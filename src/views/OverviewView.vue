<template>
  <div class="page today-view">
    <!-- ========== 页头 ========== -->
    <header class="page-head">
      <div>
        <h1 class="page-title">{{ pageDateStr }} <small>{{ pageWeekStr }}</small></h1>
        <p class="page-sub">{{ greeting }}{{ digestMeta ? ' · ' + digestMeta : '' }}</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-secondary" :disabled="digestLoading" @click="loadNoteDigest">
          <AppIcon name="refresh-cw" :size="13" />{{ digestLoading ? '扫描中…' : '重新扫描' }}
        </button>
        <button class="btn btn-sm btn-secondary" :disabled="syncing" @click="syncDone" title="把笔记里已勾选的 - [x] 对应任务标记完成">
          <AppIcon name="check" :size="13" />同步完成项
        </button>
        <button class="btn btn-sm btn-secondary" @click="openNotes">
          <AppIcon name="book-open" :size="13" />浏览笔记
        </button>
        <button class="icon-btn" @click="openConfig" title="管理项目"><AppIcon name="settings" :size="14" /></button>
      </div>
    </header>

    <!-- 一个笔记库都没有：AI 功能门禁 -->
    <NotesGate
      v-if="notesLoaded && !kbCount"
      compact
      desc="今天的待办、跟进、工作日志全部由笔记库提炼，添加至少一个笔记库后自动可用；数据集、提醒不受影响。"
      @ready="onGateReady"
    />

    <template v-else>
      <!-- ========== 概览统计行 ========== -->
      <div class="statline">
        <span>待你处理 <b class="acc">{{ digestPending.length }}</b></span>
        <span>笔记已勾 <b>{{ digestDoneCount }}</b></span>
      </div>

      <!-- ========== 昨日简报（AI 生成，昨日雷达动态 + 今日待办；失败回落原规则简报） ========== -->
      <section class="brief panel">
        <div class="sec-label">
          <AppIcon name="sparkles" :size="13" />昨日简报
          <em>{{ briefMetaText }}</em>
          <button class="brief-refresh brief-history" :disabled="briefLoading" title="查看历史简报（笔记库「日报/AI活动」目录，按日期逐份保存）" @click="goBriefHistory">历史</button>
          <button class="brief-refresh" :disabled="briefLoading" :title="briefLoading ? '生成中…' : '重新生成（覆盖落盘文件，不重推飞书）'" @click="regenBrief">{{ briefLoading ? '⋯' : '⟳' }}</button>
        </div>
        <div v-if="briefLoading && !briefMd" class="brief-body"><p>正在汇总昨日 AI 工具动态与笔记库，生成昨日简报…（首次约十几秒）</p></div>
        <div v-else-if="briefMd" class="brief-body brief-md" v-html="briefHtml"></div>
        <div v-else-if="briefEmpty" class="brief-body"><p>昨天没有 AI 会话与笔记更新。开始工作后，明天早上这里会生成昨日简报。</p></div>
        <div v-else class="brief-body">
          <p v-for="(line, i) in briefLines" :key="i" v-html="line"></p>
          <p v-if="briefError" class="brief-err">{{ briefError }}</p>
        </div>
      </section>

      </template>

      <!-- ========== 智能体雷达（原独立雷达页整体并入，不依赖笔记库） ========== -->
      <section class="radar-embed-sec">
        <AgentRadarView embedded />
      </section>

      <template v-if="notesLoaded && kbCount">
      <div class="grid2">
      <div class="col">
      <!-- ========== 等你处理 ========== -->
      <div class="sec-label"><AppIcon name="list-checks" :size="13" />等你处理<em>{{ digestPending.length + todos.length }} 项</em></div>
      <section class="panel todo-panel">
        <!-- 本地待办（可勾选） -->
        <div v-for="t in todos" :key="'lt' + t.id" class="todo-row" :class="{ done: t.status === 'done', overdue: t.due_date && t.due_date < todayStr && t.status !== 'done' }">
          <button class="todo-box" :title="t.status === 'done' ? '标记为未完成' : '标记完成'" @click="toggleTodo(t)">
            <AppIcon v-if="t.status === 'done'" name="check" :size="11" />
          </button>
          <span class="prio" :class="t.priority"></span>
          <span class="todo-tx">{{ t.title }}</span>
          <span class="todo-src">本地待办</span>
          <span class="todo-dt" :class="{ warm: t.due_date && t.due_date < todayStr && t.status !== 'done' }">{{ t.due_date || '' }}</span>
        </div>
        <div v-if="!todos.length" class="empty-row">本地库暂无待办</div>
        <!-- 来自笔记的待办（按 项目+文件 分组，勾选回写笔记） -->
        <template v-for="g in digestTodoGroups" :key="g.project + '/' + g.file">
          <div class="src-title" :title="g.project + ' / ' + g.file"><AppIcon name="file-text" :size="11" />{{ g.file }}<span class="src-count">{{ g.items.length }}</span></div>
          <div v-for="t in g.items" :key="g.project + '/' + g.file + ':' + t.line" class="todo-row ro" :title="g.project + ' / ' + g.file + ':' + t.line">
            <button
              class="todo-box ro-box"
              :disabled="checking === g.project + '/' + g.file + ':' + t.line"
              :title="checking === g.project + '/' + g.file + ':' + t.line ? '正在回写笔记…' : '勾选完成并回写笔记'"
              @click="checkDigestTodo(t, g.file)"
            >
              <AppIcon v-if="checking === g.project + '/' + g.file + ':' + t.line" name="loader" :size="11" />
            </button>
            <span class="todo-tx">{{ t.text }}</span>
            <span class="todo-src">来自 {{ t.project }}</span>
            <span class="todo-dt">{{ t.line || '' }}</span>
          </div>
        </template>
        <div v-if="digestPending.length > shownTodoCount" class="empty-row">仅列出前 {{ shownTodoCount }} 条，共 {{ digestPending.length }} 条</div>
        <div v-if="!digestPending.length && !todos.length" class="empty-row">{{ digestLoading ? '正在扫描笔记…' : '笔记里没有未勾选的待办' }}</div>
      </section>
      </div>

      <!-- ========== 工作日志（笔记库最近更新的文档） ========== -->
      <section>
        <div class="sec-label"><AppIcon name="history" :size="13" />工作日志<em>{{ recentFiles.length }}</em></div>
        <div class="panel list-panel">
          <div
            v-for="f in recentFiles"
            :key="f.projectId + '/' + f.rel"
            class="file-row"
            :title="f.projectName + ' / ' + f.rel + '（点击在笔记中打开）'"
            @click="openNoteFile(f)"
          >
            <AppIcon name="file-text" :size="14" />
            <span class="plan-tx">
              <b>{{ f.rel.split('/').pop() }}</b>
              <small>{{ f.projectName }}/{{ f.rel.split('/').slice(0, -1).join('/') }}</small>
            </span>
            <span class="todo-dt">{{ fileTime(f.mtime) }}</span>
          </div>
          <div v-if="!recentFiles.length" class="empty-row">笔记库最近没有文件更新</div>
        </div>
      </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { marked } from 'marked';
