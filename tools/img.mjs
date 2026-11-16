#!/usr/bin/env node
// 撮った静止画・動画から、確認用の画像を作る（切り出し・拡大・並べる）か、明るさを測る。使い方と例は docs/video.md。
//
//   node tools/img.mjs grid <入力>... [--crop x,y,w,h] [--at 秒,秒] [--cols N] [--max 800] [--nearest] [--out 出力先.jpg]
//   node tools/img.mjs luma <入力>... [--crop x,y,w,h] [--at 秒,秒] [--rows N]
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
const JPEG_QUALITY = 3;   // grid を JPEG で書くときの画質（ffmpeg の -q:v。小さいほど高画質。2..31）
const VIDEO_EXT = /\.(mp4|mov|webm|mkv)$/i;

const USAGE = `使い方:
  node tools/img.mjs grid <入力>... [オプション]   切り出し・拡大・並べた画像を 1 枚作る
  node tools/img.mjs luma <入力>... [オプション]   明るさ（輝度 0..255）の平均と最大を出す

入力は静止画（PNG・JPEG）か動画（MP4 など。--at が要る）。
  --crop x,y,w,h  切り出す範囲。px か、入力の大きさに対する % で書く（例: 0,50%,100%,50% は下半分）
  --at 1,2.5      動画から取り出す時刻（秒）。動画 1 本ごとに、時刻の数だけコマにする
  --cols N        grid の列の数（既定: --at の時刻の数、無ければ入力の数。上限 ${MAX_COLS}）
  --max PX        grid の出力の長辺（既定 ${MAX_SIDE}）。小さい範囲を切り出したときは、ここまで拡大する
  --nearest       grid の拡大を補間しない（画素を確かめるとき）
  --out PATH      grid の出力先（既定 <最初の入力>.grid.jpg）。.png にすると PNG で書く
  --rows N        luma で、範囲を上から N 本の帯に分けて、帯ごとの平均も出す`;

// ---- 外部のコマンド ----
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

// 静止画・動画の大きさ（px）
async function probeSize(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [width, height] = out.trim().split(',').map(Number);
  return { width, height };
}

