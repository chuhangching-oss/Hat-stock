# 🤝 交接文件（HANDOFF）— 帽廠庫存管家

> **用途**：這份文件讓新的 AI 對話（OpenCode 新 session）能無縫接續開發。
> 新對話開場請說：「請先讀 HANDOFF.md，接續帽廠庫存系統開發」。

## 專案是什麼

針織/成帽工廠的庫存管理 PWA（手機優先）：

- **前端**：React + Vite + Tailwind（`src/`），部署在 **Vercel** → https://hat-stock.vercel.app
- **後端**：Google Apps Script（`backend/Code.gs`，單檔 ~2949 行），資料落地使用者的 Google 試算表
- **部署鏈**：本機 git push → GitHub `chuhangching-oss/Hat-stock` (main) → Vercel 自動部署（兩個 Vercel 專案都會 build）
- **更新後端三步驟**（使用者手動做）：開 `https://raw.githubusercontent.com/chuhangching-oss/Hat-stock/main/backend/Code.gs` 全選複製 → Apps Script 完整覆蓋貼上儲存 → 管理部署作業 → ✏️ →「新版本」→ 等 1–2 分鐘（/exec 網址不變）

## 環境與常用指令（Windows / PowerShell）

- 本機 shell 用 `npm.cmd`（PowerShell 擋 npm.ps1）；git 在 `C:\Program Files\Git\cmd\git.exe`
- 前端編譯：`npm.cmd run build`
- 後端語法檢查：`Copy-Item backend\Code.gs $env:TEMP\code_check.js; node --check $env:TEMP\code_check.js`
- commit 訊息維持**單行簡潔**（多行中文＋特殊字元易 ParserError）
- push 後等 ~55 秒，再查 `https://api.github.com/repos/chuhangching-oss/Hat-stock/commits/<sha>/status` 確認 Vercel success
- 純前端修改 → 使用者手機要「完整刷新」（Chrome 開 hat-stock.vercel.app 載完 → 關掉主畫面版重開，PWA 快取問題）

## 帳務守則（很重要，使用者是 HC，重視帳務安全）

- 出庫整批原子性：任一品項不足整批擋；`force`（補帳模式）才放行負庫存，後端在該品項備註標「⚠️負庫存待盤」
- 所有 HC 刪改（出貨單刪改 `update_shipment`/`delete_shipment`、紀錄刪改 `correct_stock_log`）都寫稽核紀錄（type=更正/回補）留痕
- 刪除採兩段式保險（前端再按一次確認）
- 白名單：管理者 `ALLOWED_MANAGERS = ['HC','MAIN']`（前後端都要改，邏輯同步）

## 角色分權（2026-11 新增，`src/App.jsx` TABS 的 roles + `src/api.js`）

- **HC/MAIN**：全部 9 個分頁
- **ANDY**：＋生產工令、工單管理；**JL**：＋款式圖鑑
- **其他同事**：只有 庫存查詢／出入庫／出庫出貨／設定（4 頁）
- 身分判定＝App 內填的「經辦人」名字（相容 `02-ANDY`、`ANDY-組長` 格式）
- 「🩹 補帳模式」（負庫存）開關只給 HC/MAIN；「🧾 紀錄」分頁也僅管理者
- 存取碼流程：第一次進 App 必填（米字號遮蔽，對應後端 `API_TOKEN='GU3132'`）→ 存好即隱藏；後端換碼時請求回「存取碼錯誤」→ 前端自動清除已存值 → 設定頁重新出現輸入欄

## 近期已完成（commit 依序）

- `32c9b69`/`5b2bb59` HC 刪改出入庫紀錄 `correct_stock_log`（改數量回差額／刪列回補／改備註／各客份額解析提示）
- `d14d57e` 修復入庫新品項品號留空自動編號 A####（單筆 `recordLog_` 與批次 `batchStockTransaction_` 哨兵鍵 `#NEW#N`）
- `a30fc89` 帽型清單擴充 18 項（`src/constants.js` STYLE_CATEGORIES）＋新品項可批次入庫（ActionTab 雙出口：🛒 加入批次清單／單筆直送）
- `353d47a` 修復批次挑選跨搜尋勾選漏帶（BatchItemPicker `handleImport` 改收集全部勾選，不再只看當前篩選）＋ Enter 防呆
- `9e65fa8` 角色分權（見上節）
- `2d5f479` 存取碼首次必填、輸入後隱藏、換碼自動失效重輸
- 後端最後一次變更 = `d14d57e`（之後都是前端）

## 待辦／待使用者實測

- [ ] 使用者實測回報：批次入庫新品項、D1177W/S22D 補帳、JL 備註出庫 ✏️ 刪改
- [ ] README.md API 文件補 `correct_stock_log`（get/update/delete_shipment 已補）
- [ ] 若使用者要求：HC 出貨單管理加「新增明細列」功能（補錄漏掉的款式併進同張 SH 單）
- [ ] 客戶份額解析規則如有誤抓，修 `StockLogTab.jsx` 的 `rowQtyForCustomer`/`extractRemarkCustomers`

## 溝通慣例

- 使用者語言：繁體中文；「無誤」= 實測成功；改完要回報 commit sha + Vercel 狀態 + 是否需重貼 Code.gs
- 使用者非專業工程師：說明要口語、步驟化；帳務安全相關決策先解釋利弊

## 重灌後恢復開發環境

1. 安裝 Node.js LTS（https://nodejs.org）
2. 安裝 Git（https://git-scm.com）→ `git config --global user.name / user.email`
3. 安裝 OpenCode（https://opencode.ai）→ 登入 provider 帳號
4. 抓回專案：`git clone https://github.com/chuhangching-oss/Hat-stock.git`
5. 在專案資料夾（clone 後叫 `Hat-stock`）開 OpenCode，新對話說：「請先讀 HANDOFF.md，接續帽廠庫存系統開發」
6. `npm.cmd install`（重裝 node_modules）→ `npm.cmd run build` 驗證環境 OK
