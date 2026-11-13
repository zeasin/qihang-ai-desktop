<!--
  AgentRadarView —— 智能体雷达（三段式仪表盘，对齐 AgentHub 监控台布局）
  ① 工具卡片状态 ② 最近状态跃迁 ③ 最近活跃会话（点击进入会话详情页）
  数据来自主进程 radar IPC（本地 SQLite，只读连接），不出机器。
-->
<template>
  <div class="radar-view">
    <!-- 头部 -->
    <div class="content-header">
      <div>
        <h1>智能体雷达</h1>
        <div class="text-muted header-sub">
          监控本机其他 AI 工具的运行状态，会话对话自动存档在本地 · 数据不出机器
        </div>
      </div>
      <div class="header-actions">
        <input
          v-model="keyword"
          type="text"
          class="form-control search-input"
          placeholder="全文搜索所有对话…"
          @input="onSearchInput"
        />
        <span v-if="status.running" class="badge badge-success">监控中</span>
        <span v-else-if="status.enabled" class="badge badge-gray">启动中…</span>
        <span v-else class="badge badge-gray">未开启</span>
        <span v-if="status.stats" class="text-muted collect-info">
          已采 {{ status.stats.sessions }} 会话 · {{ status.stats.messages }} 条<template v-if="status.lastRound?.finishedAt"> · 上次采集 {{ fmtClock(status.lastRound.finishedAt) }}</template>
        </span>
        <button class="btn btn-secondary btn-sm" :disabled="scanning || !status.running" @click="scanNow">
          {{ scanning ? '扫描中…' : '立即扫描' }}
        </button>
        <span v-if="pendingStatus" class="badge" :class="pendingStatus.startsWith('✅') ? 'badge-success' : 'badge-danger'">{{ pendingStatus }}</span>
      </div>
    </div>

    <!-- 审批（雷达子功能；飞书不可用/离线时在此决策，与飞书卡片同一决策状态机） -->
    <div v-if="pending.length" class="section approval-sec">
      <div class="sec-title"><i class="bar bar-warn"></i>
        待审批 · {{ pending.length }} 条
        <span v-if="!feishuOn" class="text-muted" style="font-size:12px;font-weight:400;margin-left:6px;">（飞书未启用，仅桌面可决策）</span>
      </div>
      <div class="approval-table">
        <div v-for="a in pending" :key="a.id" class="approval-row">
          <div class="ap-main" @click="toggleDetail(a.id)">
            <div class="ap-top">
              <span class="badge" :class="agentBadgeClass(a.agent)">
                {{ agentLabel(a.agent) }}
              </span>
              <span class="ap-tool">{{ a.tool }}</span>
              <span class="ap-summary">{{ a.inputSummary }}</span>
              <span class="ap-time">{{ fmtIso(a.createdAt) }}</span>
            </div>
            <pre v-if="expandedId === a.id" class="ap-detail">{{ a.detail || '（无正文）' }}</pre>
          </div>
          <div class="ap-actions">
            <button class="btn btn-primary btn-sm" @click.stop="decide(a, 'allow_once')">允许一次</button>
            <button class="btn btn-secondary btn-sm" @click.stop="decide(a, 'allow_session')">本会话放行</button>
            <button class="btn btn-danger btn-sm" @click.stop="decide(a, 'deny')">拒绝</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 页面通知：回合完成/失败 + 待审批，可就地决策或追加对话（事件推送驱动，右上角浮动） -->
    <div v-if="notices.length" class="notice-stack">
      <div v-for="n in notices" :key="n.id" class="notice" :class="{ fail: n.kind === 'task' && n.ok === false, sent: n.sent }">
        <div class="nt-head">
          <span class="badge" :class="agentBadgeClass(n.agent)">{{ agentLabel(n.agent) }}</span>
          <span class="nt-title">{{ n.title }}</span>
          <button class="nt-close" title="关闭" @click="dismiss(n.id)">×</button>
        </div>
        <div class="nt-brief" :title="n.brief">{{ n.brief }}</div>
        <div v-if="n.kind === 'approval'" class="nt-actions">
          <button class="btn btn-primary btn-sm" @click="decideNotice(n, 'allow_once')">允许一次</button>
          <button class="btn btn-danger btn-sm" @click="decideNotice(n, 'deny')">拒绝</button>
          <span class="text-muted nt-tip-inline">本会话放行等完整选项见待审批列表</span>
        </div>
        <div v-if="n.kind === 'task' && canFollowup(n.agent) && !n.sent" class="nt-actions">
          <button class="btn btn-primary btn-sm" @click="sendNoticeFollowup(n, '继续')">▶️ 继续</button>
          <input v-model="n.text" class="nt-input" placeholder="或输入要追加的内容…" @keyup.enter="sendNoticeFollowup(n, n.text || '')">
          <button class="btn btn-secondary btn-sm" @click="sendNoticeFollowup(n, n.text || '')">发送</button>
        </div>
        <div v-if="n.tip" class="nt-tip" :class="n.tipOk ? 'ok' : 'err'">{{ n.tip }}</div>
      </div>
    </div>

    <!-- 未开启引导 -->
    <div v-if="!status.enabled" class="radar-off">
      <div class="off-icon"><AppIcon name="radar" :size="40" /></div>
      <h2>雷达未开启</h2>
      <p class="text-muted">
        开启后将只读扫描本机 AI 工具（ZCode / Claude Code / Codex / OpenCode / Qoder / Trae / DSH / Pi）的会话记录，
        运行状态实时展示，对话正文存档在本地 <code>~/.qihang-ai-desktop/radar/</code>，不上传任何数据。
      </p>
      <div class="off-actions">
        <button class="btn btn-primary" :disabled="toggling" @click="setEnabled(true)">
          {{ toggling ? '开启中…' : '开启雷达' }}
        </button>
        <router-link class="btn btn-secondary" to="/config">去设置</router-link>
      </div>
    </div>

    <div v-else class="dashboard">
      <!-- ① 工具卡片状态 -->
      <div class="card-grid">
        <div v-for="c in cards" :key="c.tool" class="tool-card">
          <div class="tc-top">
            <span class="tc-dot" :class="cardState(c)"></span>
            <span class="tc-name">{{ toolLabel(c.tool) }}</span>
            <span class="badge" :class="cardBadgeClass(c)">{{ cardBadgeText(c) }}</span>
          </div>
          <div class="tc-sub text-muted">{{ cardSub(c) }}</div>
          <div class="tc-bottom">
            <span class="tc-info" :title="c.lastSessionTitle || c.lastSessionProject">
              {{ c.lastSessionTitle || c.lastSessionProject || '—' }}
            </span>
            <span class="tc-time">{{ fmtClock(c.lastActivity) }}</span>
          </div>
        </div>
        <div v-if="!cards.length" class="text-muted grid-empty">等待首轮扫描…</div>
      </div>

      <!-- ② 最近状态跃迁 -->
      <div class="section">
        <div class="sec-title"><i class="bar"></i>最近状态跃迁</div>
        <div class="event-table">
          <div v-for="(e, i) in events" :key="i" class="event-row">
            <span class="ev-time">{{ fmtClock(e.ts) }}</span>
            <span class="ev-tool">{{ toolLabel(e.tool) }}</span>
            <span class="ev-type" :class="e.state">{{ e.state === 'running' ? '开始运行' : '转入空闲' }}</span>
            <span class="ev-detail text-muted">{{ e.title || e.sessionId || '—' }}</span>
          </div>
          <div v-if="!events.length" class="row-empty text-muted">暂无状态记录</div>
        </div>
      </div>

      <!-- ③ 最近活跃会话 / 搜索结果 -->
      <div class="section">
        <div class="sec-title"><i class="bar"></i>{{ keyword.trim() ? '搜索结果' : '最近活跃会话' }}</div>
        <div class="session-table">
          <div v-for="s in visibleSessions" :key="s.tool + '/' + s.sessionId" class="session-row" @click="openSession(s)">
            <span class="sm-time">{{ fmtClock(s.sourceUpdatedAt) }}</span>
            <span class="sm-tool">
              <i class="sm-dot" :class="s.state === 'running' ? 'run' : 'idle'"></i>{{ toolLabel(s.tool) }}
            </span>
            <span class="sm-title">{{ s.title || '（无标题）' }}</span>
            <span class="sm-project text-muted">{{ shortDir(s.projectDir) }}</span>
            <span class="badge" :class="s.state === 'running' ? 'badge-primary' : 'badge-gray'">
              {{ s.frozen ? '冻结' : (s.state === 'running' ? '活跃' : '历史') }}
            </span>
            <span class="sm-count text-muted">{{ s.actual_count || s.messageCount || 0 }} 消息</span>
          </div>
          <div v-if="!visibleSessions.length" class="row-empty text-muted">
            {{ keyword.trim() ? '无匹配结果' : '暂无会话，等待扫描…' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';

const API: any = (window as any).electronAPI;
const router = useRouter();

// ========== 状态 ==========
const status = ref<any>({ enabled: false, running: false, collectors: [], allTools: [], stats: null });
const cards = ref<any[]>([]);
const events = ref<any[]>([]);
const sessions = ref<any[]>([]);
const searchResults = ref<any[]>([]);
const keyword = ref('');
const scanning = ref(false);
const toggling = ref(false);

// ========== 审批（雷达子功能；飞书兜底决策面，同一 ApprovalCenter 状态机） ==========
const pending = ref<ApprovalRequest[]>([]);
const expandedId = ref('');
const feishuOn = ref(false);
const pendingStatus = ref('');

async function loadPending() {
  try { pending.value = (await API.approver.pending()) || []; } catch { pending.value = []; }
}
function toggleDetail(id: string) {
  expandedId.value = expandedId.value === id ? '' : id;
}
async function decide(a: ApprovalRequest, decision: 'allow_once' | 'allow_session' | 'deny') {
  const r = await API.approver.decide(a.id, decision);
  if (!r?.ok) {
    pendingStatus.value = '❌ ' + (r?.error || '决策失败');
  } else {
    pendingStatus.value = '✅ 已受理：' + (a.inputSummary.slice(0, 20) || a.tool);
  }
  setTimeout(() => { pendingStatus.value = ''; }, 3000);
  await loadPending();
}
function fmtIso(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  return t ? fmtClock(t) : '';
}

const TOOL_LABELS: Record<string, string> = {
  zcode: 'ZCode', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi',
};
const toolLabel = (t: string) => TOOL_LABELS[t] || t;

// 审批来源标识：pi 走 pi-approver-gate 扩展上报，此前被写死成 DSH 分支导致显示错误
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code', dsh: 'DSH', pi: 'Pi',
};
const agentLabel = (a: string) => AGENT_LABELS[a] || a;
const agentBadgeClass = (a: string) =>
  a === 'claude' ? 'badge-primary' : a === 'pi' ? 'badge-warning' : 'badge-success';

// ========== 页面通知：回合完成/失败 + 待审批（approver:event 推送驱动，右上角浮动） ==========
// 完成的通知 30s 自动消退；失败/待审批保留到人处理（就地决策或追加对话后关闭）。
// 状态回调：点过「继续/发送」的通知转入 sent 态（按钮隐藏，提示常驻），同一会话的下一轮
// task-done 到达时自动收掉——新结果弹新通知，形成「失败 → 继续 → 新结果」闭环。
interface Notice {
  id: string;
  kind: 'approval' | 'task';
  agent: string;
  ok?: boolean;
  title: string;
  brief: string;
  sessionId?: string;
  sent?: boolean;
  text?: string;
  tip?: string;
  tipOk?: boolean;
}
const notices = ref<Notice[]>([]);
const FOLLOWUP_AGENTS = new Set(['pi', 'dsh', 'claude']); // 外部会话追问走暂存，由原终端取走执行
const canFollowup = (a: string) => FOLLOWUP_AGENTS.has(a);
// claude 无常驻长轮询，只有回合收口后的等待窗口（默认 30 秒）能接住追问；pi/DSH 扩展收口后轮询 10 分钟
const followupHint = (a: string) =>
  a === 'claude'
    ? '终端会话正在等待（约 30 秒窗口），超窗请用飞书卡片'
    : '原终端会话将在 10 分钟内取走执行（终端需保持打开）';

function dirName(cwd: string): string {
  return (cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd || '?';
}
function dismiss(id: string) {
  notices.value = notices.value.filter((n) => n.id !== id);
}
function pushNotice(n: Notice) {
  if (notices.value.some((x) => x.id === n.id)) return;
  notices.value.unshift(n);
  if (notices.value.length > 5) notices.value.pop(); // 最多留 5 条，防刷屏
  if (n.kind === 'task' && n.ok !== false) {
    setTimeout(() => dismiss(n.id), 30_000);
  }
}
function onApproverNotice(e: any) {
  if (e?.type === 'approval.required' && e.request) {
    pushNotice({
      id: 'ap-' + e.request.id,
      kind: 'approval',
      agent: e.request.agent,
      title: `待审批 · ${e.request.tool}`,
      brief: e.request.inputSummary || '（无摘要）',
    });
  } else if (e?.type === 'approval.decided') {
    dismiss('ap-' + e.request?.id);
  } else if (e?.type === 'task-done' && e.report) {
    const r = e.report;
    // 状态回调：该会话此前「已发送继续」的通知，等的就是这一轮结果 → 收掉旧通知，弹新结果
    if (r.sessionId) {
      notices.value = notices.value.filter(
        (x) => !(x.kind === 'task' && x.sent && x.agent === r.agent && x.sessionId === r.sessionId),
      );
    }
    pushNotice({
      id: `task-${r.agent}-${r.sessionId || ''}-${Date.now()}`,
      kind: 'task',
      agent: r.agent,
      ok: r.ok !== false,
      title: `${r.ok !== false ? '任务完成' : '任务失败'} · ${dirName(r.cwd)}`,
      brief: String(r.ok !== false ? r.task : r.error || r.task || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      sessionId: r.sessionId,
    });
  }
}
async function decideNotice(n: Notice, decision: 'allow_once' | 'deny') {
  const r = await API.approver.decide(n.id.slice(3), decision);
  n.tipOk = !!r?.ok;
  n.tip = r?.ok ? `已${decision === 'deny' ? '拒绝' : '允许一次'}` : (r?.error || '决策失败');
  if (r?.ok) setTimeout(() => dismiss(n.id), 1500);
  await loadPending();
}
async function sendNoticeFollowup(n: Notice, text: string) {
  const body = String(text || '').trim();
  if (!body) { n.tip = '请先输入要追加的内容'; n.tipOk = false; return; }
  const r = await API.radar.followup(n.agent, n.sessionId || '', body);
  if (r?.ok) {
    // 转入已发送态：追问暂存是单槽位（同会话再发会覆盖），按钮收起防误触；
    // 提示常驻，等该会话下一轮 task-done 到达时整条收掉（见 onApproverNotice）
    n.sent = true;
    n.text = '';
    n.tip = '已发送，' + followupHint(n.agent);
    n.tipOk = true;
  } else {
    n.tip = '提交失败：' + (r?.error || '未知错误');
    n.tipOk = false;
    setTimeout(() => { if (!n.sent) n.tip = ''; }, 6000);
  }
}

const visibleSessions = ref<any[]>([]);

function applySearchMode() {
  visibleSessions.value = keyword.value.trim() ? searchResults.value : sessions.value;
}

// ========== 卡片展示逻辑 ==========
function cardState(c: any): string {
  if ((c.running || 0) > 0) return 'run';
  if (c.lastActivity && Date.now() - c.lastActivity < 5 * 60_000) return 'just';
  return 'idle';
}
function cardBadgeClass(c: any): string {
  const s = cardState(c);
  return s === 'idle' ? 'badge-gray' : 'badge-success';
}
function cardBadgeText(c: any): string {
  const s = cardState(c);
  return s === 'run' ? '运行中' : s === 'just' ? '刚完成' : '空闲';
}
function cardSub(c: any): string {
  if ((c.running || 0) > 0) return `正在运行 · ${c.running} 个会话`;
  if (!c.lastActivity) return '已连接 · 暂无活动';
  const diff = Date.now() - c.lastActivity;
  if (diff < 30 * 60_000) return `已连接 · 最近活动 ${relTime(diff)}`;
  return '已连接 · 近30分钟无活动';
}
function relTime(diff: number): string {
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}
function shortDir(dir: string): string {
  const d = String(dir || '').replace(/\\/g, '/');
  if (!d) return '';
  const parts = d.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : d;
}

// ========== 数据加载 ==========
async function loadStatus() {
  try { status.value = await API.radar.status(); } catch { /* 静默 */ }
}
async function loadDashboard() {
  try {
    const d = await API.radar.dashboard();
    cards.value = d.cards || [];
    events.value = d.events || [];
    sessions.value = d.sessions || [];
    applySearchMode();
  } catch { /* 静默 */ }
}
async function loadSearch() {
  const q = keyword.value.trim();
  if (!q) { searchResults.value = []; applySearchMode(); return; }
  try {
    const res = await API.radar.sessions({ q });
    searchResults.value = res.rows || [];
  } catch { searchResults.value = []; }
  applySearchMode();
}

// ========== 交互 ==========
function openSession(s: any) {
  router.push({ path: `/radar/session/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.sessionId)}` });
}
async function scanNow() {
  scanning.value = true;
  try {
    await API.radar.scanNow();
    await Promise.all([loadStatus(), loadDashboard()]);
  } finally { scanning.value = false; }
}
async function setEnabled(on: boolean) {
  toggling.value = true;
  try {
    const res = await API.radar.setEnabled(on);
    if (res?.status) status.value = res.status;
    else await loadStatus();
    if (on) await loadDashboard();
  } finally { toggling.value = false; }
}

// 全文搜索防抖
let searchTimer: number | undefined;
function onSearchInput() {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { void loadSearch(); }, 350);
}

function fmtClock(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 实时状态推送（防抖合并刷新）
let eventTimer: number | undefined;
function onRadarEvent() {
  if (eventTimer) window.clearTimeout(eventTimer);
  eventTimer = window.setTimeout(() => { void loadDashboard(); }, 800);
}

// 审批/回合收口事件推送：刷新待审批列表 + 页面通知（完成/失败/待审批）
function onApproverEvent(payload?: any) {
  void loadPending();
  onApproverNotice(payload);
}

onMounted(async () => {
  API.on('radar:event', onRadarEvent);
  API.on('approver:event', onApproverEvent);
  await loadStatus();
  // 审批是雷达子功能，但审批通道独立于雷达开关：雷达没开也能在此决策
  try { const s = await API.service.status(); feishuOn.value = !!s?.feishu; } catch { /* 静默 */ }
  await loadPending();
  if (status.value.enabled) await loadDashboard();
});
onUnmounted(() => {
  API.removeAllListeners('radar:event');
  API.removeAllListeners('approver:event');
  if (searchTimer) window.clearTimeout(searchTimer);
  if (eventTimer) window.clearTimeout(eventTimer);
});
</script>

<style scoped>
.radar-view {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 20px 24px 16px;
  box-sizing: border-box;
  gap: 14px;
}
.header-sub { font-size: 12.5px; margin-top: 4px; }
.header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search-input { width: 240px; font-size: 12.5px; }
.collect-info { font-size: 11.5px; }
.header-sub code, .radar-off code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--hover);
  padding: 1px 5px;
  border-radius: 4px;
}

/* ===== 未开启引导 ===== */
.radar-off {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 40px;
}
.off-icon { color: var(--text-muted); opacity: 0.5; }
.radar-off h2 { font-size: 18px; margin: 0; color: var(--text-primary); }
.radar-off p { max-width: 560px; font-size: 13px; line-height: 1.7; margin: 0; }
.off-actions { display: flex; gap: 10px; margin-top: 8px; }

/* ===== 仪表盘滚动区 ===== */
.dashboard {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 8px;
}

/* ===== ① 工具卡片 ===== */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.grid-empty { grid-column: 1 / -1; text-align: center; padding: 24px; font-size: 13px; }
.tool-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tc-top { display: flex; align-items: center; gap: 9px; }
.tc-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.tc-dot.run { background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); animation: pulse 2s infinite; }
.tc-dot.just { background: var(--success); opacity: 0.75; }
.tc-dot.idle { background: var(--text-muted); opacity: 0.4; }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--success-soft); }
  50% { box-shadow: 0 0 0 6px var(--success-soft); }
}
.tc-name { flex: 1; font-size: 14.5px; font-weight: 600; color: var(--text-primary); }
.tc-sub { font-size: 12px; }
.tc-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 2px;
}
.tc-info {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.tc-time { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); flex-shrink: 0; }

