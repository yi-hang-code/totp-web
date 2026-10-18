#!/usr/bin/env node
/**
 * 构建脚本：把 vendored 的 jsQR（tools/jsqr.min.js）注入 index.html 的占位块，
 * 生成单文件、零网络、可离线的 dist/index.html。
 *
 * 用法：
 *   node scripts/build.mjs                 # 用现有 tools/jsqr.min.js 生成可读版 dist（便于审计）
 *   node scripts/build.mjs --rebuild-jsqr  # 先从 npm 的 jsqr 重新压缩生成 tools/jsqr.min.js 再构建
 *   node scripts/build.mjs --min           # 在可读版基础上再压缩 HTML/CSS/JS（用于发布分发）
 *
 * 设计要点：
 *   - 源文件 index.html 中 jsQR 仅以占位标记 __JSQR_INLINE__ 存在（约 55KB，便于维护），
 *     构建时注入压缩后的 jsQR（约 130KB）得到 dist/index.html（约 200KB 单文件）。
 *   - tools/jsqr.min.js 是 vendored 依赖（jsqr@1.4.0, Apache-2.0），已随仓库提交，
 *     保证「无网络也可构建」。要升级 jsQR 时用 --rebuild-jsqr（需先 npm install）。
 *   - 测试脚本（tools/*.mjs）绝不会被打进产物；dist 只含应用本体。
 *   - 源码中的 window.selfTestOTP 自检块（__SELFTEST_START__/END__ 标记）仅在源码保留，
 *     供审计/控制台调试；构建产物中自动剥离，不污染下发文件。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcHtml = join(root, 'index.html');
const minPath = join(root, 'tools', 'jsqr.min.js');
const outDir = join(root, 'dist');
const outHtml = join(outDir, 'index.html');
const PLACEHOLDER = '/*__JSQR_INLINE__*/';
const RE = /(<script id="jsqr-lib">)([\s\S]*?)(<\/script>)/;
// 自检代码（window.selfTestOTP）仅用于源码审计/控制台调试，产物中剥离
const SELF_RE = /\/\*__SELFTEST_START__\*\/[\s\S]*?\/\*__SELFTEST_END__\*\//;
const rebuild = process.argv.includes('--rebuild-jsqr');
const minify = process.argv.includes('--min');

async function rebuildJsqr() {
  const req = createRequire(import.meta.url);
  const searchPaths = [process.env.NODE_PATH, join(root, 'node_modules')].filter(Boolean);
  const terser = await import(pathToFileURL(req.resolve('terser', { paths: searchPaths })).href);
  const src = readFileSync(join(root, 'node_modules', 'jsqr', 'dist', 'jsQR.js'), 'utf8');
  const out = await terser.minify(src, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
  if (out.error) throw out.error;
  writeFileSync(minPath, out.code);
  console.log('已重新生成 tools/jsqr.min.js:', out.code.length, 'bytes');
}

async function minifyJS(code) {
  const req = createRequire(import.meta.url);
  const searchPaths = [process.env.NODE_PATH, join(root, 'node_modules')].filter(Boolean);
  const terser = await import(pathToFileURL(req.resolve('terser', { paths: searchPaths })).href);
  const out = await terser.minify(code, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
  if (out.error) { console.warn('  JS 压缩失败，保留原样：', out.error); return code; }
  return out.code;
}

function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 去注释
    .replace(/\s+/g, ' ')                  // 折叠空白
    .replace(/\s*([{}:;,>])\s*/g, '$1')    // 去分隔符周围空白
    .replace(/;}/g, '}')                   // 去末尾分号
    .trim();
}

async function minifyHtml(html) {
  const blocks = [];
  // 先抽出 <style> 与 <script>，避免压缩破坏其内部内容
  html = html.replace(/<style>([\s\S]*?)<\/style>/g, (m, c) => {
    blocks.push({ kind: 'style', content: c });
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs, c) => {
    blocks.push({ kind: 'script', attrs, content: c });
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });

  for (const b of blocks) {
    if (b.kind === 'style') {
      b.out = minifyCSS(b.content);
    } else {
      const id = (b.attrs.match(/id="([^"]+)"/) || [])[1] || '';
      if (/application\/ld\+json/.test(b.attrs)) {
        b.out = JSON.stringify(JSON.parse(b.content));
      } else if (id === 'core-lib' || id === 'app') {
        b.out = await minifyJS(b.content);
      } else {
        b.out = b.content; // jsqr-lib 等已压缩
      }
    }
  }

  // 骨架压缩：去 HTML 注释 + 去除换行/制表（保留文本中的空格，避免误删可见分隔）
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/[\r\n\t]+/g, '');

  html = html.replace(/\u0000B(\d+)\u0000/g, (m, i) => {
    const b = blocks[+i];
    return b.kind === 'style' ? '<style>' + b.out + '</style>' : '<script' + b.attrs + '>' + b.out + '</script>';
  });
  return html;
}

if (rebuild || !existsSync(minPath)) await rebuildJsqr();

const lib = readFileSync(minPath, 'utf8').trim();
if (lib.includes('</script>')) throw new Error('库内容含 </script>，无法安全内联');

let html = readFileSync(srcHtml, 'utf8');
if (!RE.test(html)) throw new Error('index.html 中未找到 <script id="jsqr-lib"> 占位块');
if (!html.includes('__JSQR_INLINE__')) {
  throw new Error('index.html 的 jsqr-lib 仍是内联态，请先还原为占位符再构建（构建脚本不会改写源码）。');
}
html = html.replace(RE, '$1\n' + lib + '\n$3');

if (SELF_RE.test(html)) {
  html = html.replace(SELF_RE, '');
  console.log('已剥离源码自检代码 window.selfTestOTP（不进 dist 产物）');
} else {
  console.warn('注意：未在源码中找到 __SELFTEST__ 标记块，自检代码可能已移除或标记被改。');
}

if (minify) {
  const t0 = Date.now();
  html = await minifyHtml(html);
  console.log('已压缩 HTML/CSS/JS，用时', Date.now() - t0, 'ms');
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outHtml, html);
console.log('已生成 dist/index.html', '(' + lib.length + ' bytes jsQR' + (minify ? ' + 压缩' : '') + ')');
