#!/usr/bin/env node
// 各作品のコード量（JS と GLSL の行数）を数え、JS の行数が多い順に出す。形式は Markdown の表（既定）か JSON。
//
//   node tools/code-size.mjs [--format markdown|json]
//
// 数えるのは各 HTML のインライン <script>。空行とコメントは行数に入れない。
// 依存は Node.js だけ。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---- 設定 ----
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORMATS = ['markdown', 'json'];   // 出力の形式。先頭が既定
const NON_WORKS = ['index.html'];   // 作品ではない HTML
const COMMON_FILE = 'common.js';    // 表の最後に参考として載せる共通コード
// テンプレートリテラルのうち、これに当てはまるものを GLSL として数える
const GLSL_PATTERN = /gl_(Position|FragColor|PointSize)|void\s+main|uniform\s|varying\s|\bvec[234]\b/;
// この文字の直後の / は、割り算ではなく正規表現の始まりとみなす
const REGEX_PRECEDERS = '=(,:!&|?{};[';

// ---- 字句の読み飛ばし ----
// どれも開始位置を受け取り、その字句の直後の位置を返す
function fail(src, i) {
  const line = src.slice(0, i).split('\n').length;
  throw new Error(`unterminated token near script line ${line}`);
}

function skipString(src, start) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === src[start]) return i + 1;
  }
  fail(src, start);
}

function skipRegex(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    else if (c === '\n') break;
  }
  fail(src, start);
}

function skipTemplate(src, start) {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === '`') return i + 1;
    else if (src[i] === '$' && src[i + 1] === '{') i = skipExpression(src, i + 2);
    else i++;
  }
  fail(src, start);
}

// ${ の直後から、対応する } の直後まで
function skipExpression(src, start) {
  let depth = 0, i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") i = skipString(src, i);
    else if (c === '`') i = skipTemplate(src, i);
    else if (c === '}' && depth === 0) return i + 1;
    else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
  }
  fail(src, start);
}

// ---- 数える ----
const nonBlankLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// コメントと GLSL を取り除いた JS と、GLSL の行数を返す
function separate(src) {
  let js = '', glslLines = 0, i = 0, prev = '';
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    let end;
    if (c === '/' && next === '/') {
      end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      end = src.indexOf('*/', i);
      if (end < 0) fail(src, i);
      i = end + 2;
      continue;
    }
    if (c === '`') {
      end = skipTemplate(src, i);
      const body = src.slice(i + 1, end - 1);
      if (GLSL_PATTERN.test(body)) {
        glslLines += nonBlankLines(body).filter((l) => !l.startsWith('//')).length;
        js += '``';
      } else {
        js += src.slice(i, end);
      }
      i = end;
      prev = '`';
      continue;
    }
    if (c === '"' || c === "'") end = skipString(src, i);
    else if (c === '/' && (!prev || REGEX_PRECEDERS.includes(prev))) end = skipRegex(src, i);
    else end = i + 1;
    js += src.slice(i, end);
    i = end;
    if (c.trim()) prev = c;
  }
  return { js, glslLines };
}

function measure(name, src) {
  const { js, glslLines } = separate(src);
  const jsLines = nonBlankLines(js).length;
  return { name, jsLines, glslLines, totalLines: jsLines + glslLines };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/\bsrc=|importmap/.test(attrs))
    .map(([, , body]) => body)
    .join('\n');
}

function measureWork(file) {
  try {
    return measure(path.basename(file, '.html'), inlineScripts(readFileSync(path.join(ROOT, file), 'utf8')));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

// ---- 出力 ----
function printMarkdown({ works, total, common }) {
  const row = (cells) => console.log(`| ${cells.join(' | ')} |`);
  const count = (n) => n.toLocaleString('en-US');
  const sizeRow = (m) => row([m.name, count(m.jsLines), count(m.glslLines), count(m.totalLines)]);

  row(['Work', 'JS (lines)', 'GLSL (lines)', 'JS + GLSL (lines)']);
  row(['---', '---:', '---:', '---:']);
  works.forEach(sizeRow);
  sizeRow({ name: 'Total', ...total });
  sizeRow({ ...common, name: `${common.name} (reference)` });
}

function printJson(result) {
  console.log(JSON.stringify(result, null, 2));
}

// ---- 開始 ----
function readFormat() {
  try {
    const { values } = parseArgs({ options: { format: { type: 'string', default: FORMATS[0] } } });
    if (FORMATS.includes(values.format)) return values.format;
    throw new Error(`unknown format: ${values.format}`);
  } catch (e) {
    console.error(`${e.message}\nUsage: node tools/code-size.mjs [--format ${FORMATS.join('|')}]`);
    process.exit(1);
  }
}

const format = readFormat();
const works = readdirSync(ROOT)
  .filter((f) => f.endsWith('.html') && !NON_WORKS.includes(f))
  .map(measureWork)
  .sort((a, b) => b.jsLines - a.jsLines);
const sum = (key) => works.reduce((n, w) => n + w[key], 0);
const result = {
  works,
  total: { jsLines: sum('jsLines'), glslLines: sum('glslLines'), totalLines: sum('totalLines') },
  // 共通コードは作品の行数に入っていないので、参考として別に出す
  common: measure(COMMON_FILE, readFileSync(path.join(ROOT, COMMON_FILE), 'utf8')),
};

if (format === 'json') printJson(result);
else printMarkdown(result);
