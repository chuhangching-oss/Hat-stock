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
