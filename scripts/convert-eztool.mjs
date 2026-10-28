// 將 EZTOOL 盤點表轉成 INVENTORY_MASTER 貼入檔（A~G 欄）
// 規則：
//   1. Item_Name = 型號(＋素體等修飾詞)；Color_Spec = 字尾「完整色名」
//      - 含空白：最後一個 token 若含中文 = 顏色（整個 token，不截字）
//      - 黏字型：抽取結尾連續中文（完整 run，不截字）
//      - (樣) 等標記不是顏色；純代碼無顏色則 Color_Spec 留空
//   2. Category：名稱含「素體」→ 半成品，其餘 → 成品
//   3. Unit：全部 → PCS（頂）
//   4. Stock_Qty = 系統庫存
//   5. Item_Code：系統代管的無意義序號 A0001~A####（前端不顯示，操作以品名+顏色為主）
//   6. 另輸出 品號對照表.csv（新序號 ↔ EZTOOL原碼 ↔ 品名/顏色）
import XLSXM from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX = XLSXM.default ?? XLSXM;
const file = path.join(__dirname, '..', '..', '20261027173210787.xls');
const outDir = path.join(__dirname, '..', '..', 'output');
fs.mkdirSync(outDir, { recursive: true });

const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

// ---------- 拆色（顏色欄保留完整色名，不簡化截字） ----------
const COLOR_TAG_NOT_COLOR = new Set(['樣', '試', '打', '雜', '包']);

function splitName(rawName) {
  const name = String(rawName ?? '').trim();
  const tokens = name.split(/\s+/).filter(Boolean);

  // 型態修飾詞（素體等）屬於品名的一部分，留著
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (/[\u4e00-\u9fff]/.test(last)) {
      return {
        item_code_name: tokens.slice(0, -1).join(' '),
        color: last, // 完整色詞
      };
    }
    return { item_code_name: name, color: '' };
  }

  // 單 token 黏字型：抽結尾連續中文（整串保留）
  const cjkRuns = name.match(/[\u4e00-\u9fff]+/g);
  if (!cjkRuns) return { item_code_name: name, color: '' };
  const tail = cjkRuns[cjkRuns.length - 1];

  if (tail.length === 1 && COLOR_TAG_NOT_COLOR.has(tail)) {
    // (樣) 等標記 → 不是顏色
    return { item_code_name: name, color: '' };
  }
  const idx = name.lastIndexOf(tail);
  const bare = name.slice(0, idx).replace(/[-_/]+$/, '') || name;
  return { item_code_name: bare, color: tail };
}

// ---------- 主流程 ----------
const items = [];
for (const r of rows) {
  const rawCode = String(r[0] ?? '').trim();
  const rawName = String(r[1] ?? '').trim();
  if (!rawCode || rawCode === '商品代碼' || rawCode === '>') continue;

  const { item_code_name, color } = splitName(rawName);
  const category = rawName.includes('素體') ? '半成品' : '成品';
  const qty = Number(String(r[6] ?? '').replace(/[^0-9.\-]/g, '')) || 0;

  items.push({
    ezCode: rawCode,
    raw: rawName,
    item_name: item_code_name,
    color, // 完整色名
    category,
    qty,
    item_code: '',
  });
}

// ---------- 自動編序號（A0001 起，照原始列順序；系統內部用） ----------
for (let i = 0; i < items.length; i++) {
  items[i].item_code = `A${String(i + 1).padStart(4, '0')}`;
}
if (new Set(items.map((it) => it.item_code)).size !== items.length) {
  throw new Error('產生的序號有重複！');
}

// ---------- 匯出 CSV（Excel 可直接開，BOM 防亂碼） ----------
function csv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

const importRows = [
  ['Item_Code', 'Item_Name', 'Category', 'Color_Spec', 'Stock_Qty', 'Unit', 'Location'],
  ...items.map((it) => [it.item_code, it.item_name, it.category, it.color, it.qty, 'PCS', '']),
];
fs.writeFileSync(path.join(outDir, 'INVENTORY_MASTER_import.csv'), '\uFEFF' + csv(importRows), 'utf8');

// 新舊品號對照表（日後回查 EZTOOL 用）
const crossRows = [
  ['系統序號(Item_Code)', 'EZTOOL商品代碼', '品名', '顏色', '庫存'],
  ...items.map((it) => [it.item_code, it.ezCode, it.item_name, it.color, it.qty]),
];
fs.writeFileSync(path.join(outDir, '品號對照表.csv'), '\uFEFF' + csv(crossRows), 'utf8');

const zeroRows = [['Item_Code', 'Item_Name', 'Color_Spec'],
  ...items.filter((it) => it.qty === 0).map((it) => [it.item_code, it.item_name, it.color])];
fs.writeFileSync(path.join(outDir, '庫存為零清單.csv'), '\uFEFF' + csv(zeroRows), 'utf8');

// ---------- 報告 ----------
const quantityPositive = items.filter((it) => it.qty > 0);
const cat = {};
for (const it of items) cat[it.category] = (cat[it.category] || 0) + 1;
const colorStats = {};
for (const it of items) if (it.color) colorStats[it.color] = (colorStats[it.color] || 0) + 1;
const topColors = Object.entries(colorStats).sort((a, b) => b[1] - a[1]);
const noColorCount = items.filter((it) => !it.color).length;

console.log('============ 轉換報告 ============');
console.log(`料件總數：${items.length}`);
console.log(`系統序號：A0001 ~ A${String(items.length).padStart(4, '0')}（不出現在 App 畫面）`);
console.log(`拆色：完整色名保留（不截字）；無色名 ${noColorCount} 筆 Color_Spec 留空`);
console.log(`庫存 > 0：${quantityPositive.length} 筆，庫存 = 0：${items.length - quantityPositive.length} 筆`);
console.log(`Category 分佈：${JSON.stringify(cat)}`);
console.log(`不重複色名：${topColors.length} 種`);
console.log(`色名 TOP 15：${topColors.slice(0, 15).map(([c, n]) => `${c}(${n})`).join('、')}`);
console.log('\n=== 匯入檔前 12 筆樣本 ===');
importRows.slice(1, 13).forEach((r) => console.log(r.join(' | ')));
console.log(`\n輸出檔案 → ${outDir}`);
