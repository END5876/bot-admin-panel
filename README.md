# admin-panel

Discord Bot 的網頁管理面板：**一個網頁管理多隻 Bot**（目前是 Mousebot 與 mousebot-lite，之後新增的 Bot 也可以加進來）。

用瀏覽器就能設定與管理 Bot，不必記指令。修改後立即生效，和 Discord 指令操作的是同一份資料。支援深色模式與手機版面。

## 架構

```
瀏覽器 ──HTTPS──▶ Caddy ──▶ admin-panel ──┬─▶ mousebot:3940      （Bot 的管理 API）
                              登入、網頁、 ├─▶ mousebot-lite:3940
                              操作紀錄     └─▶ …之後的 Bot
```

- **面板（這個服務）**：網頁、登入（密碼＋Cookie）、登入限流、操作紀錄。沒有任何 npm 依賴。
- **Bot 的管理 API**（各 Bot 的 `admin/agent.js` 與 `admin/api/`）：真正執行設定與操作。各模組的設定快取在 Bot 的記憶體裡、
  語音連線與播放佇列也只存在 Bot 程序內，所以 API 必須留在 Bot 裡，直接呼叫各模組的函式，記憶體與 `data/` 檔案才會一致。
- 瀏覽器只跟面板說話；面板帶著金鑰（`Authorization: Bearer`）把 `/api/bots/<代號>/…` 轉發到那隻 Bot 的 `/api/…`。
  Bot 的管理 API 只在 Docker 內部網路，不經過 Caddy 對外公開。
- 每隻 Bot 在 `GET /api/me` 回報自己支援的功能（`features`），面板只顯示那隻 Bot 有的頁面與按鈕。
  例如 mousebot-lite 沒有自訂回應、AI 人格編輯、TTS、通知，語音頁也沒有手動加入／離開與喚醒詞。
  同一頁也會依 Bot 回傳的資料調整內容（例如 AI 設定頁：單一人格的 Bot 不顯示使用者人格與範圍）。

## 頁面

側邊欄上方切換要管理的 Bot（網址是 `#/<代號>/<頁面>`，可以直接加書籤），換 Bot 時會留在同一頁（那隻 Bot 沒有這頁就回總覽）。

| 頁面 | 可以做的事 | Mousebot | lite |
|---|---|:-:|:-:|
| 總覽 | Bot 狀態、運行時間、記憶體、Discord 延遲、外部服務、模組開機摘要、語音連線、伺服器清單 | ✓ | ✓ |
| 自訂回應 | 搜尋、新增、編輯、刪除關鍵字回應；調整包含匹配的比對順序 | ✓ | |
| AI 人格 | 編輯人格的 system prompt 與共用規則、版本紀錄與還原；Mousebot 可以新增與刪除模式，lite 只有 `AI_PERSONA` 一個人格（沒有人格檔時可以從內建人格建立） | ✓ | 有設 `GEMINI_API_KEY` 時 |
| AI 設定 | 模型與額度、隨機插話機率與逐頻道開關、清除對話記憶；Mousebot 另有使用者人格模式、多人格／單一人格範圍、環境變數指定的固定人格，lite 顯示固定人格並以頻道為單位清除記憶 | ✓ | 有設 `GEMINI_API_KEY` 時 |
| AI 用量 | 近 7／30／90 天的每日 token 長條圖，依來源、人格、使用者拆分 | ✓ | 有設 `GEMINI_API_KEY` 時 |
| 語音與音樂 | 自動加入、點歌、正在播放、播放控制、佇列管理、閒置自動停止；Mousebot 另有加入／離開頻道與喚醒詞監聽 | ✓ | ✓ |
| TTS 語音 | SoVITS 模型、edge-tts 聲音、AI 回覆自動朗讀、試聽 | ✓ | |
| 通知與報時 | Steam / Epic 限免通知、整點報時 | ✓ | |
| 狀態與訊息 | Bot 的線上狀態與活動文字、以 Bot 身分在頻道發訊息 | ✓ | ✓ |
| 維護 | Slash 指令比對與強制同步、音樂下載快取、設定備份與還原（上傳備份檔 → 預覽會換掉哪些檔案 → 重新啟動時套用）、重新啟動 Bot | ✓ | ✓ |
| 操作紀錄 | 在面板上對每隻 Bot 做過的變更與登入紀錄（含來源 IP，保留最近 2000 筆），可依 Bot 篩選 | 面板 | 面板 |
| 日誌 | 這隻 Bot 最近 500 則 log，每 2 秒更新，可依等級、模組、關鍵字篩選 | ✓ | ✓ |

## 設定

見 [.env.example](.env.example)。