/* ===== 分区通用 ===== */
.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.sec-title .bar {
  width: 4px;
  height: 16px;
  border-radius: 2px;
  background: var(--primary);
  flex-shrink: 0;
}
.event-table, .session-table {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
}
.row-empty { padding: 22px; text-align: center; font-size: 12.5px; }

/* ===== ② 状态跃迁表 ===== */
.event-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.event-row:last-child { border-bottom: none; }
.ev-time { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); width: 70px; flex-shrink: 0; }
.ev-tool { font-weight: 600; color: var(--text-primary); width: 90px; flex-shrink: 0; }
.ev-type { width: 70px; flex-shrink: 0; font-weight: 500; }
.ev-type.running { color: var(--primary); }
.ev-type.idle { color: var(--text-muted); }
.ev-detail {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ===== ③ 会话表 ===== */
.session-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.12s;
}
.session-row:last-child { border-bottom: none; }
.session-row:hover { background: var(--hover); }
.sm-time { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); width: 70px; flex-shrink: 0; }
.sm-tool { display: flex; align-items: center; gap: 7px; font-weight: 600; color: var(--text-primary); width: 110px; flex-shrink: 0; }
.sm-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sm-dot.run { background: var(--primary); }
.sm-dot.idle { background: var(--text-muted); opacity: 0.45; }
.sm-title {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sm-project {
  font-family: var(--font-mono);
  font-size: 11px;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.sm-count { flex-shrink: 0; font-size: 11.5px; }
.tool-tag {
  font-size: 10px;
  font-family: var(--font-mono);
  background: var(--hover);
  color: var(--text-secondary);
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}

/* ===== 审批（雷达子功能） ===== */
.bar-warn { background: var(--danger, #e5484d); }
.approval-table {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
}
.approval-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
}
.approval-row:last-child { border-bottom: none; }
.approval-row:nth-child(odd) { background: var(--danger-soft, rgba(229, 72, 77, 0.04)); }
.ap-main { flex: 1; min-width: 0; cursor: pointer; }
.ap-top {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.ap-tool {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--hover);
  color: var(--text-secondary);
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.ap-summary {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12.5px;
  color: var(--text-primary);
}
.ap-time {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.ap-detail {
  margin: 9px 0 0;
  padding: 10px 12px;
  background: var(--hover);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 260px;
  overflow-y: auto;
  color: var(--text-secondary);
}
.ap-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* ===== 页面通知（右上角浮动栈） ===== */
.notice-stack {
  position: absolute;
  top: 12px;
  right: 24px;
  width: 380px;
  max-height: calc(100% - 40px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 50;
}
.notice {
  border: 1px solid var(--border);
  border-left: 3px solid var(--success);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.notice.fail { border-left-color: var(--danger); }
.notice.sent { border-left-color: var(--warning); }
.nt-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.nt-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nt-close {
  border: none;
  background: none;
  font: inherit;
  font-size: 15px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 2px;
  flex-shrink: 0;
}
.nt-close:hover { color: var(--text-primary); }
.nt-brief {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.nt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nt-input {
  flex: 1;
  min-width: 120px;
  font: inherit;
  font-size: 12px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--hover);
  color: var(--text-primary);
  outline: none;
}
.nt-input:focus { border-color: var(--primary); }
.nt-tip { font-size: 11.5px; }
.nt-tip.ok { color: var(--success); }
.nt-tip.err { color: var(--danger); }
.nt-tip-inline { font-size: 11px; }
</style>
