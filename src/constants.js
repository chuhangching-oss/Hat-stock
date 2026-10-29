// ===== 全域常數 =====

// 庫存量低於此值時在查詢頁顯示紅色警示
export const LOW_STOCK_THRESHOLD = 10;

// 類別標籤顏色
export const CATEGORY_COLORS = {
  原料: 'bg-amber-100 text-amber-700',
  半成品: 'bg-sky-100 text-sky-700',
  成品: 'bg-violet-100 text-violet-700',
};

// 工作令狀態標籤顏色（WORK_ORDERS.Status）
export const WO_STATUS_COLORS = {
  生產中: 'bg-blue-100 text-blue-700',
  待確認: 'bg-amber-100 text-amber-700',
  待出貨: 'bg-orange-100 text-orange-700',
  已入庫: 'bg-emerald-100 text-emerald-700',
  已出貨: 'bg-slate-200 text-slate-500',
};
