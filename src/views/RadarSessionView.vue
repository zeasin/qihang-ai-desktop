<!--
  RadarSessionView —— 雷达会话详情页（独立页面，从雷达页会话行进入）
  全页浏览单个会话的对话记录 / 状态时间线；会话活跃时状态徽标实时更新。
-->
<template>
  <div class="rsession-view">
    <!-- 头部 -->
    <div class="content-header">
      <div class="sh-left">
        <button class="btn btn-secondary btn-sm back-btn" title="返回" @click="goBack">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
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
        <div class="seg">
          <button class="seg-btn" :class="{ on: tab === 'messages' }" @click="tab = 'messages'">对话记录</button>
          <button class="seg-btn" :class="{ on: tab === 'timeline' }" @click="tab = 'timeline'">状态时间线</button>
        </div>
      </div>
    </div>

    <!-- 正文：居中阅读列 -->
    <div ref="bodyRef" class="rsession-body">
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
        <!-- AI 会话摘要（收口后提炼；价值分达标的会话才有，雷达页通知/日报共用这一层） -->
        <div v-if="info?.summary" class="summary-card">
          <div class="sum-title"><i class="bar"></i>会话摘要</div>
          <div class="sum-body markdown-body" v-html="summaryHtml"></div>
        </div>
        <div v-for="m in mergedMessages" :key="m.seq" class="msg" :class="m.role">
          <div class="msg-role">
            <span class="role-badge" :class="m.role">{{ m.role === 'user' ? '用户' : '助手' }}</span>
            <span class="text-muted msg-ts">{{ fmtFull(m.ts) }}</span>
          </div>
          <details v-if="m.thinking || m.tools.length" class="msg-activity">
            <summary>
              <span class="act-label">
                思考过程<template v-if="m.thinking && m.tools.length"> · </template><template v-if="m.tools.length">{{ m.tools.length }} 个工具调用</template>
              </span>
              <AppIcon class="act-arrow" name="chevron-right" :size="12" />
            </summary>
            <pre v-if="m.thinking" class="act-thinking">{{ m.thinking }}</pre>
            <div v-for="(t, i) in m.tools" :key="i" class="tool-call">
              <div class="tch">
                <span class="tc-name">{{ t.name }}</span>
                <span class="tc-status" :class="t.status">{{ t.status === 'error' ? '失败' : t.status === 'running' ? '运行中' : '完成' }}</span>
              </div>
              <pre v-if="t.args" class="tc-block">{{ t.args }}</pre>
              <pre v-if="t.result" class="tc-block result">{{ t.result }}</pre>
            </div>
          </details>
          <div
            v-if="m.content"
            class="msg-content markdown-body"
            v-html="renderMarkdown(m.content)"
          ></div>
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
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import AppIcon from '../components/AppIcon.vue';
import { cleanSummaryText } from '../utils/summary-text';

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
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi', mcode: 'MiniMax Code',
};
const toolLabel = (t: string) => TOOL_LABELS[t] || t;

const title = computed(() => info.value?.title || '（无标题）');
const projectDir = computed(() => info.value?.projectDir || '');
const state = computed(() => info.value?.state || 'idle');

const summaryHtml = computed(() => {
  const s = cleanSummaryText(info.value?.summary || '');
  try { return marked(s, { async: false }) as string; } catch { return s; }
});

function goBack() {
  // 雷达已并入今天页，返回今天
  router.push('/overview');
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
  // 会话详情是回看视角：默认定位到最新消息（底部）
  scrollToBottom();
}

