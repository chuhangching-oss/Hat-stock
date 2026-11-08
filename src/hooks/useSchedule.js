import { useCallback, useEffect, useState } from 'react';
import { gasRequest, getGasUrl, getOperator } from '../api';

/**
 * 🚢 出貨排程（SHIPMENT_SCHEDULE）資料管理
 * - 收到訂單後的排程動作（計畫層看板，不扣庫存）
 * - 只有「預計出貨日」同步共用 Google Calendar（後端 Code.gs SCHEDULE_CALENDAR_ID）
 * 狀態流：待出貨 →（標記）已出貨／（取消）已取消
 */
export default function useSchedule() {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);

  const refresh = useCallback(async () => {
    const url = getGasUrl();
    if (!url) {
      setError('尚未設定 API URL，請到「設定」頁貼上 Google Apps Script 網址');
      setSchedules([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const list = await gasRequest(url, { action: 'list_schedule' });
      setSchedules(Array.isArray(list) ? list : []);
      setLastSync(new Date());
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

  /** 新增排程（ship_date 必填） */
  const createSchedule = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'create_schedule', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 修改排程（缺的欄不動） */
  const updateSchedule = useCallback(
    async (payload) => {
      const data = await gasRequest(getGasUrl(), { action: 'update_schedule', ...payload });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 待出貨 → 已出貨 */
  const markShipped = useCallback(
    async (scheduleId, remark) => {
      const data = await gasRequest(getGasUrl(), {
        action: 'mark_schedule_shipped',
        schedule_id: scheduleId,
        remark: remark || '',
        operator: getOperator(),
      });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 待出貨 → 已取消（連帶刪除行事曆事件） */
  const cancelSchedule = useCallback(
    async (scheduleId) => {
      const data = await gasRequest(getGasUrl(), {
        action: 'cancel_schedule',
        schedule_id: scheduleId,
        operator: getOperator(),
      });
      await refresh();
      return data;
    },
    [refresh],
  );

  /** 手動全域對帳（補推行事曆漏失的事件） */
  const resync = useCallback(async () => {
    const data = await gasRequest(getGasUrl(), { action: 'resync_schedule', operator: getOperator() });
    await refresh();
    return data;
  }, [refresh]);

  return { schedules, loading, error, lastSync, refresh, createSchedule, updateSchedule, markShipped, cancelSchedule, resync };
}
