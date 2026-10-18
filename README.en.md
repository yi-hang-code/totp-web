# TOTP-Web · A Pure Front-End TOTP Authenticator

> Single-file · zero-network · offline · MIT licensed

[简体中文](./README.md) | English

A **pure browser front-end** TOTP (RFC 6238) authenticator. Everything is computed locally — no server, no upload — just open it in a browser.

---

## Features

- **Multi-account management**: add / edit / remove TOTP accounts, shown in a responsive card grid that adapts to narrow screens.
- **Three ways to add**: type a Base32 secret, paste an `otpauth://` URI, or scan / upload a QR code.
- **Master password encryption**: PBKDF2 + AES-GCM derives the key that encrypts stored secrets; the password is never persisted; the app auto-locks after 5 idle minutes.
- **QR fallback**: uses the native `BarcodeDetector` when available and falls back to inlined jsQR, so desktop Firefox / Chrome can scan too.
- **Bilingual (Chinese / English)**: two language packs are bundled; the browser language is auto-detected and a switch in the header remembers your choice.
- **Zero-dependency single file**: the build output is one standalone HTML file that runs offline and can be shared freely.

---

## Security Model

- **Data never leaves your device**: all TOTP computation, encryption, and storage happen in the browser. A strict CSP with `connect-src 'none'` actively blocks any network request; the page shows a live "zero-network" self-check counter.
- **The master password is never stored**: the key is derived from your master password via PBKDF2-HMAC-SHA256 (310,000 iterations) and is `extractable: false`; it never exists in plaintext. A forgotten password can only be resolved by wiping the browser data and starting over.

---

## Quick Start

**Use directly (no build needed):** download the released `dist/index.html` and open it in any browser.

**Or build it yourself:**

```bash
npm install         # dev dependencies (jsdom / terser / jsqr)
npm run build       # readable dist/index.html, easy to audit
npm run build:min   # additionally minifies HTML/CSS/JS for distribution
```

- `npm run build` keeps newlines and indentation so you can audit the output against the source.
- `npm run build:min` further minifies HTML/CSS/JS (jsQR is already minified) to about 196KB.

**Bundle only selected languages:**

```bash
node scripts/build.mjs --lang=zh        # Chinese only (saves ~12KB); the language switch hides itself
node scripts/build.mjs --lang=zh,en --min
```

When `--lang` is omitted, `zh,en` is bundled by default.

Either way the output is a single offline file; test scripts are never bundled.

---

## Internationalization

Strings do not live in `index.html` — they live in `src/i18n/<lang>.js` and are inlined into the single-file build on demand:

```
src/i18n/zh.js   # I18N.zh = { 'app.title': 'TOTP 动态口令', ... }
src/i18n/en.js   # I18N.en = { 'app.title': 'TOTP Authenticator', ... }
```

- **Placeholder in the source**: `<script id="i18n-lib">` in `index.html` contains only a `/*__I18N_PACKS__*/` marker, which the build replaces with the selected packs.
- **Static baseline + JS override**: the HTML keeps the Chinese text as the static baseline (good for SEO and for the case where JS is disabled); switching to English overwrites it via `data-i18n` / `data-i18n-html` / `data-i18n-ph` / `data-i18n-title`.
- **Runtime strings**: toasts, confirm dialogs, errors and the security notes all go through `t(key, vars)`, with `{{var}}` interpolation and `{one,other}` plurals. The crypto/TOTP core throws errors carrying only a `code`; the UI layer translates them, so the core stays testable in plain Node.

**Adding a language:**

1. Copy `src/i18n/zh.js` to `src/i18n/<lang>.js`, rename the first line to `I18N.<lang> = { ... }` and translate the entries.
2. Add `{ <lang>: '<BCP-47 tag>' }` to `I18N_LANG` in `index.html`, plus a matching rule in `detectLocale()`.
3. Build with `node scripts/build.mjs --lang=zh,en,<lang>`; the switch button appears automatically when 2 or more languages are bundled.

---

## SEO / AI-SEO

The page is structured for both classic search engines and AI crawlers (Perplexity, ChatGPT browsing, Google SGE):

- **Basic meta**: `description` / `keywords` / `author` / `robots=index,follow` / `theme-color` / `color-scheme`.
- **Social sharing**: Open Graph (`og:title` / `og:description` / bilingual `og:locale`) and Twitter Card.
- **Structured data**: a [schema.org](https://schema.org) `SoftwareApplication` JSON-LD block in `<head>` (name, description, category, free, feature list, MIT license), so crawlers can tell what this software is and what it does.
- **Crawlable copy**: the `<h1>` and the security note are static HTML text rather than JS-rendered only, so they are indexed even when JS is not executed; an inlined SVG favicon avoids an extra request.

> When deploying publicly, add `<link rel="canonical" href="your-url">` and an `og:image` to `<head>` for the best indexing and sharing results.

---

## Tests

```bash
npm test         # = build + verify + smoke + i18n-check
```

- `tools/verify.mjs`: core algorithm tests — RFC 6238 official vectors (SHA1/256/512), otpauth round-trip, end-to-end QR decode, PBKDF2+AES-GCM round-trip.
- `tools/smoke.mjs`: loads `dist/index.html` with jsdom and exercises the main flow (add / render / persist / delete / lock / language switch / security assertions).
- `tools/i18n-check.mjs`: key consistency — every key used in the source (including dynamic error codes) must exist in every language pack; also reports unused entries.

---

## Project Structure

```
.
├── index.html          # Source (~75KB; jsQR and language packs kept as placeholders)
├── src/i18n/           # Language packs, decoupled from the main HTML, inlined at build time
│   ├── zh.js           # I18N.zh = {...}
│   └── en.js           # I18N.en = {...}
├── dist/
│   └── index.html      # Build output: single-file, offline (npm run build; usually git-ignored)
├── tools/
│   ├── jsqr.min.js     # Vendored dependency (jsqr@1.4.0, Apache-2.0), committed for offline builds
│   ├── verify.mjs      # Core algorithm tests
│   ├── smoke.mjs       # DOM smoke test
│   └── i18n-check.mjs  # Key consistency check (source keys <-> language packs)
├── scripts/
│   └── build.mjs       # Build script: injects jsQR + language packs -> dist/index.html
├── .gitleaks.toml      # Allows the RFC 6238 public test vector (not a real secret)
├── package.json
├── LICENSE             # MIT
├── README.md           # 简体中文
└── README.en.md        # This file
```

---

## Updating jsQR

`tools/jsqr.min.js` is a vendored minified jsQR. **Upgrade steps:**

```bash
npm install                 # make sure jsqr / terser are installed
npm run build:jsqr          # re-minify from node_modules/jsqr into tools/jsqr.min.js
npm run build               # regenerate dist/index.html
sha256sum tools/jsqr.min.js # record the new checksum for auditing
```

---

## License

[MIT](./LICENSE) © 2026 the TOTP-Web contributors
