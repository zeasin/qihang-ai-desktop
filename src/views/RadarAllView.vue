<!--
  RadarAllView —— 会话档案页（全部对话记录）
  浏览雷达沉淀的所有会话：工具筛选 + 全文搜索 + 分页；点击行进入会话详情。
  数据全部来自本地 radar 库（API.radar.sessions 空关键词 = 全量分页列表）。
-->
<template>
  <div class="rall-view">
    <div class="content-header">
      <div class="sh-left">
        <button class="btn btn-secondary btn-sm back-btn" title="返回" @click="goBack">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
        </button>
        <div>
          <h1>会话档案</h1>
          <div class="text-muted header-sub">雷达沉淀的全部 AI 工具对话 · 共 {{ total }} 个会话</div>
        </div>
      </div>
      <input
        v-model="keyword"
        type="text"
        class="form-control search-input"
        placeholder="全文搜索所有对话…"
        @input="onSearchInput"
      >
    </div>

    <!-- 工具筛选 -->
    <div class="filter-row">
      <button
        v-for="t in toolOptions"
        :key="t.key"
        class="filter-chip"
        :class="{ on: toolFilter === t.key }"
        @click="setToolFilter(t.key)"
      >{{ t.label }}</button>
    </div>

    <div ref="tableEl" class="session-table">
      <div v-for="s in rows" :key="s.tool + '/' + s.sessionId" class="session-row" @click="openSession(s)">
        <span class="sm-time">{{ fmtClock(s.sourceUpdatedAt) }}</span>
        <span class="sm-tool">
          <i class="sm-dot" :class="s.state === 'running' ? 'run' : 'idle'"></i>{{ toolLabel(s.tool) }}
        </span>
        <span class="sm-title">
          <template v-for="(seg, i) in hlSegments(s.title || '（无标题）')" :key="i"><mark v-if="seg.hit" class="hl">{{ seg.t }}</mark><template v-else>{{ seg.t }}</template></template>
        </span>
        <span class="sm-project text-muted">{{ shortDir(s.projectDir) }}</span>
        <span class="badge" :class="s.state === 'running' ? 'badge-primary' : 'badge-gray'">
          {{ s.frozen ? '冻结' : (s.state === 'running' ? '活跃' : '历史') }}
        </span>
        <span v-if="(s.valueScore || 0) >= 3" class="badge badge-warning" title="高价值会话：轮数/输入/时长达标，已自动提炼摘要">★ 高价值</span>
        <span v-if="s.summary" class="sm-summary text-muted" :title="s.summary">
          <template v-for="(seg, i) in hlSegments(s.summary.split('\n')[0].replace(/\*\*/g, ''))" :key="i"><mark v-if="seg.hit" class="hl">{{ seg.t }}</mark><template v-else>{{ seg.t }}</template></template>
        </span>
        <span class="sm-count text-muted">{{ s.actual_count || s.messageCount || 0 }} 消息</span>
      </div>
      <div v-if="!rows.length && !loading" class="row-empty text-muted">{{ keyword.trim() ? '无匹配结果' : '暂无会话' }}</div>
      <div v-if="loading" class="row-empty text-muted">加载中…</div>
    </div>

    <!-- 分页（搜索模式下为全量结果，无分页） -->
    <div v-if="!keyword.trim() && total > 0" class="pager">
      <button class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
      <span class="text-muted pager-info">第 {{ page }} / {{ totalPages }} 页</span>
      <button class="btn btn-secondary btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';

const API: any = (window as any).electronAPI;
const router = useRouter();

const TOOL_LABELS: Record<string, string> = {
  zcode: 'ZCode', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi',
};
const toolLabel = (t: string) => TOOL_LABELS[t] || t;

const toolOptions = [
  { key: '', label: '全部' },
  ...Object.keys(TOOL_LABELS).map((k) => ({ key: k, label: TOOL_LABELS[k] })),
];

