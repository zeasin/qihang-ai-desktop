<!--
  RadarSessionView —— 雷达会话详情页（独立页面，从雷达页会话行进入）
  全页浏览单个会话的对话记录 / 状态时间线；会话活跃时状态徽标实时更新。
-->
<template>
  <div class="rsession-view">
    <!-- 头部 -->
    <div class="content-header">
      <div class="sh-left">
        <button class="btn btn-secondary btn-sm back-btn" @click="goBack">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
          雷达
        </button>
        <div class="sh-info">
          <h1 class="sh-title">{{ title }}</h1>
          <div class="sh-sub text-muted">
            <span class="tool-tag">{{ toolLabel(tool) }}</span>
            <span class="badge" :class="state === 'running' ? 'badge-primary' : 'badge-gray'">
              {{ state === 'running' ? '活跃' : '历史' }}
            </span>
            <span v-if="info?.frozen" class="badge badge-gray">冻结</span>
            <span v-if="projectDir" class="sh-dir" :title="projectDir">{{ projectDir }}</span>
            <span>{{ messages.length }} 条消息</span>
          </div>
        </div>
      </div>
      <div class="header-actions">
        <button class="tab-btn" :class="{ on: tab === 'messages' }" @click="tab = 'messages'">对话记录</button>
        <button class="tab-btn" :class="{ on: tab === 'timeline' }" @click="tab = 'timeline'">状态时间线</button>
      </div>
    </div>

    <!-- 正文：居中阅读列 -->
    <div class="rsession-body">
      <!-- 状态说明 / 空态 -->
      <div v-if="tab === 'messages' && !messages.length && !loading" class="msg-col">
        <div v-if="!info" class="state-note">
          <p class="text-muted">会话不存在或链接无效（可能来自旧版页面）。</p>
          <button class="btn btn-secondary btn-sm" @click="goBack">返回雷达</button>
        </div>
        <div v-else-if="info.frozen" class="state-note">
          <p class="text-muted">
            🧊 该会话已<b>冻结</b>（超过 30 天无活跃，自动暂停正文采集），目前只有元数据入档。
            解冻后下一轮会重新采集完整对话。
          </p>
          <button class="btn btn-primary btn-sm" :disabled="unfreezing" @click="unfreeze">
            {{ unfreezing ? '已解冻，采集中…' : '解冻并重新采集' }}
          </button>
          <span v-if="unfreezeTip" class="text-muted" style="font-size:12px;">{{ unfreezeTip }}</span>
        </div>
        <div v-else class="state-note">
          <p class="text-muted">
            元数据已入档，正文还没有采集到——可能采集仍在进行中（稍后刷新），或源会话本身没有对话内容。
          </p>
          <button class="btn btn-secondary btn-sm" @click="reload">重新加载</button>
        </div>
      </div>

      <div v-else-if="tab === 'messages'" class="msg-col">
        <div v-for="m in messages" :key="m.seq" class="msg" :class="m.role">
          <div class="msg-role">
            <span class="role-badge" :class="m.role">{{ m.role === 'user' ? '用户' : '助手' }}</span>
            <span class="text-muted msg-ts">{{ fmtFull(m.ts) }}</span>
          </div>
          <details v-if="m.thinking" class="msg-thinking">
            <summary>思考过程</summary>
            <pre>{{ m.thinking }}</pre>
          </details>
          <div
            v-if="m.content"
            class="msg-content markdown-body"
            v-html="renderMarkdown(m.content)"
          ></div>
          <details v-if="parseTools(m.toolsJson).length" class="msg-tools">
            <summary>{{ parseTools(m.toolsJson).length }} 个工具调用</summary>
            <div v-for="(t, i) in parseTools(m.toolsJson)" :key="i" class="tool-call">
              <div class="tch">
                <span class="tc-name">{{ t.name }}</span>
                <span class="tc-status" :class="t.status">{{ t.status === 'error' ? '失败' : t.status === 'running' ? '运行中' : '完成' }}</span>
              </div>
              <pre v-if="t.args" class="tc-block">{{ t.args }}</pre>
              <pre v-if="t.result" class="tc-block result">{{ t.result }}</pre>
            </div>
          </details>
        </div>
          <div v-if="!messages.length && !loading" class="col-empty text-muted">该会话还没有采集到消息</div>

          <!-- 插入对话：pi / DSH 外部会话支持追问，由原终端会话长轮询取走执行 -->
          <div v-if="followupSupported" class="followup-bar">
            <div v-if="followupTip" class="fu-tip" :class="followupOk ? 'ok' : 'err'">{{ followupTip }}</div>
            <div class="fu-row">
              <input
                v-model="followupText"
                class="fu-input"
                type="text"
                :placeholder="state === 'running' ? '会话运行中，消息将在回合收口后被取走' : '插入对话，如：继续'"
                :disabled="sending"
                @keyup.enter="sendFollowup"
              >
              <button class="btn btn-primary btn-sm fu-send" :disabled="sending || !followupText.trim()" @click="sendFollowup">
                {{ sending ? '发送中…' : '发送' }}
              </button>
            </div>
            <div class="fu-hint text-muted">{{ followupHint }}</div>
          </div>
      </div>

      <div v-else-if="tab === 'timeline'" class="msg-col">
        <div class="timeline-list">
          <div v-for="(e, i) in stateEvents" :key="i" class="tl-item">
            <span class="tl-dot" :class="e.state"></span>
            <span class="tl-state" :class="e.state">{{ e.state === 'running' ? '开始运行' : '转入空闲' }}</span>
            <span class="text-muted">{{ fmtFull(e.ts) }}</span>
          </div>
          <div v-if="!stateEvents.length" class="col-empty text-muted">暂无状态记录</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import AppIcon from '../components/AppIcon.vue';

