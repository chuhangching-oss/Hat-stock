import { useRef, useState } from 'react';
import { uploadItemPhoto } from '../photo';

/**
 * 「🖼 上傳款式照片」按鈕
 * - requirePick = true（查詢分頁）：先彈清單選料件，再選照片上傳
 * - requirePick = false（出入庫分頁）：直接使用已選定的料件（prop `item`）
 * 照片由後端存進 Google Drive「帽廠庫存_款式照片」，連結寫入 Photo_URL 欄。
 */
export default function PhotoButton({ items, item = null, requirePick = false, onUploaded, showToast }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  const [pendingCode, setPendingCode] = useState('');

  function openInput(code) {
    setPendingCode(code);
    // 等 modal 收起來再開檔案選擇器（iOS 需要一點延遲）
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.value = '';
        inputRef.current.click();
      }
    }, 240);
  }

  function handleClick() {
    if (busy) return;
    if (requirePick) {
      setFilter('');
      setPicking(true);
      return;
    }
    if (!item) {
      showToast('❌ 請先選取料件，再上傳照片', 'error');
      return;
    }
    openInput(item.item_code);
  }

  async function handleChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true);
    try {
      const result = await uploadItemPhoto(pendingCode, file);
      showToast(`✅ 款式照片已上傳並登錄`);
      onUploaded && onUploaded(result);
    } catch (err) {
      showToast(`❌ 上傳失敗：${err.message}`, 'error');
    } finally {
      setBusy(false);
      setPendingCode('');
    }
  }

  const filteredPicker = items.filter((it) => {
    const f = filter.trim().toLowerCase();
    if (!f) return true;
    return `${it.item_name} ${it.color_spec} ${it.category}`.toLowerCase().includes(f);
  });

  return (
    <>
      <button
        onClick={handleClick}
        aria-label="上傳款式照片"
        className="flex w-16 shrink-0 flex-col items-center justify-center rounded-2xl bg-violet-600 text-white transition active:bg-violet-700 active:scale-95"
      >
        <span className={`text-2xl leading-none ${busy ? 'animate-pulse' : ''}`}>{busy ? '⏳' : '🖼️'}</span>
        <span className="mt-0.5 text-[10px] font-bold">{busy ? '上傳中' : '照片'}</span>
      </button>

      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} />

      {/* 查詢分頁用：先挑料件 */}
      {picking && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setPicking(false)}
        >
          <div
            className="max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">替哪個料件上傳照片？</h3>
              <button className="text-slate-400" onClick={() => setPicking(false)}>✕</button>
            </div>
            <input
              className="field-input mb-3"
              placeholder="搜尋：帽型 / 顏色…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <ul className="space-y-2">
              {filteredPicker.slice(0, 200).map((it) => (
                <li key={it.item_code}>
                  <button
                    onClick={() => {
                      setPicking(false);
                      openInput(it.item_code);
                    }}
                    className="w-full rounded-2xl bg-slate-50 p-3 text-left text-sm font-semibold text-slate-800 transition active:bg-violet-100"
                  >
                    <b>{it.item_name}</b>
                    {it.color_spec && <span className="text-slate-400">（{it.color_spec}）</span>}
                    {it.photo_url && <span className="float-right text-xs text-violet-600">已有照片 ✓</span>}
                  </button>
                </li>
              ))}
            </ul>
            {filteredPicker.length > 200 && (
              <p className="mt-2 text-center text-xs text-slate-400">
                只顯示前 200 筆，請用上方搜尋縮小範圍
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
