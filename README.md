# TOTP-Web · 纯前端 TOTP 身份验证器

> 单文件 · 零网络 · 可离线 · MIT 开源

[English](./README.en.md) | 简体中文

一个**纯浏览器前端**的 TOTP（RFC 6238）身份验证器。所有计算都在本地完成，不依赖任何服务器、不上传任何数据，可直接用浏览器打开使用。

---

## 功能特性

- **多账户管理**：添加 / 编辑 / 删除多个 TOTP 账户，卡片网格展示，窄屏自适应。
- **三种录入方式**：手动输入 Secret、粘贴 `otpauth://` 链接、扫描或上传二维码。
- **主密码加密**：用 PBKDF2 + AES-GCM 派生密钥加密本地存储的 Secret，密码不落盘；闲置 5 分钟自动锁定。
- **扫码兜底**：优先用浏览器原生 BarcodeDetector，不支持时回退到内联的 jsQR，保证桌面 Firefox / Chrome 也能扫。
- **中英双语**：内置中文 / English 两套语言包，按浏览器语言自动选择，右上角可手动切换并记忆选择。
- **零依赖单文件**：构建后是一个独立 HTML，可离线运行，可随意复制分发。

---

## 安全模型

- **数据不出本机**：所有 TOTP 计算、加密、存储都在浏览器内完成，页面通过 CSP 与 `connect-src 'none'` 主动禁止任何网络请求。打开页面时可看到实时「零网络」自检计数。
- **主密码不存储**：密钥由主密码经 PBKDF2-HMAC-SHA256（310,000 次迭代）派生，`extractable: false`，永不以明文出现在任何地方；忘记密码只能清除本机浏览器数据后重新设置。

---

## 快速开始

**直接用（无需构建）：** 下载发布版的 `dist/index.html`，双击用浏览器打开即可。

**或自行构建：**

```bash
npm install         # 安装开发依赖（jsdom / terser / jsqr）
npm run build       # 生成可读版 dist/index.html（便于审计源码）
npm run build:min   # 额外压缩 HTML/CSS/JS，生成用于分发的最小版
```

- `npm run build` 生成的 `dist/index.html` 保留换行与缩进，方便你直接对照源码审查。
- `npm run build:min` 在此基础上再压缩 HTML/CSS/JS（jsQR 已是压缩态），体积约 196KB，适合实际分发。

**只打包某几种语言：**

```bash
node scripts/build.mjs --lang=zh        # 只内联中文包（约省 12KB），语言切换按钮会自动隐藏
node scripts/build.mjs --lang=zh,en --min
```

不传 `--lang` 时默认打包 `zh,en`。

无论哪种方式，产物都是单文件、零网络；测试脚本永远不会被打进去。

---

## 国际化

词条不写在 `index.html` 里，而是放在 `src/i18n/<lang>.js`，构建时按需内联进单文件产物：

```
src/i18n/zh.js   # I18N.zh = { 'app.title': 'TOTP 动态口令', ... }
src/i18n/en.js   # I18N.en = { 'app.title': 'TOTP Authenticator', ... }
```

- **源码只留占位**：`index.html` 的 `<script id="i18n-lib">` 里只有一个 `/*__I18N_PACKS__*/` 标记，构建脚本把它替换成所选语言包的内容。
- **静态基线 + JS 覆盖**：HTML 里保留中文原文（利于 SEO 与禁用 JS 的场景），切到英文时由 JS 按 `data-i18n` / `data-i18n-html` / `data-i18n-ph` / `data-i18n-title` 覆盖。
- **动态文案**：toast、确认框、报错、安全说明等运行时文案统一走 `t(key, vars)`，支持 `{{var}}` 插值与 `{one,other}` 复数；算法库抛错只带 `code`，译文由 UI 层查表，保证核心算法仍可单独在 Node 中测试。

**新增一门语言：**