// 与 ChatView 同款 markdown 渲染（GFM + 换行）
marked.setOptions({ breaks: true, gfm: true });

const API: any = (window as any).electronAPI;
const route = useRoute();
const router = useRouter();

const tool = computed(() => String(route.params.tool || ''));
const sessionId = computed(() => String(route.params.sessionId || ''));

const info = ref<any>(null);
const messages = ref<any[]>([]);
const stateEvents = ref<any[]>([]);
const tab = ref<'messages' | 'timeline'>('messages');
const loading = ref(false);

const TOOL_LABELS: Record<string, string> = {
  zcode: 'ZCode', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi',
};
const toolLabel = (t: string) => TOOL_LABELS[t] || t;

const title = computed(() => info.value?.title || '（无标题）');
const projectDir = computed(() => info.value?.projectDir || '');
const state = computed(() => info.value?.state || 'idle');

function goBack() {
  router.push('/radar');
}

async function loadInfo() {
  try {
    const res = await API.radar.sessionInfo(tool.value, sessionId.value);
    if (res?.info) info.value = res.info;
  } catch { /* 静默，标题用兜底 */ }
}
function reload() {
  void loadInfo();
  void loadMessages();
  void loadStateEvents();
}

// ========== 解冻重采 ==========
const unfreezing = ref(false);
const unfreezeTip = ref('');