import NotesGate from '@/components/NotesGate.vue';
import AppIcon from '@/components/AppIcon.vue';
import AgentRadarView from './AgentRadarView.vue';

const API = window.electronAPI;
const router = useRouter();

const kbCount = ref(0);
const notesLoaded = ref(false);

const openNotes = () => router.push('/notes');
const openConfig = () => router.push('/config');

const stats = ref({
  fileCount: 0, notesFileCount: 0, chunkCount: 0, todayModified: 0, projectCount: 0, totalChats: 0, todoPending: 0, todoOverdue: 0, remindersActive: 0, todayDataRecords: 0
});

const reports = ref<any[]>([]);
const reportCron = ref('');

const reportScheduleText = computed(() => {
  if (reportCron.value) {
    const parts = reportCron.value.split(' ');
    if (parts.length >= 2) {
      const hour = parts[1].padStart(2, '0');
      const min = parts[0].padStart(2, '0');
      return `每日 ${hour}:${min}`;
    }
  }
  return '';
});

const reportPushText = ref('，可推送飞书');

const todos = ref<any[]>([]);
const todayStr = ref('');

// ========== 页头日期与问候 ==========
const pageDateStr = computed(() => {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
});
const pageWeekStr = computed(() => {
  const w = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return w[new Date().getDay()];
});
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

