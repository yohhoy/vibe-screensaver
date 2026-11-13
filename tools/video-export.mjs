#!/usr/bin/env node
// 作品を 1 コマずつ描き出して、投稿用の動画（H.264）か静止画（PNG）を作る。使い方と例は docs/video.md。
//
//   node tools/video-export.mjs <作品名> [--scenes 0,1,2] [--presets 0,1,2] [--seconds 5] [--warmup 3] [--fade 0.5] [--seed 1] [--hidden off|auto|秒,秒] [--at "秒:式"]... [--size 1920x1080] [--out 出力先.mp4|出力先.png]
//
// 作品の HTML は変更しない。手元の HTTP サーバーで配信するときに、収録用の処理を差し込む。
// 依存は Node.js（22 以降。標準の WebSocket を使う）、Google Chrome、ffmpeg（ffprobe を含む）。
import { spawn } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, SEEDED_RANDOM, connectCdp, launchChrome, run } from './common.mjs';
import { CHOICES, HIDDEN, PAGES, choiceExpressions, pagesWith } from './pages.mjs';

// ---- 設定 ----
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

// 場面の選び方（--scenes・--presets）は pages.mjs の CHOICES。両方を持つ作品は同時に指定でき、シーンと配色の組み合わせごとに 1 場面撮る。
// 省いた方は、作品が起動時に選んだまま

const USAGE = `使い方: node tools/video-export.mjs <作品名> [オプション]

作品名: ${PAGES.join(' ')}
  --scenes 0,1,2  シーンの番号（${pagesWith('scenes')} のみ）。番号ごとに 1 場面撮る
  --presets 0,1,2 配色の番号（${pagesWith('presets')} のみ）。番号ごとに 1 場面撮る。
                  --scenes と同時に指定すると、シーンごとに配色を順に替えて撮る（シーン × 配色の場面の数）
  --seconds S     1 場面の長さ（秒。既定 5。静止画では収録を始めてから撮るまでの秒数で、既定 0）
  --warmup S      各場面の収録前に進めておく時間（秒。既定 3）
  --fade S        各場面の最初と最後のフェード（秒。既定 0.5。0 で無し。静止画では使わない）
  --seed N        乱数の種（既定 1）
  --hidden H      隠し要素（${Object.keys(HIDDEN).join('・')} のみ）。auto は作品に任せる（既定）、off は出さない、
                  秒の並び（例 2,8.5）は自然には出さず、動画のその時刻に呼び出す
  --at "秒:式"    動画の時刻に式を実行する。作品のスクリプトの変数を使える。複数指定できる
  --size WxH      静止画の大きさ（既定 1280x720。.png のときだけ）
  --out PATH      出力先（既定 <作品名>.mp4）。.png なら、各場面の最後のコマを PNG にする（場面が複数なら <名前>-1.png のように番号を付ける）。
                  動画では確認用の画像を <出力先>.thumbs.jpg に作る`;

// ---- ページに差し込む処理 ----
// <body> の直後に置く。common.js のあと、作品のモジュールの前に実行される
const PRELUDE = `<script>
(() => {
${SEEDED_RANDOM}
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
  window.__exportStart = async ({ renderer, tick, choices, evaluate, summon }) => {
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
    for (const [sceneIndex, scene] of plan.scenes.entries()) {
      // シーンを選んでから配色を選ぶ（シーンを替えると配色を選び直す作品があるため）
      const names = [];
      for (const kind of ['scenes', 'presets']) {
        const i = scene[kind];
        if (i === null) continue;
        const choice = choices[kind];
        if (i >= choice.names.length) throw new Error('--' + kind + ' の番号は 0〜' + (choice.names.length - 1) + ': ' + choice.names.join(', '));
        choice.select(i);
        names.push(choice.names[i]);
      }
      for (let i = 0; i < plan.warmupFrames; i++) {
        advance();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // 命令を溜めすぎないよう、GPU の完了を待つ
        if (i % 300 === 299) await post('/__alive');                 // 長い準備の間も、止まっていないと伝える
      }
      let level = 0;
      for (let i = 0; i < plan.sceneFrames; i++, frame++) {
        for (const at of plan.at) if (at.frame === frame) evaluate(at.code);
        for (const f of plan.summonFrames) if (f === frame) summon();
        advance();
        if (i === plan.sceneFrames >> 1) level = brightness();
        if (plan.still && i < plan.sceneFrames - 1) continue;   // 静止画は最後のコマだけ撮る
        const fade = plan.fadeFrames ? Math.min(1, i / plan.fadeFrames, (plan.sceneFrames - 1 - i) / plan.fadeFrames) : 1;
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = fade;
        ctx.drawImage(source, 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, plan.still ? 'image/png' : 'image/jpeg', plan.jpegQuality));
        await post(plan.still ? '/__still?n=' + sceneIndex : '/__frame?n=' + frame, blob);
      }
      results.push({ name: names.length ? names.join(' / ') : null, level });
    }
    await post('/__done', JSON.stringify(results));
  };
})();
</script>`;

