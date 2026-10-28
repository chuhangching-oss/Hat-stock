import { useState } from 'react';
import {
  getGasUrl,
  setGasUrl,
  getOperator,
  setOperator,
  getToken,
  setToken,
  testConnection,
} from '../api';

/**
 * 分頁 3：設定
 * - Apps Script Web App 網址（存在手機 localStorage）
 * - 存取碼（對應 Code.gs 的 API_TOKEN，未設可不填）
 * - 經辦人預設姓名
 * - 連線測試
 */
export default function SettingsTab({ showToast, onSaved }) {
  const [url, setUrl] = useState(getGasUrl());
  const [name, setName] = useState(getOperator());
  const [token, setTok] = useState(getToken());
  const [testing, setTesting] = useState(false);

  async function handleSave() {
    setGasUrl(url);
    setOperator(name);
    setToken(token);
    showToast('已儲存設定');
    setTesting(true);
    try {
      const data = await testConnection(getGasUrl());
      showToast(`✅ 連線成功！（後端 ${data.version}，現在可回「查詢/出入庫」分頁）`);
      onSaved && onSaved();
    } catch (e) {
      showToast(`❌ 連線失敗：${e.message}`, 'error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-3xl bg-white p-5 shadow-card">
        <div>
          <label className="field-label">Google Apps Script Web App 網址</label>
          <input
            className="field-input break-all font-mono text-sm"
            placeholder="https://script.google.com/macros/s/AKfy.../exec"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-400">
            ★ 網址必須以 <b>/exec</b> 結尾（不是 /dev）。下方部署教學有完整步驟。
          </p>
        </div>
        <div>
          <label className="field-label">存取碼（後端有設定 API_TOKEN 時才需填）</label>
          <input
            className="field-input"
            placeholder="後端 Code.gs 的 API_TOKEN，例：帽廠2026"
            value={token}
            onChange={(e) => setTok(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-400">
            ★ 建議與後端一起設定：網址外流時，沒有存取碼也無法讀寫庫存。
          </p>
        </div>
        <div>
          <label className="field-label">經辦人預設姓名（登記異動用）</label>
          <input
            className="field-input"
            placeholder="例：陳大明"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn-primary" onClick={handleSave} disabled={testing}>
          {testing && <span className="animate-spin">⟳</span>}
          {testing ? '測試連線中…' : '儲存並測試連線'}
        </button>
      </div>

      <details className="rounded-3xl bg-white p-5 shadow-card" open>
        <summary className="cursor-pointer text-lg font-extrabold">📖 後端部署小抄</summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm font-semibold leading-6 text-slate-600">
          <li>在 Google 試算表 ➔「擴充功能 ➔ Apps Script」，貼上專案 <code>backend/Code.gs</code> 全部內容。</li>
          <li>先手動執行一次函式 <code>setupSheets</code> 授權並建立兩張工作表。</li>
          <li>「部署 ➔ 新增部署作業 ➔ 網路應用程式」：執行身份＝我，存取權＝「任何人」。</li>
          <li>複製產生的網址（結尾 /exec），貼到上面輸入框 ➔ 儲存並測試連線。</li>
        </ol>
      </details>

      <details className="rounded-3xl bg-white p-5 shadow-card">
        <summary className="cursor-pointer text-lg font-extrabold">❓ 常見問題</summary>
        <div className="mt-3 space-y-3 text-sm font-semibold leading-6 text-slate-600">
          <p><b>相機開不了？</b>需 HTTPS 網站（Vercel/Cloudflare Pages 預設 https）。iOS 需在 Safari 允許相機權限。</p>
          <p><b>資料沒同步？</b>點右上角「⟳ 同步」。GAS 免費版偶爾冷啟動較慢（3~5 秒）。</p>
          <p><b>要重新授權？</b>若改了 Code.gs，需「部署 ➔ 管理部署作業 ➔ 編輯 ➔ 新版本」。</p>
        </div>
      </details>

      <p className="pb-4 text-center text-xs text-slate-400">
        Data 落地於你的 Google 試算表（INVENTORY_MASTER / STOCK_LOG）
      </p>
    </div>
  );
}
