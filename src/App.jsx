import { useCallback, useEffect, useState } from 'react';
import useInventory from './hooks/useInventory';
import SearchTab from './components/SearchTab';
import ActionTab from './components/ActionTab';
import SettingsTab from './components/SettingsTab';
import Scanner from './components/Scanner';
import Toast from './components/Toast';
const TABS = [
  { key: 'search', label: '庫存查詢', icon: '🔍' },
  { key: 'action', label: '出入庫', icon: '📦' },
  { key: 'settings', label: '設定', icon: '⚙️' },
];

export default function App() {
  const inventory = useInventory();
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState(''); // 查詢頁搜尋字
  const [toast, setToast] = useState(null); // { type: 'success'|'error', msg }

  // 掃碼狀態：scanFor 決定把掃到的品號帶到哪個分頁
  const [scanFor, setScanFor] = useState(null); // 'search' | 'action'
  const [scanResult, setScanResult] = useState(null); // { code, seq }

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type, seq: Date.now() });
  }, []);

  const openScanner = useCallback((target) => setScanFor(target), []);
  const closeScanner = useCallback(() => setScanFor(null), []);

  const handleScanResult = useCallback(
    (code) => {
      if (!code) return;
      setScanResult({ code, seq: Date.now() });
      setScanFor(null); // 關閉相機
      if (scanFor === 'search') setTab('search');
      if (scanFor === 'action') setTab('action');
      showToast(`已掃描：${code}`);
    },
    [scanFor, showToast],
  );

  // 款式照片上傳成功 → 立刻更新該品號（卡片會出現縮圖）
  const handlePhotoUploaded = useCallback(
    (result) => {
      if (result && result.item) inventory.applyItem(result.item);
    },
    [inventory],
  );

  // 出入庫送出（ActionTab 呼叫）
  const handleSubmitLog = useCallback(
    async (payload) => {
      try {
        const res = await inventory.submitLog(payload);
        const it = res.item;
        showToast(
          `✅ ${payload.type}成功：${it.item_code} → 目前庫存 ${it.stock_qty} ${it.unit}`,
          'success',
        );
        return res;
      } catch (e) {
        showToast(`❌ 送出失敗：${e.message}`, 'error');
        throw e; // 拋回讓 ActionTab 保持彈窗、顯示錯誤
      }
    },
    [inventory, showToast],
  );

  return (
    <div className="flex h-full flex-col bg-slate-100">
      {/* ===== 頂部標題列 ===== */}
      <header className="shrink-0 bg-blue-700 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 text-white">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-extrabold tracking-wide">🧶 帽廠庫存管家</h1>
          <button
            onClick={() => inventory.refresh()}
            className="min-h-touch flex items-center gap-1 rounded-xl bg-white/10 px-3 text-sm font-bold text-white transition active:bg-white/20"
          >
            <span className={inventory.loading ? 'animate-spin' : ''}>⟳</span> 同步
          </button>
        </div>
        <p className="mt-1 text-xs text-blue-200">
          {inventory.lastSync
            ? `最後同步：${inventory.lastSync.toLocaleTimeString('zh-TW')} · 共 ${inventory.items.length} 筆料件`
            : '尚未同步雲端庫存（請先到「設定」填 API 網址）'}
        </p>
      </header>

      {/* ===== 內容區 ===== */}
      <main className="flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-28">
        {tab === 'search' && (
          <SearchTab
            items={inventory.items}
            loading={inventory.loading}
            error={inventory.error}
            query={query}
            setQuery={setQuery}
            onOpenScanner={() => openScanner('search')}
            goToSettings={() => setTab('settings')}
            onPhotoUploaded={handlePhotoUploaded}
            showToast={showToast}
          />
        )}
        {tab === 'action' && (
          <ActionTab
            items={inventory.items}
            onSubmit={handleSubmitLog}
            onOpenScanner={() => openScanner('action')}
            scanResult={scanFor === null ? scanResult : null} // 掃碼結束才套用，避免重複觸發
            showToast={showToast}
            onPhotoUploaded={handlePhotoUploaded}
          />
        )}
        {tab === 'settings' && (
          <SettingsTab
            showToast={showToast}
            onSaved={() => inventory.refresh()}
          />
        )}
      </main>

      {/* ===== 底部分頁導覽（大按鈕、好戴手套點擊） ===== */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-lg justify-around pb-[env(safe-area-inset-bottom)]">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex min-h-touch w-1/3 flex-col items-center justify-center py-2 text-xs font-bold transition ${
                tab === t.key ? 'text-blue-700' : 'text-slate-400'
              }`}
            >
              <span className="mb-0.5 text-2xl leading-none">{t.icon}</span>
              {t.label}
              {tab === t.key && <span className="mt-0.5 h-1 w-6 rounded-full bg-blue-700" />}
            </button>
          ))}
        </div>
      </nav>

      {/* ===== 相機掃碼（全螢幕覆蓋層） ===== */}
      {scanFor && (
        <Scanner
          open
          onClose={closeScanner}
          onResult={handleScanResult}
          title={scanFor === 'search' ? '掃碼查庫存' : '掃碼填入品號'}
        />
      )}

      {/* ===== Toast 提示 ===== */}
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
