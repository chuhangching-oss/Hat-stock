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
 * 分頁 4：出庫出貨（Shipment，完整外銷版 / 批次購物車模式）
 * - 單頭：Invoice No（留空自動 GS-yyyyMMdd）、出貨日期、客戶（清單／手動）、
 *   船名航次、起運/目的港、貿易條件與幣別（預設 FOB TAIWAN / USD）、經辦人、備註
 * - 連續加入列：選取／掃碼 → 帶出品名・顏色・在庫 → 數量＋箱號＋單價＋淨重/毛重
 *   →【＋ 加入出貨明細】後自動清空重新打開選取清單，方便連續掃下一箱/下一款
 * - 同一品號可加入多列（分裝多箱）；後端依品號合計檢查庫存
 * - 庫存防呆：任一品號「合計出庫量」大於在庫 → 紅字警示並阻擋送出
 * - 即時統計（sticky）：總箱數／總款式／總 PCS／總金額 USD／總淨重與毛重
 * - 送出後：批次扣庫 + STOCK_LOG + SHIPMENT_ORDERS / SHIPMENT_DETAILS
 *   （欄位結構對應 Commercial Invoice / Packing List DATA_ENTRY）
 */
export default function ShipmentTab({
  items,
  scanResult,
  showToast,
  onItemsUpdated,
  onOpenScanner,
  goToSettings,
}) {
  // ===== 單頭 =====
  const [customers, setCustomers] = useState(null); // null = 載入中
  const [custMode, setCustMode] = useState('list'); // 'list' | 'manual'
  const [custName, setCustName] = useState('');
  const [newName, setNewName] = useState('');
  const [newCountry, setNewCountry] = useState('');
  const [saveNew, setSaveNew] = useState(true);
  const [shipDate, setShipDate] = useState(todayYMD());
  const [invoiceNo, setInvoiceNo] = useState(''); // 留空 → 自動 GS-yyyyMMdd
  const [carrier, setCarrier] = useState('');     // 船名航次 / 運送方式
  const [portFrom, setPortFrom] = useState('');
  const [portTo, setPortTo] = useState('');
  const [incoterm, setIncoterm] = useState('FOB TAIWAN');
  const [currency, setCurrency] = useState('USD');
  const [remark, setRemark] = useState('');
  const [operator, setOperator] = useState(() => getOperator());

  // ===== 明細列 =====
  const [lines, setLines] = useState([]); // [{ item, qty, carton, price, nw, gw }]
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

  /** 加入一列明細（同一品號可分列多箱） */
  function addLine(item) {
    setLines((prev) => [
      ...prev,
      { item, qty: '', carton: '', price: '', nw: '', gw: '' },
    ]);
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

  const setLineField = (idx, key) => (e) => {
    const v = e.target.value;
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [key]: v } : l)));
  };

  function removeLine(idx) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // ===== 即時統計 =====
  const lineQtyValid = (l) => isFinite(Number(l.qty)) && Number(l.qty) > 0;
  const totalQty = useMemo(
    () => lines.reduce((s, l) => s + (lineQtyValid(l) ? Number(l.qty) : 0), 0),
    [lines], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /** 庫存防呆以「品號合計」比對（同款多箱合併計算） */
  const overLines = useMemo(() => {
    const agg = {};
    lines.forEach((l) => {
      if (lineQtyValid(l)) agg[l.item.item_code] = (agg[l.item.item_code] || 0) + Number(l.qty);
    });
    return lines.filter(
      (l) => lineQtyValid(l) && (agg[l.item.item_code] || 0) > (l.item.stock_qty || 0),
    );
  }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalCartons = useMemo(
    () => new Set(lines.map((l) => l.carton.trim()).filter(Boolean)).size,
    [lines],
  );
  const styleCount = useMemo(
    () => new Set(lines.map((l) => l.item.item_name).filter(Boolean)).size,
    [lines],
  );
  const totalAmount = useMemo(
    () => lines.reduce((s, l) => s + (lineQtyValid(l) ? Number(l.price) * Number(l.qty) : 0), 0),
    [lines], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const totalNW = useMemo(
    () => lines.reduce((s, l) => s + (lineQtyValid(l) ? Number(l.nw) : 0), 0),
    [lines], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const totalGW = useMemo(
    () => lines.reduce((s, l) => s + (lineQtyValid(l) ? Number(l.gw) : 0), 0),
    [lines], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const allFilled = lines.length > 0 && lines.every(lineQtyValid);
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
        invoice_no: invoiceNo.trim(),
        customer_name: customer,
        operator: operator.trim() || '',
        remark: remark.trim(),
        carrier: carrier.trim(),
        port_from: portFrom.trim(),
        port_to: portTo.trim(),
        incoterm: incoterm.trim(),
        currency: currency.trim(),
        lines: lines.map((l) => ({
          item_code: l.item.item_code,
          qty: Number(l.qty),
          carton_no: l.carton.trim(),
          unit_price: Number(l.price) || 0,
          n_w: Number(l.nw) || 0,
          g_w: Number(l.gw) || 0,
        })),
      });

      // 即時更新本地庫存
      (res.updated_items || []).forEach((it) => onItemsUpdated(it));
      showToast(
        `🚢 出貨單 ${res.shipment_id}（Invoice ${res.invoice_no}）已建立：${res.customer_name} · ` +
          `${res.total_cartons} 箱 · ${res.total_styles} 款 · ${res.total_pcs} PCS · ` +
          `$${fmtQty(res.total_amount)} ${currency.trim() || 'USD'}`,
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
      {/* ===== 單頭區 ===== */}
      <div className="space-y-4 rounded-3xl bg-white p-5 shadow-card">
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs font-bold text-slate-500">
            出貨單號 SHyyyyMMdd-## 自動編號
          </span>
          <button
            onClick={loadCustomers}
            disabled={customers === null}
            className="text-xs font-bold text-blue-700 disabled:opacity-40"
          >
            ⟳ 重新載入客戶
          </button>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="field-label">出貨日期</label>
            <input
              className="field-input"
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className="field-label">Invoice No（留空自動）</label>
            <input
              className="field-input font-mono"
              placeholder={`自動 GS-${todayYMD().replace(/-/g, '')}`}
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
            />
          </div>
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
            <select
              className="field-input mt-2"
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
                  className="field-input w-24 shrink-0"
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

        {/* 外銷運輸資訊（Commercial Invoice / Packing List 用） */}
        <div className="rounded-2xl bg-slate-50 p-3">
          <p className="mb-2 text-xs font-extrabold text-slate-500">
            🛳️ 外銷運輸資訊（匯出單據用，選填）
          </p>
          <div className="space-y-2">
            <input
              className="field-input"
              placeholder="船名航次 / 運送方式（例：YM INCEPTION / DHL）"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="field-input flex-1"
                placeholder="起運港（例：KEELUNG）"
                value={portFrom}
                onChange={(e) => setPortFrom(e.target.value)}
              />
              <input
                className="field-input flex-1"
                placeholder="目的港（例：YOKOHAMA）"
                value={portTo}
                onChange={(e) => setPortTo(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <input
                className="field-input flex-1"
                placeholder="貿易條件（例：FOB TAIWAN）"
                value={incoterm}
                onChange={(e) => setIncoterm(e.target.value)}
              />
              <input
                className="field-input w-28 shrink-0"
                placeholder="幣別（USD）"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              />
            </div>
          </div>
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

      {/* ===== 連續加入明細區 ===== */}
      <div className="mt-4 space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => {
              setPickerFilter('');
              setPickerOpen(true);
            }}
            className="min-h-touch flex-1 rounded-2xl bg-blue-700 py-2.5 text-base font-extrabold text-white shadow-card transition active:bg-blue-800 active:scale-[0.98]"
          >
            ＋ 加入出貨明細
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
          const lineOver = lineQtyValid(l) && q > (it.stock_qty || 0);
          const low = it.stock_qty <= 10;
          return (
            <div
              key={`${it.item_code}-${idx}`}
              className={`rounded-3xl bg-white p-4 shadow-card ${
                lineOver ? 'border-2 border-red-400' : 'border border-slate-100'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-black text-slate-400">#{idx + 1}</span>
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
                <span className="w-12 shrink-0 text-sm font-bold text-slate-600">PCS</span>
                <input
                  className={`field-input flex-1 tabular-nums ${lineOver ? 'border-red-400 text-red-600' : ''}`}
                  type="number"
                  inputMode="decimal"
                  step="1"
                  min="0"
                  placeholder="出貨數量"
                  value={l.qty}
                  onChange={setLineField(idx, 'qty')}
                />
                <span className="shrink-0 text-sm font-bold text-slate-500">{it.unit}</span>
              </div>

              {/* 外銷：箱號／單價／重量 */}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  className="field-input"
                  inputMode="text"
                  placeholder="箱號（例：CTN #15）"
                  value={l.carton}
                  onChange={setLineField(idx, 'carton')}
                />
                <input
                  className="field-input tabular-nums"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="單價 USD"
                  value={l.price}
                  onChange={setLineField(idx, 'price')}
                />
                <input
                  className="field-input tabular-nums"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="此列淨重 N.W. KG"
                  value={l.nw}
                  onChange={setLineField(idx, 'nw')}
                />
                <input
                  className="field-input tabular-nums"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="此列毛重 G.W. KG"
                  value={l.gw}
                  onChange={setLineField(idx, 'gw')}
                />
              </div>

              {lineOver && (
                <p className="mt-1 text-xs font-extrabold text-red-600">
                  ⚠️ 此品號合計出庫量已超過在庫 {it.stock_qty}，已阻擋送出
                </p>
              )}
              {!lineOver && lineQtyValid(l) && q === it.stock_qty && (
                <p className="mt-1 text-xs font-bold text-amber-600">屆時此品項庫存將歸零</p>
              )}
            </div>
          );
        })}

        {lines.length === 0 && (
          <div className="rounded-3xl bg-white p-6 text-center text-slate-400 shadow-card">
            <div className="text-4xl">🚢</div>
            <p className="mt-2 font-bold">尚無出貨明細</p>
            <p className="mt-1 text-xs">點上方「加入出貨明細」或「掃碼加入」開始建立出貨單</p>
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
            <div className="grid grid-cols-3 gap-x-2 px-1 text-xs font-extrabold text-slate-700">
              <span>
                總箱數：<b className="text-base text-blue-700">{totalCartons}</b>
              </span>
              <span>
                總款式：<b className="text-base text-blue-700">{styleCount}</b> 款
              </span>
              <span>
                總數量：<b className="text-base text-blue-700">{fmtQty(totalQty)}</b> PCS
              </span>
              <span>
                總金額：<b className="text-base text-blue-700">${fmtQty(totalAmount)}</b>
              </span>
              <span>
                淨重：<b className="text-base text-blue-700">{fmtQty(totalNW)}</b>
              </span>
              <span>
                毛重：<b className="text-base text-blue-700">{fmtQty(totalGW)}</b> KGS
              </span>
            </div>
            {overLines.length > 0 && (
              <p className="mt-1.5 px-1 text-xs font-extrabold text-red-600">
                ⚠️ {overLines.length} 列品號出庫合計超過在庫，已阻擋送出
              </p>
            )}
            <button
              className="btn-primary mt-2"
              disabled={!canSubmit || busy}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? '送出中…' : `🚢 確認出貨並建立單據（共 ${fmtQty(totalQty)} PCS）`}
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
              <h3 className="text-lg font-extrabold">選擇出貨料件</h3>
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
        title="🚢 確認出貨並建立單據"
        confirmText="確認出貨"
        onClose={() => !busy && setConfirmOpen(false)}
        onConfirm={handleConfirmSubmit}
      >
        <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-base">
          <Row label="客戶" value={finalCustomer} strong />
          <Row label="出貨日期" value={shipDate} />
          <Row label="Invoice No" value={invoiceNo.trim() || `自動 GS-${todayYMD().replace(/-/g, '')}`} />
          {carrier.trim() && <Row label="船名航次 / 運送" value={carrier.trim()} />}
          {(portFrom.trim() || portTo.trim()) && (
            <Row label="起運 → 目的港" value={`${portFrom.trim() || '—'} → ${portTo.trim() || '—'}`} />
          )}
          <Row label="貿易條件 / 幣別" value={`${incoterm.trim() || '—'} / ${currency.trim() || 'USD'}`} />
          <Row label="經辦人" value={operator.trim() || '—'} />
          <Row
            label="統計"
            value={`${totalCartons} 箱 · ${styleCount} 款 · ${fmtQty(totalQty)} PCS · $${fmtQty(totalAmount)}`}
            strong
          />
          {(totalNW > 0 || totalGW > 0) && (
            <Row label="總淨重 / 毛重" value={`${fmtQty(totalNW)} / ${fmtQty(totalGW)} KGS`} />
          )}
          {remark.trim() && <Row label="備註" value={remark.trim()} />}
        </div>

        {/* 明細（各款式與顏色的分項小計） */}
        <div className="mt-3 max-h-60 overflow-y-auto rounded-2xl border border-slate-100">
          <ul className="divide-y divide-slate-100">
            {lines.map((l, idx) => (
              <li key={`${l.item.item_code}-${idx}`} className="flex items-baseline justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-semibold text-slate-700">
                  {l.carton.trim() && <span className="mr-1 font-bold text-slate-400">{l.carton.trim()}</span>}
                  <b>{l.item.item_name}</b>
                  {l.item.color_spec && <span className="text-slate-500">（{l.item.color_spec}）</span>}
                </span>
                <span className="shrink-0 font-black tabular-nums text-slate-800">
                  {fmtQty(Number(l.qty))} {l.item.unit}
                  {Number(l.price) > 0 && (
                    <span className="ml-1 text-xs font-bold text-slate-500">
                      ${fmtQty(Number(l.price) * Number(l.qty))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-2 text-xs text-slate-400">
          送出後將批次扣減庫存、寫入 STOCK_LOG，並建立 SHIPMENT_ORDERS / SHIPMENT_DETAILS
          （欄位可直接對應 Commercial Invoice / Packing List）。
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
