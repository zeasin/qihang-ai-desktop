<!--
  McpChatPanel —— MCP 服务专属对话
  会话按 mcpchat_<serverId> 固定落库（source='mcp'，不进普通对话列表）；
  主进程按会话 id / mcpServerId 把 MCP 作用域收窄到所选服务，只注入它的工具。
-->
<template>
  <div class="mcpc">
    <div class="mcpc-scope">
      <span class="scope-tag"><AppIcon name="network" :size="11" />仅限本服务</span>
      <span class="scope-hint">本对话只会调用「{{ serverName }}」暴露的工具</span>
      <span class="grow"></span>
      <select v-model="selectedModel" class="mcpc-model" :disabled="stream.running" title="选择模型">
        <option value="">默认模型</option>
        <option v-for="m in models" :key="m.pattern" :value="m.pattern">{{ m.providerLabel }} · {{ m.name }}</option>
      </select>
    </div>

    <div ref="listEl" class="mcpc-messages">
      <div v-if="!messages.length && !stream.running && !stream.error" class="mcpc-empty">
        <div class="e-icon"><AppIcon name="message-square" :size="20" /></div>
        <p class="e-title">直接问这个 MCP 服务的数据</p>
        <p class="e-desc">对话只会调用「{{ serverName }}」的工具，不会使用其它 MCP 服务、本机知识库或本地文件。</p>
        <div class="e-examples">
          <button v-for="q in examples" :key="q" @click="askExample(q)">{{ q }}</button>
        </div>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="mcpc-msg" :class="m.role">
        <div class="bubble">
          <details v-if="m.thinking" class="think">
            <summary>💭 思考过程（{{ m.thinking.length }} 字）</summary>
            <pre>{{ m.thinking }}</pre>
          </details>
          <div v-if="m.role === 'user'" class="txt" v-html="formatUser(m.content)"></div>
          <div v-else class="txt markdown-body" v-html="renderMd(m.content)"></div>
        </div>
      </div>

      <div v-if="stream.running || stream.text || stream.error" class="mcpc-msg assistant">
        <div class="bubble">
          <details v-if="stream.thinking" class="think" open>
            <summary>💭 思考过程</summary>
            <pre>{{ stream.thinking }}</pre>
          </details>
          <div v-if="stream.text" class="txt markdown-body" v-html="renderMd(stream.text)"></div>
          <div v-if="stream.error" class="txt err">❌ {{ stream.error }}</div>
        </div>
      </div>

      <div v-if="stream.running" class="mcpc-status">
        <span class="spin">◌</span>{{ stream.status || '正在思考…' }}
      </div>
    </div>

    <div class="mcpc-composer">
      <textarea
        v-model="text"
        class="mcpc-input"
        rows="2"
        :disabled="stream.running || !API"
        placeholder="问这个 MCP 服务的数据，Enter 发送，Shift+Enter 换行…"
        @keydown.enter.exact.prevent="onEnter"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      ></textarea>
      <button class="mcpc-send" :disabled="!text.trim() || stream.running || !API" @click="send">
        {{ stream.running ? '生成中…' : '发送' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { marked } from 'marked';
import AppIcon from '@/components/AppIcon.vue';

marked.setOptions({ breaks: true, gfm: true });

const props = defineProps<{
  serverId: string;
  serverName: string;
  /** 已读取的工具清单，用于生成示例问题 */
  tools?: Array<{ name: string; description: string }>;
}>();

const API = (window as any).electronAPI;
const sessionId = 'mcpchat_' + props.serverId;
const MODEL_KEY = 'mcp_chat_model_pi';

const listEl = ref<HTMLElement>();
const text = ref('');
const composing = ref(false);
const selectedModel = ref('');
const models = ref<any[]>([]);
const messages = ref<Array<{ role: string; content: string; thinking?: string }>>([]);

const stream = reactive({ running: false, text: '', thinking: '', status: '', error: '' });

const examples = computed(() => {
  const first = (props.tools || []).find(t => /^list[_-]/i.test(t.name));
  const sample = first ? `查询最近的 ${first.name.replace(/^list[_-]/i, '')} 数据` : '查一下最近 7 天的记录';
  return ['这个服务能查哪些数据？', sample];
});

function renderMd(content: string): string {
  if (!content) return '';
  try { return marked(content) as string; } catch { return formatUser(content); }
}

function formatUser(content: string): string {
  const div = document.createElement('div');
  div.textContent = content || '';
  return div.innerHTML.replace(/\n/g, '<br>');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  });
}

