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
 * 彙總來源：SHIPMENT_ORDERS（客戶/金額/箱重）＋ SHIPMENT_DETAILS（款式排行）
 *
 *   { action: "list_stock_logs", limit? }           → 出入庫異動記錄檢索（STOCK_LOG）
 *       只讀最後 N 筆（limit 預設 500、最多 2000），由新到舊；
 *       回傳 { log_id, timestamp, type(入庫/出庫/盤點), item_code,
 *              item_name, color_spec, unit, change_qty, operator, remark }
 *       （品名/顏色/單位由主檔帶入；篩選由前端做）
 *
 *   { action: "list_dormant", operator, months? }   → 🧹 品項健檢：逾 N 月無異動清單
 *       months 預設 6（可調）；判斷以 STOCK_LOG 最後異動日為準（無紀錄退主檔 Last_Updated）
 *       回傳 { cutoff, months, total, items:[{ item_code, item_name, color_spec,
 *              category, stock_qty, unit, location, last_activity, days_idle, active }] }
 *       🔐 僅限 HC / MAIN / ANDY / JL（引導到「品項健檢」分頁逐項勾選處理）
 *
 *   { action: "set_items_active", operator, item_codes:[…], active:'N'|'Y' }
 *                                                   → 🧹 批次封存(N)／解封(Y) 品項
 *       只改主檔第 13 欄 Active，不刪除任何資料（歷史紀錄／出貨單參照完整保留）；
 *       封存後品項不出現在批次挑選／掃碼，可隨時解封；🔐 僅限 HC / MAIN / ANDY / JL
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
  'Active',         // 第 13 欄（選填）：品項封存旗標 Y / N（留空＝Y；N＝封存，不出現在挑選／掃碼）
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

/** 🧹 品項健檢／封存白名單：HC / MAIN / ANDY / JL（封存影響現場挑選範圍，需授權者操作） */
var HYGIENE_MANAGERS = ['HC', 'MAIN', 'ANDY', 'JL'];

var VALID_TYPES = ['入庫', '出庫', '盤點'];

/* ============================================================
 * 🧵 V2：紗線庫存（YARN_INVENTORY）＋ 新版工作令（PRODUCTION_ORDERS）
 * ------------------------------------------------------------
 * 依紙本《盛全工業 工作令》格式升級（舊 WORK_ORDERS 保留不動）：
 * - YARN_INVENTORY      紗線庫存（Yarn_Code/Yarn_Name/Color/Stock_KG/Safety_Stock/Last_Updated）
 * - PRODUCTION_ORDERS   新版工作令主表：單頭（編號#G / 客戶 / 型號 / 總計 / 完成日期）
 *                       ＋ 五色配色（Color_A~E × Qty_A~E，顏色稱呼以頭頂顏色為準）
 *                       ＋ 工序三段（定型 / 平車 / 包裝）
 *                       ＋ Destination（入倉庫備庫｜訂單出貨）＋ Status ＋ Actual_Good_Qty
 * - WO_YARN             工單領紗明細（單頂用紗量 × Total_KG、來源、是否已扣）
 * 扣紗邏輯：開立工單（或草稿）切換至「生產中」時，依
 *   需求KG = (BOM 紗線列 ＋ 開單手動指定) 合併之單頂用紗量 × Plan_Qty
 *   自動扣減 YARN_INVENTORY.Stock_KG（不足仍照扣形成負庫存供現場檢討）。
 * 完工時「不重複扣」紗線；BOM 內非紗線原料仍可於完工時扣（use_bom）。
 * ============================================================ */
var SHEET_YARN = 'YARN_INVENTORY'; // 紗線庫存
var YARN_HEADERS = ['Yarn_Code', 'Yarn_Name', 'Color', 'Stock_KG', 'Safety_Stock', 'Last_Updated'];

var SHEET_PWO = 'PRODUCTION_ORDERS'; // 新版工作令主表（工作令 V2）
var PWO_HEADERS = [
  'WO_ID',            // 工單編號（紙本「編號：#G22015」；留空自動延續 #G 序列，也可手動輸入）
  'Customer',         // 客戶（紙本「客戶：SZ」）
  'Style_No',         // 型號（紙本「型號：D1177WB/6142」）
  'Plan_Qty',         // 預計產量（紙本「總計：312頂」；單位 = 頂）
  'Due_Date',         // 預計交期（紙本「完成日期：3/30」；YYYY-MM-DD）
  'Color_A', 'Color_B', 'Color_C', 'Color_D', 'Color_E', // 五色配色（顏色稱呼以頭頂顏色為準）
  'Qty_A', 'Qty_B', 'Qty_C', 'Qty_D', 'Qty_E',           // 該組配色數量（頂）
  'Process_Setting',  // 定型工序備註（理毛／定型模／硬度／邊留…）
  'Process_Sewing',   // 平車工序備註（汗帶／洗標…）
  'Process_Packing',  // 包裝工序備註（箱裝／吊牌／素體…）
  'Destination',      // 流向：入倉庫備庫 | 訂單出貨
  'Order_Ref',        // 訂單／客戶單號（選填）
  'Status',           // 草稿｜生產中｜待確認｜已入庫｜待出貨｜已出貨
  'Actual_Good_Qty',  // 實際完工良品數
  'Confirmed_Operator', // 完工經辦
  'Completed_Time',   // 完工時間
  'Remark',           // 備註
];

var SHEET_PWO_YARN = 'WO_YARN'; // 工單領紗明細（扣紗依據＋領料紀錄）
var PWO_YARN_HEADERS = [
  'WO_ID', 'Yarn_Code', 'Yarn_Name', 'KG_Per_Unit', 'Total_KG',
  'Source',           // BOM（來自 BOM_MASTER）| MANUAL（開單直接指定）| BOM+MANUAL
  'Deducted',         // N = 預估需求（未扣）｜ Y = 已於投產時扣減
  'Deducted_Time',
];

var PWO_DESTS = ['入倉庫備庫', '訂單出貨'];
var PWO_STATUS_DRAFT = '草稿';
var PWO_STATUS_ACTIVE = '生產中';
var PWO_STATUS_CHECK = '待確認';
var PWO_STATUS_IN = '已入庫';
var PWO_STATUS_TOSHIP = '待出貨';
var PWO_STATUS_SHIPPED = '已出貨';

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
      case 'get_shipment':
        data = getShipment_(req);
        break;
      case 'update_shipment':
        data = updateShipment_(req);
        break;
      case 'delete_shipment':
        data = deleteShipment_(req);
        break;
      case 'correct_stock_log':
        data = correctStockLog_(req);
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
      /* ---- V2：紗線庫存 ＋ 新版工作令（接續紙本「工作令」） ---- */
      case 'list_yarn':
        data = listYarn_();
        break;
      case 'save_yarn':
        data = saveYarn_(req);
        break;
      case 'list_production_orders':
        data = listProductionOrders_();
        break;
      case 'create_production_order':
        data = createProductionOrder_(req);
        break;
      case 'start_production_order':
        data = startProductionOrder_(req);
        break;
      case 'complete_production_order':
        data = completeProductionOrder_(req);
        break;
      case 'ship_production_order':
        data = shipProductionOrder_(req);
        break;
      case 'list_stock_logs':
        data = listStockLogs_(req);
        break;
      /* ---- 🧹 品項健檢：逾期未異動清單／封存・解封 ---- */
      case 'list_dormant':
        data = listDormant_(req);
        break;
      case 'set_items_active':
        data = setItemsActive_(req);
        break;
      default:
        throw new Error(
          '未知的 action：' + req.action +
          ' ← 線上後端是舊版（frontend 期待的 action 不存在）。' +
          '新版後端支援：/' +
          [
            'ping', 'list', 'get', 'log', 'list_operators', 'upload_photo',
            'list_work_orders', 'list_bom', 'create_work_order', 'complete_work_order',
            'ship_work_order', 'list_customers', 'add_customer', 'create_shipment',
            'list_shipments', 'get_shipment', 'update_shipment', 'delete_shipment',
            'correct_stock_log', 'getSalesReport', 'batchStockTransaction',
            'update_item_info', 'public_lookbook', 'list_yarn', 'save_yarn',
            'list_production_orders', 'create_production_order', 'start_production_order',
            'complete_production_order', 'ship_production_order', 'list_stock_logs',
            'list_dormant', 'set_items_active',
          ].join(' / ') +
          '。請在 Apps Script 編輯器：部署 → 管理部署作業 → 編輯(筆) → 版本選「新版本」→ 部署',
        );
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
  var hasNewItem = req.new_item && typeof req.new_item === 'object';
  // 品號留空＋附 new_item（僅入庫）＝自動編號 A####，不在此擋
  if (!code && !(hasNewItem && type === '入庫')) throw new Error('缺少品號 Item_Code');
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
    // 品號完全留空的新品項 → 以哨兵鍵去重，稍後由 createMasterRow_ 自動編號 A####
    if (!code && isNew) code = '#NEW#' + (i + 1);
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

    // ① 入庫新品項：先建主檔列（品號留空 → 自動編號；回帶實際品號）
    for (var n = 0; n < details.length; n++) {
      var dNew = details[n];
      if (dNew.is_new) {
        var hint = /^#NEW#/.test(dNew.code) ? '' : dNew.code; // 哨兵鍵 → 留空自動編號
        var newRow = createMasterRow_(master, dNew.new_item, hint);
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
          dIdx.short = true; // 補帳模式（force）時以此標記負庫存品項
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
      if (d.short) {
        lineRemark = '⚠️負庫存待盤' + (lineRemark ? '；' + lineRemark : '');
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
      short_count: details.filter(function (d) { return d.short; }).length,
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

  // V2：新版工作令（PRODUCTION_ORDERS）逾期檢查（同一觸發器一次做完）
  changed += checkDuePWOs_(todayYMD);
  Logger.log('新版工作令到期檢查完成（累計 %s 張轉為「待確認」）', changed);
}

/** V2：新版工作令到期檢查——Due_Date 已過且「生產中」→ 自動改「待確認」，回傳筆數 */
function checkDuePWOs_(todayYMD) {
  var sheet = getSheet_(SHEET_PWO);
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, 1, last - 1, PWO_HEADERS.length).getValues();
  var changed = 0;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][20]).trim() !== PWO_STATUS_ACTIVE) continue; // 第 21 欄 Status
    var due = dueYMD_(values[i][4]);                                  // 第 5 欄 Due_Date
    if (!due || due >= todayYMD) continue;
    sheet.getRange(i + 2, 21).setValue(PWO_STATUS_CHECK);
    changed++;
  }
  return changed;
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