async function unfreeze() {
  unfreezing.value = true;
  unfreezeTip.value = '';
  try {
    const res = await API.radar.unfreeze(tool.value, sessionId.value);
    if (!res?.ok) {
      unfreezeTip.value = '解冻失败：雷达服务未运行，请先在设置页开启';
      unfreezing.value = false;
      return;
    }
    // 轮询等待重新采集出结果（最多 ~80s）
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const fresh = await API.radar.messages(tool.value, sessionId.value);
      if ((fresh?.rows || []).length) {
        messages.value = fresh.rows;
        await loadInfo();
        unfreezeTip.value = '';
        unfreezing.value = false;
        return;
      }
      unfreezeTip.value = `重新采集中…（${(i + 1) * 5}s）`;
    }
    unfreezeTip.value = '采集仍在后台进行，稍后重新加载即可看到';
    unfreezing.value = false;
  } catch (e: any) {
    unfreezeTip.value = '解冻失败：' + (e?.message || e);
    unfreezing.value = false;
  }
}
async function loadMessages() {
  loading.value = true;
  try {
    const res = await API.radar.messages(tool.value, sessionId.value);
    messages.value = res.rows || [];
  } catch { messages.value = []; }
  finally { loading.value = false; }
}
async function loadStateEvents() {
  try {
    const res = await API.radar.stateEvents(tool.value, sessionId.value);
    stateEvents.value = res.rows || [];
  } catch { stateEvents.value = []; }
}

function parseTools(json: string): any[] {
  if (!json) return [];
  try { return JSON.parse(json) || []; } catch { return []; }
}

// ========== 插入对话（pi / DSH 外部会话追问） ==========
// 文本按 sessionId 暂存到审批通道（TTL 10 分钟），由原终端会话的扩展/插件长轮询取走注入执行，
// 不接管不 fork：pi 走 pi-approver-gate，DSH 走 dsh-approver 插件；终端已关时按 TTL 过期。
const FOLLOWUP_LABELS: Record<string, string> = { pi: 'Pi', dsh: 'DSH', 'claude-code': 'Claude Code' };
const followupSupported = computed(() => !!FOLLOWUP_LABELS[tool.value]);
const followupHint = computed(() => {
  if (!followupSupported.value) return '';
  if (tool.value === 'claude-code') {
    return '仅回合收口后的等待窗口（约 30 秒）内能送达终端，超窗请用飞书卡片';
  }
  return `消息将在 10 分钟内被 ${FOLLOWUP_LABELS[tool.value]} 原终端会话取走执行（终端需保持打开）`;
});
const followupText = ref('');
const sending = ref(false);
const followupTip = ref('');
const followupOk = ref(false);
let tipTimer: number | undefined;

async function sendFollowup() {
  const text = followupText.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  try {
    const res = await API.radar.followup(tool.value, sessionId.value, text);
    if (res?.ok) {
      followupText.value = '';
      followupOk.value = true;
      followupTip.value = '已提交，原终端会话将取走执行';
    } else {
      followupOk.value = false;
      followupTip.value = '提交失败：' + (res?.error || '未知错误');
    }
  } catch (e: any) {
    followupOk.value = false;
    followupTip.value = '提交失败：' + (e?.message || e);
  } finally {
    sending.value = false;
    if (tipTimer) window.clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => { followupTip.value = ''; }, 6000);
  }
}

// ========== markdown 渲染（雷达是存档阅读器：用户/助手消息都按 markdown 排版） ==========
const renderMarkdown = (content: string) => {
  if (!content) return '';
  // 剥掉注入型 system-reminder 块（claude/pi 的用户消息里常见），避免原文噪音与原始 HTML
  const cleaned = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!cleaned) return '';
  try { return marked(cleaned); } catch { return escHtml(cleaned).replace(/\n/g, '<br>'); }
};

