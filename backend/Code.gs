/**************************************************************************
 * 針織/成帽工廠庫存系統 – Google Apps Script 後端 (Web App)
 * ---------------------------------------------------------------
 * 部署步驟（詳細圖文請見專案 README.md）：
 *   1. 在接到的 Google 試算表中：擴充功能 ➔ Apps Script ➔ 貼上本檔全部內容
 *   2. 先手動執行一次 setupSheets()（建立八張表、凍結標題列、允許授權、
 *      安裝工作令到期檢查觸發器）

 *   3. 部署 ➔ 新增部署作業 ➔ 類型「網路應用程式」
 *        - 描述：knit inventory API
 *        - 執行身份：我（此試算表擁有者）
 *        - 誰可以存取：任何人
 *   4. 複製產生的網站應用程式網址（結尾 /exec）
 *
 * API 協定（前端 fetch POST，Content-Type: text/plain, body 為 JSON）：
 *   { action: "ping",  }                            → 版本/時間（連線測試）
 *   { action: "list",  }                            → 整份庫存主檔陣列
 *   { action: "get",   item_code }                  → 單一料件
 *   { action: "log",   type, item_code, qty,
 *                     operator, remark, force,
 *                     new_item }                    → 記一筆異動並更新庫存
 *       type   : "入庫" | "出庫" | "盤點"
 *       盤點   : qty = 盤點後實際庫存量（可為 0），Change_Qty = qty - 原庫存
 *       force  : true 允許出庫後形成負庫存（前端已在彈窗二次確認過）
 *       new_item：僅入庫可用。品號不存在於主檔時，附上此物件即可
 *                 直接建立新品項並入庫：
 *                   { item_code(留空→自動編號A####), item_name(必填),
 *                     category, color_spec, unit(預設PCS), location }
 *
 * ---- 工作令（工單）連動與入庫 ----
 *   { action: "list_work_orders", }                 → 整份工作令陣列
 *   { action: "list_bom", }                         → 整份 BOM 物料清單
 *   { action: "create_work_order",
 *     style_no, plan_qty, due_date,
 *     destination, order_ref }                      → 開立工作令（狀態=生產中）
 *       destination : "入倉庫" | "訂單出貨"
 *   { action: "complete_work_order",
 *     wo_id, actual_qty, target_item_code,
 *     use_bom, operator, remark }                   → 確認完工結案
 *       入倉庫   : target_item_code 必填 → 成品入庫（STOCK_LOG 記錄）
 *       訂單出貨 : 不入庫存，狀態 → 待出貨
 *       use_bom  : true → 依 BOM_MASTER 扣原料（出庫記錄，允許負庫存）
 *   { action: "ship_work_order", wo_id }            → 待出貨 → 已出貨
 *
 * 每日到期檢查：checkDueWorkOrders()（Time-driven 觸發，setupSheets 會自動安裝）
 *   Due_Date 已過期且狀態仍為「生產中」→ 自動改為「待確認」
 *
 * ---- 出庫與出貨單（外銷出貨） ----
 *   { action: "list_customers" }                    → 客戶清單 [{customer_id, customer_name, country}]
 *   { action: "add_customer",
 *     customer_name, country? }                     → 新增客戶（重複名稱擋下）
 *   { action: "create_shipment",
 *     shipment_date?, invoice_no?(留空自動GS-yyyyMMdd),
 *     customer_name, operator?, remark?,
 *     carrier?, port_from?, port_to?, incoterm?, currency?,
 *     lines: [{ item_code, qty, carton_no?, unit_price?, n_w?, g_w? }] }
 *                                                   → 建立出貨單（單號 SHyyyyMMdd-##）
 *       1. 批次扣減 INVENTORY_MASTER（同一品號可分多列/多箱，合併檢查；
 *          任一品合計不足 → 整張擋下並回報）
 *       2. 每一列明細寫入 STOCK_LOG（出庫；備註含出貨單號＋客戶）
 *       3. 寫入 SHIPMENT_ORDERS 主表（含 Invoice/Carrier/港口/貿易條件/
 *          總箱數/總金額/總淨毛重）＋ SHIPMENT_DETAILS 明細（含箱號/單價/重量）
 *       → 欄位結構對應外銷 Commercial Invoice / Packing List (DATA_ENTRY)
 *   { action: "list_shipments" }                    → 出貨單主表（匯出 Invoice / Packing List 用）
 *   { action: "getSalesReport", operator, period? } → 營運統計報表（🔐 僅限管理者 HC / MAIN）
 *       period: "ALL" | "YEAR"（本年）| "MONTH"（本月），預設 ALL
 *       operator 非 HC/MAIN（不分大小寫、允許「01-HC」等名冊格式）→ 拋出權限拒絕
 *       （Apps Script 無法設 HTTP 狀態碼，回應為 ok:false error:「權限不足…」，
 *         前端一律以錯誤處理，絕不回傳任何營業額或匯總資料）
 *       彙總來源：SHIPMENT_ORDERS（客戶/金額/箱重）＋ SHIPMENT_DETAILS（款式排行）
 *
 *   { action: "update_item_info", item_code,
 *     image_url?, style_category?, season?,      → 更新品項圖鑑資訊（缺的欄不動）
 *     is_public? }                                 回傳 { item }
 *   { action: "public_lookbook" }                  → 🌍 數位圖鑑（免存取碼，GET/POST 皆可）
 *       僅 Is_Public≠'N' 款式；已過濾庫存/內部欄位，只回
 *       style_no/品名/帽型分類/季節/顏色清單/Image_URL（以款式 grouping）
 *
 * ---- 批次出入庫（購物車模式，一次多筆品項） ----
 *   { action: "batchStockTransaction" (或 batch_stock_transaction),
 *     type: "IN" | "OUT" | "入庫" | "出庫" | "盤點",
 *     customer?, operator?, remark?, force?,
 *     items: [{ item_code?, qty, new_item? }, ...] } → 批次異動
 *       1. 一次性讀取 INVENTORY_MASTER（getDataRange）
 *       2. 盤點：qty = 盤點後實際庫存量
 *          出庫：整批檢查庫存，任一不足 → 整批擋下（force:true 才允許負庫存）
 *          入庫：item_code 留空可附 new_item 直接建主檔（item_code 須自填）
 *       3. Stock_Qty / Last_Updated 兩欄各以 setValues 一次整欄寫回
 *       4. STOCK_LOG 以 setValues 一次批次附加全部明細
 *       5. 出庫且有填 customer → 額外建立 SHIPMENT_ORDERS / SHIPMENT_DETAILS
 * 回應：{ ok: true, data: ... } 或 { ok: false, error: "訊息" }
 **************************************************************************/

var SHEET_MASTER = 'INVENTORY_MASTER'; // 庫存主檔
var SHEET_LOG = 'STOCK_LOG';           // 出入庫異動記錄
var SHEET_OPS = 'OPERATORS';           // 經辦人名冊（序號 + 姓名）

var MASTER_HEADERS = [
  'Item_Code', 'Item_Name', 'Category', 'Color_Spec',
  'Stock_Qty', 'Unit', 'Location', 'Last_Updated',
  'Image_URL', // 第 9 欄（選填）：款式圖片連結＝舊稱 Photo_URL（存於 Google Drive 或外部 URL）
  // ---- 數位圖鑑（Lookbook）欄位 ----
  'Style_Category', // 第 10 欄（選填）：帽型分類（Fedora 紳士帽 / Casquette 報童帽 / Beret 貝雷帽 / Cap / Boonie…）
  'Season',         // 第 11 欄（選填）：SS（春夏）/ AW（秋冬）/ 四季款
  'Is_Public',      // 第 12 欄（選填）：圖鑑對外公開 Y / N（留空＝Y）
];
var LOG_HEADERS = [
  'Log_ID', 'Timestamp', 'Type', 'Item_Code',
  'Change_Qty', 'Operator', 'Remark',
];

var OPS_HEADERS = ['序號', '姓名', '備註']; // 名冊：序號已預填 01~30，姓名之後自行填寫
var OPS_PRESET_ROWS = 30;

var SHEET_WO = 'WORK_ORDERS';           // 工作令（工單）
var SHEET_BOM = 'BOM_MASTER';           // 物料清單（BOM）
var WO_HEADERS = [
  'WO_ID', 'Style_No', 'Plan_Qty', 'Due_Date',
  'Destination', 'Order_Ref', 'Status', 'Actual_Qty', 'Completed_Time',
];
var BOM_HEADERS = ['Style_No', 'Item_Code', 'Item_Name', 'Unit_Use']; // Unit_Use = 每件耗用量

var WO_DESTS = ['入倉庫', '訂單出貨'];
var WO_STATUS_ACTIVE = '生產中';
var WO_STATUS_CHECK = '待確認';
var WO_STATUS_TOSHIP = '待出貨';
var WO_STATUS_IN = '已入庫';
var WO_STATUS_SHIPPED = '已出貨';

