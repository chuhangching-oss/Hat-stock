import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

/**
 * 全螢幕相機掃碼元件
 * - 使用 @zxing/browser（ZXing JS），支援 QR Code 與 Code-128 / EAN 等一維條碼
 * - iOS Safari / Android Chrome 皆可呼叫 HTTPS 網站取得後置鏡頭
 * - 若相機不可用，提供「手動輸入」備援
 */
export default function Scanner({ open, onClose, onResult, title = '掃碼' }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    let controls = null;
    setError('');
    setReady(false);

    async function start() {
      try {
        // 優先挑「後置鏡頭」（label 通常含 back / rear / environment）
        let deviceId;
        try {
          const devices = await BrowserMultiFormatReader.listVideoInputDevices();
          const back = devices.find((d) => /back|rear|environment|環境|後置/i.test(d.label));
          deviceId = back ? back.deviceId : undefined;
        } catch (e) {
          /* 列舉失敗就用預設鏡頭 */
        }
        const reader = new BrowserMultiFormatReader({ delayBetweenScanAttempts: 120 });
        controls = await reader.decodeFromVideoDevice(deviceId, videoRef.current, (result) => {
          if (result && !cancelled) {
            cancelled = true; // 只取第一個結果
            const text = String(result.getText ? result.getText() : result).trim();
            if (!text) return;
            try {
              controls && controls.stop();
            } catch (e) {
              /* ignore */
            }
            onResult(text);
          }
        });
        if (!cancelled) setReady(true);
      } catch (e) {
        if (cancelled) return;
        const msg = String(e && e.message ? e.message : e);
        setError(
          /permission|denied|NotAllowed/i.test(msg)
            ? '相機權限被拒絕。請到瀏覽器網站設定允許相機後重試（iOS：設定 ➔ Safari ➔ 相機，或點網址列左側 ᴀᴀ 按鈕）。'
            : `無法開啟相機：${msg}\n請確認網站以 HTTPS 開啟，或改用下方手動輸入。`,
        );
      }
    }

    start();
    return () => {
      cancelled = true;
      try {
        controls && controls.stop();
      } catch (e) {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white">
      {/* 頂部 */}
      <div className="flex items-center justify-between p-4 pt-[calc(1rem+env(safe-area-inset-top))]">
        <button
          onClick={onClose}
          className="min-h-touch flex items-center rounded-full bg-white/10 px-4 text-base font-bold transition active:bg-white/25"
        >
          ✕ 關閉
        </button>
        <span className="text-lg font-extrabold">{title}</span>
        <span className="w-16" />
      </div>

      {/* 相機畫面 + 掃描框 */}
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {/* 掃描瞄準框 */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-64 w-64 rounded-3xl border-2 border-white/70 shadow-[0_0_0_9999rem_rgba(2,6,23,0.55)]">
            <span className="absolute left-3 right-3 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
          </div>
        </div>
        <p className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-base font-bold text-white/90">
          {ready ? '對準條碼 / QR Code（會自動辨識）' : '啟動相機中…'}
        </p>
      </div>

      {/* 錯誤與手動輸入備援 */}
      <div className="bg-slate-900 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
        {error && <p className="mb-2 whitespace-pre-line text-sm font-bold text-red-400">⚠️ {error}</p>}
        <div className="flex gap-2">
          <input
            className="min-h-touch flex-1 rounded-2xl border-2 border-slate-600 bg-slate-800 px-4 text-base font-bold text-white outline-none placeholder:text-slate-500 focus:border-blue-500"
            placeholder="相機無法使用？輸入品名（或系統序號）"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            onClick={() => manual.trim() && onResult(manual.trim())}
            className="min-h-touch rounded-2xl bg-blue-600 px-6 text-base font-extrabold transition active:bg-blue-700 active:scale-95"
          >
            帶入
          </button>
        </div>
      </div>
    </div>
  );
}
