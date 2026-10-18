/**
 * 词条一致性检查：源码里用到的 key 是否都在每个语言包里存在，以及是否有多余/拼错的 key
 *   - 使用方：t('xxx')、data-i18n / data-i18n-html / data-i18n-ph / data-i18n-title
 *   - 算法库动态错误码：mkErr('CODE') 会由 UI 层按 'err.' + code 查表，也要算进去
 * 运行：node tools/i18n-check.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'index.html'), 'utf8');
const i18nDir = join(root, 'src', 'i18n');

const langs = readdirSync(i18nDir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
if (langs.length === 0) { console.error('未找到任何语言包 src/i18n/*.js'); process.exit(1); }

/* ---------- 1. 收集源码里用到的 key ---------- */
// 先去掉注释，避免文档里的示例（如 t('key')）被当成真实引用
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[ \t])\/\/[^\n]*/g, '$1');
const used = new Set();
for (const m of code.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) used.add(m[1]);
for (const attr of ['data-i18n', 'data-i18n-html', 'data-i18n-ph', 'data-i18n-title']) {
  const re = new RegExp(attr + '="([^"]+)"', 'g');
  for (const m of code.matchAll(re)) used.add(m[1]);
}
// 算法库抛错只带 code，译文 key 形如 err.CODE；这里的 code 来自 mkErr('CODE', ...)
for (const m of code.matchAll(/mkErr\(\s*['"]([A-Z0-9_]+)['"]/g)) used.add('err.' + m[1]);

/* ---------- 2. 解析每个语言包里的 key ---------- */
// 语言包形如 I18N.zh = { 'a.b': 'x', ... };，只取顶层的 'key': 形式
function packKeys(file) {
  const body = readFileSync(join(i18nDir, file), 'utf8');
  const keys = new Set();
  for (const m of body.matchAll(/^\s{2,}'([A-Za-z0-9_.]+)'\s*:/gm)) keys.add(m[1]);
  return keys;
}
const packs = {};
for (const l of langs) packs[l] = packKeys(l + '.js');

/* ---------- 3. 比对 ---------- */
let fail = 0;
const missing = {};
const extra = {};
for (const l of langs) {
  missing[l] = [...used].filter((k) => !packs[l].has(k)).sort();
  extra[l] = [...packs[l]].filter((k) => !used.has(k)).sort();
  if (missing[l].length) fail++;
}

const zh = packs.zh || new Set();
for (const l of langs) {
  if (l === 'zh') continue;
  const onlyZh = [...zh].filter((k) => !packs[l].has(k)).sort();
  if (onlyZh.length) {
    console.log(`  WARN  ${l}.js 缺 ${onlyZh.length} 条（会回退到中文）: ${onlyZh.slice(0, 8).join(', ')}${onlyZh.length > 8 ? ' …' : ''}`);
  }
}

for (const l of langs) {
  const miss = missing[l];
  console.log(`${miss.length ? '  FAIL' : '  PASS'}  ${l}.js 覆盖源码用到的 key（${used.size - miss.length}/${used.size}）${miss.length ? '  缺: ' + miss.slice(0, 10).join(', ') + (miss.length > 10 ? ' …' : '') : ''}`);
  if (extra[l].length) console.log(`  NOTE  ${l}.js 有 ${extra[l].length} 条未被使用: ${extra[l].slice(0, 8).join(', ')}${extra[l].length > 8 ? ' …' : ''}`);
}
console.log(`\n结果: ${langs.length - fail}/${langs.length} 个语言包齐备（源码用到 ${used.size} 个 key）\n`);
process.exit(fail ? 1 : 0);
