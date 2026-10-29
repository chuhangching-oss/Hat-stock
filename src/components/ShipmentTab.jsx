import { useEffect, useMemo, useState } from 'react';
import { gasRequest, getGasUrl, getOperator } from '../api';
import ConfirmDialog from './ConfirmDialog';

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

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * 分頁 4：出庫出貨（Shipment）
 * - 表頭：出貨單號（送出時自動編號 SHyyyyMMdd-##）、出貨日期、客戶（清單選取／手動輸入可存檔）
 * - 動態明細列：品號選擇（清單／掃碼加入）＋出庫數量；每列即時比對在庫量
 * - 防呆：任何一列出庫量大於在庫 → 紅色警示＋阻擋送出
 * - 送出後：批次扣庫存 + STOCK_LOG 出庫記錄 + SHIPMENT_ORDERS / SHIPMENT_DETAILS
 */
export default function ShipmentTab({
  items,
  scanResult,
  showToast,
  onItemsUpdated,
  onOpenScanner,
  goToSettings,
}) {
  // ===== 客戶 =====
  const [customers, setCustomers] = useState(null); // null = 載入中
  const [custMode, setCustMode] = useState('list'); // 'list' | 'manual'
  const [custName, setCustName] = useState(''); // 清單選到的名稱
  const [newName, setNewName] = useState('');
  const [newCountry, setNewCountry] = useState('');
  const [saveNew, setSaveNew] = useState(true);

  // ===== 表頭 =====
  const [shipDate, setShipDate] = useState(todayYMD());
  const [remark, setRemark] = useState('');
  const [operator, setOperator] = useState(() => getOperator());

  // ===== 明細列 =====
  const [lines, setLines] = useState([]); // [{ item, qty }]
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');

  // ===== 送出 =====
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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
    loadCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 加入一列明細（重複品號擋下） */
  function addLine(item) {
    const exists = lines.some(
      (l) => String(l.item.item_code).toLowerCase() === String(item.item_code).toLowerCase(),
    );
    if (exists) {
      showToast(`❌ ${item.item_name}${item.color_spec ? `（${item.color_spec}）` : ''} 已在明細中`, 'error');
      return;
    }
    setLines((prev) => [...prev, { item, qty: '' }]);
  }

  // 掃碼／手動輸入結果 → 加入明細列
  useEffect(() => {
    if (scanResult && scanResult.code) {
      const found = resolveByScan(items, scanResult.code);
      if (found) addLine(found);
      else showToast(`❌ 找不到對應料件：${scanResult.code}`, 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanResult && scanResult.seq]);

  const setLineQty = (idx) => (e) => {
    const v = e.target.value;
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty: v } : l)));
  };

  function removeLine(idx) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // ===== 即時統計 =====
  const validQty = (l) => Number(l.qty) > 0;
  const totalQty = useMemo(
    () => lines.reduce((s, l) => s + (validQty(l) ? Number(l.qty) : 0), 0),
    [lines],
  );
  const styleCount = useMemo(
    () => new Set(lines.map((l) => l.item.item_name).filter(Boolean)).size,
    [lines],
  );
  /** 庫存不足（出庫量大於在庫） → 紅色警示＋阻擋送出 */
  const overLines = useMemo(
    () => lines.filter((l) => validQty(l) && Number(l.qty) > (l.item.stock_qty || 0)),
    [lines],
  );
  const allFilled = lines.length > 0 && lines.every(validQty);
  const finalCustomer = custMode === 'list' ? custName.trim() : newName.trim();

  const canSubmit = !!finalCustomer && !!shipDate && allFilled && overLines.length === 0;

  // 料件選取清單（清單／模糊搜尋）
  const filteredPicker = useMemo(() => {
    const f = pickerFilter.trim().toLowerCase();
    if (!f) return items;
    return items.filter((it) =>
      `${it.item_code} ${it.item_name} ${it.color_spec} ${it.category}`.toLowerCase().includes(f),
    );
  }, [items, pickerFilter]);

  async function handleConfirmSubmit() {
    setBusy(true);
    try {
      // 手動輸入且勾選保存 → 先存入客戶清單
      let customer = finalCustomer;
      if (custMode === 'manual' && saveNew && customer) {
        const already = (customers || []).some(
          (c) => String(c.customer_name).toUpperCase() === customer.toUpperCase(),
        );
        if (!already) {
          await gasRequest(getGasUrl(), {
            action: 'add_customer',
            customer_name: customer,
            country: newCountry.trim(),
          });
          await loadCustomers();
        }
      }

      const res = await gasRequest(getGasUrl(), {
        action: 'create_shipment',
        shipment_date: shipDate,
        customer_name: customer,
        operator: operator.trim() || '',
        remark: remark.trim(),
        lines: lines.map((l) => ({ item_code: l.item.item_code, qty: Number(l.qty) })),
      });

      // 即時更新本地庫存
      (res.updated_items || []).forEach((it) => onItemsUpdated(it));
      showToast(
        `🚢 出貨單 ${res.shipment_id} 已建立：${res.customer_name} · ${res.total_styles} 款 · ${res.total_pcs} PCS（庫存已扣減）`,
      );
      setConfirmOpen(false);
      setLines([]);
      setRemark('');
      if (custMode === 'manual') {
        setNewName('');
        setNewCountry('');
      }
      try {
        localStorage.setItem('kfi_operator', operator.trim());
      } catch (e) {
        /* ignore */
      }
    } catch (e) {
      showToast(`❌ 出庫失敗：${e.message}`, 'error');
      /* 失敗：保持彈窗開啟 */
    } finally {
      setBusy(false);
    }
  }

  if (!getGasUrl()) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-5xl">⚙️</div>
        <h2 className="mt-4 text-xl font-extrabold">尚未設定雲端 API</h2>
        <p className="mt-2 text-slate-500">
          請先到「設定」分頁，貼上 Google Apps Script Web App 網址後即可使用出庫出貨。
        </p>
        <button className="btn-primary mt-6" onClick={goToSettings}>
          前往設定
        </button>
      </div>
    );
  }

  return (
    <div className="pb-44">
      {/* ===== 表頭區 ===== */}
      <div className="space-y-4 rounded-3xl bg-white p-5 shadow-card">
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs font-bold text-slate-500">
            出貨單號：送出時自動編號
          </span>
          <button
            onClick={loadCustomers}
            disabled={customers === null}
            className="text-xs font-bold text-blue-700 disabled:opacity-40"
          >
            ⟳ 重新載入客戶
          </button>
        </div>

        <div>
          <label className="field-label">出貨日期</label>
          <input
            className="field-input"
            type="date"
            value={shipDate}
            onChange={(e) => setShipDate(e.target.value)}
          />
        </div>

        {/* 客戶：清單選取 或 手動輸入 */}
        <div>
          <label className="field-label">
            客戶（{finalCustomer || '未選擇'}）
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setCustMode('list')}
              className={`min-h-touch rounded-2xl text-sm font-extrabold transition active:scale-95 ${
                custMode === 'list'
                  ? 'bg-blue-700 text-white shadow-card'
                  : 'bg-white text-blue-700 ring-2 ring-blue-700'
              }`}
            >
              📋 客戶清單選取
            </button>
            <button
              onClick={() => setCustMode('manual')}
              className={`min-h-touch rounded-2xl text-sm font-extrabold transition active:scale-95 ${
                custMode === 'manual'
                  ? 'bg-blue-700 text-white shadow-card'
                  : 'bg-white text-blue-700 ring-2 ring-blue-700'
              }`}
            >
              ✏️ 手動輸入／新增
            </button>
          </div>

          {custMode === 'list' && (
            <div className="mt-2 flex gap-2">
              <select
                className="field-input flex-1"
                value={custName}
                onChange={(e) => setCustName(e.target.value)}
              >
                <option value="">
                  {customers === null ? '⟳ 載入客戶清單中…' : '— 請選擇客戶 —'}
                </option>
                {(customers || []).map((c) => (
                  <option key={c.customer_id} value={c.customer_name}>
                    {c.customer_name}
                    {c.country ? `（${c.country}）` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {custMode === 'manual' && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-2">
                <input
                  className="field-input flex-1"
                  placeholder="客戶名稱（必填，例：MOONBAT）"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <input
                  className="field-input w-28 shrink-0"
                  placeholder="國家（選填）"
                  value={newCountry}
                  onChange={(e) => setNewCountry(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
                <input
                  type="checkbox"
                  checked={saveNew}
                  onChange={(e) => setSaveNew(e.target.checked)}
                  className="h-5 w-5 accent-blue-700"
                />
                送出時存入客戶清單（CUSTOMERS）
              </label>
            </div>
          )}
        </div>

        <div>
          <label className="field-label">備註（買方 PO / 嘜頭 / 貨櫃號，選填）</label>
          <input
            className="field-input"
            placeholder="例：PO#2026-888／CONTAINER MSKU1234567"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
          />
        </div>

        <div>
          <label className="field-label">經辦人（{operator || '未選擇'}，選填）</label>
          <input
            className="field-input"
            placeholder="例：01-王小明"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          />
        </div>
      </div>

      {/* ===== 商品明細編輯區 ===== */}
      <div className="mt-4 space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => {
              setPickerFilter('');
              setPickerOpen(true);
            }}
            className="min-h-touch flex-1 rounded-2xl bg-blue-700 py-2.5 text-base font-extrabold text-white shadow-card transition active:bg-blue-800 active:scale-[0.98]"
          >
            ➕ 新增商品款式
          </button>
          <button
            onClick={onOpenScanner}
            aria-label="掃碼加入品號"
            className="flex min-h-touch w-24 shrink-0 flex-col items-center justify-center rounded-2xl bg-blue-700 text-white shadow-card transition active:bg-blue-800 active:scale-95"
          >
            <span className="text-xl leading-none">📷</span>
            <span className="mt-0.5 text-[10px] font-bold">掃碼加入</span>
          </button>
        </div>

        {lines.map((l, idx) => {
          const it = l.item;
          const q = Number(l.qty);
          const over = validQty(l) && q > (it.stock_qty || 0);
          const low = it.stock_qty <= 10;
          return (
            <div
              key={it.item_code}
              className={`rounded-3xl bg-white p-4 shadow-card ${
                over ? 'border-2 border-red-400' : 'border border-slate-100'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-slate-400">{it.item_code}</span>
                  </div>
                  <h3 className="mt-0.5 text-base font-extrabold leading-snug text-slate-900">
                    {it.item_name}
                    {it.color_spec && <span className="text-slate-500">（{it.color_spec}）</span>}
                  </h3>
                  <p className="mt-0.5 text-sm font-semibold">
                    <span className="text-slate-500">📍{it.location || '未指定'}</span>
                    <span className={`ml-2 ${low ? 'text-red-600' : 'text-slate-700'}`}>
                      在庫 <b className="tabular-nums">{it.stock_qty}</b> {it.unit}
                    </span>
                  </p>
                </div>
                <button
                  onClick={() => removeLine(idx)}
                  aria-label="刪除明細列"
                  className="shrink-0 rounded-2xl bg-red-100 px-3 py-2 text-sm font-extrabold text-red-600 transition active:bg-red-200 active:scale-95"
                >
                  ✕ 刪除
                </button>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-sm font-bold text-slate-600">出庫量</span>
                <input
                  className={`field-input flex-1 tabular-nums ${over ? 'border-red-400 text-red-600' : ''}`}
                  type="number"
                  inputMode="decimal"
                  step="1"
                  min="0"
                  placeholder="0"
                  value={l.qty}
                  onChange={setLineQty(idx)}
                />
                <span className="shrink-0 text-sm font-bold text-slate-500">{it.unit}</span>
              </div>
              {over && (
                <p className="mt-1 text-xs font-extrabold text-red-600">
                  ⚠️ 出庫量 {fmtQty(q)} 大於在庫 {it.stock_qty}，請調整或先補貨入庫
                </p>
              )}
              {over ? null : validQty(l) && q === it.stock_qty ? (
                <p className="mt-1 text-xs font-bold text-amber-600">屆時此品項庫存將歸零</p>
              ) : null}
            </div>
          );
        })}

        {lines.length === 0 && (
          <div className="rounded-3xl bg-white p-6 text-center text-slate-400 shadow-card">
            <div className="text-4xl">🚢</div>
            <p className="mt-2 font-bold">尚無出庫明細</p>
            <p className="mt-1 text-xs">點上方「新增商品款式」或「掃碼加入」開始建立出貨單</p>
          </div>
        )}
      </div>

      {/* ===== 底部統計浮動列 ===== */}
      {lines.length > 0 && (
        <div
          className="fixed inset-x-0 z-20 mx-auto max-w-lg px-4"
          style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}
        >
          <div className="rounded-3xl bg-white p-3 shadow-card ring-2 ring-blue-700">
            <div className="flex items-baseline justify-between px-1 text-sm font-extrabold text-slate-700">
              <span>
                總款式數：<b className="text-lg text-blue-700">{styleCount}</b> 款
              </span>
              <span>
                總數量：<b className="text-lg text-blue-700">{fmtQty(totalQty)}</b> PCS
              </span>
            </div>
            {overLines.length > 0 ? (
              <p className="mt-1.5 px-1 text-xs font-extrabold text-red-600">
                ⚠️ {overLines.length} 列庫存不足，已阻擋送出
              </p>
            ) : null}
            <button
              className="btn-primary mt-2"
              disabled={!canSubmit || busy}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? '送出中…' : '🚢 確認出庫並建立出貨單'}
            </button>
          </div>
        </div>
      )}

      {/* ===== 料件選取清單 ===== */}
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
              <h3 className="text-lg font-extrabold">選擇出庫料件</h3>
              <button className="text-slate-400" onClick={() => setPickerOpen(false)}>✕</button>
            </div>
            <input
              className="field-input mb-3"
              placeholder="搜尋：品號 / 帽型 / 顏色…"
              value={pickerFilter}
              onChange={(e) => setPickerFilter(e.target.value)}
            />
            <p className="mb-2 px-1 text-xs font-bold text-slate-400">共 {filteredPicker.length} 筆</p>
            <ul className="space-y-2">
              {filteredPicker.slice(0, 200).map((it) => (
                <li key={it.item_code}>
                  <button
                    onClick={() => {
                      addLine(it);
                      setPickerOpen(false);
                    }}
                    disabled={it.stock_qty <= 0}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition enabled:active:bg-blue-100 disabled:opacity-40"
                  >
                    <b>{it.item_name}</b>
                    {it.color_spec && <span className="text-slate-500">（{it.color_spec}）</span>}
                    <span className="float-right font-black text-slate-700">
                      {it.stock_qty} {it.unit}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {it.item_code}
                      {it.stock_qty <= 0 && ' （無庫存）'}
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

      {/* ===== 送出前確認彈窗 ===== */}
      <ConfirmDialog
        open={confirmOpen}
        busy={busy}
        title="🚢 確認出庫並建立出貨單"
        confirmText="確認出庫"
        onClose={() => !busy && setConfirmOpen(false)}
        onConfirm={handleConfirmSubmit}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          <Row label="客戶" value={finalCustomer} strong />
          <Row label="出貨日期" value={shipDate} />
          <Row label="經辦人" value={operator.trim() || '—'} />
          <Row label="總款式數" value={`${styleCount} 款`} />
          <Row label="總數量" value={`${fmtQty(totalQty)} PCS`} strong />
          {remark.trim() && <Row label="備註" value={remark.trim()} />}
        </div>

        {/* 明細（各款式與顏色的分項小計） */}
        <div className="mt-3 max-h-60 overflow-y-auto rounded-2xl border border-slate-100">
          <ul className="divide-y divide-slate-100">
            {lines.map((l, idx) => (
              <li key={l.item.item_code} className="flex items-baseline justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-semibold text-slate-700">
                  <b>{l.item.item_name}</b>
                  {l.item.color_spec && <span className="text-slate-500">（{l.item.color_spec}）</span>}
                </span>
                <span className="shrink-0 font-black tabular-nums text-slate-800">
                  {fmtQty(Number(l.qty))} {l.item.unit}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-2 text-xs text-slate-400">
          送出後將批次扣減庫存、寫入 STOCK_LOG，並建立 SHIPMENT_ORDERS / SHIPMENT_DETAILS 出貨單資料。
        </p>
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
