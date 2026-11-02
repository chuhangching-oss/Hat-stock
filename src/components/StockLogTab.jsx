import { useEffect, useMemo, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';
import { WO_STATUS_COLORS } from '../constants';

function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/** Timestamp → 'YYYY-MM-DD'：
 *  - Google Sheets 會把「2026-10-29 14:50:30」自動轉成日期型值，
 *    讀回來變 'Wed Oct 29 2026 14:50:30 GMT+0800…' 兩種格式都要能解析 */
function parseYMD(ts) {
  const s = String(ts || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return '';
}

/** Timestamp → 'HH:mm'（分組內顯示用） */
function parseHM(ts) {
  const s = String(ts || '').trim();
  let m = s.match(/^\d{4}-\d{2}-\d{2}[ T](\d{1,2}:\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return ''; // 解析失敗就不顯示時間
}

/** Timestamp → 可排序字串 'YYYY-MM-DD HH:mm:ss'（兩種格式皆可） */
function tsKey(ts) {
  const s = String(ts || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return '';
}

/** 從出庫備註萃取客戶名稱（兩種現場寫法）：
 *  ①「VF出貨25頂 …」→ 名稱在「出貨」之前
 *  ②「10/30出鎮群4頂」→ 名稱在「出」之後、數量之前
 *  萃取後剔除誤抓字（貨/庫/群 等） */
const CUST_STOPWORDS = new Set(['貨', '庫', '群', '入', '出', '完']);
function extractRemarkCustomers(logs) {
  const found = new Map();
  (logs || []).forEach((l) => {
    if (l.type !== '出庫') return;
    const rm = String(l.remark || '');
    let m;
    const re1 = /([A-Za-z\u4e00-\u9fff]{1,10})出貨/g;
    while ((m = re1.exec(rm))) {
      const name = m[1];
      if (name && !CUST_STOPWORDS.has(name)) found.set(name.toUpperCase(), name);
    }
    const re2 = /出([A-Za-z\u4e00-\u9fff]{1,10}?)(?=[0-9])/g;
    while ((m = re2.exec(rm))) {
      const name = m[1];
      if (name && !CUST_STOPWORDS.has(name)) found.set(name.toUpperCase(), name);
    }
  });
  return [...found.values()];
}

// 類型 chips 設定（異動記錄 Type 只會有三種值）
const TYPE_TAGS = [
  { key: '全部', icon: '', color: 'bg-blue-700 text-white' },
  { key: '入庫', icon: '📥', color: 'bg-emerald-600 text-white' },
  { key: '出庫', icon: '📤', color: 'bg-red-600 text-white' },
  { key: '盤點', icon: '🧮', color: 'bg-amber-600 text-white' },
];

// 日期區間快速鍵
const PERIOD_TAGS = ['全部', '今日', '近7天', '近30天'];

/**
 * 分頁：🧾 紀錄（檢索出入庫紀錄，STOCK_LOG 檢索）
 * - 關鍵字：品號 / 品名 / 顏色 / 經辦 / 備註 任一欄命中
 * - 類型篩選：全部 / 入庫 / 出庫 / 盤點
 * - 日期區間：全部 / 今日 / 近7天 / 近30天
 * - 依日期分組顯示（由新到舊），每列顯示 ±數量 / 經辦 / 備註
 * - 頂部統計：篩選範圍內的入庫 / 出庫合計件數
 * - 資料為最近 1000 筆（更舊的請直接看 Google 試算表 STOCK_LOG）
 */
export default function StockLogTab({ logs, loading, error, refresh, showToast }) {
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState('全部');
  const [period, setPeriod] = useState('全部');
  const [customer, setCustomer] = useState('全部');
  const [customers, setCustomers] = useState([]); // 客戶表＋歷史出貨單彙整（客戶篩選下拉用）

  // 客戶候選來源＝客戶清單（CUSTOMERS）＋歷史出貨單出現過的客戶（SHIPMENT_ORDERS）
  // 任一來源讀不到不影響本頁
  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      gasRequest(getGasUrl(), { action: 'list_customers' }),
      gasRequest(getGasUrl(), { action: 'list_shipments' }),
    ]).then(([custRes, shipRes]) => {
      if (!alive) return;
      const byName = new Map();
      const add = (name, country = '') => {
        const key = String(name || '').trim().toUpperCase();
        if (key && !byName.has(key)) byName.set(key, { customer_id: key, customer_name: String(name).trim(), country });
      };
      if (custRes.status === 'fulfilled' && Array.isArray(custRes.value)) {
        custRes.value.forEach((c) => add(c.customer_name, c.country || ''));
      }
      if (shipRes.status === 'fulfilled' && Array.isArray(shipRes.value)) {
        shipRes.value.forEach((s) => add(s.customer_name));
      }
      setCustomers([...byName.values()]);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 最終下拉選項＝客戶表＋出貨單客戶＋【從出庫備註自動萃取的客戶】（VF / 鎮群…）
  const custOptions = useMemo(() => {
    const byName = new Map(customers.map((c) => [c.customer_id, c]));
    extractRemarkCustomers(logs).forEach((name) => {
      const key = name.toUpperCase();
      if (!byName.has(key)) byName.set(key, { customer_id: key, customer_name: name, country: '' });
    });
    return [...byName.values()].sort((a, b) => a.customer_name.localeCompare(b.customer_name, 'zh-Hant'));
  }, [customers, logs]);

  // ⏳ 排序修正：Google Sheets 會把 Timestamp 轉成日期型（字串變英文月份），
  // 直接字串排序會把舊的排前面 → 一律解析成可排序鍵再由新到舊
  const sortedLogs = useMemo(
    () =>
      [...logs].sort((a, b) => {
        const ka = tsKey(a.timestamp);
        const kb = tsKey(b.timestamp);
        if (ka && kb) return String(kb).localeCompare(String(ka));
        if (ka) return -1; // 解析失敗的排最後
        if (kb) return 1;
        return 0;
      }),
    [logs],
  );

  if (!getGasUrl()) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-5xl">⚙️</div>
        <h2 className="mt-4 text-xl font-extrabold">尚未設定雲端 API</h2>
        <p className="mt-2 text-slate-500">請先到「設定」分頁貼上 Apps Script 網址。</p>
      </div>
    );
  }

  /** 日期範圍（含起訖）：{ from:'YYYY-MM-DD'|'', to:'' }，'' = 不限 */
  const range = useMemo(() => {
    const today = new Date();
    const ymd = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (period === '今日') {
      const t = ymd(today);
      return { from: t, to: t };
    }
    const days = period === '近7天' ? 7 : period === '近30天' ? 30 : 0;
    if (!days) return { from: '', to: '' };
    const from = new Date(today);
    from.setDate(today.getDate() - (days - 1));
    return { from: ymd(from), to: '' };
  }, [period]);

  const filtered = useMemo(() => {
    const f = keyword.trim().toLowerCase();
    const cust = customer === '全部' ? '' : customer.trim().toLowerCase();
    return sortedLogs.filter((l) => {
      if (type !== '全部' && l.type !== type) return false;
      const d = parseYMD(l.timestamp);
      if (range.from && d && d < range.from) return false;
      if (range.to && d && d > range.to) return false;
      // 客戶篩選：比對備註（出庫紀錄備註格式＝「出貨 SH… ／ 客戶名；…」）
      if (cust) {
        const hit =
          String(l.remark || '').toLowerCase().includes(cust) ||
          String(l.item_name || '').toLowerCase().includes(cust);
        if (!hit) return false;
      }
      if (!f) return true;
      return `${l.item_code} ${l.item_name} ${l.color_spec} ${l.operator} ${l.remark} ${l.log_id}`
        .toLowerCase()
        .includes(f);
    });
  }, [sortedLogs, type, range, keyword, customer]);

  // 篩選範圍內合計（依正負值分加總；盤點 ± 都算進去）
  const sum = useMemo(() => {
    let plus = 0;
    let minus = 0;
    filtered.forEach((l) => {
      const q = Number(l.change_qty) || 0;
      if (q > 0) plus += q;
      else if (q < 0) minus += -q;
    });
    return { plus, minus };
  }, [filtered]);

  /** 依日期分組（filtered 已由新到舊） */
  const groups = useMemo(() => {
    const out = [];
    let cur = null;
    filtered.forEach((l) => {
      const d = parseYMD(l.timestamp) || '（無日期）';
      if (!cur || cur.date !== d) {
        cur = { date: d, rows: [] };
        out.push(cur);
      }
      cur.rows.push(l);
    });
    return out;
  }, [filtered]);

  return (
    <div className="space-y-3">
      {/* ===== 標題列 ===== */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900">🔍 檢索出入庫紀錄</h2>
          <p className="text-xs font-bold text-slate-400">
            共 {filtered.length} 筆（最近 {logs.length} 筆範圍內）
          </p>
        </div>
        <button
          onClick={() => refresh().then((l) => showToast(`⟳ 已更新異動記錄（${l.length} 筆）`))}
          disabled={loading}
          className="shrink-0 rounded-2xl bg-slate-700 px-3 py-2 text-xs font-extrabold text-white shadow-card transition active:bg-slate-800 active:scale-95 disabled:opacity-50"
        >
          ⟳ 更新
        </button>
      </div>

      {error && (
        <div className="rounded-3xl bg-white p-4 text-center text-sm font-bold text-red-600 shadow-card">
          ❌ {error}
        </div>
      )}

      {/* ===== 篩選器 ===== */}
      <div className="space-y-2 rounded-3xl bg-white p-4 shadow-card">
        <input
          className="field-input"
          placeholder="搜尋：品號 / 品名 / 顏色 / 經辦 / 備註"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        {/* 客戶篩選（客戶表＋歷史出貨單＋備註自動萃取，有候選才顯示） */}
        {custOptions.length > 0 && (
          <select
            className="field-input"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          >
            <option value="全部">客戶：全部（{custOptions.length} 家）</option>
            {custOptions.map((c) => (
              <option key={c.customer_id} value={c.customer_name}>
                {c.customer_name}
                {c.country ? `（${c.country}）` : ''}
              </option>
            ))}
          </select>
        )}
        <div className="flex flex-wrap gap-1.5">
          {TYPE_TAGS.map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-extrabold transition active:scale-95 ${
                type === t.key ? `${t.color} shadow-card` : 'bg-slate-100 text-slate-600'
              }`}
            >
              {t.icon && `${t.icon} `}
              {t.key}
            </button>
          ))}
        </div>
        {custOptions.length === 0 && (
          <p className="px-1 text-[10px] font-bold text-slate-400">
            💡 想用「客戶」篩選：先在「出庫出貨」分頁建立／出貨選客戶——出過貨的客戶會自動出現在篩選下拉
          </p>
        )}
        <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
          {PERIOD_TAGS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-full px-3 py-1 text-xs font-extrabold transition active:scale-95 ${
                period === p ? 'bg-slate-800 text-white shadow-card' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        {/* 範圍內合計 */}
        <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2 text-xs font-extrabold">
          <span className="text-emerald-700">📥 入庫 +{fmtQty(sum.plus)}</span>
          <span className="text-red-700">📤 出庫 −{fmtQty(sum.minus)}</span>
        </div>
      </div>

      {/* ===== 載入中 ===== */}
      {loading && logs.length === 0 && (
        <div className="rounded-3xl bg-white p-8 text-center shadow-card">
          <p className="animate-pulse font-bold text-slate-400">⏳ 異動記錄載入中…</p>
        </div>
      )}

      {/* ===== 依日期分組的記錄列表 ===== */}
      {groups.map((g) => (
        <div key={g.date} className="overflow-hidden rounded-3xl bg-white shadow-card">
          <div className="flex items-baseline justify-between bg-slate-50 px-4 py-2">
            <b className="text-sm text-slate-700">{g.date}</b>
            <span className="text-[11px] font-bold text-slate-400">{g.rows.length} 筆</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {g.rows.map((l) => {
              const q = Number(l.change_qty) || 0;
              const plus = q > 0;
              const typeCls =
                l.type === '入庫' ? WO_STATUS_COLORS['已入庫'] : l.type === '盤點' ? WO_STATUS_COLORS['待確認'] : 'bg-red-100 text-red-700';
              return (
                <li key={l.log_id} className="flex items-start gap-3 px-4 py-2.5">
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${typeCls}`}>
                    {l.type}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-extrabold text-slate-800">
                      {l.item_name}
                      {l.color_spec && <span className="text-slate-500">（{l.color_spec}）</span>}
                    </p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {l.item_code} · {parseHM(l.timestamp)} · {l.operator || '—'}
                    </p>
                    {l.remark && (
                      <p className="truncate text-[11px] font-bold text-slate-500">📝 {l.remark}</p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-base font-black tabular-nums ${
                      plus ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {plus ? '+' : '−'}
                    {fmtQty(Math.abs(q))} {l.unit}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {!loading && filtered.length === 0 && error === '' && (
        <div className="rounded-3xl bg-white p-6 text-center text-sm font-bold text-slate-400 shadow-card">
          此篩選條件下沒有任何異動記錄
        </div>
      )}

      <p className="px-2 pb-2 text-center text-[10px] font-bold text-slate-400">
        顯示最近 1000 筆內的記錄；更舊的記錄請直接在 Google 試算表「STOCK_LOG」工作表查看
      </p>
    </div>
  );
}
