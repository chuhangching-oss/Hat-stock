// ===== Google Apps Script (Web App) API 用戶端 =====
//
// 通訊協定：
//   前端以 HTTP POST（Content-Type: text/plain 以避免 CORS 預檢請求）
//   傳送 JSON 給 Apps Script 的 doPost，回應皆為
//   { ok: true, data: ... } 或 { ok: false, error: '...' }

const GAS_URL_KEY = 'kfi_gas_url';
const OPERATOR_KEY = 'kfi_operator';
const TOKEN_KEY = 'kfi_token';

export function getGasUrl() {
  return localStorage.getItem(GAS_URL_KEY) || '';
}

export function setGasUrl(url) {
  localStorage.setItem(GAS_URL_KEY, (url || '').trim());
}

/** 存取碼（與 Code.gs 的 API_TOKEN 相同時才可通） */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, (token || '').trim());
}

export function getOperator() {
  return localStorage.getItem(OPERATOR_KEY) || '';
}

export function setOperator(name) {
  localStorage.setItem(OPERATOR_KEY, (name || '').trim());
}

/** 🔐 營運報表白名單：僅限這些使用者代碼查看統計報表（商業機密）
 *  後端 Code.gs 的 ALLOWED_MANAGERS 需與此同步 */
export const ALLOWED_MANAGERS = ['HC', 'MAIN'];

/** 此使用者是否為管理者（可查看營運報表）。
 *  相容名冊格式「序號-姓名」（01-HC）與自填格式（HC、HC-老闆、老闆-HC…）：
 *  整串、去「數字-」前綴、'-' 前段/後段，任一段命中白名單即視為管理者。
 *  與後端 Code.gs 的 isManagerOp_() 邏輯同步，兩邊都要改。 */
export function isManager(name = getOperator()) {
  const t = String(name || '').trim().toUpperCase();
  if (!t) return false;
  const parts = t.split('-');
  const candidates = [
    t,
    t.replace(/^\d+-/, ''), // 01-HC → HC
    parts[0], // HC-王小明 → HC
    parts[parts.length - 1], // 王小明-HC → HC
  ];
  return ALLOWED_MANAGERS.some((m) => candidates.includes(m));
}

/**
 * 呼叫 GAS API
 * @param {string} gasUrl Apps Script Web App 執行網址 (.../exec)
 * @param {object} payload { action: 'list'|'log'|'ping'|'get', ... }
 * @param {number} timeoutMs
 */
export async function gasRequest(gasUrl, payload, timeoutMs = 30000) {
  if (!gasUrl) {
    throw new Error('尚未設定 API URL，請到「設定」頁貼上 Google Apps Script 網址');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 自動附加存取碼（Code.gs 端 checkToken_ 驗證）
  const body = { ...payload, token: getToken() };
  try {
    const res = await fetch(gasUrl, {
      method: 'POST',
      // text/plain 讓瀏覽器不發送 OPTIONS 預檢（Apps Script 不支援預檢）
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP 錯誤 ${res.status}，請確認 Web App 是否部署正確`);
    const json = await res.json();
    if (!json || json.ok !== true) {
      throw new Error((json && json.error) || 'API 回應格式錯誤');
    }
    return json.data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('連線逾時，請檢查網路或稍後再試');
    // 最常見問題：網址不是 .../exec，或是尚未「任何人」授權存取
    if (String(e.message).includes('Failed to fetch')) {
      throw new Error('無法連上 API（請確認網址以 /exec 結尾、部署權限為「任何人」）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 測試連線 */
export async function testConnection(gasUrl) {
  const data = await gasRequest(gasUrl, { action: 'ping' });
  return data;
}
