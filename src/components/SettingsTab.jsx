import { useState } from 'react';
import {
  getGasUrl,
  setGasUrl,
  getOperator,
  setOperator,
  getToken,
  setToken,
  testConnection,
  isManager,
} from '../api';

/**
 * 分頁 3：設定
 * - Apps Script Web App 網址（存在手機 localStorage）
 * - 存取碼：🔒 已內建，僅 HC/MAIN 可查看／覆寫（一般使用者不顯示此欄）
 * - 經辦人預設姓名
 * - 連線測試
 */
export default function SettingsTab({ showToast, onSaved }) {
  const manager = isManager();
  const [url, setUrl] = useState(getGasUrl());
  const [name, setName] = useState(getOperator());
  const [token, setTok] = useState(getToken());
  const [showToken, setShowToken] = useState(false); // 存取碼遮蔽切換（僅 HC/MAIN）
  const [testing, setTesting] = useState(false);

  async function handleSave() {
    setGasUrl(url);
    setOperator(name);
    if (manager) setToken(token); // 一般人固定用內建存取碼，不寫入 localStorage
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
        {manager ? (
          <div>
            <label className="field-label">存取碼（對應後端 API_TOKEN；僅 HC/MAIN 可見）</label>
            <div className="flex gap-2">
              <input
                className="field-input flex-1"
                type={showToken ? 'text' : 'password'}
                placeholder="與後端 Code.gs 的 API_TOKEN 一致"
                value={token}
                onChange={(e) => setTok(e.target.value)}
              />
              <button
                onClick={() => setShowToken((s) => !s)}
                className="shrink-0 rounded-2xl bg-slate-100 px-4 text-lg transition active:bg-slate-200"
                aria-label={showToken ? '隱藏存取碼' : '顯示存取碼'}
              >
                {showToken ? '🙈' : '👁'}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              ★ 一般使用者的存取碼已內建，此欄只在後端輪替存取碼時才需要動。
            </p>
          </div>
        ) : (
          <div className="rounded-2xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
            🔒 存取碼已內建，無需設定（由管理者管理）
          </div>
        )}
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
