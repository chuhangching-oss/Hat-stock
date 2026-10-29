import { useCallback, useEffect, useMemo, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';

/** 今天（手機本地時區）的 YYYY-MM-DD */
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 工作令（WORK_ORDERS）＋ BOM（BOM_MASTER）資料管理
 * 狀態流：生產中 →（到期自動）待確認 →（完工）已入庫 / 待出貨 →（出貨）已出貨
 */
export default function useWorkOrders() {
  const [wos, setWos] = useState([]);
  const [bom, setBom] = useState([]); // [{style_no,item_code,item_name,unit_use}]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);

  const refresh = useCallback(async () => {
    const url = getGasUrl();
    if (!url) {
      setError('尚未設定 API URL，請到「設定」頁貼上 Google Apps Script 網址');
      setWos([]);
      setBom([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const [woList, bomList] = await Promise.all([
        gasRequest(url, { action: 'list_work_orders' }),
        gasRequest(url, { action: 'list_bom' }),
      ]);
      setWos(Array.isArray(woList) ? woList : []);
      setBom(Array.isArray(bomList) ? bomList : []);
      setLastSync(new Date());
      return woList;
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

  /** 開立工作令（成功後重拉清單，確保 WO_ID 正確） */
  const createWO = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'create_work_order', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 確認完工結案（回傳 updated_items 供庫存畫面同步） */
  const completeWO = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'complete_work_order', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 待出貨 → 已出貨 */
  const shipWO = useCallback(
    async (woId) => {
      const data = await gasRequest(getGasUrl(), { action: 'ship_work_order', wo_id: woId });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 某款式的 BOM 列 */
  const bomFor = useCallback(
    (styleNo) => {
      const s = String(styleNo || '').trim();
      if (!s) return [];
      return bom.filter((b) => b.style_no === s);
    },
    [bom],
  );

  /** 今日到期 / 已逾期：狀態為生產中、待確認 且 due_date <= 今天（首頁紅色警示用） */
  const dueWos = useMemo(() => {
    const today = todayYMD();
    return wos
      .filter(
        (w) =>
          (w.status === '生產中' || w.status === '待確認') &&
          w.due_date &&
          w.due_date <= today,
      )
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  }, [wos]);

  return { wos, bom, loading, error, lastSync, refresh, createWO, completeWO, shipWO, bomFor, dueWos };
}