/** 🔐 使用者身分是否符合任一指定白名單（共用的比對邏輯）
 *  相容名冊格式「序號-姓名」（01-王小明）與自填格式（HC、HC-老闆、老闆-HC…）：
 *  整串、去「數字-」前綴、'-' 前段/後段，任一段命中白名單即視為管理者。
 *  與前端 src/api.js 的 isManager() 邏輯同步，兩邊都要改。 */
function isManagerOp_(op) {
  return matchAnyRole_(op, ALLOWED_MANAGERS);
}

/** 身分比對共用：op 任一候選寫法命中 whitelist 即成立 */
function matchAnyRole_(op, whitelist) {
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
    if (whitelist.indexOf(String(candidates[i]).trim()) !== -1) return true;
  }
  return false;
}

/** 品項健檢／封存權限檢核：限 HC / MAIN / ANDY / JL */
function checkHygienePerm_(operator) {
  if (!matchAnyRole_(operator, HYGIENE_MANAGERS)) {
    throw new Error('權限不足：品項健檢／封存僅限 HC / MAIN / ANDY / JL 操作。' +
      '目前身分：' + (String(operator || '').trim() || '未填經辦人'));
  }
}

/** 報表權限檢核：非白名單一律拋出拒絕（不下修、無例外） */
function checkReportPerm_(operator) {
  if (!isManagerOp_(operator)) {
    throw new Error('權限不足：僅限管理者（HC / MAIN）查閱營運報表。' +
      '目前身分：' + (String(operator || '').trim() || '未填經辦人'));
  }
}

/**
 * 出入庫異動記錄檢索（STOCK_LOG）：
 * req = { action:'list_stock_logs', limit?: 預設 500（最多 2000） }
 * - 只讀最後 N 筆（老表不會越長越慢）；由新到舊排序
 * - 帶入品名／顏色／單位（主檔查表），前端可直接顯示與篩選
 * - 依 Timestamp 排序（格式 yyyy-MM-dd HH:mm:ss），無 Timestamp 的空列略過
 */
function listStockLogs_(req) {
  var limit = Math.min(Math.max(Number(req.limit) || 500, 1), 2000);
  var logSheet = getSheet_(SHEET_LOG);
  var last = logSheet.getLastRow();
  if (last < 2) return [];
  var startRow = Math.max(2, last - limit + 1);
  var num = last - startRow + 1;
  var values = logSheet.getRange(startRow, 1, num, LOG_HEADERS.length).getValues();

  // 主檔查表：品名／顏色／單位
  var master = {};
  listMaster_().forEach(function (it) {
    master[String(it.item_code).toUpperCase()] = it;
  });

  var rows = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var ts = String(values[i][1]).trim();
    var code = String(values[i][3]).trim();
    if (!code && !ts) continue; // 空列
    var it = master[code.toUpperCase()] || null;
    rows.push({
      log_id: String(values[i][0]).trim(),
      timestamp: ts,
      type: String(values[i][2]).trim(),
      item_code: code,
      item_name: it ? it.item_name : '(品號已刪除)',
      color_spec: it ? it.color_spec : '',
      unit: it ? it.unit : 'PCS',
      change_qty: Number(values[i][4]) || 0,
      operator: String(values[i][5]).trim(),
      remark: String(values[i][6]).trim(),
    });
  }
  rows.sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  return rows;
}

/* ============================================================
 * 🧹 品項健檢（Hygiene）：找出長期無異動的品項 ＋ 封存／解封
 * ------------------------------------------------------------
 * 判斷條件（可調 months，預設 6 個月）：
 *   該品號在 STOCK_LOG 的最後一筆異動（無紀錄則以主檔 Last_Updated 代替）
 *   早於「months 個月前」→ 列為待檢視（跟目前庫存量無關）
 * 處理方式＝封存不刪除：Active 欄設 N 後不出現在批次挑選／掃碼，
 *   但主檔資料、歷史紀錄、出貨單參照完整保留，隨時可設回 Y 解封。
 * ============================================================ */

/**
 * 列出所有「逾 months 個月沒有異動」的品項
 * req = { operator, months? } → { cutoff, months, total, items:[…] }
 * 每筆：item_code / item_name / color_spec / category / stock_qty / unit /
 *       location / last_activity（最後異動日 YYYY-MM-DD，無紀錄為 ''）/
 *       days_idle（閒置天數，無紀錄為 null）/ active（true=正常、false=已封存）
 */
function listDormant_(req) {
  checkHygienePerm_(req.operator);
  var months = Number(req.months) || 6;
  if (!(months > 0) || months > 60) months = 6;
  var cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  var cutoffYMD = Utilities.formatDate(cutoff, nowTz_(), 'yyyy-MM-dd'); // 早於此日＝閒置

  // ① 掃整份 STOCK_LOG：品號 → 最後異動日期（只讀不寫）
  var lastAct = {};
  var logSheet = getSheet_(SHEET_LOG);
  var last = logSheet.getLastRow();
  if (last >= 2) {
    var rows = logSheet.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      var code = String(rows[i][3]).trim().toUpperCase();
      var ymd = dueYMD_(rows[i][1]);
      if (!code || !ymd) continue;
      if (!lastAct[code] || ymd > lastAct[code]) lastAct[code] = ymd;
    }
  }

  // ② 逐品項組裝：有異動紀錄用最後異動日，無紀錄退用主檔 Last_Updated
  var today = Utilities.formatDate(new Date(), nowTz_(), 'yyyy-MM-dd');
  var out = [];
  listMaster_().forEach(function (it) {
    var key = String(it.item_code).trim().toUpperCase();
    if (!key) return;
    var act = lastAct[key] || dueYMD_(it.last_updated) || '';
    if (act && act > cutoffYMD) return; // 6 個月內動過 → 不列
    var days = act ? Math.floor((new Date(today + 'T00:00:00Z') - new Date(act + 'T00:00:00Z')) / 86400000) : null;
    out.push({
      item_code: it.item_code,
      item_name: it.item_name,
      color_spec: it.color_spec,
      category: it.category,
      stock_qty: it.stock_qty,
      unit: it.unit,
      location: it.location,
      last_activity: act,
      days_idle: days,
      active: it.active !== false,
    });
  });
  // 最久沒動的最前面；同日以品號排序
  out.sort(function (a, b) {
    if (a.last_activity !== b.last_activity) return String(a.last_activity).localeCompare(String(b.last_activity));
    return String(a.item_code).localeCompare(String(b.item_code));
  });
  return { cutoff: cutoffYMD, months: months, total: out.length, items: out };
}

