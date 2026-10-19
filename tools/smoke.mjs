/**
 * DOM 冒烟测试：用 jsdom 真实加载 index.html 并跑一遍主流程
 *  启动 -> 添加账户（手动 Secret / otpauth 链接）-> 口令渲染 -> 倒计时 -> 持久化 -> 删除
 * 依赖：npm i jsdom
 * 运行：node tools/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const searchPaths = [process.env.NODE_PATH, join(root, 'node_modules')].filter(Boolean);
const { JSDOM } = await import(pathToFileURL(req.resolve('jsdom', { paths: searchPaths })).href);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const clipboardWrites = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/',
  pretendToBeVisual: true,
  beforeParse(window) {
    Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
    // jsdom 的 navigator.language 是 en-US，会命中英文检测；这里强制中文以保证文案断言稳定
    window.localStorage.setItem('totp-web-locale', 'zh');
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: (t) => { clipboardWrites.push(String(t)); return Promise.resolve(); } },
      configurable: true,
    });
    window.TextEncoder = TextEncoder;
    window.TextDecoder = TextDecoder;
    window.confirm = () => true;
    window.HTMLCanvasElement.prototype.getContext = () => null; // jsdom 无 canvas，仅验证调用链不报错
    // 模拟「老用户：已有明文存储但账户为空」——跳过强制引导，便于测明文模式主流程
    window.localStorage.setItem('totp-web-accounts-v1', JSON.stringify({ v: 2, mode: 'plain', accounts: [] }));
  },
});
const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
const origErr = console.error;
console.error = (...a) => errors.push(a.join(' '));

await sleep(120);
check('页面脚本无运行时错误', errors.length === 0, errors.join(' | '));
check('空状态提示可见', !$('empty').classList.contains('hidden'));
check('已有明文数据时提示设置主密码', !$('upgrade-tip').classList.contains('hidden'));
check('老用户不被强制引导', $('onboard-panel').classList.contains('hidden'));
check('无账户+未加密时不谎称有明文风险', /暂无账户/.test($('sec-note').textContent), $('sec-note').textContent.slice(0, 40));
check('未加密提示条文案随账户数变化', /尚未启用加密存储/.test($('upgrade-text').textContent), $('upgrade-text').textContent.slice(0, 30));

/* --- 1. 手动输入 Secret --- */
$('in-secret').value = 'JBSWY3DPEHPK3PXP';
$('in-label').value = 'Test:demo@example.com';
$('btn-add').click();
await sleep(150);
let cards = doc.querySelectorAll('.acc');
check('添加后生成 1 张卡片', cards.length === 1, String(cards.length));
const code1 = cards[0]?.querySelector('.code')?.textContent || '';
check('口令为 6 位数字', /^\d{6}$/.test(code1), code1);
check('备注名渲染正确', cards[0].querySelector('.name').textContent === 'demo@example.com', cards[0].querySelector('.name').textContent);
check('issuer 渲染正确', cards[0].querySelector('.issuer')?.textContent === 'Test', cards[0].querySelector('.issuer')?.textContent);
check('周期信息渲染', /^\d+s · 6位 · SHA-1$/.test(cards[0].querySelector('.sec').textContent), cards[0].querySelector('.sec').textContent);
check('已写入 localStorage', JSON.parse(window.localStorage.getItem('totp-web-accounts-v1')).accounts.length === 1);
// 老用户明文有账户时，才该提示明文风险
check('明文且有账户时提示未加密风险', /未加密/.test($('sec-note').textContent), $('sec-note').textContent.slice(0, 40));
check('提示条显示明文账户数', /1 个账户/.test($('upgrade-text').textContent), $('upgrade-text').textContent.slice(0, 40));

/* --- 2. 口令与核心库一致 --- */
const libCode = await window.generateTOTP('JBSWY3DPEHPK3PXP', { digits: 6, period: 30, algorithm: 'SHA1' }, Date.now());
check('卡片口令与算法一致', code1 === libCode, `${code1} vs ${libCode}`);

