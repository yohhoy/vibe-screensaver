#!/usr/bin/env node
// 作品の GPU 負荷を、シーン別に測る。結果の見方と手順は docs/performance.md。
//
//   node tools/gpu-bench.mjs --all --cool 50                  # 全作品・全シーン。作品ごとに GPU が 50℃ に冷めるのを待つ
//   node tools/gpu-bench.mjs --only sandpicture --warmup 90   # 作品を絞り、作品の時間を 90 秒進めてから測る
//   node tools/gpu-bench.mjs --only sandpicture --base HEAD   # HEAD の版と作業ツリーの版を交互に測り、差を出す
//
// 引数なしでは測らず、オプションの一覧を出す。
// 作品の HTML は変更しない。手元の HTTP サーバーで配信するときに、計測用の処理を差し込む。
// 依存は Node.js（22 以降。標準の WebSocket を使う）と Google Chrome だけ。macmon があれば GPU の温度とクロックも記録する。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, SEEDED_RANDOM, checkoutBase, connectCdp, launchChrome } from './common.mjs';
import { CHOICES, PAGES as PAGE_NAMES, choiceExpressions } from './pages.mjs';

// ---- 設定 ----
const SEED = 12345;              // Math.random を置き換える乱数の種
const STEP_MS = 1000 / 30;       // 1 コマで進める時間（ms）
const SETTLE_FRAMES = 30;        // 計測と同じ手順で描くが、結果に入れない最初のコマ数。シェーダーのコンパイルを済ませ、
                                 // GPU のクロックを揃える。--warmup（計測を挟まずに作品の時間を進める秒数）とは別
const OVERHEAD_FRAMES = 60;      // 読み戻しだけの時間を測るコマ数
const PAGE_TIMEOUT_MS = 180000;  // 1 回の計測の上限
const LOAD_ITERATIONS = 300;     // 基準負荷のシェーダーの繰り返し回数（M3 の最速のクロックで約 5.3ms）
const REFERENCE_TOLERANCE = 0.05;   // --base で比べるとき、基準負荷の差がこれを超えたら時間を比べない（docs/performance.md の「比べ方」）
const TIME_SIGNIFICANCE = 0.03;     // --base で比べるとき、時間の差がこれと「周の幅」の大きい方を超えたら意味のある差とみなす（同上）
const SPIN_WORKERS = 1;          // CPU を回し続ける Worker の数。これが無いと GPU のクロックが最速に揃わない
const COOL_POLL_MS = 5000;       // --cool で、GPU の温度を読み直す間隔
const COOL_TIMEOUT_MS = 20 * 60000;   // --cool で冷めるのを待つ上限
const USER_ACTIVE_INTERVAL_MS = 30000;   // 操作中であることを知らせる間隔（--idle でないとき）
const MONITOR_STALE_MS = 30000;  // macmon の値がこれより古ければ、止まっているとみなす

// 測る解像度。devicePixelRatio は各作品の MAX_PIXEL_RATIO.pc で頭打ちになる
const CONDITIONS = [
  { name: 'FHD', width: 1920, height: 1080, dpr: 1 },
  { name: 'Retina', width: 1280, height: 832, dpr: 2 },
];

// 作品ごとのシーン（pages.mjs の CHOICES）。scenes はシーン別に測るか。
// シーンの定義（SCENES）が無い作品は 1 行だけ測る。配色の定義（COLOR_PRESETS）はシーンとして分けない
const PAGES = PAGE_NAMES.map((page) => ({ page, scenes: Boolean(CHOICES[page]?.scenes) }));