/**
 * 批次封存／解封品項（只動 Active 欄，不刪除任何資料）
 * req = { operator, item_codes:[…], active:'N'(封存)|'Y'(解封) }
 * → { updated, active, not_found }
 */
function setItemsActive_(req) {
  checkHygienePerm_(req.operator);
  var codes = (Array.isArray(req.item_codes) ? req.item_codes : [])
    .map(function (c) { return String(c).trim().toUpperCase(); })
    .filter(function (c) { return c; });
  if (codes.length === 0) throw new Error('缺少 item_codes');
  var active = String(req.active || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N';

  ensureSheet_(SHEET_MASTER); // 舊表自動補上 Active 標頭（第 13 欄）
  var sheet = getSheet_(SHEET_MASTER);
  var last = sheet.getLastRow();
  if (last < 2) return { updated: 0, active: active, not_found: codes };
  var codesCol = sheet.getRange(2, 1, last - 1, 1).getValues();
  var status = {}; // 'Y'=找到了
  codes.forEach(function (c) { if (!status[c]) status[c] = false; });
  var count = 0;
  for (var r = 0; r < codesCol.length; r++) {
    var c = String(codesCol[r][0]).trim().toUpperCase();
    if (c && status[c] === false) { // 找到且尚未改過
      sheet.getRange(r + 2, 13).setValue(active); // 第 13 欄 = Active
      status[c] = true;
      count++;
    }
  }
  return {
    updated: count,
    active: active,
    not_found: codes.filter(function (c) { return status[c] === false; }),
  };
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

  // 經辦人標註：SHIPMENT_ORDERS 沒有經辦欄 → 從 STOCK_LOG 的出庫列
  //（備註「出貨 SH… ／ 客戶」）反查每張單的經辦人（讀最近 3000 筆，更舊的單標 '—'）
  try {
    var logSheet2 = getSheet_(SHEET_LOG);
    var last2 = logSheet2.getLastRow();
    if (last2 >= 2) {
      var startRow2 = Math.max(2, last2 - 2999);
      var num2 = last2 - startRow2 + 1;
      var lv = logSheet2.getRange(startRow2, 1, num2, LOG_HEADERS.length).getValues();
      var ops = {};
      for (var li = 0; li < lv.length; li++) {
        if (String(lv[li][2]).trim() !== '出庫') continue;
        var mm = String(lv[li][6] || '').trim().match(/^出貨\s*(SH[^\s／]*?)\s*／/);
        if (mm && mm[1] && !ops[mm[1]]) ops[mm[1]] = String(lv[li][5]).trim() || '—';
      }
      rows.forEach(function (rw) {
        rw.operator = ops[rw.shipment_id] || '—';
      });
    }
  } catch (e) { /* 讀不到紀錄就不標經辦 */ }

  return rows;
}

/** ============================================================================
 * 🔧 HC 限定：出貨單補救工具（編輯單頭／刪除整張回補庫存）
 * - 權限：operator 需為管理者（isManagerOp_：HC / MAIN，相容 01-HC、HC-王小明）
 * - 刪除出貨單會把各明細數量【回補庫存】並寫入 STOCK_LOG（type=回補，備註含單號）
 * ========================================================================== */
function checkShipmentAdmin_(operator) {
  if (!isManagerOp_(operator)) {
    throw new Error('權限不足：僅限管理者（HC / MAIN）刪改出貨單。' +
      '目前身分：' + (String(operator || '').trim() || '未填經辦人'));
  }
}

/** 找出貨單主表列：回傳 { rowIdx(0-based), order(SHP_HEADERS 物件) } 或 null */
function findShipmentRow_(sheet, shipmentId) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(shipmentId).trim()) {
      var v = values[i];
      return {
        rowIdx: i,
        order: {
          shipment_id: String(v[0]).trim(),
          shipment_date: dueYMD_(v[1]),
          customer_name: String(v[2]).trim(),
          total_styles: Number(v[3]) || 0,
          total_pcs: Number(v[4]) || 0,
          status: String(v[5]).trim(),
          remark: String(v[6]).trim(),
          invoice_no: v.length > 7 ? String(v[7]).trim() : '',
          carrier: v.length > 8 ? String(v[8]).trim() : '',
          port_from: v.length > 9 ? String(v[9]).trim() : '',
          port_to: v.length > 10 ? String(v[10]).trim() : '',
          incoterm: v.length > 11 ? String(v[11]).trim() : '',
          currency: v.length > 12 ? String(v[12]).trim() : '',
          total_cartons: v.length > 13 ? Number(v[13]) || 0 : 0,
          total_amount: v.length > 14 ? Number(v[14]) || 0 : 0,
          total_nw: v.length > 15 ? Number(v[15]) || 0 : 0,
          total_gw: v.length > 16 ? Number(v[16]) || 0 : 0,
        },
      };
    }
  }
  return null;
}

/** 該出貨單的全部明細列：回傳 [{ rowIdx(0-based), row(試算表列號1-based), line }] */
function listShipmentLines_(detSheet, shipmentId) {
  var values = detSheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() !== String(shipmentId).trim()) continue;
    var v = values[i];
    out.push({
      rowIdx: i,
      row: i + 1,
      line: {
        item_code: String(v[1]).trim(),
        item_name: String(v[2]).trim(),
        color_spec: String(v[3]).trim(),
        qty: Number(v[4]) || 0,
        unit: String(v[5]).trim(),
        carton_no: String(v[6]).trim(),
        unit_price: Number(v[7]) || 0,
        n_w: Number(v[8]) || 0,
        g_w: Number(v[9]) || 0,
        amount: Number(v[10]) || 0,
      },
    });
  }
  return out;
}

/**
 * 取單張出貨單（單頭＋明細，前端「出庫出貨→歷史出貨單管理」用）
 * req = { action:'get_shipment', shipment_id }
 */
function getShipment_(req) {
  var shipmentId = String(req.shipment_id || '').trim();
  if (!shipmentId) throw new Error('缺少 shipment_id');
  var sheet = getSheet_(SHEET_SHP);
  var hit = findShipmentRow_(sheet, shipmentId);
  if (!hit) throw new Error('找不到出貨單：' + shipmentId);
  var lines = listShipmentLines_(getSheet_(SHEET_SHPD), shipmentId).map(function (x) {
    var L = x.line;
    L.row = x.row; // SHIPMENT_DETAILS 試算表列號（update_shipment lines 用）
    return L;
  });
  return { order: hit.order, lines: lines };
}

/**
 * 編輯出貨單（HC 限定）：單頭欄位＋明細數量修正
 * req = { action:'update_shipment', shipment_id, operator,
 *         shipment_date?, customer_name?, status?, remark?,
 *         invoice_no?, carrier?, port_from?, port_to?, incoterm?, currency?,
 *         lines?: [{ row: SHIPMENT_DETAILS 試算表列號, qty }]   ← 數量修正（自動調整庫存）
 *       }
 * - 數量修正：新合計 < 舊合計 → 多出的量回補庫存；新合計 > 舊合計 → 追加扣庫
 *   （庫存不足且有填 force:true 才放行負庫存）
 * - 每次修正寫 STOCK_LOG：type=入庫/出庫，備註「修正出貨單 SH…：品號 n→m（經辦）」
 */