/* --- 3. 粘贴 otpauth 链接（含即时回填） --- */
$('in-secret').value = 'otpauth://totp/GitHub:zhang@example.com?secret=JBSWY3DPEHPK3PXQ&issuer=GitHub&digits=8&algorithm=SHA256';
$('in-label').value = '';
$('in-secret').dispatchEvent(new window.Event('input'));
await sleep(60);
check('粘贴链接即时回填备注', $('in-label').value === 'GitHub:zhang@example.com', $('in-label').value);
check('粘贴链接即时回填高级参数', $('in-digits').value === '8' && $('in-algo').value === 'SHA256',
  $('in-digits').value + '/' + $('in-algo').value);
$('btn-add').click();
await sleep(150);
cards = doc.querySelectorAll('.acc');
check('链接解析后添加成功', cards.length === 2, String(cards.length));
const code2 = cards[0].querySelector('.code').textContent;
check('8 位 + SHA256 生效', /^\d{8}$/.test(code2), code2);
check('链接 account 解析', cards[0].querySelector('.name').textContent === 'zhang@example.com', cards[0].querySelector('.name').textContent);

/* --- 4. 非法输入 --- */
$('in-secret').value = 'NOT-VALID-01';
$('btn-add').click();
await sleep(120);
check('非法 Secret 被拦截', doc.querySelectorAll('.acc').length === 2);
check('显示错误提示', $('add-msg').classList.contains('err'), $('add-msg').textContent);

/* --- 5. 倒计时进度 --- */
const w1 = cards[1].querySelector('.bar').style.width;
await sleep(1100);
const w2 = doc.querySelectorAll('.acc')[1].querySelector('.bar').style.width;
check('倒计时进度在变化', w1 !== w2, `${w1} -> ${w2}`);

/* --- 5.5 点击口令复制：必须有可见反馈 --- */
const codeEl = doc.querySelectorAll('.acc')[0].querySelector('.code');
const codeText = codeEl.textContent.replace(/\s/g, '');
codeEl.click();
await sleep(80);
check('点击口令写入剪贴板', clipboardWrites[0] === codeText, clipboardWrites[0]);
check('点击口令后有 toast 提示', $('toast').classList.contains('show'), $('toast').classList.value);
check('toast 文案含「已复制」和口令', /已复制/.test($('toast').textContent) && $('toast').textContent.includes(codeText), $('toast').textContent);
check('口令上出现就地「已复制」高亮', codeEl.classList.contains('copied'));
check('页面可见「点击复制」提示', !$('copy-tip').classList.contains('hidden') && /点击/.test($('copy-tip').textContent), $('copy-tip').textContent.slice(0, 20));
await sleep(1300);
check('1.2s 后高亮自动消失', !codeEl.classList.contains('copied'));
// 口令每秒刷新，但高亮不应被清掉（textContent 重写不影响 class）
codeEl.click();
await sleep(80);
check('二次点击可再次触发高亮', codeEl.classList.contains('copied'));
await sleep(1300);

/* --- 5.6 触屏/手机：必须有看得见的「复制」入口 --- */
const opsBtn = doc.querySelectorAll('.acc')[0].querySelector('[data-act=copy-btn]');
check('卡片内有「复制」按钮（触屏无 hover，靠它承担入口）', !!opsBtn && opsBtn.textContent === '复制', opsBtn && opsBtn.textContent);
opsBtn.click();
await sleep(80);
check('点「复制」按钮写入剪贴板', clipboardWrites.includes(codeText), clipboardWrites.join(','));
check('点「复制」按钮同样在口令上给反馈', codeEl.classList.contains('copied'));
await sleep(1300);