// 作品の開始の処理を、収録の開始に置き換える。見つからないときは止める（黙って別の物を撮らないため）
function instrument(html, page, hidden) {
  const anchor = 'renderer.setAnimationLoop(tick);';
  if (html.split('<body>').length !== 2) throw new Error(`${page}: <body> が 1 か所ではない`);
  if (html.split(anchor).length !== 2) throw new Error(`${page}: 「${anchor}」が 1 か所ではない`);
  // 隠し要素は、自然な出現（作品が待ち時間で呼ぶ関数）を空の関数に差し替えて止め、元の関数は呼び出し用に取っておく。
  // 作品の関数は function 宣言なので、モジュールの中なら代入で差し替えられる
  const fn = HIDDEN[page];
  const hook = hidden.mode === 'auto' ? 'const summon = () => {};'
    : `const summon = ${fn}; ${fn} = () => {};`;
  // evaluate は作品のモジュールの中で eval するので、--at の式から作品の変数が見える
  return html
    .replace('<body>', () => `<body>\n${PRELUDE}`)
    .replace(anchor, () => `${hook}\nwindow.__exportStart({ renderer, tick, choices: ${choiceExpressions(page)}, evaluate: (code) => eval(code), summon });`);
}

// ---- ffmpeg ----
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
// ページのタブにつなぐ。ページのエラーが起きたら onError に渡す
async function connectPage(wsUrl, onError) {
  const list = await (await fetch(`http://${new URL(wsUrl).host}/json/list`)).json();
  return connectCdp(list.find((t) => t.type === 'page').webSocketDebuggerUrl, (text) => onError(new Error(`ページのエラー: ${text.split('\n')[0]}`)));
}

