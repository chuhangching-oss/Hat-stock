import { useMemo, useRef, useState } from 'react';
import { CATEGORY_COLORS } from '../constants';

/**
 * 批次挑選彈窗（Batch Selector Modal）
 * - 搜尋（帽型/品號/顏色）＋ 類別快速篩選（全部/成品/半成品/原料）
 * - 列表：☑ 核取＋品號/帽型＋顏色＋在庫量＋「本次數量」輸入框
 *   * 勾選該列 → 數量框自動啟用並聚焦，可由上往下連續填數量
 *   * 無庫存（≤0）品項 disabled；「全選」只選有庫存的列
 * - 底部統計：已選 X 款，共 Y 件；【整批帶入出庫明細】一次推入（onPick 回呼）
 *   * 送出前驗證：勾選列數量都必須 >0 且不超過在庫（紅字提示、阻擋送出）
 */
export default function BatchItemPicker({ open, items, showToast, onClose, onPick }) {
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('全部');
  const [sel, setSel] = useState({}); // { item_code: 'qty 字串' }
  const qtyRefs = useRef({});

  const categories = useMemo(() => {
    const set = new Set();
    items.forEach((it) => {
      if (it.category) set.add(it.category);
    });
    return ['全部', ...[...set]];
  }, [items]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== '全部' && it.category !== category) return false;
      if (!f) return true;
      return `${it.item_code} ${it.item_name} ${it.color_spec} ${it.category}`
        .toLowerCase()
        .includes(f);
    });
  }, [items, filter, category]);

  const visible = filtered.slice(0, 300);

  /** 勾選統計與驗證 */
  const checkedCodes = Object.keys(sel).filter((c) => sel[c] !== undefined);
  const shownStock = useMemo(
    () => new Map(items.map((it) => [it.item_code, it])),
    [items],
  );
  const validQty = (code) => {
    const it = shownStock.get(code);
    const q = Number(sel[code]);
    return !!it && isFinite(q) && q > 0 && q <= (it.stock_qty || 0);
  };
  const validCount = checkedCodes.filter(validQty).length;
  const validQtyTotal = checkedCodes.reduce((s, c) => s + (validQty(c) ? Number(sel[c]) : 0), 0);

  function toggle(code, item) {
    if ((item.stock_qty || 0) <= 0) return; // 無庫存不可勾
    setSel((prev) => {
      const next = { ...prev };
      if (next[code] !== undefined) {
        delete next[code];
      } else {
        next[code] = '';
      }
      return next;
    });
    // 勾選後：數量框自動啟用並聚焦
    setTimeout(() => qtyRefs.current[code] && qtyRefs.current[code].focus(), 30);
  }

  /** 全選／全取消（無庫存的列不勾） */
  function toggleAll() {
    const visibleOk = visible.filter((it) => (it.stock_qty || 0) > 0);
    const allChecked =
      visibleOk.length > 0 && visibleOk.every((it) => sel[it.item_code] !== undefined);
    setSel((prev) => {
      const next = { ...prev };
      if (allChecked) {
        visibleOk.forEach((it) => delete next[it.item_code]);
      } else {
        visibleOk.forEach((it) => {
          if (next[it.item_code] === undefined) next[it.item_code] = '';
        });
      }
      return next;
    });
  }

  function handleImport() {
    const list = [];
    for (const it of filtered) {
      if (sel[it.item_code] === undefined) continue;
      const q = Number(sel[it.item_code]);
      if (!(q > 0)) continue;
      if (q > (it.stock_qty || 0)) {
        return showToast(
          `❌ ${it.item_name}${it.color_spec ? `（${it.color_spec}）` : ''} 數量 ${q} 超過在庫 ${it.stock_qty}，請修正`,
          'error',
        );
      }
      list.push({ item: it, qty: q });
    }
    const invalid = checkedCodes.length - validCount;
    if (list.length === 0) {
      return showToast(
        checkedCodes.length === 0
          ? '❌ 請先勾選品項'
          : '⚠️ 尚有勾選品項未填數量（已略過未填的列）',
        'error',
      );
    }
    if (invalid > 0) {
      showToast(`⚠️ ${invalid} 款未填／填錯數量，已自動略過，帶入其餘 ${list.length} 款`);
    }
    onPick(list);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-3xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 標題 */}
        <div className="flex items-center justify-between border-b border-slate-100 p-4 pb-3">
          <h3 className="text-lg font-extrabold">📦 批次挑選品項</h3>
          <button className="text-slate-400" onClick={onClose}>✕</button>
        </div>

        {/* 搜尋 + 類別篩選 */}
        <div className="space-y-2 p-4 pb-2">
          <input
            className="field-input"
            placeholder="搜尋：帽型 / 品號 / 顏色（例：MONET、GRAY）"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-extrabold transition active:scale-95 ${
                  category === c
                    ? 'bg-blue-700 text-white shadow-card'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between px-1 text-xs font-bold text-slate-400">
            <span>
              {filtered.length} 筆{filtered.length > 300 && '（顯示前 300 筆，請用搜尋縮小）'}
            </span>
            <button
              onClick={toggleAll}
              className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-extrabold text-blue-700 transition active:bg-slate-200 active:scale-95"
            >
              ☑️ 全選
            </button>
          </div>
        </div>

        {/* 品項勾選清單 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
          <ul className="divide-y divide-slate-100">
            {visible.map((it) => {
              const checked = sel[it.item_code] !== undefined;
              const noStock = (it.stock_qty || 0) <= 0;
              const q = checked ? Number(sel[it.item_code]) : NaN;
              const over = checked && isFinite(q) && q > (it.stock_qty || 0);
              return (
                <li
                  key={it.item_code}
                  className={`flex items-start gap-2.5 py-2.5 ${noStock ? 'opacity-40' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={noStock}
                    onChange={() => toggle(it.item_code, it)}
                    className="mt-1.5 h-6 w-6 shrink-0 accent-blue-700"
                  />
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => !noStock && toggle(it.item_code, it)}
                  >
                    <span
                      className={`mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                        CATEGORY_COLORS[it.category] || 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {it.category || '未分類'}
                    </span>
                    <b className="text-[15px] text-slate-900">{it.item_name}</b>
                    {it.color_spec && <span className="text-slate-500">（{it.color_spec}）</span>}
                    <span className="block font-mono text-[11px] text-slate-400">{it.item_code}</span>
                    <span className={`text-xs font-bold ${it.stock_qty <= 10 ? 'text-red-600' : 'text-slate-600'}`}>
                      在庫 <b className="tabular-nums">{it.stock_qty}</b> {it.unit}
                      {noStock && '（無庫存）'}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      ref={(el) => (qtyRefs.current[it.item_code] = el)}
                      disabled={!checked}
                      className={`h-11 w-20 rounded-xl px-2 text-right font-black tabular-nums transition ${
                        checked
                          ? over
                            ? 'border-2 border-red-400 text-red-600'
                            : 'border-2 border-blue-600 text-blue-700'
                          : 'border border-slate-200 bg-slate-100 text-slate-300'
                      }`}
                      type="number"
                      inputMode="decimal"
                      step="1"
                      min="0"
                      placeholder="0"
                      value={checked ? sel[it.item_code] : ''}
                      onChange={(e) =>
                        setSel((prev) => ({ ...prev, [it.item_code]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleImport();
                      }}
                    />
                  </div>
                </li>
              );
            })}
            {visible.length === 0 && (
              <li className="p-6 text-center text-sm font-bold text-slate-400">
                找不到符合的品項
              </li>
            )}
          </ul>
        </div>

        {/* 底部統計＋整批帶入 */}
        <div className="border-t border-slate-100 p-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mb-2 flex items-baseline justify-between px-1 text-sm font-extrabold">
            <span className="text-slate-700">
              已選 <b className="text-lg text-blue-700">{validCount}</b> 款
              {checkedCodes.length > validCount && (
                <span className="ml-1 text-xs font-bold text-red-500">
                  （{checkedCodes.length - validCount} 款未填／超庫存）
                </span>
              )}
            </span>
            <span className="text-slate-700">
              共 <b className="text-lg text-blue-700">{validQtyTotal}</b> 件
            </span>
          </div>
          <button
            className={`btn-primary ${validCount === 0 ? 'opacity-40' : ''}`}
            onClick={handleImport}
            disabled={validCount === 0}
          >
            整批帶入出庫明細（{validCount} 款 / {validQtyTotal} 件）
          </button>
        </div>
      </div>
    </div>
  );
}