var SHEET_CUST = 'CUSTOMERS';                // 客戶清單
var SHEET_SHP = 'SHIPMENT_ORDERS';           // 出貨單主表
var SHEET_SHPD = 'SHIPMENT_DETAILS';         // 出貨單明細
var CUST_HEADERS = ['Customer_ID', 'Customer_Name', 'Country'];
var SHP_HEADERS = [
  'Shipment_ID', 'Shipment_Date', 'Customer_Name', 'Total_Styles', 'Total_PCS', 'Status', 'Remark',
  // 外銷單據（Commercial Invoice / Packing List DATA_ENTRY 對應欄）
  'Invoice_No', 'Carrier', 'Port_From', 'Port_To', 'Incoterm', 'Currency',
  'Total_Cartons', 'Total_Amount', 'Total_NW', 'Total_GW',
];
var SHPD_HEADERS = [
  'Shipment_ID', 'Item_Code', 'Style_No', 'Color_Spec', 'Qty', 'Unit',
  'Carton_No', 'Unit_Price', 'N_W', 'G_W', 'Amount', // Amount = Unit_Price × Qty
];
var SHP_STATUS = '已出庫';

/** 🔐 營運報表白名單：僅限這些使用者代碼可查看統計報表（商業機密）
 *  前端 src/api.js 的 ALLOWED_MANAGERS 需與此同步 */
var ALLOWED_MANAGERS = ['HC', 'MAIN'];

var VALID_TYPES = ['入庫', '出庫', '盤點'];

/* ============================================================
 * 🔐 存取碼（建議設定！）
 * ------------------------------------------------------------
 * 留空   = 不驗證（完全公開，知道網址就能用）
 * 設定後 = 前端每個請求都必須帶正確 token，否則拒絕
 * 用法：把下面改成自己的密語（例：'帽廠2026'），前端「設定」分頁
 *       填入同一組存取碼即可。網址外流也進不來。
 * ============================================================ */
var API_TOKEN = 'GU3132'; // 前端「設定」分頁需填入同一組存取碼

/* ========================= Endpoints ========================= */

function doPost(e) {
  try {
    var req = parseRequest_(e);
    checkToken_(req);
    var data;
    switch (String(req.action || '')) {
      case 'ping':
        data = ping_();
        break;
      case 'list':
        data = listMaster_();
        break;
      case 'get':
        data = findByCode_(String(req.item_code || ''));
        break;
      case 'log':
        data = recordLog_(req);
        break;
      case 'list_operators':
        data = listOperators_();
        break;
      case 'upload_photo':
        data = uploadPhoto_(req);
        break;
      case 'list_work_orders':
        data = listWorkOrders_();
        break;
      case 'list_bom':
        data = listBom_();
        break;
      case 'create_work_order':
        data = createWorkOrder_(req);
        break;
      case 'complete_work_order':
        data = completeWorkOrder_(req);
        break;
      case 'ship_work_order':
        data = shipWorkOrder_(req);
        break;
      case 'list_customers':
        data = listCustomers_();
        break;
      case 'add_customer':
        data = addCustomer_(req);
        break;
      case 'create_shipment':
        data = createShipment_(req);
        break;
      case 'list_shipments':
        data = listShipments_();
        break;
      case 'getSalesReport':
      case 'get_sales_report':
        data = getSalesReport_(req);
        break;
      case 'batchStockTransaction':
      case 'batch_stock_transaction':
        data = batchStockTransaction_(req);
        break;
      case 'update_item_info':
        data = updateItemInfo_(req);
        break;
      case 'public_lookbook':
        data = getPublicLookbook_();
        break;
      default:
        throw new Error('未知的 action：' + req.action + '（可用：ping / list / get / log / upload_photo）');
    }
    return makeResponse_({ ok: true, data: data });
  } catch (err) {
    return makeResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = String(params.action || '');
  try {
    // 🌍 公開圖鑑：資料已過濾商業機密（無庫存／成本欄位），不需存取碼，
    //    供「客戶分享連結 #/lookbook?api=…」直接撈取
    if (action === 'public_lookbook') {
      return makeResponse_({ ok: true, data: getPublicLookbook_() });
    }
    checkToken_(params);
    if (action === 'ping') return makeResponse_({ ok: true, data: ping_() });
    if (action === 'list') return makeResponse_({ ok: true, data: listMaster_() });
    if (action === 'get') {
      return makeResponse_({ ok: true, data: findByCode_(String(params.item_code || '')) });
    }
  } catch (err) {
    return makeResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }

  // 預設：回一頁簡易使用說明（用瀏覽器直接開網址測試時可以看到）
  var html =
    '<body style="font-family:sans-serif;line-height:1.8;max-width:640px;margin:40px auto;padding:0 20px">' +
    '<h2>🧶 帽廠庫存 API（Google Apps Script）</h2>' +
    '<p>後端運行中 ✓。此網址需由前端以 POST JSON 呼叫。</p>' +
    '<p>GET 測試：<code>?action=list</code>、<code>?action=ping</code></p>' +
    '<p>前端設定：到 App「設定」分頁貼上此網址（結尾 /exec）。</p>' +
    '<p style="color:#888">伺服器時間：' + now_() + '</p></body>';
  return ContentService.createTextOutput(html).setMimeType(ContentService.MimeType.HTML);
}

/* ========================= Actions ========================= */

function ping_() {
  return {
    version: '1.0.0',
    serverTime: now_(),
    itemCount: getSheet_(SHEET_MASTER).getLastRow() - 1,
  };
}

/** 整份庫存主檔，依品號排序；回傳每筆資料皆為小寫底線欄位 */
function listMaster_() {
  var values = getSheet_(SHEET_MASTER).getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    rows.push(rowToItem_(values[i]));
  }
  rows.sort(function (a, b) {
    return String(a.item_code).localeCompare(String(b.item_code));
  });
  return rows;
}

/** 經辦人名冊：讀出「姓名」已填寫的人（序號預填 01~30，姓名之後自行補） */
function listOperators_() {
  var sheet = getSheet_(SHEET_OPS);
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var code = String(values[i][0] ?? '').trim();
    var name = String(values[i][1] ?? '').trim();
    if (!name) continue; // 姓名空白 = 還未登記
    out.push({ code: code, name: name });
  }
  return out;
}

function findByCode_(code) {  var sheet = getSheet_(SHEET_MASTER);
  var row = findMasterRow_(sheet, code);
  if (row === -1) return null;
  return rowToItem_(sheet.getRange(row, 1, 1, MASTER_HEADERS.length).getValues()[0]);
}

/**
 * 記錄一筆異動 + 更新主檔庫存（具 LockService 防止併發覆寫）
 */
