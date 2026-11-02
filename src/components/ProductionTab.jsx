import { useMemo, useState } from 'react';
import { PWO_STATUS_COLORS, COLOR_SLOTS } from '../constants';
import { getGasUrl, getOperator } from '../api';
import ConfirmDialog from './ConfirmDialog';

const DESTS = [
  {
    key: '入倉庫備庫',
    label: '📥 入倉庫備庫',
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
  wo_id: '',
  customer: '',
  style_no: '',
  plan_qty: '',
  due_date: '',
  colors: COLOR_SLOTS.map(() => ({ color: '', qty: '' })),
  destination: '入倉庫備庫',
  order_ref: '',
  setting: '',
  sewing: '',
  packing: '',
  start_now: true,
};

/** 狀態排序權重（生產中最上，草稿緊接在待確認後提醒投產） */
const STATUS_ORDER = { 生產中: 0, 待確認: 1, 草稿: 2, 待出貨: 3, 已入庫: 4, 已出貨: 5 };

const DEST_BADGE = {
  入倉庫備庫: 'bg-emerald-100 text-emerald-700',
  訂單出貨: 'bg-orange-100 text-orange-700',
};

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 小數最多顯示 4 位 */
function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * 分頁：生產工令（新版工作令，接續紙本《盛全工業 工作令》格式）
 * - 單頭：編號(#G…可留空自動)／客戶／型號／總計(頂)／完成日期(預計交期)／訂單編號
 * - 配色：A色～E色 × 數量（顏色稱呼以頭頂顏色為準）
 * - 工序：定型／平車／包裝 備註
 * - 流向：入倉庫備庫｜訂單出貨；狀態：草稿→生產中→待確認→已入庫/待出貨→已出貨
 * - 紗線：投產瞬間依「BOM 紗線列＋手動指定」合併之單頂用紗量 × 預計量扣 YARN_INVENTORY
 * - 完工：入倉庫備庫 → 成品入 INVENTORY_MASTER；訂單出貨 → 待出貨（出庫出貨分頁開單）
 */
export default function ProductionTab({
  pos,
  yarns,
  items,
  bomFor,
  loading,
  error,
  showToast,
  onCreatePO,
  onStartPO,
  onCompletePO,
  onShipPO,
  onSaveYarn,
  onRefresh,
  goToSettings,
}) {
  // ===== 開立工作令 =====
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [draftYarns, setDraftYarns] = useState([]); // 手動指定紗線 [{yarn_code, kg_per_unit}]
  const [createConfirmOpen, setCreateConfirmOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [styleFilter, setStyleFilter] = useState('');
  const [yarnPickerRow, setYarnPickerRow] = useState(null); // 正在選紗的手動列索引
  const [yarnFilter, setYarnFilter] = useState('');

  // ===== 清單搜尋 =====
  const [filter, setFilter] = useState('');

  // ===== 投產（草稿→生產中＋扣紗） =====
  const [starting, setStarting] = useState(null);
  const [startBusy, setStartBusy] = useState(false);

  // ===== 確認完工 =====
  const [completing, setCompleting] = useState(null);
  const [cActual, setCActual] = useState('');
  const [cTarget, setCTarget] = useState(null);
  const [cTargetFilter, setCTargetFilter] = useState('');
  const [cPickerOpen, setCPickerOpen] = useState(false);
  const [cUseBom, setCUseBom] = useState(false);
  const [cOperator, setCOperator] = useState(() => getOperator());
  const [cRemark, setCRemark] = useState('');
  const [completeBusy, setCompleteBusy] = useState(false);

  // ===== 登記已出貨 =====
  const [shipWo, setShipWo] = useState(null);
  const [shipBusy, setShipBusy] = useState(false);

  // ===== 紗線庫存專區 =====
  const [yarnPanelOpen, setYarnPanelOpen] = useState(false);
  const [yarnForm, setYarnForm] = useState({ yarn_code: '', yarn_name: '', color: '', stock_kg: '', safety_stock: '' });
  const [yarnFilterList, setYarnFilterList] = useState('');
  const [yarnSaveBusy, setYarnSaveBusy] = useState(false);

  const today = todayYMD();
  const itemsByKey = useMemo(() => new Map(items.map((it) => [it.item_code, it])), [items]);
  const yarnByKey = useMemo(
    () => new Map(yarns.map((y) => [String(y.yarn_code).toUpperCase(), y])),
    [yarns],
  );

  /** 本分頁到期清單（生產中/待確認 且 due <= 今天） */
  const duePOs = useMemo(
    () =>
      pos
        .filter(
          (w) =>
            (w.status === '生產中' || w.status === '待確認') &&
            w.due_date &&
            w.due_date <= today,
        )
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))),
    [pos, today],
  );

  /** 排序：生產中 → 待確認 → 草稿 → 待出貨 → 已入庫 → 已出貨 */
  const sortedPos = useMemo(
    () =>
      [...pos].sort((a, b) => {
        const oa = STATUS_ORDER[a.status] ?? 9;
        const ob = STATUS_ORDER[b.status] ?? 9;
        if (oa !== ob) return oa - ob;
        const da = a.due_date || '9999-99-99';
        const db = b.due_date || '9999-99-99';
        if (da !== db) return da.localeCompare(db);
        return String(a.wo_id).localeCompare(String(b.wo_id));
      }),
    [pos],
  );

  const filteredPos = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return sortedPos;
    return sortedPos.filter((w) =>
      `${w.wo_id} ${w.customer} ${w.style_no} ${w.order_ref} ${w.status} ${w.destination}`
        .toLowerCase()
        .includes(f),
    );
  }, [sortedPos, filter]);

  const counts = useMemo(() => {
    const c = { 生產中: 0, 待確認: 0, 草稿: 0, 待出貨: 0 };
    pos.forEach((w) => {
      if (c[w.status] !== undefined) c[w.status]++;
    });
    return c;
  }, [pos]);

  // ===== 開單表單：紗線需求合併試算（BOM 紗線列＋手動指定，同碼相加） =====
  const draftQty = Number(draft.plan_qty) || 0;
  const draftYarnNeed = useMemo(() => {
    const map = {}; // code -> {yarn_code, yarn_name, kg_per_unit}
    const order = [];
    (bomFor(draft.style_no) || []).forEach((b) => {
      const code = String(b.item_code).trim().toUpperCase();
      const y = yarnByKey.get(code);
      if (!y) return; // BOM 內非紗線原料（完工時才扣），不列入投產領紗
      if (!map[code]) {
        map[code] = { yarn_code: code, yarn_name: y.yarn_name, kg_per_unit: 0, sources: new Set(['BOM']) };
        order.push(code);
      }
      map[code].kg_per_unit += Number(b.unit_use) || 0;
    });
    draftYarns.forEach((r) => {
      const code = String(r.yarn_code || '').trim().toUpperCase();
      if (!code) return;
      const y = yarnByKey.get(code);
      if (!map[code]) {
        map[code] = { yarn_code: code, yarn_name: y ? y.yarn_name : code, kg_per_unit: 0, sources: new Set(['手動']) };
        order.push(code);
      }
      map[code].kg_per_unit += Number(r.kg_per_unit) || 0;
      if (y && !map[code].sources.has('BOM')) map[code].sources.add('手動');
    });
    return order.map((c) => ({
      ...map[c],
      kg_per_unit: fmtQty(map[c].kg_per_unit),
      sources: [...map[c].sources].join('+'),
    }));
  }, [draft.style_no, draftYarns, bomFor, yarnByKey]);

  /** 投產扣紗預覽（開單確認／草稿投產共用）：回傳列＋是否有透支 */
  function previewDeduct(lines, planQty) {
    const rows = (lines || []).map((l) => {
      const y = yarnByKey.get(String(l.yarn_code).toUpperCase());
      const need = fmtQty((Number(l.kg_per_unit) || 0) * planQty);
      const stock = y ? y.stock_kg : null;
      const after = stock === null ? null : fmtQty(stock - need);
      return { ...l, need, stock, after, missing: !y };
    });
    const shortage = rows.some((r) => r.after !== null && r.after < 0);
    return { rows, shortage };
  }

  // 開單表單：款式候選（品名去重）
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

  // 紗線選擇候選
  const yarnCandidateOptions = useMemo(() => {
    const f = yarnFilter.trim().toLowerCase();
    return yarns
      .filter((y) => {
        if (!f) return true;
        return `${y.yarn_code} ${y.yarn_name} ${y.color}`.toLowerCase().includes(f);
      })
      .slice(0, 200);
  }, [yarns, yarnFilter]);

  // 紗線專區清單（低庫存排最前）
  const yarnListSorted = useMemo(() => {
    const f = yarnFilterList.trim().toLowerCase();
    return [...yarns]
      .filter((y) => {
        if (!f) return true;
        return `${y.yarn_code} ${y.yarn_name} ${y.color}`.toLowerCase().includes(f);
      })
      .sort((a, b) => {
        const la = a.safety_stock > 0 && a.stock_kg < a.safety_stock ? 0 : 1;
        const lb = b.safety_stock > 0 && b.stock_kg < b.safety_stock ? 0 : 1;
        if (la !== lb) return la - lb;
        return String(a.yarn_code).localeCompare(String(b.yarn_code));
      });
  }, [yarns, yarnFilterList]);

  function openCreateForm() {
    setDraft(EMPTY_DRAFT);
    setDraftYarns([]);
    setFormOpen(true);
  }

  const setDraftField = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const setColorField = (idx, key) => (e) =>
    setDraft((d) => {
      const colors = d.colors.map((c, i) => (i === idx ? { ...c, [key]: e.target.value } : c));
      return { ...d, colors };
    });

  function handleOpenCreateConfirm() {
    if (!draft.style_no.trim()) return showToast('❌ 請填寫型號 Style_No', 'error');
    if (!(draftQty > 0)) return showToast('❌ 預計產量必須大於 0', 'error');
    if (!draft.due_date) return showToast('❌ 請選擇預計交期（完成日期）', 'error');
    if (!draft.colors.some((c) => c.color.trim())) return showToast('❌ 請填寫至少一組配色（A色～E色）', 'error');
    const filled = draft.colors.filter((c) => String(c.qty).trim() !== '');
    if (filled.length > 0) {
      const sum = filled.reduce((s, c) => s + Number(c.qty || 0), 0);
      if (!isFinite(sum) || fmtQty(sum) !== fmtQty(draftQty)) {
        return showToast(`❌ 配色數量合計 ${sum} 與預計產量 ${draftQty} 不符`, 'error');
      }
    }
    for (const r of draftYarns) {
      if (!String(r.yarn_code).trim()) return showToast('❌ 手動紗線列請選擇紗線代碼', 'error');
      if (!(Number(r.kg_per_unit) > 0)) return showToast(`❌ ${r.yarn_code} 的單頂用紗量需大於 0`, 'error');
      if (!yarnByKey.get(String(r.yarn_code).trim().toUpperCase())) {
        return showToast(`❌ 紗線代碼不存在於紗線庫存：${r.yarn_code}（請先建檔）`, 'error');
      }
    }
    setCreateConfirmOpen(true);
  }

  async function handleCreateConfirm() {
    setCreateBusy(true);
    try {
      await onCreatePO({
        wo_id: draft.wo_id.trim().replace(/^#/, ''),
        customer: draft.customer.trim(),
        style_no: draft.style_no.trim(),
        plan_qty: draftQty,
        due_date: draft.due_date,
        destination: draft.destination,
        order_ref: draft.order_ref.trim(),
        colors: draft.colors.map((c) => ({ color: c.color.trim(), qty: c.qty })),
        process_setting: draft.setting.trim(),
        process_sewing: draft.sewing.trim(),
        process_packing: draft.packing.trim(),
        yarn_lines: draftYarns
          .filter((r) => String(r.yarn_code).trim() && Number(r.kg_per_unit) > 0)
          .map((r) => ({ yarn_code: r.yarn_code.trim(), kg_per_unit: Number(r.kg_per_unit) })),
        start_now: draft.start_now,
        operator: getOperator().trim() || '—',
      });
      setCreateConfirmOpen(false);
      setFormOpen(false);
      setDraft(EMPTY_DRAFT);
      setDraftYarns([]);
    } catch (e) {
      /* 失敗：保持彈窗，錯誤已由 Toast 顯示 */
    } finally {
      setCreateBusy(false);
    }
  }

  // ===== 投產 =====
  function openStart(wo) {
    setStarting(wo);
  }

  async function handleStartConfirm() {
    const wo = starting;
    if (!wo) return;
    setStartBusy(true);
    try {
      await onStartPO(wo.wo_id, getOperator().trim() || '—');
      setStarting(null);
    } catch (e) {
      /* 失敗：保持彈窗 */
    } finally {
      setStartBusy(false);
    }
  }

  // ===== 完工 =====
  function openComplete(wo) {
    setCompleting(wo);
    setCActual(String(wo.plan_qty));
    setCTarget(null);
    setCTargetFilter('');
    setCPickerOpen(false);
    setCUseBom(false);
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
    if (wo.destination === '入倉庫備庫' && !cTarget) {
      return showToast('❌ 請選擇成品入庫料號', 'error');
    }
    const n = Number(cActual);
    if (!isFinite(n) || n < 0) return showToast('❌ 實際良品數格式錯誤（不可為負數）', 'error');
    if (!cOperator.trim()) return showToast('❌ 請填寫經辦人姓名', 'error');
    setCompleteBusy(true);
    try {
      await onCompletePO({
        wo_id: wo.wo_id,
        actual_good_qty: n,
        target_item_code: wo.destination === '入倉庫備庫' ? cTarget.item_code : '',
        use_bom: cUseBom && cNonYarnBomRows.length > 0,
        operator: cOperator.trim(),
        remark: cRemark.trim(),
      });
      setCompleting(null);
    } catch (e) {
      /* 失敗：保持彈窗 */
    } finally {
      setCompleteBusy(false);
    }
  }

  // 完工彈窗：BOM 內「非紗線」原料（紗線已於投產扣除，不重複扣）
  const cNonYarnBomRows = useMemo(() => {
    if (!completing) return [];
    return (bomFor(completing.style_no) || []).filter(
      (b) => !yarnByKey.get(String(b.item_code).trim().toUpperCase()),
    );
  }, [completing, bomFor, yarnByKey]);

  // 完工彈窗：非紗線原料扣完會負庫存（紅色警示）
  const cShortage = useMemo(() => {
    if (!cUseBom || !cNonYarnBomRows.length) return false;
    const n = Number(cActual);
    return cNonYarnBomRows.some((b) => {
      const stock = itemsByKey.get(b.item_code)?.stock_qty;
      return typeof stock === 'number' && stock - Number(b.unit_use) * n < 0;
    });
  }, [cUseBom, cNonYarnBomRows, cActual, itemsByKey]);

  async function handleShipConfirm() {
    if (!shipWo) return;
    setShipBusy(true);
    try {
      await onShipPO(shipWo.wo_id);
      setShipWo(null);
    } catch (e) {
      /* 失敗：保持彈窗 */
    } finally {
      setShipBusy(false);
    }
  }

  // ===== 紗線庫存維護 =====
  const setYarnField = (key) => (e) => setYarnForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSaveYarn() {
    if (!yarnForm.yarn_name.trim()) return showToast('❌ 請填寫紗名 Yarn_Name', 'error');
    if (yarnForm.stock_kg !== '' && !(Number(yarnForm.stock_kg) >= 0)) {
      return showToast('❌ Stock_KG 需為 0 以上的數字', 'error');
    }
    setYarnSaveBusy(true);
    try {
      await onSaveYarn({
        yarn_code: yarnForm.yarn_code.trim().replace(/^#/, ''),
        yarn_name: yarnForm.yarn_name.trim(),
        color: yarnForm.color.trim(),
        stock_kg: yarnForm.stock_kg === '' ? undefined : Number(yarnForm.stock_kg),
        safety_stock: yarnForm.safety_stock === '' ? undefined : Number(yarnForm.safety_stock),
      });
      setYarnForm({ yarn_code: '', yarn_name: '', color: '', stock_kg: '', safety_stock: '' });
    } catch (e) {
      /* 失敗：Toast 已顯示 */
    } finally {
      setYarnSaveBusy(false);
    }
  }

  const dueCls = (w) => {
    if (!w.due_date) return 'text-slate-400';
    if (w.due_date < today && (w.status === '生產中' || w.status === '待確認')) return 'text-red-600 font-bold';
    if (w.due_date === today && (w.status === '生產中' || w.status === '待確認')) return 'text-amber-600 font-bold';
    return 'text-slate-600';
  };

  if (!getGasUrl()) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-5xl">⚙️</div>
        <h2 className="mt-4 text-xl font-extrabold">尚未設定雲端 API</h2>
        <p className="mt-2 text-slate-500">
          請先到「設定」分頁，貼上 Google Apps Script Web App 網址後即可使用生產工令。
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
      {duePOs.length > 0 && (
        <div className="mb-3 rounded-3xl border-2 border-red-300 bg-red-50 p-4 shadow-card">
          <p className="text-base font-extrabold text-red-600">
            ⏰ 今日到期／逾期未完工工令：{duePOs.length} 張
          </p>
          <ul className="mt-2 space-y-1">
            {duePOs.slice(0, 4).map((w) => (
              <li key={w.wo_id} className="flex items-baseline justify-between text-sm font-semibold text-slate-700">
                <span>
                  <span className="font-mono text-xs text-slate-400">{w.wo_id}</span> <b>{w.style_no}</b>
                  <span className="ml-1 text-slate-400">×{w.plan_qty}頂</span>
                </span>
                <span className={w.due_date < today ? 'text-red-600' : 'text-amber-600'}>
                  {w.due_date === today ? '今日' : '逾期'} {w.due_date}
                </span>
              </li>
            ))}
          </ul>
          {duePOs.length > 4 && (
            <p className="mt-1 text-xs font-bold text-red-400">還有 {duePOs.length - 4} 張，請盡快完工確認…</p>
          )}
        </div>
      )}

      {/* ===== 狀態統計 + 開立按鈕 ===== */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${counts['生產中'] ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`}>
          生產中 {counts['生產中']}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${counts['待確認'] ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`}>
          待確認 {counts['待確認']}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${counts['草稿'] ? 'bg-slate-200 text-slate-600' : 'bg-slate-100 text-slate-400'}`}>
          草稿 {counts['草稿']}
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

      {/* ===== 開立工作令表單（紙本《工作令》格式） ===== */}
      {formOpen && (
        <div className="mt-3 space-y-4 rounded-3xl bg-white p-5 shadow-card">
          <p className="text-xs font-bold text-slate-400">紙本「工作令」格式：編號／客戶／型號／總計／完成日期＋A色～E色配色＋定型／平車／包裝</p>

          <div className="flex gap-2">
            <div className="w-32 shrink-0">
              <label className="field-label">編號（留空自動）</label>
              <input
                className="field-input"
                placeholder="#G…"
                value={draft.wo_id}
                onChange={setDraftField('wo_id')}
              />
            </div>
            <div className="flex-1">
              <label className="field-label">客戶 Customer</label>
              <input
                className="field-input"
                placeholder="例：SZ / MOONBAT"
                value={draft.customer}
                onChange={setDraftField('customer')}
              />
            </div>
          </div>

          <div>
            <label className="field-label">型號 Style_No（款號）</label>
            <div className="flex gap-2">
              <input
                className="field-input flex-1"
                placeholder="例：D1177WB/6142"
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
              <label className="field-label">總計（預計產量，頂）</label>
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
              <label className="field-label">完成日期（預計交期）</label>
              <input
                className="field-input"
                type="date"
                value={draft.due_date}
                onChange={setDraftField('due_date')}
              />
            </div>
          </div>

          {/* 五色配色（顏色稱呼以頭頂顏色為準） */}
          <div className="rounded-2xl bg-slate-50 p-3">
            <p className="text-sm font-extrabold text-slate-700">🎨 配色（顏色稱呼以頭頂顏色為準）</p>
            <div className="mt-2 space-y-2">
              {draft.colors.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-sm font-black text-slate-500">{COLOR_SLOTS[i]}</span>
                  <input
                    className="field-input flex-1"
                    placeholder="色名（例：干邑褐）"
                    value={c.color}
                    onChange={setColorField(i, 'color')}
                  />
                  <input
                    className="field-input w-24 shrink-0 tabular-nums"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    placeholder="數量(頂)"
                    value={c.qty}
                    onChange={setColorField(i, 'qty')}
                  />
                </div>
              ))}
            </div>
            {draftQty > 0 && (
              <p className="mt-2 text-xs font-bold text-slate-400">
                已填合計{' '}
                {fmtQty(
                  draft.colors.reduce((s, c) => s + (String(c.qty).trim() === '' ? 0 : Number(c.qty || 0)), 0),
                )}{' '}
                ／ 總計 {draftQty} 頂
              </p>
            )}
          </div>

          {/* 流向 */}
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

          {/* 工序備註（紙本：定型／平車／包裝） */}
          <div className="space-y-2">
            <div>
              <label className="field-label">定型工序（選填）</label>
              <textarea
                className="field-input min-h-[64px]"
                placeholder="例：1.理毛,反面只理頭部 2.定型:用D1177(S) 3.硬度-普通(同參考樣品) 4.邊留1.5公分"
                value={draft.setting}
                onChange={setDraftField('setting')}
              />
            </div>
            <div>
              <label className="field-label">平車工序（選填）</label>
              <textarea
                className="field-input min-h-[48px]"
                placeholder="例：1.普通汗帶57CM 只固定 2.內銷洗標"
                value={draft.sewing}
                onChange={setDraftField('sewing')}
              />
            </div>
            <div>
              <label className="field-label">包裝工序（選填）</label>
              <textarea
                className="field-input min-h-[48px]"
                placeholder="例：1.12頂裝1箱 2.用小羊毛吊牌 3.素體"
                value={draft.packing}
                onChange={setDraftField('packing')}
              />
            </div>
          </div>

          {/* 投產扣紗設定 */}
          <div className="rounded-2xl bg-slate-50 p-3">
            <p className="text-sm font-extrabold text-slate-700">🧵 投產扣紗（YARN_INVENTORY）</p>
            {draftYarnNeed.length === 0 && draftYarns.length === 0 && (
              <p className="mt-1 text-xs text-slate-400">
                尚未指定紗線：可在 BOM_MASTER 建立此款紗線用量（Style_No / Yarn_Code / Unit_Use=單頂用紗量 KG），
                或按「➕ 指定紗線」手動輸入。
              </p>
            )}
            {draftYarnNeed.length > 0 && (
              <ul className="mt-2 space-y-1.5 text-sm">
                {draftYarnNeed.map((l) => {
                  const need = fmtQty(l.kg_per_unit * draftQty);
                  const y = yarnByKey.get(l.yarn_code);
                  const stock = y ? y.stock_kg : null;
                  const after = stock === null ? null : fmtQty(stock - need);
                  const short = after !== null && after < 0;
                  return (
                    <li key={l.yarn_code} className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-semibold text-slate-700">
                        {l.yarn_name || l.yarn_code}（{fmtQty(l.kg_per_unit)} KG/頂 · {l.sources}）
                      </span>
                      <span className={`shrink-0 font-black tabular-nums ${short ? 'text-red-600' : 'text-slate-800'}`}>
                        需 {need} KG ｜ 庫 {stock === null ? '—' : stock}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {draftYarns.map((r, i) => (
              <div key={i} className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => {
                    setYarnFilter('');
                    setYarnPickerRow(i);
                  }}
                  className={`field-input flex-1 truncate text-left ${r.yarn_code ? '' : 'text-slate-400'}`}
                >
                  {r.yarn_code
                    ? `${r.yarn_code} ${yarnByKey.get(r.yarn_code.toUpperCase())?.yarn_name || ''}`
                    : '📋 點此選擇紗線（手動指定）'}
                </button>
                <input
                  className="field-input w-24 shrink-0 tabular-nums"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="KG/頂"
                  value={r.kg_per_unit}
                  onChange={(e) =>
                    setDraftYarns((rows) =>
                      rows.map((row, j) => (j === i ? { ...row, kg_per_unit: e.target.value } : row)),
                    )
                  }
                />
                <button
                  onClick={() => setDraftYarns((rows) => rows.filter((_, j) => j !== i))}
                  className="min-h-touch shrink-0 rounded-xl bg-slate-200 px-2 text-sm font-bold text-slate-600"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setDraftYarns((rows) => [...rows, { yarn_code: '', kg_per_unit: '' }])}
                className="min-h-touch rounded-2xl bg-blue-700 px-3 text-sm font-extrabold text-white transition active:bg-blue-800 active:scale-95"
              >
                ➕ 指定紗線
              </button>
            </div>

            {/* 開單後動作 */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => setDraft((d) => ({ ...d, start_now: true }))}
                className={`min-h-touch rounded-2xl text-sm font-extrabold transition active:scale-95 ${
                  draft.start_now
                    ? 'bg-blue-700 text-white shadow-card'
                    : 'bg-white text-blue-700 ring-2 ring-blue-700'
                }`}
              >
                🏭 直接投產（立即扣紗）
              </button>
              <button
                onClick={() => setDraft((d) => ({ ...d, start_now: false }))}
                className={`min-h-touch rounded-2xl text-sm font-extrabold transition active:scale-95 ${
                  !draft.start_now
                    ? 'bg-slate-600 text-white shadow-card'
                    : 'bg-white text-slate-600 ring-2 ring-slate-500'
                }`}
              >
                📝 先存草稿（投產才扣紗）
              </button>
            </div>
          </div>

          <button className="btn-primary" onClick={handleOpenCreateConfirm}>
            {draft.start_now ? `送出「開立 ${draftQty || '?'} 頂＋投產扣紗」` : `送出「開立 ${draftQty || '?'} 頂（草稿）」`}
          </button>
        </div>
      )}

      {/* ===== 搜尋 + 本頁同步 ===== */}
      <div className="mt-4 flex gap-2">
        <input
          className="field-input flex-1"
          type="search"
          placeholder="搜尋：工令編號 / 客戶 / 型號 / 訂單編號…"
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

      {/* ===== 🧵 紗線庫存專區 ===== */}
      <div className="mt-3">
        <button
          onClick={() => setYarnPanelOpen((v) => !v)}
          className="min-h-touch w-full rounded-2xl bg-slate-800 px-4 py-2.5 text-sm font-extrabold text-white transition active:scale-[0.98]"
        >
          {yarnPanelOpen ? '▾ 收起紗線庫存' : `▸ 紗線庫存（${yarns.length} 種）`}
        </button>
        {yarnPanelOpen && (
          <div className="mt-2 space-y-3 rounded-3xl bg-white p-4 shadow-card">
            {/* 新增／調整紗線 */}
            <div className="rounded-2xl bg-slate-50 p-3">
              <p className="text-sm font-extrabold text-slate-700">➕ 新增／調整紗線（代碼留空自動 Y…）</p>
              <div className="mt-2 flex gap-2">
                <input className="field-input w-24 shrink-0" placeholder="代碼" value={yarnForm.yarn_code} onChange={setYarnField('yarn_code')} />
                <input className="field-input flex-1" placeholder="紗名（必填）" value={yarnForm.yarn_name} onChange={setYarnField('yarn_name')} />
                <input className="field-input w-24 shrink-0" placeholder="色號" value={yarnForm.color} onChange={setYarnField('color')} />
              </div>
              <div className="mt-2 flex gap-2">
                <input className="field-input flex-1" type="number" inputMode="decimal" placeholder="庫存 KG（直接設定現有量）" value={yarnForm.stock_kg} onChange={setYarnField('stock_kg')} />
                <input className="field-input flex-1" type="number" inputMode="decimal" placeholder="安全庫存 KG" value={yarnForm.safety_stock} onChange={setYarnField('safety_stock')} />
                <button
                  onClick={handleSaveYarn}
                  disabled={yarnSaveBusy}
                  className="min-h-touch shrink-0 rounded-2xl bg-emerald-600 px-4 text-sm font-extrabold text-white shadow-card transition active:bg-emerald-700 active:scale-95 disabled:opacity-50"
                >
                  {yarnSaveBusy ? '…' : '儲存'}
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-400">
                已存在的代碼＝更新該欄（Stock_KG 為直接設定値，非增減；異動請改用「出入庫」出庫紗線品號）。
              </p>
            </div>

            <input
              className="field-input"
              type="search"
              placeholder="搜尋紗線：代碼 / 紗名 / 色號…"
              value={yarnFilterList}
              onChange={(e) => setYarnFilterList(e.target.value)}
            />

            <ul className="space-y-2">
              {yarnListSorted.map((y) => {
                const low = y.safety_stock > 0 && y.stock_kg < y.safety_stock;
                return (
                  <li
                    key={y.yarn_code}
                    className={`rounded-2xl p-3 ${low ? 'bg-red-50 ring-2 ring-red-300' : 'bg-slate-50'}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-extrabold text-slate-800">
                        <span className="font-mono text-xs text-slate-400">{y.yarn_code}</span> {y.yarn_name}
                        {y.color && <span className="text-slate-500">（{y.color}）</span>}
                      </span>
                      <span className={`shrink-0 font-black tabular-nums ${low ? 'text-red-600' : 'text-slate-700'}`}>
                        {fmtQty(y.stock_kg)} KG{low ? ' ⚠️ 低於安全庫存' : ''}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      安全庫存 {fmtQty(y.safety_stock)} KG · 更新 {y.last_updated || '—'}
                    </p>
                  </li>
                );
              })}
              {yarnListSorted.length === 0 && (
                <li className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                  尚無紗線資料——請先於上方建檔（投產扣紗與庫存警示都靠這份清單）。
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* 狀態提示 */}
      {error && <div className="mt-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-600">⚠️ {error}</div>}
      {loading && (
        <div className="mt-4 animate-pulse rounded-2xl bg-blue-50 p-4 text-center text-sm font-bold text-blue-600">
          同步雲端工作令中…
        </div>
      )}
      {!loading && filteredPos.length === 0 && pos.length > 0 && (
        <div className="mt-8 text-center text-slate-400">
          <div className="text-4xl">🔎</div>
          <p className="mt-2 font-bold">找不到符合的工作令</p>
        </div>
      )}
      {!loading && pos.length === 0 && !error && (
        <div className="mt-8 text-center text-slate-400">
          <div className="text-4xl">🗒️</div>
          <p className="mt-2 font-bold">尚無工作令</p>
          <p className="mt-1 text-xs">點右上「➕ 開立工作令」建立第一張生產工令</p>
        </div>
      )}

      {/* ===== 工作令清單（紙本格式卡片） ===== */}
      <div className="mt-4 space-y-3">
        {filteredPos.map((w) => {
          const overdue = w.due_date && w.due_date < today && (w.status === '生產中' || w.status === '待確認');
          const dueToday = w.due_date === today && (w.status === '生產中' || w.status === '待確認');
          const colors = COLOR_SLOTS.map((label, i) => {
            const key = ['color_a', 'color_b', 'color_c', 'color_d', 'color_e'][i];
            const qkey = ['qty_a', 'qty_b', 'qty_c', 'qty_d', 'qty_e'][i];
            return w[key] ? { label, color: w[key], qty: w[qkey] } : null;
          }).filter(Boolean);
          return (
            <div
              key={w.wo_id}
              className={`rounded-3xl bg-white p-4 shadow-card ${
                overdue ? 'border-2 border-red-400' : dueToday ? 'border-2 border-amber-300' : 'border border-slate-100'
              }`}
            >
              {/* 卡頭：編號 + 狀態 + 流向 */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">{w.wo_id}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${PWO_STATUS_COLORS[w.status] || 'bg-slate-100 text-slate-600'}`}>
                      {w.status}
                    </span>
                    {overdue && <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">逾期</span>}
                  </div>
                  <h3 className="mt-1 text-lg font-extrabold leading-snug text-slate-900">{w.style_no}</h3>
                  {w.customer && <p className="text-xs font-semibold text-slate-500">客戶：{w.customer}</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${DEST_BADGE[w.destination] || 'bg-slate-100 text-slate-600'}`}>
                  {w.destination === '入倉庫備庫' ? '📥 入倉庫備庫' : '🚚 訂單出貨'}
                </span>
              </div>

              {/* 單頭資訊 */}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
                <span className="text-slate-700">
                  總計 <b className="tabular-nums">{w.plan_qty}</b> 頂
                </span>
                <span className={dueCls(w)}>
                  交期 {w.due_date || '—'}
                  {dueToday && '（今日）'}
                </span>
                {w.order_ref && <span className="text-slate-500">📄 {w.order_ref}</span>}
              </div>

              {/* 配色明細 */}
              {colors.length > 0 && (
                <div className="mt-2 rounded-2xl bg-slate-50 p-2.5">
                  <p className="text-[10px] font-bold text-slate-400">配色（顏色以頭頂顏色為準）</p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold text-slate-700">
                    {colors.map((c) => (
                      <span key={c.label}>
                        {c.label}: <b>{c.color}</b>
                        {c.qty ? ` ×${c.qty}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 工序備註 */}
              {(w.process_setting || w.process_sewing || w.process_packing) && (
                <details className="mt-2 rounded-2xl bg-amber-50 p-2.5">
                  <summary className="cursor-pointer text-xs font-bold text-amber-700">🛠️ 工序資訊（定型／平車／包裝）</summary>
                  <div className="mt-1 space-y-1 text-xs font-semibold text-slate-700">
                    {w.process_setting && (
                      <p>
                        <span className="text-slate-400">定型：</span>
                        <span className="whitespace-pre-wrap">{w.process_setting}</span>
                      </p>
                    )}
                    {w.process_sewing && (
                      <p>
                        <span className="text-slate-400">平車：</span>
                        <span className="whitespace-pre-wrap">{w.process_sewing}</span>
                      </p>
                    )}
                    {w.process_packing && (
                      <p>
                        <span className="text-slate-400">包裝：</span>
                        <span className="whitespace-pre-wrap">{w.process_packing}</span>
                      </p>
                    )}
                  </div>
                </details>
              )}

              {/* 領紗明細 */}
              {w.yarn_lines && w.yarn_lines.length > 0 && (
                <div className="mt-2 rounded-2xl bg-sky-50 p-2.5">
                  <p className="text-[10px] font-bold text-slate-400">🧵 領紗明細（投產時自動扣 YARN_INVENTORY）</p>
                  <ul className="mt-1 space-y-0.5 text-xs font-semibold text-slate-700">
                    {w.yarn_lines.map((l) => (
                      <li key={l.yarn_code} className="flex items-baseline justify-between gap-2">
                        <span className="truncate">
                          {l.yarn_name || l.yarn_code}
                          <span className="text-slate-400">
                            （{fmtQty(l.kg_per_unit)} KG/頂 × {w.plan_qty} = {fmtQty(l.total_kg)} KG · {l.source}）
                          </span>
                        </span>
                        <span className={`shrink-0 ${l.deducted ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {l.deducted ? '已扣' : '預估'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 完工資訊 */}
              {(w.actual_good_qty !== null && w.actual_good_qty !== undefined || w.completed_time) && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-slate-600">
                  {w.actual_good_qty !== null && w.actual_good_qty !== undefined && (
                    <span>
                      良品 <b className="tabular-nums">{w.actual_good_qty}</b> 頂
                    </span>
                  )}
                  {w.completed_time && <span className="text-xs text-slate-400">完工：{w.completed_time}{w.confirmed_operator ? `（${w.confirmed_operator}）` : ''}</span>}
                </div>
              )}
              {w.remark && <p className="mt-1 text-xs text-slate-500">📝 {w.remark}</p>}

              {/* 操作按鈕 */}
              {w.status === '草稿' && (
                <button
                  onClick={() => openStart(w)}
                  className="mt-3 min-h-touch w-full rounded-2xl bg-blue-700 py-2.5 text-base font-extrabold text-white transition active:bg-blue-800 active:scale-[0.98]"
                >
                  ▶ 投產扣紗{w.yarn_lines.length > 0 ? `（${w.yarn_lines.length} 種紗線）` : ''}
                </button>
              )}
              {(w.status === '生產中' || w.status === '待確認') && (
                <button
                  onClick={() => openComplete(w)}
                  className="mt-3 min-h-touch w-full rounded-2xl bg-emerald-600 py-2.5 text-base font-extrabold text-white transition active:bg-emerald-700 active:scale-[0.98]"
                >
                  ✅ 確認完工
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
              <h3 className="text-lg font-extrabold">選擇型號</h3>
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
                    {s.category && <span className="float-right text-xs text-slate-400">{s.category}</span>}
                  </button>
                </li>
              ))}
              {styleOptions.length === 0 && (
                <li className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                  庫存主檔尚無品名，可直接在上方手動輸入型號。
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      {/* ===== 紗線選擇（手動指定列） ===== */}
      {yarnPickerRow !== null && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setYarnPickerRow(null)}
        >
          <div
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">選擇紗線</h3>
              <button className="text-slate-400" onClick={() => setYarnPickerRow(null)}>✕</button>
            </div>
            <input
              className="field-input mb-3"
              placeholder="搜尋：代碼 / 紗名 / 色號…"
              value={yarnFilter}
              onChange={(e) => setYarnFilter(e.target.value)}
            />
            <ul className="space-y-2">
              {yarnCandidateOptions.map((y) => (
                <li key={y.yarn_code}>
                  <button
                    onClick={() => {
                      setDraftYarns((rows) =>
                        rows.map((row, j) => (j === yarnPickerRow ? { ...row, yarn_code: y.yarn_code } : row)),
                      );
                      setYarnPickerRow(null);
                    }}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition active:bg-sky-100"
                  >
                    <b>{y.yarn_name}</b>{y.color && <span className="text-slate-500">（{y.color}）</span>}
                    <span className="float-right font-black text-slate-700">{fmtQty(y.stock_kg)} KG</span>
                    <p className="font-mono text-[10px] text-slate-400">{y.yarn_code}</p>
                  </button>
                </li>
              ))}
              {yarnCandidateOptions.length === 0 && (
                <li className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                  尚無紗線資料，請先在下方「紗線庫存」建檔。
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
              placeholder={`搜尋（預設列成品，例：${completing?.style_no || '型號'}）…`}
              value={cTargetFilter}
              onChange={(e) => setCTargetFilter(e.target.value)}
            />
            <p className="mb-2 px-1 text-xs font-bold text-slate-400">
              目前選擇：{cTarget ? `${cTarget.item_name}（${cTarget.color_spec || '無色號'}）` : '未選擇'}
            </p>
            <ul className="space-y-2">
              {items
                .filter((it) => {
                  const f = cTargetFilter.trim().toLowerCase();
                  if (!f) return it.category === '成品' || !it.category;
                  return `${it.item_name} ${it.color_spec} ${it.item_code} ${it.category}`.toLowerCase().includes(f);
                })
                .slice(0, 200)
                .map((it) => (
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
        title={draft.start_now ? '確認開立＋投產' : '確認開立工作令'}
        confirmText={draft.start_now ? '開立並投產' : '確認開立'}
        danger={previewDeduct(draftYarnNeed, draftQty).shortage}
        onClose={() => !createBusy && setCreateConfirmOpen(false)}
        onConfirm={handleCreateConfirm}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          <Row label="編號" value={draft.wo_id.trim() ? `#${draft.wo_id.trim().replace(/^#/, '')}` : '自動編號'} />
          <Row label="客戶" value={draft.customer.trim() || '—'} />
          <Row label="型號 / 總計" value={`${draft.style_no.trim()} × ${draftQty} 頂`} strong />
          <Row label="預計交期" value={draft.due_date || '—'} />
          <Row label="配色" value={draft.colors.filter((c) => c.color.trim()).map((c) => `${c.color}${String(c.qty).trim() !== '' ? `×${c.qty}` : ''}`).join('、')} />
          <Row label="流向" value={draft.destination} />
          <Row label="訂單編號" value={draft.order_ref.trim() || '—'} />
          {draftYarnNeed.length > 0 &&
            previewDeduct(draftYarnNeed, draftQty).rows.map((r) => (
              <div key={r.yarn_code} className="rounded-xl bg-white px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold text-slate-700">
                    🧵 {r.yarn_name || r.yarn_code}
                  </span>
                  <span className="shrink-0 font-black tabular-nums text-slate-800">領 {r.need} KG</span>
                </div>
                {draft.start_now && (
                  <p className={`text-xs font-bold ${r.after !== null && r.after < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                    庫存 {r.stock === null ? '—' : r.stock} → {r.after === null ? '—' : r.after} KG
                    {r.after !== null && r.after < 0 ? '（透支，仍照扣）' : ''}
                    {r.missing ? '（⚠️ 紗線檔不存在，不可投產扣紗）' : ''}
                  </p>
                )}
              </div>
            ))}
          <Row
            label="後續"
            value={
              draft.start_now
                ? '立即轉「生產中」並自動扣紗'
                : '先存「草稿」，投產時才扣紗'
            }
          />
        </div>
      </ConfirmDialog>

      {/* ===== 投產扣紗確認 ===== */}
      <ConfirmDialog
        open={!!starting}
        busy={startBusy}
        title="🏭 確認投產（扣紗）"
        confirmText="投產並扣紗"
        danger={starting ? previewDeduct(starting.yarn_lines || [], starting.plan_qty).shortage : false}
        onClose={() => !startBusy && setStarting(null)}
        onConfirm={handleStartConfirm}
      >
        {starting && (
          <div className="mt-4 space-y-3">
            <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
              <Row label="工令" value={`${starting.wo_id}（草稿）`} />
              <Row label="型號 / 總計" value={`${starting.style_no} × ${starting.plan_qty} 頂`} strong />
              <Row label="客戶" value={starting.customer || '—'} />
            </div>
            {(starting.yarn_lines || []).length === 0 ? (
              <p className="rounded-2xl bg-amber-50 p-3 text-sm font-bold text-amber-700">
                ⚠️ 此工令沒有領紗明細（未指定紗線且 BOM 無紗線列），投產不會扣任何紗線。
              </p>
            ) : (
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-sm font-extrabold text-slate-700">🧵 領紗扣減預覽</p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {previewDeduct(starting.yarn_lines || [], starting.plan_qty).rows.map((r) => (
                    <li key={r.yarn_code} className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-semibold text-slate-700">{r.yarn_name || r.yarn_code}</span>
                      <span className={`shrink-0 font-black tabular-nums ${r.after !== null && r.after < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                        {r.stock === null ? '庫存未知' : `${r.stock} → ${r.after}`} KG
                      </span>
                    </li>
                  ))}
                </ul>
                {previewDeduct(starting.yarn_lines || [], starting.plan_qty).shortage && (
                  <p className="mt-2 text-xs font-bold text-red-600">
                    ⚠️ 有紗線領用後會透支（負庫存仍照扣，請事後補正或檢討用量）
                  </p>
                )}
                <p className="mt-2 text-[10px] text-slate-400">投產後此工令狀態改為「生產中」，紗線立即自 YARN_INVENTORY 扣減並寫入領料紀錄。</p>
              </div>
            )}
          </div>
        )}
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
              <Row label="工令" value={`${completing.wo_id}（${completing.status}）`} />
              <Row label="型號 / 流向" value={`${completing.style_no} ／ ${completing.destination}`} />
              <Row label="客戶 / 總計" value={`${completing.customer || '—'} ／ ${completing.plan_qty} 頂`} />
            </div>

            <div>
              <label className="field-label">實際完工良品數（預設 = 預計產量）</label>
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

            {completing.destination === '入倉庫備庫' && (
              <div>
                <label className="field-label">成品入庫料號（必選 → INVENTORY_MASTER）</label>
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

            {completing.destination === '訂單出貨' && (
              <p className="rounded-2xl bg-orange-50 p-3 text-xs font-bold text-orange-700">
                🚚 訂單出貨：不入一般成品庫，結案後轉「待出貨」；請到「出庫出貨」分頁開立出貨單
                （欄位可直接輸出 Commercial Invoice / Packing List）。
              </p>
            )}

            {cNonYarnBomRows.length > 0 && (
              <div className="rounded-2xl bg-slate-50 p-3">
                <label className="flex items-center gap-2 text-sm font-extrabold text-slate-700">
                  <input
                    type="checkbox"
                    checked={cUseBom}
                    onChange={(e) => setCUseBom(e.target.checked)}
                    className="h-5 w-5 accent-emerald-600"
                  />
                  依 BOM 扣「非紗線」原料（紗線已於投產扣除，不重複扣）
                </label>
                {cUseBom && (
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {cNonYarnBomRows.map((b) => {
                      const need = fmtQty(Number(b.unit_use) * Number(cActual || 0));
                      const stock = itemsByKey.get(b.item_code)?.stock_qty;
                      const after = typeof stock === 'number' ? fmtQty(stock - Number(b.unit_use) * Number(cActual || 0)) : null;
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
              <label className="field-label">完工經辦</label>
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
                placeholder="例：良品後另有 20 頂待重工"
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
            <Row label="工令" value={shipWo.wo_id} />
            <Row label="型號" value={shipWo.style_no} />
            <Row label="良品 / 總計" value={`${shipWo.actual_good_qty ?? '—'} / ${shipWo.plan_qty} 頂`} />
            <Row label="客戶 / 訂單" value={`${shipWo.customer || '—'} / ${shipWo.order_ref || '—'}`} />
            <p className="mt-2 text-xs text-slate-400">
              登記後狀態改為「已出貨」並留存完工時間；實際出庫與 Commercial Invoice /
              Packing List 請在「出庫出貨」分頁開立出貨單（未入庫之訂單出貨工令需用覆核通過）。
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-right ${strong ? 'text-lg font-black' : 'font-semibold'} text-slate-800`}>{value}</span>
    </div>
  );
}