function updateShipment_(req) {
  var shipmentId = String(req.shipment_id || '').trim();
  if (!shipmentId) throw new Error('缺少 shipment_id');
  checkShipmentAdmin_(req.operator);
  var lines = Array.isArray(req.lines) ? req.lines : [];
  var force = !!req.force;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var shpSheet = getSheet_(SHEET_SHP);
    var hit = findShipmentRow_(shpSheet, shipmentId);
    if (!hit) throw new Error('找不到出貨單：' + shipmentId);

    // ① 單頭欄位更新（有提供才覆寫）
    var H = hit.order;
    var f = {
      1: String(req.shipment_date || '').trim() ? dueYMD_(req.shipment_date) : '',
      2: String(req.customer_name || '').trim(),
      5: String(req.status || '').trim(),
      6: String(req.remark || '').trim(),
      7: String(req.invoice_no || '').trim(),
      8: String(req.carrier || '').trim(),
      9: String(req.port_from || '').trim(),
      10: String(req.port_to || '').trim(),
      11: String(req.incoterm || '').trim(),
      12: String(req.currency || '').trim(),
    };
    for (var col in f) {
      var v = f[col];
      if (v !== '') shpSheet.getRange(hit.rowIdx + 1, Number(col)).setValue(v);
    }

    // ② 明細數量修正（庫存隨動）
    var updatedItems = [];
    if (lines.length > 0) {
      var detSheet = getSheet_(SHEET_SHPD);
      var detLines = listShipmentLines_(detSheet, shipmentId);
      var byRow = {};
      detLines.forEach(function (x) { byRow[x.row] = x; });

      // 先驗證所有要改的列（一次讀取主檔；超出在庫整批擋，force 才放行）
      var master = getSheet_(SHEET_MASTER);
      var values = master.getDataRange().getValues();
      var index = {};
      for (var r = 1; r < values.length; r++) {
        var k = String(values[r][0]).trim().toUpperCase();
        if (k && !index[k]) index[k] = r;
      }
      var aggDelta = {};   // code → 增量（>0 追加出庫、<0 回補）
      var shortages = [];
      var nRowsM = values.length;
      var newStocks = [];
      var newUpdated = [];
      for (var s = 0; s < nRowsM; s++) {
        newStocks.push([Number(values[s][4]) || 0]);
        newUpdated.push([String(values[s][7] || '')]);
      }
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var row = Number(ln.row);
        var x = byRow[row];
        if (!x) throw new Error('明細列不存在：row ' + row + '（畫面資料已過期，請重新整理再試）');
        var newQty = Number(ln.qty);
        if (isNaN(newQty) || newQty <= 0) throw new Error('列 ' + (x.line.item_code) + ' 數量需大於 0');
        var cur = x.line.qty;
        if (newQty === cur) continue; // 沒變就不動
        var delta = newQty - cur; // >0：追加出庫（扣多），<0：回補（出少了）
        aggDelta[x.line.item_code] = (aggDelta[x.line.item_code] || 0) + delta;
      }
      for (var c in aggDelta) {
        var rowIdx = index[c];
        if (rowIdx === undefined) throw new Error('品號不存在於 INVENTORY_MASTER：' + c);
        var stock = Number(values[rowIdx][4]) || 0;
        if (aggDelta[c] > 0 && aggDelta[c] > stock) {
          shortages.push(c + '：在庫 ' + stock + '、需追加扣庫 ' + aggDelta[c]);
        }
      }
      if (shortages.length > 0 && !force) {
        throw new Error('庫存不足，整批擋下：' + shortages.join('；') +
          '（貨已實際出倉可再送一次並附 force:true）');
      }
      for (var c2 in aggDelta) {
        var rowIdx2 = index[c2];
        var after = round4_((Number(values[rowIdx2][4]) || 0) - aggDelta[c2]);
        newStocks[rowIdx2] = [after];
        newUpdated[rowIdx2] = [now_()];
        var item2 = rowToItem_(values[rowIdx2]);
        item2.stock_qty = after;
        updatedItems.push(item2);
      }
      if (nRowsM > 1) {
        master.getRange(2, 5, nRowsM - 1, 1).setValues(newStocks.slice(1));
        master.getRange(2, 8, nRowsM - 1, 1).setValues(newUpdated.slice(1));
      }

      // 明細列覆寫 qty ＋ Amount，並寫 STOCK_LOG 修正紀錄
      var logId_ = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
        ('000' + Math.floor(Math.random() * 1000)).slice(-3);
      var logRows = [];
      var seq = 0;
      var byCodeDelta = {}; // 供備註顯示合計差異
      for (var c3 in aggDelta) byCodeDelta[c3] = 0;
      for (var j = 0; j < lines.length; j++) {
        var ln2 = lines[j];
        var row2 = Number(ln2.row);
        var x2 = byRow[row2];
        if (!x2) continue;
        var newQty2 = Number(ln2.qty);
        if (newQty2 === x2.line.qty) continue;
        byCodeDelta[x2.line.item_code] += newQty2 - x2.line.qty;
        detSheet.getRange(row2, 5).setValue(newQty2); // Qty
        var price = x2.line.unit_price;
        if (price > 0) detSheet.getRange(row2, 11).setValue(round4_(price * newQty2));
      }
      for (var c4 in byCodeDelta) {
        if (!byCodeDelta[c4]) continue; // 同品號多列加總後沒變 → 不寫紀錄
        var idxM = index[c4] === undefined ? 0 : index[c4];
        var label = c4 + (idxM && String(values[idxM][1]).trim() ? ' ' + String(values[idxM][1]).trim() : '');
        logRows.push([
          logId_ + ('00' + (seq + 1)).slice(-2), now_(),
          byCodeDelta[c4] > 0 ? '出庫' : '入庫', c4, -byCodeDelta[c4], String(req.operator || '').trim() || 'HC',
          '修正出貨單 ' + shipmentId + '：' + label + ' 出貨量調整 ' + (byCodeDelta[c4] > 0 ? '+' : '') + (-byCodeDelta[c4]),
        ]);
        seq++;
      }
      if (logRows.length > 0) {
        var logSheet = getSheet_(SHEET_LOG);
        logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, LOG_HEADERS.length)
          .setValues(logRows);
      }

      // ③ 重算單頭統計（總款式／總件數／總箱數／金額／淨毛重）
      var freshLines = listShipmentLines_(detSheet, shipmentId).map(function (x) { return x.line; });
      var styles = {};
      var pcs = 0;
      var cartons = {};
      var amount = 0;
      var nw = 0;
      var gw = 0;
      freshLines.forEach(function (L) {
        styles[L.item_code] = true;
        pcs += L.qty;
        if (L.carton_no) cartons[L.carton_no] = true;
        amount += L.unit_price * L.qty;
        nw += L.n_w;
        gw += L.g_w;
      });
      shpSheet.getRange(hit.rowIdx + 1, 4).setValue(Object.keys(styles).length);
      shpSheet.getRange(hit.rowIdx + 1, 5).setValue(pcs);
      shpSheet.getRange(hit.rowIdx + 1, 14).setValue(Object.keys(cartons).length);
      shpSheet.getRange(hit.rowIdx + 1, 15).setValue(round4_(amount));
      shpSheet.getRange(hit.rowIdx + 1, 16).setValue(round4_(nw));
      shpSheet.getRange(hit.rowIdx + 1, 17).setValue(round4_(gw));
    }

    return { shipment_id: shipmentId, updated: true, updated_items: updatedItems };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/**
 * 刪除出貨單（HC 限定）：主表＋明細整張刪除，各明細數量【回補庫存】並寫回補紀錄
 * req = { action:'delete_shipment', shipment_id, operator }
 * 回傳 { deleted, shipment_id, returned: [{item_code, item_name, qty}], restored_count }
 */
