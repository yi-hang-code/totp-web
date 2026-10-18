/**
 * 自测脚本：从 index.html 抽取 core-lib 并执行
 *  1) RFC 6238 官方测试向量（SHA1 / SHA256 / SHA512，8 位）
 *  2) otpauth:// 解析与生成
 *  3) QR 编码器端到端校验（生成矩阵 -> 渲染像素 -> jsQR 解码）
 * 依赖：npm i jsqr（二维码解码校验用，缺失则跳过第 3 组）
 * 运行：node tools/verify.mjs
 * 说明：ESM 不读 NODE_PATH，脚本会按 NODE_PATH / 项目 node_modules 解析 jsqr
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const m = /<script id="core-lib">([\s\S]*?)<\/script>/.exec(html);
if (!m) throw new Error('未找到 core-lib 脚本块');

const factory = new Function(`${m[1]}\nreturn { normalizeSecret, base32Decode, generateTOTP, parseOtpauthUri, buildOtpauthUri, QR,
  deriveKey, encryptString, decryptString, b64encode, b64decode, PBKDF2_ITER };`);
const lib = factory();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
};
const b32encode = (buf) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
};

console.log('\n[1] RFC 6238 TOTP 测试向量');
{
  const s1 = b32encode(Buffer.from('12345678901234567890', 'ascii'));
  const s256 = b32encode(Buffer.from('12345678901234567890123456789012', 'ascii'));
  const s512 = b32encode(Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'));
  const cases = [
    [s1, 'SHA1', 59, '94287082'], [s1, 'SHA1', 1111111109, '07081804'],
    [s1, 'SHA1', 1111111111, '14050471'], [s1, 'SHA1', 1234567890, '89005924'],
    [s1, 'SHA1', 2000000000, '69279037'], [s1, 'SHA1', 20000000000, '65353130'],
    [s256, 'SHA256', 59, '46119246'], [s256, 'SHA256', 1111111109, '68084774'],
    [s256, 'SHA256', 1111111111, '67062674'], [s256, 'SHA256', 1234567890, '91819424'],
    [s256, 'SHA256', 2000000000, '90698825'], [s256, 'SHA256', 20000000000, '77737706'],
    [s512, 'SHA512', 59, '90693936'], [s512, 'SHA512', 1111111109, '25091201'],
    [s512, 'SHA512', 1111111111, '99943326'], [s512, 'SHA512', 1234567890, '93441116'],
    [s512, 'SHA512', 2000000000, '38618901'], [s512, 'SHA512', 20000000000, '47863826'],
  ];
  for (const [secret, algo, t, expect] of cases) {
    const got = await lib.generateTOTP(secret, { digits: 8, period: 30, algorithm: algo }, t * 1000);
    check(`${algo} T=${t}`, got === expect, `expect ${expect}, got ${got}`);
  }
  // 6 位：应为 8 位向量的后 6 位
  const six = await lib.generateTOTP(s1, { digits: 6, period: 30, algorithm: 'SHA1' }, 59 * 1000);
  check('SHA1 6位 T=59 取后6位', six === '287082', `got ${six}`);
  // 非法字符 / 空值
  let threw = false;
  try { await lib.generateTOTP('JBSWY3DP0!', {}); } catch { threw = true; }
  check('非法 Base32 字符抛错', threw);
  threw = false;
  try { await lib.generateTOTP('', {}); } catch { threw = true; }
  check('空 Secret 抛错', threw);
  // 大小写与空格容错
  const spaced = await lib.generateTOTP('jbswy3dp ehpk3pxp', { digits: 8 }, 59 * 1000);
  const plain = await lib.generateTOTP('JBSWY3DPEHPK3PXP', { digits: 8 }, 59 * 1000);
  check('大小写/空格规范化一致', spaced === plain, `${spaced} vs ${plain}`);
}

console.log('\n[2] otpauth:// URI 解析与生成');
{
  const uri = 'otpauth://totp/ACME%20Co:john.doe@email.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&digits=8&period=60&algorithm=SHA256';
  const p = lib.parseOtpauthUri(uri);
  check('issuer 解析', p.issuer === 'ACME Co', p.issuer);
  check('account 解析', p.account === 'john.doe@email.com', p.account);
  check('digits 解析', p.digits === 8, String(p.digits));
  check('period 解析', p.period === 60, String(p.period));
  check('algorithm 解析', p.algorithm === 'SHA256', p.algorithm);
  check('secret 解析', p.secret === 'JBSWY3DPEHPK3PXP', p.secret);
  const rebuilt = lib.buildOtpauthUri(p);
  const p2 = lib.parseOtpauthUri(rebuilt);
  check('生成后回环一致', JSON.stringify(p) === JSON.stringify(p2), rebuilt);
  // 无 issuer 参数时从 label 推断
  const p3 = lib.parseOtpauthUri('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP');
  check('label 推断 issuer', p3.issuer === 'GitHub' && p3.account === 'me', `${p3.issuer}/${p3.account}`);
  let threw = false;
  try { lib.parseOtpauthUri('https://example.com'); } catch { threw = true; }
  check('非 otpauth 链接抛错', threw);
  threw = false;
  try { lib.parseOtpauthUri('otpauth://totp/x'); } catch { threw = true; }
  check('缺 secret 抛错', threw);
}

console.log('\n[3] QR 编码器端到端解码（jsQR）');
{
  // 优先使用页面里内联的那份 jsQR（真正随页面发布的代码），取不到再退回 npm 包
  let jsQR, jsqrSource = 'inline';
  try {
    const inline = /<script id="jsqr-lib">([\s\S]*?)<\/script>/.exec(html);
    if (inline && inline[1].length > 10000) {
      new Function(inline[1])();               // UMD：在 Node 中挂到 globalThis.jsQR
      jsQR = globalThis.jsQR;
    }
    if (typeof jsQR !== 'function') throw new Error('内联 jsQR 未就绪');
  } catch (e) {
    jsqrSource = 'npm';
    try {
      const req = createRequire(import.meta.url);
      const searchPaths = [process.env.JSQR_PATH, process.env.NODE_PATH, join(root, 'node_modules')].filter(Boolean);
      const entry = req.resolve('jsqr', { paths: searchPaths });
      const mod = await import(pathToFileURL(entry).href);
      jsQR = mod.default || mod;
    } catch (e2) {
      console.log('  SKIP  未找到 jsqr：' + e2.message);
    }
  }
  if (typeof jsQR === 'function') console.log(`  (解码器来源: ${jsqrSource})`);
  if (jsQR) {
    const samples = [
      'otpauth://totp/GitHub:zhang@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      'otpauth://totp/ACME Co:john.doe@email.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ACME Co&digits=8&period=60&algorithm=SHA256',
      'A',
      'x'.repeat(180),
    ];
    for (const text of samples) {
      let ok = false, info = '';
      try {
        const mat = lib.QR.encode(text);
        const quiet = 4, scale = 4, total = (mat.size + quiet * 2) * scale;
        const data = new Uint8ClampedArray(total * total * 4).fill(255);
        for (let r = 0; r < mat.size; r++) for (let c = 0; c < mat.size; c++) {
          if (!mat.get(r, c)) continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            const y = (r + quiet) * scale + dy, x = (c + quiet) * scale + dx;
            const i = (y * total + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
        const res = jsQR(data, total, total);
        ok = !!res && res.data === text;
        info = `v${mat.version} size=${mat.size} got=${res ? JSON.stringify(res.data).slice(0, 60) : 'null'}`;
      } catch (e) { info = e.message; }
      check(`解码 "${text.slice(0, 34)}${text.length > 34 ? '…' : ''}" (${text.length}B)`, ok, info);
    }
    let tooLong = false;
    try { lib.QR.encode('x'.repeat(500)); } catch { tooLong = true; }
    check('超长内容报错', tooLong);
  }
}

console.log('\n[4] 主密码加密（PBKDF2 + AES-GCM）');
{
  const json = JSON.stringify({ v: 2, accounts: [{ secret: 'JBSWY3DPEHPK3PXP', account: 'a@b.c' }] });
  const salt = new Uint8Array(16).fill(7);
  // 迭代次数用低值加速测试，逻辑与线上一致
  const ITER = 1000;
  const k1 = await lib.deriveKey('correct horse', salt, ITER);
  const enc = await lib.encryptString(k1, json);
  const plainCipherText = new TextDecoder().decode(lib.b64decode(enc.data));
  check('密文中不含明文 secret', !plainCipherText.includes('JBSWY3DPEHPK3PXP'), plainCipherText.slice(0, 30));
  const dec = await lib.decryptString(k1, enc.iv, enc.data);
  check('正确密码可解密还原', dec === json);

  const k2 = await lib.deriveKey('correct horse', salt, ITER);
  check('相同密码+salt 派生出可用密钥', (await lib.decryptString(k2, enc.iv, enc.data)) === json);

  let wrong = false;
  try { await lib.decryptString(await lib.deriveKey('wrong pass', salt, ITER), enc.iv, enc.data); }
  catch { wrong = true; }
  check('错误密码解密失败（GCM 认证拒绝）', wrong);

  const k3 = await lib.deriveKey('correct horse', new Uint8Array(16).fill(8), ITER);
  let wrongSalt = false;
  try { await lib.decryptString(k3, enc.iv, enc.data); } catch { wrongSalt = true; }
  check('不同 salt 无法解密', wrongSalt);

  const enc2 = await lib.encryptString(k1, json);
  check('每次加密使用新 IV（密文不同）', enc2.data !== enc.data || enc2.iv !== enc.iv);

  check('base64 往返一致', lib.b64decode(lib.b64encode(new Uint8Array([1, 2, 250, 0, 127]))).join() === '1,2,250,0,127');
  check('默认迭代次数达标（>=100000）', lib.PBKDF2_ITER >= 100000, String(lib.PBKDF2_ITER));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