/* --- 5.7 无 navigator.clipboard 的兜底（手机 http 访问就是这种环境） --- */
const domF = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
  beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    // 同上：jsdom navigator.language=en-US，强制中文
    w.localStorage.setItem('totp-web-locale', 'zh');
    w.confirm = () => true;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    w.localStorage.setItem('totp-web-accounts-v1', JSON.stringify({ v: 2, mode: 'plain', accounts: [] }));
    // 故意不注入 clipboard：模拟手机通过 http（非安全上下文）访问时 navigator.clipboard 不存在
  },
});
await sleep(250);
const docF = domF.window.document;
check('无 clipboard 时不注入该 API（环境成立）', !domF.window.navigator.clipboard, typeof domF.window.navigator.clipboard);
docF.getElementById('in-secret').value = 'JBSWY3DPEHPK3PXP';
docF.getElementById('in-label').value = 'M:mobile@example.com';
docF.getElementById('btn-add').click();
await sleep(180);
const fCode = docF.querySelector('.acc .code');
check('无 clipboard 环境仍能正常使用', !!fCode && /^\d{6}$/.test(fCode.textContent), fCode && fCode.textContent);
// execCommand 明确返回 false = 没复制成功，绝不能假装成功
Object.defineProperty(docF, 'execCommand', { value: () => false, configurable: true });
fCode.click();
await sleep(80);
check('execCommand 失败时不假装复制成功', !fCode.classList.contains('copied'));
check('复制失败时给出明确提示', /复制失败|无法调用系统剪贴板/.test(docF.getElementById('toast').textContent), docF.getElementById('toast').textContent);
// execCommand 成功则照常反馈
Object.defineProperty(docF, 'execCommand', { value: () => true, configurable: true });
fCode.click();
await sleep(80);
check('execCommand 成功时照常有反馈', fCode.classList.contains('copied'));
domF.window.close();

/* --- 6. 二维码弹窗：jsdom 无 canvas，验证优雅降级不抛错 --- */
const errCountBefore = errors.length;
doc.querySelectorAll('.acc')[0].querySelector('[data-act=qr]').click();
await sleep(120);
check('二维码点击链路无异常', errors.length === errCountBefore, errors.slice(errCountBefore).join(' | '));
check('canvas 不可用时弹窗已关闭', $('modal').classList.contains('hidden'));

/* --- 7. 删除 --- */
// 上一步的非法输入把提示条改成了报错，先补一个账户让提示条回到「已添加」
$('in-secret').value = 'JBSWY3DPEHPK3PXP';
$('in-label').value = 'Tmp:tmp@example.com';
$('btn-add').click();
await sleep(150);
check('补充账户后共 3 张卡片', doc.querySelectorAll('.acc').length === 3, String(doc.querySelectorAll('.acc').length));
check('删除前提示条确实是「已添加」', /已添加/.test($('add-msg').textContent), $('add-msg').textContent.slice(0, 30));
doc.querySelectorAll('.acc')[0].querySelector('[data-act=del]').click();
await sleep(80);
check('删掉刚提示的那个账户后剩 2 张', doc.querySelectorAll('.acc').length === 2, String(doc.querySelectorAll('.acc').length));
// 提示条说的正是被删掉的那个账户，不能还挂着「已添加 xxx」
check('删掉账户后不残留「已添加」提示', !/已添加/.test($('add-msg').textContent), $('add-msg').textContent.slice(0, 30));
check('提示条回到默认引导文案', /可直接粘贴/.test($('add-msg').textContent), $('add-msg').textContent.slice(0, 30));
// 再删一个，回到后续用例期望的 1 张
doc.querySelectorAll('.acc')[0].querySelector('[data-act=del]').click();
await sleep(80);
check('删除后剩 1 张卡片', doc.querySelectorAll('.acc').length === 1);
check('删除已持久化', JSON.parse(window.localStorage.getItem('totp-web-accounts-v1')).accounts.length === 1);

/* --- 8. 安全声明自检 --- */
const secBar = doc.querySelector('.secbar');
check('安全声明横幅存在', !!secBar && /不会向任何服务器发送数据/.test(secBar.textContent));
check('声明写明无后端/不出设备', /无后端/.test(secBar.textContent) && /永不离开这台设备/.test(secBar.textContent));
const netBefore = $('net-count').textContent;
check('网络请求计数初始为 0', netBefore === '0', netBefore);
// 只 open 不 send：触发计数但不产生真实网络流量（jsdom 未实现 window.fetch，故用 XHR 验证）
new window.XMLHttpRequest().open('GET', 'http://127.0.0.1:9/probe');
await sleep(60);
check('计数器能捕获 XHR 请求', $('net-count').textContent === '1', $('net-count').textContent);
$('btn-sec-detail').click();
await sleep(30);
check('自检详情可展开', !$('sec-detail').classList.contains('hidden'));

/* --- 9. XSS 转义 --- */
$('in-secret').value = 'JBSWY3DPEHPK3PXR';
$('in-label').value = '<img src=x onerror=alert(1)>';
$('btn-add').click();
await sleep(120);
const injected = doc.querySelector('.acc .name img');
check('备注名已转义（无注入元素）', !injected);

