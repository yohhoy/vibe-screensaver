// tools の下のスクリプトで共通の処理。gpu-bench.mjs・video-export.mjs・video-compare.mjs で使う。
// 作品の一覧と場面の選び方は pages.mjs にある。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 設定 ----
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ---- 外部のコマンド ----
// コマンドを実行し、標準出力を返す。失敗したら標準エラーを添えて止める
export function run(command, args, options = {}) {
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

// ---- 比べる版を取り出す ----
// --base の版を dir の下に取り出し、その場所を返す。作業ツリーのファイルには触らない。
// git のコミットならその版を、作品の HTML のパスなら HEAD の版にその HTML を重ねる。
// tools は tools の下のファイル名の一覧で、取り出した版に作業ツリーのものを写す（古い版には無いことがあるため）
export async function checkoutBase(base, page, dir, tools = []) {
  const file = path.resolve(base);
  const isFile = existsSync(file) && statSync(file).isFile();
  const archive = path.join(dir, 'base.tar');
  const root = path.join(dir, 'base');
  await mkdir(path.join(root, 'tools'), { recursive: true });
  await run('git', ['-C', ROOT, 'archive', '-o', archive, isFile ? 'HEAD' : base]);
  await run('tar', ['-xf', archive, '-C', root]);
  for (const name of tools) await copyFile(path.join(ROOT, 'tools', name), path.join(root, 'tools', name));
  if (isFile) await copyFile(file, path.join(root, `${page}.html`));
  return root;
}

// ---- Chrome ----
// ヘッドレス Chrome を起動する。name は一時的なプロフィールのフォルダの名前に使う
export async function launchChrome(name) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), `${name}-`));   // 普段のプロフィールと分ける
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

// Chrome DevTools Protocol でつなぐ。ページのエラー（例外とエラーのログ）は errors に溜め、onError があれば渡す
export async function connectCdp(url, onError = null) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  const pageError = (text) => { errors.push(text); onError?.(text); };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageError(d.exception?.description ?? d.text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      pageError(m.params.entry.text);
    }
  });
  return {
    ws,
    errors,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

// ---- ページに差し込む処理 ----
// 作品のスクリプトより先に実行するスクリプトの一部。同じ種から同じ絵を描くため、乱数を固定する（mulberry32。種は URL の seed）
export const SEEDED_RANDOM = `
  let s = Number(new URLSearchParams(location.search).get('seed')) >>> 0;
  Math.random = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };`;
