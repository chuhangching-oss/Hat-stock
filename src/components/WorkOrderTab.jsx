import { useMemo, useState } from 'react';
import { WO_STATUS_COLORS } from '../constants';
import { getGasUrl, getOperator } from '../api';
import ConfirmDialog from './ConfirmDialog';

const DESTS = [
  {
    key: '入倉庫',
    label: '📥 入倉庫',
    activeCls: 'bg-emerald-600 text-white shadow-card',
    inactiveCls: 'bg-white text-emerald-600 ring-2 ring-emerald-600',
  },
  {
    key: '訂單出貨',
    label: '🚚 訂單出貨',
    activeCls: 'bg-orange-500 text-white shadow-card',
    inactiveCls: 'bg-white text-orange-500 ring-2 ring-orange-500',
  },
];

const EMPTY_DRAFT = {
  style_no: '',
  plan_qty: '',
  due_date: '',
  destination: '入倉庫',
  order_ref: '',
};

/** 狀態排序權重（生產中在最上） */
const STATUS_ORDER = { 生產中: 0, 待確認: 1, 待出貨: 2, 已入庫: 3, 已出貨: 4 };

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 小數最多顯示 4 位（0.09×330 之類的浮點誤差） */
function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * 分頁 3：工單管理（工作令連動與入庫）
 * - 開立工作令：Style_No + 數量 → 即時依 BOM_MASTER 試算所需原料
 * - Destination：入倉庫（完工入庫）/ 訂單出貨（完工後待出貨）
 * - 確認完工：輸入實際良品數 → 一鍵成品入庫＋BOM 扣料＋結案
 * - 到期（含今日到期）工作令紅色警示；逾期的由後端每日觸發轉為待確認
 */
