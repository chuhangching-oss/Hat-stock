import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORY_COLORS } from '../constants';
import { gasRequest, getGasUrl, getOperator } from '../api';

const MONTH_OPTIONS = [3, 6, 12];

function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * 🧹 品項健檢（HC / MAIN / ANDY / JL）：
 * 列出「逾 N 個月沒有任何出入庫異動」的品項（判斷以最後異動日為準，跟庫存量無關），
 * 讓管理人逐一勾選：🗄️ 封存（不出現在批次挑選／掃碼，資料保留可解封）或保留。
 * 資料源：list_dormant（後端掃整份 STOCK_LOG ＋ 主檔組裝）
 */
export default function HygieneTab({ showToast }) {
  const [months, setMonths] = useState(6);
  const [data, setData] = useState(null); // { cutoff, months, total, items }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState(new Set()); // 勾選待封存的品號
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (m = months) => {
      setLoading(true);
      setError('');
      setChecked(new Set());
      try {
        const res = await gasRequest(getGasUrl(), {
          action: 'list_dormant',
          months: m,
          operator: getOperator(),
        });
        setData(res || { cutoff: '', months: m, total: 0, items: [] });
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [months],
  );

  useEffect(() => {
    load(6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = data?.items || [];
  const candidates = useMemo(() => items.filter((it) => it.active !== false), [items]);
  const archived = useMemo(() => items.filter((it) => it.active === false), [items]);

  const filtered = useMemo(() => {
    const t = query.trim().toLowerCase();
    const hit = (it) =>
      !t ||
      [it.item_code, it.item_name, it.color_spec, it.location]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(t);
    return { candidates: candidates.filter(hit), archived: archived.filter(hit) };
  }, [query, candidates, archived]);

  function toggleCheck(code) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  const toggleAllVisible = () => {
    // 全選／全不選（只對畫面上看得見的未封存品項）
    const visible = filtered.candidates.map((it) => String(it.item_code).trim().toUpperCase());
    const allOn = visible.every((c) => checked.has(c));
    setChecked((prev) => {
      const next = new Set(prev);
      visible.forEach((c) => (allOn ? next.delete(c) : next.add(c)));
      return next;
    });
  };

  /** 批次封存勾選品項（後端只改 Active 欄，不刪資料） */
  async function handleArchive() {
    if (busy) return;
    if (checked.size === 0) return showToast('❌ 請先勾選要封存的品項', 'error');
    setBusy(true);
    try {
      const res = await gasRequest(getGasUrl(), {
        action: 'set_items_active',
        item_codes: Array.from(checked),
        active: 'N',
        operator: getOperator(),
      });
      showToast(
        `🗄️ 已封存 ${res.updated} 項` +
          (res.not_found?.length ? `（${res.not_found.length} 項品號找不到：${res.not_found.join('、')}）` : ''),
      );
      await load(months);
    } catch (e) {
      showToast(`❌ 封存失敗：${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 單筆解封（封存清單每列的 ↩️） */
  async function handleUnarchive(code) {
    if (busy) return;
    setBusy(true);
    try {
      await gasRequest(getGasUrl(), {
        action: 'set_items_active',
        item_codes: [code],
        active: 'Y',
        operator: getOperator(),
      });
      showToast(`↩️ 已解封：${code}（挑選／掃碼清單恢復出現）`);
      await load(months);
    } catch (e) {
      showToast(`❌ 解封失敗：${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-28">
      {/* ===== 標題說明 ===== */}
      <div className="rounded-3xl bg-white p-5 shadow-card">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-xl font-extrabold text-slate-900">🧹 品項健檢</h2>
          <button
            onClick={() => load(months)}
            disabled={loading}
            className="min-h-touch shrink-0 rounded-xl bg-slate-100 px-3 text-sm font-bold text-slate-700 transition active:bg-slate-200 disabled:opacity-50"
          >
            {loading ? '⟳ 檢查中…' : '🔁 重新檢查'}
          </button>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          找出超過一段時間<strong>沒有任何出入庫異動</strong>的品項（判斷以最後異動日為準，跟現在庫存無關）。
          選定後「<strong>🗄️ 封存</strong>」——品項會從批次挑選／掃碼清單消失，
          但<strong>資料完全保留、隨時可解封</strong>，歷史紀錄與出貨單不受影響。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-500">閒置判定：</span>
          {MONTH_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => {
                setMonths(m);
                load(m);
              }}
              className={`rounded-full px-3 py-1 text-xs font-extrabold transition active:scale-95 ${
                months === m ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {m} 個月
            </button>
          ))}
          {data?.cutoff && (
            <span className="text-xs text-slate-400">
              （最後異動日早於 {data.cutoff} 共 {data?.total} 項）
            </span>
          )}
        </div>
        <input
          className="field-input mt-3"
          placeholder="🔍 搜尋品號／品名／顏色／儲位（選填）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && (
          <div className="mt-3 rounded-2xl bg-red-50 p-3 text-sm font-bold text-red-600">{error}</div>
        )}
      </div>

      {/* ===== 待檢視清單 ===== */}
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between px-1">
          <p className="text-xs font-bold text-slate-400">
            待檢視 {filtered.candidates.length} 項（勾選後按底部「封存」）
          </p>
          <button
            onClick={toggleAllVisible}
            className="text-xs font-extrabold text-blue-700 transition active:scale-95"
          >
            ☑️ 全選／全不選
          </button>
        </div>

        {filtered.candidates.map((it) => {
          const code = String(it.item_code).trim().toUpperCase();
          const isOn = checked.has(code);
          const catCls = CATEGORY_COLORS[it.category] || 'bg-slate-100 text-slate-600';
          return (
            <label
              key={it.item_code}
              className={`flex cursor-pointer items-center gap-3 rounded-2xl p-3 shadow-card transition ${
                isOn ? 'bg-blue-50 ring-2 ring-blue-400' : 'bg-white ring-1 ring-slate-100'
              }`}
            >
              <input
                type="checkbox"
                checked={isOn}
                onChange={() => toggleCheck(code)}
                className="h-5 w-5 shrink-0 accent-blue-700"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">{it.item_code}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${catCls}`}>
                    {it.category || '未分類'}
                  </span>
                </div>
                <h3 className="mt-0.5 truncate text-base font-extrabold text-slate-900">
                  {it.item_name}
                  {it.color_spec && <span className="font-semibold text-slate-500">（{it.color_spec}）</span>}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  在庫 {fmtQty(it.stock_qty)} {it.unit}
                  {it.location ? ` · 📍${it.location}` : ''} · 最後異動：
                  {it.last_activity || '（查無異動紀錄）'}
                  {it.days_idle !== null ? `（已閒置 ${it.days_idle} 天）` : ''}
                </p>
              </div>
            </label>
          );
        })}

        {filtered.candidates.length === 0 && !loading && !error && (
          <div className="rounded-3xl bg-white p-5 text-center text-sm text-slate-400">
            🎉 沒有超過 {months} 個月未異動的品項（或已被你封存完畢）
          </div>
        )}
      </div>

      {/* ===== 已封存清單（可解封） ===== */}
      {filtered.archived.length > 0 && (
        <div className="mt-6">
          <p className="px-1 text-xs font-bold text-slate-400">
            已封存 {filtered.archived.length} 項（不出現在挑選／掃碼；按 ↩️ 解封）
          </p>
          <div className="mt-2 space-y-2">
            {filtered.archived.map((it) => (
              <div
                key={it.item_code}
                className="flex items-center gap-3 rounded-2xl bg-slate-100 p-3"
              >
                <span className="text-lg">🗄️</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">{it.item_code}</span>
                    <span className="rounded-full bg-slate-300 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                      已封存
                    </span>
                  </div>
                  <h3 className="mt-0.5 truncate text-sm font-extrabold text-slate-600">
                    {it.item_name}
                    {it.color_spec && <span className="font-semibold text-slate-400">（{it.color_spec}）</span>}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    在庫 {fmtQty(it.stock_qty)} {it.unit} · 最後異動：{it.last_activity || '（查無）'}
                  </p>
                </div>
                <button
                  onClick={() => handleUnarchive(String(it.item_code).trim().toUpperCase())}
                  disabled={busy}
                  className="min-h-touch shrink-0 rounded-xl bg-white px-3 text-sm font-extrabold text-emerald-700 shadow-card transition active:bg-emerald-50 active:scale-95 disabled:opacity-50"
                >
                  ↩️ 解封
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== Sticky 封存列 ===== */}
      {candidates.length > 0 && (
        <div
          className="fixed inset-x-0 z-20 mx-auto max-w-lg px-4"
          style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}
        >
          <div className="rounded-3xl bg-white p-3 shadow-card ring-2 ring-slate-300">
            <div className="flex items-center justify-between px-1 text-sm font-extrabold text-slate-700">
              <span>
                已勾選：<b className="text-lg text-blue-700">{checked.size}</b> 項
              </span>
              <span className="text-xs font-semibold text-slate-400">封存不刪除、可解封</span>
            </div>
            <button
              className={`btn-primary mt-2 ${checked.size === 0 || busy ? 'opacity-40' : ''}`}
              onClick={handleArchive}
            >
              {busy ? '處理中…' : `🗄️ 封存勾選 ${checked.size} 項（從挑選／掃碼隱藏）`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