function recordLog_(req) {
  var type = String(req.type || '').trim();
  if (VALID_TYPES.indexOf(type) === -1) {
    throw new Error('Type 必須為：入庫 / 出庫 / 盤點，收到：' + type);
  }
  var code = String(req.item_code || '').trim();
  if (!code) throw new Error('缺少品號 Item_Code');
  var qty = Number(req.qty);
  if (isNaN(qty) || qty < 0) throw new Error('數量格式錯誤（不可為負數）');
  if (type !== '盤點' && qty <= 0) throw new Error('異動數量必須大於 0');
  var operator = String(req.operator || '').trim();
  if (!operator) throw new Error('缺少經辦人 Operator');
  var remark = String(req.remark || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // 等待 30 秒，防止兩支手機同時改到同一料件
  try {
    var master = getSheet_(SHEET_MASTER);
    var row = findMasterRow_(master, code);
    var isNewItem = false;
    // 入庫新品項：品號不存在且附 new_item → 先建立主檔列再入庫
    if (row === -1 && type === '入庫' && req.new_item && typeof req.new_item === 'object') {
      row = createMasterRow_(master, req.new_item, code);
      code = String(master.getRange(row, 1).getValue()); // 自動編號後的實際品號
      isNewItem = true;
    }
    if (row === -1) throw new Error('品號不存在於 INVENTORY_MASTER：' + code);

    var colQty = 5; // Stock_Qty 所在欄（第 5 欄 E）
    var current = Number(master.getRange(row, colQty).getValue()) || 0;

    var change, after;
    if (type === '入庫') {
      change = qty;
      after = current + qty;
    } else if (type === '出庫') {
      change = -qty;
      after = current - qty;
      if (after < 0 && !req.force) {
        throw new Error(
          '庫存不足：目前 ' + current + '、欲出庫 ' + qty + '。若確定要出庫（負庫存），需附 force:true'
        );
      }
    } else {
      // 盤點：qty = 盤點後實際庫存量
      change = qty - current;
      after = qty;
    }

    // 更新主檔
    master.getRange(row, colQty).setValue(after);
    master.getRange(row, 8).setValue(now_()); // Last_Updated

    // 寫入異動記錄
    var logId = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
      ('000' + Math.floor(Math.random() * 1000)).slice(-3);
    getSheet_(SHEET_LOG).appendRow([logId, now_(), type, code, change, operator, remark]);

    return {
      log_id: logId,
      item_code: code,
      is_new_item: isNewItem,
      balance_before: current,
      balance_after: after,
      change: change,
      item: rowToItem_(master.getRange(row, 1, 1, MASTER_HEADERS.length).getValues()[0]),
    };
  } finally {
    try {
      lock.releaseLock();
    } catch (e) { /* ignore */ }
  }
}

/* ============================================================
 * 批次出入庫（Batch Entry：購物車模式，一次多筆品項）
 * ============================================================ */

/**
 * 批次出入庫：
 * req = { type: "IN"|"OUT"|"入庫"|"出庫"|"盤點", customer?, operator?, remark?,
 *         force?, items: [{ item_code?, qty, new_item? }, ...] }
 * - 盤點：qty = 盤點後實際庫存量（Change_Qty = qty - 原庫存）
 * - 出庫：整批檢查庫存，回報所有不足品項；force:true 才允許負庫存
 * - 入庫：品號不存在時可附 new_item 建主檔（new_item.item_code 建議自填，
 *   留空則自動編號 A####）
 * - 出庫且有填 customer → 額外建立出貨單（SHIPMENT_ORDERS / SHIPMENT_DETAILS）
 * - 主檔 Stock_Qty / Last_Updated 兩欄各一次 setValues 整欄寫回；
 *   STOCK_LOG 一次 setValues 批次附加（避免逐格讀寫造成量能下降）
 * 回傳 { type, total_items, total_qty, updated_items, shipment_id? }
 */
function batchStockTransaction_(req) {
  var typeRaw = String(req.type || '').trim().toUpperCase();
  var type = (typeRaw === 'IN') ? '入庫' : (typeRaw === 'OUT') ? '出庫' : String(req.type || '').trim();
  if (VALID_TYPES.indexOf(type) === -1) {
    throw new Error('Type 必須為 IN / OUT / 入庫 / 出庫 / 盤點，收到：' + req.type);
  }
  var customer = String(req.customer || '').trim();
  var operator = String(req.operator || '').trim() || '—';
  var remark = String(req.remark || '').trim();
  var force = !!req.force;
  var colQty = 5, colUpdated = 8;

  var raw = Array.isArray(req.items) ? req.items : [];
  if (raw.length === 0) throw new Error('items 不可為空');

  // 先整理（品號重複擋下；數量檢查）
  var details = [];
  var seenCode = {};
  for (var i = 0; i < raw.length; i++) {
    var code = String(raw[i].item_code || '').trim().toUpperCase();
    var isNew = false;
    if (!code && raw[i].new_item && typeof raw[i].new_item === 'object' && type === '入庫') {
      isNew = true;
      code = String(raw[i].new_item.item_code || '').trim().toUpperCase();
    }
    if (!code) throw new Error('第 ' + (i + 1) + ' 筆缺少品號 Item_Code');
    if (seenCode[code]) throw new Error('品號重複：' + code + '（批次內請合併為一筆）');
    seenCode[code] = true;
    var qty = Number(raw[i].qty);
    if (isNaN(qty) || qty < 0) throw new Error('第 ' + (i + 1) + ' 筆數量格式錯誤：' + code);
    if (type !== '盤點' && qty <= 0) throw new Error('第 ' + (i + 1) + ' 筆異動數量必須大於 0：' + code);
    details.push({ code: code, qty: qty, is_new: isNew, new_item: raw[i].new_item || null });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var master = getSheet_(SHEET_MASTER);

    // ① 入庫新品項：先建主檔列（回帶實際品號）
    for (var n = 0; n < details.length; n++) {
      var dNew = details[n];
      if (dNew.is_new) {
        var newRow = createMasterRow_(master, dNew.new_item, dNew.code);
        dNew.code = String(master.getRange(newRow, 1).getValue()).toUpperCase();
      }
    }

    // ② 一次性讀取主檔：建立索引 + 檢查所有品項（出庫先全數驗庫存）
    var values = master.getDataRange().getValues();
    var index = {}; // CODE -> values 列索引（0-based）
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][0]).trim().toUpperCase();
      if (k && !index[k]) index[k] = r;
    }
    var shortages = [];
    for (var v1 = 0; v1 < details.length; v1++) {
      var dIdx = details[v1];
      dIdx.rowIdx = index[dIdx.code];
      if (dIdx.rowIdx === undefined) {
        throw new Error('品號不存在於 INVENTORY_MASTER：' + dIdx.code);
      }
      if (type === '出庫') {
        var curStock = Number(values[dIdx.rowIdx][4]) || 0;
        if (dIdx.qty > curStock) {
          shortages.push(dIdx.code + ' ' + String(values[dIdx.rowIdx][1]).trim() +
            '：在庫 ' + curStock + '、欲出庫 ' + dIdx.qty);
        }
      }
    }
    if (type === '出庫' && shortages.length > 0 && !force) {
      throw new Error('庫存不足，整批擋下（' + shortages.length + ' 項）：' + shortages.join('；'));
    }

    // ③ 計算異動後庫存與 Last_Updated
    var nRows = values.length;
    var newStocks = [];
    var newUpdated = [];
    for (var s = 0; s < nRows; s++) {
      newStocks.push([Number(values[s][4]) || 0]);
      newUpdated.push([String(values[s][7] || '')]);
    }
    var logRows = [];
    var updatedItems = [];
    var totalQty = 0;
    var logId = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
      ('000' + Math.floor(Math.random() * 1000)).slice(-3);
    var outCustomer = (type === '出庫' && customer) ? customer : '';
    var shipmentId = outCustomer ? nextShipmentId_() : '';
    for (var t = 0; t < details.length; t++) {
      var d = details[t];
      var rowIdx = d.rowIdx;
      var cur = Number(values[rowIdx][4]) || 0;
      var change, after;
      if (type === '入庫') {
        change = d.qty;
        after = cur + d.qty;
        totalQty += d.qty;
      } else if (type === '出庫') {
        change = -d.qty;
        after = cur - d.qty;
        totalQty += d.qty;
      } else {
        change = d.qty - cur;
        after = d.qty;
      }
      newStocks[rowIdx] = [round4_(after)];
      newUpdated[rowIdx] = [now_()];

      var lineRemark = remark;
      if (outCustomer) {
        lineRemark = '出貨 ' + shipmentId + ' ／ ' + outCustomer + (remark ? '；' + remark : '');
      }
      logRows.push([
        logId + ('00' + (t + 1)).slice(-2), now_(), type, d.code, change, operator, lineRemark,
      ]);

      var item = rowToItem_(values[rowIdx]);
      item.stock_qty = round4_(after);
      updatedItems.push(item);
    }

    // ④ Stock_Qty / Last_Updated 兩欄各一次 setValues 整欄寫回
    if (nRows > 1) {
      master.getRange(2, colQty, nRows - 1, 1).setValues(newStocks.slice(1));
      master.getRange(2, colUpdated, nRows - 1, 1).setValues(newUpdated.slice(1));
    }

    // ⑤ STOCK_LOG 以 setValues 一次批次附加
    var logSheet = getSheet_(SHEET_LOG);
    logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, LOG_HEADERS.length)
      .setValues(logRows);

    // ⑥ 出庫且有客戶 → 一併建立出貨單主表＋明細表
    if (outCustomer) {
      ensureSheet_(SHEET_SHP);
      ensureSheet_(SHEET_SHPD);
      var styleNames = {};
      var detailRows = [];
      for (var w = 0; w < details.length; w++) {
        var dw = details[w];
        styleNames[updatedItems[w].item_name] = true;
        detailRows.push([
          shipmentId, updatedItems[w].item_code, updatedItems[w].item_name,
          updatedItems[w].color_spec, dw.qty, updatedItems[w].unit,
          '', '', '', '', '',
        ]);
      }
      getSheet_(SHEET_SHP).appendRow([
        shipmentId, Utilities.formatDate(new Date(), nowTz_(), 'yyyy-MM-dd'),
        outCustomer, Object.keys(styleNames).length, totalQty, SHP_STATUS, remark,
        '', '', '', '', '', '', '', '', '', '',   // 外銷欄位批式出庫留空（出庫出貨分頁才有）
      ]);
      var detSheet = getSheet_(SHEET_SHPD);
      detSheet.getRange(detSheet.getLastRow() + 1, 1, detailRows.length, SHPD_HEADERS.length)
        .setValues(detailRows);
    }

    return {
      type: type,
      total_items: details.length,
      total_qty: round4_(totalQty),
      updated_items: updatedItems,
      shipment_id: shipmentId || undefined,
    };
  } finally {
    try {
      lock.releaseLock();
    } catch (e) { /* ignore */ }
  }
}

