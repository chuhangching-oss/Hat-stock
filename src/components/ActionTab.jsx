import { useEffect, useRef, useState } from 'react';
import { CATEGORY_COLORS, LOW_STOCK_THRESHOLD } from '../constants';
import { getOperator, gasRequest, getGasUrl } from '../api';
import PhotoButton from './PhotoButton';
import ConfirmDialog from './ConfirmDialog';

const MODES = [
  {
    key: 'IN',
    label: '📥 入庫',
    activeCls: 'bg-emerald-600 text-white shadow-card',
    inactiveCls: 'bg-white text-emerald-600 ring-2 ring-emerald-600',
  },
  {
    key: 'OUT',
    label: '📤 出庫',
    activeCls: 'bg-red-600 text-white shadow-card',
    inactiveCls: 'bg-white text-red-600 ring-2 ring-red-600',
  },
  {
    key: 'COUNT',
    label: '🧮 盤點',
    activeCls: 'bg-blue-700 text-white shadow-card',
    inactiveCls: 'bg-white text-blue-700 ring-2 ring-blue-700',
  },
];

const CATEGORIES = ['原料', '半成品', '成品'];

/** 新品項表單預設值（品號留空 → 後端自動編號 A####） */
const EMPTY_DRAFT = {
  item_code: '',
  item_name: '',
  color_spec: '',
  category: '成品',
  unit: 'PCS',
  location: '',
};

/** 掃碼／手動輸入文字 → 對應料件（先比對序號，再比對品名） */
function resolveByScan(items, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const hay = (it) =>
    [String(it.item_code), String(it.item_name)].join(' ').toLowerCase();
  return (
    items.find((it) => String(it.item_code).toLowerCase() === t) ||
    items.find((it) => String(it.item_name).toLowerCase() === t) ||
    (t.length >= 4 ? items.find((it) => hay(it).includes(t)) : null) ||
    null
  );
}

function itemTitle(it) {
  if (!it) return '';
  return it.color_spec ? `${it.item_name}（${it.color_spec}）` : it.item_name;
}

function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * 分頁 2：出入庫 － 批次填報（購物車模式）
 * 三層結構：
 *  ① 單頭：異動類型／經辦人／（出庫）客戶＋箱號或單據備註
 *  ② 連續加入區：選取／掃碼 → 帶出品名・顏色・在庫 → 輸入數量 →【＋ 加入清單】
 *     加入後自動清空並重新打開選取清單，方便立刻掃「下一筆」
 *  ③ 暫存清單＋即時統計（sticky）：總品項數／總款數／總件數，
 *     出庫任一列超過在庫 → 紅字並阻擋送出；底部【一鍵確認送出（共 M 件）】
 * - 盤點：每列輸入的是「盤點後實際庫存量」
 * - 出庫且有填客戶 → 送出時後端會一併建立出貨單（SHIPMENT_ORDERS/DETAILS）
 * - 入庫新品項：保留原「直接入庫新品項（自動建主檔）」單筆流程
 */
