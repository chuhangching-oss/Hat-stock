/**************************************************************************
 * 針織/成帽工廠庫存系統 – Google Apps Script 後端 (Web App)
 * ---------------------------------------------------------------
 * 部署步驟（詳細圖文請見專案 README.md）：
 *   1. 在接到的 Google 試算表中：擴充功能 ➔ Apps Script ➔ 貼上本檔全部內容
 *   2. 先手動執行一次 setupSheets()（建立五張表、凍結標題列、允許授權、
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
 * 回應：{ ok: true, data: ... } 或 { ok: false, error: "訊息" }
 **************************************************************************/

var SHEET_MASTER = 'INVENTORY_MASTER'; // 庫存主檔
var SHEET_LOG = 'STOCK_LOG';           // 出入庫異動記錄
var SHEET_OPS = 'OPERATORS';           // 經辦人名冊（序號 + 姓名）

var MASTER_HEADERS = [
  'Item_Code', 'Item_Name', 'Category', 'Color_Spec',
  'Stock_Qty', 'Unit', 'Location', 'Last_Updated',
  'Photo_URL', // 第 9 欄（選填）：款式照片連結（存於 Google Drive）
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

    ensureSheet_(SHEET_MASTER);          // 補上 Photo_URL 標題（舊表）
    master.getRange(row, 9).setValue(url); // 第 9 欄 = Photo_URL

    return {
      item_code: code,
      photo_url: url,
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
  ensureSheet_(SHEET_MASTER); // 舊表補上 Photo_URL 等標題（不影響既有資料）
  master.appendRow([
    code,
    name,
    String(newItem.category || '').trim(),
    String(newItem.color_spec || '').trim(),
    0,
    String(newItem.unit || '').trim() || 'PCS',
    String(newItem.location || '').trim(),
    now_(),
    '', // Photo_URL
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
    photo_url: row.length > 8 ? String(row[8]) : '', // 款式照片（未有資料則空字串）
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
