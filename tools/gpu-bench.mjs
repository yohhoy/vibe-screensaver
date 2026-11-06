#!/usr/bin/env node
// 全作品の GPU 負荷を、シーン別に測る。結果の見方と手順は docs/performance.md。
//
//   node tools/gpu-bench.mjs [--rounds 3] [--frames 450] [--only drone,ripple] [--conditions FHD,Retina] [--json 出力先] [--shots 出力先]
//
// 作品の HTML は変更しない。手元の HTTP サーバーで配信するときに、計測用の処理を差し込む。
// 依存は Node.js（22 以降。標準の WebSocket を使う）と Google Chrome だけ。
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 設定 ----
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEED = 12345;              // Math.random を置き換える乱数の種
const STEP_MS = 1000 / 30;       // 1 コマで進める時間（ms）
const WARMUP_FRAMES = 30;        // シェーダーのコンパイルなどを避けるため、結果に入れない最初のコマ数
const OVERHEAD_FRAMES = 60;      // 読み戻しだけの時間を測るコマ数
const PAGE_TIMEOUT_MS = 180000;  // 1 回の計測の上限
const LOAD_ITERATIONS = 300;     // 基準負荷のシェーダーの繰り返し回数（M3 の最速のクロックで約 5.5ms）
const SPIN_WORKERS = 1;          // CPU を回し続ける Worker の数。これが無いと GPU のクロックが最速に揃わない

// 測る解像度。devicePixelRatio は各作品の MAX_PIXEL_RATIO.pc で頭打ちになる
const CONDITIONS = [
  { name: 'FHD', width: 1920, height: 1080, dpr: 1 },
  { name: 'Retina', width: 1280, height: 832, dpr: 2 },
];

// 作品ごとのシーン。select はシーンを切り替える式で、i が番号。
// scenes が無い作品（シーンの定義が無く、乱数で変わるだけの作品）は 1 行だけ測る
const PAGES = [
  { page: 'pipes' },
  { page: 'tube' },
  { page: 'drone', scenes: 'COURSES', select: 'loadCourse(i)' },
  { page: 'ripple', scenes: 'SCENES', select: 'setScene(i)' },
  { page: 'campfire' },
  { page: 'jellyfish' },
  { page: 'aurora' },
  { page: 'waterfall', scenes: 'SCENES', select: 'setScene(i)' },
  { page: 'lavalamp' },
  { page: 'penguins', scenes: 'SCENES', select: 'setScene(i)' },
  { page: 'diamond' },
  { page: 'sandpicture' },
];