// ---- ページに差し込む処理 ----
// 作品のスクリプトより先に実行し、乱数と時計を固定する
const PRELUDE = `<script>
(() => {
${SEEDED_RANDOM}
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
    const settle = Number(q.get('settle'));     // 結果に入れない最初のコマ数（SETTLE_FRAMES）
    const advance = Number(q.get('advance'));   // 計測の前に進めておくコマ数（--warmup の秒数から求める）
    const overheadFrames = Number(q.get('overhead'));
    const stepMs = Number(q.get('step'));
    if (select) select(sceneIndex);
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const readback = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // 1 画素読み、GPU の完了を待つ
    // 計測の前に、作品の時間を進めておく（--warmup）。砂が積もる sandpicture のように、時間とともに重くなる作品の
    // 後半を測るため。基準負荷も時間の計測も挟まずに進めるので、計測より速く進む。
    // 描画の命令が溜まりすぎないよう、30 コマごとに GPU の完了を待つ
    for (let i = 0; i < advance; i++) {
      virtualNow += stepMs;
      tick(virtualNow);
      if (i % 30 === 29) readback();
    }
    const info = renderer.info;
    info.autoReset = false;
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
      if (frame < settle + frames) {
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
          query.measured = frame >= settle;
          pendingQueries.push(query);
        }
        readback();                       // GPU の完了を待つ
        const t2 = realNow();
        collectQueries();
        if (frame === settle + frames - 1) contentRatio = measureContent();
        if (frame >= settle) {
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
  // シーンだけを選ぶ（配色は作品が起動時に選んだまま）
  return html
    .replace('<head>', () => `<head>\n${PRELUDE}`)
    .replace(anchor, () => `window.__benchStart({ renderer, tick, ...${choiceExpressions(def.page)}.scenes });`);
}

// ---- HTTP サーバー ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };

// root のファイルを配信する。作品の HTML には計測の処理を差し込む
function serve(root) {
  const server = createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    if (name === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    if (name === '__spin.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('for (;;);'); return; }
    try {
      let body = await readFile(path.join(root, name));
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

// ---- GPU の温度とクロック（macmon） ----
// macmon（sudo の要らない Apple Silicon 用の計測ツール）を動かし続け、1 秒ごとの GPU の温度とクロックを溜める。
// 途中で macmon が終わることがあるので、そのときは理由を出して起動し直す。
// 無ければ null を返し、温度とクロックは記録しない（--cool は使えない）
async function startMonitor() {
  const samples = [];
  let proc = null;
  let stopped = false;
  let alive = false;   // macmon が 1 行でも出したか（温度が null の行も数える）
  const launch = () => {
    proc = spawn('macmon', ['pipe', '-i', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          alive = true;
          // 温度が読めず null になることがあるので、その回は捨てる
          if (Number.isFinite(m.temp?.gpu_temp_avg) && Number.isFinite(m.gpu_freq_mhz)) samples.push({ t: Date.now(), temp: m.temp.gpu_temp_avg, freq: m.gpu_freq_mhz });
        } catch {}
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
    proc.on('exit', (code, signal) => {
      if (stopped || !alive) return;   // 起動できなかったときは下の ok で扱う
      progress(`macmon が終わったので起動し直す（${signal ?? `終了コード ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}）`);
      setTimeout(() => { if (!stopped) launch(); }, 1000);
    });
    return proc;
  };
  const first = launch();
  const ok = await new Promise((resolve) => {
    first.on('error', () => resolve(false));
    // 起動した直後は温度が null の行が続くことがあるので、使える値が来るまで待つ（来なければ使わない）
    const deadline = Date.now() + 15000;
    const poll = () => (samples.length ? resolve(true) : Date.now() > deadline ? resolve(false) : setTimeout(poll, 100));
    poll();
  });
  if (!ok && alive) progress('macmon が温度を返さないので、温度とクロックは記録しない');
  if (!ok) { stopped = true; first.kill(); return null; }
  const mean = (list, k) => list.reduce((a, s) => a + s[k], 0) / list.length;
  return {
    latest: () => samples.at(-1),
    // t0〜t1 の間の平均。1 つも無ければ（1 秒より短いとき）直前の値
    between(t0, t1) {
      const list = samples.filter((s) => s.t >= t0 && s.t <= t1);
      const use = list.length ? list : samples.filter((s) => s.t <= t1).slice(-1);
      return use.length ? { temp: mean(use, 'temp'), freq: mean(use, 'freq') } : null;
    },
    stop: () => { stopped = true; proc.kill(); },
  };
}

