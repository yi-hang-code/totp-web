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
 *   - 语言包与 index.html 解耦：词条放在 src/i18n/<lang>.js，index.html 只留
 *     __I18N_PACKS__ 占位，构建时按需注入（默认 zh,en；--lang=zh 只打一种）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
// 语言包与 index.html 解耦：源码只留 __I18N_PACKS__ 占位，构建时按需注入
const I18N_DIR = join(root, 'src', 'i18n');
const I18N_PLACEHOLDER = '/*__I18N_PACKS__*/';
const langArg = (process.argv.find(function (a) { return a.indexOf('--lang=') === 0; }) || '').slice(7);
const LANGS = langArg ? langArg.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : ['zh', 'en'];
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
      } else if (id === 'core-lib' || id === 'app' || id === 'i18n-lib') {
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

// 注入语言包（按需：默认中英双语；--lang=zh 只打中文，--lang=zh,en,ja 指定多种）
let packs = '';
for (const l of LANGS) {
  const f = join(I18N_DIR, l + '.js');
  if (!existsSync(f)) throw new Error('缺少语言包: src/i18n/' + l + '.js');
  packs += readFileSync(f, 'utf8').trim() + '\n';
}
if (!html.includes(I18N_PLACEHOLDER)) {
  throw new Error('index.html 中未找到 ' + I18N_PLACEHOLDER + ' 占位（构建脚本不会改写源码）');
}
html = html.replace(I18N_PLACEHOLDER, packs);
console.log('已注入语言包:', LANGS.join(', '));

if (minify) {
  const t0 = Date.now();
  html = await minifyHtml(html);
  console.log('已压缩 HTML/CSS/JS，用时', Date.now() - t0, 'ms');
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outHtml, html);
console.log('已生成 dist/index.html', '(' + lib.length + ' bytes jsQR' + (minify ? ' + 压缩' : '') + ')');

// —— CSP hash 白名单：单文件应用的全部 JS 都内联，静态托管无法用 nonce（需逐请求
// 生成响应头），标准做法是对每个内联 <script> 的内容算 SHA-256。产物任何字节变化
// 都会使 hash 失效，因此头文件随每次构建重新生成，与 index.html 严格配对部署。
function cspValue(h) {
  return "default-src 'self'; script-src 'self' " + h.join(' ') +
    "; style-src 'self' 'unsafe-inline'" +   // CSS 无法执行脚本；页面用内联 style 属性，收紧需 unsafe-hashes 得不偿失
    "; img-src 'self' data: blob:" +         // blob: 是「图片」识别兜底路径（loadViaImg）的硬需求
    "; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'" +
    "; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
}
const scriptHashes = [];
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let sm;
while ((sm = scriptRe.exec(html))) {
  scriptHashes.push("'sha256-" + createHash('sha256').update(sm[1], 'utf8').digest('base64') + "'");
}
if (!scriptHashes.length) throw new Error('产物中没有内联 <script>，CSP 头无法生成');
writeFileSync(join(outDir, 'csp-header.txt'), 'Content-Security-Policy "' + cspValue(scriptHashes) + '"\n');
console.log('已生成 dist/csp-header.txt（内联脚本 SHA-256 ×' + scriptHashes.length + '，与本次 dist/index.html 配对使用）');
