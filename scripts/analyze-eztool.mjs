// 深度分析 EZTOOL 盤點表：顏色詞、型態詞、品系分佈
import XLSXM from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX = XLSXM.default ?? XLSXM;
const file = path.join(__dirname, '..', '..', '20261027173210787.xls');

const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

const items = [];
for (const r of rows) {
  const code = String(r[0] ?? '').trim();
  const name = String(r[1] ?? '').trim();
  if (!code || code === '商品代碼' || code === '>') continue;
  items.push({
    code,
    name,
    barcode: String(r[2] ?? '').trim(),
    current: r[3] ?? '',
    sysQty: r[6] ?? '',
    shelf: String(r[7] ?? '').trim(),
  });
}

console.log(`料件數：${items.length}`);
console.log(`現有庫存有值的：${items.filter((i) => i.current !== '').length}`);
console.log(`系統庫存有值的：${items.filter((i) => i.sysQty !== '').length}`);
console.log(`架位有值的：${items.filter((i) => i.shelf).length}`);

// ---- 品名怎麼組成？拆 token（以空白切） ----
const seg = (n) => [n.split(/\s+/), ''];

// 系統庫存非 0 的品系前綴統計（傾向真實在庫）
function prefixOf(name) {
  return name.split(/\s+/)[0] || '';
}
const prefixCount = {};
for (const it of items) {
  const p = prefixOf(it.name);
  const key = p.replace(/[-_]?[A-Z0-9]+$/u, (m) => m); // 保持原樣
  prefixCount[key] = (prefixCount[key] || 0) + 1;
}
const topPrefix = Object.entries(prefixCount).sort((a, b) => b[1] - a[1]).slice(0, 25);

// 型態詞（第二個 token）：素體、配件…
const secondToken = {};
for (const it of items) {
  const t = it.name.split(/\s+/);
  if (t.length >= 2) {
    const w = t[1].replace(/[0-9]+$/, '');
    secondToken[w] = (secondToken[w] || 0) + 1;
  }
}
const topSecond = Object.entries(secondToken).sort((a, b) => b[1] - a[1]).slice(0, 25);

// 顏色候選：最後一個 token（往往就是顏色）
const lastToken = {};
for (const it of items) {
  const t = it.name.split(/\s+/);
  if (t.length >= 2) {
    const w = t[t.length - 1];
    lastToken[w] = (lastToken[w] || 0) + 1;
  }
}
const topLast = Object.entries(lastToken).sort((a, b) => b[1] - a[1]).slice(0, 40);

// 名稱僅一個 token（可能是黏字型）
const single = items.filter((it) => it.name.split(/\s+/).length === 1);
const singleSample = single.slice(0, 15).map((i) => i.name + ' | ' + i.code);

// 系統庫存 > 0 的樣本列
const stocked = items.filter((i) => Number(i.sysQty) > 0).slice(0, 15);

console.log('\n=== 前 25 名品系前綴 ===');
topPrefix.forEach(([k, v]) => console.log(`${String(v).padStart(4)}  ${k}`));
console.log('\n=== 第 2 token（型態詞）TOP ===');
topSecond.forEach(([k, v]) => console.log(`${String(v).padStart(4)}  ${k}`));
console.log('\n=== 最後 token（顏色候選）TOP 40 ===');
topLast.forEach(([k, v]) => console.log(`${String(v).padStart(4)}  ${k}`));
console.log(`\n=== 只有一個 token 的名稱（黏字型）：${single.length} 筆，樣本 ===`);
console.log(singleSample.join('\n'));
console.log('\n=== 系統庫存>0 樣本 ===');
for (const it of stocked) console.log(JSON.stringify(it));