check('全流程无未捕获错误', errors.length === 0, errors.join(' | '));

/* --- 10. 主密码加密全链路 --- */
const STORE_KEY = 'totp-web-accounts-v1';
const waitFor = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
  return false;
};
const accountsBefore = doc.querySelectorAll('.acc').length;
check('加密前存在明文账户', accountsBefore === 2, String(accountsBefore));
check('默认不加密（明文存储）', JSON.parse(window.localStorage.getItem(STORE_KEY)).mode === 'plain');

$('btn-crypto').click();
await sleep(80);
check('弹出设置主密码框', !!$('pw1') && !!$('pw2'));
$('pw1').value = 'my-master-pw'; $('pw2').value = 'my-master-pw';
$('pw-ack').checked = true;
$('pw-ok').click();
const encrypted = await waitFor(() => {
  const s = window.localStorage.getItem(STORE_KEY);
  return !!s && JSON.parse(s).mode === 'enc';
});
check('启用后转为加密存储', encrypted);
const store1 = JSON.parse(window.localStorage.getItem(STORE_KEY));
check('落盘不含明文 Secret', !JSON.stringify(store1).includes('JBSWY3DPEHPK3PXP'));
check('不保存密码本身', !JSON.stringify(store1).includes('my-master-pw'));
check('保存 salt/iter/iv 用于派生', !!store1.enc.salt && store1.enc.iter >= 100000 && !!store1.enc.iv);
check('启用加密后不再提供「关闭加密」入口', $('btn-crypto').classList.contains('hidden'), $('btn-crypto').textContent);
check('代码中不存在 disableEncryption', !/disableEncryption/.test(html));
check('页面文案中不再出现「关闭加密」', !/关闭加密/.test(html));
check('加密后安全提示同步更新', /闲置 5 分钟/.test($('sec-note').textContent) && /清除本机浏览器加密数据/.test($('sec-note').textContent),
  $('sec-note').textContent.slice(0, 40));

$('btn-lock').click();
await sleep(100);
check('锁定后显示锁屏', !$('lock-panel').classList.contains('hidden'));
check('锁定后隐藏账户列表', $('list').classList.contains('hidden'));
check('锁定后内存中账户已清空', doc.querySelectorAll('.acc').length === 0);

$('in-master').value = 'wrong-password';
$('btn-unlock').click();
await waitFor(() => $('lock-msg').classList.contains('err'));
check('错误密码被拒绝', /密码错误/.test($('lock-msg').textContent), $('lock-msg').textContent);
check('错误密码不解锁', doc.querySelectorAll('.acc').length === 0);

$('in-master').value = 'my-master-pw';
$('btn-unlock').click();
await sleep(500);
const unlocked = await waitFor(() => doc.querySelectorAll('.acc').length === accountsBefore);
check('正确密码解锁成功', unlocked, String(doc.querySelectorAll('.acc').length));
check('解锁后口令正常生成', /^\d{6,8}$/.test(doc.querySelector('.acc .code').textContent),
  doc.querySelector('.acc .code').textContent);

/* 模拟「下次打开页面」：把已加密的存储带进全新实例 */
const storedEnc = window.localStorage.getItem(STORE_KEY);
const dom3 = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
  beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    // 同上：jsdom navigator.language=en-US，强制中文
    w.localStorage.setItem('totp-web-locale', 'zh');
    w.localStorage.setItem(STORE_KEY, storedEnc);
    w.confirm = () => true;
    w.HTMLCanvasElement.prototype.getContext = () => null;
  },
});
await sleep(300);
const doc3 = dom3.window.document;
check('重新打开页面需输入密码', !doc3.getElementById('lock-panel').classList.contains('hidden'));
check('重新打开时看不到任何账户', doc3.querySelectorAll('.acc').length === 0);
doc3.getElementById('in-master').value = 'my-master-pw';
doc3.getElementById('btn-unlock').click();
const reopened = await waitFor(() => doc3.querySelectorAll('.acc').length === accountsBefore);
check('重新打开后可用密码解锁', reopened, String(doc3.querySelectorAll('.acc').length));

