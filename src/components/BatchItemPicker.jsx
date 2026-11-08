import { useMemo, useRef, useState } from 'react';
import { CATEGORY_COLORS } from '../constants';

/**
 * 批次挑選彈窗（Batch Selector Modal）
 * - 搜尋（帽型/品號/顏色）＋ 類別快速篩選（全部/成品/半成品/原料）
 * - 列表：☑ 核取＋品號/帽型＋顏色＋在庫量＋「本次數量」輸入框
 *   * 勾選該列 → 數量框自動啟用並聚焦，可由上往下連續填數量
 *   * 出庫模式（OUT）：無庫存（≤0）品項 disabled；「全選」只選有庫存的列
 *   * 入庫（IN）/盤點（COUNT）模式：無庫存品項【可以勾選】——入庫的品項
 *     本來就可能目前庫存 0；盤點則是要把實際數量填回去
 * - 底部統計：已選 X 款，共 Y 件；【整批帶入明細】一次推入（onPick 回呼）
 *   * 送出前驗證：出庫數量需 >0 且不超過在庫；入庫需 >0；盤點可 ≥0（紅字提示）
 */
export default function BatchItemPicker({ open, mode = 'OUT', items, force = false, showToast, onClose, onPick }) {
  const outOnly = mode === 'OUT'; // 僅出庫需要「不得超過在庫」的限制（補帳模式 force 放行）
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
    const s = String(sel[code] ?? '').trim();
    if (s === '' || !it) return false; // 空白＝還沒填數量
    const q = Number(s);
    if (!isFinite(q)) return false;
    if (mode === 'COUNT') return q >= 0; // 盤點：盤後可為 0
    if (!(q > 0)) return false; // 入庫/出庫：異動量必須 > 0
    return !outOnly || force || q <= (it.stock_qty || 0); // 僅出庫檢查在庫上限（補帳模式放行）
  };
  const validCount = checkedCodes.filter(validQty).length;
  const validQtyTotal = checkedCodes.reduce((s, c) => s + (validQty(c) ? Number(sel[c]) : 0), 0);

  function toggle(code, item) {
    if (outOnly && !force && (item.stock_qty || 0) <= 0) return; // 僅出庫：無庫存不可勾（補帳模式放行）
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

  /** 全選／全取消（出庫模式跳過無庫存的列；入庫/盤點包含無庫存列） */
  function toggleAll() {
    const visibleOk = outOnly && !force ? visible.filter((it) => (it.stock_qty || 0) > 0) : visible;
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
    // ★ 收集「所有已勾選」的品項——不受當前搜尋／分類篩選影響：
    //   跨搜尋勾選（搜A款勾→搜B款勾→整批帶入）不會漏掉先前的勾選
    for (const code of checkedCodes) {
      const it = shownStock.get(code);
      if (!it) continue; // 品項已被清單更新移除（理論上不發生）
      const s = String(sel[code] ?? '').trim();
      if (s === '') continue;
      const q = Number(s);
      if (!isFinite(q)) continue;
      if (mode === 'COUNT') {
        if (q < 0) {
          return showToast(`❌ ${it.item_name}${it.color_spec ? `（${it.color_spec}）` : ''} 盤後數量不可為負數`, 'error');
        }
      } else {
        if (!(q > 0)) continue;
        if (outOnly && !force && q > (it.stock_qty || 0)) {
          return showToast(
            `❌ ${it.item_name}${it.color_spec ? `（${it.color_spec}）` : ''} 數量 ${q} 超過在庫 ${it.stock_qty}，請修正`,
            'error',
          );
        }
      }
      list.push({ item: it, qty: q });
    }
    const invalid = checkedCodes.length - validCount;
    if (list.length === 0) {
      return showToast(
        checkedCodes.length === 0
          ? '❌ 請先勾選品項'
          : `⚠️ 尚有勾選品項未填${mode === 'COUNT' ? '盤後' : ''}數量（已略過未填的列）`,
        'error',
      );
    }
    if (invalid > 0) {
      showToast(`⚠️ ${invalid} 款未填／填錯數量，已自動略過，帶入其餘 ${list.length} 款`);
    }
    // ✅ 整批帶入成功 → 清空預選清單（勾選／數量／搜尋字／類別篩選），
    //    讓下一次打開是乾淨的選單；驗證失敗（上方提前 return）不會清，可修正後重送
    setSel({});
    setFilter('');
    setCategory('全部');
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
          {mode !== 'OUT' && (
            <p className="px-1 text-[10px] font-extrabold text-emerald-600">
              {mode === 'IN'
                ? '📥 入庫模式：無庫存（0）的品項也可以勾選入庫'
                : '🧮 盤點模式：全部品項可勾選，盤後數量可填 0'}
            </p>
          )}
          {outOnly && force && (
            <p className="px-1 text-[10px] font-extrabold text-amber-600">
              🩹 補帳模式：無庫存／超庫存的品項也可以勾選送出（會以負庫存落帳，備註標「⚠️負庫存待盤」）
            </p>
          )}
        </div>

        {/* 品項勾選清單 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
          <ul className="divide-y divide-slate-100">
            {visible.map((it) => {
              const checked = sel[it.item_code] !== undefined;
              const noStock = (it.stock_qty || 0) <= 0;
              const q = checked ? Number(sel[it.item_code]) : NaN;
              const over = outOnly && checked && isFinite(q) && q > (it.stock_qty || 0);
              const locked = outOnly && !force && noStock;
              return (
                <li
                  key={it.item_code}
                  className={`flex items-start gap-2.5 py-2.5 ${locked ? 'opacity-40' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => toggle(it.item_code, it)}
                    className="mt-1.5 h-6 w-6 shrink-0 accent-blue-700"
                  />
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => !locked && toggle(it.item_code, it)}
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
                      {noStock && `（${mode === 'COUNT' ? '帳面 0，可填盤後數' : mode === 'IN' ? '可入庫' : '無庫存'}）`}
                    </span>
                    {over && (
                      <span className="block text-[10px] font-extrabold text-amber-600">
                        超庫存 {force ? '→ 補帳以負庫存送出' : '→ 不可送出'}
                      </span>
                    )}
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
                        // Enter（桌機／掃描器）只在「全部勾選列都已填好數量」時才整批帶入，
                        // 避免鍵到一半按 Enter 造成只帶入部分品項
                        if (e.key !== 'Enter') return;
                        if (checkedCodes.length === 0) return;
                        if (validCount < checkedCodes.length) {
                          showToast(`⚠️ 尚有 ${checkedCodes.length - validCount} 款未填／超庫存，先補齊再按 Enter 整批帶入`, 'error');
                          return;
                        }
                        handleImport();
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
                  （{checkedCodes.length - validCount} 款未填{outOnly ? '／超庫存' : ''}）
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
            整批帶入{mode === 'IN' ? '入庫' : mode === 'COUNT' ? '盤點' : '出庫'}明細（{validCount} 款 / {validQtyTotal} 件）
          </button>
        </div>
      </div>
    </div>
  );
}
