# 🧶 帽廠庫存管家（Knit Factory Inventory）

小型針織/成帽工廠專用的**雲端手機端庫存查詢與出入庫輸入系統**。

- **前端**：Vite + React + TailwindCSS，PWA 架構（manifest + Service Worker），iPhone / Android 加入主畫面後可像原生 App 全螢幕執行
- **掃碼**：`@zxing/browser`（ZXing JS），iOS Safari / Android Chrome 皆可呼叫後置鏡頭掃 QR Code 與一維條碼
- **後端**：Google Apps Script（GAS）部署為 Web App，資料 100% 落地在你自己的 **Google 試算表**，零主機費、零資料庫費

```
手機 PWA (React)
   │  fetch POST (JSON, text/plain 避免 CORS 預檢)
   ▼
GAS Web App (.../exec)  ──►  Google Spreadsheet
   doPost / doGet               ├─ INVENTORY_MASTER（庫存主檔）
   LockService 防併發           └─ STOCK_LOG（出入庫異動記錄）
```

---

## 📁 專案結構

```
knit-factory-inventory/
├── index.html                    # PWA meta（iOS apple-* 全螢幕設定）
├── package.json
├── vite.config.js                # Vite + vite-plugin-pwa（自動產生 manifest/SW）
├── tailwind.config.js / postcss.config.js
├── public/
│   ├── favicon.svg
│   └── icons/                    # icon-192/512、apple-touch-icon（已生成）
├── scripts/generate-icons.ps1    # 圖示再生成腳本（Windows 原生，無需套件）
├── backend/
│   └── Code.gs                   # ★ 複製到 Google Apps Script 的後端
└── src/
    ├── main.jsx                  # 入口 + Service Worker 註冊
    ├── App.jsx                   # 分頁導覽 / 掃碼調度 / Toast
    ├── api.js                    # GAS API client（fetch POST）
    ├── constants.js              # 低庫存門檻 (=10) 等設定
    ├── hooks/useInventory.js     # 庫存清單載入 / 送出異動 / 本地更新
    └── components/
        ├── SearchTab.jsx         # 分頁1：搜尋 + 掃碼 + 卡片清單（<=10 紅字警示）
        ├── ActionTab.jsx         # 分頁2：入庫/出庫/盤點 + 防呆 + 二次確認
        ├── SettingsTab.jsx       # 分頁3：API 網址 / 經辦人 / 連線測試
        ├── Scanner.jsx           # 全螢幕相機掃碼（含手動輸入備援）
        ├── ConfirmDialog.jsx     # 底部抽屜式確認彈窗
        └── Toast.jsx
```

---

## 🚀 步驟一：本機執行（需先安裝 Node.js 18+）

1. 到 https://nodejs.org 安裝 Node.js LTS（或用 `winget install OpenJS.NodeJS.LTS`）
2. 在專案資料夾：

```bash
cd knit-factory-inventory
npm install
npm run dev
```

3. 電腦瀏覽器開啟 http://localhost:5173 即可預覽（手機在同一 Wi-Fi 可用區網 IP 開啟）

> 圖示已預先生成好；想改形象時執行
> `powershell -ExecutionPolicy Bypass -File scripts\generate-icons.ps1`

---

## 🟦 步驟二：Google 試算表 + Apps Script 後端部署

1. **建立試算表**：到 https://sheets.new 建一新試算表，命名例如「帽廠庫存」。
   （不需要手動建欄位 —— 下一步的 `setupSheets()` 會自動建立。）

2. **貼上後端**：選單「**擴充功能 ➔ Apps Script**」➔ 將專案
   `knit-factory-inventory/backend/Code.gs` 的全部內容貼上（覆蓋原有 myFunction）➔ 儲存（💾）。

3. **初始化資料表**：
   - 上方函式選單選 `setupSheets` ➔ 按「執行」➔ 彈出授權視窗 ➔「繼續」➔ 選擇你的帳號 ➔
     「進階 ➔ 前往專案（不安全）➔ 允許」。
   - （選用）再執行一次 `seedDemoData` ➔ 灌入 5 筆示範料件方便測試。

4. **部署為 Web App**：
   - 右上角「**部署 ➔ 新增部署作業**」
   - 齒輪圖示選「**網路應用程式**」
   - 說明：隨意；**執行身份：我**；**誰可以存取：任何人** ←（手機不用登入就能叫用）
   - 按「部署」➔ 複製產生的 **網頁应用程式網址**（`https://script.google.com/macros/s/AKfy…/exec`）