export default function WorkOrderTab({
  wos,
  items,
  loading,
  error,
  showToast,
  onCreateWO,
  onCompleteWO,
  onShipWO,
  bomFor,
  onRefresh,
  goToSettings,
}) {
  // ===== 開立工作令 =====
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [createConfirmOpen, setCreateConfirmOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [styleFilter, setStyleFilter] = useState('');

  // ===== 清單搜尋 =====
  const [filter, setFilter] = useState('');

  // ===== 確認完工 =====
  const [completing, setCompleting] = useState(null); // 正在完工的工作令
  const [cActual, setCActual] = useState('');
  const [cTarget, setCTarget] = useState(null); // 入庫料號（入倉庫時必選）
  const [cTargetFilter, setCTargetFilter] = useState('');
  const [cPickerOpen, setCPickerOpen] = useState(false);
  const [cUseBom, setCUseBom] = useState(true);
  const [cOperator, setCOperator] = useState(() => getOperator());
  const [cRemark, setCRemark] = useState('');
  const [completeBusy, setCompleteBusy] = useState(false);

  // ===== 登記已出貨 =====
  const [shipWo, setShipWo] = useState(null);
  const [shipBusy, setShipBusy] = useState(false);

  const today = todayYMD();
  const itemsByKey = useMemo(
    () => new Map(items.map((it) => [it.item_code, it])),
    [items],
  );

  /** 本分頁的到期清單（生產中/待確認 且 due <= 今天） */
  const dueWos = useMemo(
    () =>
      wos
        .filter(
          (w) =>
            (w.status === '生產中' || w.status === '待確認') &&
            w.due_date &&
            w.due_date <= today,
        )
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))),
    [wos, today],
  );

  /** 排序：生產中 → 待確認 → 待出貨 → 已入庫 → 已出貨；同狀態按到期日近的在前 */
  const sortedWos = useMemo(() => {
    return [...wos].sort((a, b) => {
      const oa = STATUS_ORDER[a.status] ?? 9;
      const ob = STATUS_ORDER[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      const da = a.due_date || '9999-99-99';
      const db = b.due_date || '9999-99-99';
      if (da !== db) return da.localeCompare(db);
      return String(a.wo_id).localeCompare(String(b.wo_id));
    });
  }, [wos]);

  const filteredWos = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return sortedWos;
    return sortedWos.filter((w) =>
      `${w.wo_id} ${w.style_no} ${w.order_ref} ${w.status} ${w.destination}`.toLowerCase().includes(f),
    );
  }, [sortedWos, filter]);

  const counts = useMemo(() => {
    const c = { 生產中: 0, 待確認: 0, 待出貨: 0 };
    wos.forEach((w) => {
      if (c[w.status] !== undefined) c[w.status]++;
    });
    return c;
  }, [wos]);

  // 開立表單：BOM 試算
  const draftQty = Number(draft.plan_qty) || 0;
  const draftBom = bomFor(draft.style_no);

  // 完工彈窗：BOM 試算
  const cActualNum = Number(cActual);
  const cActualValid = isFinite(cActualNum) && cActualNum >= 0;
  const cBomRows = completing ? bomFor(completing.style_no) : [];
  /** 是否有原料扣完會變負庫存（-> 彈窗轉紅色警示） */
  const cShortage = cBomRows.some((b) => {
    if (!cUseBom || !cActualValid) return false;
    const stock = itemsByKey.get(b.item_code)?.stock_qty;
    return typeof stock === 'number' && stock - Number(b.unit_use) * cActualNum < 0;
  });

  // 完工彈窗：目標料號候選（預設只列成品；輸入關鍵字即搜尋全部）
  const targetOptions = useMemo(() => {
    const f = cTargetFilter.trim().toLowerCase();
    return items
      .filter((it) => {
        if (!f) return it.category === '成品' || !it.category;
        return `${it.item_name} ${it.color_spec} ${it.item_code} ${it.category}`.toLowerCase().includes(f);
      })
      .slice(0, 200);
  }, [items, cTargetFilter]);

  // 開立表單：款式候選（品名去重）
  const styleOptions = useMemo(() => {
    const seen = new Map();
    items.forEach((it) => {
      const n = String(it.item_name || '').trim();
      if (n && !seen.has(n)) {
        seen.set(n, { name: n, category: it.category, color: it.color_spec });
      }
    });
    const f = styleFilter.trim().toLowerCase();
    return [...seen.values()]
      .filter((s) => {
        if (!f) return true;
        return `${s.name} ${s.category} ${s.color}`.toLowerCase().includes(f);
      })
      .slice(0, 200);
  }, [items, styleFilter]);

  function openCreateForm() {
    setDraft(EMPTY_DRAFT);
    setFormOpen(true);
  }

  const setDraftField = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  function handleOpenCreateConfirm() {
    if (!draft.style_no.trim()) return showToast('❌ 請填寫款號 Style_No', 'error');
    if (!(draftQty > 0)) return showToast('❌ 計畫數量必須大於 0', 'error');
    if (!draft.due_date) return showToast('❌ 請選擇預計完工日', 'error');
    setCreateConfirmOpen(true);
  }

  async function handleCreateConfirm() {
    setCreateBusy(true);
    try {
      await onCreateWO({
        style_no: draft.style_no.trim(),
        plan_qty: draftQty,
        due_date: draft.due_date,
        destination: draft.destination,
        order_ref: draft.order_ref.trim(),
      });
      setCreateConfirmOpen(false);
      setFormOpen(false);
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      /* 失敗：保持彈窗，錯誤已由 Toast 顯示 */
    } finally {
      setCreateBusy(false);
    }
  }

  function openComplete(wo) {
    setCompleting(wo);
    setCActual(String(wo.plan_qty));
    setCTarget(null);
    setCTargetFilter('');
    setCPickerOpen(false);
    setCUseBom(true);
    setCOperator(getOperator());
    setCRemark('');
  }

  function closeComplete() {
    if (completeBusy) return;
    setCompleting(null);
  }

  async function handleCompleteConfirm() {
    const wo = completing;
    if (!wo) return;
    if (wo.destination === '入倉庫' && !cTarget) {
      return showToast('❌ 請選擇成品入庫料號', 'error');
    }
    if (!cActualValid) return showToast('❌ 實際良品數格式錯誤（不可為負數）', 'error');
    if (!cOperator.trim()) return showToast('❌ 請填寫經辦人姓名', 'error');
    setCompleteBusy(true);
    try {
      await onCompleteWO({
        wo_id: wo.wo_id,
        actual_qty: cActualNum,
        target_item_code: wo.destination === '入倉庫' ? cTarget.item_code : '',
        use_bom: cUseBom && cBomRows.length > 0,
        operator: cOperator.trim(),
        remark: cRemark.trim(),
      });
      setCompleting(null);
    } catch (e) {
      /* 失敗：保持彈窗，錯誤已由 Toast 顯示 */
    } finally {
      setCompleteBusy(false);
    }
  }

  async function handleShipConfirm() {
    if (!shipWo) return;
    setShipBusy(true);
    try {
      await onShipWO(shipWo.wo_id);
      setShipWo(null);
    } catch (e) {
      /* 失敗：保持彈窗，錯誤已由 Toast 顯示 */
    } finally {
      setShipBusy(false);
    }
  }

  const dueCls = (w) => {
    if (!w.due_date) return 'text-slate-400';
    if (w.due_date < today && (w.status === '生產中' || w.status === '待確認')) {
      return 'text-red-600 font-bold';
    }
    if (w.due_date === today && (w.status === '生產中' || w.status === '待確認')) {
      return 'text-amber-600 font-bold';
    }
    return 'text-slate-600';
  };

  if (!getGasUrl()) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-5xl">⚙️</div>
        <h2 className="mt-4 text-xl font-extrabold">尚未設定雲端 API</h2>
        <p className="mt-2 text-slate-500">
          請先到「設定」分頁，貼上 Google Apps Script Web App 網址後即可使用工單管理。
        </p>
        <button className="btn-primary mt-6" onClick={goToSettings}>
          前往設定
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* ===== 到期警示（醒目） ===== */}
      {dueWos.length > 0 && (
        <div className="mb-3 rounded-3xl border-2 border-red-300 bg-red-50 p-4 shadow-card">
          <p className="text-base font-extrabold text-red-600">
            ⏰ 今日到期／逾期待確認工單：{dueWos.length} 張
          </p>
          <ul className="mt-2 space-y-1">
            {dueWos.slice(0, 4).map((w) => (
              <li key={w.wo_id} className="flex items-baseline justify-between text-sm font-semibold text-slate-700">
                <span>
                  <span className="font-mono text-xs text-slate-400">{w.wo_id}</span> <b>{w.style_no}</b>
                  <span className="ml-1 text-slate-400">×{w.plan_qty}</span>
                </span>
                <span className={w.due_date < today ? 'text-red-600' : 'text-amber-600'}>
                  {w.due_date === today ? '今日' : '逾期'} {w.due_date}
                </span>
              </li>
            ))}
          </ul>
          {dueWos.length > 4 && (
            <p className="mt-1 text-xs font-bold text-red-400">還有 {dueWos.length - 4} 張，請盡快完工確認…</p>
          )}
        </div>
      )}

      {/* ===== 狀態統計 + 開立按鈕 ===== */}
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${counts['生產中'] ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`}>
          生產中 {counts['生產中']}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${counts['待確認'] ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`}>
          待確認 {counts['待確認']}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${counts['待出貨'] ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-400'}`}>
          待出貨 {counts['待出貨']}
        </span>
        <button
          onClick={() => (formOpen ? setFormOpen(false) : openCreateForm())}
          className="ml-auto min-h-touch rounded-2xl bg-emerald-600 px-4 text-sm font-extrabold text-white shadow-card transition active:bg-emerald-700 active:scale-95"
        >
          {formOpen ? '✕ 收起表單' : '➕ 開立工作令'}
        </button>
      </div>

      {/* ===== 開立工作令表單 ===== */}
      {formOpen && (
        <div className="mt-3 space-y-4 rounded-3xl bg-white p-5 shadow-card">
          <div>
            <label className="field-label">款號 Style_No（成品款式名稱）</label>
            <div className="flex gap-2">
              <input
                className="field-input flex-1"
                placeholder="例：111AG20/6090R-G-D"
                value={draft.style_no}
                onChange={setDraftField('style_no')}
              />
              <button
                onClick={() => {
                  setStyleFilter('');
                  setStylePickerOpen(true);
                }}
                className="min-h-touch shrink-0 rounded-2xl bg-blue-700 px-3 text-sm font-extrabold text-white transition active:bg-blue-800 active:scale-95"
              >
                📋 從品名選
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="field-label">計畫數量 Plan_Qty</label>
              <input
                className="field-input"
                type="number"
                inputMode="decimal"
                step="1"
                min="0"
                placeholder="0"
                value={draft.plan_qty}
                onChange={setDraftField('plan_qty')}
              />
            </div>
            <div className="flex-1">
              <label className="field-label">預計完工日 Due_Date</label>
              <input
                className="field-input"
                type="date"
                value={draft.due_date}
                onChange={setDraftField('due_date')}
              />
            </div>
          </div>
          <div>
            <label className="field-label">流向 Destination</label>
            <div className="grid grid-cols-2 gap-2">
              {DESTS.map((d) => (
                <button
                  key={d.key}
                  onClick={() => setDraft((dr) => ({ ...dr, destination: d.key }))}
                  className={`min-h-touch rounded-2xl text-base font-extrabold transition active:scale-95 ${
                    draft.destination === d.key ? d.activeCls : d.inactiveCls
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">訂單編號 Order_Ref（選填）</label>
            <input
              className="field-input"
              placeholder="例：PO-2026-0888"
              value={draft.order_ref}
              onChange={setDraftField('order_ref')}
            />
          </div>

          {/* BOM 試算（即時） */}
          <div className="rounded-2xl bg-slate-50 p-3">
            <p className="text-sm font-extrabold text-slate-700">
              🧾 BOM 試算{draft.style_no.trim() ? `（${draft.style_no.trim()} × ${draftQty || '?'}）` : ''}
            </p>
            {draftBom.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">
                BOM_MASTER 尚未建立此款的原料清單（可直接在 Google 試算表新增：Style_No / Item_Code / Item_Name / Unit_Use）
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {draftBom.map((b) => {
                  const need = fmtQty(Number(b.unit_use) * draftQty);
                  const stock = itemsByKey.get(b.item_code)?.stock_qty;
                  const short = typeof stock === 'number' && draftQty > 0 && stock - Number(b.unit_use) * draftQty < 0;
                  return (
                    <li key={b.item_code} className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-semibold text-slate-700">
                        {b.item_name || b.item_code}
                        {need > 0 && <span className="text-slate-400">（{fmtQty(b.unit_use)}/件）</span>}
                      </span>
                      <span className={`shrink-0 font-black tabular-nums ${short ? 'text-red-600' : 'text-slate-800'}`}>
                        需 {need} ｜ 庫 {typeof stock === 'number' ? stock : '—'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <button className="btn-primary" onClick={handleOpenCreateConfirm}>
            送出「開立 {draftQty || '?'} 件」
          </button>
        </div>
      )}

      {/* ===== 搜尋 + 本頁同步 ===== */}
      <div className="mt-4 flex gap-2">
        <input
          className="field-input flex-1"
          type="search"
          placeholder="搜尋：工作令編號 / 款號 / 訂單編號…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          onClick={onRefresh}
          className="min-h-touch shrink-0 rounded-2xl bg-white px-4 text-sm font-extrabold text-blue-700 ring-2 ring-blue-700 transition active:bg-blue-50 active:scale-95"
        >
          ⟳ 同步
        </button>
      </div>

      {/* 狀態提示 */}
      {error && <div className="mt-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-600">⚠️ {error}</div>}
      {loading && (
        <div className="mt-4 animate-pulse rounded-2xl bg-blue-50 p-4 text-center text-sm font-bold text-blue-600">
          同步雲端工作令中…
        </div>
      )}
      {!loading && filteredWos.length === 0 && wos.length > 0 && (
        <div className="mt-8 text-center text-slate-400">
          <div className="text-4xl">🔎</div>
          <p className="mt-2 font-bold">找不到符合的工作令</p>
        </div>
      )}
      {!loading && wos.length === 0 && !error && (
        <div className="mt-8 text-center text-slate-400">
          <div className="text-4xl">🗒️</div>
          <p className="mt-2 font-bold">尚無工作令</p>
          <p className="mt-1 text-xs">點右上「➕ 開立工作令」建立第一張工作令</p>
        </div>
      )}

      {/* ===== 工作令清單 ===== */}
      <div className="mt-4 space-y-3">
        {filteredWos.map((w) => {
          const overdue = w.due_date && w.due_date < today && (w.status === '生產中' || w.status === '待確認');
          const dueToday = w.due_date === today && (w.status === '生產中' || w.status === '待確認');
          const bomCount = bomFor(w.style_no).length;
          return (
            <div
              key={w.wo_id}
              className={`rounded-3xl bg-white p-4 shadow-card ${
                overdue ? 'border-2 border-red-400' : dueToday ? 'border-2 border-amber-300' : 'border border-slate-100'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">{w.wo_id}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        WO_STATUS_COLORS[w.status] || 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {w.status}
                    </span>
                    {overdue && (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">逾期</span>
                    )}
                  </div>
                  <h3 className="mt-1 text-lg font-extrabold leading-snug text-slate-900">{w.style_no}</h3>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    w.destination === '入倉庫' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'
                  }`}
                >
                  {w.destination === '入倉庫' ? '📥 入倉庫' : '🚚 訂單出貨'}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
                <span className="text-slate-700">
                  計畫 <b className="tabular-nums">{w.plan_qty}</b>
                </span>
                <span className={dueCls(w)}>
                  到期 {w.due_date || '—'}
                  {dueToday && '（今日）'}
                </span>
                {w.order_ref && <span className="text-slate-500">📄 {w.order_ref}</span>}
              </div>

              {(w.actual_qty !== null || w.completed_time) && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-slate-600">
                  {w.actual_qty !== null && (
                    <span>
                      良品 <b className="tabular-nums">{w.actual_qty}</b>
                    </span>
                  )}
                  {w.completed_time && <span className="text-xs text-slate-400">完工：{w.completed_time}</span>}
                </div>
              )}

              {(w.status === '生產中' || w.status === '待確認') && (
                <button
                  onClick={() => openComplete(w)}
                  className="mt-3 min-h-touch w-full rounded-2xl bg-emerald-600 py-2.5 text-base font-extrabold text-white transition active:bg-emerald-700 active:scale-[0.98]"
                >
                  ✅ 確認完工{bomCount > 0 ? `（含 ${bomCount} 種原料扣料）` : ''}
                </button>
              )}
              {w.status === '待出貨' && (
                <button
                  onClick={() => setShipWo(w)}
                  className="mt-3 min-h-touch w-full rounded-2xl bg-orange-500 py-2.5 text-base font-extrabold text-white transition active:bg-orange-600 active:scale-[0.98]"
                >
                  📦 登記已出貨
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ===== 款式選擇（品名去重） ===== */}
      {stylePickerOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setStylePickerOpen(false)}
        >
          <div
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">選擇款號</h3>
              <button className="text-slate-400" onClick={() => setStylePickerOpen(false)}>✕</button>
            </div>
            <input
              className="field-input mb-3"
              placeholder="搜尋：品名 / 顏色…"
              value={styleFilter}
              onChange={(e) => setStyleFilter(e.target.value)}
            />
            <ul className="space-y-2">
              {styleOptions.map((s) => (
                <li key={s.name}>
                  <button
                    onClick={() => {
                      setDraft((d) => ({ ...d, style_no: s.name }));
                      setStylePickerOpen(false);
                    }}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition active:bg-blue-100"
                  >
                    <b>{s.name}</b>
                    {s.color && <span className="text-slate-500">（{s.color}）</span>}
                    {s.category && (
                      <span className="float-right text-xs text-slate-400">{s.category}</span>
                    )}
                  </button>
                </li>
              ))}
              {styleOptions.length === 0 && (
                <li className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                  庫存主檔尚無品名，可直接在上方手動輸入款號。
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      {/* ===== 入庫料號選擇（完工彈窗用） ===== */}
      {cPickerOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setCPickerOpen(false)}
        >
          <div
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">選擇成品入庫料號</h3>
              <button className="text-slate-400" onClick={() => setCPickerOpen(false)}>✕</button>
            </div>
            <input
              className="field-input mb-2"
              placeholder={`搜尋（預設列成品，例：${completing?.style_no || '款號'}）…`}
              value={cTargetFilter}
              onChange={(e) => setCTargetFilter(e.target.value)}
            />
            <p className="mb-2 px-1 text-xs font-bold text-slate-400">目前選擇：{cTarget ? `${cTarget.item_name}（${cTarget.color_spec || '無色號'}）` : '未選擇'}</p>
            <ul className="space-y-2">
              {targetOptions.map((it) => (
                <li key={it.item_code}>
                  <button
                    onClick={() => {
                      setCTarget(it);
                      setCPickerOpen(false);
                    }}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition active:bg-emerald-100"
                  >
                    <b>{it.item_name}</b>
                    {it.color_spec && <span className="text-slate-500">（{it.color_spec}）</span>}
                    <span className="float-right font-black text-slate-700">
                      {it.stock_qty} {it.unit}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ===== 開立二次確認 ===== */}
      <ConfirmDialog
        open={createConfirmOpen}
        busy={createBusy}
        title="確認開立工作令"
        confirmText="確認開立"
        onClose={() => !createBusy && setCreateConfirmOpen(false)}
        onConfirm={handleCreateConfirm}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          <Row label="款號" value={draft.style_no.trim() || '—'} />
          <Row label="計畫數量" value={draftQty} strong />
          <Row label="預計完工日" value={draft.due_date || '—'} />
          <Row label="流向" value={draft.destination} />
          <Row label="訂單編號" value={draft.order_ref.trim() || '—'} />
          <Row
            label="BOM 原料"
            value={draftBom.length > 0 ? `${draftBom.length} 種（開工後完工時扣料）` : '無（未建立 BOM）'}
          />
        </div>
      </ConfirmDialog>

      {/* ===== 確認完工結案 ===== */}
      <ConfirmDialog
        open={!!completing}
        busy={completeBusy}
        title="✅ 確認完工"
        confirmText="完工結案"
        danger={cShortage}
        onClose={closeComplete}
        onConfirm={handleCompleteConfirm}
      >
        {completing && (
          <div className="mt-4 space-y-3">
            <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
              <Row label="工作令" value={`${completing.wo_id}（${completing.status}）`} />
              <Row label="款號 / 流向" value={`${completing.style_no} ／ ${completing.destination}`} />
              <Row label="計畫數量" value={completing.plan_qty} />
            </div>

            <div>
              <label className="field-label">實際良品數（預設 = 計畫數量）</label>
              <input
                className="field-input text-2xl font-black tabular-nums"
                type="number"
                inputMode="decimal"
                step="1"
                min="0"
                value={cActual}
                onChange={(e) => setCActual(e.target.value)}
              />
            </div>

            {completing.destination === '入倉庫' && (
              <div>
                <label className="field-label">成品入庫料號（必選）</label>
                <button
                  onClick={() => setCPickerOpen(true)}
                  className={`field-input flex items-center justify-between text-left ${cTarget ? '' : 'text-slate-400'}`}
                >
                  <span>
                    {cTarget
                      ? `${cTarget.item_name}${cTarget.color_spec ? `（${cTarget.color_spec}）` : ''} ｜ 現有庫存 ${cTarget.stock_qty}`
                      : '📋 點此選擇成品料號…'}
                  </span>
                  <span className="text-slate-300">▾</span>
                </button>
              </div>
            )}

            {cBomRows.length > 0 && (
              <div className="rounded-2xl bg-slate-50 p-3">
                <label className="flex items-center gap-2 text-sm font-extrabold text-slate-700">
                  <input
                    type="checkbox"
                    checked={cUseBom}
                    onChange={(e) => setCUseBom(e.target.checked)}
                    className="h-5 w-5 accent-emerald-600"
                  />
                  依 BOM 扣原料（每件耗用量 × 實際良品數）
                </label>
                {cUseBom && (
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {cBomRows.map((b) => {
                      const need = fmtQty(Number(b.unit_use) * cActualNum);
                      const stock = itemsByKey.get(b.item_code)?.stock_qty;
                      const after = typeof stock === 'number' ? fmtQty(stock - Number(b.unit_use) * cActualNum) : null;
                      const neg = after !== null && after < 0;
                      return (
                        <li key={b.item_code} className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-semibold text-slate-700">
                            {b.item_name || b.item_code}
                            {need > 0 && <span className="text-slate-400">（扣 {need}）</span>}
                          </span>
                          <span className={`shrink-0 font-black tabular-nums ${neg ? 'text-red-600' : 'text-slate-800'}`}>
                            {typeof stock === 'number' ? `${stock} → ${after}` : '庫存未知'}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {cUseBom && cShortage && (
                  <p className="mt-2 text-xs font-bold text-red-600">
                    ⚠️ 有原料庫存不足，仍將照扣形成負庫存（請事後補料或檢討 BOM）
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="field-label">經辦人</label>
              <input
                className="field-input"
                placeholder="例：01-王小明"
                value={cOperator}
                onChange={(e) => setCOperator(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">備註（選填）</label>
              <input
                className="field-input"
                placeholder="例：良品後另有 20 件待重工"
                value={cRemark}
                onChange={(e) => setCRemark(e.target.value)}
              />
            </div>
          </div>
        )}
      </ConfirmDialog>

      {/* ===== 登記已出貨確認 ===== */}
      <ConfirmDialog
        open={!!shipWo}
        busy={shipBusy}
        title="📦 登記已出貨"
        confirmText="確認出貨"
        onClose={() => !shipBusy && setShipWo(null)}
        onConfirm={handleShipConfirm}
      >
        {shipWo && (
          <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
            <Row label="工作令" value={shipWo.wo_id} />
            <Row label="款號" value={shipWo.style_no} />
            <Row label="良品 / 計畫" value={`${shipWo.actual_qty ?? '—'} / ${shipWo.plan_qty}`} />
            <Row label="訂單編號" value={shipWo.order_ref || '—'} />
            <p className="mt-2 text-xs text-slate-400">
              此流向未進一般庫存，登記後狀態改為「已出貨」並留存完工時間。
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function Row({ label, value, strong, cls }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-right ${strong ? 'text-lg font-black' : 'font-semibold'} ${cls || 'text-slate-800'}`}>
        {value}
      </span>
    </div>
  );
}
