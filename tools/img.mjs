#!/usr/bin/env node
// 撮った静止画・動画から、確認用の画像を作る（切り出し・拡大・並べる・差を見る）か、明るさを測る。使い方と例は docs/video.md。
//
//   node tools/img.mjs grid <入力>... [--crop x,y,w,h] [--at 秒,秒] [--cols N] [--max 800] [--nearest] [--out 出力先.jpg]
//   node tools/img.mjs luma <入力>... [--crop x,y,w,h] [--at 秒,秒] [--rows N]
//   node tools/img.mjs diff <入力A> <入力B> [--crop x,y,w,h] [--at 秒] [--gain 4] [--out 出力先.png]
//
// 入力のファイルは変更しない。依存は ffmpeg（ffprobe を含む）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './common.mjs';

// ---- 設定 ----
const MAX_SIDE = 800;     // grid の出力の長辺の既定（px）。CLAUDE.md の「画像は長辺 800px 以下」に合わせる
const MAX_COLS = 4;       // grid の列の数の既定の上限（--at で時刻が複数あるときは、時刻の数を列にする）
const GAP = 4;            // grid のコマの間の隙間（px）
const GAP_COLOR = 'gray'; // 隙間の色。黒い画面どうしの境目が分かるように、黒にしない
const DIFF_GAIN = 4;      // diff で差を何倍に明るくするかの既定
const JPEG_QUALITY = 3;   // grid を JPEG で書くときの画質（ffmpeg の -q:v。小さいほど高画質。2..31）
const VIDEO_EXT = /\.(mp4|mov|webm|mkv)$/i;

const USAGE = `使い方:
  node tools/img.mjs grid <入力>... [オプション]   切り出し・拡大・並べた画像を 1 枚作る
  node tools/img.mjs luma <入力>... [オプション]   明るさ（輝度 0..255）の平均と最大を出す
  node tools/img.mjs diff <A> <B> [オプション]     2 枚の画素ごとの差を画像にし、差のある画素の割合と最大を出す

入力は静止画（PNG・JPEG）か動画（MP4 など。--at が要る）。
  --crop x,y,w,h  切り出す範囲。px か、入力の大きさに対する % で書く（例: 0,50%,100%,50% は下半分）
  --at 1,2.5      動画から取り出す時刻（秒）。動画 1 本ごとに、時刻の数だけコマにする
  --cols N        grid の列の数（既定: --at の時刻の数、無ければ入力の数。上限 ${MAX_COLS}）
  --max PX        grid の出力の長辺（既定 ${MAX_SIDE}）。小さい範囲を切り出したときは、ここまで拡大する
  --nearest       grid の拡大を補間しない（画素を確かめるとき）
  --rows N        luma で、範囲を上から N 本の帯に分けて、帯ごとの平均も出す
  --gain N        diff の画像で、差を N 倍に明るくする（既定 ${DIFF_GAIN}）。標準出力の値は倍にする前の差
  --out PATH      出力先。grid の既定は <最初の入力>.grid.jpg（.png にすると PNG で書く）、diff の既定は <A>.diff.png`;

// ---- 外部のコマンド ----
const FFMPEG_ARGS = ['-hide_banner', '-loglevel', 'error'];
const ffmpeg = (args) => run('ffmpeg', [...FFMPEG_ARGS, '-y', ...args]);