5. **前端接上**：開啟 App ➔「設定」分頁 ➔ 貼上網址（必須以 `/exec` 結尾）➔
   「儲存並測試連線」，看到 ✅ 連線成功即可開始使用。

6. **之後改了 Code.gs**：必須「部署 ➔ 管理部署作業 ➔ ✏️ 編輯 ➔ 版本：新版本 ➔ 部署」才會生效
   （網址不變）。

### 資料結構（自動建立）

**INVENTORY_MASTER（庫存主檔）**

| Item_Code | Item_Name | Category | Color_Spec | Stock_Qty | Unit | Location | Last_Updated |
|---|---|---|---|---|---|---|---|
| KN-CAP-001 | 針織毛線帽 M | 成品 | 燕麥色 | 120 | PCS | A-01-05 | 2026-… |
| KN-YARN-007 | 壓克力毛紗 30# | 原料 | 本白 | 45.5 | KG | R-03 | 2026-… |

**STOCK_LOG（出入庫異動記錄）**

| Log_ID | Timestamp | Type | Item_Code | Change_Qty | Operator | Remark |
|---|---|---|---|---|---|---|
| L20261027… | 2026-… | 出庫 | KN-CAP-001 | -12 | 陳大明 | WO-2026-1130-A |

**WORK_ORDERS（工作令／工單）**

| WO_ID | Style_No | Plan_Qty | Due_Date | Destination | Order_Ref | Status | Actual_Qty | Completed_Time |
|---|---|---|---|---|---|---|---|---|
| WO261029-01 | 111AG20/6090R-G-D | 500 | 2026-11-05 | 入倉庫 | PO-2026-0888 | 生產中 | | |

`Destination`：**入倉庫**（完工入庫存）／**訂單出貨**（完工後待出貨）；
`Status`：**生產中 → 待確認 →（完工）已入庫 / 待出貨 →（出貨）已出貨**；
`WO_ID` 由 App 自動編號（WOyyMMdd-##）。

**BOM_MASTER（物料清單）**：一列 = 一款 × 一種原料

| Style_No | Item_Code | Item_Name | Unit_Use |
|---|---|---|---|
| 111AG20/6090R-G-D | A0001 | 1101PC/6624 | 0.09 |

`Unit_Use` = 每件耗用量。開立工作令時自動試算 `需求量 = Plan_Qty × Unit_Use`；
完工時可勾選「依 BOM 扣原料」（扣至負庫存也會照扣，供現場檢討）。

新增料件可直接在 App「出入庫」分頁按「➕ 直接入庫新品項」（品號留空會自動編號 A####），
或直接在 INVENTORY_MASTER 插入列填入（Last_Updated 系統會自動維護）；
`Type` 支援：**入庫**（+數量）、**出庫**（−數量）、**盤點**（設定為盤點後實際庫存量）。

#### 工作令每日到期檢查（自動）

`setupSheets()` 會安裝 Time-driven 觸發器（每日約 06:00 執行 `checkDueWorkOrders()`）：
`Due_Date` 已過期且狀態仍為「生產中」的自動轉為「**待確認**」，
App 首頁會出現醒目的「⏰ 到期待確認工單」清單。

### API 協定（給日後擴充參考）

```
POST { action:"ping" }                                   → 版本/時間/料件數
POST { action:"list" }                                   → 整份庫存主檔
POST { action:"get",  item_code }                         → 單一料件
POST { action:"log",  type:"入庫", item_code, qty,
       operator, remark, force }                          → 記錄異動 + 更新庫存
POST { action:"log",  type:"入庫", item_code, qty, …,
       new_item:{ item_code?, item_name, category?,
                  color_spec?, unit?, location? } }       → 品號不存在時
       先建立新品項（item_code 留空 → 自動編號 A####）再入庫
POST { action:"list_work_orders" }                         → 整份工作令
POST { action:"list_bom" }                                 → 整份 BOM
POST { action:"create_work_order", style_no, plan_qty,
       due_date, destination, order_ref? }                 → 開立工作令（生產中）
POST { action:"complete_work_order", wo_id, actual_qty,
       target_item_code(入倉庫必填), use_bom,
       operator, remark? }                                 → 確認完工結案
       入倉庫 → 成品入庫＋BOM 扣料＋「已入庫」；訂單出貨 → 「待出貨」
POST { action:"ship_work_order", wo_id }                   → 待出貨 → 已出貨
回應固定為 { ok:true, data:… } 或 { ok:false, error:"…" }
```

