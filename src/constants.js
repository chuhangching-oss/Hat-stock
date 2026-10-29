// ===== 全域常數 =====

// 庫存量低於此值時在查詢頁顯示紅色警示
export const LOW_STOCK_THRESHOLD = 10;

// 類別標籤顏色
export const CATEGORY_COLORS = {
  原料: 'bg-amber-100 text-amber-700',
  半成品: 'bg-sky-100 text-sky-700',
  成品: 'bg-violet-100 text-violet-700',
};

// ===== 數位圖鑑（Lookbook） =====

// 帽型分類（Style_Category 欄候選值；最後一個「其他」可當空白時的歸類）
export const STYLE_CATEGORIES = [
  'Fedora 紳士帽',
  'Casquette 報童帽',
  'Beret 貝雷帽',
  'Cap 棒球帽',
  'Boonie 邊帽',
  'Bucket 漁夫帽',
  'Beanie 毛帽',
  '其他',
];

// 季節分類（Season 欄候選值）
export const SEASONS = ['SS', 'AW', '四季'];

// 季節標籤顏色（圖鑑卡片徽章）
export const SEASON_COLORS = {
  SS: 'bg-amber-200 text-amber-800', // 春夏
  AW: 'bg-indigo-200 text-indigo-800', // 秋冬
  四季: 'bg-emerald-200 text-emerald-800',
};

// 工作令狀態標籤顏色（WORK_ORDERS.Status）
export const WO_STATUS_COLORS = {
  生產中: 'bg-blue-100 text-blue-700',
  待確認: 'bg-amber-100 text-amber-700',
  待出貨: 'bg-orange-100 text-orange-700',
  已入庫: 'bg-emerald-100 text-emerald-700',
  已出貨: 'bg-slate-200 text-slate-500',
};
