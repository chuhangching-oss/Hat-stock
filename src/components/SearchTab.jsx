import { useMemo } from 'react';
import { CATEGORY_COLORS, LOW_STOCK_THRESHOLD } from '../constants';
import { getGasUrl } from '../api';
import PhotoButton from './PhotoButton';

function isLowStock(item) {
  return Number(item.stock_qty) <= LOW_STOCK_THRESHOLD;
}

/** 今天（本地時區）的 YYYY-MM-DD（比對工作令到期日用） */
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 分頁 1：快速庫存查詢
 * - 頂部搜尋列（料號/帽型/顏色 模糊篩選）
 * - 相機掃描按鈕（掃條碼 / QR Code 帶入品號）
 * - 卡片式清單，庫存 <= 10 紅色警示
 */
export default function SearchTab({
  items,
  loading,
  error,
  query,
  setQuery,
  dueWos = [],
  goToWorkOrders,
  onOpenScanner,
  goToSettings,
  onPhotoUploaded,
  showToast,
}) {
  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return items;
    return items.filter((it) => {
      const hay = [
        it.item_code,
        it.item_name,
        it.category,
        it.color_spec,
        it.location,
      ]
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [items, query]);

  if (!getGasUrl()) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-5xl">⚙️</div>
        <h2 className="mt-4 text-xl font-extrabold">尚未設定雲端 API</h2>
        <p className="mt-2 text-slate-500">
          請先到「設定」分頁，貼上 Google Apps Script Web App 網址後即可同步庫存。
        </p>
        <button className="btn-primary mt-6" onClick={goToSettings}>
          前往設定
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* ===== 今日到期／逾期待確認工單（醒目警示，點擊前往工單管理） ===== */}
      {dueWos.length > 0 && (
        <button
          onClick={goToWorkOrders}
          className="mb-3 w-full rounded-3xl border-2 border-red-300 bg-red-50 p-4 text-left shadow-card transition active:bg-red-100 active:scale-[0.99]"
        >
          <div className="flex items-center justify-between">
            <span className="text-base font-extrabold text-red-600">
              ⏰ 到期待確認工單 {dueWos.length} 張
            </span>
            <span className="text-xs font-bold text-red-400">前往處理 ›</span>
          </div>
          <ul className="mt-2 space-y-1">
            {dueWos.slice(0, 3).map((w) => (
              <li
                key={w.wo_id}
                className="flex items-baseline justify-between gap-2 text-sm font-semibold text-slate-700"
              >
                <span className="truncate">
                  <span className="font-mono text-xs text-slate-400">{w.wo_id}</span> <b>{w.style_no}</b>
                  <span className="ml-1 text-slate-400">×{w.plan_qty}</span>
                </span>
                <span className={w.due_date < todayYMD() ? 'shrink-0 text-red-600' : 'shrink-0 text-amber-600'}>
                  {w.due_date === todayYMD() ? '今日' : '逾期'} {w.due_date}
                </span>
              </li>
            ))}
          </ul>
          {dueWos.length > 3 && (
            <p className="mt-1 text-xs font-bold text-red-400">還有 {dueWos.length - 3} 張…</p>
          )}
        </button>
      )}

      {/* 搜尋列 + 掃碼按鈕（規格確認後啟用）+ 款式照片上傳 */}
      <div className="flex gap-2">
        <input
          className="field-input flex-1"
          type="search"
          inputMode="search"
          placeholder="搜尋：帽型 / 顏色…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          onClick={onOpenScanner}
          aria-label="相機掃描條碼"
          className="flex w-16 shrink-0 flex-col items-center justify-center rounded-2xl bg-blue-700 text-white shadow-card transition active:bg-blue-800 active:scale-95"
        >
          <span className="text-2xl leading-none">📷</span>
          <span className="mt-0.5 text-[10px] font-bold">掃碼</span>
        </button>
        <PhotoButton
          items={items}
          requirePick
          onUploaded={onPhotoUploaded}
          showToast={showToast}
        />
      </div>
      {query && (
        <div className="mt-2 flex items-center justify-between px-1 text-sm">
          <span className="text-slate-500">
            「{query}」共 <b className="text-blue-700">{filtered.length}</b> 筆
          </span>
          <button className="font-bold text-blue-700" onClick={() => setQuery('')}>
            清除
          </button>
        </div>
      )}

      {/* 狀態提示 */}
      {error && (
        <div className="mt-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-600">⚠️ {error}</div>
      )}
      {loading && (
        <div className="mt-4 animate-pulse rounded-2xl bg-blue-50 p-4 text-center text-sm font-bold text-blue-600">
          同步雲端庫存中…
        </div>
      )}
      {!loading && items.length > 0 && filtered.length === 0 && (
        <div className="mt-8 text-center text-slate-400">
          <div className="text-4xl">🔎</div>
          <p className="mt-2 font-bold">找不到符合的料件</p>
        </div>
      )}
      {!loading && items.length === 0 && !error && (
        <div className="mt-8 text-center text-slate-400">
          <div className="text-4xl">🗃️</div>
          <p className="mt-2 font-bold">雲端尚無料件資料</p>
          <p className="mt-1 text-xs">請在 Google 試算表 INVENTORY_MASTER 中建立料件（或執行 GAS 的 seedDemoData）</p>
        </div>
      )}

      {/* 卡片式庫存清單 */}
      <div className="mt-4 space-y-3">
        {filtered.map((it) => {
          const low = isLowStock(it);
          const catCls = CATEGORY_COLORS[it.category] || 'bg-slate-100 text-slate-600';
          return (
            <div
              key={it.item_code}
              className={`rounded-3xl bg-white p-4 shadow-card ${low ? 'border-2 border-red-400' : 'border border-slate-100'}`}
            >
              {/* 款式照片（若有上傳） */}
              {it.photo_url && (
                <a href={it.photo_url} target="_blank" rel="noreferrer">
                  <img
                    src={it.photo_url}
                    alt={`款式照片 ${it.item_code}`}
                    loading="lazy"
                    className="mb-3 h-44 w-full rounded-2xl border border-slate-100 object-cover"
                  />
                </a>
              )}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${catCls}`}>
                      {it.category || '未分類'}
                    </span>
                    {low && (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                        低庫存
                      </span>
                    )}
                  </div>
                  <h3 className="mt-1.5 text-lg font-extrabold leading-snug text-slate-900">
                    {it.item_name || '（未命名帽型）'}
                  </h3>
                  {it.color_spec && <p className="mt-1 text-sm text-slate-600">{it.color_spec}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={`text-4xl font-black leading-none tabular-nums ${
                      low ? 'text-red-600' : 'text-slate-900'
                    }`}
                  >
                    {it.stock_qty}
                    {Number(it.stock_qty) < 0 && <span className="ml-0.5 text-sm">負庫存!</span>}
                  </div>
                  <div className="mt-1 text-xs font-bold text-slate-400">{it.unit}</div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-dashed border-slate-100 pt-2 text-sm">
                <span className="font-semibold text-slate-700">📍 儲位：{it.location || '未指定'}</span>
                <span className="text-xs text-slate-400">更新：{it.last_updated}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
