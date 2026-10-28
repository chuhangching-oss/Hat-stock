/**
 * 二次確認彈窗（行動端採用「底部抽屜」式排版，方便單手確認）
 */
export default function ConfirmDialog({
  open,
  title = '請確認以下內容',
  confirmText = '確認送出',
  busy = false,
  danger = false,
  children,
  onClose,
  onConfirm,
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-md rounded-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:pb-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-extrabold">{title}</h3>
          <button className="text-slate-400" onClick={() => !busy && onClose()}>
            ✕
          </button>
        </div>

        {children}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            disabled={busy}
            onClick={onClose}
            className="min-h-touch rounded-2xl bg-slate-100 text-lg font-bold text-slate-600 transition active:bg-slate-200 disabled:opacity-50"
          >
            取消
          </button>
          <button
            disabled={busy}
            onClick={onConfirm}
            className={`min-h-touch flex items-center justify-center gap-2 rounded-2xl text-lg font-extrabold text-white transition active:scale-95 disabled:opacity-60 ${
              danger ? 'bg-red-600 active:bg-red-700' : 'bg-emerald-600 active:bg-emerald-700'
            }`}
          >
            {busy && <span className="animate-spin">⟳</span>}
            {busy ? '送出中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
