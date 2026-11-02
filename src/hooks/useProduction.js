import { useCallback, useEffect, useMemo, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';

/** 今天（手機本地時區）的 YYYY-MM-DD */
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 新版工作令（PRODUCTION_ORDERS，接續紙本「盛全工業 工作令」）＋紗線庫存（YARN_INVENTORY）
 * 狀態流：草稿 →（投產扣紗）生產中 →（到期自動）待確認 →（完工）已入庫 / 待出貨 →（出貨）已出貨
 * 紗線扣減後端時機＝切換至「生產中」當下（開單直接投產或草稿投產皆同）
 */
export default function useProduction() {
  const [pos, setPos] = useState([]);
  const [yarns, setYarns] = useState([]); // [{yarn_code,yarn_name,color,stock_kg,safety_stock,last_updated}]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);

  const refresh = useCallback(async () => {
    const url = getGasUrl();
    if (!url) {
      setError('尚未設定 API URL，請到「設定」頁貼上 Google Apps Script 網址');
      setPos([]);
      setYarns([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const [poList, yarnList] = await Promise.all([
        gasRequest(url, { action: 'list_production_orders' }),
        gasRequest(url, { action: 'list_yarn' }),
      ]);
      setPos(Array.isArray(poList) ? poList : []);
      setYarns(Array.isArray(yarnList) ? yarnList : []);
      setLastSync(new Date());
      return poList;
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

  /** 開立工作令（status=start_now → 後端立即投產扣紗） */
  const createPO = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'create_production_order', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 草稿 → 生產中（後端立即扣紗） */
  const startPO = useCallback(
    async (woId, operator) => {
      const data = await gasRequest(getGasUrl(), {
        action: 'start_production_order',
        wo_id: woId,
        operator,
      });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 確認完工結案（入倉庫備庫 → 已入庫＋成品入庫；訂單出貨 → 待出貨） */
  const completePO = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'complete_production_order', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 待出貨 → 已出貨 */
  const shipPO = useCallback(
    async (woId) => {
      const data = await gasRequest(getGasUrl(), { action: 'ship_production_order', wo_id: woId });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 新增／更新紗線庫存（upsert；stock_kg＝直接設定為現有量） */
  const saveYarn = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'save_yarn', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 紗線代碼 → 資料檔（低庫存試算用） */
  const yarnByKey = useMemo(
    () => new Map(yarns.map((y) => [String(y.yarn_code).toUpperCase(), y])),
    [yarns],
  );

  /** 今日到期 / 已逾期：生產中、待確認 且 due_date <= 今天（首頁紅色警示用） */
  const duePOs = useMemo(() => {
    const today = todayYMD();
    return pos
      .filter(
        (w) =>
          (w.status === '生產中' || w.status === '待確認') &&
          w.due_date &&
          w.due_date <= today,
      )
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  }, [pos]);

  return { pos, yarns, yarnByKey, loading, error, lastSync, refresh, createPO, startPO, completePO, shipPO, saveYarn, duePOs };
}