// ========== 引擎简报（由现有数据汇编，不额外调用 AI） ==========
const briefLines = computed(() => {
  const lines: string[] = [];
  const latest = reports.value[0];
  if (latest) {
    const points = keyPointGroups.value.flatMap((g) => g.items).slice(0, 2);
    lines.push(
      `最新综合日报 <b>《${latest.report_date || '最新'}》</b> 已生成${latest.created_at ? '（' + latest.created_at + '）' : ''}` +
      (reportScheduleText.value ? `，${reportScheduleText.value}自动更新` : '') + '。'
    );
    for (const p of points) lines.push(escapeHtml(p).replace(/：(\d[\d,.]*)/g, '：<b>$1</b>') + '。');
  }
  if (digest.value) {
    const dp = digestPending.value.length;
    if (dp) {
      lines.push(`笔记库扫描 <b>${digest.value.scannedFiles ?? 0}</b> 个文件：发现未勾待办 <b>${dp}</b> 项。`);
    }
  }
  return lines.slice(0, 4);
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== 今日简报（AI 生成：AI 工具动态 + 笔记库动态；失败/无数据回落规则简报） ==========
const briefMd = ref('');
const briefGeneratedAt = ref('');
const briefLoading = ref(false);
const briefEmpty = ref(false);
const briefError = ref('');
const briefHtml = computed(() => {
  try { return marked.parse(briefMd.value, { async: false }) as string; } catch { return briefMd.value; }
});
const briefMetaText = computed(() => {
  if (briefLoading.value) return '生成中…';
  if (briefGeneratedAt.value) return 'AI 生成 · ' + briefGeneratedAt.value;
  return 'AI 汇总昨日动态与今日待办';
});
async function loadBrief(force = false) {
  if (briefLoading.value) return;
  briefLoading.value = true;
  try {
    const r: any = await API.radar.brief(force);
    if (r?.ok && r.brief) {
      briefMd.value = r.brief;
      briefGeneratedAt.value = r.generatedAt || '';
      briefEmpty.value = false;
      briefError.value = '';
    } else if (r?.ok && r.empty) {
      briefMd.value = '';
      briefGeneratedAt.value = '';
      briefEmpty.value = true;
      briefError.value = '';
    } else {
      briefMd.value = '';
      briefGeneratedAt.value = '';
      briefEmpty.value = false;
      briefError.value = r?.error ? 'AI 简报生成失败：' + r.error + '（下方为规则简报）' : '';
    }
  } catch (e: any) {
    briefMd.value = '';
    briefEmpty.value = false;
    briefError.value = 'AI 简报生成失败：' + (e?.message || e) + '（下方为规则简报）';
  } finally {
    briefLoading.value = false;
  }
}
function regenBrief() { void loadBrief(true); }

/** 历史简报入口：跳笔记库默认库的昨日简报文件，文件树里可浏览「日报/AI活动」全部历史 */
async function goBriefHistory() {
  try {
    const libs = (await API.kb.list()) || [];
    const lib = libs.find((l: any) => l.isDefault) || libs[0];
    if (!lib) return;
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const key = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
    router.push({ path: '/notes', query: { lib: String(lib.id), file: '日报/AI活动/' + key + '.md' } });
  } catch { /* 忽略 */ }
}

// ========== 智能体雷达：已整体并入本页（AgentRadarView embedded），此处不再单独拉数 ==========

function relTime(diff: number): string {
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

// ========== 最新日报重点提炼 ==========
const latestReport = computed(() => (reports.value.length ? reports.value[0] : null));

const KEY_GROUPS: { match: RegExp; label: string }[] = [
  { match: /今日概览|概览/, label: '📊 今日概览' },
  { match: /今日完成|已完成|完成情况/, label: '✅ 完成情况' },
  { match: /待办|待处理|进行中/, label: '📋 今日待办' },
  { match: /综合评估|改进建议|建议/, label: '💡 改进建议' },
];

function markdownClean(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .trim();
}

function extractKeyPoints(content: string): { label: string; items: string[] }[] {
  if (!content) return [];
  const lines = content.split('\n');
  const start = lines.findIndex((l) => {
    const t = l.trim();
    return /^#{1,4}\s/.test(t) || /^-{3,}\s*$/.test(t);
  });
  const body = (start >= 0 ? lines.slice(start) : lines).map((l) => l.trim()).filter(Boolean);

  const groups: { label: string; items: string[] }[] = [];
  let current: { label: string; items: string[] } | null = null;
  let defaultGroup: { label: string; items: string[] } | null = null;

  const pushItem = (text: string) => {
    if (!text) return;
    if (current) current.items.push(text);
    else {
      if (!defaultGroup) {
        defaultGroup = { label: '关键数据', items: [] };
        groups.push(defaultGroup);
      }
      defaultGroup.items.push(text);
    }
  };

  let inTable = false;
  for (const line of body) {
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      inTable = false;
      const title = heading[1];
      const g = KEY_GROUPS.find((k) => k.match.test(title));
      current = g ? { label: g.label, items: [] } : null;
      if (g) groups.push(current!);
      continue;
    }
    if (/^[-|=]{3,}$/.test(line)) { inTable = false; continue; }
    if (/^\|/.test(line)) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        if (!inTable) inTable = true;
        else if (!/^:?-{2,}:?$/.test(cells[1])) pushItem(`${cells[0]}：${cells.slice(1).join(' / ')}`);
      }
      continue;
    }
    inTable = false;
    const clean = markdownClean(line.replace(/^[-*]\s+/, ''));
    if (clean && clean.length < 80) pushItem(clean);
  }

  return groups.map((g) => ({ ...g, items: g.items.slice(0, 6) })).filter((g) => g.items.length);
}