doc3.getElementById('btn-wipe').click();
await sleep(150);
check('忘记密码清除后锁屏消失', doc3.getElementById('lock-panel').classList.contains('hidden'));
check('忘记密码清除后回到强制引导（可重新设置）', !doc3.getElementById('onboard-panel').classList.contains('hidden'));
check('忘记密码清除后存储已删除', dom3.window.localStorage.getItem(STORE_KEY) === null);
dom3.window.close();

/* --- 11. 响应式：源码规则 + 窄屏行为 --- */
check('含 viewport meta', /<meta name="viewport"[^>]*width=device-width/.test(html));
check('含移动端断点 720px', /@media \(max-width:720px\)/.test(html));
check('含超窄屏断点 400px', /@media \(max-width:400px\)/.test(html));
check('含触屏反馈规则', /@media \(hover:none\)/.test(html));
check('移动端输入字号 >=16px（防 iOS 聚焦缩放）', /max-width:720px[\s\S]*?font-size:16px/.test(html));

const dom2 = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
  beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    // 同上：jsdom navigator.language=en-US，强制中文
    w.localStorage.setItem('totp-web-locale', 'zh');
    // 模拟窄屏：所有媒体查询命中
    w.matchMedia = () => ({ matches: true, media: '', onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
    w.HTMLCanvasElement.prototype.getContext = () => null;
    // 跳过强制引导，专测响应式布局
    w.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, mode: 'plain', accounts: [] }));
  },
});
await sleep(200);
const doc2 = dom2.window.document;
check('窄屏默认收起添加面板', doc2.getElementById('add-panel').classList.contains('hidden'));
doc2.getElementById('btn-toggle-add').click();
await sleep(60);
check('窄屏点击可展开添加面板', !doc2.getElementById('add-panel').classList.contains('hidden'));
check('窄屏空状态正常显示', !doc2.getElementById('empty').classList.contains('hidden'));
dom2.window.close();