// 測っている間に Mac がスリープすると計測が止まるので、このプロセスが終わるまでスリープさせない（macOS の caffeinate）。
// さらに、操作が無い状態が長く続くと、penguins・diamond が約 15% 遅くなる状態に入ることがあるので（docs/performance.md）、
// 画面を点けたままにし、操作中であることを定期的に知らせる。--idle のときは、スリープを止めるだけにする
function keepAwake(idle) {
  // unref しないと、caffeinate がこのプロセスの終わりを待ち、このプロセスが caffeinate の終わりを待って、終わらなくなる
  const run = (args) => spawn('caffeinate', args, { stdio: 'ignore' }).on('error', () => {}).unref();
  run([idle ? '-i' : '-id', '-w', String(process.pid)]);
  if (idle) return;
  run(['-u', '-t', '1']);
  setInterval(() => run(['-u', '-t', '1']), USER_ACTIVE_INTERVAL_MS).unref();
}

// 進捗を標準出力に 1 行ずつ出す（途中の様子を tail などで見るため）。先頭は計測を始めてからの経過時間
const startedAt = Date.now();
function progress(message) {
  const sec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}] ${message}`);
}

// GPU の温度が limit（℃）以下に下がるまで待つ。GPU は熱がたまると OS がクロックを下げるので（docs/performance.md）、
// 作品ごとに冷めた状態から測る
async function coolDown(monitor, limit) {
  const start = Date.now();
  let shown = 0;
  while (monitor.latest().temp > limit) {
    // 値が古いまま（macmon が止まっている）なら、古い温度で待ち続けない
    if (Date.now() - monitor.latest().t > MONITOR_STALE_MS) throw new Error(`macmon の値が ${Math.round((Date.now() - monitor.latest().t) / 1000)} 秒更新されていない`);
    if (Date.now() - start > COOL_TIMEOUT_MS) throw new Error(`GPU が ${limit}℃ まで冷めない（いま ${monitor.latest().temp.toFixed(1)}℃）`);
    if (Date.now() - shown >= 30000) {   // 待っている間も、30 秒ごとに温度を出す
      progress(`冷めるのを待っている: GPU ${monitor.latest().temp.toFixed(1)}℃ → ${limit}℃`);
      shown = Date.now();
    }
    await new Promise((r) => setTimeout(r, COOL_POLL_MS));
  }
  progress(`GPU ${monitor.latest().temp.toFixed(1)}℃（冷めるのを ${Math.round((Date.now() - start) / 1000)} 秒待った）`);
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

async function measure(browser, origin, def, sceneIndex, condition, version, opts) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const pageInfo = await (await fetch(`${opts.httpBase}/json/list`)).json();
  const target = pageInfo.find((t) => t.id === targetId);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: condition.width, height: condition.height, deviceScaleFactor: condition.dpr, mobile: false,
    });
    const advance = Math.round(opts.warmup * 1000 / STEP_MS);   // --warmup の秒数を、進めておくコマ数にする
    const q = new URLSearchParams({ seed: SEED, scene: sceneIndex, frames: opts.frames, settle: SETTLE_FRAMES, advance, overhead: OVERHEAD_FRAMES, step: STEP_MS, loadIter: LOAD_ITERATIONS, spin: SPIN_WORKERS });
    await cdp.send('Page.navigate', { url: `${origin}/${def.page}.html?${q}` });
    const r = await waitForResult(cdp);
    if (opts.shots) {
      // 描いた絵に中身があることを、人が確かめるための画像
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      const name = `${def.page}-${sceneIndex}-${condition.name}${version ? `-${version}` : ''}.jpg`;
      await writeFile(path.join(opts.shots, name), Buffer.from(shot.data, 'base64'));
    }
    return r;
  } finally {
    cdp.ws.close();
    await browser.send('Target.closeTarget', { targetId });
  }
}

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };

// docs/performance-data.md に貼る一覧。時間は条件ごとの表に、条件で変わらない値は最後の表にまとめる
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

// --base で比べたときの一覧。行ごとに変更前（base）と変更後（作業ツリー）の時間と差を並べ、
// docs/performance.md の「比べ方」の目安で判定する
function toCompareMarkdown(baseRows, rows) {
  const pct = (before, after) => `${after >= before ? '+' : '−'}${(Math.abs(after / before - 1) * 100).toFixed(1)}%`;
  const lines = [
    '| 条件 | 作品 | シーン | GPU タイマー (ms) | 差 | 判定の基準 | コマ全体 (ms) | 差 | 基準負荷の差 | 描画命令・三角形 | 判定 |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
  ];
  for (const a of rows) {
    const b = baseRows.find((x) => x.page === a.page && x.sceneIndex === a.sceneIndex && x.condition === a.condition);
    const refDiff = Math.abs(a.reference / b.reference - 1);
    const gpuDiff = Math.abs(a.gpu_ms / b.gpu_ms - 1);
    const content = a.calls === b.calls && a.triangles === b.triangles ? '同じ' : `${b.calls}→${a.calls}・${b.triangles}→${a.triangles}`;
    // 周ごとの値の幅（最大−最小）の、中央値に対する割合。変更前と変更後の大きい方を、その行の揺れとみなす
    const spread = Math.max((b.gpuMax - b.gpuMin) / b.gpu_ms, (a.gpuMax - a.gpuMin) / a.gpu_ms);
    const threshold = Math.max(TIME_SIGNIFICANCE, spread);
    const verdict = refDiff > REFERENCE_TOLERANCE ? '比べない（測り直す）' : gpuDiff > threshold ? '差あり' : '差なし';
    lines.push(`| ${a.condition} | ${a.page} | ${a.scene ?? '—'} | ${b.gpu_ms.toFixed(2)} → ${a.gpu_ms.toFixed(2)} | ${pct(b.gpu_ms, a.gpu_ms)} | ${(threshold * 100).toFixed(1)}% | ${b.total.toFixed(1)} → ${a.total.toFixed(1)} | ${pct(b.total, a.total)} | ${pct(b.reference, a.reference)} | ${content} | ${verdict} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// 引数なしや、引数の誤りのときに出すオプションの一覧
