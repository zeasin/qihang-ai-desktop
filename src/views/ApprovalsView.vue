<!--
  ApprovalsView —— 智能体审批（独立页面，侧边栏「审批」入口）
  承载待审批决策（飞书兜底面）+ 最近已决审计。与飞书卡片共用同一 ApprovalCenter 状态机。
  数据来自主进程 approver IPC，不出机器。
-->
<template>
  <div class="approvals-view">
    <!-- 头部 -->
    <div class="content-header">
      <div>
        <h1>智能体审批</h1>
        <div class="text-muted header-sub">
          Claude Code / DSH 发起权限请求时在此决策 · 与飞书卡片同一状态机，决策双向一致
        </div>
      </div>
      <div class="header-actions">
        <span v-if="!approverOn" class="badge badge-gray">审批通道未启用</span>
        <span v-else-if="feishuOn" class="badge badge-success">飞书已连接</span>
        <span v-else class="badge badge-warn">飞书未启用 · 仅桌面决策</span>
        <span v-if="pending.length" class="badge badge-danger">待审批 {{ pending.length }}</span>
        <button class="btn btn-secondary btn-sm" @click="refresh">刷新</button>
      </div>
    </div>

    <div v-if="statusMsg" class="status-msg" :class="statusMsg.startsWith('✅') ? 'ok' : 'err'">{{ statusMsg }}</div>

    <!-- 未启用引导 -->
    <div v-if="!approverOn" class="off-box">
      <div class="off-icon"><AppIcon name="check-square" :size="40" /></div>
      <h2>审批通道未启用</h2>
      <p class="text-muted">
        在「设置 → 智能体审批与雷达通知」开启审批通道。开启后，Claude Code / DSH 的权限请求会挂起等待决策：
        飞书在线时推送审批卡片，飞书不可用时可在此页面决策。
      </p>
      <div class="off-actions">
        <router-link class="btn btn-primary" to="/config">去设置</router-link>
      </div>
    </div>

    <div v-else class="body">
      <!-- 待审批 -->
      <div class="section">
        <div class="sec-title"><i class="bar bar-warn"></i>待审批 · {{ pending.length }} 条</div>
        <div v-if="pending.length" class="approval-table">
          <div v-for="a in pending" :key="a.id" class="approval-row">
            <div class="ap-main" @click="toggleDetail(a.id)">
              <div class="ap-top">
                <span class="badge" :class="a.agent === 'claude' ? 'badge-primary' : 'badge-success'">
                  {{ a.agent === 'claude' ? 'Claude Code' : 'DSH' }}
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
        <div v-else class="row-empty text-muted">暂无挂起审批 · 智能体发起权限请求时会自动出现</div>
      </div>

      <!-- 最近已决 -->
      <div class="section">
        <div class="sec-title"><i class="bar"></i>最近已决</div>
        <div class="approval-table">
          <div v-for="a in history" :key="a.id" class="history-row">
            <span class="badge" :class="decisionClass(a)">{{ decisionLabel(a) }}</span>
            <span class="ap-tool">{{ a.agent === 'claude' ? 'Claude Code' : 'DSH' }} · {{ a.tool }}</span>
            <span class="ap-summary">{{ a.inputSummary }}</span>
            <span class="ap-time">{{ fmtIso(a.decidedAt || a.createdAt) }}</span>
            <span class="ap-by text-muted">{{ a.decidedBy || '—' }}</span>
          </div>
          <div v-if="!history.length" class="row-empty text-muted">暂无已决记录</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import AppIcon from '../components/AppIcon.vue';

const API: any = (window as any).electronAPI;

// ========== 状态 ==========
const approverOn = ref(false);
const feishuOn = ref(false);
const pending = ref<ApprovalRequest[]>([]);
const history = ref<ApprovalRequest[]>([]);
const expandedId = ref('');
const statusMsg = ref('');

// ========== 加载 ==========
async function loadStatus() {
  try {
    const s = await API.approver.status();
    approverOn.value = !!s?.enabled;
  } catch { approverOn.value = false; }
  try {
    const fs = await API.service.status();
    feishuOn.value = !!fs?.feishu;
  } catch { feishuOn.value = false; }
}
async function loadPending() {
  try { pending.value = (await API.approver.pending()) || []; } catch { pending.value = []; }
}
async function loadHistory() {
  try { history.value = (await API.approver.history(30)) || []; } catch { history.value = []; }
}
async function refresh() {
  await Promise.all([loadStatus(), loadPending(), loadHistory()]);
}

// ========== 交互 ==========
function toggleDetail(id: string) {
  expandedId.value = expandedId.value === id ? '' : id;
}
async function decide(a: ApprovalRequest, decision: 'allow_once' | 'allow_session' | 'deny') {
  const r = await API.approver.decide(a.id, decision);
  if (!r?.ok) {
    statusMsg.value = '❌ ' + (r?.error || '决策失败');
  } else {
    statusMsg.value = '✅ 已受理：' + (a.inputSummary.slice(0, 20) || a.tool);
  }
  setTimeout(() => { statusMsg.value = ''; }, 3000);
  await Promise.all([loadPending(), loadHistory()]);
}
function decisionLabel(a: ApprovalRequest): string {
  if (a.decision === 'allow_once') return '允许一次';
  if (a.decision === 'allow_session') return '本会话放行';
  if (a.decision === 'deny') return '拒绝';
  return '已处理';
}
function decisionClass(a: ApprovalRequest): string {
  if (a.decision === 'deny') return 'badge-danger';
  if (a.decision === 'allow_session') return 'badge-success';
  return 'badge-primary';
}
function fmtIso(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 审批事件：挂起/决策时刷新
function onApproverEvent() {
  void loadPending();
  void loadHistory();
}

onMounted(async () => {
  API.on('approver:event', onApproverEvent);
  await refresh();
});
onUnmounted(() => {
  API.removeAllListeners('approver:event');
});
</script>

<style scoped>
.approvals-view {
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
.badge-warn { background: var(--warning-soft, rgba(234, 179, 8, 0.15)); color: var(--warning, #b45309); }
.status-msg { font-size: 12.5px; padding: 8px 12px; border-radius: 8px; }
.status-msg.ok { background: var(--success-soft, rgba(34, 197, 94, 0.1)); color: var(--success); }
.status-msg.err { background: var(--danger-soft, rgba(220, 38, 38, 0.1)); color: var(--danger); }

/* 未启用引导 */
.off-box {
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
.off-box h2 { font-size: 18px; margin: 0; color: var(--text-primary); }
.off-box p { max-width: 560px; font-size: 13px; line-height: 1.7; margin: 0; }
.off-actions { display: flex; gap: 10px; margin-top: 8px; }

/* 主体滚动区 */
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 8px;
}

/* 分区通用 */
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
.bar-warn { background: var(--danger, #e5484d); }

.approval-table {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
}
.row-empty { padding: 22px; text-align: center; font-size: 12.5px; }

/* 待审批行 */
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
.ap-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
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

/* 已决行 */
.history-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.history-row:last-child { border-bottom: none; }
.ap-by { font-size: 11px; flex-shrink: 0; }
</style>