export default function ActionTab({
  items,
  onSubmit,
  onBatchSubmit,
  onOpenScanner,
  scanResult,
  showToast,
  onPhotoUploaded,
}) {
  // ===== 模式 / 暫存清單 =====
  const [mode, setMode] = useState('IN');
  const [lines, setLines] = useState([]); // [{ item, qty }]
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const qtyRef = useRef(null);

  // ===== 單頭 =====
  const [operator, setOperator] = useState(() => getOperator());
  const [remark, setRemark] = useState('');
  const [operators, setOperators] = useState(null); // null=載入中；[]=名冊空；[{code,name}]
  const [opPickerOpen, setOpPickerOpen] = useState(false);
  const [manualOp, setManualOp] = useState('');
  // 出庫：客戶（清單選取 / 手動輸入）
  const [customers, setCustomers] = useState(null);
  const [custName, setCustName] = useState('');
  const [newCustName, setNewCustName] = useState('');
  const [newCustCountry, setNewCustCountry] = useState('');
  const [saveNewCust, setSaveNewCust] = useState(true);
  const [custQuickOpen, setCustQuickOpen] = useState(false);

  // ===== 選取清單 =====
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');

  // ===== 新品項（單筆入庫，保留原流程） =====
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const loadOperators = async () => {
    setOperators(null);
    try {
      const list = await gasRequest(getGasUrl(), { action: 'list_operators' });
      setOperators(Array.isArray(list) ? list : []);
    } catch (e) {
      setOperators([]);
      showToast(`⚠️ 經辦人名冊載入失敗：${e.message}`, 'error');
    }
  };

  const loadCustomers = async () => {
    setCustomers(null);
    try {
      const list = await gasRequest(getGasUrl(), { action: 'list_customers' });
      setCustomers(Array.isArray(list) ? list : []);
    } catch (e) {
      setCustomers([]);
      showToast(`⚠️ 客戶清單載入失敗：${e.message}`, 'error');
    }
  };

  useEffect(() => {
    loadOperators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切到出庫時才載入客戶清單
  useEffect(() => {
    if (mode === 'OUT' && customers === null) loadCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const meta = () => MODES.find((m) => m.key === mode);
  const modeLabel = meta().label.replace(/^[^ ]+ /, '');

  // 掃碼／手動輸入結果 → 帶出料件並聚焦數量
  useEffect(() => {
    if (scanResult && scanResult.code && !newOpen) {
      const found = resolveByScan(items, scanResult.code);
      if (found) {
        setSelected(found);
        setQty('');
        setTimeout(() => qtyRef.current && qtyRef.current.focus(), 50);
      } else {
        showToast(`❌ 找不到對應料件：${scanResult.code}`, 'error');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanResult && scanResult.seq]);

  /** 加入清單（同品號已在清單 → 提示去改那列數量） */
  function handleAddToList() {
    if (!selected) return showToast('❌ 請先選取或掃描料件', 'error');
    const q = Number(qty);
    const ok = mode === 'COUNT' ? (qty !== '' && isFinite(q) && q >= 0) : q > 0;
    if (!ok) return showToast('❌ 請輸入異動數量（盤點可為 0）', 'error');
    const exists = lines.some(
      (l) => String(l.item.item_code).toLowerCase() === String(selected.item_code).toLowerCase(),
    );
    if (exists) {
      showToast(`⚠️ ${itemTitle(selected)} 已在清單中，請直接修改該列數量`, 'error');
      return;
    }
    setLines((prev) => [...prev, { item: selected, qty: qty }]);
    // 自動清空 + 聚焦：立刻可掃／選「下一筆」
    setSelected(null);
    setQty('');
    setPickerOpen(true);
  }

  const setLineQty = (idx) => (e) => {
    const v = e.target.value;
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty: v } : l)));
  };

  function removeLine(idx) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // ===== 即時統計 =====
  const lineQtyValid = (l) => isFinite(Number(l.qty)) && Number(l.qty) > 0;
  const totalQty = lines.reduce((s, l) => s + (lineQtyValid(l) ? Number(l.qty) : 0), 0);
  const styleCount = new Set(lines.map((l) => l.item.item_name).filter(Boolean)).size;
  const overLines =
    mode === 'OUT'
      ? lines.filter((l) => lineQtyValid(l) && Number(l.qty) > (l.item.stock_qty || 0))
      : [];
  const custIsManual = newCustName.trim() !== '';
  const finalCustomer =
    mode === 'OUT' ? (custIsManual ? newCustName.trim() : custName.trim()) : '';

  const allFilled = lines.length > 0 && lines.every((l) => (mode === 'COUNT' ? isFinite(Number(l.qty)) && Number(l.qty) >= 0 : lineQtyValid(l)));
  const canSubmit = allFilled && overLines.length === 0 && !!operator.trim();

  // 新品項（單筆入庫）：以草稿資料當作料件（庫存由 0 起算）
  const newItem = { ...draft, stock_qty: 0, unit: draft.unit.trim() || 'PCS' };
  const newQtyNum = Number(qty);
  const newQtyValid = isFinite(newQtyNum) && newQtyNum > 0;
  const newAfter = newQtyValid ? newQtyNum : 0;

  const filteredPicker = items.filter((it) => {
    const f = pickerFilter.trim().toLowerCase();
    if (!f) return true;
    return `${it.item_code} ${it.item_name} ${it.color_spec} ${it.category}`.toLowerCase().includes(f);
  });

  function handleOpenConfirm() {
    if (!lines.length) return showToast('❌ 清單尚未加入任何品項', 'error');
    if (!allFilled) return showToast('❌ 尚有品項未填數量（盤點可為 0）', 'error');
    if (overLines.length > 0) return showToast(`❌ ${overLines.length} 列出庫量大於在庫量，已阻擋送出`, 'error');
    if (!operator.trim()) return showToast('❌ 請填寫經辦人姓名', 'error');
    setConfirmOpen(true);
  }

  function handleOpenNewConfirm() {
    if (!draft.item_name.trim()) return showToast('❌ 新品項請填寫「品名」', 'error');
    const customCode = draft.item_code.trim().toUpperCase();
    if (customCode && items.some((it) => String(it.item_code).trim().toUpperCase() === customCode)) {
      return showToast(`❌ 品號 ${customCode} 已存在，請改用清單選取，或換一個品號`, 'error');
    }
    if (!newQtyValid) return showToast('❌ 入庫數量必須大於 0', 'error');
    if (!operator.trim()) return showToast('❌ 請填寫經辦人姓名', 'error');
    setConfirmOpen(true);
  }

  /** 批次送出（入庫／出庫／盤點） */
  async function handleConfirm() {
    setBusy(true);
    try {
      // 出庫＋手動輸入客戶＋勾選保存 → 先存入客戶清單
      if (mode === 'OUT' && custIsManual && finalCustomer && saveNewCust) {
        const already = (customers || []).some(
          (c) => String(c.customer_name).toUpperCase() === finalCustomer.toUpperCase(),
        );
        if (!already) {
          await gasRequest(getGasUrl(), {
            action: 'add_customer',
            customer_name: finalCustomer,
            country: newCustCountry.trim(),
          });
          await loadCustomers();
        }
      }
      await onBatchSubmit({
        type: mode === 'COUNT' ? '盤點' : mode, // 後端把 IN→入庫、OUT→出庫
        customer: mode === 'OUT' ? finalCustomer : '',
        operator: operator.trim(),
        remark: remark.trim(),
        items: lines.map((l) => ({ item_code: l.item.item_code, qty: Number(l.qty) })),
      });
      try {
        localStorage.setItem('kfi_operator', operator.trim());
      } catch (e) {
        /* ignore */
      }
      setConfirmOpen(false);
      setLines([]);
      setRemark('');
    } catch (e) {
      /* 失敗：保持彈窗，錯誤已由 App Toast 顯示 */
    } finally {
      setBusy(false);
    }
  }

  /** 新品項單筆入庫（原先流程） */
  async function handleConfirmNewItem() {
    setBusy(true);
    try {
      await onSubmit({
        type: '入庫',
        item_code: draft.item_code.trim().toUpperCase(),
        qty: newQtyNum,
        operator: operator.trim(),
        remark: remark.trim(),
        new_item: {
          item_code: draft.item_code.trim(),
          item_name: draft.item_name.trim(),
          color_spec: draft.color_spec.trim(),
          category: draft.category,
          unit: draft.unit.trim() || 'PCS',
          location: draft.location.trim(),
        },
      });
      try {
        localStorage.setItem('kfi_operator', operator.trim());
      } catch (e) {
        /* ignore */
      }
      setConfirmOpen(false);
      setNewOpen(false);
      setDraft(EMPTY_DRAFT);
      setQty('');
      setRemark('');
    } catch (e) {
      /* 失敗：保持彈窗 */
    } finally {
      setBusy(false);
    }
  }

  function openNew() {
    setSelected(null);
    setNewOpen(true);
  }

  function closeNew() {
    setNewOpen(false);
    setDraft(EMPTY_DRAFT);
  }

  const setDraftField = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <div className={lines.length > 0 ? 'pb-40' : ''}>
      {/* ===== ① 單頭：異動類型 ===== */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setMode(m.key);
              setSelected(null);
              setQty('');
              if (newOpen) closeNew();
            }}
            className={`min-h-touch rounded-2xl text-xl font-extrabold transition active:scale-95 ${
              mode === m.key ? m.activeCls : m.inactiveCls
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* ===== 單頭資訊 ===== */}
      <div className="mt-4 space-y-4 rounded-3xl bg-white p-5 shadow-card">
        {/* 經辦人 */}
        <div>
          <label className="field-label">經辦人（{operator || '未選擇'}）</label>
          <button
            onClick={() => setOpPickerOpen(true)}
            className={`field-input flex items-center justify-between text-left ${operator ? '' : 'text-slate-400'}`}
          >
            <span>{operator || '🧑‍🏭 點此選擇經辦人…'}</span>
            <span className="text-slate-300">▾</span>
          </button>
        </div>

        {/* 出庫：客戶（選填；有填才會建立出貨單） */}
        {mode === 'OUT' && (
          <div>
            <label className="field-label">
              客戶（選填；{finalCustomer ? `已選：${finalCustomer}` : '未填＝不建立出貨單'}）
            </label>
            <div className="flex gap-2">
              <select
                className="field-input flex-1"
                value={custName}
                onChange={(e) => {
                  setCustName(e.target.value);
                  if (e.target.value) setNewCustName('');
                }}
              >
                <option value="">
                  {customers === null ? '⟳ 載入客戶清單中…' : '— 不建立出貨單（一般出庫） —'}
                </option>
                {(customers || []).map((c) => (
                  <option key={c.customer_id} value={c.customer_name}>
                    {c.customer_name}
                    {c.country ? `（${c.country}）` : ''}
                  </option>
                ))}
                {finalCustomer && custIsManual && (
                  <option value={finalCustomer}>{finalCustomer}（手動輸入）</option>
                )}
              </select>
              <button
                onClick={() => setCustQuickOpen(true)}
                className="min-h-touch shrink-0 rounded-2xl bg-slate-700 px-3 text-sm font-extrabold text-white transition active:bg-slate-800 active:scale-95"
              >
                ✏️ 手動
              </button>
            </div>
            {custIsManual && (
              <div className="mt-2 space-y-2">
                <div className="flex gap-2">
                  <input
                    className="field-input flex-1"
                    placeholder="客戶名稱（例：MOONBAT）"
                    value={newCustName}
                    onChange={(e) => setNewCustName(e.target.value)}
                  />
                  <input
                    className="field-input w-24 shrink-0"
                    placeholder="國家（選填）"
                    value={newCustCountry}
                    onChange={(e) => setNewCustCountry(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={saveNewCust}
                    onChange={(e) => setSaveNewCust(e.target.checked)}
                    className="h-5 w-5 accent-blue-700"
                  />
                  送出時存入客戶清單（CUSTOMERS）
                </label>
              </div>
            )}
          </div>
        )}

        {/* 備註 */}
        <div>
          <label className="field-label">
            {mode === 'OUT' ? '出貨單號 / 箱號備註（例：CTN #15-28）' : '備註（工單號 / 箱號，選填）'}
          </label>
          <input
            className="field-input"
            placeholder="選填"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>
      </div>

      {/* ===== ② 連續加入品項區 ===== */}
      {newOpen ? (
        <div className="mt-4 space-y-4 rounded-3xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <span className="text-sm font-extrabold text-emerald-700">
              🆕 入庫新品項（自動建立主檔資料，單筆立即入庫）
            </span>
            <button onClick={closeNew} className="text-xs font-bold text-slate-400">
              改用清單選取
            </button>
          </div>
          <input
            className="field-input"
            placeholder="品號（留空 → 自動編號 A####）"
            value={draft.item_code}
            onChange={setDraftField('item_code')}
          />
          <input
            className="field-input"
            placeholder="品名（必填，例：111AG20/6090R-G-D）"
            value={draft.item_name}
            onChange={setDraftField('item_name')}
          />
          <input
            className="field-input"
            placeholder="顏色（例：可可）"
            value={draft.color_spec}
            onChange={setDraftField('color_spec')}
          />
          <div className="grid grid-cols-3 gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setDraft((d) => ({ ...d, category: c }))}
                className={`min-h-touch rounded-2xl text-base font-extrabold transition active:scale-95 ${
                  draft.category === c
                    ? 'bg-blue-700 text-white shadow-card'
                    : 'bg-white text-slate-500 ring-2 ring-slate-200'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="field-input"
              placeholder="單位（預設 PCS）"
              value={draft.unit}
              onChange={setDraftField('unit')}
            />
            <input
              className="field-input"
              placeholder="儲位（選填）"
              value={draft.location}
              onChange={setDraftField('location')}
            />
          </div>
          <div>
            <label className="field-label">入庫數量（{draft.unit.trim() || 'PCS'}）</label>
            <input
              ref={qtyRef}
              className="field-input text-3xl font-black tabular-nums"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <button className="btn-primary" onClick={handleOpenNewConfirm}>
            入庫「{newItem.item_name.trim() || '新品項'} × {newQtyValid ? newQtyNum : '?'}」
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-4 rounded-3xl bg-white p-5 shadow-card">
          {/* 選取／掃碼 */}
          <div>
            <label className="field-label">料件（已選：{selected ? itemTitle(selected) : '未選擇'}）</label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setPickerFilter('');
                  setPickerOpen(true);
                }}
                className={`field-input flex-1 truncate text-left ${selected ? 'bg-blue-50/60' : 'text-slate-400'}`}
              >
                {selected ? itemTitle(selected) : '📋 點此從清單選取帽型…'}
              </button>
              <PhotoButton
                items={items}
                item={selected}
                onUploaded={onPhotoUploaded}
                showToast={showToast}
              />
              <button
                onClick={onOpenScanner}
                aria-label="相機掃描帶出料件"
                className="flex w-16 shrink-0 flex-col items-center justify-center rounded-2xl bg-blue-700 text-white transition active:bg-blue-800 active:scale-95"
              >
                <span className="text-2xl leading-none">📷</span>
                <span className="mt-0.5 text-[10px] font-bold">掃碼</span>
              </button>
            </div>

            {/* 選定後即時顯示目前在庫 */}
            {selected && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 p-3 text-sm">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                    CATEGORY_COLORS[selected.category] || 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {selected.category}
                </span>
                <b className="text-slate-800">{selected.item_name}</b>
                {selected.color_spec && <span className="text-slate-500">{selected.color_spec}</span>}
                {selected.location && <span className="text-slate-500">📍{selected.location}</span>}
                <span
                  className={`ml-auto text-lg font-black tabular-nums ${
                    selected.stock_qty <= LOW_STOCK_THRESHOLD ? 'text-red-600' : 'text-slate-900'
                  }`}
                >
                  在庫 {selected.stock_qty} {selected.unit}
                </span>
              </div>
            )}

            {/* 清單沒有時：入庫可直接建立新品項 */}
            {mode === 'IN' && (
              <button
                onClick={openNew}
                className="mt-2 w-full rounded-2xl border-2 border-dashed border-emerald-400 py-2.5 text-sm font-extrabold text-emerald-600 transition active:scale-[0.98] active:bg-emerald-50"
              >
                ➕ 清單沒有？直接入庫新品項
              </button>
            )}
          </div>

          {/* 數量 */}
          <div>
            <label className="field-label">
              {mode === 'COUNT' ? '盤點後實際庫存量' : '異動數量'}（{selected ? selected.unit : 'PCS'}）
            </label>
            <input
              ref={qtyRef}
              className="field-input text-3xl font-black tabular-nums"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddToList();
              }}
            />
          </div>

          {/* 【＋ 加入清單】大按鈕 */}
          <button
            onClick={handleAddToList}
            className={`min-h-touch w-full rounded-2xl text-lg font-extrabold text-white shadow-card transition active:scale-[0.98] ${
              mode === 'IN'
                ? 'bg-emerald-600 active:bg-emerald-700'
                : mode === 'OUT'
                  ? 'bg-red-600 active:bg-red-700'
                  : 'bg-blue-700 active:bg-blue-800'
            }`}
          >
            ＋ 加入清單（Add to List）
          </button>
        </div>
      )}

      {/* ===== ③ 已選品項清單（動態表格） ===== */}
      <div className="mt-4 space-y-2">
        <p className="px-1 text-xs font-bold text-slate-400">
          已加入 {lines.length} 項（點數量可直接修改、🗑️ 可刪除）
        </p>
        {lines.map((l, idx) => {
          const q = Number(l.qty);
          const valid = isFinite(q) && (mode === 'COUNT' ? q >= 0 : q > 0);
          const over = mode === 'OUT' && valid && q > (l.item.stock_qty || 0);
          return (
            <div
              key={l.item.item_code}
              className={`rounded-2xl bg-white p-3 shadow-card ${over ? 'border-2 border-red-400' : 'border border-slate-100'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-black text-slate-400">#{idx + 1}</span>
                    <span className="font-mono text-xs text-slate-400">{l.item.item_code}</span>
                  </div>
                  <h3 className="mt-0.5 text-base font-extrabold leading-snug text-slate-900">
                    {l.item.item_name}
                    {l.item.color_spec && <span className="text-slate-500">（{l.item.color_spec}）</span>}
                  </h3>
                </div>
                <div className="flex shrink-0 items-baseline gap-2 text-sm font-bold">
                  <span className="text-slate-500">
                    {mode === 'COUNT' ? '盤後' : '在庫'}{' '}
                    <b className="tabular-nums text-slate-800">{l.item.stock_qty}</b>
                  </span>
                  <button
                    onClick={() => removeLine(idx)}
                    aria-label="從清單刪除"
                    className="rounded-xl bg-red-100 px-2 py-1 text-red-600 transition active:bg-red-200 active:scale-95"
                  >
                    🗑️
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="w-16 shrink-0 text-xs font-bold text-slate-500">
                  {mode === 'COUNT' ? '盤後庫存' : '異動量'}
                </span>
                <input
                  className={`field-input flex-1 tabular-nums ${over ? 'border-red-400 text-red-600' : ''}`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={l.qty}
                  onChange={setLineQty(idx)}
                />
                <span className="shrink-0 text-xs font-bold text-slate-500">{l.item.unit}</span>
              </div>
              {over && (
                <p className="mt-1 text-xs font-extrabold text-red-600">
                  ⚠️ 出庫 {fmtQty(q)} 大於在庫 {l.item.stock_qty}，已阻擋送出
                </p>
              )}
            </div>
          );
        })}
        {lines.length === 0 && (
          <div className="rounded-3xl bg-white p-5 text-center text-sm text-slate-400">
            還沒有加入品項 —— 在上方選取／掃碼料件後按「＋ 加入清單」
          </div>
        )}
      </div>

      {/* ===== Sticky 統計列＋送出大按鈕 ===== */}
      {lines.length > 0 && (
        <div
          className="fixed inset-x-0 z-20 mx-auto max-w-lg px-4"
          style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}
        >
          <div className="rounded-3xl bg-white p-3 shadow-card ring-2 ring-slate-300">
            <div className="flex items-baseline justify-between px-1 text-sm font-extrabold text-slate-700">
              <span>
                總品項：<b className="text-lg text-blue-700">{lines.length}</b> 項
              </span>
              <span className="text-slate-500">共 {styleCount} 款</span>
              <span>
                總件數：
                <b className="text-lg text-blue-700">{fmtQty(totalQty)}</b>
              </span>
            </div>
            {overLines.length > 0 && (
              <p className="mt-1 px-1 text-xs font-extrabold text-red-600">
                ⚠️ {overLines.length} 列出庫量大於在庫量，已阻擋送出
              </p>
            )}
            <button className="btn-primary mt-2" disabled={!canSubmit || busy} onClick={handleOpenConfirm}>
              {busy ? '送出中…' : `一鍵確認送出（共 ${fmtQty(totalQty)} 件）`}
            </button>
          </div>
        </div>
      )}

      {/* ===== 料件選取清單（品名搜尋） ===== */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">選擇料件（還要加第 {lines.length + 1} 項）</h3>
              <button className="text-slate-400" onClick={() => setPickerOpen(false)}>✕</button>
            </div>
            <div className="mb-3 flex gap-2">
              <input
                className="field-input flex-1"
                placeholder="搜尋：帽型 / 顏色 / 品號"
                value={pickerFilter}
                onChange={(e) => setPickerFilter(e.target.value)}
              />
              <button
                onClick={() => {
                  setPickerOpen(false);
                  setTimeout(() => onOpenScanner(), 10);
                }}
                className="flex w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-blue-700 text-white transition active:bg-blue-800 active:scale-95"
              >
                <span className="text-2xl leading-none">📷</span>
                <span className="mt-0.5 text-[10px] font-bold">掃碼</span>
              </button>
            </div>
            <p className="mb-2 px-1 text-xs font-bold text-slate-400">共 {filteredPicker.length} 筆</p>
            <ul className="space-y-2">
              {filteredPicker.slice(0, 200).map((it) => (
                <li key={it.item_code}>
                  <button
                    onClick={() => {
                      const dup = lines.some(
                        (l) => String(l.item.item_code).toLowerCase() === String(it.item_code).toLowerCase(),
                      );
                      if (dup) {
                        showToast(`⚠️ ${itemTitle(it)} 已在清單中，請直接修改該列數量`, 'error');
                        setPickerOpen(false);
                        return;
                      }
                      setSelected(it);
                      setQty('');
                      setPickerOpen(false);
                    }}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition active:bg-blue-100"
                  >
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        CATEGORY_COLORS[it.category] || 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {it.category}
                    </span>
                    {'  '}
                    <b>{it.item_name}</b>
                    {it.color_spec && <span className="text-slate-500">（{it.color_spec}）</span>}
                    <span className="float-right font-black text-slate-700">
                      {it.stock_qty} {it.unit}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {filteredPicker.length > 200 && (
              <p className="mt-2 text-center text-xs text-slate-400">只顯示前 200 筆，請用搜尋縮小範圍</p>
            )}
          </div>
        </div>
      )}

      {/* ===== 經辦人名冊選單 ===== */}
      {opPickerOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setOpPickerOpen(false)}
        >
          <div
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">選擇經辦人</h3>
              <button className="text-slate-400" onClick={() => setOpPickerOpen(false)}>✕</button>
            </div>
            <button
              onClick={loadOperators}
              disabled={operators === null}
              className="mb-3 min-h-touch w-full rounded-2xl bg-slate-100 text-base font-bold text-slate-700 transition active:bg-slate-200 disabled:opacity-50"
            >
              {operators === null ? '⟳ 載入名冊中…' : '🔁 重新載入名冊'}
            </button>
            {operators !== null && operators.length === 0 && (
              <div className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold leading-6 text-slate-600">
                名冊目前是空的。請到 Google 試算表 <b>OPERATORS</b> 分頁，在「姓名」欄填入人員，填完按「🔁 重新載入名冊」。
              </div>
            )}
            {operators !== null && operators.length > 0 && (
              <ul className="space-y-2">
                {operators.map((op) => (
                  <li key={op.code}>
                    <button
                      onClick={() => {
                        setOperator(`${op.code}-${op.name}`);
                        try {
                          localStorage.setItem('kfi_operator', `${op.code}-${op.name}`);
                        } catch (e) {
                          /* ignore */
                        }
                        setOpPickerOpen(false);
                      }}
                      className="w-full rounded-2xl bg-slate-50 p-3 text-left text-base font-bold text-slate-800 transition active:bg-blue-100"
                    >
                      <span className="mr-2 font-mono text-slate-400">{op.code}</span>
                      {op.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 border-t border-dashed border-slate-200 pt-3">
              <div className="flex gap-2">
                <input
                  className="field-input flex-1"
                  placeholder="✏️ 臨時輸入未登記人員"
                  value={manualOp}
                  onChange={(e) => setManualOp(e.target.value)}
                />
                <button
                  onClick={() => {
                    const v = manualOp.trim();
                    if (!v) return;
                    setOperator(v);
                    try {
                      localStorage.setItem('kfi_operator', v);
                    } catch (e) {
                      /* ignore */
                    }
                    setManualOp('');
                    setOpPickerOpen(false);
                  }}
                  className="min-h-touch rounded-2xl bg-slate-700 px-4 text-base font-extrabold text-white transition active:bg-slate-800 active:scale-95"
                >
                  加入
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== 客戶手動輸入彈窗 ===== */}
      {custQuickOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setCustQuickOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">✏️ 手動輸入客戶</h3>
              <button className="text-slate-400" onClick={() => setCustQuickOpen(false)}>✕</button>
            </div>
            <input
              className="field-input"
              placeholder="客戶名稱（例：MOONBAT）"
              value={newCustName}
              onChange={(e) => setNewCustName(e.target.value)}
            />
            <input
              className="field-input mt-2"
              placeholder="國家（選填，例：JP）"
              value={newCustCountry}
              onChange={(e) => setNewCustCountry(e.target.value)}
            />
            <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={saveNewCust}
                onChange={(e) => setSaveNewCust(e.target.checked)}
                className="h-5 w-5 accent-blue-700"
              />
              送出時存入客戶清單（CUSTOMERS）
            </label>
            <button
              onClick={() => {
                if (!newCustName.trim()) return showToast('❌ 請填寫客戶名稱', 'error');
                setCustName('');
                setCustQuickOpen(false);
              }}
              className="btn-primary mt-3"
            >
              決定
            </button>
          </div>
        </div>
      )}

      {/* ===== 二次確認（批次送出） ===== */}
      <ConfirmDialog
        open={confirmOpen && !newOpen}
        busy={busy}
        confirmText="確認批次送出"
        onClose={() => !busy && setConfirmOpen(false)}
        onConfirm={handleConfirm}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          <Row label="異動類型" value={meta().label} />
          {mode === 'OUT' && <Row label="客戶" value={finalCustomer || '（不建立出貨單）'} />}
          <Row label="經辦人" value={operator || '—'} />
          {remark.trim() && <Row label="備註 / 箱號" value={remark.trim()} />}
          <Row label="總品項數" value={`${lines.length} 項（${styleCount} 款）`} />
          <Row label="總件數" value={`${fmtQty(totalQty)} PCS`} strong />
        </div>

        <div className="mt-3 max-h-60 overflow-y-auto rounded-2xl border border-slate-100">
          <ul className="divide-y divide-slate-100">
            {lines.map((l, idx) => {
              const over = mode === 'OUT' && Number(l.qty) > (l.item.stock_qty || 0);
              return (
                <li key={l.item.item_code} className="flex items-baseline justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-semibold text-slate-700">
                    <span className="mr-1 text-slate-400">#{idx + 1}</span>
                    <b>{l.item.item_name}</b>
                    {l.item.color_spec && <span className="text-slate-500">（{l.item.color_spec}）</span>}
                  </span>
                  <span className={`shrink-0 font-black tabular-nums ${over ? 'text-red-600' : 'text-slate-800'}`}>
                    {mode === 'COUNT' ? `盤後 ${fmtQty(Number(l.qty))}` : `${fmtQty(Number(l.qty))} ${l.item.unit}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <p className="mt-2 text-xs text-slate-400">
          送出後一次批次扣／加全部品項庫存並寫入 STOCK_LOG。
          {mode === 'OUT' && (finalCustomer ? '（有填客戶 → 同時建立出貨單）' : '（未填客戶 → 不建立出貨單）')}
        </p>
      </ConfirmDialog>

      {/* ===== 新品項二次確認（單筆） ===== */}
      <ConfirmDialog
        open={confirmOpen && newOpen}
        busy={busy}
        confirmText="確認送出"
        onClose={() => !busy && setConfirmOpen(false)}
        onConfirm={handleConfirmNewItem}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          <Row label="異動類型" value="📥 入庫（建立新品項）" />
          <Row label="品號" value={draft.item_code.trim() || '自動編號（A####）'} />
          <Row label="品名" value={draft.item_name.trim() || '—'} />
          <Row label="顏色" value={draft.color_spec.trim() || '—'} />
          <Row label="類別 / 單位" value={`${draft.category} / ${draft.unit.trim() || 'PCS'}`} />
          <Row label="儲位" value={draft.location.trim() || '—'} />
          <Row label="入庫數量" value={newQtyValid ? newQtyNum : '?'} strong />
          <Row label="入庫後庫存" value={`${fmtQty(newAfter)} ${draft.unit.trim() || 'PCS'}`} strong cls="text-emerald-600" />
          <Row label="經辦人" value={operator || '—'} />
          {remark.trim() && <Row label="備註" value={remark.trim()} />}
        </div>
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
