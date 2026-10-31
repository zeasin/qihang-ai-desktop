import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './styles/global.css';

// 纯浏览器 dev 预览垫片：npm run dev（不开 Electron）时提供示例数据，
// 便于 UI 开发调试；打包与 Electron 运行完全不受影响。
if (import.meta.env.DEV && !(window as any).electronAPI) {
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const isoH = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const fixtureEvents: Record<string, Function[]> = {};
  const fixture = {
    platform: 'win32',
    app: { firstRun: async () => ({ firstRun: false }), version: async () => '0.9.0' },
    kb: {
      list: async () => [
        { id: 1, name: '旗舰店运营', dir: 'C:/demo/notes', is_default: 1 },
        { id: 2, name: '供应链', dir: 'C:/demo/supply', is_default: 0 },
      ],
      getDefault: async () => ({ id: 1, name: '旗舰店运营', dir: 'C:/demo/notes' }),
      setDefault: async () => ({}),
    },
    service: { status: async () => ({ feishu: true, scheduler: true }) },
    todo: {
      list: async () => [
        { id: 1, title: '核对昨日订单与库存差异', status: 'pending', priority: 'high', due_date: '' },
        { id: 2, title: '回复供应商的报价邮件', status: 'pending', priority: 'mid', due_date: '' },
        { id: 3, title: '确认双 11 预热文案终稿', status: 'pending', priority: 'mid', due_date: '' },
        { id: 4, title: '核对竞品降价清单', status: 'done', priority: 'mid', due_date: '' },
      ],
      add: async () => ({ id: 9 }), update: async () => ({}), remove: async () => ({}),
    },
    task: (() => {
      const tasks: any[] = [
        { id: 1, title: '生成综合日报', status: 'pending', priority: 'mid', trigger_type: 'cycle', cycle_type: 'daily', cycle_time: '22:00', cycle_value: '', project_id: 1, source: 'system', last_run_at: iso(1), last_status: 'SUCCESS', created_at: iso(3), notify_feishu: 1, output_target: '', scheduled_start: '', description: '内置任务：每天定时聚合所有笔记库与数据集生成综合日报。', prompt: '', session_id: 's1', task_type: 'daily_report' },
        { id: 2, title: '竞品价格巡检', status: 'pending', priority: 'mid', trigger_type: 'cycle', cycle_type: 'daily', cycle_time: '08:00', cycle_value: '', project_id: 1, source: 'ui', last_run_at: iso(1), last_status: 'SUCCESS', created_at: iso(5), notify_feishu: 0, output_target: '', scheduled_start: '', description: '', prompt: '抓取三个竞品的价格页，更新「竞品价格」数据集。', session_id: '', task_type: 'note' },
      ];
      return {
        list: async () => tasks,
        add: async (data: any) => {
          const id = Math.max(0, ...tasks.map((t) => t.id)) + 1;
          tasks.unshift({ ...data, id, last_run_at: '', last_status: '', created_at: iso(0), source: 'ui' });
          return { id };
        },
        update: async (id: number, data: any) => {
          const t = tasks.find((x) => x.id === id);
          if (t) Object.assign(t, data);
        },
        remove: async (id: number) => {
          const i = tasks.findIndex((x) => x.id === id);
          if (i >= 0) tasks.splice(i, 1);
        },
        execute: async (id: number) => {
          const t = tasks.find((x) => x.id === id);
          if (t) { t.status = 'done'; t.last_run_at = iso(0); t.last_status = 'SUCCESS'; }
          return true;
        },
        followup: async () => { throw new Error('任务不支持追问'); }, executions: async () => [],
        executionList: async () => ({ total: 0, rows: [] }),
      };
    })(),
    chat: (() => {
      const sessions: any[] = [
        { session_id: 's1', id: 's1', title: '竞品价格调研', source: 'ui', mode: 'general', project_id: 1, last_message: '一周内三个竞品都有动作…', created_at: iso(2), updated_at: isoH(5) },
        { session_id: 's2', id: 's2', title: '「帮我看看这周销量」', source: 'feishu', mode: 'general', project_id: 1, last_message: '已读取销售数据…', created_at: iso(1), updated_at: isoH(1) },
        { session_id: 's3', id: 's3', title: '物流时效跟进', source: 'ui', mode: 'general', project_id: 2, last_message: '华东线路恢复 48 小时达', created_at: iso(4), updated_at: iso(2) },
      ];
      const messages: Record<string, any[]> = {
        s1: [
          { role: 'user', content: '拉一下三个竞品最近一周的价格变化，重点看降幅。', created_at: iso(0) },
          { role: 'assistant', content: '一周内三个竞品都有动作，核心结论：**竞品 A 降价 6.2%，已低于我们的到手价**。\n\n- 竞品 A：329 → 309，降幅 6.2%，10-28 生效\n- 竞品 B：价格持平 359，新增赠品\n- 竞品 C：价格持平 349，满减门槛降低', created_at: iso(0) },
        ],
      };
      return {
        getSessions: async () => sessions,
        getSessionsBySource: async (source: string) => sessions.filter((s) => s.source === source),
        getMessages: async (sid: string) => messages[sid] || [],
        createSession: async (id: string, projectId: number | null) => {
          sessions.unshift({ session_id: id, id, title: '新对话', source: 'ui', mode: 'general', project_id: projectId, last_message: '', created_at: iso(0), updated_at: iso(0) });
          return { session_id: id, id, title: '新对话', source: 'ui', mode: 'general', project_id: projectId };
        },
        deleteSession: async (sid: string) => {
          const i = sessions.findIndex((s) => s.session_id === sid);
          if (i >= 0) sessions.splice(i, 1);
          delete messages[sid];
        },
        send: async (text: string, sid: string) => {
          (messages[sid] ||= []).push({ role: 'user', content: text, created_at: iso(0) });
          const s = sessions.find((x) => x.session_id === sid);
          if (s) { s.last_message = text.slice(0, 30); s.updated_at = iso(0); }
          setTimeout(() => {
            const fire = (ch: string, d: any) => ((fixtureEvents[ch] || []) as Function[]).forEach((cb) => cb(d));
            fire('chat:status', { sessionId: sid, text: '思考中…' });
            fire('chat:delta', { sessionId: sid, text: '（浏览器预览模式）这是一条示例回复；在 Electron 里运行会连接本地引擎真实执行。\n\n你说的是：**' + text.slice(0, 40) + '**' });
            (messages[sid] ||= []).push({ role: 'assistant', content: '（浏览器预览模式）这是一条示例回复；在 Electron 里运行会连接本地引擎真实执行。\n\n你说的是：**' + text.slice(0, 40) + '**', created_at: iso(0) });
            fire('chat:done', { sessionId: sid });
          }, 400);
        },
      };
    })(),
    project: { list: async () => [{ id: 1, name: '旗舰店运营', dir: 'C:/demo/notes', is_default: 1 }] },
    ds: {
      pendingRecords: async () => [
        { datasetId: 3, datasetName: '项目工单', records: [{ id: 1, _created_at: iso(0) }, { id: 2, _created_at: iso(0) }, { id: 3, _created_at: iso(1) }] },
      ],
    },
    reminder: {
      list: async () => [
        { id: 'r1', name: '核对今日销量', message: '', type: 'once', time: '21:45', date: '', day_of_week: 1, day_of_month: 1, month_day: '', enabled: 1, created_at: '' },
      ],
    },
    insights: {
      stats: async () => ({ fileCount: 0, notesFileCount: 324, todayModified: 4, projectCount: 2, totalChats: 21, todoPending: 5, todoOverdue: 1, remindersActive: 1, todayDataRecords: 12 }),
      reports: async () => [
        { id: 1, report_date: '2026-10-30', created_at: iso(1), summary: '今日完成订单核对 42 单；竞品 A 降价 6.2% 已记录；双 11 素材进入终审。', content: '# 综合日报\n## 今日概览\n订单核对 42 单，售后关闭 3 个。' },
      ],
    },
    noteDigest: {
      extract: async () => ({
        todos: [
          { file: '1015 运营记录.md', line: 12, text: '跟进孟总 ERP 源码合同回签与首付款', done: false },
          { file: '1015 运营记录.md', line: 15, text: 'CRM #131 状态改回跟进中', done: false },
        ],
        followups: [
          { file: '跟进记录.md', line: 8, text: '等供应商回传报价单' },
          { file: '跟进记录.md', line: 9, text: '确认物流时效' },
        ],
        logs: [
          { file: '2026-10-30.md', line: 1, date: '2026-10-30', preview: '今日完成 6 项待办，补货单已提交。' },
        ],
        scannedFiles: 324,
        generated_at: new Date().toISOString(),
      }),
      syncDone: async () => ({ touched: 0 }),
    },
    pi: { models: async () => ({ models: [] }) },
  };
  (window as any).electronAPI = new Proxy(fixture, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      if (prop === 'on') return (ch: string, cb: Function) => { (fixtureEvents[ch] ||= []).push(cb); };
      if (prop === 'removeAllListeners') return (ch: string) => { delete fixtureEvents[ch]; };
      return () => Promise.resolve([]);
    },
  });
}

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