// ---- ページに差し込む処理 ----
// 作品のスクリプトより先に実行し、乱数と時計を固定する
const PRELUDE = `<script>
(() => {
  // 同じコマの列を描くため、乱数を固定する（mulberry32）
  let s = Number(new URLSearchParams(location.search).get('seed')) >>> 0;
  Math.random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // 作品が読む時計は仮の時計にする。本物の時計は計測にだけ使う
  const realNow = performance.now.bind(performance);
  let virtualNow = 0;
  performance.now = () => virtualNow;
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  const percentile = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };

  // 基準負荷: 作品とは別のコンテキストで、決まった重さの全画面描画をする。
  // コマごとに挟んで GPU を休ませず、シーンの軽重によらずクロックを揃える。かかった時間はクロックの状態の目安になる
  function createReferenceLoad(width, height, iterations) {
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false });
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, \`#version 300 es
      void main() { gl_Position = vec4(vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0); }\`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, \`#version 300 es
      precision highp float;
      out vec4 color;
      void main() {
        vec2 p = gl_FragCoord.xy * 0.01;
        for (int i = 0; i < \${iterations}; i++) p = fract(p.yx * 1.7 + sin(p * 6.1) * 0.3 + 0.1);
        color = vec4(p, 0.0, 1.0);
      }\`));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    const px = new Uint8Array(4);
    return () => {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
  }

  // 作品の「開始」節の最後で呼ばれる
  window.__benchStart = ({ renderer, tick, select, names }) => {
    const q = new URLSearchParams(location.search);
    const sceneIndex = Number(q.get('scene'));
    const frames = Number(q.get('frames'));
    const warmup = Number(q.get('warmup'));
    const overheadFrames = Number(q.get('overhead'));
    const stepMs = Number(q.get('step'));
    if (select) select(sceneIndex);
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const info = renderer.info;
    info.autoReset = false;
    const readback = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const total = [], wait = [], calls = [], triangles = [], gpuTime = [], reference = [];
    const referenceLoad = createReferenceLoad(1280, 720, Number(q.get('loadIter')));
    const overhead = [];
    let frame = 0;
    let contentRatio = 0;
    for (let n = Number(q.get('spin')); n > 0; n--) {
      new Worker('/__spin.js');
    }
    // GPU の時間を直接測るタイマー。結果は少し遅れて届くので、順番待ちに入れておく
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pendingQueries = [];
    let disjoint = 0;
    const collectQueries = () => {
      while (pendingQueries.length && gl.getQueryParameter(pendingQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pendingQueries.shift();
        if (gl.getParameter(timer.GPU_DISJOINT_EXT)) disjoint++;
        else if (q.measured) gpuTime.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    };
    // 最後のコマに、暗くない画素がどれだけあるか（空白の画像を測っていないことの確認）
    const measureContent = () => {
      const [w, h] = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      const all = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, all);
      let n = 0;
      for (let i = 0; i < all.length; i += 4) if (all[i] + all[i + 1] + all[i + 2] > 24) n++;
      return n / (w * h);
    };
    const loop = () => {
      if (frame < warmup + frames) {
        virtualNow += stepMs;
        info.reset();
        const r0 = realNow();
        referenceLoad();
        const r1 = realNow();
        readback();                       // 前のコマの処理を終わらせてから測り始める
        const query = timer && gl.createQuery();
        if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        const t0 = realNow();
        tick(virtualNow);
        const t1 = realNow();
        if (query) {
          gl.endQuery(timer.TIME_ELAPSED_EXT);
          query.measured = frame >= warmup;
          pendingQueries.push(query);
        }
        readback();                       // GPU の完了を待つ
        const t2 = realNow();
        collectQueries();
        if (frame === warmup + frames - 1) contentRatio = measureContent();
        if (frame >= warmup) {
          reference.push(r1 - r0);
          total.push(t2 - t0);
          wait.push(t2 - t1);
          calls.push(info.render.calls);
          triangles.push(info.render.triangles);
        }
        frame++;
      } else if (overhead.length < overheadFrames) {
        // 読み戻しだけにかかる時間
        const t0 = realNow();
        gl.clear(gl.COLOR_BUFFER_BIT);
        readback();
        overhead.push(realNow() - t0);
      } else if (pendingQueries.length) {
        collectQueries();
      } else {
        renderer.setAnimationLoop(() => tick(virtualNow));   // 撮影用に描き続ける（時間は進めない）
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        window.__benchResult = {
          scene: names?.[sceneIndex] ?? null,
          sceneCount: names?.length ?? 1,
          gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          dpr: devicePixelRatio,
          touch: matchMedia('(pointer: coarse)').matches,
          frames: total.length,
          totalMedian: median(total), totalP95: percentile(total, 0.95),
          waitMedian: median(wait), waitP95: percentile(wait, 0.95),
          overheadMedian: median(overhead),
          callsMedian: median(calls), callsMax: Math.max(...calls),
          trianglesMedian: median(triangles), trianglesMax: Math.max(...triangles),
          contentRatio,
          referenceMedian: reference.length ? median(reference) : null,
          referenceMin: Math.min(...reference), referenceMax: Math.max(...reference),
          gpuMedian: gpuTime.length ? median(gpuTime) : null,
          gpuP95: gpuTime.length ? percentile(gpuTime, 0.95) : null,
          gpuSamples: gpuTime.length,
          disjoint,
        };
      }
    };
    // コマの間で待たない（rAF を使わない）。GPU を休ませるとクロックが下がり、負荷によって時間の物差しが変わるため
    renderer.setAnimationLoop(null);
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      loop();
      if (!window.__benchResult) channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
  };
})();
</script>`;