/**
 * 上傳款式照片：
 * req = { action:'upload_photo', item_code, data: dataURL(base64) }
 * → 存入雲端硬碟資料夾「帽廠庫存_款式照片」，網址寫回主檔 Photo_URL 欄
 */
function uploadPhoto_(req) {
  var code = String(req.item_code || '').trim();
  if (!code) throw new Error('缺少品號 Item_Code');
  var dataUrl = String(req.data || '');
  var m = dataUrl.match(/^data:([-\w.+]+\/[-\w.+]+);base64,(.+)$/);
  if (!m) throw new Error('圖片格式錯誤（需為 data:image/…;base64,…）');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var master = getSheet_(SHEET_MASTER);
    var row = findMasterRow_(master, code);
    if (row === -1) throw new Error('品號不存在於 INVENTORY_MASTER：' + code);

    var blob = Utilities.newBlob(
      Utilities.base64Decode(m[2]),
      m[1],
      code + '_' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMdd_HHmmss')
    );
    var file = getPhotoFolder_().createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // img 標籤直接可顯示的縮圖網址
    var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200';

    ensureSheet_(SHEET_MASTER);          // 補上 Image_URL 等標題（舊表）
    master.getRange(row, 9).setValue(url); // 第 9 欄 = Image_URL（款式圖片）

    return {
      item_code: code,
      image_url: url,
      file_id: file.getId(),
      item: rowToItem_(master.getRange(row, 1, 1, MASTER_HEADERS.length).getValues()[0]),
    };
  } finally {
    try {
      lock.releaseLock();
    } catch (e) { /* ignore */ }
  }
}

function getPhotoFolder_() {
  var name = '帽廠庫存_款式照片';
  var folders = DriveApp.getFolders();
  while (folders.hasNext()) {
    var f = folders.next();
    if (f.getName() === name) return f;
  }
  return DriveApp.createFolder(name);
}

/* ============================================================
 * 數位圖鑑（Lookbook / B2B Catalog）
 * ============================================================ */

/**
 * 更新品項的圖鑑資訊（圖片 URL／帽型分類／季節／是否公開）
 * req = { item_code, image_url?, style_category?, season?, is_public? }
 * （有傳欄位才更新，缺的欄不動；回傳更新後完整 item）
 */
function updateItemInfo_(req) {
  var code = String(req.item_code || '').trim();
  if (!code) throw new Error('缺少品號 Item_Code');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var master = getSheet_(SHEET_MASTER);
    ensureSheet_(SHEET_MASTER); // 舊表補上圖鑑欄位
    var row = findMasterRow_(master, code);
    if (row === -1) throw new Error('品號不存在於 INVENTORY_MASTER：' + code);

    if (req.image_url !== undefined) {
      master.getRange(row, 9).setValue(String(req.image_url || '').trim());
    }
    if (req.style_category !== undefined) {
      master.getRange(row, 10).setValue(String(req.style_category || '').trim());
    }
    if (req.season !== undefined) {
      master.getRange(row, 11).setValue(String(req.season || '').trim());
    }
    if (req.is_public !== undefined) {
      master.getRange(row, 12).setValue(
        String(req.is_public || '').trim().toUpperCase() === 'N' ? 'N' : 'Y',
      );
    }
    return { item: rowToItem_(master.getRange(row, 1, 1, MASTER_HEADERS.length).getValues()[0]) };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/**
 * 🌍 公開數位圖鑑（B2B 客戶挑款式用，不需存取碼）：
 * - 僅撈取 Is_Public ≠ 'N' 的款式（留空或 Y = 公開）
 * - 安全過濾：回傳只有款式資料本身——
 *   { style_no, style_name, style_category, season, category, image_url,
 *     colors: [顏色規格…] }
 *   絕不包含庫存量、位置、更新時間等內部欄位
 * - 以款式（Item_Name）為單位 grouping：同款所有顏色歸到同一張卡片
 */
function getPublicLookbook_() {
  var items = listMaster_();
  var map = {};
  var order = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (String(it.is_public || 'Y').toUpperCase() === 'N') continue; // 業主不想公開的款式
    var key = it.item_name;
    var g = map[key];
    if (!g) {
      g = map[key] = {
        style_no: it.item_name,
        style_name: it.item_name,
        style_category: it.style_category || '',
        season: it.season || '',
        category: it.category,
        image_url: '',
        colors: [],
      };
      order.push(key);
    }
    if (!g.image_url && it.image_url) g.image_url = it.image_url;
    if (!g.style_category && it.style_category) g.style_category = it.style_category;
    if (!g.season && it.season) g.season = it.season;
    if (it.color_spec && g.colors.indexOf(it.color_spec) === -1) g.colors.push(it.color_spec);
  }
  order.sort(function (a, b) { return a.localeCompare(b); });
  var rows = [];
  for (var k = 0; k < order.length; k++) rows.push(map[order[k]]);
  return rows;
}

/* ============================================================
 * 工作令（WORK_ORDERS）與 BOM（BOM_MASTER）
 * ============================================================ */

/** 整份工作令，以 WO_ID 由新到舊排序 */
function listWorkOrders_() {
  var sheet = getSheet_(SHEET_WO);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    rows.push(rowToWO_(values[i]));
  }
  rows.sort(function (a, b) { return String(b.wo_id).localeCompare(String(a.wo_id)); });
  return rows;
}

/** 整份 BOM（一列 = 一款樣式 × 一種原料） */
function listBom_() {
  var sheet = getSheet_(SHEET_BOM);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    rows.push(rowToBom_(values[i]));
  }
  return rows;
}

/** 找出某款式的 BOM 列 */
function bomForStyle_(styleNo) {
  return listBom_().filter(function (r) {
    return String(r.style_no).trim() === String(styleNo).trim();
  });
}

/**
 * 開立工作令（狀態=生產中），WO_ID 自動編號 WOyyMMdd-##
 */