const keyPointGroups = computed(() => extractKeyPoints(latestReport.value?.content || ''));

// ========== 最近更新（笔记库按修改时间倒序的前 6 个文件） ==========
const recentFiles = ref<any[]>([]);

function fileTime(ts: number): string {
  const d = new Date(ts);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

// 工作日志条目点击：打开笔记库里对应的最近更新文档
function openNoteFile(f: any) {
  router.push({ path: '/notes', query: { lib: String(f.projectId), file: f.rel } });
}

async function toggleTodo(t: any) {
  // 2026-11-21 待办并入工单：勾选 = 待办工单 状态流转（已完成/待处理）
  const done = t.status === 'done';
  const nextStatus = done ? '待处理' : '已完成';
  await API.ticket.data.update(t.id, { '状态': nextStatus });
  t.status = done ? 'pending' : 'done';
}

async function loadOverviewData() {
  const d = new Date();
  todayStr.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  try { stats.value = await API.insights.stats(); } catch {}
  try { reports.value = await API.insights.reports(); } catch {}
  // 待办 = 类型'待办'的未完结工单（2026-11-21 待办并入工单）
  try {
    todos.value = (await API.ticket.data.list())
      .filter((t: any) => t['类型'] === '待办' && !['已完成', '已关闭'].includes(String(t['状态'] || '')))
      .map((t: any) => ({ id: t.id, title: t['标题'], status: 'pending' }))
      .slice(0, 8);
  } catch {}
  try { recentFiles.value = await API.insights.recentFiles(12); } catch {}
  // 数据页退役（本地数据集隐藏）：pendingRecords 不再加载
  // 日报调度时间来自内置的「生成综合日报」任务（未开启则不显示该行）
  try {
    const tsk = (await API.task.list()) || [];
    const dr: any = tsk.find((t: any) => t.task_type === 'daily_report' && t.status === 'pending' && t.cycle_time);
    if (dr) {
      const parts = String(dr.cycle_time).split(':');
      reportCron.value = `${parseInt(parts[1] || '0', 10)} ${parseInt(parts[0] || '0', 10)} * * *`;
      reportPushText.value = dr.notify_feishu ? '，并推送飞书' : '';
    } else {
      reportCron.value = '';
      reportPushText.value = '';
    }
  } catch { reportCron.value = ''; }
}

async function loadKbCount() {
  try { kbCount.value = ((await API.kb.list()) || []).length; } catch { kbCount.value = 0; }
  notesLoaded.value = true;
}

// ========== 来自笔记（规则提炼：待办/跟进/日志，出处到项目+文件+行） ==========
const digest = ref<any>(null);
const digestLoading = ref(false);
const syncing = ref(false);
const digestAt = ref('');

const digestPending = computed(() => (digest.value?.todos || []).filter((t: any) => !t.done));
const digestDoneCount = computed(() => (digest.value?.todos || []).length - digestPending.value.length);
const digestMeta = computed(() => {
  if (digestLoading.value) return '扫描中…';
  if (!digestAt.value) return '';
  return `已扫描 ${digest.value?.scannedFiles ?? 0} 个文件`;
});

// 待办按 项目+来源文件 分组展示；一屏最多 40 条，多了不截断出处信息
const shownTodoCount = 40;
const digestTodoGroups = computed(() => {
  const groups: { project: string; file: string; items: any[] }[] = [];
  const byKey: Record<string, { project: string; file: string; items: any[] }> = {};
  let n = 0;
  for (const t of digestPending.value) {
    if (n >= shownTodoCount) break;
    n++;
    const key = t.project_id + '|' + t.file;
    let g = byKey[key];
    if (!g) { g = byKey[key] = { project: t.project, file: t.file, items: [] }; groups.push(g); }
    g.items.push(t);
  }
  return groups;
});

async function loadNoteDigest() {
  digestLoading.value = true;
  try {
    const d = await API.noteDigest.extract();
    digest.value = d;
    const t = new Date(d.generated_at);
    digestAt.value = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  } catch { digest.value = null; }
  digestLoading.value = false;
}

// 来自笔记的待办：页内勾选，状态直接回写笔记文件里的复选框
const checking = ref('');
async function checkDigestTodo(t: any, file: string) {
  const key = t.project + '/' + file + ':' + t.line;
  if (checking.value) return;
  checking.value = key;
  try {
    const r = await API.noteDigest.checkTodo(t.project_id, file, t.line, t.text, !t.done);
    if (r?.ok) {
      await loadNoteDigest();
    } else {
      alert(r?.error || '回写失败');
    }
  } catch (e: any) {
    alert('回写失败: ' + (e?.message || e));
  }
  checking.value = '';
}

async function syncDone() {
  syncing.value = true;
  try {
    const r = await API.noteDigest.syncDone();
    if (r?.touched) await loadOverviewData();
    await loadNoteDigest();
    alert(r?.touched ? `已将 ${r.touched} 个勾选完成的任务标记为 done` : '没有匹配的已勾选待办可回写');
  } catch (e: any) {
    alert('同步失败: ' + (e?.message || e));
  }
  syncing.value = false;
}

async function onGateReady() {
  await loadKbCount();
  await loadOverviewData();
  loadNoteDigest();
}

onMounted(() => {
  loadOverviewData();
  loadKbCount();
  loadNoteDigest();
  loadBrief();
  API.on('report:generated', () => {
    loadOverviewData();
  });
});
onUnmounted(() => {
  API.removeAllListeners('report:generated');
  API.removeAllListeners('radar:event');
});
</script>

<style scoped>
.today-view { display: flex; flex-direction: column; }
/* 根节点同时是 .page（视口高度 + overflow-y:auto）：内容超高时 flex 会把子项压扁
   （.panel 的 overflow:hidden 使压缩无下限，简报曾被压到只剩标题），这里禁止压缩，交给页面滚动 */
.today-view > * { flex-shrink: 0; }
/* 垫底板块：标准区块间距是 sec-label 的 16px，尾部的最新更新拉开一倍 */
.tail-sec { margin-top: 32px; }

/* ========== 统计行 ========== */
.statline {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.statline b { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.statline b.acc { color: var(--primary); }
.statline.warm, .statline .warm b { color: var(--warning); }

/* ========== 引擎简报 ========== */
/* 左侧强调条用内嵌伪元素而非 border-left：panel 有圆角，border-left 会沿圆角弯成 "(" 形 */
.brief { position: relative; padding: 12px 16px 14px 19px; }
.brief::before {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--primary);
}
.brief .sec-label { margin: 0 0 8px; }
.brief-refresh {
  margin-left: auto; border: 1px solid var(--border); background: var(--surface);
  color: var(--text-muted); border-radius: 6px; width: 22px; height: 22px;
  font-size: 13px; line-height: 1; cursor: pointer; flex-shrink: 0;
}
.brief-refresh:hover:not(:disabled) { color: var(--primary); border-color: var(--primary); }
.brief-refresh:disabled { opacity: .5; cursor: default; }
.brief-history { width: auto; padding: 0 8px; font-size: 11.5px; }
.brief-md { font-size: 13px; line-height: 1.7; color: var(--text-primary); }
.brief-md :deep(p) { margin: 0 0 8px; }
.brief-md :deep(h3) { font-size: 13.5px; margin: 10px 0 6px; }
.brief-md :deep(ul), .brief-md :deep(ol) { margin: 0 0 8px; padding-left: 18px; }
.brief-md :deep(code) { font-size: 12px; background: var(--hover); border-radius: 4px; padding: 1px 5px; }
.brief-err { color: var(--danger, #dc2626); font-size: 12px; margin-top: 6px; }
.brief-body { display: flex; flex-direction: column; gap: 5px; }
.brief-body p { font-size: 12.5px; line-height: 1.7; color: var(--text-secondary); }
.brief-body p :deep(b) {
  display: inline-block;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}

/* ========== 智能体雷达（整体嵌入板块） ========== */
.radar-embed-sec { margin-top: 16px; }

/* ========== 等你处理 ========== */
.todo-panel { display: flex; flex-direction: column; }
.todo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}
.todo-row:first-child { border-top: none; }
.todo-row:hover { background: var(--primary-soft); }
.todo-row.done .todo-tx { color: var(--text-muted); text-decoration: line-through; }
.todo-row.overdue { background: var(--danger-soft); }
.todo-box {
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--text-muted);
  border-radius: 5px;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  padding: 0;
}
.todo-box:hover { border-color: var(--primary); }
.todo-row.done .todo-box { background: var(--primary); border-color: var(--primary); }
.ro-box { cursor: pointer; background: none; }
.ro-box:hover:not(:disabled) { border-color: var(--primary); }
.ro-box:disabled { cursor: wait; }
.prio { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); opacity: 0.6; }
.prio.high { background: var(--danger); opacity: 1; }
.prio.mid { background: var(--warning); opacity: 1; }
.prio.low { background: var(--success); opacity: 1; }
.todo-tx { flex: 1; min-width: 0; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-src { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.todo-dt { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.todo-dt.warm { color: var(--warning); font-weight: 600; }
.src-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  padding: 8px 14px 2px;
  background: var(--surface-2);
  border-top: 1px solid var(--border);
  overflow: hidden;
}
.src-title:first-child { border-top: none; }
.src-count { margin-left: auto; flex-shrink: 0; }
.empty-row { font-size: 12px; color: var(--text-muted); padding: 14px; text-align: center; }

/* ========== 双栏区（等你处理 + 工作日志） ========== */
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  align-items: start;
  margin-top: 16px;
}
.list-panel { display: flex; flex-direction: column; }
.plan-row, .file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}
.plan-row:first-child, .file-row:first-child { border-top: none; }
.plan-row > svg, .file-row > svg { color: var(--primary); flex-shrink: 0; }
.plan-tx { flex: 1; min-width: 0; }
.plan-tx b { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-tx small { display: block; font-size: 11px; color: var(--text-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-row { cursor: pointer; }
.file-row:hover { background: var(--primary-soft); }
.row-src { font-size: 11px; color: var(--text-muted); flex-shrink: 0; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 1080px) {
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}

/* ========== 日报详情弹窗 ========== */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
  background: var(--surface); border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
  max-width: 90%; max-height: 90vh; overflow-y: auto; width: 520px;
}
.modal-box-lg { width: 680px; }
.modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.modal-header h3 { font-size: 16px; font-weight: 600; }
.modal-close {
  border: none; background: none; font-size: 20px; line-height: 1;
  color: var(--text-muted); cursor: pointer; padding: 4px 8px; border-radius: 6px;
}
.modal-close:hover { color: var(--text-primary); background: var(--hover); }
.modal-body { padding: 20px; }
.report-modal-body { font-size: 14px; line-height: 1.7; color: var(--text-primary); word-break: break-word; }
</style>
