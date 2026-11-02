#!/usr/bin/env node
// 作品を 1 コマずつ描き出して、投稿用の動画（H.264）を作る。使い方と例は docs/video.md。
//
//   node tools/video-export.mjs <作品名> [--scenes 0,1,2] [--seconds 5] [--warmup 3] [--fade 0.5] [--seed 1] [--at "秒:式"]... [--out 出力先.mp4]
//
// 作品の HTML は変更しない。手元の HTTP サーバーで配信するときに、収録用の処理を差し込む。
// 依存は Node.js（22 以降。標準の WebSocket を使う）、Google Chrome、ffmpeg（ffprobe を含む）。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---- 設定 ----
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const JPEG_QUALITY = 0.95;       // コマの画質（0..1）。PNG は 1 枚数 MB あり、約 500 枚で Chrome の Blob のメモリ上限に達する
const X264_CRF = 18;             // 動画の画質（小さいほど高画質。0..51）
const STALL_MS = 180000;         // この時間コマが届かなければ、止まったとみなす
const BLANK_LEVEL = 4;           // 場面の中ほどのコマの最も明るい値（0..255）がこれ未満なら、描けていないと警告する
const THUMBS_COLS = 4;            // 確認用の画像の列数
const THUMBS_ROWS = 3;            // 確認用の画像の行数
const THUMB_WIDTH = 320;          // 確認用の画像の 1 コマの幅（px）

// 作品ごとのシーンの定義。select はシーンを番号で選ぶ式で、i が番号。
// 無い作品は場面を選べないので、1 場面だけ撮る
const SCENES = {
  drone: { names: 'COURSES', select: 'loadCourse(i)' },
  ripple: { names: 'SCENES', select: 'setScene(i)' },
  waterfall: { names: 'SCENES', select: 'setScene(i)' },
  penguins: { names: 'SCENES', select: 'setScene(i)' },
};
const PAGES = ['pipes', 'tube', 'drone', 'ripple', 'campfire', 'jellyfish', 'aurora', 'waterfall', 'lavalamp', 'penguins'];

const USAGE = `使い方: node tools/video-export.mjs <作品名> [オプション]

作品名: ${PAGES.join(' ')}
  --scenes 0,1,2  場面の番号（${Object.keys(SCENES).join('・')} のみ）
  --seconds S     1 場面の長さ（秒。既定 5）
  --warmup S      各場面の収録前に進めておく時間（秒。既定 3）
  --fade S        各場面の最初と最後のフェード（秒。既定 0.5。0 で無し）
  --seed N        乱数の種（既定 1）
  --at "秒:式"    動画の時刻に式を実行する。作品のスクリプトの変数を使える。複数指定できる
  --out PATH      出力先（既定 <作品名>.mp4）。確認用の画像を <出力先>.thumbs.jpg に作る`;

// ---- ページに差し込む処理 ----
// <body> の直後に置く。common.js のあと、作品のモジュールの前に実行される
const PRELUDE = `<script>
(() => {
  // 同じ種から同じ動画を作るため、乱数を固定する（mulberry32）
  let s = new URLSearchParams(location.search).get('seed') >>> 0;
  Math.random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let now = 0;
  performance.now = () => now;

  // 作品の暗転は DOM の #fade で canvas に写らないので、--at で切り替えてもすぐに切り替える
  Common.fadeAndRun = (change) => change();

  async function post(url, body) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', body });
        if (res.ok) return;
        throw new Error(url + ': ' + res.status);
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
  }

  // 作品の「開始」節の最後で呼ばれる
  window.__exportStart = async ({ renderer, tick, select, names, evaluate }) => {
    const plan = await (await fetch('/__plan')).json();
    const source = renderer.domElement;
    if (source.width !== plan.width || source.height !== plan.height) {
      throw new Error('描画先の大きさが違う: ' + source.width + 'x' + source.height);
    }
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const advance = () => { now += 1000 / plan.fps; tick(now); };

    const canvas = Object.assign(document.createElement('canvas'), { width: plan.width, height: plan.height });
    const ctx = canvas.getContext('2d', { alpha: false });
    const probe = Object.assign(document.createElement('canvas'), { width: 32, height: 18 });
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    // 描いた直後に写す。あとの task になると WebGL の canvas は空になっていることがある
    const brightness = () => {
      probeCtx.drawImage(source, 0, 0, probe.width, probe.height);
      const { data } = probeCtx.getImageData(0, 0, probe.width, probe.height);
      let max = 0;
      for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
      return max;
    };

    const results = [];
    let frame = 0;
    for (const scene of plan.scenes) {
      if (scene !== null) {
        if (scene >= names.length) throw new Error('場面の番号は 0〜' + (names.length - 1) + ': ' + names.join(', '));
        select(scene);
      }
      for (let i = 0; i < plan.warmupFrames; i++) {
        advance();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // 命令を溜めすぎないよう、GPU の完了を待つ
      }
      let level = 0;
      for (let i = 0; i < plan.sceneFrames; i++, frame++) {
        for (const at of plan.at) if (at.frame === frame) evaluate(at.code);
        advance();
        if (i === plan.sceneFrames >> 1) level = brightness();
        const fade = plan.fadeFrames ? Math.min(1, i / plan.fadeFrames, (plan.sceneFrames - 1 - i) / plan.fadeFrames) : 1;
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = fade;
        ctx.drawImage(source, 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', plan.jpegQuality));
        await post('/__frame?n=' + frame, blob);
      }
      results.push({ name: scene !== null ? names[scene] : null, level });
    }
    await post('/__done', JSON.stringify(results));
  };
})();
</script>`;

