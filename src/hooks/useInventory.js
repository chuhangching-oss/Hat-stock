import { useCallback, useEffect, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';

/**
 * 庫存資料 state 管理：清單載入 / 出入庫送出 / 樂觀更新
 */
export default function useInventory() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);

  const refresh = useCallback(async () => {
    const url = getGasUrl();
    if (!url) {
      setError('尚未設定 API URL，請到「設定」頁貼上 Google Apps Script 網址');
      setItems([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const data = await gasRequest(url, { action: 'list' });
      setItems(Array.isArray(data) ? data : []);
      setLastSync(new Date());
      return data;
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

  /**
   * 送出一筆異動（入庫/出庫/盤點）
   * 成功後以 API 回傳的最新庫存更新本地清單
   */
  const submitLog = useCallback(async ({ type, item_code, qty, operator, remark, force }) => {
    const data = await gasRequest(getGasUrl(), {
      action: 'log',
      type,
      item_code,
      qty,
      operator,
      remark,
      force: !!force,
    });
    if (data && data.item) {
      setItems((prev) => prev.map((it) => (it.item_code === data.item.item_code ? data.item : it)));
      setLastSync(new Date());
    }
    return data;
  }, []);

  /** 依品號在本地清單查商品（不分大小寫） */
  const findByCode = useCallback(
    (code) => {
      const target = String(code || '').trim().toLowerCase();
      if (!target) return null;
      return items.find((it) => String(it.item_code).trim().toLowerCase() === target) || null;
    },
    [items],
  );

  /** 以 API 回傳的單一 item 物件更新本地清單（例如照片上傳後） */
  const applyItem = useCallback((item) => {
    if (!item || !item.item_code) return;
    setItems((prev) => {
      const exists = prev.some((it) => it.item_code === item.item_code);
      return exists
        ? prev.map((it) => (it.item_code === item.item_code ? item : it))
        : [...prev, item];
    });
  }, []);

  return { items, loading, error, lastSync, refresh, submitLog, findByCode, applyItem };
}
