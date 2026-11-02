#!/usr/bin/env node
// 2 つの版の作品を同じ条件で撮り、並べた比較動画と確認用の画像を作る。使い方と例は docs/video.md。
//
//   node tools/video-compare.mjs <作品名> [--base HEAD] [--case "名前:式"]... [--scenes 0,1,2] [--seconds 4] [--warmup 3] [--seed 1] [--out 出力先.mp4] [--open]
//
// 撮影は video-export.mjs に任せる。作品の HTML も作業ツリーも変更しない。依存は video-export.mjs と同じで、加えて git と tar。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---- 設定 ----
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXPORTER = path.join(ROOT, 'tools', 'video-export.mjs');
const VIDEO_WIDTH = 1920;         // 比較動画の幅（px）。列が 1 つのときは半分にする
const SHEET_MAX = 1536;           // 確認用の画像の長辺の上限（px）。これより大きいと、読むときに縮小され、トークンも増える
const X264_CRF = 20;              // 比較動画の画質（小さいほど高画質。0..51）
const CAPTURE_TRIES = 3;          // 読み込みの失敗（net::ERR_）で撮影が止まったときに、試す回数

const USAGE = `使い方: node tools/video-compare.mjs <作品名> [オプション]

上の段に --base の版、下の段に作業ツリーの版を並べる。
  --base 版       比べる版。git のコミットか、作品の HTML のパス（既定 HEAD）
  --case "名前:式" 列を 1 つ足す。収録の最初に式を実行する。複数指定できる（省くと、そのままの 1 列）
  --scenes 0,1,2  場面の番号（drone・ripple・waterfall・penguins のみ）
  --seconds S     1 場面の長さ（秒。既定 4）
  --warmup S      各場面の収録前に進めておく時間（秒。既定 3）
  --seed N        乱数の種（既定 1）
  --out PATH      出力先（既定 <作品名>-compare.mp4）。確認用の画像を <出力先>.thumbs.jpg に作る
  --open          できた動画を開く`;

// ---- 外部のコマンド ----
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(command)} が失敗した (${code})\n${err}`))));
  });
}

const ffmpeg = (args, options) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], options);

// ---- 引数 ----
function parseOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string', default: 'HEAD' },
      case: { type: 'string', multiple: true, default: [] },
      scenes: { type: 'string' },
      seconds: { type: 'string', default: '4' },
      warmup: { type: 'string', default: '3' },
      seed: { type: 'string', default: '1' },
      out: { type: 'string' },
      open: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) throw new Error(USAGE);
  const cases = values.case.map((spec) => {
    const m = spec.match(/^([^:]+):(.+)$/s);
    if (!m) throw new Error(`--case は「名前:式」で書く: ${spec}`);
    return { label: m[1], code: m[2] };
  });
  return {
    ...values,
    page: positionals[0],
    cases: cases.length ? cases : [{ label: 'そのまま', code: null }],
    sceneCount: values.scenes ? values.scenes.split(',').length : 1,
    out: path.resolve(values.out ?? `${positionals[0]}-compare.mp4`),
  };
}

// ---- 比べる版を取り出す ----
// HTML のパスなら HEAD に重ねる。撮影の処理は、どの版でも今の video-export.mjs を使う（古い版には無いことがあるため）
async function checkoutBase(base, page, dir) {
  const file = path.resolve(base);
  const isFile = existsSync(file) && statSync(file).isFile();
  const archive = path.join(dir, 'base.tar');
  const baseRoot = path.join(dir, 'base');
  await mkdir(path.join(baseRoot, 'tools'), { recursive: true });
  await run('git', ['-C', ROOT, 'archive', '-o', archive, isFile ? 'HEAD' : base]);
  await run('tar', ['-xf', archive, '-C', baseRoot]);
  await copyFile(EXPORTER, path.join(baseRoot, 'tools', 'video-export.mjs'));
  if (isFile) await copyFile(file, path.join(baseRoot, `${page}.html`));
  return path.join(baseRoot, 'tools', 'video-export.mjs');
}

// ---- 撮影 ----
async function capture(exporter, options, code, out) {
  const { page, seconds, warmup, seed, scenes } = options;
  const args = [exporter, page, '--seconds', seconds, '--warmup', warmup, '--seed', seed, '--fade', '0', '--out', out];
  if (scenes) args.push('--scenes', scenes);
  if (code) args.push('--at', `0:${code}`);
  for (let attempt = 1; ; attempt++) {
    try {
      await run(process.execPath, args);
      return;
    } catch (e) {
      if (attempt >= CAPTURE_TRIES || !e.message.includes('net::ERR_')) throw e;
      console.error('読み込みに失敗したので撮り直す');
    }
  }
}

// ---- 比べる ----
// 場面ごとの差を返す。frames はコマ数、same は完全に一致したコマの数、min は最も低い PSNR（dB）
async function comparePsnr(a, b, sceneCount, dir) {
  await ffmpeg(['-i', a, '-i', b, '-lavfi', 'psnr=stats_file=psnr.log', '-f', 'null', '-'], { cwd: dir });
  const values = (await readFile(path.join(dir, 'psnr.log'), 'utf8')).trim().split('\n')
    .map((line) => Number(line.match(/psnr_avg:(\S+)/)[1].replace('inf', 'Infinity')));
  const perScene = values.length / sceneCount;
  return Array.from({ length: sceneCount }, (_, i) => {
    const part = values.slice(i * perScene, (i + 1) * perScene);
    return { frames: part.length, same: part.filter((v) => v === Infinity).length, min: Math.min(...part) };
  });
}

const describeDiff = ({ frames, same, min }) => (same === frames ? '全コマ一致' : `最小 ${min.toFixed(1)}dB、一致 ${same}/${frames} コマ`);

// 上の段に変更前、下の段に変更後を並べる
function compose(files, columns, out) {
  const even = (v) => Math.round(v / 2) * 2;
  const width = even(VIDEO_WIDTH / Math.max(columns, 2));
  const height = even(width * 9 / 16);
  const scaled = files.map((_, i) => `[${i}:v]scale=${width}:${height},setsar=1[v${i}]`).join(';');
  const inputs = files.map((_, i) => `[v${i}]`).join('');
  const layout = files.map((_, i) => `${(i % columns) * width}_${Math.floor(i / columns) * height}`).join('|');
  return ffmpeg([
    ...files.flatMap((f) => ['-i', f]),
    '-filter_complex', `${scaled};${inputs}xstack=inputs=${files.length}:layout=${layout}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(X264_CRF), '-movflags', '+faststart', out,
  ]).then(() => ({ width: width * columns, height: height * 2 }));
}

