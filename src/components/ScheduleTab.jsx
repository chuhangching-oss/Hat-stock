import { useEffect, useMemo, useState } from 'react';
import { gasRequest, getGasUrl } from '../api';

/** 今天（手機本地時區）的 YYYY-MM-DD */
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 距離目標日還有幾天（目標<今天 → 負數；同一天 → 0） */
function daysTo(dateStr) {
  if (!dateStr) return null;
  const t = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  const n = new Date(`${todayYMD()}T00:00:00`);
  if (isNaN(t.getTime())) return null;
  return Math.round((t.getTime() - n.getTime()) / 86400000);
}

const EMPTY_FORM = {
  order_no: '',
  customer_name: '',
  material_due: '',
  acc_flag: '自備',
  acc_due: '',
  label_flag: '自備',
  label_due: '',
  factory_complete: '',
  ship_date: '',
  details: '',
  remark: '',
};

/**
 * 🚢 出貨倒數分頁（收到訂單後的排程動作；計畫層看板，不扣庫存）
 * - 每張訂單五節點：🧵原料 → 🧷配件(客供/自備) → 🏷️洗標吊牌(客供/自備) → 🏭場內完成 → 🚢出貨
 * - 只有「預計出貨日」同步共用 Google Calendar（後端 Code.gs SCHEDULE_CALENDAR_ID）
 * - 四人皆可新增／修改／標記出貨／取消；經辦自動記錄
 */
