import { useState } from 'react';
import { SEASON_COLORS } from '../constants';

/**
 * 破圖時的灰階帽子 Placeholder（inline SVG data URI，無外部依賴）
 */
export const HAT_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <rect width="200" height="200" fill="#e2e8f0"/>
      <g fill="#94a3b8">
        <ellipse cx="100" cy="118" rx="62" ry="16"/>
        <path d="M62 118 C62 78, 138 78, 138 118 L138 122 L62 122 Z"/>
        <rect x="96" y="86" width="8" height="34" rx="3" fill="#cbd5e1"/>
      </g>
      <text x="100" y="152" font-size="14" fill="#94a3b8" text-anchor="middle" font-family="sans-serif">No Photo</text>
    </svg>`,
  );

/** 圖片元件：載入失敗（破圖／Drive 權限）時自動換成灰階帽子預設圖 */
export function HatImage({ src, alt, className = '' }) {
  const [err, setErr] = useState(false);
  const url = !src || err ? HAT_PLACEHOLDER : src;
  return (
    <img
      src={url}
      alt={alt || '款式圖片'}
      loading="lazy"
      onError={() => setErr(true)}
      className={className}
    />
  );
}

/**
 * 欄位值正規化：季節顯示（空白 → 四季）
 */
export function seasonOf(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'SS' || s === 'AW') return s;
  return '四季';
}

/**
 * 以款式（style_no = 品名）為單位 grouping：
 * - 來源可以是主檔 item（有 color_spec / image_url / style_category / season / is_public）
 *   或公開 API 已分組的 rows（有 colors 陣列）
 * - 內部模式（internal=true）附 item_codes 與是否含非公開列
 */
export function groupStyles(list, { internal = false } = {}) {
  const map = new Map();
  for (const it of list || []) {
    const styleNo = String(it.style_no || it.item_name || '').trim();
    if (!styleNo) continue;
    const key = styleNo.toUpperCase();
    let g = map.get(key);
    if (!g) {
      g = {
        style_no: styleNo,
        style_category: '',
        season: '',
        image_url: '',
        colors: [],
        item_codes: [],
        hasPrivate: false,
      };
      map.set(key, g);
    }
    const cat = String(it.style_category || '').trim() || '其他';
    const season = it.season || '';
    if (!g.style_category || g.style_category === '其他') g.style_category = cat;
    if (!g.season && season) g.season = season;
    if (!g.image_url && it.image_url) g.image_url = it.image_url;
    if (it.colors) {
      (it.colors || []).forEach((c) => addColor(g, c));
    } else if (it.color_spec) {
      addColor(g, it.color_spec);
    }
    if (it.item_code) g.item_codes.push(it.item_code);
    if (internal && String(it.is_public || 'Y').toUpperCase() === 'N') g.hasPrivate = true;
  }
  const groups = [...map.values()];
  groups.sort((a, b) => a.style_no.localeCompare(b.style_no, 'zh-Hant'));
  return groups;
}

function addColor(g, c) {
  const v = String(c).trim();
  if (v && !g.colors.includes(v)) g.colors.push(v);
}

/**
 * 圖鑑篩選：帽型分類（tag）＋季節（tag）＋關鍵字（款號／顏色／品號）
 */
export function filterGroups(groups, { category, season, keyword }) {
  const f = String(keyword || '').trim().toLowerCase();
  return (groups || []).filter((g) => {
    if (category !== '全部' && g.style_category !== category) return false;
    if (season !== '全部' && seasonOf(g.season) !== season) return false;
    if (!f) return true;
    return `${g.style_no} ${g.style_category} ${g.colors.join(' ')} ${g.item_codes.join(' ')}`
      .toLowerCase()
      .includes(f);
  });
}

/** 款式徽章列：[帽型] [季節]（＋[非公開]） */
export function StyleBadges({ group, internal = false }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {group.style_category && group.style_category !== '其他' && (
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-extrabold text-blue-700">
          {group.style_category}
        </span>
      )}
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
          SEASON_COLORS[seasonOf(group.season)] || SEASON_COLORS['四季']
        }`}
      >
        {seasonOf(group.season)}
      </span>
      {internal && group.hasPrivate && (
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-extrabold text-red-600">
          非公開
        </span>
      )}
    </div>
  );
}

/** 顏色清單 chips（GRAY / BLACK / BEIGE…） */
export function ColorChips({ colors }) {
  return (
    <div className="flex flex-wrap gap-1">
      {(colors || []).length === 0 && (
        <span className="text-[11px] font-bold text-slate-400">未填顏色規格</span>
      )}
      {(colors || []).map((c) => (
        <span
          key={c}
          className="rounded-lg bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-600"
        >
          {c}
        </span>
      ))}
    </div>
  );
}