// ---- 入力 ----
// 入力を 1 コマずつの { file, time, label } に広げる。動画は --at の時刻ごとに 1 コマ
function expandInputs(files, times) {
  const frames = [];
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`入力が無い: ${file}`);
    if (VIDEO_EXT.test(file)) {
      if (times.length === 0) throw new Error(`動画には --at で時刻を指定する: ${file}`);
      for (const time of times) frames.push({ file, time, label: `${path.basename(file)}@${time}s` });
    } else {
      frames.push({ file, time: null, label: path.basename(file) });
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
const even = (v) => Math.max(2, Math.floor(v / 2) * 2);

// ---- grid ----
// コマを切り出し、同じ大きさにそろえて格子に並べる。コマの大きさは最初のコマ（切り出し後）の縦横比で決める
async function grid(frames, values) {
  const size = await probeSize(frames[0].file);
  const crop = parseCrop(values.crop, size);
  const times = values.at ? values.at.split(',').length : 0;
  const cols = Number(values.cols ?? Math.min(MAX_COLS, times > 1 ? times : frames.length));
  const rows = Math.ceil(frames.length / cols);
  const maxSide = Number(values.max);
  // 隙間を除いた幅・高さが長辺 maxSide に収まるように、コマの幅を決める
  const aspect = crop.h / crop.w;
  const cellW = even(Math.min((maxSide - GAP * (cols - 1)) / cols, (maxSide - GAP * (rows - 1)) / rows / aspect));
  const cellH = even(cellW * aspect);
  const flags = values.nearest ? 'neighbor' : 'lanczos';

  const sizes = await Promise.all(frames.map((f) => probeSize(f.file)));
  const chains = frames.map((f, i) => {
    const c = parseCrop(values.crop, sizes[i]);
    return `[${i}:v]${cropFilter(c)},scale=${cellW}:${cellH}:flags=${flags}:force_original_aspect_ratio=decrease,`
      + `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[c${i}]`;
  });
  let graph;
  if (frames.length === 1) {
    graph = chains[0].replace(/\[c0\]$/, '');
  } else {
    const layout = frames.map((_, i) => `${(i % cols) * (cellW + GAP)}_${Math.floor(i / cols) * (cellH + GAP)}`).join('|');
    const labels = frames.map((_, i) => `[c${i}]`).join('');
    graph = `${chains.join(';')};${labels}xstack=inputs=${frames.length}:layout=${layout}:fill=${GAP_COLOR}`;
  }
  const out = values.out ?? `${frames[0].file.replace(/\.[^.\/]+$/, '')}.grid.jpg`;
  const quality = /\.png$/i.test(out) ? [] : ['-q:v', String(JPEG_QUALITY)];
  await ffmpeg([...frames.flatMap(inputArgs), '-filter_complex', graph, '-frames:v', '1', ...quality, out]);

  const outSize = await probeSize(out);
  console.log(`${out}: ${outSize.width}x${outSize.height}（${cols} 列 × ${rows} 行、1 コマ ${cellW}x${cellH}、切り出し ${crop.w}x${crop.h}+${crop.x}+${crop.y}）`);
  for (let r = 0; r < rows; r++) {
    console.log(`  ${r + 1} 行目: ${frames.slice(r * cols, (r + 1) * cols).map((f) => f.label).join('  ')}`);
  }
}

// ---- luma ----
// 切り出した範囲を灰色（PGM）で読み、輝度の平均と最大を出す。--rows なら上からの帯ごとの平均も出す
async function readGray(frame, crop) {
  const filter = `${crop ? `${cropFilter(crop)},` : ''}format=gray`;
  // run() は出力を文字列にするので、画素のバイト列はここで直に受け取る
  const buf = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...inputArgs(frame), '-vf', filter, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'pgm', '-']);
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg が失敗した (${code})\n${err}`))));
  });
  // PGM（P5）の見出し: "P5\n幅 高さ\n最大値\n" のあとに画素が並ぶ
  const header = buf.subarray(0, 64).toString('latin1').match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!header) throw new Error(`灰色の画像を読めない: ${frame.label}`);
  const [, width, height] = header.map(Number);
  return { width, height, pixels: buf.subarray(header[0].length) };
}

async function luma(frames, values) {
  const rows = Number(values.rows ?? 0);
  for (const frame of frames) {
    const crop = values.crop ? parseCrop(values.crop, await probeSize(frame.file)) : null;
    const { width, height, pixels } = await readGray(frame, crop);
    let sum = 0;
    let max = 0;
    for (const v of pixels) { sum += v; if (v > max) max = v; }
    let line = `${frame.label}: 平均 ${(sum / pixels.length).toFixed(1)}・最大 ${max}`;
    if (rows > 0) {
      const bands = [];
      for (let b = 0; b < rows; b++) {
        const y0 = Math.floor((height * b) / rows);
        const y1 = Math.floor((height * (b + 1)) / rows);
        let s = 0;
        for (let i = y0 * width; i < y1 * width; i++) s += pixels[i];
        bands.push((s / ((y1 - y0) * width)).toFixed(1));
      }
      line += `｜帯（上から）${bands.join(' ')}`;
    }
    console.log(line);
  }
}

// ---- 本体 ----
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      crop: { type: 'string' },
      at: { type: 'string' },
      cols: { type: 'string' },
      max: { type: 'string', default: String(MAX_SIDE) },
      nearest: { type: 'boolean', default: false },
      out: { type: 'string' },
      rows: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...files] = positionals;
  if (values.help || !['grid', 'luma'].includes(command) || files.length === 0) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const times = values.at ? values.at.split(',').map(Number) : [];
  if (times.some((t) => !Number.isFinite(t) || t < 0)) throw new Error(`--at の時刻が正しくない: ${values.at}`);
  const frames = expandInputs(files, times);
  if (command === 'grid') await grid(frames, values);
  else await luma(frames, values);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