// ---- 収録 ----
function parseOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scenes: { type: 'string' },
      presets: { type: 'string' },
      seconds: { type: 'string' },
      warmup: { type: 'string', default: '3' },
      size: { type: 'string' },
      fade: { type: 'string', default: '0.5' },
      seed: { type: 'string', default: '1' },
      hidden: { type: 'string', default: 'auto' },
      at: { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
    },
  });
  const page = positionals[0];
  if (positionals.length !== 1 || !PAGES.includes(page)) throw new Error(USAGE);
  if (values.scenes && !CHOICES[page]?.scenes) throw new Error(`${page} にシーンの定義は無い。--scenes は ${pagesWith('scenes')} だけで使える`);
  if (values.presets && !CHOICES[page]?.presets) throw new Error(`${page} に配色の定義は無い。--presets は ${pagesWith('presets')} だけで使える`);

  // 出力先が .png なら静止画（各場面の最後のコマを PNG にする）
  const out = path.resolve(values.out ?? `${page}.mp4`);
  const still = /\.png$/i.test(out);
  if (!still && !/\.mp4$/i.test(out)) throw new Error(`--out は .mp4（動画）か .png（静止画）: ${out}`);
  if (!still && values.size) throw new Error('--size は静止画（.png）だけで使える。動画は 1280x720 に固定している');
  const size = values.size?.match(/^(\d+)x(\d+)$/);
  if (values.size && !(size && Number(size[1]) >= 16 && Number(size[2]) >= 16)) throw new Error(`--size は「幅x高さ」で書く（例 1920x1080）: ${values.size}`);

  const seconds = Number(values.seconds ?? (still ? 0 : 5));
  const fade = still ? 0 : Number(values.fade);
  const warmup = Number(values.warmup);
  if (!(seconds >= 0) || (!still && !(seconds > 0)) || !(warmup >= 0) || !(fade >= 0)) throw new Error(USAGE);
  if (fade * 2 > seconds) throw new Error('--fade は --seconds の半分以下にする');

  // 場面ごとのシーンと配色の番号。null は選ばず、起動時のまま撮る
  const numbers = (kind) => values[kind]?.split(',').map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${kind} の番号が正しくない: ${v}`);
    return n;
  }) ?? [null];
  const scenes = numbers('scenes').flatMap((sceneNo) => numbers('presets').map((preset) => ({ scenes: sceneNo, presets: preset })));
  const sceneFrames = Math.max(1, Math.round(seconds * FPS));   // 静止画は 0 秒でも 1 コマ撮る
  const totalFrames = scenes.length * sceneFrames;
  // 隠し要素: auto（作品に任せる）・off（出さない）・秒の並び（その時刻に呼び出す）
  const hiddenTimes = ['auto', 'off'].includes(values.hidden) ? [] : values.hidden.split(',').map(Number);
  if (values.hidden !== 'auto' && !HIDDEN[page]) throw new Error(`${page} に隠し要素は無い。--hidden は ${Object.keys(HIDDEN).join('・')} だけで使える`);
  if (hiddenTimes.some((t) => !(t >= 0 && Math.round(t * FPS) < totalFrames))) throw new Error(`--hidden は auto・off・動画の中の秒の並び（0〜${seconds * scenes.length} 未満）で書く: ${values.hidden}`);
  const at = values.at.map((spec) => {
    const m = spec.match(/^([\d.]+):(.+)$/s);
    const frame = m && Math.round(Number(m[1]) * FPS);
    if (!m || !(frame < totalFrames)) throw new Error(`--at は「動画の中の秒:式」で書く: ${spec}`);
    return { frame, code: m[2] };
  });
  return {
    page,
    hidden: { mode: values.hidden === 'auto' ? 'auto' : 'off' },
    seed: values.seed,
    out,
    plan: {
      width: size ? Number(size[1]) : WIDTH, height: size ? Number(size[2]) : HEIGHT, fps: FPS, jpegQuality: JPEG_QUALITY,
      still,
      scenes, sceneFrames, at,
      summonFrames: hiddenTimes.map((t) => Math.round(t * FPS)),
      warmupFrames: Math.round(warmup * FPS),
      fadeFrames: Math.round(fade * FPS),
    },
    totalFrames,
  };
}

async function main() {
  const { page, hidden, seed, out, plan, totalFrames } = parseOptions();
  const partial = `${out}.part`;
  const thumbs = `${out.replace(/\.mp4$/, '')}.thumbs.jpg`;
  // 静止画は ffmpeg を使わず、ページが送ってきた PNG をそのまま書く
  const { encoder, finished } = plan.still ? { encoder: null, finished: Promise.resolve() } : startEncoder(partial);
  const stills = new Map();   // 場面の番号 → PNG

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
    if (name === '__alive') {
      lastFrameAt = Date.now();
      return reply(200);
    }
    if (name === '__frame' || name === '__done' || name === '__still') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      if (name === '__done') {
        settle.resolve(JSON.parse(body));
        return reply(200);
      }
      if (name === '__still') {
        lastFrameAt = Date.now();
        stills.set(Number(url.searchParams.get('n')), body);
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
      if (PAGES.includes(name.replace(/\.html$/, ''))) body = instrument(body.toString(), page, hidden);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(name)];
      reply(200, type ?? 'application/octet-stream', body);
    } catch (e) {
      settle.reject(e);
      reply(404);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { chrome, wsUrl, userDataDir } = await launchChrome('video-export');
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: plan.width, height: plan.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${page}.html?seed=${encodeURIComponent(seed)}` });

    const results = await done;
    // リポジトリの中なら短く出す
    const shown = (file) => { const r = path.relative(process.cwd(), file); return r.startsWith('..') ? file : r; };
    const names = results.map((r) => r.name).filter(Boolean).join(' / ');
    if (plan.still) {
      // 場面が複数なら <名前>-1.png のように番号を付ける
      const files = results.map((_, i) => (results.length === 1 ? out : out.replace(/\.png$/i, `-${i + 1}.png`)));
      for (const [i, file] of files.entries()) {
        if (!stills.has(i)) throw new Error(`場面 ${i + 1} の静止画が届かなかった`);
        await writeFile(file, stills.get(i));
        const { size } = await stat(file);
        console.log(`${shown(file)}: ${plan.width}x${plan.height} PNG ${(size / 1e6).toFixed(1)}MB${results[i].name ? ` [${results[i].name}]` : ''}`);
      }
    } else {
      encoder.stdin.end();
      await finished;
      await verify(partial, totalFrames);
      await rename(partial, out);
      await makeThumbs(out, thumbs, totalFrames);
      const { size } = await stat(out);
      console.log(`${shown(out)}: ${WIDTH}x${HEIGHT} ${FPS}fps ${(totalFrames / FPS).toFixed(1)}秒 ${totalFrames}コマ ${(size / 1e6).toFixed(1)}MB${names ? ` [${names}]` : ''}`);
      console.log(`確認用の画像: ${shown(thumbs)}`);
    }
    for (const [i, r] of results.entries()) {
      if (r.level < BLANK_LEVEL) console.error(`警告: 場面 ${i + 1}${r.name ? `（${r.name}）` : ''} の中ほどのコマが真っ暗（最大 ${r.level}）`);
    }
  } catch (e) {
    // 止まるのを待ってから消す。先に消すと、ffmpeg が作り直して残ることがある
    encoder?.kill('SIGKILL');
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
