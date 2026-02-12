# telegram-files PR 準備事項

> 本文件整理了 `telegram-files` extension 提交 PR 到 openclaw 主倉庫的完整狀況。
> 版本號由 `pnpm plugins:sync` 腳本自動同步，不需手動維護。

---

## 已完成的修正

### 1. `package.json` — 已修正 ✅

- `version`: 改為 `2026.2.10`（由 `scripts/sync-plugin-versions.ts` 自動同步，不用手動追蹤）
- `private`: 加上 `true`
- `peerDependencies` → `devDependencies`，值改為 `workspace:*`

### 2. `openclaw.plugin.json` — 已修正 ✅

- 移除了 `version`、`name`、`description` 欄位（其他 extension 都沒有這些）
- 只保留 `id` + `configSchema`，與 telegram/slack/discord 等一致

### 3. `index.ts` configSchema — 已修正 ✅

- 移除 `emptyPluginConfigSchema()`
- 改為內建 `parse()` 方法，安全解析 `externalUrl` 和 `allowedPaths`
- 與 `openclaw.plugin.json` 的 JSON Schema 保持一致

### 4. `register.ts` 拆分 — 已完成 ✅

原本 625 行，現在拆分為：

| 檔案 | 行數 | 職責 |
|------|------|------|
| `register.ts` | 213 | 主入口、/files 命令、HTTP 路由分發 |
| `api-handlers.ts` | 441 | 所有 REST API 端點處理 |
| `auth.ts` | 136 | Token 管理、JSON body 解析、回應輔助函式 |
| `path-utils.ts` | 137 | 路徑安全驗證、白名單檢查、檔案搜尋 |

全部 ≤500 行。

### 5. 程式碼品質與安全修正 — 已完成 ✅

- **curly braces**: 全部加上大括號
- **setInterval 記憶體洩漏**: 移除 `setInterval`，改為 `checkAuth` 中惰性清理（每次最多清 20 個過期 token）
- **pairing store 無限增長**: 加入 `MAX_PAIRING_CODES = 100`，超過時淘汰最舊的
- **CORS origin 回退**: URL 解析失敗時保持 `"null"`（拒絕跨域），不再使用原始使用者輸入
- **safePath 回退**: 所有祖先都不存在時回傳 `null`（拒絕操作），不再回傳未解析路徑
- **X-Content-Type-Options**: `jsonResponse` 加上 `nosniff` header
- **檔名長度限制**: 上傳加入 `MAX_FILENAME_LENGTH = 255`
- **static-server.ts**: 全部改為 `node:fs/promises` 異步操作
- **CSP header**: 從只有 `frame-ancestors` 擴展為完整 CSP（`default-src`, `script-src`, `style-src`, `connect-src` 等）
- **vite.config.ts**: `__dirname` 改為 `import.meta.url` 方式
- **重複的 errorMessage**: 提取到 `webapp/src/utils.ts` 共用
- **files-api.ts 重複解析**: 提取為 `private parseResponse()` 方法
- **app.ts 尾部斜線**: 父路徑計算加上正規化

---

## PR 提交前仍需完成

### 檔案清理
- [ ] 移除 `extensions/telegram-files/.git/`（獨立 repo 殘留）
- [ ] 移除 `extensions/telegram-files/node_modules/`
- [ ] 移除 `extensions/telegram-files/package-lock.json`
- [ ] 移除 `extensions/telegram-files/dist/`（如果存在）
- [ ] 從根目錄 `.gitignore` 移除 `extensions/telegram-files/` 這行
- [ ] 刪除本檔案 `PR-PREPARATION.md`（不需要提交到主倉庫）

### 建構驗證
- [ ] 執行 `pnpm install`（讓 workspace 識別新 extension）
- [ ] 執行 `pnpm plugins:sync`（自動同步版本號）
- [ ] 執行 `pnpm format`（oxfmt 格式化）
- [ ] 執行 `pnpm lint`（oxlint 檢查）
- [ ] 執行 `pnpm build` 確認建構成功
- [ ] 在 `extensions/telegram-files/webapp/` 執行 `npx vite build` 確認前端建構

### 測試
- [ ] 確認 `pnpm test` 通過
- [ ] 確認 `pnpm check` 通過（format + type check + lint）

---

## PR 訊息建議

```
feat(extensions): add telegram-files Mini App for mobile file management

Add a Telegram Mini App extension that allows users to browse, edit,
create, delete, upload, and search agent workspace files directly
from their mobile devices.

- Registers /files bot command with Telegram Mini App inline keyboard
- REST API with token-based auth (24h TTL, one-time pairing codes)
- Path whitelist security with traversal prevention
- Vite-built frontend using Telegram WebApp SDK
- Supports file search, binary detection, hidden file toggle
```

---

## 版本管理說明

版本號**不需要手動維護**。項目使用 `scripts/sync-plugin-versions.ts` 腳本：

```bash
pnpm plugins:sync
```

此腳本會讀取根目錄 `package.json` 的 version，自動寫入所有 `extensions/*/package.json`。
`openclaw.plugin.json` 不需要 version 欄位（其他 extension 都沒有）。

---

## 目前檔案結構

```
extensions/telegram-files/
├── package.json                  # @openclaw/telegram-files
├── openclaw.plugin.json          # 插件元資料 (id + configSchema)
├── index.ts                      # 插件入口 (33 行)
├── src/
│   ├── register.ts               # 主入口 + /files 命令 + HTTP 路由 (213 行)
│   ├── api-handlers.ts           # REST API 端點處理 (441 行)
│   ├── auth.ts                   # Token 管理 + 回應工具 (136 行)
│   ├── path-utils.ts             # 路徑安全 + 搜尋 (137 行)
│   ├── pairing.ts                # 配對碼管理 (49 行)
│   ├── runtime.ts                # PluginRuntime 橋接 (14 行)
│   └── static-server.ts          # 靜態檔案伺服 (126 行)
└── webapp/
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.ts               # 入口 + 認證流程
        ├── app.ts                # SPA 路由
        ├── utils.ts              # 共用工具函式
        ├── styles/theme.css
        ├── services/
        │   ├── auth.ts           # Token 持久化
        │   ├── files-api.ts      # REST 客戶端
        │   └── telegram.ts       # Telegram SDK 型別
        └── views/
            ├── file-list.ts      # 目錄瀏覽 + 搜尋
            └── file-editor.ts    # 檔案編輯器
```
