import { useMemo, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';
import { SEASONS, STYLE_CATEGORIES } from '../constants';
import {
  ColorChips,
  HatImage,
  StyleBadges,
  filterGroups,
  groupStyles,
  seasonOf,
} from './LookbookShared';

const CAT_TAGS = ['全部', ...STYLE_CATEGORIES];
const SEASON_TAGS = ['全部', ...SEASONS];

/**
 * 分頁：🧢 款式圖鑑（內部版）
 * - 以款式（品名）為單位 grouping（同款多色歸同卡）
 * - 篩選：帽型分類標籤＋季節標籤＋關鍵字（款號/顏色/品號）
 * - 卡片：照片（破圖→灰階帽子 Placeholder）＋徽章＋顏色清單
 * - 點擊卡片 → Lightbox 大圖＋品號/庫存明細＋✏️ 編輯圖鑑資訊
 *   （帽型分類／季節／Image_URL／Is_Public，經 update_item_info 寫回）
 * - 【🔗 複製客戶分享連結】產生 #/lookbook 公開展示頁連結（僅露出 Is_Public=Y 款式）
 */
export default function LookbookTab({ items, onItemsUpdated, showToast }) {
  const [category, setCategory] = useState('全部');
  const [season, setSeason] = useState('全部');
  const [keyword, setKeyword] = useState('');

  // Lightbox / 編輯
  const [active, setActive] = useState(null); // 選中的 group
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null); // { style_category, season, image_url, is_public }
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => groupStyles(items, { internal: true }), [items]);
  const filtered = useMemo(
    () => filterGroups(groups, { category, season, keyword }),
    [groups, category, season, keyword],
  );

  const cats = useMemo(() => {
    // 只顯示資料裡有出現的帽型分類，減少標籤噪音
    const set = new Set(groups.map((g) => g.style_category).filter((c) => c && c !== '其他'));
    return ['全部', ...[...set].sort(), ...(groups.some((g) => !g.style_category || g.style_category === '其他') ? ['其他'] : [])];
  }, [groups]);

  function openLightbox(g) {
    setActive(g);
    setEditing(false);
    setDraft({
      style_category: g.style_category === '其他' ? '' : g.style_category,
      season: seasonOf(g.season),
      image_url: g.image_url,
      is_public: g.hasPrivate ? 'N' : 'Y',
    });
  }

  async function handleSave() {
    if (!active) return;
    setBusy(true);
    try {
      const payload = {
        style_category: draft.style_category,
        season: draft.season,
        image_url: draft.image_url.trim(),
        is_public: draft.is_public,
      };
      // 同款每個品號（顏色列）都要同步 → 逐一送 update_item_info
      for (const code of active.item_codes) {
        const res = await gasRequest(getGasUrl(), {
          action: 'update_item_info',
          item_code: code,
          ...payload,
        });
        if (res.item) onItemsUpdated(res.item);
      }
      showToast(`✅ 已更新款式資訊（${active.item_codes.length} 個顏色品號）`);
      setEditing(false);
      setActive(null);
    } catch (e) {
      showToast(`❌ 更新失敗：${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copyShareLink() {
    const url = `${location.origin}${location.pathname}#/lookbook?api=${encodeURIComponent(getGasUrl())}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('🔗 客戶分享連結已複製，貼到 LINE / Email 即可傳給客人挑款式');
    } catch (e) {
      showToast(`⚠️ 複製失敗，請手動複製：${url}`);
    }
  }

  if (!getGasUrl()) {
    return (
      <div className="mt-10 rounded-3xl bg-white p-8 text-center shadow-card">
        <div className="text-5xl">⚙️</div>
        <h2 className="mt-4 text-xl font-extrabold">尚未設定雲端 API</h2>
        <p className="mt-2 text-slate-500">請先到「設定」分頁貼上 Apps Script 網址。</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ===== 標題列＋客戶分享連結 ===== */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900">🧢 款式圖鑑</h2>
          <p className="text-xs font-bold text-slate-400">
            共 {filtered.length} 款（全部 {groups.length} 款）· 點卡片放大檢視
          </p>
        </div>
        <button
          onClick={copyShareLink}
          className="shrink-0 rounded-2xl bg-emerald-600 px-3 py-2 text-xs font-extrabold text-white shadow-card transition active:bg-emerald-700 active:scale-95"
        >
          🔗 客戶分享連結
        </button>
      </div>

      {/* ===== 篩選器 ===== */}
      <div className="space-y-2 rounded-3xl bg-white p-4 shadow-card">
        <input
          className="field-input"
          placeholder="搜尋款號 / 顏色 / 品號（例：MONET、GRAY）"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <TagRow label="帽型" tags={cats} value={category} onChange={setCategory} />
        <TagRow label="季節" tags={SEASON_TAGS} value={season} onChange={setSeason} />
      </div>

      {/* ===== 卡片 Grid ===== */}
      <div className="grid grid-cols-2 gap-3">
        {filtered.map((g) => (
          <button
            key={g.style_no}
            onClick={() => openLightbox(g)}
            className="overflow-hidden rounded-3xl bg-white text-left shadow-card ring-1 ring-slate-100 transition active:scale-[0.98]"
          >
            <div className="relative">
              <HatImage
                src={g.image_url}
                alt={`款式 ${g.style_no}`}
                className="h-36 w-full object-cover"
              />
              <div className="absolute left-1.5 top-1.5">{<StyleBadges group={g} internal />}</div>
            </div>
            <div className="space-y-1.5 p-2.5">
              <h3 className="truncate text-sm font-extrabold text-slate-900">{g.style_no}</h3>
              <ColorChips colors={g.colors.slice(0, 5)} />
              {g.colors.length > 5 && (
                <span className="text-[10px] font-bold text-slate-400">
                  +其他 {g.colors.length - 5} 色 · 共 {g.item_codes.length} 品號
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="rounded-3xl bg-white p-6 text-center text-sm font-bold text-slate-400 shadow-card">
          找不到符合條件的款式（可清空篩選看看）
        </div>
      )}

      {/* ===== Lightbox 放大檢視 ===== */}
      {active && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/80 p-4 sm:items-center"
          onClick={() => !busy && setActive(null)}
        >
          <div
            className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{active.style_no}</h3>
              <button
                className="text-slate-400"
                onClick={() => !busy && setActive(null)}
              >
                ✕
              </button>
            </div>
            <HatImage
              src={active.image_url}
              alt={`款式 ${active.style_no}`}
              className="h-64 w-full rounded-2xl border border-slate-100 object-contain"
            />
            <div className="mt-3 flex items-center justify-between">
              <StyleBadges group={active} internal />
              <span className="text-xs font-bold text-slate-400">
                {active.item_codes.length} 個顏色品號
              </span>
            </div>
            <p className="mt-3 text-xs font-extrabold text-slate-500">可挑顏色</p>
            <ColorChips colors={active.colors} />

            {/* 內部專用：品號與庫存明細 */}
            <div className="mt-3 max-h-40 overflow-y-auto rounded-2xl border border-slate-100">
              <ul className="divide-y divide-slate-100">
                {active.item_codes.map((code) => {
                  const it = items.find((x) => x.item_code === code);
                  if (!it) return null;
                  return (
                    <li
                      key={code}
                      className="flex items-baseline justify-between gap-2 px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-bold text-slate-700">
                        {it.color_spec || '—'}
                        <span className="ml-1 font-mono text-slate-400">{code}</span>
                      </span>
                      <span className="shrink-0 font-black tabular-nums text-slate-800">
                        {it.stock_qty} {it.unit}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setEditing(true)}
                className="btn-primary flex-1 bg-violet-600 active:bg-violet-700"
              >
                ✏️ 編輯圖鑑資訊
              </button>
              {active.image_url && (
                <a
                  href={active.image_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-touch items-center justify-center rounded-2xl bg-slate-700 px-4 text-sm font-extrabold text-white transition active:bg-slate-800"
                >
                  🖼 原圖
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== 編輯圖鑑資訊彈窗 ===== */}
      {active && editing && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          onClick={() => !busy && setEditing(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold">✏️ 編輯：{active.style_no}</h3>
              <button className="text-slate-400" onClick={() => !busy && setEditing(false)}>
                ✕
              </button>
            </div>
            <label className="field-label">帽型分類</label>
            <select
              className="field-input"
              value={draft.style_category}
              onChange={(e) => setDraft((d) => ({ ...d, style_category: e.target.value }))}
            >
              <option value="">— 未分類 —</option>
              {STYLE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="field-label mt-3">季節</label>
            <div className="grid grid-cols-3 gap-2">
              {SEASONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setDraft((d) => ({ ...d, season: s }))}
                  className={`min-h-touch rounded-2xl text-base font-extrabold transition active:scale-95 ${
                    draft.season === s
                      ? 'bg-blue-700 text-white shadow-card'
                      : 'bg-white text-blue-700 ring-2 ring-blue-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <label className="field-label mt-3">Image_URL（圖片連結）</label>
            <input
              className="field-input font-mono text-xs"
              placeholder="Google Drive 或外部圖片 URL（留空＝無照片）"
              value={draft.image_url}
              onChange={(e) => setDraft((d) => ({ ...d, image_url: e.target.value }))}
            />
            <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={draft.is_public !== 'N'}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, is_public: e.target.checked ? 'Y' : 'N' }))
                }
                className="h-5 w-5 accent-emerald-600"
              />
              對外公開（客人可由分享連結看到的款式＝勾選）
            </label>
            <button className="btn-primary mt-4" disabled={busy} onClick={handleSave}>
              {busy ? `儲存中…（${active.item_codes.length} 個品號）` : '💾 儲存整款'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TagRow({ label, tags, value, onChange }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-8 shrink-0 pt-1.5 text-[10px] font-extrabold text-slate-400">{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {tags.map((t) => (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={`rounded-full px-2.5 py-1 text-xs font-extrabold transition active:scale-95 ${
              value === t
                ? 'bg-blue-700 text-white shadow-card'
                : 'bg-slate-100 text-slate-600'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
