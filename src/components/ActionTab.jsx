import { useEffect, useState } from 'react';
import { CATEGORY_COLORS, LOW_STOCK_THRESHOLD } from '../constants';
import { getOperator, gasRequest, getGasUrl } from '../api';
import PhotoButton from './PhotoButton';
import ConfirmDialog from './ConfirmDialog';

const MODES = [
  {
    key: 'IN',
    type: '入庫',
    label: '📥 入庫',
    activeCls: 'bg-emerald-600 text-white shadow-card',
    inactiveCls: 'bg-white text-emerald-600 ring-2 ring-emerald-600',
  },
  {
    key: 'OUT',
    type: '出庫',
    label: '📤 出庫',
    activeCls: 'bg-red-600 text-white shadow-card',
    inactiveCls: 'bg-white text-red-600 ring-2 ring-red-600',
  },
  {
    key: 'COUNT',
    type: '盤點',
    label: '🧮 盤點',
    activeCls: 'bg-blue-700 text-white shadow-card',
    inactiveCls: 'bg-white text-blue-700 ring-2 ring-blue-700',
  },
];

/** 掃碼／手動輸入文字 → 對應料件（先比對序號，再比對品名） */
function resolveByScan(items, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const hay = (it) => [
    String(it.item_code),
    String(it.item_name),
  ]
    .join(' ')
    .toLowerCase();
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

/**
 * 分頁 2：出入庫快速填報
 * - 入庫 / 出庫 / 盤點 大按鈕切換
 * - 品料一律以「品名（顏色）」選取：📋 選取清單、📷 掃碼（規格確定後啟用）
 * - 系統序號 Item_Code 只在內部使用，不上畫面
 * - 入庫時可「直接入庫新品項」：現場填寫品名/顏色等，後端自動建立主檔
 * - 防呆：出庫大於在庫量 → 明顯警告 + 二次確認彈窗
 */
export default function ActionTab({ items, onSubmit, onOpenScanner, scanResult, showToast, onPhotoUploaded }) {
  const [mode, setMode] = useState('IN');
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState('');
  const [operator, setOperator] = useState(() => getOperator());
  const [remark, setRemark] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operators, setOperators] = useState(null); // null=載入中；[]=名冊空；[{code,name}]
  const [opPickerOpen, setOpPickerOpen] = useState(false);
  const [manualOp, setManualOp] = useState('');
  // 入庫新品項：直接在本頁建立主檔資料並入庫
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

  useEffect(() => {
    loadOperators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新品項模式：以草稿資料當作料件（庫存由 0 起算）
  const item = newOpen
    ? { ...draft, stock_qty: 0, unit: draft.unit.trim() || 'PCS' }
    : selected;
  const qtyNum = Number(qty);
  const qtyValid = isFinite(qtyNum) && qtyNum > 0;
  const newStock =
    mode === 'IN'
      ? (item ? item.stock_qty : 0) + (qtyValid ? qtyNum : 0)
      : mode === 'OUT'
        ? (item ? item.stock_qty : 0) - (qtyValid ? qtyNum : 0)
        : qtyValid
          ? qtyNum
          : (item ? item.stock_qty : 0);
  const overStock = mode === 'OUT' && item && qtyValid && qtyNum > item.stock_qty;
  const resultNegative = mode !== 'IN' && newStock < 0;

  // 掃碼／手動輸入結果 → 帶出料件
  useEffect(() => {
    if (scanResult && scanResult.code) {
      const found = resolveByScan(items, scanResult.code);
      if (found) {
        setSelected(found);
        setQty('');
        setNewOpen(false); // 掃到既有料件 → 退出新品項表單
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanResult && scanResult.seq]);

  function handleOpenConfirm() {
    if (newOpen) {
      if (!draft.item_name.trim()) return showToast('❌ 新品項請填寫「品名」', 'error');
      const customCode = draft.item_code.trim().toUpperCase();
      if (
        customCode &&
        items.some((it) => String(it.item_code).trim().toUpperCase() === customCode)
      ) {
        return showToast(`❌ 品號 ${customCode} 已存在，請改用清單選取，或換一個品號`, 'error');
      }
    } else if (!selected) {
      return showToast('❌ 請先點「📋 選取」挑選料件', 'error');
    }
    if (!qtyValid) return showToast('❌ 異動數量必須大於 0', 'error');
    if (mode === 'COUNT' && qtyNum < 0) return showToast('❌ 盤點數量不可為負數', 'error');
    if (!operator.trim()) return showToast('❌ 請填寫經辦人姓名', 'error');
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    setBusy(true);
    try {
      await onSubmit({
        type: newOpen ? '入庫' : meta()?.type,
        item_code: newOpen ? draft.item_code.trim().toUpperCase() : item.item_code,
        qty: qtyNum,
        operator: operator.trim(),
        remark: remark.trim(),
        force: overStock, // 已於彈窗明確警告過，後端才允許形成負庫存
        ...(newOpen
          ? {
              new_item: {
                item_code: draft.item_code.trim(),
                item_name: draft.item_name.trim(),
                color_spec: draft.color_spec.trim(),
                category: draft.category,
                unit: draft.unit.trim() || 'PCS',
                location: draft.location.trim(),
              },
            }
          : {}),
      });
      try {
        localStorage.setItem('kfi_operator', operator.trim());
      } catch (e) {
        /* ignore */
      }
      setConfirmOpen(false);
      setQty('');
      setRemark('');
      if (newOpen) {
        setNewOpen(false);
        setDraft(EMPTY_DRAFT);
        setSelected(null); // 新品項已建立，清掉舊選取避免混淆
      }
    } catch (e) {
      /* 送出失敗：保持彈窗開啟，錯誤已由 App Toast 顯示 */
    } finally {
      setBusy(false);
    }
  }

  function meta() {
    return MODES.find((m) => m.key === mode);
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

  const toggleCls = (m) => (mode === m.key ? m.activeCls : m.inactiveCls);

  const filteredPicker = items.filter((it) => {
    const f = pickerFilter.trim().toLowerCase();
    if (!f) return true;
    return `${it.item_name} ${it.color_spec} ${it.category}`.toLowerCase().includes(f);
  });

  return (
    <div>
      {/* 入庫 / 出庫 / 盤點 切換大按鈕 */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setMode(m.key);
              setQty('');
              if (newOpen) closeNew(); // 切換類型時收起新品項表單
            }}
            className={`min-h-touch rounded-2xl text-xl font-extrabold transition active:scale-95 ${toggleCls(m)}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* 表單卡片 */}
      <div className="mt-4 space-y-4 rounded-3xl bg-white p-5 shadow-card">
        {/* 料件選取（只顯示品名/顏色，不顯示系統序號）；入庫可改為建立新品項 */}
        <div>
          {newOpen ? (
            <div className="rounded-2xl bg-emerald-50/70 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-extrabold text-emerald-700">
                  🆕 入庫新品項（自動建立主檔資料）
                </span>
                <button
                  onClick={closeNew}
                  className="text-xs font-bold text-slate-400 transition active:text-slate-600"
                >
                  改用清單選取
                </button>
              </div>
              <div className="space-y-2">
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
                <div className="flex gap-2">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      onClick={() => setDraft((d) => ({ ...d, category: c }))}
                      className={`min-h-touch flex-1 rounded-2xl text-base font-extrabold transition active:scale-95 ${
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
              </div>
            </div>
          ) : (
            <>
              <label className="field-label">
                料件（已選：{selected ? itemTitle(selected) : '未選擇'}）
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setPickerFilter('');
                    setPickerOpen(true);
                  }}
                  className={`field-input flex-1 truncate text-left ${
                    selected ? 'bg-blue-50/60' : 'text-slate-400'
                  }`}
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

              {/* 清單沒有時：入庫可直接建立新品項 */}
              {mode === 'IN' && (
                <button
                  onClick={openNew}
                  className="mt-2 w-full rounded-2xl border-2 border-dashed border-emerald-400 py-2.5 text-sm font-extrabold text-emerald-600 transition active:scale-[0.98] active:bg-emerald-50"
                >
                  ➕ 清單沒有？直接入庫新品項
                </button>
              )}
            </>
          )}

          {/* 選定後即時顯示目前在庫，協助現場判斷 */}
          {!newOpen && item && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 p-3 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-bold ${CATEGORY_COLORS[item.category] || 'bg-slate-100 text-slate-600'}`}
              >
                {item.category}
              </span>
              <b className="text-slate-800">{item.item_name}</b>
              {item.color_spec && <span className="text-slate-500">{item.color_spec}</span>}
              {item.location && <span className="text-slate-500">📍{item.location}</span>}
              <span
                className={`ml-auto text-lg font-black tabular-nums ${
                  item.stock_qty <= LOW_STOCK_THRESHOLD ? 'text-red-600' : 'text-slate-900'
                }`}
              >
                在庫 {item.stock_qty} {item.unit}
              </span>
            </div>
          )}
        </div>

        {/* 數量 */}
        <div>
          <label className="field-label">
            {mode === 'COUNT' ? '盤點後實際庫存量' : '異動數量'}（{item ? item.unit : 'PCS'}）
          </label>
          <input
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

        {/* 經辦人（從名冊點選；名冊在 Google 試算表 OPERATORS 工作表） */}
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

        {/* 備註 */}
        <div>
          <label className="field-label">備註（工單號 / 箱號 / 出貨單）</label>
          <input
            className="field-input"
            placeholder="選填，例：WO-2026-1130-A、箱號 12"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>

        {/* 送出 */}
        <button className="btn-primary" onClick={handleOpenConfirm}>
          送出「{meta().label.replace(/^[^ ]+ /, '')} {qtyValid ? qtyNum : '?'}」
        </button>
      </div>

      {/* === 料件選取清單（品名搜尋） === */}
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
              <h3 className="text-lg font-extrabold">選擇料件</h3>
              <button className="text-slate-400" onClick={() => setPickerOpen(false)}>✕</button>
            </div>
            <input
              className="field-input mb-3"
              placeholder="搜尋：帽型 / 顏色（例：111AG20、可可）"
              value={pickerFilter}
              onChange={(e) => setPickerFilter(e.target.value)}
            />
            <p className="mb-2 px-1 text-xs font-bold text-slate-400">
              共 {filteredPicker.length} 筆
            </p>
            <ul className="space-y-2">
              {filteredPicker.slice(0, 200).map((it) => (
                <li key={it.item_code}>
                  <button
                    onClick={() => {
                      setSelected(it);
                      setQty('');
                      setPickerOpen(false);
                    }}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition active:bg-blue-100"
                  >
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${CATEGORY_COLORS[it.category] || 'bg-slate-100 text-slate-600'}`}
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
              <p className="mt-2 text-center text-xs text-slate-400">
                只顯示前 200 筆，請用上方搜尋縮小範圍
              </p>
            )}
          </div>
        </div>
      )}

      {/* === 經辦人名冊選單 === */}
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
                名冊目前是空的。請到 Google 試算表 <b>OPERATORS</b> 分頁，
                在「姓名」欄填入人員（序號已幫你預填 01~30），填完按上面的「🔁 重新載入名冊」。
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
                        } catch (e) { /* ignore */ }
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

            {/* 臨時輸入（名冊未登記者一次性使用） */}
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
                    } catch (e) { /* ignore */ }
                    setManualOp('');
                    setOpPickerOpen(false);
                  }}
                  className="min-h-touch rounded-2xl bg-slate-700 px-4 text-base font-extrabold text-white transition active:bg-slate-800 active:scale-95"
                >
                  加入
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                記錄進 STOCK_LOG 的格式為「序號-姓名」（臨時輸入則為原文字）
              </p>
            </div>
          </div>
        </div>
      )}

      {/* === 二次確認彈窗 === */}
      <ConfirmDialog
        open={confirmOpen}
        busy={busy}
        confirmText={overStock ? '仍要送出（覆核通過）' : '確認送出'}
        danger={overStock || resultNegative}
        onClose={() => !busy && setConfirmOpen(false)}
        onConfirm={handleConfirm}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          {newOpen ? (
            <>
              <Row label="異動類型" value="📥 入庫（建立新品項）" />
              <Row label="品號" value={draft.item_code.trim() || '自動編號（A####）'} />
              <Row label="品名" value={draft.item_name.trim() || '—'} />
              <Row label="顏色" value={draft.color_spec.trim() || '—'} />
              <Row label="類別 / 單位" value={`${draft.category} / ${draft.unit.trim() || 'PCS'}`} />
              <Row label="儲位" value={draft.location.trim() || '—'} />
              <Row label="入庫數量" value={qtyValid ? qtyNum : '?'} strong />
              <Row
                label="入庫後庫存"
                value={`${newStock} ${draft.unit.trim() || 'PCS'}`}
                strong
                cls="text-emerald-600"
              />
            </>
          ) : (
            <>
              <Row label="異動類型" value={meta().label} />
              <Row label="品名" value={item ? itemTitle(item) : '—'} />
              <Row
                label={mode === 'COUNT' ? '盤點後庫存' : '異動數量'}
                value={qtyValid ? qtyNum : '?'}
                strong
              />
              <Row label="目前庫存" value={item ? `${item.stock_qty} ${item.unit}` : '—'} />
              <Row
                label="異動後庫存"
                value={`${newStock} ${item ? item.unit : ''}`}
                strong
                cls={
                  resultNegative || newStock <= LOW_STOCK_THRESHOLD
                    ? 'text-red-600'
                    : 'text-emerald-600'
                }
              />
            </>
          )}
          <Row label="經辦人" value={operator || '—'} />
          <Row label="備註" value={remark || '—'} />
        </div>

        {(overStock || resultNegative) && (
          <div className="mt-4 rounded-2xl border-2 border-red-400 bg-red-50 p-4">
            <p className="text-base font-extrabold text-red-600">⚠️ 庫存不足警告</p>
            <p className="mt-1 text-sm font-semibold text-red-500">
              出庫量 {qtyValid ? qtyNum : '?'} 大於目前在庫 {item ? item.stock_qty : 0}，
              送出後將形成負庫存 {newStock}。
              <br />
              請確認數量與單位是否正確；若為確定的大單出貨，可覆核後仍送出。
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