const USAGE = `使い方: node tools/gpu-bench.mjs (--all | --only 作品名,…) [オプション]

作品名: ${PAGES.map((p) => p.page).join(' ')}
  --all              全作品・全シーンを測る（--cool なしで約 12 分）
  --only a,b         測る作品を絞る
  --rounds N         全シーンを何周するか（既定 3）
  --frames N         1 回に測るコマ数（既定 450。1 コマは作品の中の時間で 1/30 秒）
  --warmup S         測る前に作品の時間を進めておく秒数（既定 0。時間とともに重くなる作品の後半を測る）
  --base 版          比べる版（git のコミットか、作品の HTML のパス）。その版と作業ツリーの版を交互に測り、差の一覧を出す
  --cool C           作品ごとに、GPU の温度が C℃ 以下に下がるのを待ってから測る（macmon が要る。基準値は 50）
  --idle             画面を点けたままにせず、操作中であることも知らせない（操作が無いときの遅い状態を確かめる用）
  --scene N          シーンのある作品は、N 番目（0 から）のシーンだけを測る
  --conditions a,b   測る条件（${CONDITIONS.map((c) => c.name).join(',')}。既定は全部）
  --json PATH        全項目を JSON に書き出す
  --shots DIR        各シーンの最後のコマを画像に書き出す`;

// 引数の誤り。スタックトレースを出さず、理由とオプションの一覧だけを出す
class UsageError extends Error {}

// 名前の並び（a,b）を読み、知らない名前があれば止める
function parseNames(v, known, label) {
  const names = v.split(',');
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length) throw new UsageError(`不明な${label}: ${unknown.join(', ')}`);
  return names;
}

function parseNumber(k, v, min) {
  const n = Number(v);
  if (!(n >= min)) throw new UsageError(`${k} は ${min} 以上の数にする`);
  return n;
}