/* --- 12. 安全加固检查 --- */
const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
check('存在 CSP meta', !!csp);
const cspVal = csp ? csp[1] : '';
check('CSP 禁止一切对外连接', /connect-src 'none'/.test(cspVal), cspVal);
check('CSP 禁止外部脚本/样式', /script-src 'unsafe-inline'/.test(cspVal) && /style-src 'unsafe-inline'/.test(cspVal));
// frame-ancestors 在 <meta> 里被浏览器忽略（只认 HTTP 头），写进去只会在控制台告警，
// 所以这里断言它「不在」meta 中，同时确认其余防护仍然齐全。
check('CSP 不含被 meta 忽略的 frame-ancestors', !/frame-ancestors/.test(cspVal), cspVal);
check('CSP 禁止 base 注入', /base-uri 'none'/.test(cspVal));
check('CSP 禁止插件类嵌入', /object-src 'none'/.test(cspVal));
// PWA：标准写法 mobile-web-app-capable 必须存在（apple- 前缀版已废弃）
check('PWA 使用标准 mobile-web-app-capable', /name="mobile-web-app-capable" content="yes"/.test(html));
check('禁用 referrer 泄露', /name="referrer" content="no-referrer"/.test(html));
// 所有拼进 innerHTML 的动态值必须经过 escapeHtml
const appSrc = html.slice(html.indexOf('<script id="app">'), html.indexOf('</script>', html.indexOf('<script id="app">')));
// 只在真正拼 HTML 的块里找裸变量（textContent 拼接不算风险）
const htmlChunks = [...appSrc.matchAll(/(?:innerHTML\s*=|openModal\()[\s\S]{0,1200}?;/g)].map((m) => m[0]);
const bareVars = [];
for (const chunk of htmlChunks) {
  for (const mm of chunk.matchAll(/\+\s*([a-zA-Z_$][\w$]*)\.([a-zA-Z]+)/g)) {
    const before = chunk.slice(Math.max(0, mm.index - 20), mm.index);
    if (!/escapeHtml\(/.test(before)) bareVars.push(mm[0].trim());
  }
}
check('HTML 模板插值均经 escapeHtml', bareVars.length === 0, bareVars.join(', '));
check('确有多个 HTML 模板块被检查', htmlChunks.length >= 2, String(htmlChunks.length));
check('扫码结果写入用 value/textContent 而非 innerHTML', !/\.innerHTML *= *text/.test(appSrc));
// 文案已外置到语言包：既要有中文原文（在 html 内联的 zh 包里），也要确认代码用的是词条 key
// 引号用 ['"] 兼容默认版与压缩版（terser 会把单引号统一成双引号）
check('复制迁移链接时提示含 Secret', /内含 Secret/.test(html) && /t\(['"]toast\.linkCopied['"]/.test(appSrc));

/* --- 13. 二维码识别：jsQR 兜底（桌面 Firefox/Chrome 无 BarcodeDetector） --- */
check('页面内联 jsQR 已就绪', typeof window.jsQR === 'function', typeof window.jsQR);
check('解码走「原生优先 + jsQR 兜底」', /BarcodeDetector/.test(html) && /jsQR\(/.test(html));
check('不再出现 BarcodeDetector 不可用提示', !/不支持 BarcodeDetector/.test(html));
check('环境提示改为摄像头可用性', /无法调用摄像头/.test(html));
$('btn-scan').click();
await sleep(120);
check('无摄像头时提示并可改用图片', /无法访问摄像头/.test($('toast').textContent), $('toast').textContent);
let picked = false;
$('file-input').addEventListener('click', () => { picked = true; }, { once: true });
$('btn-pick').click();
await sleep(60);
check('点「图片」会触发文件选择（不再被原生解码器缺失拦截）', picked);

/* --- 14. 新用户强制引导 + 闲置自动锁定 + 清除后回到引导 --- */
const dom0 = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
  beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    // 同上：jsdom navigator.language=en-US，强制中文
    w.localStorage.setItem('totp-web-locale', 'zh');
    w.confirm = () => true;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    // 全新用户：localStorage 完全为空
  },
});
await sleep(250);
const d0 = dom0.window.document;
const g0 = (id) => d0.getElementById(id);
check('新用户显示强制引导', !g0('onboard-panel').classList.contains('hidden'));
check('引导状态下隐藏添加面板', g0('add-panel').classList.contains('hidden'));
check('引导状态下隐藏「添加账户」按钮', g0('btn-toggle-add').classList.contains('hidden'));
check('引导状态下 header 不再重复「设置主密码」按钮', g0('btn-crypto').classList.contains('hidden'));
check('引导面板内只有 1 个设置主密码按钮',
  [...g0('onboard-panel').querySelectorAll('button')].length === 1,
  String([...g0('onboard-panel').querySelectorAll('button')].length));
check('引导状态下隐藏空状态', g0('empty').classList.contains('hidden'));
// 引导页含 {{min}} 插值文案：必须被替换成实际分钟数，不能把占位符漏到界面上
const li3 = g0('onboard-panel').querySelector('[data-i18n="onboard.li3"]');
check('引导页「闲置 N 分钟」已插值（无 {{min}} 残留）',
  !!li3 && !/\{\{/.test(li3.textContent) && /5/.test(li3.textContent),
  li3 ? li3.textContent : '(未找到 li3)');

g0('btn-onboard-set').click();
await sleep(80);
check('引导按钮打开设置弹窗', !!g0('pw1') && !!g0('pw-ack'));
g0('pw1').value = 'onboard-pw'; g0('pw2').value = 'onboard-pw';
g0('pw-ok').click();
await sleep(150);
check('未勾选「已牢记」则不允许启用', dom0.window.localStorage.getItem(STORE_KEY) === null,
  String(dom0.window.localStorage.getItem(STORE_KEY)));
check('未勾选时给出提示', /请先确认已牢记/.test(g0('toast').textContent), g0('toast').textContent);

g0('pw-ack').checked = true;
g0('pw-ok').click();
const onboardDone = await waitFor(() => {
  const s = dom0.window.localStorage.getItem(STORE_KEY);
  return !!s && JSON.parse(s).mode === 'enc';
});
check('勾选后启用加密成功', onboardDone);
check('设置完成后引导消失', g0('onboard-panel').classList.contains('hidden'));
check('设置完成后可添加账户', !g0('btn-toggle-add').classList.contains('hidden'));
check('设置完成后显示空状态', !g0('empty').classList.contains('hidden'));

// 时间前进 6 分钟，验证闲置自动锁定真的会触发
const realNow = dom0.window.Date.now.bind(dom0.window.Date);
dom0.window.Date.now = () => realNow() + 6 * 60 * 1000;
const autoLocked = await waitFor(() => !g0('lock-panel').classList.contains('hidden'), 8000);
check('闲置 5 分钟后自动锁定', autoLocked);
check('自动锁定后清空内存账户', d0.querySelectorAll('.acc').length === 0);
check('自动锁定有提示', /自动锁定/.test(g0('toast').textContent), g0('toast').textContent);
dom0.window.Date.now = realNow;

g0('in-master').value = 'onboard-pw';
g0('btn-unlock').click();
await waitFor(() => !g0('lock-panel').classList.contains('hidden') === false);
check('自动锁定后可用密码解锁', g0('lock-panel').classList.contains('hidden'));

// 忘记密码 → 清除 → 回到引导，形成闭环
g0('btn-wipe').click();
await sleep(200);
check('清除后回到强制引导', !g0('onboard-panel').classList.contains('hidden'));
check('清除后存储为空', dom0.window.localStorage.getItem(STORE_KEY) === null);
dom0.window.close();

/* --- 15. 国际化 i18n：切换 / 持久化 / 语言包与源码解耦 --- */
check('默认中文：主标题为「TOTP 动态口令」', doc.querySelector('h1').textContent === 'TOTP 动态口令', doc.querySelector('h1').textContent);
check('存在语言切换按钮', !!$('btn-lang'));

$('btn-lang').click();
await sleep(150);
check('切英文后主标题变英文', doc.querySelector('h1').textContent === 'TOTP Authenticator', doc.querySelector('h1').textContent);
check('切英文后按钮变为「中文」', $('btn-lang').textContent === '中文', $('btn-lang').textContent);
check('切英文已持久化到 localStorage', window.localStorage.getItem('totp-web-locale') === 'en', String(window.localStorage.getItem('totp-web-locale')));
check('切英文后安全提示为英文', /Security note|No accounts|master password/i.test($('sec-note').textContent), $('sec-note').textContent.slice(0, 50));

// 切到英文后不应残留中文：可见文本节点 + title/placeholder（跳过 script/style，它们的中文只是注释）
function collectText(node, out){
  if (node.nodeType === 3){ out.push(node.nodeValue); return out; }
  if (node.nodeType !== 1) return out;
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'SCRIPT' || tag === 'STYLE') return out;
  // 语言切换按钮的文案本身就是「另一种语言的名称」，不参与残留检查
  if (node.getAttribute && node.getAttribute('id') === 'btn-lang') return out;
  const attrs = [];
  for (const a of ['title', 'placeholder', 'aria-label']){
    const v = node.getAttribute(a);
    if (v) attrs.push(v);
  }
  if (attrs.length) out.push(attrs.join(' '));
  for (const c of node.childNodes) collectText(c, out);
  return out;
}
const zhLeftover = collectText(doc.body, [])
  .map((s) => String(s).trim())
  .filter((s) => s && /[\u4e00-\u9fff]/.test(s))
  .map((s) => s.slice(0, 40));
check('切英文后无中文残留（含 title/placeholder）', zhLeftover.length === 0, zhLeftover.slice(0, 6).join(' | '));
// 切语言后静态文案要重新插值，不能残留 {{min}}
const li3En = $('onboard-panel').querySelector('[data-i18n="onboard.li3"]');
check('切英文后「闲置 N 分钟」同样已插值',
  !!li3En && !/\{\{/.test(li3En.textContent) && /after 5 minutes/i.test(li3En.textContent),
  li3En ? li3En.textContent : '(未找到 li3)');

$('btn-lang').click();
await sleep(150);
check('切回中文后主标题复原', doc.querySelector('h1').textContent === 'TOTP 动态口令', doc.querySelector('h1').textContent);
check('切回中文已持久化', window.localStorage.getItem('totp-web-locale') === 'zh', String(window.localStorage.getItem('totp-web-locale')));

// 语言包与源码解耦：源码只留占位，词条放在 src/i18n/<lang>.js
const srcHtml = readFileSync(join(root, 'index.html'), 'utf8');
check('源码不含词条、只留占位', !/'app\.title'\s*:/.test(srcHtml) && srcHtml.includes('__I18N_PACKS__'));
let zhPack = '', enPack = '';
try { zhPack = readFileSync(join(root, 'src', 'i18n', 'zh.js'), 'utf8'); } catch (e) { zhPack = ''; }
try { enPack = readFileSync(join(root, 'src', 'i18n', 'en.js'), 'utf8'); } catch (e) { enPack = ''; }
const hasKey = (s, k) => new RegExp("['\"]" + k.replace(/\./g, '\\.') + "['\"]\\s*:").test(s);
check('语言包 zh.js / en.js 独立存在', hasKey(zhPack, 'app.title') && hasKey(enPack, 'app.title'));
check('产物已内联词条且无占位残留', hasKey(html, 'app.title') && !html.includes('__I18N_PACKS__'));

/* --- 16. 语言自动检测：没有历史选择时按浏览器语言决定（jsdom navigator.language = en-US） --- */
const domDetect = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/',
  pretendToBeVisual: true,
  beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    w.confirm = () => true;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    // 注意：这里刻意不写 totp-web-locale，用于验证自动检测
  },
});
await sleep(150);
const docAuto = domDetect.window.document;
check('未手动选择时按浏览器语言自动显示英文', docAuto.querySelector('h1').textContent === 'TOTP Authenticator', docAuto.querySelector('h1').textContent);
check('自动检测不落盘（只有手动切换才记忆）', domDetect.window.localStorage.getItem('totp-web-locale') === null, String(domDetect.window.localStorage.getItem('totp-web-locale')));
check('自动检测时 <html lang> 同步为 en', docAuto.documentElement.getAttribute('lang') === 'en', String(docAuto.documentElement.getAttribute('lang')));
domDetect.window.close();

/* --- 17. 文档双语：README.md（中文）与 README.en.md（英文）分开维护且互链 --- */
const readIfExists = (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch (e) { return ''; } };
const zhDoc = readIfExists('README.md');
const enDoc = readIfExists('README.en.md');
check('README 中英拆成两个文件', zhDoc.length > 500 && enDoc.length > 500, `zh ${zhDoc.length}B / en ${enDoc.length}B`);
check('中文 README 链到英文版', /README\.en\.md/.test(zhDoc));
check('英文 README 链到中文版', /README\.md/.test(enDoc));
// 防止又退回「中英混排」：各自只保留本语言的章节标题
const EN_HEADINGS = ['Features', 'Security Model', 'Quick Start', 'Internationalization', 'Tests', 'License'];
const ZH_HEADINGS = ['功能特性', '安全模型', '快速开始', '国际化', '测试', '许可证'];
const strayEn = EN_HEADINGS.filter((h) => new RegExp('^##\\s+' + h + '\\s*$', 'm').test(zhDoc));
const strayZh = ZH_HEADINGS.filter((h) => new RegExp('^##\\s+' + h + '\\s*$', 'm').test(enDoc));
check('中文 README 不含英文章节标题', strayEn.length === 0, strayEn.join(', '));
check('英文 README 不含中文章节标题', strayZh.length === 0, strayZh.join(', '));
check('两份 README 章节数一致', (zhDoc.match(/^## /gm) || []).length === (enDoc.match(/^## /gm) || []).length,
  `zh ${(zhDoc.match(/^## /gm) || []).length} / en ${(enDoc.match(/^## /gm) || []).length}`);

/* --- 18. 版本号：package.json 与页面 JSON-LD 的 softwareVersion 必须同步 --- */
// 版本号散在两处，漏改会让搜索引擎读到的版本与包版本不一致，这里强制对齐
const pkg = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch (e) { return {}; } })();
check('版本号为 semver 三段式', /^\d+\.\d+\.\d+$/.test(String(pkg.version)), String(pkg.version));
// 单一来源：源码 JSON-LD 用 __APP_VERSION__ 占位，版本由构建从 package.json 注入，
// 因此源码不再硬编码版本，从根上避免「漏改」导致与包版本不一致。
check('源码 JSON-LD 版本由构建从 package.json 注入（不硬编码）',
  srcHtml.includes('"softwareVersion": "__APP_VERSION__"'),
  '应为 __APP_VERSION__ 占位');
check('构建产物里的 JSON-LD 版本号同步', html.includes('"softwareVersion":"' + pkg.version + '"') || html.includes('"softwareVersion": "' + pkg.version + '"'), String(pkg.version));

console.error = origErr;
console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
dom.window.close();
process.exit(fail ? 1 : 0);
