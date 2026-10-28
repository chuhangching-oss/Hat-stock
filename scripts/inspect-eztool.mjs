// 檢查 EZTOOL 盤點表結構
import XLSXLazy from 'xlsx';
const XLSX = XLSXLazy.default ?? XLSXLazy;
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', '..', '20261027173210787.xls');

const wb = XLSX.readFile(file, { raw: false, cellDates: true });
console.log('=== 工作表清單 ===');
console.log(wb.SheetNames.map((n) => `${n}(${wb.Sheets[n]['!ref']})`).join(' | '));

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  console.log(`\n===== [${name}] 共 ${rows.length} 列，前 12 列內容 =====`);
  for (let i = 0; i < Math.min(12, rows.length); i++) {
    console.log(`R${i + 1}:`, JSON.stringify(rows[i]));
  }
}
