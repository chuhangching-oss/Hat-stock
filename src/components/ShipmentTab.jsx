import { useEffect, useMemo, useState } from 'react';
import { gasRequest, getGasUrl, getOperator, isManager } from '../api';
import ConfirmDialog from './ConfirmDialog';
import BatchItemPicker from './BatchItemPicker';

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
  const [batchOpen, setBatchOpen] = useState(false); // 批次挑選彈窗

  // ===== 送出 =====
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // ===== 歷史出貨單管理（HC 限定：編輯單頭／修正數量／刪除整張回補庫存） =====
  const manager = isManager();
  const [shipList, setShipList] = useState(null); // null = 未載入
  const [shipFilter, setShipFilter] = useState('');
  const [shipOpFilter, setShipOpFilter] = useState('全部'); // 經辦人篩選
  const [shipDetail, setShipDetail] = useState(null); // {order, lines}
  const [shipEdit, setShipEdit] = useState({}); // 單頭欄位編輯值
  const [shipLineQty, setShipLineQty] = useState({}); // row(明細列號) → 新數量字串
  const [shipForce, setShipForce] = useState(false);
  const [shipBusy, setShipBusy] = useState(false);
  const [shipDelArm, setShipDelArm] = useState(false); // 刪除兩段式解除保險

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

  // ===== 歷史出貨單管理（HC 限定） =====
  const loadShipments = async () => {
    setShipList(null);
    try {
      const rows = await gasRequest(getGasUrl(), { action: 'list_shipments' });
      setShipList(Array.isArray(rows) ? rows.slice(0, 100) : []);
    } catch (e) {
      setShipList([]);
      showToast(`⚠️ 出貨單清單載入失敗：${e.message}`, 'error');
    }
  };

  /** HC → 掛載時自動載入歷史出貨單 */
  useEffect(() => {
    if (manager) loadShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 經辦人快選（從清單聚合，JL 等使用者直接篩） */
  const shipOperators = useMemo(() => {
    const set = new Set(
      (shipList || []).map((o) => String(o.operator || '').trim()).filter((x) => x && x !== '—'),
    );
    return [...set];
  }, [shipList]);

  /** 展開單張出貨單詳情（單頭×明細，含試算表列號） */  async function openShipment(o) {
    setShipDetail({ order: { ...o, _loading: true }, lines: [] });
    setShipEdit({});
    setShipLineQty({});
    setShipForce(false);
    setShipDelArm(false);
    try {
      const res = await gasRequest(getGasUrl(), { action: 'get_shipment', shipment_id: o.shipment_id });
      setShipDetail({ ...res, order: { ...res.order, operator: o.operator || '—' } });
      setShipDetail(res);
      setShipEdit({
        shipment_date: res.order.shipment_date || '',
        customer_name: res.order.customer_name || '',
        status: res.order.status || '',
        remark: res.order.remark || '',
        invoice_no: res.order.invoice_no || '',
        carrier: res.order.carrier || '',
        port_from: res.order.port_from || '',
        port_to: res.order.port_to || '',
        incoterm: res.order.incoterm || '',
        currency: res.order.currency || '',
      });
      setShipLineQty(
        Object.fromEntries(res.lines.map((l) => [String(l.row), String(l.qty)])),
      );
    } catch (e) {
      setShipDetail(null);
      showToast(`❌ 讀取出貨單失敗：${e.message}`, 'error');
    }
  }

  /** 儲存修改（單頭＋數量）→ update_shipment */
  async function handleShipUpdate() {
    if (!shipDetail) return;
    const changedLines = shipDetail.lines
      .filter((l) => Number(shipLineQty[String(l.row)]) !== Number(l.qty))
      .map((l) => ({ row: l.row, qty: Number(shipLineQty[String(l.row)]) }));
    if (
      changedLines.length > 0 &&
      changedLines.some((l) => !(isFinite(l.qty) && l.qty > 0))
    ) {
      return showToast('❌ 修正後的數量必須大於 0', 'error');
    }
    setShipBusy(true);
    try {
      const res = await gasRequest(getGasUrl(), {
        action: 'update_shipment',
        shipment_id: shipDetail.order.shipment_id,
        operator: operator.trim() || 'HC',
        shipment_date: shipEdit.shipment_date,
        customer_name: shipEdit.customer_name,
        status: shipEdit.status,
        remark: shipEdit.remark,
        invoice_no: shipEdit.invoice_no,
        carrier: shipEdit.carrier,
        port_from: shipEdit.port_from,
        port_to: shipEdit.port_to,
        incoterm: shipEdit.incoterm,
        currency: shipEdit.currency,
        force: shipForce,
        lines: changedLines,
      });
      (res.updated_items || []).forEach((it) => onItemsUpdated(it));
      showToast(
        `✅ 出貨單 ${res.shipment_id} 已更新` +
          (changedLines.length ? `（修正 ${changedLines.length} 列數量，庫存已同步調整）` : ''),
      );
      setShipBusy(false);
      const id = shipDetail.order.shipment_id;
      await loadShipments();
      const fresh = await gasRequest(getGasUrl(), { action: 'get_shipment', shipment_id: id });
      setShipDetail(fresh);
      setShipLineQty(Object.fromEntries(fresh.lines.map((l) => [String(l.row), String(l.qty)])));
      setShipForce(false);
    } catch (e) {
      setShipBusy(false);
      showToast(`❌ 修改失敗：${e.message}`, 'error');
    }
  }

  /** 刪除整張出貨單（回補庫存並寫回補紀錄） */
  async function handleShipDelete() {
    if (!shipDetail) return;
    setShipBusy(true);
    try {
      const res = await gasRequest(getGasUrl(), {
        action: 'delete_shipment',
        shipment_id: shipDetail.order.shipment_id,
        operator: operator.trim() || 'HC',
      });
      (res.returned || []).forEach((r) => {
        const it = (items || []).find((x) => x.item_code === r.item_code);
        if (it) onItemsUpdated({ ...it, stock_qty: Number(it.stock_qty || 0) + Number(r.qty) });
      });
      showToast(
        `🗑 出貨單 ${res.shipment_id} 已刪除：${res.restored_count} 個品號庫存已回補（STOCK_LOG 記「回補」）`,
      );
      setShipBusy(false);
      setShipDetail(null);
      await loadShipments();
    } catch (e) {
      setShipBusy(false);
      showToast(`❌ 刪除失敗：${e.message}`, 'error');
    }
  }

  /** 掃碼加入一列明細（數量留空待填） */
  function addLine(item) {
    setLines((prev) => [
      ...prev,
      { item, qty: '', carton: '', price: '', nw: '', gw: '' },
    ]);
  }

  /**
   * 批次挑選彈窗：【整批帶入】一次性推入全部勾選品項
   * （單次 setState，同品號已存在時直接累加到既有那一列）
   */
  function addLines(list) {
    setLines((prev) => {
      const next = [...prev];
      const idxByCode = new Map(prev.map((l, i) => [l.item.item_code, i]));
      list.forEach(({ item, qty }) => {
        const i = idxByCode.get(item.item_code);
        if (i === undefined) {
          idxByCode.set(item.item_code, next.length);
          next.push({ item, qty: String(qty), carton: '', price: '', nw: '', gw: '' });
        } else {
          next[i] = { ...next[i], qty: String(Number(next[i].qty) + qty) };
        }
      });
      return next;
    });
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
            onClick={() => setBatchOpen(true)}
            className="min-h-touch flex-1 rounded-2xl bg-blue-700 py-2.5 text-base font-extrabold text-white shadow-card transition active:bg-blue-800 active:scale-[0.98]"
          >
            ＋ 批次加入品項（多選）
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
        <p className="px-1 text-xs font-bold text-slate-400">
          打開「批次加入」可一次勾選多款並逐列填出庫數量，一次整批帶入；或用掃碼單筆加入
        </p>

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

      {/* ===== 歷史出貨單管理（HC 限定：編輯單頭／修正數量／刪除整張回補庫存） ===== */}
      {manager && (
        <div className="mt-6 space-y-2 rounded-3xl bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-extrabold text-slate-900">🗂 歷史出貨單（HC 管理）</h3>
            <button
              onClick={loadShipments}
              disabled={shipList === null}
              className="rounded-xl px-3 py-1.5 text-xs font-extrabold text-blue-700 transition active:scale-95 disabled:opacity-40"
            >
              ⟳ 更新
            </button>
          </div>

          {shipList === null ? (
            <p className="py-4 text-center text-sm font-bold text-slate-400">⟳ 載入出貨單清單中…</p>
          ) : shipList.length === 0 ? (
            <p className="py-4 text-center text-xs font-bold text-slate-400">
              還沒有任何出貨單（送出第一張之後會出現在此）
            </p>
          ) : (
            <>
              <input
                className="field-input"
                placeholder="搜尋：單號 SH… / 客戶 / Invoice… / 經辦"
                value={shipFilter}
                onChange={(e) => setShipFilter(e.target.value)}
              />
              {shipOperators.length > 0 && (
                <select
                  className="field-input"
                  value={shipOpFilter}
                  onChange={(e) => setShipOpFilter(e.target.value)}
                >
                  <option value="全部">經辦：全部（{shipOperators.length} 人）</option>
                  {shipOperators.map((p) => (
                    <option key={p} value={p}>👤 {p}</option>
                  ))}
                </select>
              )}
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100">
                {shipList
                  .filter((o) => {
                    const f = shipFilter.trim().toLowerCase();
                    if (shipOpFilter !== '全部' && String(o.operator || '') !== shipOpFilter) return false;
                    if (!f) return true;
                    return `${o.shipment_id} ${o.customer_name} ${o.invoice_no} ${o.shipment_date} ${o.remark} ${o.operator}`
                      .toLowerCase()
                      .includes(f);
                  })
                  .slice(0, 50)
                  .map((o) => (
                    <li key={o.shipment_id}>
                      <button
                        onClick={() => openShipment(o)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition active:bg-slate-50"
                      >
                        <span className="min-w-0">
                          <span className="font-mono text-xs font-bold text-blue-700">{o.shipment_id}</span>
                          <span className="ml-2 text-sm font-extrabold text-slate-800">{o.customer_name}</span>
                          <span className="block text-[11px] font-semibold text-slate-400">
                            {o.shipment_date || '—'} · {o.total_styles} 款 · {fmtQty(o.total_pcs)} PCS
                            {o.total_amount ? ` · $${fmtQty(o.total_amount)}` : ''}
                            {o.invoice_no ? ` · ${o.invoice_no}` : ''} · {o.status || ''}
                            {o.operator && o.operator !== '—' ? ` · 👤${o.operator}` : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-extrabold text-slate-400">✏️ / 🗑</span>
                      </button>
                    </li>
                  ))}
              </ul>
              <p className="px-1 text-[10px] font-bold text-slate-400">
                顯示最近 100 張內、篩後前 50 張。點任一張可編輯單頭／明細數量，或刪除整張（庫存自動回補）
              </p>
            </>
          )}
        </div>
      )}

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

      {/* ===== 歷史出貨單詳情／編輯彈窗（HC） ===== */}
      {shipDetail && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => !shipBusy && setShipDetail(null)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-md flex-col rounded-3xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 標題 */}
            <div className="flex items-center justify-between border-b border-slate-100 p-4 pb-3">
              <div className="min-w-0">
                <h3 className="truncate text-lg font-extrabold">
                  ✏️ 出貨單 {shipDetail.order.shipment_id}
                </h3>
                {shipDetail.order.operator && shipDetail.order.operator !== '—' && (
                  <p className="text-[11px] font-bold text-slate-400">👤 經辦：{shipDetail.order.operator}</p>
                )}
              </div>
              <button className="text-slate-400" onClick={() => !shipBusy && setShipDetail(null)}>✕</button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {shipDetail.order._loading && (
                <p className="py-6 text-center text-sm font-bold text-slate-400">⟳ 載入明細中…</p>
              )}
              {!shipDetail.order._loading && (
                <>
                  {/* 單頭編輯 */}
                  <div className="space-y-2 rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs font-extrabold text-slate-500">單頭（可直接改）</p>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="field-label">出貨日期</label>
                        <input
                          className="field-input"
                          type="date"
                          value={shipEdit.shipment_date || ''}
                          onChange={(e) => setShipEdit((p) => ({ ...p, shipment_date: e.target.value }))}
                        />
                      </div>
                      <div className="flex-1">
                        <label className="field-label">狀態</label>
                        <input
                          className="field-input"
                          placeholder="已出庫"
                          value={shipEdit.status || ''}
                          onChange={(e) => setShipEdit((p) => ({ ...p, status: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="field-label">客戶</label>
                      <input
                        className="field-input"
                        value={shipEdit.customer_name || ''}
                        onChange={(e) => setShipEdit((p) => ({ ...p, customer_name: e.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="field-label">Invoice No</label>
                        <input
                          className="field-input font-mono"
                          value={shipEdit.invoice_no || ''}
                          onChange={(e) => setShipEdit((p) => ({ ...p, invoice_no: e.target.value }))}
                        />
                      </div>
                      <div className="flex-1">
                        <label className="field-label">船名航次</label>
                        <input
                          className="field-input"
                          value={shipEdit.carrier || ''}
                          onChange={(e) => setShipEdit((p) => ({ ...p, carrier: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <input
                        className="field-input flex-1"
                        placeholder="起運港"
                        value={shipEdit.port_from || ''}
                        onChange={(e) => setShipEdit((p) => ({ ...p, port_from: e.target.value }))}
                      />
                      <input
                        className="field-input flex-1"
                        placeholder="目的港"
                        value={shipEdit.port_to || ''}
                        onChange={(e) => setShipEdit((p) => ({ ...p, port_to: e.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2">
                      <input
                        className="field-input flex-1"
                        placeholder="貿易條件"
                        value={shipEdit.incoterm || ''}
                        onChange={(e) => setShipEdit((p) => ({ ...p, incoterm: e.target.value }))}
                      />
                      <input
                        className="field-input w-24 shrink-0"
                        placeholder="幣別"
                        value={shipEdit.currency || ''}
                        onChange={(e) => setShipEdit((p) => ({ ...p, currency: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="field-label">備註 / 買方 PO</label>
                      <input
                        className="field-input"
                        value={shipEdit.remark || ''}
                        onChange={(e) => setShipEdit((p) => ({ ...p, remark: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* 明細數量修正 */}
                  <div>
                    <p className="mb-1 text-xs font-extrabold text-slate-500">
                      明細（數量可修正；改完儲存會自動調整庫存）
                    </p>
                    <div className="space-y-1.5">
                      {shipDetail.lines.map((l) => {
                        const key = String(l.row);
                        const cur = Number(shipLineQty[key] ?? l.qty);
                        const orig = Number(l.qty);
                        const changed = cur !== orig;
                        return (
                          <div
                            key={key}
                            className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${
                              changed ? 'border-amber-400 bg-amber-50' : 'border-slate-100'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <b className="text-sm text-slate-900">{l.item_name}</b>
                              {l.color_spec && <span className="text-xs text-slate-500">（{l.color_spec}）</span>}
                              <span className="block font-mono text-[10px] text-slate-400">
                                {l.item_code}
                                {l.carton_no ? ` · ${l.carton_no}` : ''}
                                {l.unit_price ? ` · $${fmtQty(l.unit_price)}` : ''}
                              </span>
                            </div>
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              className={`h-11 w-20 shrink-0 rounded-xl border-2 px-2 text-right font-black tabular-nums ${
                                changed ? 'border-amber-400 text-amber-700' : 'border-slate-200 text-slate-700'
                              }`}
                              value={shipLineQty[key] ?? String(l.qty)}
                              onChange={(e) =>
                                setShipLineQty((p) => ({ ...p, [key]: e.target.value }))
                              }
                            />
                            <span className="w-10 shrink-0 text-[10px] font-bold text-slate-400">{l.unit}</span>
                          </div>
                        );
                      })}
                      {shipDetail.lines.length === 0 && (
                        <p className="text-center text-xs font-bold text-slate-400">此單沒有明細</p>
                      )}
                    </div>
                    {shipDetail.lines.some(
                      (l) => Number(shipLineQty[String(l.row)]) > Number(l.qty),
                    ) && (
                      <label className="mt-2 flex items-start gap-2 rounded-2xl bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
                        <input
                          type="checkbox"
                          checked={shipForce}
                          onChange={(e) => setShipForce(e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-amber-600"
                        />
                        <span className="text-[11px] font-bold leading-snug text-amber-800">
                          🩹 補帳模式：數量調整需要追加扣庫但帳面庫存不足時，勾起來允許負庫存
                        </span>
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* 底部操作 */}
            <div className="space-y-2 border-t border-slate-100 p-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <button
                className="btn-primary"
                disabled={shipBusy}
                onClick={handleShipUpdate}
              >
                {shipBusy ? '處理中…' : '💾 儲存修改'}
              </button>
              <button
                className={`min-h-touch w-full rounded-2xl py-2.5 text-sm font-extrabold transition active:scale-[0.98] ${
                  shipDelArm ? 'bg-red-600 text-white' : 'bg-red-100 text-red-600'
                }`}
                disabled={shipBusy}
                onClick={() => {
                  if (!shipDelArm) return setShipDelArm(true);
                  handleShipDelete();
                }}
              >
                {shipDelArm ? '⚠️ 再按一次＝真的刪除整張（庫存回補）' : '🗑 刪除整張出貨單（回補庫存）'}
              </button>
              {shipDelArm && (
                <p className="px-1 text-[10px] font-bold text-red-500">
                  刪除後：主表＋明細整張移除，各品號如有失誤可用「庫存查詢」核對；STOCK_LOG 會記「回補」紀錄
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== 批次挑選彈窗（多選＋逐列填數量 → 整批帶入） ===== */}
      <BatchItemPicker
        open={batchOpen}
        items={items}
        showToast={showToast}
        onClose={() => setBatchOpen(false)}
        onPick={(list) => {
          addLines(list); // 單次 setState 整批推入
          setBatchOpen(false);
        }}
      />

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