function parseArgs(argv) {
  // 引数なしでは測らない（うっかり全作品の計測を始めないため）。全作品は --all で測る
  if (!argv.length) throw new UsageError('');
  const opts = { all: false, rounds: 3, frames: 450, warmup: 0, cool: null, idle: false, scene: null, base: null, only: null, conditions: null, json: null, shots: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--all') { opts.all = true; continue; }   // 値を取らないのは --all と --idle だけ
    if (k === '--idle') { opts.idle = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new UsageError(`${k} の値が無い`);
    if (k === '--rounds') opts.rounds = parseNumber(k, v, 1);
    else if (k === '--frames') opts.frames = parseNumber(k, v, 1);
    else if (k === '--warmup') opts.warmup = parseNumber(k, v, 0);
    else if (k === '--cool') opts.cool = parseNumber(k, v, 0);
    else if (k === '--scene') opts.scene = Math.floor(parseNumber(k, v, 0));
    else if (k === '--base') opts.base = v;
    else if (k === '--only') opts.only = parseNames(v, PAGES.map((p) => p.page), '作品名');
    else if (k === '--conditions') opts.conditions = parseNames(v, CONDITIONS.map((c) => c.name), '条件');
    else if (k === '--json') opts.json = v;
    else if (k === '--shots') opts.shots = v;
    else throw new UsageError(`不明な引数: ${k}`);
  }
  if (opts.all && opts.only) throw new UsageError('--all と --only は一緒に使えない');
  if (!opts.all && !opts.only) throw new UsageError('--all か --only で測る作品を選ぶ');
  const baseIsFile = opts.base && existsSync(path.resolve(opts.base)) && statSync(path.resolve(opts.base)).isFile();
  if (baseIsFile && opts.only?.length !== 1) throw new UsageError('--base に HTML のパスを渡すときは、--only で作品を 1 つだけ選ぶ');
  return opts;
}

// 1 つの行（作品・シーン・条件）の、周ごとの結果をまとめる。時間は周ごとの中央値の中央値と、その最小〜最大
function summarize(page, sceneIndex, condition, list) {
  const pick = (get) => list.map(get);
  const totals = pick((r) => r.totalMedian);
  const gpus = pick((r) => r.gpuMedian);
  const first = list[0];
  return {
    page, sceneIndex, scene: first.scene, condition,
    buffer: first.buffer, dpr: first.dpr, touch: first.touch, gpu: first.gpu,
    rounds: list.length,
    total: median(totals), totalMin: Math.min(...totals), totalMax: Math.max(...totals),
    totalP95: median(pick((r) => r.totalP95)),
    wait: median(pick((r) => r.waitMedian)),
    overhead: median(pick((r) => r.overheadMedian)),
    calls: median(pick((r) => r.callsMedian)), callsMax: Math.max(...pick((r) => r.callsMax)),
    triangles: median(pick((r) => r.trianglesMedian)), trianglesMax: Math.max(...pick((r) => r.trianglesMax)),
    contentRatio: Math.min(...pick((r) => r.contentRatio)),
    reference: median(pick((r) => r.referenceMedian)),
    referenceMax: Math.max(...pick((r) => r.referenceMedian)),
    gpu_ms: median(gpus), gpuMin: Math.min(...gpus), gpuMax: Math.max(...gpus),
    gpuP95: median(pick((r) => r.gpuP95)),
    gpuSamples: first.gpuSamples, disjoint: first.disjoint,
    // macmon があるときだけ。計測 1 回（ページの読み込みから）の間の平均の、周ごとの中央値
    gpuTemp: first.monitor ? median(pick((r) => r.monitor.temp)) : undefined,
    gpuFreq: first.monitor ? median(pick((r) => r.monitor.freq)) : undefined,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.platform === 'darwin') keepAwake(opts.idle);
  const monitor = await startMonitor();
  if (opts.cool != null && !monitor) throw new UsageError('--cool には macmon が要る（brew install macmon）');
  if (opts.shots) await mkdir(opts.shots, { recursive: true });
  const servers = [];
  const listen = async (root) => {
    const server = await serve(root);
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  // 測る版。--base があれば、その版と作業ツリーの版をシーンごとに交互に測り、時間による揺れが片方に偏らないようにする
  const tempDir = opts.base ? await mkdtemp(path.join(tmpdir(), 'gpu-bench-base-')) : null;
  let baseRoot;
  try {
    if (opts.base) baseRoot = await checkoutBase(opts.base, opts.only?.[0], tempDir);
  } catch (e) {
    await rm(tempDir, { recursive: true, force: true });
    throw e;
  }
  const versions = opts.base
    ? [{ label: 'base', origin: await listen(baseRoot) }, { label: 'work', origin: await listen(ROOT) }]
    : [{ label: null, origin: await listen(ROOT) }];
  const { chrome, wsUrl, userDataDir } = await launchChrome('gpu-bench');
  opts.httpBase = `http://${new URL(wsUrl).host}`;
  const browser = await connectCdp(wsUrl);
  const pages = PAGES.filter((p) => !opts.only || opts.only.includes(p.page));
  const conditions = CONDITIONS.filter((c) => !opts.conditions || opts.conditions.includes(c.name));

  try {
    // シーンの数は最初の 1 回で分かる（for の条件は毎回読み直す）。温度などの揺れが特定のシーンに偏らないよう、全シーンを順に回す。
    // --cool のときは作品ごとに区切り、冷めるのを待ってから、その作品の全シーンを周の数だけ回す
    const sceneCounts = new Map();
    const samples = new Map();   // "版/作品/番号/条件" -> 結果の配列
    const groups = opts.cool != null ? pages.map((p) => [p]) : [pages];
    for (const [g, group] of groups.entries()) {
      if (groups.length > 1) progress(`作品 ${g + 1}/${groups.length}: ${group[0].page}`);
      if (opts.cool != null) await coolDown(monitor, opts.cool);
      for (let round = 0; round < opts.rounds; round++) {
        for (const condition of conditions) {
          for (const def of group) {
            // --scene のときは、シーンのある作品はそのシーンだけ、無い作品は 1 行だけ測る
            const first = opts.scene != null && def.scenes ? opts.scene : 0;
            // 終わりの番号は、測るたびに sceneCounts から求め直す
            const last = () => (opts.scene != null ? first + 1 : (sceneCounts.get(def.page) ?? 1));
            for (let i = first; i < last(); i++) {
              for (const { label, origin } of versions) {
                const t0 = Date.now();
                const r = await measure(browser, origin, def, i, condition, label, opts);
                if (monitor) r.monitor = monitor.between(t0, Date.now());
                sceneCounts.set(def.page, r.sceneCount);
                const key = `${label}/${def.page}/${i}/${condition.name}`;
                if (!samples.has(key)) samples.set(key, []);
                samples.get(key).push(r);
                const mon = r.monitor ? ` ${r.monitor.temp.toFixed(0)}℃ ${r.monitor.freq.toFixed(0)}MHz` : '';
                progress(`[${round + 1}/${opts.rounds}]${label ? ` ${label}` : ''} ${condition.name} ${def.page} ${r.scene ?? ''} gpu=${r.gpuMedian?.toFixed(2)} (p95 ${r.gpuP95?.toFixed(2)}, n=${r.gpuSamples}, disjoint=${r.disjoint}) total=${r.totalMedian.toFixed(1)} wait=${r.waitMedian.toFixed(1)} ref=${r.referenceMedian?.toFixed(2)} calls=${r.callsMedian} tris=${r.trianglesMedian} ${r.buffer.join('x')}${mon}`);
              }
            }
          }
        }
      }
    }
    const rowsOf = (version) => [...samples].filter(([key]) => key.startsWith(`${version}/`)).map(([key, list]) => {
      const [, page, scene, condition] = key.split('/');
      return summarize(page, Number(scene), condition, list);
    });
    const rows = rowsOf(versions.at(-1).label);
    const baseRows = opts.base ? rowsOf('base') : undefined;
    const output = JSON.stringify({ date: new Date().toISOString(), seed: SEED, frames: opts.frames, warmup: opts.warmup, rounds: opts.rounds, cool: opts.cool ?? undefined, base: opts.base ?? undefined, baseRows, rows }, null, 2);
    if (opts.json) await writeFile(opts.json, output);
    console.log(opts.base ? toCompareMarkdown(baseRows, rows) : toMarkdown(rows));
  } finally {
    monitor?.stop();
    browser.ws.close();
    chrome.removeAllListeners('exit');
    chrome.kill();
    for (const server of servers) server.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  if (e instanceof UsageError) console.error(e.message ? `${e.message}\n\n${USAGE}` : USAGE);
  else console.error(e);
  process.exit(1);
});