// ffmpeg で 1 コマを書き出し、生の画素（rawvideo）のバイト列を返す。run() は出力を文字列にするので、ここで直に受け取る
function ffmpegPixels(args, pixFmt) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [...FFMPEG_ARGS, ...args, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-']);
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg が失敗した (${code})\n${err}`))));
  });
}

// 静止画・動画の大きさ（px）
async function probeSize(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [width, height] = out.trim().split(',').map(Number);
  return { width, height };
}

// ---- 入力 ----
// 入力を 1 コマずつの { file, time, label, size } に広げる。動画は --at の時刻ごとに 1 コマ。大きさはファイルごとに 1 回だけ測る
async function loadFrames(files, times) {
  const frames = [];
  for (const file of new Set(files)) {
    if (!existsSync(file)) throw new Error(`入力が無い: ${file}`);
    if (VIDEO_EXT.test(file) && times.length === 0) throw new Error(`動画には --at で時刻を指定する: ${file}`);
  }
  const sizes = new Map(await Promise.all([...new Set(files)].map(async (file) => [file, await probeSize(file)])));
  for (const file of files) {
    const size = sizes.get(file);
    if (VIDEO_EXT.test(file)) {
      for (const time of times) frames.push({ file, time, label: `${path.basename(file)}@${time}s`, size });
    } else {
      frames.push({ file, time: null, label: path.basename(file), size });
    }
  }
  return frames;
}

// ffmpeg の入力の引数。動画は時刻へ飛んで 1 コマだけ読む
const inputArgs = (frame) => (frame.time === null ? ['-i', frame.file] : ['-ss', String(frame.time), '-i', frame.file]);

// "x,y,w,h"（px か %）を、大きさ size に対する px の範囲にする。省くと全体
function parseCrop(text, size) {
  if (!text) return { x: 0, y: 0, w: size.width, h: size.height };
  const parts = text.split(',');
  if (parts.length !== 4) throw new Error(`--crop は x,y,w,h の 4 つで書く: ${text}`);
  const [x, y, w, h] = parts.map((p, i) => {
    const full = i % 2 === 0 ? size.width : size.height;
    const v = p.endsWith('%') ? (full * Number(p.slice(0, -1))) / 100 : Number(p);
    if (!Number.isFinite(v)) throw new Error(`--crop の値が数でない: ${p}`);
    return Math.round(v);
  });
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > size.width || y + h > size.height) {
    throw new Error(`--crop ${text} が入力（${size.width}x${size.height}）からはみ出す`);
  }
  return { x, y, w, h };
}

const cropFilter = (c) => `crop=${c.w}:${c.h}:${c.x}:${c.y}`;
const cropText = (c) => `${c.w}x${c.h}+${c.x}+${c.y}`;
const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
// 出力先の既定。最初の入力の拡張子を suffix に替える
const defaultOut = (frame, suffix) => frame.file.replace(/\.[^./]+$/, '') + suffix;

// ---- grid ----
// コマを切り出し、同じ大きさにそろえて格子に並べる。コマの大きさは最初のコマ（切り出し後）の縦横比で決める
async function grid(frames, values, times) {
  const crops = frames.map((f) => parseCrop(values.crop, f.size));
  const cols = values.cols ?? Math.min(MAX_COLS, times.length > 1 ? times.length : frames.length);
  const rows = Math.ceil(frames.length / cols);
  const maxSide = values.max ?? MAX_SIDE;
  // 隙間を除いた幅・高さが長辺 maxSide に収まるように、コマの幅を決める
  const aspect = crops[0].h / crops[0].w;
  const cellW = even(Math.min((maxSide - GAP * (cols - 1)) / cols, (maxSide - GAP * (rows - 1)) / rows / aspect));
  const cellH = even(cellW * aspect);
  const flags = values.nearest ? 'neighbor' : 'lanczos';

  // コマごとに切り出して cellW x cellH に収め、余りを黒で埋める
  const chains = crops.map((c, i) => `[${i}:v]${cropFilter(c)},scale=${cellW}:${cellH}:flags=${flags}:force_original_aspect_ratio=decrease,`
    + `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`);
  let graph;
  if (frames.length === 1) {
    graph = chains[0];
  } else {
    const layout = frames.map((_, i) => `${(i % cols) * (cellW + GAP)}_${Math.floor(i / cols) * (cellH + GAP)}`).join('|');
    const labels = frames.map((_, i) => `[c${i}]`).join('');
    graph = `${chains.map((chain, i) => `${chain}[c${i}]`).join(';')};${labels}xstack=inputs=${frames.length}:layout=${layout}:fill=${GAP_COLOR}`;
  }
  const out = values.out ?? defaultOut(frames[0], '.grid.jpg');
  const quality = /\.png$/i.test(out) ? [] : ['-q:v', String(JPEG_QUALITY)];
  await ffmpeg([...frames.flatMap(inputArgs), '-filter_complex', graph, '-frames:v', '1', ...quality, out]);

  const outSize = await probeSize(out);
  console.log(`${out}: ${outSize.width}x${outSize.height}（${cols} 列 × ${rows} 行、1 コマ ${cellW}x${cellH}、切り出し ${cropText(crops[0])}）`);
  for (let r = 0; r < rows; r++) {
    console.log(`  ${r + 1} 行目: ${frames.slice(r * cols, (r + 1) * cols).map((f) => f.label).join('  ')}`);
  }
}

// ---- luma ----
// 切り出した範囲を灰色で読み、輝度の平均と最大を出す。--rows なら上からの帯ごとの平均も出す
async function luma(frames, values) {
  const rows = values.rows ?? 0;
  for (const frame of frames) {
    const crop = parseCrop(values.crop, frame.size);
    const pixels = await ffmpegPixels([...inputArgs(frame), '-vf', cropFilter(crop)], 'gray');
    let sum = 0;
    let max = 0;
    for (const v of pixels) { sum += v; if (v > max) max = v; }
    let line = `${frame.label}: 平均 ${(sum / pixels.length).toFixed(1)}・最大 ${max}`;
    if (rows > 0) {
      const bands = [];
      for (let b = 0; b < rows; b++) {
        const y0 = Math.floor((crop.h * b) / rows);
        const y1 = Math.floor((crop.h * (b + 1)) / rows);
        let s = 0;
        for (let i = y0 * crop.w; i < y1 * crop.w; i++) s += pixels[i];
        bands.push((s / ((y1 - y0) * crop.w)).toFixed(1));
      }
      line += `｜帯（上から）${bands.join(' ')}`;
    }
    console.log(line);
  }
}

// ---- diff ----
// 2 コマの同じ範囲を切り出し、画素ごとの RGB の差の絶対値を gain 倍にした画像を書く。
// 標準出力には、倍にする前の差で、差のある画素（RGB のどれかが違う画素）の割合と、差の最大（RGB のうち大きいほう。0..255）を出す
async function diff(frames, values) {
  if (frames.length !== 2) throw new Error('diff は入力を 2 つ（動画なら --at の時刻を 1 つ）にする');
  const [a, b] = frames.map((f) => f.size);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`diff の入力の大きさが違う: ${a.width}x${a.height} と ${b.width}x${b.height}`);
  const crop = parseCrop(values.crop, a);
  const gain = values.gain ?? DIFF_GAIN;
  const inputs = frames.flatMap(inputArgs);
  const difference = `[0:v]${cropFilter(crop)},format=gbrp[a];[1:v]${cropFilter(crop)},format=gbrp[b];[a][b]blend=all_mode=difference`;

  const out = values.out ?? defaultOut(frames[0], '.diff.png');
  const amp = `val*${gain}`;
  await ffmpeg([...inputs, '-filter_complex', `${difference},lutrgb=r='${amp}':g='${amp}':b='${amp}',format=rgb24`, '-frames:v', '1', out]);

  const pixels = await ffmpegPixels([...inputs, '-filter_complex', difference], 'rgb24');
  let changed = 0;
  let max = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const v = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (v > 0) changed++;
    if (v > max) max = v;
  }
  console.log(`${out}: ${crop.w}x${crop.h}（差 ×${gain}）。差のある画素 ${(300 * changed / pixels.length).toFixed(2)}%・差の最大 ${max}`);
}

// ---- 本体 ----
// サブコマンドごとに、使えるオプション
const COMMANDS = {
  grid: { run: grid, options: ['crop', 'at', 'cols', 'max', 'nearest', 'out'] },
  luma: { run: luma, options: ['crop', 'at', 'rows'] },
  diff: { run: diff, options: ['crop', 'at', 'gain', 'out'] },
};
const NUMBER_OPTIONS = ['cols', 'max', 'rows', 'gain']; // 1 以上の整数で受け取るオプション

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      crop: { type: 'string' },
      at: { type: 'string' },
      cols: { type: 'string' },
      max: { type: 'string' },
      nearest: { type: 'boolean' },
      out: { type: 'string' },
      rows: { type: 'string' },
      gain: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [name, ...files] = positionals;
  const command = COMMANDS[name];
  if (values.help || !command || files.length === 0) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const unused = Object.keys(values).filter((key) => !command.options.includes(key));
  if (unused.length > 0) throw new Error(`${name} では使えないオプション: ${unused.map((key) => `--${key}`).join(' ')}`);
  for (const key of NUMBER_OPTIONS) {
    if (values[key] === undefined) continue;
    const v = Number(values[key]);
    if (!Number.isInteger(v) || v < 1) throw new Error(`--${key} は 1 以上の整数にする: ${values[key]}`);
    values[key] = v;
  }
  const times = values.at ? values.at.split(',').map(Number) : [];
  if (times.some((t) => !Number.isFinite(t) || t < 0)) throw new Error(`--at の時刻が正しくない: ${values.at}`);
  await command.run(await loadFrames(files, times), values, times);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