const escHtml = (text: string) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};
function fmtFull(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 会话活跃时实时更新徽标与时间线
let eventTimer: number | undefined;
function onRadarEvent(payload: any) {
  const events = payload?.events;
  if (payload?.type !== 'state' || !Array.isArray(events)) return;
  if (!events.some((e: any) => e.tool === tool.value && e.sessionId === sessionId.value)) return;
  void loadInfo();
  void loadStateEvents();
}

onMounted(async () => {
  API.on('radar:event', onRadarEvent);
  await Promise.all([loadInfo(), loadMessages(), loadStateEvents()]);
});
onUnmounted(() => {
  API.removeAllListeners('radar:event');
  if (eventTimer) window.clearTimeout(eventTimer);
});
</script>

<style scoped>
.rsession-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 20px 24px 16px;
  box-sizing: border-box;
  gap: 12px;
}
.sh-left { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
.back-btn { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.sh-info { min-width: 0; }
.sh-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sh-sub { display: flex; align-items: center; gap: 10px; margin-top: 4px; font-size: 11.5px; flex-wrap: wrap; }
.sh-dir { font-family: var(--font-mono); font-size: 11px; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.tab-btn {
  border: none;
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-muted);
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tab-btn.on { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }

.rsession-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
}
.msg-col {
  width: 100%;
  max-width: 860px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 8px 24px;
}
.col-empty { text-align: center; padding: 40px 0; font-size: 13px; }
.state-note {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.state-note p { margin: 0; font-size: 13px; line-height: 1.7; }

/* 消息流 */
.msg { max-width: 100%; }
.msg-role { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.role-badge { font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 5px; }
.role-badge.user { background: var(--primary-soft); color: var(--primary); }
.role-badge.assistant { background: var(--success-soft); color: var(--success); }
.msg-ts { font-size: 11px; }
.msg-content {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
  border-radius: 9px;
  padding: 11px 13px;
}
/* 用户消息：同样走 markdown，但保留主色气泡区分角色 */
.msg.user .msg-content { background: var(--primary-soft); }
/* 助手消息：markdown 渲染，卡片边框风格（对齐 ChatView） */
.msg.assistant .msg-content { background: transparent; border: 1px solid var(--border); }
.msg-content :deep(pre) {
  background: var(--code-bg, var(--hover));
  border-radius: 7px;
  padding: 10px 12px;
  overflow-x: auto;
}
.msg-content :deep(code) { font-family: var(--font-mono); font-size: 12px; }
.msg-content :deep(table) { border-collapse: collapse; margin-bottom: 12px; }
.msg-content :deep(th),
.msg-content :deep(td) { border: 1px solid var(--border); padding: 5px 10px; font-size: 12px; }
.msg-content :deep(blockquote) {
  border-left: 3px solid var(--border);
  margin: 0 0 12px;
  padding: 2px 12px;
  color: var(--text-secondary);
}
.msg-thinking, .msg-tools { margin-top: 6px; }
.msg-thinking summary, .msg-tools summary {
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.msg-thinking pre, .tc-block {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--code-bg, var(--hover));
  border-radius: 7px;
  padding: 8px 10px;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
}
.tool-call { margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.tch { display: flex; align-items: center; justify-content: space-between; }
.tc-name { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--text-primary); }
.tc-status { font-size: 10.5px; }
.tc-status.done { color: var(--success); }
.tc-status.error { color: var(--danger); }
.tc-status.running { color: var(--warning); }

/* 时间线 */
.timeline-list { display: flex; flex-direction: column; gap: 10px; padding-top: 8px; }
.tl-item { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
.tl-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.tl-dot.running { background: var(--success); }
.tl-dot.idle { background: var(--text-muted); opacity: 0.4; }
.tl-state { font-weight: 500; }
.tl-state.running { color: var(--success); }
.tl-state.idle { color: var(--text-secondary); }

.tool-tag {
  font-size: 10px;
  font-family: var(--font-mono);
  background: var(--hover);
  color: var(--text-secondary);
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}

/* 插入对话栏 */
.followup-bar {
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fu-row { display: flex; align-items: center; gap: 8px; }
.fu-input {
  flex: 1;
  font: inherit;
  font-size: 13px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-primary);
  outline: none;
}
.fu-input:focus { border-color: var(--primary); }
.fu-send { flex-shrink: 0; }
.fu-hint { font-size: 11px; }
.fu-tip { font-size: 12px; }
.fu-tip.ok { color: var(--success); }
.fu-tip.err { color: var(--danger); }
</style>