| 變數 | 說明 |
|---|---|
| `ADMIN_PASSWORD` | **必填**，登入密碼（至少 12 個字元，建議 24 字元以上的隨機字串） |
| `PANEL_BOTS` | 要管理的 Bot：逗號分隔的「代號=管理 API 網址」，順序就是顯示順序，例如 `mousebot=http://mousebot:3940,lite=http://mousebot-lite:3940` |
| `PANEL_TOKEN_<代號>` | 各 Bot 的金鑰（代號大寫，`-` 換成 `_`），要和那隻 Bot 的 `ADMIN_AGENT_TOKEN` 相同；全部相同時可以只設 `PANEL_TOKEN` |
| `ADMIN_PORT` / `ADMIN_HOST` | 監聽埠（預設 3940）與位址（預設 127.0.0.1；Docker 映像預設 0.0.0.0） |
| `ADMIN_SESSION_HOURS` | 登入有效時數（預設 168＝7 天） |
| `ADMIN_SESSION_SECRET` | 選填，簽 Cookie 的金鑰；未設定時自動產生並存在 `data/admin-session-secret` |
| `ADMIN_TRUSTED_PROXIES` | 選填，信任哪些反向代理帶來的 `X-Forwarded-For`（見下方「安全性」） |
| `PANEL_DATA_DIR` | 資料目錄（預設 `./data`，映像裡是 `/app/data`，要掛 Volume） |
| `ALERT_WEBHOOK_URL` / `ALERT_NAME` | 登入被鎖定時通知的 Discord webhook |

### 新增一隻 Bot

1. Bot 那邊：加上管理 API（可以從 mousebot-lite 複製 `admin/`，`admin/agent.js`、`admin/http.js` 不用改，
   在 `admin/api/index.js` 註冊這隻 Bot 有的路由並回報 `features`），`.env` 設定 `ADMIN_AGENT_TOKEN`（至少 32 字元），
   容器裡設 `ADMIN_HOST=0.0.0.0`。
2. 面板這邊：`PANEL_BOTS` 加一筆 `代號=http://<容器名稱>:3940`，設定 `PANEL_TOKEN_<代號>`，重新啟動面板。

產生金鑰：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## 執行

```bash
npm start        # 本機：開啟 http://localhost:3940/
npm test
```

本機開發時讓 Bot 的管理 API 用不同的 port（例如 Mousebot `ADMIN_PORT=3941`、lite `ADMIN_PORT=3942`），
面板的 `PANEL_BOTS=mousebot=http://127.0.0.1:3941,lite=http://127.0.0.1:3942`。

正式環境（VPS）：Docker 映像，Caddy 把 HTTPS 網域轉到 `admin-panel:3940`，前面再加 Cloudflare Access。
不要以純 HTTP 對外開放，否則密碼會以明文傳送。

## 安全性

- 沒有設定 `ADMIN_PASSWORD`（或少於 12 個字元）時拒絕啟動。
- 登入後以 HttpOnly、SameSite=Strict 的 Cookie 維持（預設 7 天）。簽章金鑰存在 `data/admin-session-secret`，再和密碼一起衍生：**換密碼等於讓所有裝置登出**。登出的 Cookie 記在 `data/admin-revoked.json`，重新啟動後仍然無效。
- 登入限流：每個來源 10 分鐘內最多失敗 10 次，全站 10 分鐘內最多失敗 50 次。成功登入過的裝置（`mb_admin_dev` Cookie，90 天）不受全站上限影響，攻擊者灌錯誤密碼鎖不住擁有者。
- 來源 IP：連線來自信任的反向代理時改用 `X-Forwarded-For`（最右邊那一個）。信任範圍由 `ADMIN_TRUSTED_PROXIES` 決定；沒設定時信任所有私有網段（VPS 上 Caddy 經由 Docker 網路連進來需要這個），`none` 表示完全不讀。
- 只有真的登出了一個有效 session 才寫「登出」紀錄；登入失敗在操作紀錄裡另有上限，擠不掉真正的管理操作。
- 所有寫入請求都必須帶自訂 header 與 JSON body（防 CSRF）；網頁設有嚴格的 Content-Security-Policy，外部資料（伺服器名稱、回應內容、log）一律以純文字顯示。
- 面板與 Bot 之間：每隻 Bot 各自的金鑰（`timingSafeEqual` 比對）。Bot 回 401 時面板改回 502 並說明「金鑰不一致」，不會被當成面板的登入過期。面板的 Cookie 不會轉送給 Bot，Bot 回應裡的 `Set-Cookie` 等標頭也不會傳給瀏覽器。

## 管理 API 協定（protocol 1）

給要加管理 API 的 Bot 參考；實作見 Mousebot 的 `admin/agent.js`。

- 每個請求帶 `Authorization: Bearer <ADMIN_AGENT_TOKEN>`；金鑰錯誤一律 401。
- `GET /api/me` → `{ protocol: 1, app, features: string[], ready, ping, bot: { id, name, tag, avatarUrl } | null }`
- 其餘 `/api/*`：寫入請求的 body 是 JSON；錯誤回 `{ error }`（訊息會直接顯示在網頁上）。
- 請求標頭 `x-admin-source`：面板看到的使用者來源（URL 編碼），只用來寫 log。
- 回應標頭 `x-admin-audit`：這次做了哪些變更（base64url 編碼的 JSON 字串陣列），面板寫進操作紀錄；請求失敗時不帶。
- `features`：頁面代號 `overview`、`responses`、`prompts`、`ai`、`usage`、`voice`、`tts`、`notify`、`status`、`maintenance`、`logs`，
  以及頁面內的選用功能 `voice:join`（加入／離開語音頻道）、`voice:wakeWord`（喚醒詞監聽）、`maintenance:backup`（設定備份）。
