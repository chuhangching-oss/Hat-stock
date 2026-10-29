import { useCallback, useEffect, useState } from 'react';
import { gasRequest, getGasUrl, getOperator, isManager } from '../api';

const PERIODS = [
  { key: 'ALL', label: '全部' },
  { key: 'YEAR', label: '本年' },
  { key: 'MONTH', label: '本月' },
];

function fmtQty(n) {
  return Math.round(Number(n) * 100) / 100;
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * 分頁 5：營運統計報表（🔐 僅限管理者 HC / MAIN）
 * - 進入分頁即以目前經辦人身分請求後端（後端同樣白名單檢核，雙重防護）
 * - 非白名單：只顯示「無權限存取此報表」，不送任何請求、不顯示任何數據
 * - 內容：總營收 / 總出貨量 / 訂單數 / 客戶數 / 箱數 / 淨毛重
 *         ＋ 客戶採購業績金額排行（USD）＋ 款式銷售總量排行 Top 20
 */
export default function AnalyticsTab({ showToast }) {
  const [operator] = useState(() => getOperator());
  const allowed = isManager(operator);

  const [period, setPeriod] = useState('ALL');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (p) => {
      setLoading(true);
      setError('');
      try {
        const res = await gasRequest(getGasUrl(), {
          action: 'getSalesReport',
          operator: getOperator(),
          period: p,
        });
        setData(res);
      } catch (e) {
        setError(e.message);
        showToast(`❌ 報表載入失敗：${e.message}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    // 非管理者：完全不發請求
    if (allowed) load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchPeriod(p) {
    setPeriod(p);
    load(p);
  }

  // ===== 🔒 無權限畫面（一般使用者：隱藏所有敏感數據） =====
  if (!allowed) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-6xl">🔒</div>
        <h2 className="mt-4 text-xl font-extrabold text-red-600">
          無權限存取此報表
        </h2>
        <p className="mt-2 font-bold text-slate-600">
          僅限授權管理者（HC / MAIN）查閱
        </p>
        <p className="mt-4 rounded-2xl bg-slate-50 p-3 text-xs text-slate-400">
          目前身分：{operator.trim() || '未設定經辦人（請到「設定」分頁填寫）'}
          <br />
          營收、客戶採購金額與款式銷量屬核心商業機密，已由後端權限保護
        </p>
      </div>
    );
  }

  const maxCustAmount = data && data.customer_ranks.length > 0
    ? Math.max(...data.customer_ranks.map((c) => c.amount), 1)
    : 1;
  const maxStyleQty = data && data.style_ranks.length > 0
    ? Math.max(...data.style_ranks.map((s) => s.qty), 1)
    : 1;

  return (
    <div className="space-y-4">
      {/* ===== 期間切換 ＋ 重新載入 ===== */}
      <div className="flex items-center gap-2">
        <div className="grid flex-1 grid-cols-3 gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => switchPeriod(p.key)}
              className={`min-h-touch rounded-2xl text-base font-extrabold transition active:scale-95 ${
                period === p.key
                  ? 'bg-blue-700 text-white shadow-card'
                  : 'bg-white text-blue-700 ring-2 ring-blue-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => load(period)}
          disabled={loading}
          aria-label="重新載入報表"
          className="min-h-touch w-14 shrink-0 rounded-2xl bg-slate-700 text-2xl text-white transition active:bg-slate-800 active:scale-95 disabled:opacity-50"
        >
          <span className={loading ? 'inline-block animate-spin' : ''}>⟳</span>
        </button>
      </div>

      {error && (
        <div className="rounded-3xl bg-red-50 p-4 text-center text-sm font-bold text-red-600 shadow-card">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="rounded-3xl bg-white p-8 text-center shadow-card">
          <p className="animate-pulse font-bold text-slate-400">⏳ 統計載入中…</p>
        </div>
      )}

      {/* ===== 總覽統計卡 ===== */}
      {data && (
        <>
          <div className="rounded-3xl bg-gradient-to-br from-blue-700 to-blue-900 p-5 text-white shadow-card">
            <p className="text-xs font-bold text-blue-200">
              💰 總營收（{data.currency}）· {data.date_from} ~ {data.date_to}
            </p>
            <p className="mt-1 text-5xl font-black tabular-nums leading-none">
              {fmtMoney(data.total_revenue)}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-white/10 p-2">
                <p className="text-[10px] font-bold text-blue-200">出貨訂單</p>
                <p className="text-lg font-extrabold tabular-nums">{data.total_orders}</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-2">
                <p className="text-[10px] font-bold text-blue-200">出貨件數</p>
                <p className="text-lg font-extrabold tabular-nums">{fmtQty(data.total_pcs)}</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-2">
                <p className="text-[10px] font-bold text-blue-200">客戶數</p>
                <p className="text-lg font-extrabold tabular-nums">{data.total_customers}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <StatCard label="總箱數" value={fmtQty(data.total_cartons)} />
            <StatCard label="總淨重" value={`${fmtQty(data.total_nw)} kg`} />
            <StatCard label="總毛重" value={`${fmtQty(data.total_gw)} kg`} />
          </div>

          {/* ===== 客戶採購業績排行 ===== */}
          <div className="rounded-3xl bg-white p-5 shadow-card">
            <h3 className="text-base font-extrabold text-slate-900">
              🏆 客戶採購業績排行（USD）
            </h3>
            <p className="mt-0.5 text-xs font-bold text-slate-400">依採購金額降冪</p>
            <ul className="mt-3 space-y-3">
              {data.customer_ranks.map((c, i) => (
                <li key={c.customer_name}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-extrabold text-slate-800">
                      <span
                        className={`mr-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-black ${
                          i === 0
                            ? 'bg-amber-400 text-amber-900'
                            : i === 1
                              ? 'bg-slate-300 text-slate-700'
                              : i === 2
                                ? 'bg-orange-200 text-orange-800'
                                : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {i + 1}
                      </span>
                      {c.customer_name}
                      {c.country && <span className="ml-1 text-xs text-slate-400">{c.country}</span>}
                    </span>
                    <span className="shrink-0 font-black tabular-nums text-blue-700">
                      ${fmtMoney(c.amount)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-blue-600"
                      style={{ width: `${Math.max((c.amount / maxCustAmount) * 100, 2)}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-xs font-bold text-slate-400">
                    {c.orders} 張單 · {fmtQty(c.pcs)} PCS
                    {c.cartons > 0 && ` · ${fmtQty(c.cartons)} 箱`}
                  </p>
                </li>
              ))}
              {data.customer_ranks.length === 0 && (
                <li className="py-4 text-center text-sm font-bold text-slate-400">
                  此期間尚無出貨單
                </li>
              )}
            </ul>
          </div>

          {/* ===== 款式銷售排行 ===== */}
          <div className="rounded-3xl bg-white p-5 shadow-card">
            <h3 className="text-base font-extrabold text-slate-900">
              🧢 款式銷售總量排行 Top 20
            </h3>
            <p className="mt-0.5 text-xs font-bold text-slate-400">
              依出貨數量降冪（金額單位：{data.currency}）
            </p>
            <ul className="mt-3 space-y-2.5">
              {data.style_ranks.map((s, i) => (
                <li key={s.item_code}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-bold text-slate-800">
                      <span className="mr-1.5 text-xs font-black text-slate-400">#{i + 1}</span>
                      {s.style_no || s.item_code}
                      {s.color_spec && <span className="text-slate-500">（{s.color_spec}）</span>}
                    </span>
                    <span className="shrink-0 font-black tabular-nums text-slate-800">
                      {fmtQty(s.qty)} PCS
                      {s.amount > 0 && (
                        <span className="ml-1.5 text-xs font-bold text-blue-600">
                          ${fmtMoney(s.amount)}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.max((s.qty / maxStyleQty) * 100, 2)}%` }}
                    />
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-slate-400">{s.item_code}</p>
                </li>
              ))}
              {data.style_ranks.length === 0 && (
                <li className="py-4 text-center text-sm font-bold text-slate-400">
                  此期間尚無出貨明細
                </li>
              )}
            </ul>
          </div>

          <p className="px-1 pb-2 text-[10px] leading-5 text-slate-400">
            🔐 統計來源：SHIPMENT_ORDERS ＋ SHIPMENT_DETAILS。本報表僅限管理者查閱，
            後端已對非白名單（HC / MAIN 以外）身分直接拒絕回應。
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-3xl bg-white p-3 text-center shadow-card">
      <p className="text-[10px] font-bold text-slate-400">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums text-slate-800">{value}</p>
    </div>
  );
}
