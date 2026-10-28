/**************************************************************************
 * 針織/成帽工廠庫存系統 – Google Apps Script 後端 (Web App)
 * ---------------------------------------------------------------
 * 部署步驟（詳細圖文請見專案 README.md）：
 *   1. 在接到的 Google 試算表中：擴充功能 ➔ Apps Script ➔ 貼上本檔全部內容
 *   2. 先手動執行一次 setupSheets()（建立兩張表、凍結標題列、允許授權）
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
 *                     operator, remark, force }     → 記一筆異動並更新庫存
 *       type   : "入庫" | "出庫" | "盤點"
 *       盤點   : qty = 盤點後實際庫存量（可為 0），Change_Qty = qty - 原庫存
 *       force  : true 允許出庫後形成負庫存（前端已在彈窗二次確認過）
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

/** 【手動執行一次】建立 / 修復三張工作表與標題格式 */
function setupSheets() {
  Logger.log('建立 %s …', ensureSheet_(SHEET_MASTER));
  Logger.log('建立 %s …', ensureSheet_(SHEET_LOG));
  Logger.log('建立 %s …', ensureSheet_(SHEET_OPS));
  Logger.log('完成！接著執行 seedDemoData() 可灌入示範料件（現有資料不會被覆蓋）');
}

function ensureSheet_(name) {
  var spreadsheet = ss_();
  var sheet = spreadsheet.getSheetByName(name);
  var headers = (name === SHEET_MASTER) ? MASTER_HEADERS
              : (name === SHEET_OPS) ? OPS_HEADERS
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