// 作品の開始の処理を、収録の開始に置き換える。見つからないときは止める（黙って別の物を撮らないため）
function instrument(html, page) {
  const anchor = 'renderer.setAnimationLoop(tick);';
  if (html.split('<body>').length !== 2) throw new Error(`${page}: <body> が 1 か所ではない`);
  if (html.split(anchor).length !== 2) throw new Error(`${page}: 「${anchor}」が 1 か所ではない`);
  const def = SCENES[page];
  const select = def ? `(i) => { ${def.select}; }` : 'null';
  const names = def ? `${def.names}.map((s) => s.name)` : 'null';
  // evaluate は作品のモジュールの中で eval するので、--at の式から作品の変数が見える
  return html
    .replace('<body>', () => `<body>\n${PRELUDE}`)
    .replace(anchor, () => `window.__exportStart({ renderer, tick, select: ${select}, names: ${names}, evaluate: (code) => eval(code) });`);
}

// ---- ffmpeg ----
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} が失敗した (${code})\n${err}`))));
  });
}

function startEncoder(output) {
  const encoder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
    // JPEG はフルレンジの BT.601。変換しないと、再生するときの色の範囲と色味がずれる
    '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    '-c:v', 'libx264', '-crf', String(X264_CRF), '-preset', 'medium', '-movflags', '+faststart',
    '-f', 'mp4', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  encoder.stderr.on('data', (d) => { log += d; });
  const finished = new Promise((resolve, reject) => {
    encoder.on('error', reject);
    encoder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg が失敗した (${code})\n${log}`))));
  });
  encoder.stdin.on('error', () => {});   // ffmpeg が先に落ちたときの理由は finished で伝える
  return { encoder, finished };
}

async function verify(file, expectedFrames) {
  const probe = JSON.parse(await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-of', 'json',
    '-show_entries', 'stream=width,height,pix_fmt,color_range,nb_read_frames', file,
  ])).streams[0];
  const frames = Number(probe.nb_read_frames);
  if (probe.width !== WIDTH || probe.height !== HEIGHT || frames !== expectedFrames || probe.pix_fmt !== 'yuv420p' || probe.color_range !== 'tv') {
    throw new Error(`書き出した動画が想定と違う: ${JSON.stringify(probe)}（${expectedFrames} コマの想定）`);
  }
}

function makeThumbs(file, thumbs, frames) {
  const every = Math.max(1, Math.floor(frames / (THUMBS_COLS * THUMBS_ROWS)));
  return run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-vf', `select='eq(mod(n\\,${every})\\,${every >> 1})',scale=${THUMB_WIDTH}:-2,tile=${THUMBS_COLS}x${THUMBS_ROWS}`,
    '-fps_mode', 'vfr', '-frames:v', '1', '-q:v', '4', thumbs,
  ]);
}

