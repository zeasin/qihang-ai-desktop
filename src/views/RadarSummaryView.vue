<!--
  RadarSummaryView —— 摘要详情页（从会话档案「摘要」视图卡片进入）
  整页专注阅读单条会话摘要：四段卡片 markdown 全文 + 元信息，
  「查看对话原文」跳会话详情页。数据来自本地 radar 库（API.radar.sessionInfo）。
-->
<template>
  <div class="rsummary-view">
    <!-- 头部 -->
    <div class="content-header">
      <div class="sh-left">
        <button class="btn btn-secondary btn-sm back-btn" title="返回" @click="goBack">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
        </button>
        <div class="sh-info">
          <h1 class="sh-title">{{ info?.title || '（无标题）' }}</h1>
          <div class="sh-sub text-muted">
            <span class="tool-tag">{{ toolLabel(tool) }}</span>
            <span v-if="summaryAtText" class="rs-ts">提炼于 {{ summaryAtText }}</span>
            <span v-if="info?.messageCount">{{ info.messageCount }} 条消息</span>
            <span v-if="projectDir" class="rs-dir" :title="projectDir">{{ projectDir }}</span>
          </div>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="openSession">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
          查看对话原文
        </button>
      </div>
    </div>

    <!-- 正文：居中阅读列 -->
    <div class="rsummary-body">
      <div v-if="!info && !loading" class="state-note">
        <p class="text-muted">会话不存在或链接无效。</p>
        <button class="btn btn-secondary btn-sm" @click="goBack">返回</button>
      </div>
      <div v-else-if="info && !info.summary && !loading" class="state-note">
        <p class="text-muted">该会话还没有摘要（价值分达标的会话收口后自动提炼）。</p>
        <button class="btn btn-secondary btn-sm" @click="openSession">查看对话原文</button>
      </div>
      <div v-else-if="loading" class="state-note">
        <p class="text-muted">加载中…</p>
      </div>
      <article v-else-if="info?.summary" class="summary-article">
        <div class="sum-tag"><i class="bar"></i>会话摘要</div>
        <div class="sum-body markdown-body" v-html="summaryHtml"></div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
const loading = ref(true);

const TOOL_LABELS: Record<string, string> = {
  zcode: 'ZCode', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi',
};
const toolLabel = (t: string) => TOOL_LABELS[t] || t;

const projectDir = computed(() => info.value?.projectDir || '');
const summaryAtText = computed(() => {
  const ts = Number(info.value?.summaryAt) || 0;
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
});

// 渲染前清洗模板噪音（codex 照抄的 Task handoff 开头）
const summaryHtml = computed(() => {
  const s = cleanSummaryText(info.value?.summary || '');
  try { return marked(s, { async: false }) as string; } catch { return s; }
});

function goBack() {
  if (window.history.length > 1) router.back();
  else router.push('/radar/all');
}
function openSession() {
  router.push({ path: `/radar/session/${encodeURIComponent(tool.value)}/${encodeURIComponent(sessionId.value)}` });
}

onMounted(async () => {
  try {
    const res = await API.radar.sessionInfo(tool.value, sessionId.value);
    if (res?.info) info.value = res.info;
  } catch { /* 保持空态 */ }
  finally { loading.value = false; }
});
</script>

<style scoped>
.rsummary-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.sh-title { font-size: 15px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 52vw; }
.sh-sub { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 2px; }
.tool-tag { font-weight: 600; color: var(--text-primary); }
.rs-ts { font-family: var(--font-mono); font-size: 11px; }
.rs-dir { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.rsummary-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 0 40px;
}
.state-note {
  max-width: 640px;
  margin: 60px auto 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.summary-article {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 20px;
}
.sum-tag {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.sum-tag .bar { width: 3px; height: 13px; border-radius: 2px; background: var(--primary); }
.sum-body {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  padding: 18px 22px;
  font-size: 13.5px;
  line-height: 1.85;
}
</style>