// 各場面の最後のコマを縦に並べた 1 枚の画像を作る。最後のコマなら、--case の式で変えた状態が落ち着いている
function makeSheet(video, size, frames, sceneCount, out) {
  const picks = Array.from({ length: sceneCount }, (_, i) => `eq(n\\,${(i + 1) * frames / sceneCount - 1})`).join('+');
  const scale = Math.min(1, SHEET_MAX / size.width, SHEET_MAX / (size.height * sceneCount));
  const even = (v) => Math.round(v * scale / 2) * 2;
  return ffmpeg([
    '-i', video,
    '-vf', `select='${picks}',scale=${even(size.width)}:${even(size.height)},tile=1x${sceneCount}`,
    '-fps_mode', 'vfr', '-frames:v', '1', '-update', '1', '-q:v', '4', out,
  ]);
}

// ---- 実行 ----
async function main() {
  const options = parseOptions();
  const { page, cases, base, sceneCount, out } = options;
  const thumbs = `${out.replace(/\.mp4$/, '')}.thumbs.jpg`;
  const dir = await mkdtemp(path.join(tmpdir(), 'video-compare-'));
  try {
    const baseExporter = await checkoutBase(base, page, dir);
    const before = cases.map((_, i) => path.join(dir, `before-${i}.mp4`));
    const after = cases.map((_, i) => path.join(dir, `after-${i}.mp4`));
    // GPU を取り合わないよう、1 本ずつ撮る
    for (const [i, c] of cases.entries()) {
      console.error(`撮影中 (${i + 1}/${cases.length}): ${c.label}`);
      await capture(baseExporter, options, c.code, before[i]);
      await capture(EXPORTER, options, c.code, after[i]);
    }

    const lines = [];
    let frames = 0;
    for (const [i, c] of cases.entries()) {
      const scenes = await comparePsnr(before[i], after[i], sceneCount, dir);
      frames = scenes.reduce((sum, s) => sum + s.frames, 0);
      const detail = scenes.length === 1
        ? describeDiff(scenes[0])
        : scenes.map((s, k) => `場面 ${k + 1}: ${describeDiff(s)}`).join(' / ');
      lines.push(`  ${c.label}: ${detail}`);
    }

    const size = await compose([...before, ...after], cases.length, path.join(dir, 'compare.mp4'));
    await copyFile(path.join(dir, 'compare.mp4'), out);
    await makeSheet(out, size, frames, sceneCount, thumbs);

    const shown = (file) => { const r = path.relative(process.cwd(), file); return r.startsWith('..') ? file : r; };
    console.log(`${shown(out)}（上: ${path.basename(base)}、下: 作業ツリー、左から ${cases.map((c) => c.label).join(' / ')}）`);
    console.log(`確認用の画像: ${shown(thumbs)}（各場面の最後のコマ）`);
    console.log('差（PSNR）:');
    console.log(lines.join('\n'));
    if (options.open) await run('open', [out]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