1. 复制 `src/i18n/zh.js` 为 `src/i18n/<lang>.js`，把首行改为 `I18N.<lang> = { ... }` 并翻译各条。
2. 在 `index.html` 的 `I18N_LANG` 里补上 `{ <lang>: '<BCP-47 tag>' }`，并在 `detectLocale()` 里加一条匹配规则。
3. 用 `node scripts/build.mjs --lang=zh,en,<lang>` 构建即可；语言切换按钮会在语言数 ≥ 2 时自动出现。

---

## 搜索引擎与 AI 友好（SEO / AI-SEO）

页面已针对传统搜索引擎与 AI 抓取（如 Perplexity、ChatGPT 浏览、Google SGE）做了结构化优化：

- **基础 meta**：`description` / `keywords` / `author` / `robots=index,follow` / `theme-color` / `color-scheme`。
- **社交分享**：Open Graph（`og:title` / `og:description` / `og:locale` 中英双语）与 Twitter Card。
- **结构化数据**：`<head>` 内含 [schema.org](https://schema.org) 的 `SoftwareApplication` JSON-LD（名称、描述、分类、免费、功能列表、MIT 许可），AI 与搜索引擎可直接理解「这是什么软件、能做什么」。
- **可爬取文案**：页头 `<h1>`、安全说明栏均为静态 HTML 文本（非仅 JS 渲染），即使不执行 JS 也能被收录；并内置内联 SVG favicon（零额外请求）。

> 部署到公网时，建议在 `<head>` 补一行 `<link rel="canonical" href="你的地址">` 与 `og:image`（预览图）以获得最佳收录与分享效果。

---

## 测试

```bash
npm test         # = build + verify + smoke + i18n-check
```

- `tools/verify.mjs`：核心算法自测（RFC 6238 官方向量 SHA1/256/512、otpauth 回环、QR 端到端解码、PBKDF2+AES-GCM 往返）。
- `tools/smoke.mjs`：用 jsdom 真实加载 `dist/index.html` 跑主流程（添加 / 渲染 / 持久化 / 删除 / 锁定 / 语言切换 / 安全断言）。
- `tools/i18n-check.mjs`：词条一致性检查——源码里用到的每个 key 是否都在每个语言包里存在（含算法库的动态错误码），并提示未被使用的词条。

---

## 项目结构

```
.
├── index.html          # 源码（约 75KB；jsQR 与语言包都以占位符存在，便于维护）
├── src/i18n/           # 语言包，与主 HTML 解耦，构建时按需内联
│   ├── zh.js           # I18N.zh = {...}
│   └── en.js           # I18N.en = {...}
├── dist/
│   └── index.html      # 构建产物：单文件、零网络、可离线（npm run build 生成，通常 git 忽略）
├── tools/
│   ├── jsqr.min.js     # vendored 依赖（jsqr@1.4.0, Apache-2.0），随仓库提交，保证离线可构建
│   ├── verify.mjs      # 核心算法测试
│   ├── smoke.mjs       # DOM 冒烟测试
│   └── i18n-check.mjs  # 词条一致性检查（源码 key ↔ 各语言包）
├── scripts/
│   └── build.mjs       # 构建脚本：注入 jsQR + 语言包 → dist/index.html
├── .gitleaks.toml      # 放行 RFC 6238 公开测试向量（非真实密钥）
├── package.json
├── LICENSE             # MIT
├── README.md           # 本文件（简体中文）
└── README.en.md        # English
```

---

## 升级 jsQR

`tools/jsqr.min.js` 是 vendored 的压缩版 jsQR。**升级步骤：**

```bash
npm install                 # 确保本地有 jsqr / terser
npm run build:jsqr          # 从 node_modules/jsqr 重新压缩生成 tools/jsqr.min.js
npm run build               # 重新生成 dist/index.html
sha256sum tools/jsqr.min.js # 记录新校验值，便于审计
```

---

## 许可证

[MIT](./LICENSE) © 2026 the TOTP-Web contributors