function deleteShipment_(req) {
  var shipmentId = String(req.shipment_id || '').trim();
  if (!shipmentId) throw new Error('缺少 shipment_id');
  checkShipmentAdmin_(req.operator);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var shpSheet = getSheet_(SHEET_SHP);
    var hit = findShipmentRow_(shpSheet, shipmentId);
    if (!hit) throw new Error('找不到出貨單：' + shipmentId);
    var detSheet = getSheet_(SHEET_SHPD);
    var detLines = listShipmentLines_(detSheet, shipmentId);
    if (detLines.length === 0) throw new Error('出貨單 ' + shipmentId + ' 沒有任何明細列（請確認後再刪）');

    // ① 回補庫存：明細各 code 合計 → 逐次性讀主檔；同 code 多列累加
    var master = getSheet_(SHEET_MASTER);
    var values = master.getDataRange().getValues();
    var index = {};
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][0]).trim().toUpperCase();
      if (k && !index[k]) index[k] = r;
    }
    var agg = {}; // code → 回補量
    for (var i = 0; i < detLines.length; i++) {
      var code = detLines[i].line.item_code;
      agg[code] = (agg[code] || 0) + (Number(detLines[i].line.qty) || 0);
    }
    var nRows = values.length;
    var newStocks = [];
    var newUpdated = [];
    for (var s = 0; s < nRows; s++) {
      newStocks.push([Number(values[s][4]) || 0]);
      newUpdated.push([String(values[s][7] || '')]);
    }
    var logRows = [];
    var returned = [];
    var logId_ = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
      ('000' + Math.floor(Math.random() * 1000)).slice(-3);
    var seq = 0;
    for (var c in agg) {
      var rowIdx = index[c];
      if (rowIdx === undefined) continue; // 主檔已無此品號 → 只刪單不回補
      var after = round4_((Number(values[rowIdx][4]) || 0) + agg[c]);
      newStocks[rowIdx] = [after];
      newUpdated[rowIdx] = [now_()];
      var item = rowToItem_(values[rowIdx]);
      item.stock_qty = after;
      returned.push({ item_code: c, item_name: item.item_name, qty: agg[c] });
      logRows.push([
        logId_ + ('00' + (seq + 1)).slice(-2), now_(), '回補', c, agg[c], String(req.operator || '').trim() || 'HC',
        '刪除出貨單 ' + shipmentId + '：回補 ' + c + ' ' + item.item_name + ' × ' + agg[c],
      ]);
      seq++;
    }
    if (nRows > 1) {
      master.getRange(2, 5, nRows - 1, 1).setValues(newStocks.slice(1));
      master.getRange(2, 8, nRows - 1, 1).setValues(newUpdated.slice(1));
    }

    // ② STOCK_LOG 一次附加（type=回補；正數＝加回庫存）
    if (logRows.length > 0) {
      var logSheet = getSheet_(SHEET_LOG);
      logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, LOG_HEADERS.length)
        .setValues(logRows);
    }

    // ③ 刪除明細列（由下往上刪避免位移）
    for (var d2 = detLines.length - 1; d2 >= 0; d2--) {
      detSheet.deleteRow(detLines[d2].row);
    }
    // ④ 刪除主表列
    shpSheet.deleteRow(hit.rowIdx + 1);

    return {
      deleted: true,
      shipment_id: shipmentId,
      returned: returned,
      restored_count: returned.length,
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/**
 * 🔧 HC 限定：刪改出入庫紀錄（備註式出庫等非正式單的補救）
 * req = { action:'correct_stock_log', log_id, operator,
 *         new_qty?: 新的異動數量（簽號：出庫負／入庫正）← 給了就是「修改」
 *         delete?: true                                        ← 「刪除整列」 }
 * - 入庫／出庫列：修改＝庫存加（新−舊）差額；刪除＝庫存反轉原數量（扣過的還回來）
 * - 盤點列：只允許刪除（還原到盤點前那一瞬的庫存＝現值−當時差額，期間若有其他異動會失準）
 * - 任何操作皆另寫一筆 type=「更正」稽核紀錄（change=0，不改庫存，僅留痕）
 * 回傳 { corrected, log_id, item_code, old_change, new_change, deleted, item }
 */
function correctStockLog_(req) {
  checkShipmentAdmin_(req.operator);
  var logId = String(req.log_id || '').trim();
  if (!logId) throw new Error('缺少 log_id');
  var doDelete = !!req.delete;
  var hasNew = req.new_qty !== undefined && req.new_qty !== null && String(req.new_qty).trim() !== '';
  var newQty = hasNew ? Number(req.new_qty) : null;
  var newRemark = req.new_remark !== undefined && req.new_remark !== null ? String(req.new_remark).trim() : null;
  if (doDelete && (hasNew || newRemark !== null)) throw new Error('delete 與 new_qty / new_remark 只能擇一組');
  if (!doDelete && !hasNew && newRemark === null) throw new Error('請提供 new_qty（新異動數量）或 new_remark（新備註）');
  if (hasNew && isNaN(newQty)) throw new Error('new_qty 需為數字');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // ① 在最近 2000 筆內定位 Log_ID
    var logSheet = getSheet_(SHEET_LOG);
    var last = logSheet.getLastRow();
    if (last < 2) throw new Error('STOCK_LOG 沒有任何紀錄');
    var startRow = Math.max(2, last - 1999);
    var num = last - startRow + 1;
    var values = logSheet.getRange(startRow, 1, num, LOG_HEADERS.length).getValues();
    var rowIdx = -1; // 0-based（values 內）
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim() === logId) { rowIdx = i; break; }
    }
    if (rowIdx === -1) throw new Error('最近 2000 筆內找不到紀錄 ' + logId + '（更舊的請直接在工作表處理）');
    var sheetRow = startRow + rowIdx; // 1-based 試算表列號
    var rType = String(values[rowIdx][2]).trim();
    var rCode = String(values[rowIdx][3]).trim();
    var rOld = Number(values[rowIdx][4]) || 0;
    var rOperator = String(values[rowIdx][5]).trim() || '—';
    var rRemark = String(values[rowIdx][6]).trim();

    // ② 操作限制
    if (['入庫', '出庫', '盤點', '回補'].indexOf(rType) === -1) {
      throw new Error('此紀錄類型不可刪改：' + rType);
    }
    if (rType === '盤點') {
      if (hasNew) throw new Error('盤點列不可修改數量——請先刪除此列再重新盤點校正');
      // 刪除／僅改備註 OK
    }
    if (hasNew && rType !== '入庫' && rType !== '出庫') {
      throw new Error('只有入庫／出庫列可以修改數量');
    }

    // ③ 庫存隨動：刪除 → 現值 − 原量；修改 → 現值 +（新 − 舊）
    var item = null;
    var stockAfter = null;
    var stockDelta = doDelete ? -rOld : (hasNew ? (newQty - rOld) : 0);
    if (rCode) {
      var master = getSheet_(SHEET_MASTER);
      var mv = master.getDataRange().getValues();
      for (var m = 1; m < mv.length; m++) {
        if (String(mv[m][0]).trim().toUpperCase() !== rCode.toUpperCase()) continue;
        stockAfter = round4_((Number(mv[m][4]) || 0) + stockDelta);
        master.getRange(m + 1, 5).setValue(stockAfter);
        master.getRange(m + 1, 8).setValue(now_());
        item = rowToItem_(mv[m]);
        item.stock_qty = stockAfter;
        break;
      }
    }

    // ④ 原列處理：修改 → 覆寫數量／備註（＋更正標記）；刪除 → 整列移除
    if (doDelete) {
      logSheet.deleteRow(sheetRow);
    } else {
      var finalRemark = newRemark !== null ? newRemark : rRemark;
      if (hasNew) {
        finalRemark = finalRemark + (finalRemark ? '；' : '') + '更正 ' + rOld + '→' + newQty + '（' + (String(req.operator || '').trim() || 'HC') + '）';
        logSheet.getRange(sheetRow, 5).setValue(newQty);
      }
      logSheet.getRange(sheetRow, 7).setValue(finalRemark);
    }

    // ⑤ 稽核紀錄（type=更正，change=0，不影響庫存）
    var auditId = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
      ('000' + Math.floor(Math.random() * 1000)).slice(-3);
    var hcOp = String(req.operator || '').trim() || 'HC';
    var acts = [];
    if (doDelete) acts.push('刪除整列');
    if (hasNew) acts.push('異動量 ' + rOld + '→' + newQty);
    if (newRemark !== null && !doDelete) acts.push(hasNew ? '並改備註' : '修改備註（原：' + (rRemark || '無') + '）');
    var detail = '更正紀錄 ' + logId + '（' + rType + ' ' + rCode + '，原經辦 ' + rOperator + '）：' +
      (doDelete
        ? '刪除整列（庫存 ' + (rOld >= 0 ? '＋' : '−') + Math.abs(rOld) + '）'
        : acts.join('、'));
    logSheet.appendRow([auditId, now_(), '更正', rCode, 0, hcOp, detail]);

    return {
      corrected: true,
      log_id: logId,
      item_code: rCode,
      old_change: rOld,
      new_change: doDelete ? null : (hasNew ? newQty : rOld),
      new_remark: doDelete ? null : (newRemark !== null ? newRemark : rRemark),
      deleted: doDelete,
      item: item || undefined,
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
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
    active: row.length > 12 ? (String(row[12]).trim().toUpperCase() !== 'N') : true, // 空白視為未封存（true）；'N'＝已封存
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
  Logger.log('建立 %s …', ensureSheet_(SHEET_YARN));     // V2 紗線庫存
  Logger.log('建立 %s …', ensureSheet_(SHEET_PWO));      // V2 新版工作令
  Logger.log('建立 %s …', ensureSheet_(SHEET_PWO_YARN)); // V2 工單領紗明細
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
              : (name === SHEET_YARN) ? YARN_HEADERS
              : (name === SHEET_PWO) ? PWO_HEADERS
              : (name === SHEET_PWO_YARN) ? PWO_YARN_HEADERS
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

/* ============================================================
 * 🧵 V2：紗線庫存（YARN_INVENTORY）
 * ============================================================ */

/** 紗線清單（依 Yarn_Code 排序） */
function listYarn_() {
  var sheet = getSheet_(SHEET_YARN);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    rows.push(rowToYarn_(values[i]));
  }
  rows.sort(function (a, b) { return String(a.yarn_code).localeCompare(String(b.yarn_code)); });
  return rows;
}