function createWorkOrder_(req) {
  var style = String(req.style_no || '').trim();
  if (!style) throw new Error('缺少款號 Style_No');
  var planQty = Number(req.plan_qty);
  if (isNaN(planQty) || planQty <= 0) throw new Error('計畫數量 Plan_Qty 必須大於 0');
  var dest = String(req.destination || '').trim();
  if (WO_DESTS.indexOf(dest) === -1) {
    throw new Error('Destination 必須為：入倉庫 / 訂單出貨，收到：' + dest);
  }
  var due = String(req.due_date || '').trim();
  if (!due) throw new Error('缺少預計完工日 Due_Date');
  if (dueYMD_(due) === '') throw new Error('Due_Date 格式需為 YYYY-MM-DD：' + due);
  var orderRef = String(req.order_ref || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_(SHEET_WO);
    var woId = nextWOId_(sheet);
    sheet.appendRow([woId, style, planQty, dueYMD_(due), dest, orderRef, WO_STATUS_ACTIVE, '', '']);
    return {
      wo: rowToWO_(sheet.getRange(sheet.getLastRow(), 1, 1, WO_HEADERS.length).getValues()[0]),
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/**
 * 確認完工結案：
 * - 入倉庫 → 成品 target_item_code 入庫 Actual_Qty（STOCK_LOG 記錄，狀態 → 已入庫）
 * - 訂單出貨 → 不入庫，狀態 → 待出貨
 * - use_bom → 依 BOM_MASTER 扣原料（出庫記錄；不足照扣形成負庫存，前端已預覽警告）
 * 回傳 updated_items 供前端即時更新庫存畫面
 */
function completeWorkOrder_(req) {
  var woId = String(req.wo_id || '').trim();
  if (!woId) throw new Error('缺少 WO_ID');
  var actual = Number(req.actual_qty);
  if (isNaN(actual) || actual < 0) throw new Error('實際良品數 Actual_Qty 格式錯誤');
  var operator = String(req.operator || '').trim();
  if (!operator) throw new Error('缺少經辦人 Operator');
  var remark = String(req.remark || '').trim();
  var useBom = !!req.use_bom;
  var targetItem = String(req.target_item_code || '').trim();
  var colQty = 5; // Stock_Qty 所在欄（第 5 欄 E）

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var woSheet = getSheet_(SHEET_WO);
    var row = findWORow_(woSheet, woId);
    if (row === -1) throw new Error('找不到工作令：' + woId);
    var wo = rowToWO_(woSheet.getRange(row, 1, 1, WO_HEADERS.length).getValues()[0]);
    if (wo.status !== WO_STATUS_ACTIVE && wo.status !== WO_STATUS_CHECK) {
      throw new Error('工作令狀態為「' + wo.status + '」，不能完工');
    }

    var master = getSheet_(SHEET_MASTER);
    var updatedItems = [];
    var woRemark = 'WO 完工 ' + woId + (remark ? '；' + remark : '');

    if (wo.destination === '入倉庫') {
      if (!targetItem) throw new Error('入倉庫完工需選擇入庫料號 target_item_code');
      var itemRow = findMasterRow_(master, targetItem);
      if (itemRow === -1) throw new Error('品號不存在於 INVENTORY_MASTER：' + targetItem);
      var cur = Number(master.getRange(itemRow, colQty).getValue()) || 0;
      master.getRange(itemRow, colQty).setValue(cur + actual);
      master.getRange(itemRow, 8).setValue(now_()); // Last_Updated
      var logId = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
        ('000' + Math.floor(Math.random() * 1000)).slice(-3);
      getSheet_(SHEET_LOG).appendRow([
        logId, now_(), '入庫', String(master.getRange(itemRow, 1).getValue()), actual, operator, woRemark,
      ]);
      updatedItems.push(rowToItem_(master.getRange(itemRow, 1, 1, MASTER_HEADERS.length).getValues()[0]));
    }

    // BOM 扣料（兩種流向都會耗用原料；原料不足仍照扣 → 負庫存供現場檢討）
    var bomUsed = 0;
    if (useBom) {
      var bomRows = bomForStyle_(wo.style_no);
      for (var i = 0; i < bomRows.length; i++) {
        var code = String(bomRows[i].item_code).trim();
        if (!code) continue;
        var consume = Number(bomRows[i].unit_use) * actual;
        if (!(consume > 0)) continue;
        var mRow = findMasterRow_(master, code);
        if (mRow === -1) continue; // BOM 內原料品號不存在 → 跳過，不擋結案
        var mCur = Number(master.getRange(mRow, colQty).getValue()) || 0;
        master.getRange(mRow, colQty).setValue(mCur - consume);
        master.getRange(mRow, 8).setValue(now_());
        var logId2 = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
          ('000' + Math.floor(Math.random() * 1000)).slice(-3);
        getSheet_(SHEET_LOG).appendRow([logId2, now_(), '出庫', code, -consume, operator, 'WO BOM 扣料 ' + woId]);
        updatedItems.push(rowToItem_(master.getRange(mRow, 1, 1, MASTER_HEADERS.length).getValues()[0]));
        bomUsed++;
      }
    }

    // 更新工作令：狀態 / 實際良品數 / 完工時間
    woSheet.getRange(row, 7).setValue(wo.destination === '入倉庫' ? WO_STATUS_IN : WO_STATUS_TOSHIP);
    woSheet.getRange(row, 8).setValue(actual);
    woSheet.getRange(row, 9).setValue(now_());

    return {
      wo: rowToWO_(woSheet.getRange(row, 1, 1, WO_HEADERS.length).getValues()[0]),
      updated_items: updatedItems,
      bom_used: bomUsed,
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/** 待出貨 → 已出貨（出貨單未來由此狀態連動） */
function shipWorkOrder_(req) {
  var woId = String(req.wo_id || '').trim();
  if (!woId) throw new Error('缺少 WO_ID');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var woSheet = getSheet_(SHEET_WO);
    var row = findWORow_(woSheet, woId);
    if (row === -1) throw new Error('找不到工作令：' + woId);
    var wo = rowToWO_(woSheet.getRange(row, 1, 1, WO_HEADERS.length).getValues()[0]);
    if (wo.status !== WO_STATUS_TOSHIP) {
      throw new Error('只有「待出貨」的工作令可以登記出貨，目前：' + wo.status);
    }
    woSheet.getRange(row, 7).setValue(WO_STATUS_SHIPPED);
    return { wo: rowToWO_(woSheet.getRange(row, 1, 1, WO_HEADERS.length).getValues()[0]) };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/** WO_ID 自動編號：WOyyMMdd-##（當日流水號） */
function nextWOId_(sheet) {
  var today = Utilities.formatDate(new Date(), nowTz_(), 'yyMMdd');
  var prefix = 'WO' + today + '-';
  var max = 0;
  var last = sheet.getLastRow();
  if (last >= 2) {
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var s = String(ids[i][0]).trim();
      if (s.indexOf(prefix) === 0) {
        var n = parseInt(s.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    }
  }
  return prefix + ('00' + (max + 1)).slice(-2);
}

/** 依 WO_ID（不分大小寫）找工作令列號；找不到回 -1 */
function findWORow_(sheet, woId) {
  if (!woId) return -1;
  var target = String(woId).trim().toUpperCase();
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim().toUpperCase() === target) return i + 2;
  }
  return -1;
}

/** 工作令一列 → 前端資料物件 */
function rowToWO_(row) {
  return {
    wo_id: String(row[0]).trim(),
    style_no: String(row[1]).trim(),
    plan_qty: Number(row[2]) || 0,
    due_date: dueYMD_(row[3]),
    destination: String(row[4]).trim(),
    order_ref: String(row[5]).trim(),
    status: String(row[6]).trim(),
    actual_qty: row[7] === '' ? null : Number(row[7]),
    completed_time: String(row[8] || '').trim(),
  };
}

/** BOM 一列 → 前端資料物件 */
function rowToBom_(row) {
  return {
    style_no: String(row[0]).trim(),
    item_code: String(row[1]).trim(),
    item_name: String(row[2]).trim(),
    unit_use: Number(row[3]) || 0, // 單件耗用量
  };
}

/** 數值四捨五入到小數 4 位（避免浮點誤差 0.09×330） */
function round4_(v) {
  return Math.round(Number(v) * 10000) / 10000;
}

/** 任意值 → 'YYYY-MM-DD'（解析不出回 ''；支援 Date 物件與多種字串格式） */
function dueYMD_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, nowTz_(), 'yyyy-MM-dd');
  var s = String(v || '').trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/**
 * 【Time-driven 每日觸發】到期檢查：
 * Due_Date 已過期（< 今天）且狀態仍為「生產中」→ 自動改為「待確認」
 * （今日到期不算逾期，由現場完成或隔日由下次檢查轉為待確認）
 */
function checkDueWorkOrders() {
  var sheet = getSheet_(SHEET_WO);
  var last = sheet.getLastRow();
  if (last < 2) return;
  var todayYMD = Utilities.formatDate(new Date(), nowTz_(), 'yyyy-MM-dd');
  var values = sheet.getRange(2, 1, last - 1, WO_HEADERS.length).getValues();
  var changed = 0;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][6]).trim() !== WO_STATUS_ACTIVE) continue; // 只檢查生產中
    var due = dueYMD_(values[i][3]);
    if (!due || due >= todayYMD) continue;
    sheet.getRange(i + 2, 7).setValue(WO_STATUS_CHECK);
    changed++;
  }
  Logger.log('工作令到期檢查完成：%s 張轉為「待確認」', changed);
}

/** 安裝每日到期檢查觸發器（重複執行會先移除舊觸發器再重裝） */
function installDueCheckTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkDueWorkOrders') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('checkDueWorkOrders').timeBased().everyDays(1).atHour(6).create();
  Logger.log('已安裝「工作令到期檢查」每日觸發器（約每日 06:00 執行）');
}

/* ============================================================
 * 出庫與出貨單（CUSTOMERS / SHIPMENT_ORDERS / SHIPMENT_DETAILS）
 * ============================================================ */

/** 客戶清單（依名稱排序） */
function listCustomers_() {
  var sheet = getSheet_(SHEET_CUST);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][1]).trim();
    if (!name) continue;
    rows.push({
      customer_id: String(values[i][0]).trim(),
      customer_name: name,
      country: String(values[i][2]).trim(),
    });
  }
  rows.sort(function (a, b) { return a.customer_name.localeCompare(b.customer_name); });
  return rows;
}

/** 依客戶名稱（不分大小寫）找列號；找不到回 -1 */
function findCustomerRowByName_(name) {
  var target = String(name || '').trim().toUpperCase();
  if (!target) return -1;
  var sheet = getSheet_(SHEET_CUST);
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var values = sheet.getRange(2, 2, last - 1, 1).getValues(); // 第 2 欄 Customer_Name
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === target) return i + 2;
  }
  return -1;
}

