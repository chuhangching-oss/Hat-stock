import { useMemo, useState } from 'react';
import { getGasUrl } from '../api';
import { WO_STATUS_COLORS } from '../constants';

function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
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
 * 分頁：🧾 異動記錄（STOCK_LOG 檢索）
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
    return logs.filter((l) => {
      if (type !== '全部' && l.type !== type) return false;
      const d = String(l.timestamp || '').slice(0, 10);
      if (range.from && d && d < range.from) return false;
      if (range.to && d && d > range.to) return false;
      if (!f) return true;
      return `${l.item_code} ${l.item_name} ${l.color_spec} ${l.operator} ${l.remark} ${l.log_id}`
        .toLowerCase()
        .includes(f);
    });
  }, [logs, type, range, keyword]);

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
      const d = String(l.timestamp || '').slice(0, 10) || '（無日期）';
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
          <h2 className="text-lg font-extrabold text-slate-900">🧾 異動記錄</h2>
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
                      {l.item_code} · {String(l.timestamp).slice(11)} · {l.operator || '—'}
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
