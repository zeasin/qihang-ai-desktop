<!--
  RadarAskView —— 问雷达（独立页面）
  基于已采集对话的检索问答：关键词检索 → AI 汇总 → 答案 + 来源会话（可点击跳详情）。
  空态为居中 hero 布局（引导提问），提问后切换为紧凑顶栏 + 答案排版，避免大片空白。
-->
<template>
  <div class="radar-ask-view">
    <!-- 顶栏：返回 + 标题 -->
    <div class="content-header">
      <div class="sh-left">
        <button class="btn btn-secondary btn-sm back-btn" @click="goBack">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
          雷达
        </button>
        <div>
          <h1>问雷达</h1>
          <div class="text-muted header-sub">向已采集的本机 AI 工具历史对话提问，答案附带来源会话</div>
        </div>
      </div>
    </div>

    <div class="ask-body" :class="{ centered: isEmpty }">
      <!-- 空态引导头 -->
      <div v-if="isEmpty" class="hero-head">
        <div class="hero-icon"><AppIcon name="radar" :size="28" /></div>
        <div class="hero-title">问问你的历史对话</div>
        <div class="hero-sub text-muted">关键词检索已采集会话，AI 汇总答案并标注来源</div>
      </div>

      <!-- 提问栏（composer 卡片） -->
      <div class="composer" :class="{ compact: !isEmpty }">
        <input
          v-model="question"
          type="text"
          class="composer-input"
          placeholder="问问已采集的对话，比如：最近哪个会话在调 POS 折扣？"
          :disabled="asking"
          @keyup.enter="doAsk"
        />
        <select class="model-selector" v-model="selectedModel" :disabled="asking || modelsLoading" title="选择大模型">
          <option value="">默认模型</option>
          <option v-if="modelsLoading" value="" disabled>模型加载中…</option>
          <option v-for="m in piModels" :key="m.pattern" :value="m.pattern">
            {{ m.providerLabel }} · {{ m.name }}
          </option>
        </select>
        <button class="btn btn-primary ask-btn" :disabled="asking || !question.trim()" @click="doAsk">
          {{ asking ? '思考中…' : '提问' }}
        </button>
      </div>

      <!-- 空态示例卡片 -->
      <div v-if="isEmpty" class="examples">
        <div v-for="(t, i) in EXAMPLES" :key="t" class="example-card" @click="askExample(t)">
          <AppIcon :name="EXAMPLE_ICONS[i] || 'search'" :size="15" />
          <span>{{ t }}</span>
        </div>
      </div>

      <div v-if="asking" class="thinking"><span class="spin">◌</span> 正在检索已采集对话并汇总…</div>

      <div v-if="error" class="ask-error">❌ {{ error }}</div>

      <!-- 答案 -->
      <div v-if="result" class="ask-result">
        <div class="ask-answer markdown-body" v-html="answerHtml"></div>
        <div v-if="result.refs && result.refs.length" class="ask-refs">
          <div class="refs-title text-muted">来源会话（{{ result.refs.length }}）· 点击进入详情</div>
          <div
            v-for="(r, i) in result.refs"
            :key="r.tool + '/' + r.sessionId"
            class="ref-row"
            @click="openSession(r)"
          >
            <span class="badge badge-gray ref-no">S{{ i + 1 }}</span>
            <span class="ref-tool">{{ toolLabel(r.tool) }}</span>
            <span class="ref-title">{{ r.title || '（无标题）' }}</span>
            <span class="text-muted ref-dir">{{ shortDir(r.projectDir) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { marked } from 'marked';
import AppIcon from '../components/AppIcon.vue';

const API: any = (window as any).electronAPI;
const router = useRouter();

const MODEL_KEY = 'radar_ask_model_pi';
const CHAT_MODEL_KEY = 'chat_home_model_pi';

const EXAMPLES = [
  '最近哪个会话在改支付相关逻辑？',
  '有哪些会话遇到了编译报错',
  '今天都干了些什么',
];
const EXAMPLE_ICONS = ['clock', 'search', 'calendar'];

const question = ref('');
const asking = ref(false);
const result = ref<any>(null);
const error = ref('');

/** 空态：未提问且无结果时用居中 hero 布局 */
const isEmpty = computed(() => !asking.value && !result.value && !error.value);

const answerHtml = computed(() => {
  const text = result.value?.answer || '';
  try { return marked(text, { async: false }) as string; } catch { return text; }
});

// ===== 大模型选择（与聊天页同源：API.pi.models，记住上次选择，缺省跟随聊天页） =====
const piModels = ref<any[]>([]);
const modelsLoading = ref(false);
const selectedModel = ref('');

async function loadModels() {
  modelsLoading.value = true;
  try {
    const res = await API.pi.models();
    piModels.value = (res?.models || []).filter((m: any) => m.pattern);
    const saved = localStorage.getItem(MODEL_KEY);
    if (saved && piModels.value.some((m: any) => m.pattern === saved)) {
      selectedModel.value = saved;
    } else {
      const chatSaved = localStorage.getItem(CHAT_MODEL_KEY);
      if (chatSaved && piModels.value.some((m: any) => m.pattern === chatSaved)) {
        selectedModel.value = chatSaved;
      } else {
        const first = piModels.value.find((m: any) => m.configured);
        if (first) selectedModel.value = first.pattern;
      }
    }
  } catch { piModels.value = []; }
  finally { modelsLoading.value = false; }
}
onMounted(loadModels);

const TOOL_LABELS: Record<string, string> = {
  zcode: 'ZCode', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi',
};
const toolLabel = (t: string) => TOOL_LABELS[t] || t;

function goBack() {
  router.push('/radar');
}
function askExample(t: string) {
  if (asking.value) return;
  question.value = t;
  void doAsk();
}
async function doAsk() {
  const q = question.value.trim();
  if (!q || asking.value) return;
  asking.value = true;
  error.value = '';
  result.value = null;
  try {
    const r = await API.radar.ask(q, selectedModel.value || undefined);
    if (r?.ok) {
      result.value = r;
      if (selectedModel.value) localStorage.setItem(MODEL_KEY, selectedModel.value);
      else localStorage.removeItem(MODEL_KEY);
    }
    else error.value = r?.error || '提问失败，请重试';
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally { asking.value = false; }
}
function openSession(r: any) {
  router.push({ path: `/radar/session/${encodeURIComponent(r.tool)}/${encodeURIComponent(r.sessionId)}` });
}
function shortDir(dir: string): string {
  const d = String(dir || '').replace(/\\/g, '/');
  if (!d) return '';
  const parts = d.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : d;
}
</script>

<style scoped>
.radar-ask-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 20px 24px 16px;
  box-sizing: border-box;
  gap: 14px;
}
.sh-left { display: flex; align-items: center; gap: 12px; }
.sh-left h1 { margin: 0; font-size: 18px; }
.header-sub { font-size: 12.5px; margin-top: 2px; }

.ask-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 8px;
}
/* 空态：整体在剩余空间居中（略偏上），消除大片空白 */
.ask-body.centered {
  justify-content: center;
  padding-bottom: 10vh;
}

/* ===== 空态引导头 ===== */
.hero-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.hero-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--primary-soft);
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
}
.hero-title { font-size: 20px; font-weight: 700; color: var(--text-primary); }
.hero-sub { font-size: 13px; }