async function loadModels() {
  if (!API?.pi) return;
  try {
    const res = await API.pi.models();
    models.value = (res?.models || []).filter((m: any) => m.pattern);
    const saved = localStorage.getItem(MODEL_KEY) || localStorage.getItem('chat_home_model_pi') || '';
    if (saved && models.value.some((m: any) => m.pattern === saved)) selectedModel.value = saved;
  } catch { models.value = []; }
}

async function loadHistory() {
  if (!API) return;
  try {
    const rows = await API.chat.getMessages(sessionId);
    messages.value = (rows || [])
      .filter((m: any) => m.role !== 'assistant' || String(m.content || '').trim())
      .map((m: any) => ({ role: m.role, content: m.content, thinking: m.thinking || '' }));
  } catch { messages.value = []; }
  scrollToBottom();
}

function askExample(q: string) {
  text.value = q;
  void send();
}

function onEnter() {
  if (composing.value) return;
  void send();
}

async function send() {
  const q = text.value.trim();
  if (!q || stream.running || !API) return;
  messages.value.push({ role: 'user', content: q });
  text.value = '';
  stream.running = true;
  stream.text = '';
  stream.thinking = '';
  stream.status = '准备中…';
  stream.error = '';
  scrollToBottom();
  try {
    await API.chat.send(q, sessionId, '', undefined, 'general', selectedModel.value || undefined, props.serverId);
    if (selectedModel.value) localStorage.setItem(MODEL_KEY, selectedModel.value);
  } catch (e: any) {
    stream.running = false;
    stream.status = '';
    stream.error = (e && e.message) || '发送失败';
  }
}

function onStatus(d: any) {
  if (d.sessionId !== sessionId) return;
  stream.running = true;
  stream.error = '';
  stream.status = d.text || '';
}

function onDelta(d: any) {
  if (d.sessionId !== sessionId) return;
  if (!stream.running) { stream.running = true; stream.text = ''; stream.thinking = ''; }
  stream.error = '';
  stream.text += d.text || '';
  stream.status = '';
  scrollToBottom();
}

function onThinking(d: any) {
  if (d.sessionId !== sessionId) return;
  if (!stream.running) { stream.running = true; stream.text = ''; stream.thinking = ''; }
  stream.thinking += d.text || '';
  scrollToBottom();
}

function onTool(d: any) {
  if (d.sessionId !== sessionId) return;
  const raw = String(d.name || '');
  const label = raw.startsWith('mcp__') ? '🔌 ' + raw.replace(/^mcp__/, '').replace(/__/g, ' · ') : '🔧 ' + raw;
  if (d.type === 'start') stream.status = `${label} 正在执行`;
  else if (d.type === 'end') stream.status = `${d.error ? '❌' : '✅'} ${label} ${d.error ? '失败' : '完成'}`;
}

async function finishTurn() {
  stream.running = false;
  stream.text = '';
  stream.thinking = '';
  stream.status = '';
  await loadHistory();
}

function onDone(d: any) {
  if (d.sessionId !== sessionId) return;
  void finishTurn();
}

function onError(d: any) {
  if (d.sessionId !== sessionId) return;
  stream.running = false;
  stream.thinking = '';
  stream.status = '';
  stream.text = '';
  stream.error = d.text || '未知错误';
}

