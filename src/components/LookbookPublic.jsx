import { useEffect, useMemo, useState } from 'react';
import {
  ColorChips,
  HatImage,
  StyleBadges,
  filterGroups,
  seasonOf,
} from './LookbookShared';
import { SEASONS, STYLE_CATEGORIES } from '../constants';

const CAT_TAGS = ['全部', ...STYLE_CATEGORIES];
const SEASON_TAGS = ['全部', ...SEASONS];

/**
 * 🌍 客戶分享頁（訪客模式，純展示）
 * - 路由：App 網址後加 #/lookbook（內部圖鑑分頁的「🔗 客戶分享連結」按鈕會產生完整連結）
 *   連結格式：<app網址>#/lookbook?api=<Apps Script exec 網址編碼>
 * - 資料：GET ?action=public_lookbook（免存取碼；後端已過濾庫存/內部欄位、
 *   僅回 Is_Public=Y 款式）
 * - 無內部操作按鈕、無庫存數字；可篩選帽型/季節、搜尋款號、點卡片放大
 */
export default function LookbookPublic() {
  const [rows, setRows] = useState(null); // null = 載入中
  const [error, setError] = useState('');
  const [category, setCategory] = useState('全部');
  const [season, setSeason] = useState('全部');
  const [keyword, setKeyword] = useState('');
  const [active, setActive] = useState(null);

  // 從 hash 解析 API 網址（內部分享連結會帶 ?api=…）；無則用本機設定值
  const apiUrl = useMemo(() => {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx !== -1) {
      const params = new URLSearchParams(hash.slice(qIdx + 1));
      const api = (params.get('api') || '').trim();
      if (api) return api;
    }
    return localStorage.getItem('kfi_gas_url') || '';
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${apiUrl}?action=public_lookbook`, { redirect: 'follow' })
      .then((res) => res.json())
      .then((json) => {
        if (!alive) return;
        if (json && json.ok) setRows(json.data);
        else setError((json && json.error) || 'API 回應格式錯誤');
      })
      .catch(() => {
        if (alive) setError('無法載入圖鑑（連線失敗）');
      });
    return () => {
      alive = false;
    };
  }, [apiUrl]);

  const groups = useMemo(() => rows || [], [rows]);
  const filtered = useMemo(
    () =>
      groups.filter((g) => {
        if (category !== '全部' && (g.style_category || '其他') !== category) return false;
        if (season !== '全部' && seasonOf(g.season) !== season) return false;
        const f = keyword.trim().toLowerCase();
        if (!f) return true;
        return `${g.style_no} ${g.style_category} ${(g.colors || []).join(' ')}`
          .toLowerCase()
          .includes(f);
      }),
    [groups, category, season, keyword],
  );

  const cats = useMemo(() => {
    // 只顯示打開的帽型分類
    const set = [];
    groups.forEach((g) => {
      const c = g.style_category || '其他';
      if (!set.includes(c)) set.push(c);
    });
    return [...set].sort();
  }, [groups]);

  return (
    <div className="min-h-full bg-slate-100 pb-10">
      {/* ===== 頂部 Header（品牌展示風格） ===== */}
      <header className="bg-gradient-to-br from-slate-800 to-slate-900 px-5 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-5 text-white">
        <h1 className="text-2xl font-extrabold tracking-wide">🧢 款式圖鑑</h1>
        <p className="mt-1 text-xs text-slate-300">
          Knit Hat Lookbook · 瀏覽款式，點選有興趣的帽型與顏色，歡迎聯絡我們報價試單
        </p>
      </header>

      <div className="mx-auto max-w-lg space-y-3 px-4 pt-4">
        {/* ===== 篩選器 ===== */}
        <div className="space-y-2 rounded-3xl bg-white p-4 shadow-card">
          <input
            className="field-input"
            placeholder="搜尋款號 / 顏色（例：1177W、GRAY）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {/* 帽型分類 tags */}
          <div className="flex flex-wrap gap-1.5">
            <span className="pt-1.5 text-[10px] font-extrabold text-slate-400">帽型</span>
            {['全部', ...cats].map((t) => (
              <button
                key={t}
                onClick={() => setCategory(t)}
                className={`rounded-full px-2.5 py-1 text-xs font-extrabold transition active:scale-95 ${
                  category === t ? 'bg-slate-800 text-white shadow-card' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          {/* 季節 tags */}
          <div className="flex flex-wrap gap-1.5">
            <span className="pt-1.5 text-[10px] font-extrabold text-slate-400">季節</span>
            {SEASON_TAGS.map((t) => (
              <button
                key={t}
                onClick={() => setSeason(t)}
                className={`rounded-full px-2.5 py-1 text-xs font-extrabold transition active:scale-95 ${
                  season === t ? 'bg-slate-800 text-white shadow-card' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="px-1 text-[10px] font-bold text-slate-400">共 {filtered.length} 款</p>
        </div>

        {/* ===== 狀態 ===== */}
        {rows === null && !error && (
          <div className="rounded-3xl bg-white p-8 text-center shadow-card">
            <p className="animate-pulse font-bold text-slate-400">⏳ 圖鑑載入中…</p>
          </div>
        )}
        {error && (
          <div className="rounded-3xl bg-white p-8 text-center shadow-card">
            <div className="text-5xl">🌐</div>
            <p className="mt-3 font-bold text-slate-600">{error}</p>
            <p className="mt-1 text-xs text-slate-400">請確認連結是否完整，或聯絡業務重新提供</p>
          </div>
        )}

        {/* ===== 卡片 Grid ===== */}
        {filtered.map((g, i) => (
          <button
            key={`${g.style_no}-${i}`}
            onClick={() => setActive(g)}
            className="w-full overflow-hidden rounded-3xl bg-white text-left shadow-card ring-1 ring-slate-100 transition active:scale-[0.99]"
          >
            <HatImage
              src={g.image_url}
              alt={`款式 ${g.style_no}`}
              className="h-56 w-full object-cover"
            />
            <div className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-extrabold text-slate-900">{g.style_no}</h3>
                {/* 徽章（訪客版不顯示公開狀態） */}
                <div className="shrink-0">
                  <BadgeOnly group={g} />
                </div>
              </div>
              <ColorChips colors={g.colors || []} />
            </div>
          </button>
        ))}
        {rows !== null && !error && filtered.length === 0 && (
          <div className="rounded-3xl bg-white p-6 text-center text-sm font-bold text-slate-400 shadow-card">
            找不到符合條件的款式
          </div>
        )}

        <p className="px-1 pt-2 text-center text-[10px] leading-5 text-slate-400">
          © {new Date().getFullYear()} 針織帽款數位圖鑑 · 本頁僅展示款式資訊，
          不含庫存與價格；下單請聯絡您的業務窗口
        </p>
      </div>

      {/* ===== Lightbox ===== */}
      {active && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/80 p-4 sm:items-center"
          onClick={() => setActive(null)}
        >
          <div
            className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{active.style_no}</h3>
              <button className="text-slate-400" onClick={() => setActive(null)}>
                ✕
              </button>
            </div>
            <HatImage
              src={active.image_url}
              alt={`款式 ${active.style_no}`}
              className="h-72 w-full rounded-2xl bg-slate-50 object-contain"
            />
            <div className="mt-3 flex items-center justify-between">
              <StyleBadges group={active} />
              <a
                href={active.image_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-extrabold text-blue-600"
              >
                🖼 檢視原圖
              </a>
            </div>
            <p className="mt-3 text-xs font-extrabold text-slate-500">可挑顏色</p>
            <ColorChips colors={active.colors || []} />
          </div>
        </div>
      )}
    </div>
  );
}

/** 訪客版徽章（帽型＋季節；不顯示公開／非公開） */
function BadgeOnly({ group }) {
  return (
    <span className="inline-flex gap-1">
      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-extrabold text-blue-700">
        {seasonOf(group.season)}
      </span>
    </span>
  );
}
