import { useCallback, useEffect, useState } from 'react';
import useInventory from './hooks/useInventory';
import useWorkOrders from './hooks/useWorkOrders';
import useProduction from './hooks/useProduction';
import useStockLogs from './hooks/useStockLogs';
import useSchedule from './hooks/useSchedule';
import { gasRequest, getGasUrl, isManager, matchedRoles } from './api';
import SearchTab from './components/SearchTab';
import ActionTab from './components/ActionTab';
import WorkOrderTab from './components/WorkOrderTab';
import ProductionTab from './components/ProductionTab';
import ScheduleTab from './components/ScheduleTab';
import ShipmentTab from './components/ShipmentTab';
import HygieneTab from './components/HygieneTab';
import AnalyticsTab from './components/AnalyticsTab';
import LookbookTab from './components/LookbookTab';
import LookbookPublic from './components/LookbookPublic';
import StockLogTab from './components/StockLogTab';
import SettingsTab from './components/SettingsTab';
import Scanner from './components/Scanner';
import Toast from './components/Toast';
// 🎭 角色分權：roles = ['*'] 所有人 ／ 'manager' HC・MAIN ／ 具名角色（ANDY、JL）
//    新手畫面只出現 庫存查詢／出入庫／出庫出貨／設定，降低第一次上手的按鈕數
const TABS = [
  { key: 'search', label: '庫存查詢', icon: '🔍', roles: ['*'] },
  { key: 'action', label: '出入庫', icon: '📦', roles: ['*'] },
  { key: 'pwo', label: '生產工令', icon: '🏭', roles: ['manager', 'ANDY'] },
  { key: 'wo', label: '工單管理', icon: '📋', roles: ['manager', 'ANDY'] },
  { key: 'ship', label: '出庫出貨', icon: '🚢', roles: ['*'] },
  { key: 'sched', label: '出貨排程', icon: '📅', roles: ['*'] },
  { key: 'hygiene', label: '品項健檢', icon: '🧹', roles: ['manager', 'ANDY', 'JL'] },
  { key: 'logs', label: '紀錄', icon: '🧾', roles: ['manager'] },
  { key: 'book', label: '款式圖鑑', icon: '🧢', roles: ['manager', 'JL'] },
  { key: 'report', label: '營運報表', icon: '📊', roles: ['manager'] },
  { key: 'settings', label: '設定', icon: '⚙️', roles: ['*'] },
];

/** 🌍 訪客展示路由：網址 #/lookbook → 純展示圖鑑（無登入、無內部按鈕） */
function isLookbookRoute() {
  return (window.location.hash || '').split('?')[0] === '#/lookbook';
}