- 同時出庫／入庫並發時，GAS 端以 `LockService.waitLock(30s)` 序列化更新，**不會互相覆蓋庫存**。
- 出庫形成負庫存一定需要 `force:true`，而 force 只會由前端「已明確警告 + 二次確認」帶出。

---

## 🟩 步驟三：前端免費部署（上線給手機裝）

### 方案 A：Vercel（推薦，最快）

1. 把 `knit-factory-inventory` 資料夾上傳到 GitHub（ 建立 repo ➔ push）。
2. 開 https://vercel.com ➔ 以 GitHub 登入 ➔「Add New Project」➔ 匯入該 repo。
3. Framework Preset 自動偵測 **Vite**，直接按 **Deploy**。
4. 完成後取得網址 `https://你的專案.vercel.app`（已是 HTTPS ✅，相機掃碼可用）。

CLI 方式：`npm i -g vercel && vercel --prod`

### 方案 B：Cloudflare Pages

1. 開 https://pages.cloudflare.com ➔「Create a project ➔ Connect to Git」➔ 選 repo。
2. 建置設定：Framework preset 選 **Vite**；Build command `npm run build`；
   Output directory `dist` ➔ Save and Deploy。
3. 取得 `https://你的專案.pages.dev`。

（二擇一即可，之後 git push 都會自動重新部署。）

---

## 📱 步驟四：加到主畫面（像原生 App）

### iPhone（Safari）

1. 用 **Safari** 開啟網址（重要：Chrome/其他瀏覽器在 iOS 不能加主畫面）。
2. 按底部中間的「**分享**」按鈕 ⬆️ ➔ 捲動找到「**加入主畫面**」➔ 按「加入」。
3. 桌面出現 🧶 圖示，點開即是**無網址列的全螢幕 App**。
4. 相機權限：第一次按📷時 Safari 會詢問；若按錯拒绝，
   到「設定 ➔ Apps ➔ Safari ➔ 相機」或網站設定重新允許。

### Android（Chrome）

1. 用 **Chrome** 開啟網址。
2. 右上 ⋮ ➔「**加入主畫面 / 安裝應用程式**」（若顯示「安裝」圖示也可直接點）。
3. 完成 ➔ App 清單與桌面都有獨立圖示，啟動即全螢幕 standalone 模式。

> Android 需等 Service Worker 安裝完（開啟網站 1~2 秒後）才會出現「安裝」選項。

---

## 🛡️ 防呆與 UX 重點（現場實測導向）

- **大字體、高對比、48px+ 觸控高度**：戴手套也能穩定點按；輸入字級 ≥16px 防 iOS 自動放大。
- **出庫防呆**：選完品號即時顯示「在庫量」；數量超出在庫 → 紅色警告區塊 +
  「仍要送出（覆核通過）」確認鍵，後端同時要求 `force:true` 才允許負庫存。
- **二次確認彈窗**：底部抽屜式，完整列出類型／品號／異動前後庫存／經辦／備註。
- **盤點**：填「盤點後實際庫存量」，系統自動換算差異寫入 Change_Qty。
- **Toast 回饋**：成功顯示最新庫存餘額；失敗（含 GAS 錯誤訊息）即時提示。
- **離線改善**：`NetworkOnly` 快取策略確保**永遠不快取**舊庫存資料。

---

## ❓ 常見問題

| 問題 | 解法 |
|---|---|
| 相機打不開 | 網站必須是 HTTPS（Vercel/CF Pages 預設 https）；iOS 需允許相機；相機壞掉時可用掃碼頁下方「手動輸入」備援 |
| `Failed to fetch` / 連不上 | 確認網址以 `/exec` 結尾、部署「誰可以存取＝任何人」、手機有網路 |
| 回應很慢（3~5 秒） | GAS 免費版冷啟動正常現象；等首次請求後會變快 |
| 送出後資料沒更新 | 改過 Code.gs 記得「管理部署作業 ➔ 新版本」；App 內按右上「⟳ 同步」 |
| 想換低庫存門檻（預設 10） | 改 `src/constants.js` 的 `LOW_STOCK_THRESHOLD` 後重新 build |
| 圖示想換 | 改 `scripts/generate-icons.ps1` 中的繪圖參數後執行該腳本 |