// 作品の開始の処理を、計測の開始に置き換える。見つからないときは止める（黙って別の物を測らないため）
function instrument(html, def) {
  if (!html.includes('<head>')) throw new Error(`${def.page}: <head> が見つからない`);
  const anchor = 'renderer.setAnimationLoop(tick);';
  if (html.split(anchor).length !== 2) throw new Error(`${def.page}: 「${anchor}」が 1 か所ではない`);
  const select = def.select ? `(i) => { ${def.select}; }` : 'null';
  const names = def.scenes ? `${def.scenes}.map((s) => s.name)` : 'null';
  return html
    .replace('<head>', () => `<head>\n${PRELUDE}`)
    .replace(anchor, () => `window.__benchStart({ renderer, tick, select: ${select}, names: ${names} });`);
}

// ---- HTTP サーバー ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };

function serve() {
  const server = createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    if (name === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    if (name === '__spin.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('for (;;);'); return; }
    try {
      let body = await readFile(path.join(ROOT, name));
      const def = PAGES.find((p) => `${p.page}.html` === name);
      if (def) body = instrument(body.toString(), def);
      res.writeHead(200, { 'content-type': MIME[path.extname(name)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- Chrome DevTools Protocol ----
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(m.params.entry.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }
}

async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'gpu-bench-'));
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

// ---- 計測 ----
async function waitForResult(cdp) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cdp.errors.length) throw new Error(`ページのエラー: ${cdp.errors.join('\n')}`);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__benchResult ?? null)', returnByValue: true });
    const value = JSON.parse(result.value);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('時間切れ');
}

async function measure(browser, origin, def, sceneIndex, condition, opts) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const pageInfo = await (await fetch(`${opts.httpBase}/json/list`)).json();
  const target = pageInfo.find((t) => t.id === targetId);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: condition.width, height: condition.height, deviceScaleFactor: condition.dpr, mobile: false,
    });
    const q = new URLSearchParams({ seed: SEED, scene: sceneIndex, frames: opts.frames, warmup: WARMUP_FRAMES, overhead: OVERHEAD_FRAMES, step: STEP_MS, loadIter: LOAD_ITERATIONS, spin: SPIN_WORKERS });
    await cdp.send('Page.navigate', { url: `${origin}/${def.page}.html?${q}` });
    const r = await waitForResult(cdp);
    if (opts.shots) {
      // 描いた絵に中身があることを、人が確かめるための画像
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      const name = `${def.page}-${sceneIndex}-${condition.name}.jpg`;
      await writeFile(path.join(opts.shots, name), Buffer.from(shot.data, 'base64'));
    }
    return r;
  } finally {
    cdp.ws.close();
    await browser.send('Target.closeTarget', { targetId });
  }
}

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };

// docs/performance.md に貼る一覧。時間は条件ごとの表に、条件で変わらない値は最後の表にまとめる
function toMarkdown(rows) {
  const lines = [];
  const withRange = (value, min, max, digits) => `${value.toFixed(digits)}（${min.toFixed(digits)}〜${max.toFixed(digits)}）`;
  for (const condition of new Set(rows.map((r) => r.condition))) {
    const c = CONDITIONS.find((x) => x.name === condition);
    lines.push(`### ${c.name}（${c.width}×${c.height}、devicePixelRatio ${c.dpr}）`, '');
    lines.push('| 作品 | シーン | GPU タイマー (ms) | コマ全体 (ms) | 基準負荷 (ms) |');
    lines.push('|---|---|---:|---:|---:|');
    for (const r of rows.filter((x) => x.condition === condition)) {
      lines.push(`| ${r.page} | ${r.scene ?? '—'} | ${withRange(r.gpu_ms, r.gpuMin, r.gpuMax, 2)} | ${withRange(r.total, r.totalMin, r.totalMax, 1)} | ${r.reference.toFixed(1)} |`);
    }
    lines.push('');
  }
  lines.push('### 描画の内容', '');
  lines.push(`| 作品 | シーン | 描画の解像度（${[...new Set(rows.map((r) => r.condition))].join(' / ')}） | 描画命令 | 三角形 |`);
  lines.push('|---|---|---|---:|---:|');
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.page}/${r.sceneIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // 条件で値が違うときだけ「/」で並べる
  const values = (group, get) => [...new Set(group.map(get))].join(' / ');
  for (const group of groups.values()) {
    const r = group[0];
    lines.push(`| ${r.page} | ${r.scene ?? '—'} | ${values(group, (x) => x.buffer.join('×'))} | ${values(group, (x) => x.calls)} | ${values(group, (x) => x.triangles)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { rounds: 3, frames: 450, only: null, conditions: null, json: null, shots: null, };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--rounds') opts.rounds = Number(v);
    else if (k === '--frames') opts.frames = Number(v);
    else if (k === '--only') opts.only = v.split(',');
    else if (k === '--conditions') opts.conditions = v.split(',');
    else if (k === '--json') opts.json = v;
    else if (k === '--shots') opts.shots = v;
    else throw new Error(`不明な引数: ${k}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.shots) await mkdir(opts.shots, { recursive: true });
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chrome, wsUrl, userDataDir } = await launchChrome();
  opts.httpBase = `http://${new URL(wsUrl).host}`;
  const browser = await Cdp.connect(wsUrl);
  const pages = PAGES.filter((p) => !opts.only || opts.only.includes(p.page));
  const conditions = CONDITIONS.filter((c) => !opts.conditions || opts.conditions.includes(c.name));

  try {
    // シーンの数は最初の 1 回で分かる（for の条件は毎回読み直す）。温度などの揺れが特定のシーンに偏らないよう、全シーンを順に回す
    const sceneCounts = new Map();
    const samples = new Map();   // "作品/番号/条件" -> 結果の配列
    for (let round = 0; round < opts.rounds; round++) {
      for (const condition of conditions) {
        for (const def of pages) {
          for (let i = 0; i < (sceneCounts.get(def.page) ?? 1); i++) {
            const r = await measure(browser, origin, def, i, condition, opts);
            sceneCounts.set(def.page, r.sceneCount);
            const key = `${def.page}/${i}/${condition.name}`;
            if (!samples.has(key)) samples.set(key, []);
            samples.get(key).push(r);
            console.error(`[${round + 1}/${opts.rounds}] ${condition.name} ${def.page} ${r.scene ?? ''} gpu=${r.gpuMedian?.toFixed(2)} (p95 ${r.gpuP95?.toFixed(2)}, n=${r.gpuSamples}, disjoint=${r.disjoint}) total=${r.totalMedian.toFixed(1)} wait=${r.waitMedian.toFixed(1)} ref=${r.referenceMedian?.toFixed(2)} calls=${r.callsMedian} tris=${r.trianglesMedian} ${r.buffer.join('x')}`);
          }
        }
      }
    }
    const rows = [];
    for (const [key, list] of samples) {
      const [page, scene, condition] = key.split('/');
      const totals = list.map((r) => r.totalMedian);
      rows.push({
        page, sceneIndex: Number(scene), scene: list[0].scene, condition,
        buffer: list[0].buffer, dpr: list[0].dpr, touch: list[0].touch, gpu: list[0].gpu,
        rounds: list.length,
        total: median(totals), totalMin: Math.min(...totals), totalMax: Math.max(...totals),
        totalP95: median(list.map((r) => r.totalP95)),
        wait: median(list.map((r) => r.waitMedian)),
        overhead: median(list.map((r) => r.overheadMedian)),
        calls: median(list.map((r) => r.callsMedian)), callsMax: Math.max(...list.map((r) => r.callsMax)),
        triangles: median(list.map((r) => r.trianglesMedian)), trianglesMax: Math.max(...list.map((r) => r.trianglesMax)),
        contentRatio: Math.min(...list.map((r) => r.contentRatio)),
        reference: median(list.map((r) => r.referenceMedian)),
        referenceMax: Math.max(...list.map((r) => r.referenceMedian)),
        gpu_ms: median(list.map((r) => r.gpuMedian)),
        gpuMin: Math.min(...list.map((r) => r.gpuMedian)),
        gpuMax: Math.max(...list.map((r) => r.gpuMedian)),
        gpuP95: median(list.map((r) => r.gpuP95)),
        gpuSamples: list[0].gpuSamples, disjoint: list[0].disjoint,
      });
    }
    const output = JSON.stringify({ date: new Date().toISOString(), seed: SEED, frames: opts.frames, rounds: opts.rounds, rows }, null, 2);
    if (opts.json) await writeFile(opts.json, output);
    console.log(toMarkdown(rows));
  } finally {
    browser.ws.close();
    chrome.removeAllListeners('exit');
    chrome.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