// 正文滚动容器；加载后跳到最底部
const bodyRef = ref<HTMLElement | null>(null);
function scrollToBottom() {
  void nextTick(() => {
    const el = bodyRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
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

// 合并连续的助手消息：终端采集里一个回合会被切成多条（思考 / 工具 / 正文各一条），
// 阅读时合并成同一个助手块，用户消息仍是天然分隔点
const mergedMessages = computed(() => {
  const out: any[] = [];
  for (const m of messages.value) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'assistant' && m.role === 'assistant') {
      if (m.thinking) prev.thinking = prev.thinking ? `${prev.thinking}\n\n${m.thinking}` : m.thinking;
      if (m.content) prev.content = prev.content ? `${prev.content}\n\n${m.content}` : m.content;
      prev.tools = prev.tools.concat(parseTools(m.toolsJson));
    } else {
      out.push({
        seq: m.seq,
        role: m.role,
        ts: m.ts,
        thinking: m.thinking || '',
        content: m.content || '',
        tools: parseTools(m.toolsJson),
      });
    }
  }
  return out;
});

// ========== 插入对话（pi / DSH 外部会话追问） ==========
// 文本按 sessionId 暂存到审批通道（TTL 10 分钟），由原终端会话的扩展/插件长轮询取走注入执行，
// 不接管不 fork：pi 走 pi-approver-gate，DSH 走 dsh-approver 插件；终端已关时按 TTL 过期。
const FOLLOWUP_LABELS: Record<string, string> = { pi: 'Pi', dsh: 'DSH', 'claude-code': 'Claude Code', opencode: 'OpenCode' };
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
  gap: 14px;
}
.content-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.sh-left { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 5px 7px;
}
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
.header-actions { display: flex; align-items: center; flex-shrink: 0; }
/* 分段式 Tab（胶囊） */
.seg {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px;
}
.seg-btn {
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 5px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.seg-btn:hover { color: var(--text-primary); }
.seg-btn.on {
  background: var(--surface);
  color: var(--primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(30, 36, 28, 0.1);
}

.rsession-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start; /* 面板高度跟随内容，避免背景只覆盖一屏 */
}
.msg-col {
  width: 100%;
  max-width: 900px;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px 24px 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.col-empty { text-align: center; padding: 40px 0; font-size: 13px; }

/* ===== 会话摘要卡（提炼层②） ===== */
.summary-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 12px 16px;
}
.sum-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.sum-title .bar { width: 3px; height: 12px; background: var(--primary); border-radius: 2px; }
.sum-body { font-size: 12.5px; line-height: 1.7; color: var(--text-secondary, var(--text-muted)); }
.sum-body p { margin: 0 0 4px; }
.sum-body p:last-child { margin-bottom: 0; }

.state-note {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.state-note p { margin: 0; font-size: 13px; line-height: 1.7; }

/* 消息流 */
.msg { max-width: 100%; }
/* 用户消息：右对齐收窄气泡，与助手消息形成明确的阅读流向 */
.msg.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.msg.user .msg-role { flex-direction: row-reverse; }
.msg.user .msg-content { max-width: 76%; }
.msg-role { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.role-badge {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}
.role-badge.user { background: var(--primary-soft); color: var(--primary); }
.role-badge.assistant {
  background: var(--surface-2);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}
.msg-ts { font-size: 11px; font-family: var(--font-mono); }
.msg-content {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
  border-radius: 10px;
  padding: 11px 14px;
}
/* 用户消息：主色气泡，右下角收角 */
.msg.user .msg-content {
  background: var(--primary-soft);
  border: 1px solid var(--border);
  border-bottom-right-radius: 4px;
}
/* 助手消息：正文直接排在白面板上，阅读更自然 */
.msg.assistant .msg-content {
  background: transparent;
  border: none;
  padding: 0 1px;
}
.msg-content :deep(pre) {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
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
/* 折叠条：思考过程 + 工具调用合并为一条，默认收起，点击展开 */
.msg-activity {
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 7px 12px;
}
.msg-activity summary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.msg-activity summary::-webkit-details-marker { display: none; }
.act-label { flex: 1; }
.act-arrow {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.15s;
}
.msg-activity[open] > summary .act-arrow { transform: rotate(90deg); }
.msg-activity summary:hover { color: var(--text-secondary); }
.act-thinking {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 8px 0 2px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
}
.tc-block {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
}
.tc-block.result { background: var(--surface-2); }
.tool-call { margin-top: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; background: var(--surface); }
.tool-call:first-of-type { margin-top: 8px; }
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