/** 紗線一列 → 前端資料物件 */
function rowToYarn_(row) {
  return {
    yarn_code: String(row[0]).trim(),
    yarn_name: String(row[1]).trim(),
    color: String(row[2]).trim(),
    stock_kg: Number(row[3]) || 0,
    safety_stock: Number(row[4]) || 0,
    last_updated: String(row[5] || '').trim(),
  };
}

/** 紗線自動編號：Y####（既有最大序號 + 1） */
function nextYarnCode_(sheet) {
  var last = sheet.getLastRow();
  var max = 0;
  if (last >= 2) {
    var codes = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < codes.length; i++) {
      var m = String(codes[i][0]).trim().toUpperCase().match(/^Y(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return 'Y' + ('000' + (max + 1)).slice(-3);
}

/** 依紗線代碼（不分大小寫）找列號；找不到回 -1 */
function findYarnRow_(sheet, code) {
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
 * 新增／更新紗線（upsert）：
 * req = { yarn_code?(留空自動 Y####), yarn_name(必填), color?,
 *         stock_kg?, safety_stock? }（stock_kg = 直接設定為現有庫存量）
 * 已存在的 yarn_code 只會更新有提供 Stock_KG / Safety_Stock 的欄位。
 */
function saveYarn_(req) {
  var name = String(req.yarn_name || '').trim();
  if (!name) throw new Error('缺少紗名 Yarn_Name');
  var color = String(req.color || '').trim();
  var hasStock = req.stock_kg !== undefined && req.stock_kg !== null && String(req.stock_kg).trim() !== '';
  var stock = hasStock ? Number(req.stock_kg) : null;
  if (hasStock && (isNaN(stock) || stock < 0)) {
    throw new Error('Stock_KG 格式錯誤（不可為負數）：' + req.stock_kg);
  }
  var hasSafety = req.safety_stock !== undefined && req.safety_stock !== null && String(req.safety_stock).trim() !== '';
  var safety = hasSafety ? Number(req.safety_stock) : null;
  if (hasSafety && (isNaN(safety) || safety < 0)) {
    throw new Error('Safety_Stock 格式錯誤（不可為負數）：' + req.safety_stock);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_(SHEET_YARN);
    var code = String(req.yarn_code || '').trim().replace(/^#/, '').toUpperCase();
    var row = code ? findYarnRow_(sheet, code) : -1;
    if (row === -1) {
      // 新建：無碼自動編號（自訂碼需不存在於檔內）
      if (!code) code = nextYarnCode_(sheet);
      row = sheet.getLastRow() + 1;
      sheet.getRange(row, 1, 1, YARN_HEADERS.length).setValues([[
        code, name, color,
        stock !== null ? stock : 0,
        safety !== null ? safety : 0,
        now_(),
      ]]);
    } else {
      if (stock !== null) sheet.getRange(row, 4).setValue(stock);
      if (safety !== null) sheet.getRange(row, 5).setValue(safety);
      sheet.getRange(row, 2).setValue(name);
      if (color) sheet.getRange(row, 3).setValue(color);
      sheet.getRange(row, 6).setValue(now_());
    }
    return { yarn: rowToYarn_(sheet.getRange(row, 1, 1, YARN_HEADERS.length).getValues()[0]) };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/* ============================================================
 * 🧵 V2：新版工作令（PRODUCTION_ORDERS）＋ 領紗（WO_YARN）
 * ============================================================ */

/** 工作令自動編號：#G + 既有最大序號 + 1（無資料時由 #G24001 起，可延續紙本序列） */
function nextPWOId_(sheet) {
  var last = sheet.getLastRow();
  var max = 23999;
  if (last >= 2) {
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var m = String(ids[i][0]).trim().replace(/^#/, '').toUpperCase().match(/^G(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return '#' + 'G' + (max + 1);
}

/** 依 WO_ID（容許 # 前綴／不分大小寫）找工作令列號；找不到回 -1 */
function findPWORow_(sheet, woId) {
  if (!woId) return -1;
  var target = String(woId).trim().replace(/^#/, '').toUpperCase();
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim().replace(/^#/, '').toUpperCase() === target) return i + 2;
  }
  return -1;
}

/** 工作令一列（＋領紗明細）→ 前端資料物件 */
function rowToPWO_(row, yarnLines) {
  return {
    wo_id: String(row[0]).trim(),
    customer: String(row[1]).trim(),
    style_no: String(row[2]).trim(),
    plan_qty: Number(row[3]) || 0,
    due_date: dueYMD_(row[4]),
    color_a: String(row[5]).trim(),
    color_b: String(row[6]).trim(),
    color_c: String(row[7]).trim(),
    color_d: String(row[8]).trim(),
    color_e: String(row[9]).trim(),
    qty_a: Number(row[10]) || null,
    qty_b: Number(row[11]) || null,
    qty_c: Number(row[12]) || null,
    qty_d: Number(row[13]) || null,
    qty_e: Number(row[14]) || null,
    process_setting: String(row[15]).trim(),
    process_sewing: String(row[16]).trim(),
    process_packing: String(row[17]).trim(),
    destination: String(row[18]).trim(),
    order_ref: String(row[19]).trim(),
    status: String(row[20]).trim(),
    actual_good_qty: row[21] === '' ? null : Number(row[21]),
    confirmed_operator: String(row[22]).trim(),
    completed_time: String(row[23] || '').trim(),
    remark: String(row[24]).trim(),
    yarn_lines: yarnLines || [],
  };
}

/** WO_YARN 一列 → 前端資料物件 */
function rowToWOYarn_(row) {
  return {
    wo_id: String(row[0]).trim(),
    yarn_code: String(row[1]).trim(),
    yarn_name: String(row[2]).trim(),
    kg_per_unit: Number(row[3]) || 0,
    total_kg: Number(row[4]) || 0,
    source: String(row[5]).trim(),
    deducted: String(row[6]).trim() === 'Y',
    deducted_time: String(row[7] || '').trim(),
  };
}

/** 讀取某工作令（或全部）的領紗明細 */
function yarnLinesForWO_(woId, onlyUndeducted) {
  var sheet = getSheet_(SHEET_PWO_YARN);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim().replace(/^#/, '').toUpperCase() !==
        String(woId).trim().replace(/^#/, '').toUpperCase()) continue;
    if (onlyUndeducted && String(values[i][6]).trim() !== 'N') continue;
    rows.push(rowToWOYarn_(values[i]));
  }
  return rows;
}

/** 整份新版工作令（含各單領紗明細），以 WO_ID 由新到舊排序 */
function listProductionOrders_() {
  var sheet = getSheet_(SHEET_PWO);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    var woId = String(values[i][0]).trim();
    rows.push(rowToPWO_(values[i], yarnLinesForWO_(woId)));
  }
  rows.sort(function (a, b) { return String(b.wo_id).localeCompare(String(a.wo_id)); });
  return rows;
}

/**
 * 彙整單張工作令的紗線需求：
 * ① BOM_MASTER 內屬於 YARN_INVENTORY 的列（Source=BOM）
 * ② 開單手動指定的 yarn_lines（Source=MANUAL）
 * 依 Yarn_Code 合併、單頂用紗量相加；未知紗線代碼直接拋錯（必須先建檔）
 * 回傳 [{ yarn_code, yarn_name, kg_per_unit, total_kg, source }]
 */
function resolveYarnNeed_(styleNo, manualLines) {
  var yarns = listYarn_();
  var yarnMap = {};
  yarns.forEach(function (y) { yarnMap[String(y.yarn_code).toUpperCase()] = y; });

  var need = {};   // CODE -> line
  var order = [];  // 維持第一次出現順序
  function addLine(code, name, kgUnit, source) {
    code = String(code || '').trim().replace(/^#/, '').toUpperCase();
    if (!code) throw new Error('紗線代碼 Yarn_Code 不可空白');
    var y = yarnMap[code];
    if (!y) throw new Error('紗線代碼不存在於 YARN_INVENTORY（請先在紗線庫存建檔）：' + code);
    var kg = Number(kgUnit);
    if (isNaN(kg) || kg <= 0) throw new Error('單頂用紗量需大於 0：' + code);
    var line = need[code];
    if (!line) {
      line = need[code] = {
        yarn_code: code,
        yarn_name: name || y.yarn_name,
        kg_per_unit: 0,
        total_kg: 0,
        sources: [],
      };
      order.push(code);
    }
    line.kg_per_unit = round4_(line.kg_per_unit + kg);
    if (line.sources.indexOf(source) === -1) line.sources.push(source);
  }

  // ① BOM（只有 YARN_INVENTORY 內的品號視為紗線；其餘原料留給完工 BOM 扣料）
  if (styleNo) {
    bomForStyle_(styleNo).forEach(function (b) {
      if (yarnMap[String(b.item_code).trim().toUpperCase()]) {
        addLine(b.item_code, b.item_name, b.unit_use, 'BOM');
      }
    });
  }
  // ② 開單直接指定
  (Array.isArray(manualLines) ? manualLines : []).forEach(function (l) {
    addLine(l.yarn_code, undefined, l.kg_per_unit, 'MANUAL');
  });

  var out = [];
  order.forEach(function (c) {
    var l = need[c];
    l.source = l.sources.join('+');
    l.total_kg = round4_(l.kg_per_unit); // × Plan_Qty 由呼叫端補（write 階段已知量）
    out.push(l);
  });
  return out;
}

/** 把紗線需求寫入 WO_YARN（先全部 Deducted=N 預估；投產時改 Y 並扣庫存） */
function writeYarnLines_(woId, need, planQty) {
  ensureSheet_(SHEET_PWO_YARN);
  var sheet = getSheet_(SHEET_PWO_YARN);
  var rows = need.map(function (l) {
    var total = round4_(l.kg_per_unit * (Number(planQty) || 0));
    return [woId, l.yarn_code, l.yarn_name, l.kg_per_unit, total, l.source, 'N', ''];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, PWO_YARN_HEADERS.length).setValues(rows);
}

/**
 * 投產扣紗：YARN_INVENTORY.Stock_KG -= Total_KG（不足仍照扣 → 負庫存供現場檢討）
 * + STOCK_LOG 記錄（出庫）＋ WO_YARN 標記 Deducted=Y
 * 回傳 { yarn_used, updated_yarn, alerts:[…低於安全庫存／透支提示] }
 */
function deductYarn_(woId, operator) {
  var lines = yarnLinesForWO_(woId, true); // 僅未扣的
  if (lines.length === 0) return { yarn_used: 0, updated_yarn: [], alerts: [] };

  var logId = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
    ('000' + Math.floor(Math.random() * 1000)).slice(-3);
  var logRows = [];
  var updatedYarn = [];
  var alerts = [];
  var seq = 0;

  var yarnSheet = getSheet_(SHEET_YARN);
  var values = yarnSheet.getDataRange().getValues();
  var index = {};
  for (var r = 1; r < values.length; r++) {
    var k = String(values[r][0]).trim().toUpperCase();
    if (k && !index[k]) index[k] = r;
  }

  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var idx = index[String(l.yarn_code).toUpperCase()];
    if (idx === undefined) {
      alerts.push(l.yarn_code + ' ' + l.yarn_name + '：紗線檔已不存在，未扣庫存（請人工補正）');
      continue;
    }
    var before = Number(values[idx][3]) || 0;
    var after = round4_(before - l.total_kg);
    yarnSheet.getRange(idx + 2, 4).setValue(after);
    yarnSheet.getRange(idx + 2, 6).setValue(now_());
    var y = rowToYarn_(values[idx]);
    y.stock_kg = after;
    y.last_updated = now_();
    updatedYarn.push(y);
    logRows.push([logId + ('00' + (seq + 1)).slice(-2), now_(), '出庫', l.yarn_code, -l.total_kg,
      operator, 'PWO 領紗 ' + woId + '（' + l.source + '）']);
    seq++;
    if (after < 0) {
      alerts.push(l.yarn_code + ' ' + l.yarn_name + '：領紗後透支 ' + Math.abs(after) + ' KG（現場請檢討補料）');
    } else if (after < (Number(values[idx][4]) || 0)) {
      alerts.push(l.yarn_code + ' ' + l.yarn_name + '：領紗後 ' + after + ' KG，低於安全庫存');
    }
  }

  // STOCK_LOG 一次批次附加
  if (logRows.length > 0) {
    var logSheet = getSheet_(SHEET_LOG);
    logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, LOG_HEADERS.length)
      .setValues(logRows);
  }

  // WO_YARN 標記已扣除
  var yarnRows = getSheet_(SHEET_PWO_YARN).getDataRange().getValues();
  var yarnSheet2 = getSheet_(SHEET_PWO_YARN);
  for (var w = 1; w < yarnRows.length; w++) {
    if (String(yarnRows[w][0]).trim().replace(/^#/, '').toUpperCase() !==
        String(woId).trim().replace(/^#/, '').toUpperCase()) continue;
    if (String(yarnRows[w][6]).trim() === 'N') {
      yarnSheet2.getRange(w + 2, 7).setValue('Y');
      yarnSheet2.getRange(w + 2, 8).setValue(now_());
    }
  }

  return { yarn_used: updatedYarn.length, updated_yarn: updatedYarn, alerts: alerts };
}

/**
 * 開立新版工作令：
 * req = { wo_id?（留空自動 #G 序列）, customer, style_no, plan_qty, due_date,
 *         colors?: [{color, qty}, …最多5], destination, order_ref?,
 *         process_setting?, process_sewing?, process_packing?,
 *         yarn_lines?: [{yarn_code, kg_per_unit}, …],
 *         start_now?: true 直接投產（立即扣紗）, operator?, remark? }
 * 配色數量合計若已填且不等於 Plan_Qty → 擋下（紙本「總計＝各組合計」）
 */
function createProductionOrder_(req) {
  var style = String(req.style_no || '').trim();
  if (!style) throw new Error('缺少型號 Style_No');
  var planQty = Number(req.plan_qty);
  if (isNaN(planQty) || planQty <= 0) throw new Error('預計產量 Plan_Qty 必須大於 0');
  var dest = String(req.destination || '').trim();
  if (PWO_DESTS.indexOf(dest) === -1) {
    throw new Error('Destination 必須為：入倉庫備庫 / 訂單出貨，收到：' + dest);
  }
  var due = dueYMD_(req.due_date);
  if (!due) throw new Error('缺少預計交期 Due_Date（格式 YYYY-MM-DD）');
  var customer = String(req.customer || '').trim();
  var orderRef = String(req.order_ref || '').trim();
  var operator = String(req.operator || '').trim() || '—';
  var remark = String(req.remark || '').trim();
  var startNow = !!req.start_now;

  // 五色配色（顏色稱呼以頭頂顏色為準）
  var colors = Array.isArray(req.colors) ? req.colors.slice(0, 5) : [];
  var colorTexts = ['', '', '', '', ''];
  var qtyNums = [null, null, null, null, null];
  var qtySum = 0;
  var hasQty = false;
  for (var c = 0; c < 5; c++) {
    var item = colors[c];
    if (!item) continue;
    colorTexts[c] = String(item.color || '').trim();
    var q = String(item.qty === undefined || item.qty === null ? '' : item.qty).trim();
    if (q !== '') {
      var qn = Number(q);
      if (isNaN(qn) || qn <= 0) throw new Error('第 ' + (c + 1) + ' 組配色數量需為正數');
      qtyNums[c] = qn;
      qtySum += qn;
      hasQty = true;
    }
  }
  if (colorTexts.join('') === '') {
    throw new Error('請至少填寫一組配色（A色～E色）');
  }
  if (hasQty && round4_(qtySum) !== round4_(planQty)) {
    throw new Error('配色數量合計 ' + qtySum + ' 與預計產量 ' + planQty + ' 不符（請檢查 A色～E色數量）');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_(SHEET_PWO);
    // 工單編號：手動輸入（延續紙本序列）需唯一；留空自動編號 #Gxxxx
    var woId = String(req.wo_id || '').trim().replace(/^#+/, '').toUpperCase();
    if (woId) {
      woId = '#' + woId;
      if (findPWORow_(sheet, woId) !== -1) throw new Error('工單編號已存在：' + woId);
    } else {
      woId = nextPWOId_(sheet);
    }

    // 紗線需求（BOM＋手動合併；未知紗線代碼會拋錯）
    var need = resolveYarnNeed_(style, req.yarn_lines);
    if (need.length === 0 && startNow) {
      // 無紗線需求不擋投產（例如外包半成品組合），僅提示由前端處理
    }

    var rowIdx = sheet.getLastRow() + 1;
    sheet.getRange(rowIdx, 1, 1, PWO_HEADERS.length).setValues([[
      woId, customer, style, planQty, due,
      colorTexts[0], colorTexts[1], colorTexts[2], colorTexts[3], colorTexts[4],
      qtyNums[0], qtyNums[1], qtyNums[2], qtyNums[3], qtyNums[4],
      String(req.process_setting || '').trim(),
      String(req.process_sewing || '').trim(),
      String(req.process_packing || '').trim(),
      dest, orderRef,
      startNow ? PWO_STATUS_ACTIVE : PWO_STATUS_DRAFT,
      '', '', '', remark,
    ]]);

    // 領紗明細先記錄（Deducted=N）
    writeYarnLines_(woId, need, planQty);

    var result = {
      wo: rowToPWO_(sheet.getRange(rowIdx, 1, 1, PWO_HEADERS.length).getValues()[0],
        yarnLinesForWO_(woId)),
      yarn_need: need,
      deduction: { yarn_used: 0, updated_yarn: [], alerts: [] },
    };

    // 直接投產 → 立即扣紗
    if (startNow) {
      result.deduction = deductYarn_(woId, operator);
    }
    return result;
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/** 草稿 → 生產中：立即依預估領紗明細扣 YARN_INVENTORY */
function startProductionOrder_(req) {
  var woId = String(req.wo_id || '').trim();
  if (!woId) throw new Error('缺少 WO_ID');
  var operator = String(req.operator || '').trim() || '—';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_(SHEET_PWO);
    var row = findPWORow_(sheet, woId);
    if (row === -1) throw new Error('找不到工作令：' + woId);
    var status = String(sheet.getRange(row, 21).getValue()).trim();
    if (status !== PWO_STATUS_DRAFT) {
      throw new Error('只有「草稿」工作令可以投產，目前：' + status);
    }
    sheet.getRange(row, 21).setValue(PWO_STATUS_ACTIVE);
    var deduction = deductYarn_(sheet.getRange(row, 1).getValue(), operator);
    return {
      wo: rowToPWO_(sheet.getRange(row, 1, 1, PWO_HEADERS.length).getValues()[0],
        yarnLinesForWO_(sheet.getRange(row, 1).getValue())),
      deduction: deduction,
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/**
 * 確認完工分流（與舊版對應）：
 * - 入倉庫備庫 → target_item_code 必填：成品 Actual_Good_Qty 入 INVENTORY_MASTER
 *   （STOCK_LOG 記錄）＋ 狀態 → 已入庫
 * - 訂單出貨   → 不入一般成品庫，狀態 → 待出貨（後續由「出庫出貨」分頁開出貨單，
 *                欄位結構對應 Commercial Invoice / Packing List）
 * - 紗線已於投產時扣除，此處不重複扣；use_bom 只扣 BOM 台帳內「非紗線」原料
 * req = { wo_id, actual_good_qty, target_item_code?, use_bom?, operator, remark? }
 */
function completeProductionOrder_(req) {
  var woId = String(req.wo_id || '').trim();
  if (!woId) throw new Error('缺少 WO_ID');
  var actual = Number(req.actual_good_qty);
  if (isNaN(actual) || actual < 0) throw new Error('實際完工良品數 Actual_Good_Qty 格式錯誤');
  var operator = String(req.operator || '').trim();
  if (!operator) throw new Error('缺少完工經辦 Confirmed_Operator');
  var remark = String(req.remark || '').trim();
  var useBom = !!req.use_bom;
  var targetItem = String(req.target_item_code || '').trim();
  var colQty = 5; // INVENTORY_MASTER Stock_Qty 欄

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var woSheet = getSheet_(SHEET_PWO);
    var row = findPWORow_(woSheet, woId);
    if (row === -1) throw new Error('找不到工作令：' + woId);
    var wo = rowToPWO_(woSheet.getRange(row, 1, 1, PWO_HEADERS.length).getValues()[0]);
    if (wo.status !== PWO_STATUS_ACTIVE && wo.status !== PWO_STATUS_CHECK) {
      throw new Error('工作令狀態為「' + wo.status + '」，不能完工');
    }

    var master = getSheet_(SHEET_MASTER);
    var updatedItems = [];
    var woRemark = 'PWO 完工 ' + wo.wo_id + (remark ? '；' + remark : '');

    if (wo.destination === '入倉庫備庫') {
      if (!targetItem) throw new Error('入倉庫備庫完工需選擇入庫成品料號 target_item_code');
      var itemRow = findMasterRow_(master, targetItem);
      if (itemRow === -1) throw new Error('品號不存在於 INVENTORY_MASTER：' + targetItem);
      var cur = Number(master.getRange(itemRow, colQty).getValue()) || 0;
      master.getRange(itemRow, colQty).setValue(cur + actual);
      master.getRange(itemRow, 8).setValue(now_());
      var logId = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
        ('000' + Math.floor(Math.random() * 1000)).slice(-3);
      getSheet_(SHEET_LOG).appendRow([
        logId, now_(), '入庫', String(master.getRange(itemRow, 1).getValue()), actual, operator, woRemark,
      ]);
      updatedItems.push(rowToItem_(master.getRange(itemRow, 1, 1, MASTER_HEADERS.length).getValues()[0]));
    }
    // 訂單出貨：不入一般成品庫 → 待出貨（連動現有出貨單／CI / PL 流程）

    // 選用：完工時依 BOM 扣「非紗線」原料（紗線已於投產扣過，跳過避免重複）
    var bomUsed = 0;
    if (useBom) {
      var yarnCodes = {};
      listYarn_().forEach(function (y) { yarnCodes[String(y.yarn_code).toUpperCase()] = true; });
      bomForStyle_(wo.style_no).forEach(function (b) {
        var code = String(b.item_code).trim();
        if (!code || yarnCodes[code.toUpperCase()]) return; // 紗線：投產已扣
        var consume = round4_(Number(b.unit_use) * actual);
        if (!(consume > 0)) return;
        var mRow = findMasterRow_(master, code);
        if (mRow === -1) return; // 原料品號不存在 → 跳過不擋結案
        var mCur = Number(master.getRange(mRow, colQty).getValue()) || 0;
        master.getRange(mRow, colQty).setValue(mCur - consume);
        master.getRange(mRow, 8).setValue(now_());
        var logId2 = 'L' + Utilities.formatDate(new Date(), nowTz_(), 'yyyyMMddHHmmss') +
          ('000' + Math.floor(Math.random() * 1000)).slice(-3);
        getSheet_(SHEET_LOG).appendRow([logId2, now_(), '出庫', code, -consume, operator,
          'PWO BOM 扣料 ' + wo.wo_id]);
        updatedItems.push(rowToItem_(master.getRange(mRow, 1, 1, MASTER_HEADERS.length).getValues()[0]));
        bomUsed++;
      });
    }

    // 更新工作令：狀態／實際良品數／完工經辦／完工時間
    woSheet.getRange(row, 21).setValue(wo.destination === '入倉庫備庫' ? PWO_STATUS_IN : PWO_STATUS_TOSHIP);
    woSheet.getRange(row, 22).setValue(actual);        // Actual_Good_Qty
    woSheet.getRange(row, 23).setValue(operator);      // Confirmed_Operator
    woSheet.getRange(row, 24).setValue(now_());        // Completed_Time
    if (remark) {
      var oldRemark = String(woSheet.getRange(row, 25).getValue() || '').trim();
      woSheet.getRange(row, 25).setValue(oldRemark ? oldRemark + '；' + remark : remark);
    }

    return {
      wo: rowToPWO_(woSheet.getRange(row, 1, 1, PWO_HEADERS.length).getValues()[0],
        yarnLinesForWO_(wo.wo_id)),
      updated_items: updatedItems,
      bom_used: bomUsed,
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/** 新版工作令：待出貨 → 已出貨（出貨單在「出庫出貨」分頁開立） */
function shipProductionOrder_(req) {
  var woId = String(req.wo_id || '').trim();
  if (!woId) throw new Error('缺少 WO_ID');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var woSheet = getSheet_(SHEET_PWO);
    var row = findPWORow_(woSheet, woId);
    if (row === -1) throw new Error('找不到工作令：' + woId);
    var status = String(woSheet.getRange(row, 21).getValue()).trim();
    if (status !== PWO_STATUS_TOSHIP) {
      throw new Error('只有「待出貨」的工作令可以登記出貨，目前：' + status);
    }
    woSheet.getRange(row, 21).setValue(PWO_STATUS_SHIPPED);
    return { wo: rowToPWO_(woSheet.getRange(row, 1, 1, PWO_HEADERS.length).getValues()[0],
      yarnLinesForWO_(woId)) };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}
