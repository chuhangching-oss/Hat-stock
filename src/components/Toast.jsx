import { useEffect, useRef } from 'react';

/**
 * 全域 Toast 訊息（成功 / 失敗），自動消失
 */
export default function Toast({ toast, onDone }) {
  const timer = useRef(null);

  useEffect(() => {
    if (!toast) return undefined;
    timer.current = setTimeout(() => onDone(), 3200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, onDone]);

  if (!toast) return null;
  return (
    <div
      key={toast.seq}
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-6 transition"
    >
      <div
        className={`max-w-md rounded-2xl px-5 py-3 text-center text-sm font-bold text-white shadow-xl ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'
        }`}
      >
        {toast.msg}
      </div>
    </div>
  );
}