/** 手動新增客戶（Customer_ID 自動編號 C###；重複名稱擋下；Country 選填） */
function addCustomer_(req) {
  var name = String(req.customer_name || '').trim();
  if (!name) throw new Error('缺少客戶名稱 Customer_Name');
  var country = String(req.country || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (findCustomerRowByName_(name) !== -1) throw new Error('客戶已存在：' + name);
    var sheet = getSheet_(SHEET_CUST);
    var last = sheet.getLastRow();
    var max = 0;
    if (last >= 2) {
      var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        var m = String(ids[i][0]).trim().match(/^C(\d+)$/i);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
    var id = 'C' + ('000' + (max + 1)).slice(-3);
    sheet.appendRow([id, name, country]);
    return { customer: { customer_id: id, customer_name: name, country: country } };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/**
 * 建立出貨單（外銷出庫）：
 * 1. 批次扣減 INVENTORY_MASTER（LockService 保護下先全數檢查，
 *    同一品號可分列多箱 → 合計檢查；任一品合計不足 → 整張擋下）
 * 2. 每一列明細寫入 STOCK_LOG（出庫；備註＝出貨 單號／客戶）
 * 3. 寫入 SHIPMENT_ORDERS 主表 ＋ SHIPMENT_DETAILS 明細
 * req = { shipment_date?(YYYY-MM-DD，預設今天), invoice_no?(留空 → GS-yyyyMMdd),
 *         customer_name, operator?, remark?, carrier?, port_from?, port_to?,
 *         incoterm?, currency?,
 *         lines: [{ item_code, qty, carton_no?, unit_price?, n_w?, g_w? }, ...] }
 * 回傳 { shipment_id, invoice_no, shipment_date, customer_name,
 *        total_styles, total_pcs, total_cartons, total_amount, total_nw, total_gw,
 *        updated_items }
 */
function createShipment_(req) {
  var shipDate = dueYMD_(String(req.shipment_date || '').trim() || now_());
  if (!shipDate) throw new Error('Shipment_Date 格式需為 YYYY-MM-DD');
  var customer = String(req.customer_name || '').trim();
  if (!customer) throw new Error('缺少客戶名稱 Customer_Name');
  var operator = String(req.operator || '').trim() || '—';
  var remark = String(req.remark || '').trim();
  var invoiceNo = String(req.invoice_no || '').trim();
  if (!invoiceNo) {
    invoiceNo = 'GS-' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMdd');
  }
  var carrier = String(req.carrier || '').trim();
  var portFrom = String(req.port_from || '').trim();
  var portTo = String(req.port_to || '').trim();
  var incoterm = String(req.incoterm || '').trim();
  var currency = String(req.currency || '').trim();
  var lines = Array.isArray(req.lines) ? req.lines : [];
  if (lines.length === 0) throw new Error('出貨明細不可為空');

  // 先整理明細：同一品號可分多列（多箱），合計數量檢查
  var details = [];
  var agg = {};   // code -> 合計數量（庫存檢查／扣庫用）
  for (var i = 0; i < lines.length; i++) {
    var lCode = String(lines[i].item_code || '').trim().toUpperCase();
    if (!lCode) throw new Error('明細缺少品號 Item_Code');
    var lQty = Number(lines[i].qty);
    if (isNaN(lQty) || lQty <= 0) throw new Error('明細數量必須大於 0：' + lCode);
    details.push({
      code: lCode,
      qty: lQty,
      carton: String(lines[i].carton_no || '').trim(),
      price: Number(lines[i].unit_price) || 0,
      nw: Number(lines[i].n_w) || 0,
      gw: Number(lines[i].g_w) || 0,
    });
    agg[lCode] = (agg[lCode] || 0) + lQty;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureSheet_(SHEET_SHP);   // 舊表自動補上外銷新欄位（Invoice/Carrier/重量…）
    ensureSheet_(SHEET_SHPD);
    var master = getSheet_(SHEET_MASTER);

    // 第一輪：一次性讀取主檔，解析品項並檢查所有庫存（任一不足不寫入任何資料）
    var values = master.getDataRange().getValues();
    var index = {}; // CODE -> values 列索引（0-based）
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][0]).trim().toUpperCase();
      if (k && !index[k]) index[k] = r;
    }
    var aKey;
    for (aKey in agg) {
      var aRow = index[aKey];
      if (aRow === undefined) throw new Error('品號不存在於 INVENTORY_MASTER：' + aKey);
      var stock = Number(values[aRow][4]) || 0;
      if (agg[aKey] > stock) {
        var aName = String(values[aRow][1]).trim();
        var aColor = String(values[aRow][3]).trim();
        throw new Error('庫存不足：' + aKey + ' ' + aName +
          (aColor ? '（' + aColor + '）' : '') +
          '；在庫 ' + stock + '、欲出庫合計 ' + agg[aKey] + '。請先補貨入庫');
      }
    }

    // 第二輪：計算新庫存 → 兩欄各一次 setValues 整欄寫回；逐列組日誌與明細
    var shipmentId = nextShipmentId_();
    var logId_ = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
      ('000' + Math.floor(Math.random() * 1000)).slice(-3);
    var logRows = [];
    var detailRows = [];
    var updatedItems = [];
    var styleNames = {};
    var totalPcs = 0;
    var cartonSet = {};
    var totalAmount = 0;
    var totalNW = 0;
    var totalGW = 0;
    var nRows = values.length;
    var newStocks = [];
    var newUpdated = [];
    for (var s = 0; s < nRows; s++) {
      newStocks.push([Number(values[s][4]) || 0]);
      newUpdated.push([String(values[s][7] || '')]);
    }
    var baseStock = {}; // rowIdx -> 原庫存（同列多列明細累扣）
    var seq = 0;
    for (var t = 0; t < details.length; t++) {
      var d = details[t];
      var rowIdx = index[d.code];

      if (baseStock[rowIdx] === undefined) baseStock[rowIdx] = Number(values[rowIdx][4]) || 0;
      newStocks[rowIdx] = [round4_(baseStock[rowIdx] - agg[d.code])];
      newUpdated[rowIdx] = [now_()];

      var lineRemark = '出貨 ' + shipmentId + ' ／ ' + customer + (remark ? '；' + remark : '');
      logRows.push([
        logId_ + ('00' + (seq + 1)).slice(-2), now_(), '出庫', d.code, -d.qty, operator, lineRemark,
      ]);
      seq++;

      var item = rowToItem_(values[rowIdx]);
      var once = false;
      for (var u = 0; u < updatedItems.length; u++) {
        if (updatedItems[u].item_code === item.item_code) { once = true; break; }
      }
      if (!once) {
        item.stock_qty = round4_(baseStock[rowIdx] - agg[d.code]);
        updatedItems.push(item);
      }

      totalPcs += d.qty;
      styleNames[item.item_name] = true;
      if (d.carton) cartonSet[d.carton] = true;
      totalAmount += d.price * d.qty;
      totalNW += d.nw;
      totalGW += d.gw;
      detailRows.push([
        shipmentId, d.code, item.item_name, item.color_spec, d.qty, item.unit,
        d.carton, d.price > 0 ? d.price : '', d.nw > 0 ? d.nw : '', d.gw > 0 ? d.gw : '',
        d.price > 0 ? round4_(d.price * d.qty) : '',
      ]);
    }

    // Stock_Qty / Last_Updated 各一次 setValues 整欄寫回
    if (nRows > 1) {
      master.getRange(2, 5, nRows - 1, 1).setValues(newStocks.slice(1));
      master.getRange(2, 8, nRows - 1, 1).setValues(newUpdated.slice(1));
    }

    // STOCK_LOG 一次批次附加
    var logSheet = getSheet_(SHEET_LOG);
    logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, LOG_HEADERS.length)
      .setValues(logRows);

    // 出貨單主表＋明細表（欄位結構對應 Commercial Invoice / Packing List DATA_ENTRY）
    getSheet_(SHEET_SHP).appendRow([
      shipmentId, shipDate, customer, Object.keys(styleNames).length, totalPcs, SHP_STATUS, remark,
      invoiceNo, carrier, portFrom, portTo, incoterm, currency,
      Object.keys(cartonSet).length, round4_(totalAmount), round4_(totalNW), round4_(totalGW),
    ]);
    var detSheet = getSheet_(SHEET_SHPD);
    detSheet.getRange(detSheet.getLastRow() + 1, 1, detailRows.length, SHPD_HEADERS.length)
      .setValues(detailRows);

    return {
      shipment_id: shipmentId,
      invoice_no: invoiceNo,
      shipment_date: shipDate,
      customer_name: customer,
      total_styles: Object.keys(styleNames).length,
      total_pcs: totalPcs,
      total_cartons: Object.keys(cartonSet).length,
      total_amount: round4_(totalAmount),
      total_nw: round4_(totalNW),
      total_gw: round4_(totalGW),
      updated_items: updatedItems,
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/** 出貨單號自動編號：SHyyyyMMdd-##（當日流水號） */
function nextShipmentId_() {
  var today = Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMdd');
  var prefix = 'SH' + today + '-';
  var sheet = getSheet_(SHEET_SHP);
  var max = 0;
  var last = sheet.getLastRow();
  if (last >= 2) {
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var s = String(ids[i][0]).trim();
      if (s.indexOf(prefix) === 0) {
        var n = parseInt(s.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    }
  }
  return prefix + ('00' + (max + 1)).slice(-2);
}

/** 🔐 使用者身分是否符合報表白名單（HC / MAIN）
 *  相容名冊格式「序號-姓名」（01-王小明）與自填格式（HC、HC-老闆、老闆-HC…）：
 *  整串、去「數字-」前綴、'-' 前段/後段，任一段命中白名單即視為管理者。
 *  與前端 src/api.js 的 isManager() 邏輯同步，兩邊都要改。 */
function isManagerOp_(op) {
  var t = String(op || '').trim().toUpperCase();
  if (!t) return false;
  var parts = t.split('-');
  var candidates = [
    t,
    t.replace(/^\d+-/, ''),   // 01-HC → HC
    parts[0],                 // HC-王小明 → HC
    parts[parts.length - 1],  // 王小明-HC → HC
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (ALLOWED_MANAGERS.indexOf(String(candidates[i]).trim()) !== -1) return true;
  }
  return false;
}

/** 報表權限檢核：非白名單一律拋出拒絕（不下修、無例外） */
function checkReportPerm_(operator) {
  if (!isManagerOp_(operator)) {
    throw new Error('權限不足：僅限管理者（HC / MAIN）查閱營運報表。' +
      '目前身分：' + (String(operator || '').trim() || '未填經辦人'));
  }
}

/** 出貨單主表（由新到舊排序；匯出 Commercial Invoice / Packing List 用） */
function listShipments_() {
  var sheet = getSheet_(SHEET_SHP);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    rows.push({
      shipment_id: String(values[i][0]).trim(),
      shipment_date: dueYMD_(values[i][1]),
      customer_name: String(values[i][2]).trim(),
      total_styles: Number(values[i][3]) || 0,
      total_pcs: Number(values[i][4]) || 0,
      status: String(values[i][5]).trim(),
      remark: String(values[i][6]).trim(),
      invoice_no: values[i].length > 7 ? String(values[i][7]).trim() : '',
      carrier: values[i].length > 8 ? String(values[i][8]).trim() : '',
      port_from: values[i].length > 9 ? String(values[i][9]).trim() : '',
      port_to: values[i].length > 10 ? String(values[i][10]).trim() : '',
      incoterm: values[i].length > 11 ? String(values[i][11]).trim() : '',
      currency: values[i].length > 12 ? String(values[i][12]).trim() : '',
      total_cartons: values[i].length > 13 ? Number(values[i][13]) || 0 : 0,
      total_amount: values[i].length > 14 ? Number(values[i][14]) || 0 : 0,
      total_nw: values[i].length > 15 ? Number(values[i][15]) || 0 : 0,
      total_gw: values[i].length > 16 ? Number(values[i][16]) || 0 : 0,
    });
  }
  rows.sort(function (a, b) { return String(b.shipment_id).localeCompare(String(a.shipment_id)); });
  return rows;
}

/**
 * 營運統計報表（🔐 核心商業機密：僅限管理者 HC / MAIN 查閱）
 * req = { operator: 使用者代碼/名稱（白名單檢核）, period?: "ALL"|"YEAR"|"MONTH" }
 * 資料源：SHIPMENT_ORDERS（客戶業績/金額/箱數/淨毛重）＋ SHIPMENT_DETAILS（款式銷售排行）
 * 回傳 { period, date_from, date_to, currency,
 *        total_revenue, total_pcs, total_orders, total_customers, total_cartons, total_nw, total_gw,
 *        customer_ranks: [{customer_name, country, orders, pcs, amount, cartons, nw, gw}],
 *        style_ranks: [{item_code, style_no, color_spec, qty, amount}] }
 * （客戶榜依金額降冪、款式榜依數量降冪；金額欄缺欄的舊表自動當 0 處理）
 */
function getSalesReport_(req) {
  checkReportPerm_(req.operator); // 🔐 白名單之外的請求到此為止，不多讀一列資料
  var period = String(req.period || 'ALL').trim().toUpperCase();
  if (['ALL', 'YEAR', 'MONTH'].indexOf(period) === -1) period = 'ALL';
  var tz = nowTz_();
  var now = new Date();
  var dateTo = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var dateFrom = '';
  if (period === 'YEAR') dateFrom = Utilities.formatDate(now, tz, 'yyyy') + '-01-01';
  else if (period === 'MONTH') dateFrom = Utilities.formatDate(now, tz, 'yyyy-MM') + '-01';

  // ① 出貨單主表：一次讀取 → 依期間過濾（以出貨日為準）
  var orders = listShipments_().filter(function (s) {
    if (dateFrom && s.shipment_date) {
      return s.shipment_date >= dateFrom && s.shipment_date <= dateTo;
    }
    return !dateFrom; // 指定期間但出貨日空白的單不計入（列新補日期即會出現）
  });

  // ② 客戶業績彙整
  var countryOf = {};
  try {
    listCustomers_().forEach(function (c) { countryOf[c.customer_name.toUpperCase()] = c.country; });
  } catch (e) { /* 客戶表讀失敗不影響主彙整 */ }
  var custMap = {};
  var currency = '';
  var totRevenue = 0, totPcs = 0, totCartons = 0, totNW = 0, totGW = 0;
  for (var i = 0; i < orders.length; i++) {
    var s = orders[i];
    var cname = s.customer_name || '（未填客戶）';
    if (!custMap[cname]) {
      custMap[cname] = {
        customer_name: cname,
        country: countryOf[String(cname).toUpperCase()] || '',
        orders: 0, pcs: 0, amount: 0, cartons: 0, nw: 0, gw: 0,
      };
    }
    var c = custMap[cname];
    c.orders += 1;
    c.pcs += s.total_pcs;
    c.amount += s.total_amount;
    c.cartons += s.total_cartons;
    c.nw += s.total_nw;
    c.gw += s.total_gw;
    totRevenue += s.total_amount;
    totPcs += s.total_pcs;
    totCartons += s.total_cartons;
    totNW += s.total_nw;
    totGW += s.total_gw;
    if (!currency && s.currency) currency = s.currency;
  }
  var customerRanks = [];
  for (var key in custMap) {
    var cr = custMap[key];
    cr.amount = round4_(cr.amount);
    cr.nw = round4_(cr.nw);
    cr.gw = round4_(cr.gw);
    customerRanks.push(cr);
  }
  customerRanks.sort(function (a, b) { return b.amount - a.amount || b.pcs - a.pcs; });

  // ③ 款式銷售排行：SHIPMENT_DETAILS 逐列（限主表期間內的出貨單）
  var shipDateOf = {};
  orders.forEach(function (s) { shipDateOf[s.shipment_id] = true; });
  var styleMap = {};
  if (orders.length > 0) {
    var detValues = getSheet_(SHEET_SHPD).getDataRange().getValues();
    for (var d = 1; d < detValues.length; d++) {
      var row = detValues[d];
      var sid = String(row[0]).trim();
      if (!shipDateOf[sid]) continue;
      var code = String(row[1]).trim();
      if (!code) continue;
      var qty = Number(row[4]) || 0;
      var price = Number(row[7]) || 0;
      var amount = Number(row[10]) || (price > 0 ? price * qty : 0);
      if (!styleMap[code]) {
        styleMap[code] = { item_code: code, style_no: String(row[2]).trim(), color_spec: String(row[3]).trim(), qty: 0, amount: 0 };
      }
      styleMap[code].qty += qty;
      styleMap[code].amount += amount;
    }
  }
  var styleRanks = [];
  for (var k in styleMap) {
    styleRanks.push(styleMap[k]);
  }
  styleRanks.sort(function (a, b) { return b.qty - a.qty || b.amount - a.amount; });
  styleRanks = styleRanks.slice(0, 20).map(function (it) {
    return { item_code: it.item_code, style_no: it.style_no, color_spec: it.color_spec, qty: round4_(it.qty), amount: round4_(it.amount) };
  });

  return {
    period: period,
    date_from: dateFrom || '（全部）',
    date_to: dateTo,
    currency: currency || 'USD',
    total_revenue: round4_(totRevenue),
    total_pcs: round4_(totPcs),
    total_orders: orders.length,
    total_customers: customerRanks.length,
    total_cartons: round4_(totCartons),
    total_nw: round4_(totNW),
    total_gw: round4_(totGW),
    customer_ranks: customerRanks,
    style_ranks: styleRanks,
  };
}

/** 【選用】灌入示範客戶清單（Spec 中之外銷客戶），方便第一次測試 */
function seedDemoCustomers() {
  var demo = [
    ['MOONBAT', 'JP'],
    ['KURIHARA', 'JP'],
    ['CANAL', 'US'],
    ['APE', ''],
  ];
  var sheet = getSheet_(SHEET_CUST);
  var last = sheet.getLastRow();
  var next = 1;
  for (var i = 0; i < demo.length; i++) {
    if (findCustomerRowByName_(demo[i][0]) !== -1) continue;
    sheet.appendRow(['C' + ('000' + next).slice(-3), demo[i][0], demo[i][1]]);
    next++;
  }
  Logger.log('示範客戶完成：%s 筆', demo.length);
}

/* ========================= Helpers ========================= */

/** 🔐 存取碼檢查：API_TOKEN 非空時，req.token 必須一致 */
function checkToken_(req) {
  if (!API_TOKEN) return; // 未設定 = 不啟用驗證
  if (String(req && req.token || '') !== API_TOKEN) {
    throw new Error('存取碼錯誤（無效的 token）');
  }
}

function parseRequest_(e) {
  try {
    if (e && e.postData && e.postData.contents) return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('JSON 解析失敗：' + err.message);
  }
  return (e && e.parameter) || {};
}

function makeResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sheet = ss_().getSheetByName(name);
  if (!sheet) {
    // 未跑過 setupSheets 時自動補建
    sheet = ensureSheet_(name);
  }
  return sheet;
}

function nowTz_() {
  return ss_().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

function now_() {
  return Utilities.formatDate(new Date(), nowTz_(), 'yyyy-MM-dd HH:mm:ss');
}

/** 依品號（不分大小寫）找出主檔列號；找不到回 -1 */
function findMasterRow_(sheet, code) {
  if (!code) return -1;
  var target = String(code).trim().toUpperCase();
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var codes = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < codes.length; i++) {
    if (String(codes[i][0]).trim().toUpperCase() === target) return i + 2;
  }
  return -1;
}

/**
 * 建立新品項主檔列（入庫新品項用，須在 LockService 保護下呼叫）
 * newItem = { item_name(必填), category?, color_spec?, unit?, location? }
 * codeHint：自訂品號（留空 → nextItemCode_ 自動編號 A####）
 * 新品項庫存由 0 起算，回傳新列列號
 */
function createMasterRow_(master, newItem, codeHint) {
  var name = String(newItem.item_name || '').trim();
  if (!name) throw new Error('建立新品項需填寫品名 Item_Name');
  var code = String(codeHint || newItem.item_code || '').trim().toUpperCase();
  if (!code) {
    code = nextItemCode_(master);
  } else if (findMasterRow_(master, code) !== -1) {
    throw new Error('品號已存在，不可重複建立：' + code);
  }
  ensureSheet_(SHEET_MASTER); // 舊表補上 Image_URL / Style_Category / Season / Is_Public 等標題（不影響既有資料）
  master.appendRow([
    code,
    name,
    String(newItem.category || '').trim(),
    String(newItem.color_spec || '').trim(),
    0,
    String(newItem.unit || '').trim() || 'PCS',
    String(newItem.location || '').trim(),
    now_(),
    String(newItem.image_url || '').trim(), // 圖片 URL（可留空，之後上傳／填入）
    String(newItem.style_category || '').trim(), // 帽型分類（選填）
    String(newItem.season || '').trim(),         // SS / AW / 四季（選填）
    String(newItem.is_public || 'Y').trim(),     // 預設公開
  ]);
  return master.getLastRow();
}

/** 自動編號：取主檔中 A#### 型品號最大序號 + 1，並避開已使用的品號 */
function nextItemCode_(master) {
  var last = master.getLastRow();
  var max = 0;
  if (last >= 2) {
    var codes = master.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < codes.length; i++) {
      var m = String(codes[i][0]).trim().match(/^A(\d+)$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  var n = max + 1;
  while (findMasterRow_(master, 'A' + ('0000' + n).slice(-4)) !== -1) n++;
  return 'A' + ('0000' + n).slice(-4);
}

/** 工作表一列 → 前端資料物件 */
function rowToItem_(row) {
  return {
    item_code: String(row[0]).trim(),
    item_name: String(row[1]),
    category: String(row[2]),
    color_spec: String(row[3]),
    stock_qty: Number(row[4]) || 0,
    unit: String(row[5]) || 'PCS',
    location: String(row[6]),
    last_updated: String(row[7]),
    image_url: row.length > 8 ? String(row[8]) : '', // 款式圖片（舊稱 photo_url）
    style_category: row.length > 9 ? String(row[9]) : '', // 帽型分類（Fedora/Casquette/Beret/Cap/Boonie…）
    season: row.length > 10 ? String(row[10]) : '',       // SS / AW / 四季
    is_public: row.length > 11 ? (String(row[11]).trim().toUpperCase() || 'Y') : 'Y', // 空白視為 Y
  };
}

/* ========================= 初始化 ========================= */

/** 【手動執行一次】建立 / 修復工作表、標題格式，並安裝到期檢查觸發器 */
function setupSheets() {
  Logger.log('建立 %s …', ensureSheet_(SHEET_MASTER));
  Logger.log('建立 %s …', ensureSheet_(SHEET_LOG));
  Logger.log('建立 %s …', ensureSheet_(SHEET_OPS));
  Logger.log('建立 %s …', ensureSheet_(SHEET_WO));
  Logger.log('建立 %s …', ensureSheet_(SHEET_BOM));
  Logger.log('建立 %s …', ensureSheet_(SHEET_CUST));
  Logger.log('建立 %s …', ensureSheet_(SHEET_SHP));
  Logger.log('建立 %s …', ensureSheet_(SHEET_SHPD));
  installDueCheckTrigger();
  Logger.log('完成！接著執行 seedDemoData() 可灌入示範料件（現有資料不會被覆蓋）');
}

function ensureSheet_(name) {
  var spreadsheet = ss_();
  var sheet = spreadsheet.getSheetByName(name);
  var headers = (name === SHEET_MASTER) ? MASTER_HEADERS
              : (name === SHEET_OPS) ? OPS_HEADERS
              : (name === SHEET_WO) ? WO_HEADERS
              : (name === SHEET_BOM) ? BOM_HEADERS
              : (name === SHEET_CUST) ? CUST_HEADERS
              : (name === SHEET_SHP) ? SHP_HEADERS
              : (name === SHEET_SHPD) ? SHPD_HEADERS
              : LOG_HEADERS;
  if (!sheet) {
    // 全新建表：一次寫入所有標題
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    // 名冊預先填好 30 個序號（01~30），姓名欄留空等人填
    if (name === SHEET_OPS) {
      var seq = [];
      for (var n = 1; n <= OPS_PRESET_ROWS; n++) {
        seq.push([String(n).padStart(2, '0'), '', '']);
      }
      sheet.getRange(2, 1, seq.length, OPS_HEADERS.length).setValues(seq);
    }
  } else if (sheet.getLastColumn() < headers.length) {
    // 舊表補上新欄位標題（例如 Photo_URL），不影響既有資料
    var startCol = sheet.getLastColumn() + 1;
    var extra = headers.slice(sheet.getLastColumn());
    sheet.getRange(1, startCol, 1, extra.length).setValues([extra]);
  }
  var width = Math.max(sheet.getLastColumn(), headers.length);
  var head = sheet.getRange(1, 1, 1, width);
  head.setFontWeight('bold').setBackground('#1d4ed8').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, width);
  return sheet;
}

/** 【選用】灌入示範料件，方便第一次測試 */
function seedDemoData() {
  var sheet = getSheet_(SHEET_MASTER);
  var demo = [
    ['KN-CAP-001', '針織毛線帽 M', '成品', '燕麥色', 120, 'PCS', 'A-01-05', now_()],
    ['KN-CAP-001', '針織毛線帽 M', '成品', '黑', 8, 'PCS', 'A-01-06', now_()],
    ['KN-CAP-002', 'Bumble 疊捲帽', '成品', '酒紅', 64, 'PCS', 'A-02-01', now_()],
    ['KN-YARN-007', '壓克力毛紗 30#', '原料', '本白', 45.5, 'KG', 'R-03', now_()],
    ['KN-WIP-021', '織帶半成品 12cm', '半成品', '雜色', 6, 'PCS', 'W-01', now_()],
  ];
  for (var i = 0; i < demo.length; i++) {
    if (findMasterRow_(sheet, demo[i][0]) !== -1) continue; // 已存在的品號略過
    sheet.appendRow(demo[i]);
  }
  Logger.log('示範資料完成，目前料件：%s 筆', sheet.getLastRow() - 1);
}

/** 【選用】灌入示範 BOM（對應 seedDemoData 的款式），方便測試工作令試算 */
function seedDemoBom() {
  var demo = [
    // Style_No, Item_Code, Item_Name, Unit_Use（每件耗用量）
    ['針織毛線帽 M', 'KN-YARN-007', '壓克力毛紗 30#', 0.09], // 一件約用 90g
  ];
  var sheet = getSheet_(SHEET_BOM);
  for (var i = 0; i < demo.length; i++) {
    sheet.appendRow(demo[i]);
  }
  Logger.log('示範 BOM 完成：%s 列', demo.length);
}