export default function App() {
  const inventory = useInventory();
  const workOrders = useWorkOrders();
  const production = useProduction();
  const logs = useStockLogs();
  const schedule = useSchedule();
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState(''); // 查詢頁搜尋字
  const [toast, setToast] = useState(null); // { type: 'success'|'error', msg }
  const [showMore, setShowMore] = useState(false); // ⋯ 更多功能選單開闔

  // 🌍 訪客展示模式：#/lookbook 路由（跟隨 hash 變化，可分享後返回）
  const [guestRoute, setGuestRoute] = useState(isLookbookRoute);
  useEffect(() => {
    const onHash = () => setGuestRoute(isLookbookRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 🎭 角色分權：依經辦身分決定顯示哪些分頁
  //    HC/MAIN 全部；ANDY ＋生產工令/工單管理；JL ＋款式圖鑑；其餘使用者基本 4 頁
  const manager = isManager();
  const extras = matchedRoles(); // 命中的具名角色（例：['ANDY']）
  const visibleTabs = TABS.filter(
    (t) =>
      t.roles.includes('*') ||
      (manager && t.roles.includes('manager')) ||
      t.roles.some((r) => extras.includes(r)),
  );
  const allowedKeys = visibleTabs.map((t) => t.key).join(',');

  // 📥 分頁收納（2026-11）：底欄只留常用 5 頁（查詢／出入庫／出庫出貨／出貨排程／設定），
  //    其餘（生產工令／工單管理／品項健檢／紀錄／款式圖鑑／營運報表）收進「⋯ 更多」選單；
  //    非管理者本來就只有 5 頁 → 不會出現「更多」按鈕，畫面維持不變
  const PRIMARY_TAB_KEYS = ['search', 'action', 'ship', 'sched', 'settings'];
  const mainTabs = visibleTabs.filter((t) => PRIMARY_TAB_KEYS.includes(t.key));
  const moreTabs = visibleTabs.filter((t) => !PRIMARY_TAB_KEYS.includes(t.key));
  const inMoreMenu = moreTabs.some((t) => t.key === tab); // 目前分頁在「更多」內 → 該按鈕高亮

  // 經辦身分變動後，當前分頁可能被收走（例：非管理者停在「紀錄」）→ 跳回庫存查詢
  useEffect(() => {
    if (guestRoute) return;
    if (!allowedKeys.split(',').includes(tab)) setTab('search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedKeys, tab, guestRoute]);

  // 掃碼狀態：scanFor 決定把掃到的品號帶到哪個分頁
  const [scanFor, setScanFor] = useState(null); // 'search' | 'action'
  const [scanResult, setScanResult] = useState(null); // { code, seq }

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type, seq: Date.now() });
  }, []);

  const openScanner = useCallback((target) => setScanFor(target), []);
  const closeScanner = useCallback(() => setScanFor(null), []);

  const handleScanResult = useCallback(
    (code) => {
      if (!code) return;
      setScanResult({ code, seq: Date.now() });
      setScanFor(null); // 關閉相機
      if (scanFor === 'search') setTab('search');
      if (scanFor === 'action') setTab('action');
      if (scanFor === 'wo') setTab('wo');
      if (scanFor === 'ship') setTab('ship');
      showToast(`已掃描：${code}`);
    },
    [scanFor, showToast],
  );

  // 款式照片上傳成功 → 立刻更新該品號（卡片會出現縮圖）
  const handlePhotoUploaded = useCallback(
    (result) => {
      if (result && result.item) inventory.applyItem(result.item);
    },
    [inventory],
  );

  // 頂部「同步」按鈕：庫存主檔＋工作令＋生產工令＋異動記錄＋出貨排程一起重拉
  const handleSync = useCallback(() => {
    inventory.refresh();
    workOrders.refresh();
    production.refresh();
    logs.refresh();
    schedule.refresh();
  }, [inventory, workOrders, production, logs, schedule]);

  // 出入庫單筆送出（ActionTab「直接入庫新品項」呼叫）
  const handleSubmitLog = useCallback(
    async (payload) => {
      try {
        const res = await inventory.submitLog(payload);
        const it = res.item;
        // 顯示「品號 + 品名（顏色）」，現場一眼確認沒選錯料件
        const nameWithColor = `${it.item_name}${it.color_spec ? `（${it.color_spec}）` : ''}`;
        showToast(
          `✅ ${payload.type}成功：${it.item_code} ${nameWithColor} → 目前庫存 ${it.stock_qty} ${it.unit}`,
          'success',
        );
        logs.refresh(); // 異動記錄分頁保持最新
        return res;
      } catch (e) {
        showToast(`❌ 送出失敗：${e.message}`, 'error');
        throw e; // 拋回讓 ActionTab 保持彈窗、顯示錯誤
      }
    },
    [inventory, logs, showToast],
  );

  // 批次出入庫送出（ActionTab 購物車模式呼叫）
  const handleBatchSubmit = useCallback(
    async (payload) => {
      // 批次 payload 的 type 是 IN／OUT／盤點 → 先正規化成後端的 入庫／出庫／盤點
      const type = payload.type === 'IN' ? '入庫' : payload.type === 'OUT' ? '出庫' : payload.type;
      // ===== 樂観更新：先以本地庫存試算「送出後」數字，立刻反映在畫面 =====
      // - 既有料件：入庫＝原庫＋數量、出庫＝原庫−數量（補帳可負）、盤點＝盤後值
      // - 新品項（item_code 留空自動編號）無法本地預知品號 → 等後端回應再插入
      const prevByCode = new Map(); // code -> 送出前的 item（失敗 rollback 用）
      const round4 = (v) => Math.round(Number(v) * 10000) / 10000;
      const stamp = () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      };
      const findByCode = (code) => {
        const t = String(code || '').trim().toLowerCase();
        return (
          inventory.items.find((it) => String(it.item_code).trim().toLowerCase() === t) || null
        );
      };
      payload.items.forEach((line) => {
        if (line.new_item) return; // 新品項：等後端自動編號後再套用
        const cur = findByCode(line.item_code);
        if (!cur) return;
        const curQty = Number(cur.stock_qty) || 0;
        const q = Number(line.qty) || 0;
        const after = type === '入庫' ? curQty + q
          : type === '出庫' ? curQty - q
          : q; // 盤點＝盤後實際庫存量
        prevByCode.set(String(cur.item_code), cur);
        inventory.applyItem({ ...cur, stock_qty: round4(after), last_updated: stamp() });
      });
      try {
        const res = await gasRequest(getGasUrl(), {
          action: 'batchStockTransaction',
          ...payload,
        });
        // 以後端回應為準校正（含自動編號後的新品項）
        (res.updated_items || []).forEach((it) => inventory.applyItem(it));
        const shipPart = res.shipment_id ? `，已建立出貨單 ${res.shipment_id}` : '';
        const shortPart =
          type === '出庫' && res.short_count ? `（⚠️ ${res.short_count} 項負庫存待盤）` : '';
        showToast(
          `${type === '出庫' ? '📤' : type === '盤點' ? '🧮' : '📥'} 批次${res.type}成功：` +
            `${res.total_items} 項 ${res.total_qty} 件${shipPart}${shortPart}`,
        );
        logs.refresh(); // 異動記錄分頁保持最新
        return res;
      } catch (e) {
        // 後端拒絕（庫存不足／斷線／逾時…）→ 把樂観更新的庫存還原回送出前狀態
        prevByCode.forEach((orig) => inventory.applyItem(orig));
        showToast(`❌ 批次送出失敗：${e.message}`, 'error');
        throw e; // 拋回讓 ActionTab 還原暫存清單與彈窗
      }
    },
    [inventory, logs, showToast],
  );

  // ===== 工作令（WorkOrderTab 呼叫） =====
  const handleCreateWO = useCallback(
    async (payload) => {
      try {
        const res = await workOrders.createWO(payload);
        const w = res.wo;
        showToast(`✅ 工作令已開立：${w.wo_id}（${w.style_no} × ${w.plan_qty}${w.due_date ? `，到期 ${w.due_date}` : ''}）`);
        return res;
      } catch (e) {
        showToast(`❌ 開立失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [workOrders, showToast],
  );

  const handleCompleteWO = useCallback(
    async (payload) => {
      try {
        const res = await workOrders.completeWO(payload);
        // 完工會動到的料件（成品＋BOM 原料）即時更新本地庫存畫面
        (res.updated_items || []).forEach((it) => inventory.applyItem(it));
        const w = res.wo;
        if (w.destination === '入倉庫') {
          showToast(
            `✅ 已完工入庫：${w.wo_id} → ${w.style_no} ×${w.actual_qty}${
              res.bom_used > 0 ? `，並扣 ${res.bom_used} 種原料` : ''
            }`,
          );
        } else {
          showToast(`✅ 已完工：${w.wo_id} → 待出貨（${w.style_no} ×${w.actual_qty}）`);
        }
        return res;
      } catch (e) {
        showToast(`❌ 完工失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [workOrders, inventory, showToast],
  );

  const handleShipWO = useCallback(
    async (woId) => {
      try {
        const res = await workOrders.shipWO(woId);
        showToast(`📦 已登記出貨：${res.wo.wo_id}（${res.wo.style_no}）`);
        return res;
      } catch (e) {
        showToast(`❌ 登記失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [workOrders, showToast],
  );

  // ===== 生產工令（ProductionTab 呼叫） =====
  const handleCreatePO = useCallback(
    async (payload) => {
      try {
        const res = await production.createPO(payload);
        const w = res.wo;
        const alertPart = (res.deduction.alerts || []).length > 0 ? `，⚠️ ${res.deduction.alerts.length} 項庫存提示` : '';
        const yarnPart = (res.yarn_need || []).length > 0
          ? `，領紗 ${res.yarn_need.length} 種${payload.start_now ? `（已扣 ${res.deduction.yarn_used || res.yarn_need.length} 種）` : '（投產時扣）'}`
          : '';
        showToast(
          `✅ 工作令已${payload.start_now ? '開立並投產' : '開立（草稿）'}：${w.wo_id}（${w.style_no} × ${w.plan_qty}頂${yarnPart}${alertPart}）`,
        );
        return res;
      } catch (e) {
        showToast(`❌ 開立失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [production, showToast],
  );

  const handleStartPO = useCallback(
    async (woId, operator) => {
      try {
        const res = await production.startPO(woId, operator);
        const d = res.deduction || {};
        const alertPart = (d.alerts || []).length > 0
          ? `，⚠️ ${(d.alerts || []).join('；')}`
          : '';
        showToast(`🏭 已投產：${woId}，扣減紗線 ${d.yarn_used || 0} 種${alertPart}`);
        return res;
      } catch (e) {
        showToast(`❌ 投產失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [production, showToast],
  );

  const handleCompletePO = useCallback(
    async (payload) => {
      try {
        const res = await production.completePO(payload);
        (res.updated_items || []).forEach((it) => inventory.applyItem(it));
        const w = res.wo;
        if (w.destination === '入倉庫備庫') {
          showToast(
            `✅ 已完工入庫：${w.wo_id} → ${w.style_no} ×${w.actual_good_qty}頂${
              res.bom_used > 0 ? `，並扣 ${res.bom_used} 種非紗線原料` : ''
            }`,
          );
        } else {
          showToast(`✅ 已完工：${w.wo_id} → 待出貨（${w.style_no} ×${w.actual_good_qty}頂），請到「出庫出貨」開單`);
        }
        return res;
      } catch (e) {
        showToast(`❌ 完工失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [production, inventory, showToast],
  );

  const handleShipPO = useCallback(
    async (woId) => {
      try {
        const res = await production.shipPO(woId);
        showToast(`📦 已登記出貨：${res.wo.wo_id}（${res.wo.style_no}）`);
        return res;
      } catch (e) {
        showToast(`❌ 登記失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [production, showToast],
  );

  const handleSaveYarn = useCallback(
    async (payload) => {
      try {
        const res = await production.saveYarn(payload);
        const y = res.yarn;
        showToast(`✅ 紗線已儲存：${y.yarn_code} ${y.yarn_name}（庫存 ${y.stock_kg} KG）`);
        return res;
      } catch (e) {
        showToast(`❌ 儲存失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [production, showToast],
  );

  // ===== 🚢 出貨排程（ScheduleTab 呼叫：計畫層看板，不扣庫存） =====
  // 行事曆同步結果 → toast 尾綴；「未設定」代表後端 SCHEDULE_CALENDAR_ID 尚未填
  const scheduleCalSuffix = useCallback((status) => {
    const s = String(status || '').trim();
    if (s === '已同步') return '，已同步共用 Google 日曆';
    if (s === '未設定') return '（日曆未設定：後端 SCHEDULE_CALENDAR_ID 留空）';
    if (s === '已刪除') return '，日曆事件已刪除';
    if (s.startsWith('失敗')) return ` ⚠️ 日曆同步失敗（${s.slice(3)}）`;
    return '';
  }, []);

  const handleCreateSchedule = useCallback(
    async (payload) => {
      try {
        const res = await schedule.createSchedule(payload);
        const s = res.schedule;
        showToast(`✅ 排程已建立：${s.schedule_id}（${s.order_no}，出貨日 ${s.ship_date}）${scheduleCalSuffix(res.calendar_status)}`);
        return res;
      } catch (e) {
        showToast(`❌ 新增排程失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [schedule, showToast, scheduleCalSuffix],
  );

  const handleUpdateSchedule = useCallback(
    async (scheduleId, payload) => {
      try {
        const res = await schedule.updateSchedule({ schedule_id: scheduleId, ...payload });
        const s = res.schedule;
        showToast(`✅ 排程已更新：${s.order_no || s.schedule_id}（出貨日 ${s.ship_date}）${scheduleCalSuffix(res.calendar_status)}`);
        return res;
      } catch (e) {
        showToast(`❌ 更新排程失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [schedule, showToast, scheduleCalSuffix],
  );

  const handleMarkScheduleShipped = useCallback(
    async (s) => {
      try {
        const res = await schedule.markShipped(s.schedule_id);
        showToast(`📦 已標記出貨：${res.schedule.order_no || res.schedule.schedule_id}${scheduleCalSuffix(res.calendar_status)}`);
        return res;
      } catch (e) {
        showToast(`❌ 標記失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [schedule, showToast, scheduleCalSuffix],
  );

  const handleCancelSchedule = useCallback(
    async (s) => {
      try {
        const res = await schedule.cancelSchedule(s.schedule_id);
        showToast(`🗑 已取消排程：${res.schedule.order_no || res.schedule.schedule_id}${scheduleCalSuffix(res.calendar_status)}`);
        return res;
      } catch (e) {
        showToast(`❌ 取消失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [schedule, showToast, scheduleCalSuffix],
  );

  const handleResyncSchedule = useCallback(
    async () => {
      try {
        const res = await schedule.resync();
        return res;
      } catch (e) {
        showToast(`❌ 重新同步失敗：${e.message}`, 'error');
        throw e;
      }
    },
    [schedule, showToast],
  );

  // 🌍 訪客展示路由：#/lookbook 只渲染純展示圖鑑（無登入／無分頁／無內部功能）
  if (guestRoute) {
    return (
      <>
        <LookbookPublic />
        <Toast toast={toast} onDone={() => setToast(null)} />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-100">
      {/* ===== 頂部標題列 ===== */}
      <header className="shrink-0 bg-blue-700 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 text-white">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-extrabold tracking-wide">🧶 帽廠庫存管家</h1>
          <button
            onClick={handleSync}
            className="min-h-touch flex items-center gap-1 rounded-xl bg-white/10 px-3 text-sm font-bold text-white transition active:bg-white/20"
          >
            <span className={inventory.loading || workOrders.loading || production.loading || schedule.loading ? 'animate-spin' : ''}>⟳</span> 同步
          </button>
        </div>
        <p className="mt-1 text-xs text-blue-200">
          {inventory.lastSync
            ? `最後同步：${inventory.lastSync.toLocaleTimeString('zh-TW')} · 共 ${inventory.items.length} 筆料件`
            : '尚未同步雲端庫存（請先到「設定」填 API 網址）'}
        </p>
      </header>

      {/* ===== 內容區 ===== */}
      <main className="flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-28">
        {tab === 'search' && (
          <SearchTab
            items={inventory.items}
            loading={inventory.loading}
            error={inventory.error}
            query={query}
            setQuery={setQuery}
            dueWos={workOrders.dueWos}
            goToWorkOrders={() => setTab('wo')}
            onOpenScanner={() => openScanner('search')}
            goToSettings={() => setTab('settings')}
            onPhotoUploaded={handlePhotoUploaded}
            showToast={showToast}
          />
        )}
        {tab === 'action' && (
          <ActionTab
            items={inventory.items}
            onSubmit={handleSubmitLog}
            onBatchSubmit={handleBatchSubmit}
            onOpenScanner={() => openScanner('action')}
            scanResult={scanFor === null ? scanResult : null} // 掃碼結束才套用，避免重複觸發
            showToast={showToast}
            onPhotoUploaded={handlePhotoUploaded}
          />
        )}
        {tab === 'wo' && (
          <WorkOrderTab
            wos={workOrders.wos}
            items={inventory.items}
            loading={workOrders.loading}
            error={workOrders.error}
            showToast={showToast}
            onCreateWO={handleCreateWO}
            onCompleteWO={handleCompleteWO}
            onShipWO={handleShipWO}
            bomFor={workOrders.bomFor}
            onRefresh={workOrders.refresh}
            goToSettings={() => setTab('settings')}
          />
        )}
        {tab === 'pwo' && (
          <ProductionTab
            pos={production.pos}
            yarns={production.yarns}
            items={inventory.items}
            bomFor={workOrders.bomFor}
            loading={production.loading}
            error={production.error}
            showToast={showToast}
            onCreatePO={handleCreatePO}
            onStartPO={handleStartPO}
            onCompletePO={handleCompletePO}
            onShipPO={handleShipPO}
            onSaveYarn={handleSaveYarn}
            onRefresh={production.refresh}
            goToSettings={() => setTab('settings')}
          />
        )}
        {tab === 'ship' && (
          <ShipmentTab
            items={inventory.items}
            scanResult={scanFor === 'ship' ? scanResult : null}
            showToast={showToast}
            onItemsUpdated={inventory.applyItem}
            onOpenScanner={() => openScanner('ship')}
            goToSettings={() => setTab('settings')}
          />
        )}
        {tab === 'sched' && (
          <ScheduleTab
            schedules={schedule.schedules}
            loading={schedule.loading}
            error={schedule.error}
            showToast={showToast}
            onCreate={handleCreateSchedule}
            onUpdate={handleUpdateSchedule}
            onMarkShipped={handleMarkScheduleShipped}
            onCancel={handleCancelSchedule}
            onResync={handleResyncSchedule}
            onRefresh={schedule.refresh}
            goToSettings={() => setTab('settings')}
          />
        )}
        {tab === 'hygiene' && <HygieneTab showToast={showToast} />}
        {tab === 'logs' && (
          <StockLogTab
            logs={logs.logs}
            loading={logs.loading}
            error={logs.error}
            refresh={logs.refresh}
            showToast={showToast}
            onItemsUpdated={(it) => inventory.applyItem(it)}
          />
        )}
        {tab === 'book' && (
          <LookbookTab
            items={inventory.items}
            onItemsUpdated={inventory.applyItem}
            showToast={showToast}
          />
        )}
        {tab === 'report' && <AnalyticsTab showToast={showToast} />}
        {tab === 'settings' && (
          <SettingsTab
            showToast={showToast}
            onSaved={() => inventory.refresh()}
          />
        )}
      </main>

      {/* ===== 底部分頁導覽（大按鈕、好戴手套點擊；收進「⋯ 更多」見 PRIMARY_TAB_KEYS） ===== */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-lg justify-around pb-[env(safe-area-inset-bottom)]">
          {/* 🎭 角色分權：只渲染此經辦可用的分頁；AnalyticsTab／StockLogTab 內另有第二道權限防護 */}
          {mainTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex min-h-touch flex-1 flex-col items-center justify-center py-2 text-xs font-bold transition ${
                tab === t.key ? 'text-blue-700' : 'text-slate-400'
              }`}
            >
              <span className="mb-0.5 text-2xl leading-none">{t.icon}</span>
              {t.label}
              {tab === t.key && <span className="mt-0.5 h-1 w-6 rounded-full bg-blue-700" />}
            </button>
          ))}
          {/* ⋯ 更多：收納生產工令／工單管理／品項健檢／紀錄／款式圖鑑／營運報表等 */}
          {moreTabs.length > 0 && (
            <button
              onClick={() => setShowMore((v) => !v)}
              className={`flex min-h-touch flex-1 flex-col items-center justify-center py-2 text-xs font-bold transition ${
                inMoreMenu ? 'text-blue-700' : 'text-slate-400'
              }`}
            >
              <span className="mb-0.5 text-2xl leading-none">⋯</span>
              更多
              {inMoreMenu && <span className="mt-0.5 h-1 w-6 rounded-full bg-blue-700" />}
            </button>
          )}
        </div>
      </nav>

      {/* ===== ⋯ 更多功能選單（底部抽屜） ===== */}
      {showMore && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/50 p-4"
          onClick={() => setShowMore(false)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-extrabold text-slate-800">⋯ 更多功能</h3>
              <button className="px-2 text-slate-400" onClick={() => setShowMore(false)}>✕</button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {moreTabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => {
                    setTab(t.key);
                    setShowMore(false);
                  }}
                  className={`flex min-h-touch flex-col items-center justify-center gap-1 rounded-2xl py-3 text-xs font-bold transition active:scale-[0.97] ${
                    tab === t.key ? 'bg-blue-50 text-blue-700' : 'bg-slate-50 text-slate-600 active:bg-slate-200'
                  }`}
                >
                  <span className="text-2xl leading-none">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== 相機掃碼（全螢幕覆蓋層） ===== */}
      {scanFor && (
        <Scanner
          open
          onClose={closeScanner}
          onResult={handleScanResult}
          title={scanFor === 'search' ? '掃碼查庫存' : scanFor === 'ship' ? '掃碼加入出貨明細' : '掃碼填入品號'}
        />
      )}

      {/* ===== Toast 提示 ===== */}
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