/* ===== 提问 composer 卡片 ===== */
.composer {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.composer:focus-within {
  border-color: var(--primary, #2563eb);
  box-shadow: 0 0 0 3px var(--primary-soft, rgba(37, 99, 235, 0.12));
}
.composer.compact { padding: 8px 10px; border-radius: 10px; }
.composer-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 13.5px;
  color: var(--text-primary);
}
.composer-input::placeholder { color: var(--text-muted); }
.model-selector {
  flex-shrink: 0;
  font-size: 12px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  max-width: 190px;
  outline: none;
  cursor: pointer;
  transition: all 0.2s;
}
.model-selector:hover { border-color: var(--primary, #2563eb); }
.ask-btn { flex-shrink: 0; border-radius: 8px; }

/* ===== 空态示例卡片 ===== */
.examples {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.example-card {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  min-width: 0;
}
.example-card svg { color: var(--text-muted); flex-shrink: 0; transition: color 0.15s; }
.example-card span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.example-card:hover {
  border-color: var(--primary, #2563eb);
  background: var(--primary-soft);
  color: var(--primary, #2563eb);
}
.example-card:hover svg { color: var(--primary, #2563eb); }

/* ===== 提问中 ===== */
.thinking {
  font-size: 13px;
  color: var(--text-muted);
  padding: 10px 4px;
}
.spin {
  display: inline-block;
  animation: ask-spin 1s linear infinite;
}
@keyframes ask-spin { to { transform: rotate(360deg); } }

.ask-error { font-size: 12.5px; color: var(--danger, #d9534f); }

/* ===== 答案面板 ===== */
.ask-result {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 22px;
  background: var(--surface);
}
.ask-answer { font-size: 13.5px; line-height: 1.8; }
.ask-answer :deep(p) { margin: 0 0 10px; }
.ask-answer :deep(p:last-child) { margin-bottom: 0; }
.ask-answer :deep(ul), .ask-answer :deep(ol) { margin: 4px 0 10px; padding-left: 22px; }
.ask-answer :deep(h1), .ask-answer :deep(h2), .ask-answer :deep(h3), .ask-answer :deep(h4) { margin: 14px 0 8px; font-size: 14px; }
.ask-answer :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--hover);
  padding: 1px 5px;
  border-radius: 4px;
}
.ask-answer :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }
.ask-answer :deep(th), .ask-answer :deep(td) { border: 1px solid var(--border); padding: 5px 10px; text-align: left; }
.ask-answer :deep(blockquote) { border-left: 3px solid var(--border); margin: 8px 0; padding: 2px 12px; color: var(--text-muted); }

/* ===== 来源会话 ===== */
.ask-refs {
  margin-top: 16px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
.refs-title { font-size: 12px; margin-bottom: 8px; }
.ref-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
  min-width: 0;
}
.ref-row:hover { background: var(--hover); }
.ref-no { flex-shrink: 0; }
.ref-tool { flex-shrink: 0; font-weight: 600; }
.ref-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref-dir {
  flex-shrink: 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}
</style>
