import { useCallback, useEffect, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';

/**
 * 出入庫異動記錄（STOCK_LOG 檢索，list_stock_logs API）
 * - logs = [{ log_id, timestamp, type, item_code, item_name, color_spec,
 *             unit, change_qty, operator, remark }]（由新到舊）
 * - 每次「送出入庫」成功後由 App 呼叫 refresh() 保持最新
 */
export default function useStockLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const url = getGasUrl();
    if (!url) {
      setError('尚未設定 API URL，請到「設定」頁貼上 Google Apps Script 網址');
      setLogs([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const data = await gasRequest(url, { action: 'list_stock_logs', limit: 1000 });
      const list = Array.isArray(data) ? data : [];
      setLogs(list);
      return list;
    } catch (e) {
      setError(e.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次載入：若已設定過網址則自動拉取
  useEffect(() => {
    if (getGasUrl()) refresh();
  }, [refresh]);

  return { logs, loading, error, refresh };
}