function bindEvents() {
  if (!API) return;
  API.on('chat:status', onStatus);
  API.on('chat:delta', onDelta);
  API.on('chat:thinking', onThinking);
  API.on('chat:tool', onTool);
  API.on('chat:done', onDone);
  API.on('chat:error', onError);
}

onMounted(async () => {
  await loadModels();
  await loadHistory();
  bindEvents();
});

onBeforeUnmount(() => {
  if (!API) return;
  for (const ch of ['chat:status', 'chat:delta', 'chat:thinking', 'chat:tool', 'chat:done', 'chat:error']) {
    API.removeAllListeners(ch);
  }
});
</script>

<style scoped>
.mcpc { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ========== 作用域提示条 ========== */
.mcpc-scope {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 18px; border-bottom: 1px solid var(--border);
  background: var(--surface-2); flex-shrink: 0;
}
.scope-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 4px 8px; border-radius: 999px;
  background: var(--primary-soft); color: var(--primary);
  flex-shrink: 0;
}
.scope-hint { font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcpc-scope .grow { flex: 1; }
.mcpc-model {
  flex-shrink: 0; max-width: 190px;
  font: inherit; font-size: 11.5px; color: var(--text-secondary);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 6px; outline: none; cursor: pointer;
}
.mcpc-model:focus { border-color: var(--primary); }

/* ========== 消息 ========== */
.mcpc-messages {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 14px 18px; display: flex; flex-direction: column; gap: 12px;
}
.mcpc-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px;
  text-align: center; color: var(--text-muted); padding: 20px;
}
.mcpc-empty .e-icon {
  width: 42px; height: 42px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--primary-soft); color: var(--primary); margin-bottom: 4px;
}
.mcpc-empty .e-title { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.mcpc-empty .e-desc { font-size: 11.5px; line-height: 1.7; max-width: 420px; }
.e-examples { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 8px; }
.e-examples button {
  font: inherit; font-size: 11.5px; color: var(--text-secondary);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 999px; padding: 5px 11px; cursor: pointer; transition: all 0.15s;
}
.e-examples button:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }

.mcpc-msg { display: flex; }
.mcpc-msg.user { justify-content: flex-end; }
.mcpc-msg.assistant { justify-content: flex-start; }
.bubble { max-width: 88%; border-radius: 10px; padding: 9px 12px; font-size: 13px; line-height: 1.7; }
.mcpc-msg.user .bubble { background: var(--primary); color: #fff; }
.mcpc-msg.assistant .bubble { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-primary); }
.bubble .txt { word-break: break-word; }
.bubble .err { color: var(--danger); font-size: 12.5px; }

.think { margin-bottom: 6px; }
.think summary { font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
.think pre {
  margin-top: 5px; padding: 7px 9px; border-radius: 6px;
  background: var(--hover); color: var(--text-secondary);
  font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  max-height: 200px; overflow-y: auto;
}

.mcpc-status {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--text-muted); padding: 2px 2px 6px;
}
.spin { display: inline-block; animation: mcpc-spin 1s linear infinite; }
@keyframes mcpc-spin { to { transform: rotate(360deg); } }

/* ========== 输入区 ========== */
.mcpc-composer {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 10px 18px 12px; border-top: 1px solid var(--border);
  background: var(--surface); flex-shrink: 0;
}
.mcpc-input {
  flex: 1; resize: none; min-height: 46px; max-height: 120px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-main); color: var(--text-primary);
  font: inherit; font-size: 12.5px; line-height: 1.6; outline: none;
}
.mcpc-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(var(--primary-rgb), 0.12); }
.mcpc-input:disabled { opacity: 0.7; }
.mcpc-send {
  flex-shrink: 0; height: 34px; padding: 0 14px;
  border: none; border-radius: 8px; background: var(--primary); color: #fff;
  font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
}
.mcpc-send:hover { background: var(--primary-dark); }
.mcpc-send:disabled { opacity: 0.45; cursor: default; }
</style>