// ---- Chrome ----
async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'video-export-'));   // 普段のプロフィールと分ける
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--use-angle=metal',            // ソフトウェア描画に落ちないよう、実際の GPU を使わせる
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    chrome.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\S+)/);
      if (m) resolve(m[1]);
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome が終了した (${code})\n${log}`)));
  });
  return { chrome, wsUrl, userDataDir };
}

// ページのタブにつなぎ、エラーは onError に渡す
async function connectPage(wsUrl, onError) {
  const list = await (await fetch(`http://${new URL(wsUrl).host}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      onError(new Error(`ページのエラー: ${(d.exception?.description ?? d.text).split('\n')[0]}`));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      onError(new Error(`ページのエラー: ${m.params.entry.text}`));
    }
  });
  return {
    ws,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

// ---- 収録 ----
function parseOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scenes: { type: 'string' },
      seconds: { type: 'string', default: '5' },
      warmup: { type: 'string', default: '3' },
      fade: { type: 'string', default: '0.5' },
      seed: { type: 'string', default: '1' },
      at: { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
    },
  });
  const page = positionals[0];
  if (positionals.length !== 1 || !PAGES.includes(page)) throw new Error(USAGE);
  if (values.scenes && !SCENES[page]) throw new Error(`${page} にシーンの定義は無い。--scenes は ${Object.keys(SCENES).join('・')} だけで使える`);

  const seconds = Number(values.seconds);
  const fade = Number(values.fade);
  const warmup = Number(values.warmup);
  if (!(seconds > 0) || !(warmup >= 0) || !(fade >= 0)) throw new Error(USAGE);
  if (fade * 2 > seconds) throw new Error('--fade は --seconds の半分以下にする');

  // null は場面を選ばず、起動時の場面のまま撮る
  const scenes = values.scenes?.split(',').map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--scenes の番号が正しくない: ${v}`);
    return n;
  }) ?? [null];
  const sceneFrames = Math.round(seconds * FPS);
  const totalFrames = scenes.length * sceneFrames;
  const at = values.at.map((spec) => {
    const m = spec.match(/^([\d.]+):(.+)$/s);
    const frame = m && Math.round(Number(m[1]) * FPS);
    if (!m || !(frame < totalFrames)) throw new Error(`--at は「動画の中の秒:式」で書く: ${spec}`);
    return { frame, code: m[2] };
  });
  return {
    page,
    seed: values.seed,
    out: path.resolve(values.out ?? `${page}.mp4`),
    plan: {
      width: WIDTH, height: HEIGHT, fps: FPS, jpegQuality: JPEG_QUALITY,
      scenes, sceneFrames, at,
      warmupFrames: Math.round(warmup * FPS),
      fadeFrames: Math.round(fade * FPS),
    },
    totalFrames,
  };
}

async function main() {
  const { page, seed, out, plan, totalFrames } = parseOptions();
  const partial = `${out}.part`;
  const thumbs = `${out.replace(/\.mp4$/, '')}.thumbs.jpg`;
  const { encoder, finished } = startEncoder(partial);

  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  finished.catch(settle.reject);
  let received = 0;
  let lastFrameAt = Date.now();
  let lastTenth = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const name = path.basename(url.pathname);
    const reply = (code, type, body) => { res.writeHead(code, type ? { 'content-type': type } : {}); res.end(body); };
    if (name === 'favicon.ico') return reply(204);
    if (name === '__plan') return reply(200, 'application/json', JSON.stringify(plan));
    if (name === '__frame' || name === '__done') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      if (name === '__done') {
        settle.resolve(JSON.parse(body));
        return reply(200);
      }
      // 送り直されたコマは書かない。ffmpeg が受け取ってから返すと、ページが先走らずメモリも溜まらない
      lastFrameAt = Date.now();
      if (Number(url.searchParams.get('n')) !== received) return reply(200);
      received++;
      const tenth = Math.floor((received * 10) / totalFrames);
      if (tenth > lastTenth) {
        lastTenth = tenth;
        console.error(`${tenth * 10}% (${received}/${totalFrames} コマ)`);
      }
      encoder.stdin.write(body, () => reply(200));
      return;
    }
    try {
      let body = await readFile(path.join(ROOT, name));
      if (PAGES.includes(name.replace(/\.html$/, ''))) body = instrument(body.toString(), page);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(name)];
      reply(200, type ?? 'application/octet-stream', body);
    } catch (e) {
      settle.reject(e);
      reply(404);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { chrome, wsUrl, userDataDir } = await launchChrome();
  chrome.on('exit', (code) => settle.reject(new Error(`Chrome が終了した (${code})`)));
  const stallTimer = setInterval(() => {
    if (Date.now() - lastFrameAt > STALL_MS) settle.reject(new Error(`${STALL_MS / 1000} 秒間コマが届かない（${received}/${totalFrames} コマで停止）`));
  }, 1000);

  let cdp;
  try {
    cdp = await connectPage(wsUrl, settle.reject);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    // --window-size は当てにならず、高さが奇数になると H.264 で失敗する。大きさはここで固定する
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${page}.html?seed=${encodeURIComponent(seed)}` });

    const results = await done;
    encoder.stdin.end();
    await finished;
    await verify(partial, totalFrames);
    await rename(partial, out);
    await makeThumbs(out, thumbs, totalFrames);

    for (const [i, r] of results.entries()) {
      if (r.level < BLANK_LEVEL) console.error(`警告: 場面 ${i + 1}${r.name ? `（${r.name}）` : ''} の中ほどのコマが真っ暗（最大 ${r.level}）`);
    }
    const names = results.map((r) => r.name).filter(Boolean).join(' / ');
    const { size } = await stat(out);
    // リポジトリの中なら短く出す
    const shown = (file) => { const r = path.relative(process.cwd(), file); return r.startsWith('..') ? file : r; };
    console.log(`${shown(out)}: ${WIDTH}x${HEIGHT} ${FPS}fps ${(totalFrames / FPS).toFixed(1)}秒 ${totalFrames}コマ ${(size / 1e6).toFixed(1)}MB${names ? ` [${names}]` : ''}`);
    console.log(`確認用の画像: ${shown(thumbs)}`);
  } catch (e) {
    // 止まるのを待ってから消す。先に消すと、ffmpeg が作り直して残ることがある
    encoder.kill('SIGKILL');
    await finished.catch(() => {});
    await rm(partial, { force: true });
    throw e;
  } finally {
    clearInterval(stallTimer);
    cdp?.ws.close();
    chrome.removeAllListeners('exit');
    chrome.kill();
    server.closeAllConnections();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