export default function ScheduleTab({
  schedules,
  loading,
  error,
  showToast,
  onCreate,
  onUpdate,
  onMarkShipped,
  onCancel,
  onResync,
  onRefresh,
  goToSettings,
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null); // 排程物件（編輯中）
  const [form, setForm] = useState(EMPTY_FORM);
  const [customers, setCustomers] = useState([]); // 客戶清單（datalist 提示用）
  const [saving, setSaving] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [showShipped, setShowShipped] = useState(false); // 是否顯示已出貨/已取消歷史

  // 客戶清單：與出庫出貨分頁同一份 CUSTOMERS
  useEffect(() => {
    const url = getGasUrl();
    if (!url) return;
    gasRequest(url, { action: 'list_customers' })
      .then((list) => setCustomers(Array.isArray(list) ? list : []))
      .catch(() => {}); // 客戶提示拉不到不阻擋主功能
  }, []);

  // 節奏：待出貨在前（後端已依出貨日排序）；歷史折疊顯示
  const active = useMemo(
    () => schedules.filter((s) => s.status === '待出貨'),
    [schedules],
  );
  const history = useMemo(
    () => schedules.filter((s) => s.status !== '待出貨'),
    [schedules],
  );
  const urgent7 = active.filter((s) => {
    const d = daysTo(s.ship_date);
    return d !== null && d <= 7;
  }).length;

  const calNotSet = schedules.some((s) => s.calendar_status === '未設定');
  const calFail = schedules.filter(
    (s) => s.status === '待出貨' && String(s.calendar_status || '').startsWith('失敗'),
  );

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(s) {
    setEditing(s);
    setForm({
      order_no: s.order_no || '',
      customer_name: s.customer_name || '',
      material_due: s.material_due || '',
      acc_flag: s.acc_flag || '自備',
      acc_due: s.acc_due || '',
      label_flag: s.label_flag || '自備',
      label_due: s.label_due || '',
      factory_complete: s.factory_complete || '',
      ship_date: s.ship_date || '',
      details: s.details || '',
      remark: s.remark || '',
    });
    setShowForm(true);
  }

  function setField(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleSave() {
    if (!form.ship_date) {
      return showToast('❌ 預計出貨日為必填', 'error');
    }
    if (form.material_due && form.ship_date && form.material_due > form.ship_date) {
      showToast('⚠️ 原料到期日晚於出貨日，請再確認');
    }
    setSaving(true);
    try {
      if (editing) {
        await onUpdate(editing.schedule_id, form);
      } else {
        await onCreate(form);
      }
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (e) {
      // 錯誤 toast 已由 App 層顯示；保持表單內容讓使用者修正
    } finally {
      setSaving(false);
    }
  }

  async function handleShipped(s) {
    if (!window.confirm(`確認「${s.order_no || s.schedule_id}」已出貨？`)) return;
    try {
      await onMarkShipped(s);
    } catch (e) {
      /* toast 已由 App 顯示 */
    }
  }

  async function handleCancel(s) {
    if (!window.confirm(`確定取消排程「${s.order_no || s.schedule_id}」？\n（同步的 Google 日曆事件會一併刪除）`)) return;
    try {
      await onCancel(s);
    } catch (e) {
      /* toast 已由 App 顯示 */
    }
  }

  async function handleResync() {
    setResyncing(true);
    try {
      const res = await onResync();
      showToast(`⟳ 已完成對帳：${res.message}`);
    } catch (e) {
      /* toast 已由 App 顯示 */
    } finally {
      setResyncing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ===== 說明／行事曆狀態提示 ===== */}
      {calNotSet && (
        <div className="rounded-3xl bg-amber-50 p-4 text-sm font-semibold text-amber-700 shadow-card ring-1 ring-amber-200">
          ℹ️ 尚未啟用 Google 日曆同步：請在後端 Code.gs 的 <code>SCHEDULE_CALENDAR_ID</code> 填入共用行事曆 ID（詳見設定分頁部署小抄）。排程功能本身照常可用。
        </div>
      )}
      {calFail.length > 0 && (
        <div className="rounded-3xl bg-red-50 p-4 text-sm font-semibold text-red-700 shadow-card ring-1 ring-red-200">
          ⚠️ 有 {calFail.length} 筆排程的行事曆同步失敗（每日 06:00 會自動補推）。可按下方「⟳ 重新同步」立即補推。
        </div>
      )}

      {/* ===== 統計＋操作列 ===== */}
      <div className="rounded-3xl bg-white p-5 shadow-card">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-slate-800">🚢 出貨倒數</h2>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          收到訂單後排定五節點日期；只有「預計出貨日」會同步到共用 Google 日曆
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-2xl bg-red-50 py-3">
            <div className="text-2xl font-extrabold text-red-600">{urgent7}</div>
            <div className="text-xs font-bold text-red-400">7 天內要出</div>
          </div>
          <div className="rounded-2xl bg-blue-50 py-3">
            <div className="text-2xl font-extrabold text-blue-700">{active.length}</div>
            <div className="text-xs font-bold text-blue-400">排程中訂單</div>
          </div>
          <div className="rounded-2xl bg-slate-100 py-3">
            <div className="text-2xl font-extrabold text-slate-500">{history.length}</div>
            <div className="text-xs font-bold text-slate-400">已出貨/取消</div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button className="btn-primary flex-1" onClick={openCreate}>
            ➕ 新增排程
          </button>
          <button
            className="min-h-touch rounded-2xl bg-slate-100 px-4 text-sm font-extrabold text-slate-600 transition active:bg-slate-200"
            onClick={handleResync}
            disabled={resyncing}
          >
            {resyncing && <span className="animate-spin">⟳</span>} 重新同步
          </button>
        </div>
      </div>

      {/* ===== 新增／編輯表單 ===== */}
      {showForm && (
        <div className="space-y-3 rounded-3xl bg-white p-5 shadow-card">
          <h3 className="text-lg font-extrabold text-slate-800">
            {editing ? `✏️ 編輯排程 ${editing.order_no || editing.schedule_id}` : '➕ 新增出貨排程'}
          </h3>

          <div>
            <label className="field-label">客戶（可從客戶清單帶入或自由輸入）</label>
            <input
              className="field-input"
              list="sched-customers"
              placeholder="例：MOONBAT"
              value={form.customer_name}
              onChange={(e) => setField('customer_name', e.target.value)}
            />
            <datalist id="sched-customers">
              {customers.map((c) => (
                <option key={c.customer_id} value={c.customer_name} />
              ))}
            </datalist>
          </div>

          <div>
            <label className="field-label">訂單編號（留空自動編 PO）</label>
            <input
              className="field-input"
              placeholder="例：PO-2026-0891"
              value={form.order_no}
              onChange={(e) => setField('order_no', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">🧵 原料到期日</label>
              <input
                className="field-input"
                type="date"
                value={form.material_due}
                onChange={(e) => setField('material_due', e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">🧷 配件到期日</label>
              <input
                className="field-input"
                type="date"
                value={form.acc_due}
                onChange={(e) => setField('acc_due', e.target.value)}
              />
              <label className="mt-2 flex items-center gap-2 text-sm font-bold text-slate-600">
                配件來源：
                <select
                  className="rounded-xl border-2 border-slate-200 px-2 py-1 font-bold focus:border-blue-600"
                  value={form.acc_flag}
                  onChange={(e) => setField('acc_flag', e.target.value)}
                >
                  <option value="自備">自備</option>
                  <option value="客供">客供</option>
                </select>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">🏷️ 洗標吊牌到期日</label>
              <input
                className="field-input"
                type="date"
                value={form.label_due}
                onChange={(e) => setField('label_due', e.target.value)}
              />
              <label className="mt-2 flex items-center gap-2 text-sm font-bold text-slate-600">
                來源：
                <select
                  className="rounded-xl border-2 border-slate-200 px-2 py-1 font-bold focus:border-blue-600"
                  value={form.label_flag}
                  onChange={(e) => setField('label_flag', e.target.value)}
                >
                  <option value="自備">自備</option>
                  <option value="客供">客供</option>
                </select>
              </label>
            </div>
            <div>
              <label className="field-label">🏭 場內預計完成</label>
              <input
                className="field-input"
                type="date"
                value={form.factory_complete}
                onChange={(e) => setField('factory_complete', e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-400">要指定時間請在備註註明（例：下午 3 點前）</p>
            </div>
          </div>

          <div>
            <label className="field-label">🚢 預計出貨日（必填・同步 Google 日曆）</label>
            <input
              className="field-input"
              type="date"
              value={form.ship_date}
              onChange={(e) => setField('ship_date', e.target.value)}
            />
          </div>

          <div>
            <label className="field-label">明細（一行一項：款號 × 數量）</label>
            <textarea
              className="field-input min-h-[7rem]"
              placeholder={'111AG20/6090R × 500\nCAS902/7022 × 120'}
              value={form.details}
              onChange={(e) => setField('details', e.target.value)}
            />
          </div>

          <div>
            <label className="field-label">備註（船名航次／港口／時間點…）</label>
            <input
              className="field-input"
              placeholder="例：趕船期 YM INCEPTION 11/30"
              value={form.remark}
              onChange={(e) => setField('remark', e.target.value)}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              className="btn-secondary flex-1"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
                setForm(EMPTY_FORM);
              }}
            >
              取消
            </button>
            <button className="btn-primary flex-1" onClick={handleSave} disabled={saving}>
              {saving && <span className="animate-spin">⟳</span>}
              💾 儲存{editing ? '變更' : '並同步日曆'}
            </button>
          </div>
        </div>
      )}

      {/* ===== 排程卡片清單 ===== */}
      {error && (
        <div className="rounded-3xl bg-red-50 p-4 text-sm font-semibold text-red-600 shadow-card" onClick={onRefresh}>
          ❌ {error}（點此重試）
        </div>
      )}

      {loading && <LoadingList />}
      {!loading && active.length === 0 && !error && (
        <div className="rounded-3xl bg-white p-8 text-center text-slate-400 shadow-card">
          目前沒有排程中的訂單。<br />
          收到訂單時按「➕ 新增排程」開始倒數 🚢
        </div>
      )}

      {!loading && active.map((s) => (
        <ScheduleCard
          key={s.schedule_id}
          s={s}
          onShipped={() => handleShipped(s)}
          onEdit={() => openEdit(s)}
          onCancel={() => handleCancel(s)}
        />
      ))}

      {/* 已出貨／已取消歷史（摺疊） */}
      {!loading && history.length > 0 && (
        <details className="rounded-3xl bg-white p-5 shadow-card">
          <summary className="cursor-pointer text-base font-extrabold text-slate-600">
            📜 歷史排程（{history.length} 筆）
          </summary>
          <div className="mt-3 space-y-3">
            {history.map((s) => (
              <ScheduleCard
                key={s.schedule_id}
                s={s}
                compact
                onEdit={() => openEdit(s)}
              />
            ))}
          </div>
        </details>
      )}

      {goToSettings && (
        <button className="mx-auto block text-xs font-bold text-blue-600 underline" onClick={goToSettings}>
          API 連線設定 → 到「設定」分頁
        </button>
      )}
    </div>
  );
}

/** 轉動中的骨架卡片 */
function LoadingList() {
  return (
    <>
      {[0, 1].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-3xl bg-white/60 shadow-card" />
      ))}
    </>
  );
}

/** 五節點進度列：原料 → 配件 → 洗吊 → 場內 → 出貨 */
function StageStrip({ s }) {
  const today = todayYMD();
  const nodes = [
    { label: '🧵原料', date: s.material_due, extra: '' },
    { label: '🧷配件', date: s.acc_due, extra: s.acc_flag ? `（${s.acc_flag}）` : '' },
    { label: '🏷️洗吊', date: s.label_due, extra: s.label_flag ? `（${s.label_flag}）` : '' },
    { label: '🏭場內', date: (s.factory_complete || '').slice(0, 10), extra: (s.factory_complete || '').slice(10).trim() ? (s.factory_complete || '').slice(10).trim() : '' },
    { label: '🚢出貨', date: s.ship_date, extra: '' },
  ];
  return (
    <div className="mt-2.5 flex gap-1">
      {nodes.map((n, i) => {
        const state = !n.date ? 'none' : n.date < today ? 'done' : n.date === today ? 'now' : 'todo';
        return (
          <div
            key={i}
            className={`flex-1 rounded-lg px-1 py-1.5 text-center text-[10px] font-bold leading-tight ring-1 ${
              state === 'done'
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : state === 'now'
                ? 'bg-blue-50 text-blue-700 ring-blue-300'
                : state === 'todo'
                ? 'bg-slate-50 text-slate-500 ring-slate-200'
                : 'bg-slate-50/50 text-slate-300 ring-slate-100'
            }`}
          >
            {n.label}
            {state === 'done' ? ' ✓' : ''}
            <br />
            <span className="font-semibold">{n.date ? n.date.slice(5) : '—'}</span>
            {n.extra && <><br /><span className="font-semibold opacity-80">{n.extra}</span></>}
          </div>
        );
      })}
    </div>
  );
}

/** 單張排程卡片 */
function ScheduleCard({ s, compact, onShipped, onEdit, onCancel }) {
  const shipped = s.status === '已出貨';
  const cancelled = s.status === '已取消';
  const d = daysTo(s.ship_date);
  const urgent = !shipped && !cancelled && d !== null && d <= 3;
  const warn = !shipped && !cancelled && d !== null && d > 3 && d <= 7;
  const overdue = !shipped && !cancelled && d !== null && d < 0;
  const calSyncFailed = String(s.calendar_status || '').startsWith('失敗') && !cancelled;

  return (
    <div
      className={`rounded-3xl bg-white p-4 shadow-card ${
        urgent || overdue ? 'ring-2 ring-red-300' : warn ? 'ring-2 ring-amber-200' : ''
      } ${shipped ? 'opacity-70' : ''}`}
    >
      <div className="flex items-center gap-2">
        {shipped ? (
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-extrabold text-emerald-700">✅ 已出貨</span>
        ) : cancelled ? (
          <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-extrabold text-slate-500">🚫 已取消</span>
        ) : overdue ? (
          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-extrabold text-red-600">⚠️ 逾期 {Math.abs(d)} 天</span>
        ) : urgent ? (
          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-extrabold text-red-600">
            ⏰ {d === 0 ? '今天出貨' : `${d} 天內`}
          </span>
        ) : warn ? (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-extrabold text-amber-700">📅 {d} 天</span>
        ) : (
          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-extrabold text-blue-600">
            📅 {d !== null ? `${d} 天` : '未定'}
          </span>
        )}

        {s.customer_name && (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-extrabold text-slate-600">
            {s.customer_name}
          </span>
        )}
        {calSyncFailed && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-700">
            日曆同步失敗
          </span>
        )}

        {!compact && !shipped && !cancelled && (
          <div className="ml-auto text-right">
            <div className={`text-3xl font-extrabold leading-none ${urgent ? 'text-red-600' : warn ? 'text-amber-500' : 'text-slate-700'}`}>
              {d !== null ? d : '—'}
            </div>
            <div className="text-[10px] font-bold text-slate-400">天後出貨</div>
          </div>
        )}
      </div>

      <p className="mt-2.5 text-lg font-extrabold text-slate-800">{s.order_no || s.schedule_id}</p>
      {(s.details || s.remark) && (
        <p className="mt-1 whitespace-pre-line text-sm font-semibold text-slate-500">
          {s.details}
          {s.details && s.remark && '　·　'}
          {s.remark}
        </p>
      )}
      {s.operator && <p className="mt-1 text-[10px] font-bold text-slate-300">經辦：{s.operator}</p>}

      <StageStrip s={s} />

      {!compact && (
        <div className="mt-3 flex gap-2">
          {!shipped && !cancelled && (
            <>
              <button className="btn-primary flex-1 !min-h-0 !py-2.5 text-sm" onClick={onShipped}>
                ✅ 標記已出貨
              </button>
              <button
                className="min-h-touch rounded-2xl bg-slate-100 px-4 text-sm font-extrabold text-slate-600 transition active:bg-slate-200"
                onClick={onEdit}
              >
                ✏️ 改期
              </button>
              <button
                className="min-h-touch rounded-2xl bg-red-50 px-3 text-sm font-extrabold text-red-500 transition active:bg-red-100"
                onClick={onCancel}
              >
                🗑
              </button>
            </>
          )}
          {(shipped || cancelled) && (
            <button className="btn-secondary flex-1 !min-h-0 !py-2.5 text-sm" onClick={onEdit}>
              檢視／編輯
            </button>
          )}
        </div>
      )}
    </div>
  );
}