const rows = ref<any[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 50;
const toolFilter = ref('');
const keyword = ref('');
const loading = ref(false);
const tableEl = ref<HTMLElement | null>(null);
let searchTimer: number | undefined;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

async function load() {
  loading.value = true;
  try {
    const res = await API.radar.sessions({ tool: toolFilter.value || undefined, q: keyword.value.trim() || undefined, page: page.value, pageSize });
    rows.value = res.rows || [];
    total.value = Number(res.total) || 0;
  } catch { rows.value = []; total.value = 0; }
  finally { loading.value = false; }
  // 翻页/搜索后回到列表顶部
  await nextTick();
  if (tableEl.value) tableEl.value.scrollTop = 0;
}

function setToolFilter(key: string) {
  toolFilter.value = key;
  page.value = 1;
  void load();
}
function goPage(p: number) {
  page.value = p;
  void load();
}
function onSearchInput() {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { page.value = 1; void load(); }, 300);
}
function openSession(s: any) {
  router.push({ path: `/radar/session/${encodeURIComponent(s.tool)}/${encodeURIComponent(s.sessionId)}` });
}

// ========== 搜索词高亮（与 findSessions 同口径：整词 + 中文 2 字词兜底） ==========
const hlTerms = computed(() => {
  const kw = keyword.value.trim();
  if (!kw) return [];
  const terms = new Set<string>([kw]);
  const chars = [...kw.replace(/[^\u4e00-\u9fa5]/g, '')];
  if (chars.length >= 2) {
    for (let i = 0; i + 1 < chars.length; i += 2) terms.add(chars[i] + chars[i + 1]);
    if (chars.length % 2 === 1) terms.add(chars[chars.length - 2] + chars[chars.length - 1]);
  }
  return [...terms];
});

function hlSegments(text: string): { t: string; hit: boolean }[] {
  const src = String(text || '');
  const terms = hlTerms.value;
  if (!terms.length || !src) return [{ t: src, hit: false }];
  const lower = src.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    let idx = lower.indexOf(t);
    while (idx !== -1) {
      ranges.push([idx, idx + t.length]);
      idx = lower.indexOf(t, idx + 1);
    }
  }
  if (!ranges.length) return [{ t: src, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r] as [number, number]);
  }
  const segs: { t: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) segs.push({ t: src.slice(pos, s), hit: false });
    segs.push({ t: src.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < src.length) segs.push({ t: src.slice(pos), hit: false });
  return segs;
}
function goBack() {
  router.push('/overview');
}

function fmtClock(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function shortDir(dir: string): string {
  const d = String(dir || '').replace(/\\/g, '/');
  if (!d) return '';
  const parts = d.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : d;
}

onMounted(load);
</script>

<style scoped>
.rall-view {
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
.sh-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.sh-left h1 { margin: 0; font-size: 18px; }
.header-sub { font-size: 12px; margin-top: 3px; }
.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 5px 7px;
}
.search-input { width: 260px; font-size: 12.5px; }

.filter-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.filter-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s;
}
.filter-chip:hover { color: var(--text-primary); border-color: var(--text-muted); }
.filter-chip.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }

.session-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.session-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  cursor: pointer;
}
.session-row:last-child { border-bottom: none; }
.session-row:hover { background: var(--primary-soft); }
.sm-time { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); width: 108px; flex-shrink: 0; }
.sm-tool { font-weight: 600; color: var(--text-primary); width: 92px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; }
.sm-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); opacity: 0.4; }
.sm-dot.run { background: var(--primary); opacity: 1; }
.sm-title { flex: 1; min-width: 0; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-project { font-family: var(--font-mono); font-size: 11px; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.sm-summary { font-size: 11.5px; max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.sm-count { flex-shrink: 0; font-size: 11px; }
.row-empty { padding: 24px; text-align: center; font-size: 12.5px; }

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  flex-shrink: 0;
}
.pager-info { font-size: 12px; font-variant-numeric: tabular-nums; }

mark.hl {
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  color: var(--primary);
  font-weight: 600;
  padding: 0 1px;
  border-radius: 2px;
}
</style>
