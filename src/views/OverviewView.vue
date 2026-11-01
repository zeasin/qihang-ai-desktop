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
        <span>待跟进 <b>{{ digestFollowups.length }}</b></span>
      </div>

      <!-- ========== 引擎简报 ========== -->
      <section class="brief panel">
        <div class="sec-label"><AppIcon name="sparkles" :size="13" />引擎简报<em>由笔记库与任务数据自动汇编</em></div>
        <div v-if="briefLines.length" class="brief-body">
          <p v-for="(line, i) in briefLines" :key="i" v-html="line"></p>
        </div>
        <div v-else class="brief-body"><p>暂无数据。扫描笔记库后，这里会汇总你的待办、跟进与最新产出。</p></div>
      </section>

      <!-- ========== 雷达统计 ========== -->
      <section class="panel radar-sec">
        <div class="sec-label">
          <AppIcon name="radar" :size="13" />雷达统计
          <em v-if="radarStats">监控 {{ radarCards.length }} 个工具 · 沉淀 {{ radarStats.messages }} 条消息</em>
          <em v-else>未开启或暂无数据</em>
          <router-link class="sec-more" to="/radar">进入雷达<AppIcon name="chevron-right" :size="11" /></router-link>
        </div>
        <div class="radar-stats">
          <div class="rs-item" :class="{ run: (radarStats?.running || 0) > 0 }"><b>{{ radarStats?.running ?? 0 }}</b><small>运行中</small></div>
          <div class="rs-item"><b>{{ radarStats?.activeToday ?? 0 }}</b><small>今日活跃</small></div>
          <div class="rs-item"><b>{{ radarStats?.sessions ?? 0 }}</b><small>会话总数</small></div>
          <div class="rs-item"><b>{{ radarStats?.messages ?? 0 }}</b><small>沉淀消息</small></div>
        </div>
        <div v-if="radarCards.length" class="radar-tools">
          <div v-for="c in radarCards" :key="c.tool" class="radar-tool" :class="{ run: (c.running || 0) > 0 }">
            <span class="rt-dot"></span>
            <span class="rt-name">{{ toolLabel(c.tool) }}</span>
            <span class="rt-sub">{{ radarToolSub(c) }}</span>
          </div>
        </div>
      </section>

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

      <!-- ========== 跟进事项 + 工作日志 ========== -->
      <div class="grid2">
        <section>
          <div class="sec-label"><AppIcon name="bookmark" :size="13" />跟进事项<em>{{ digestFollowups.length }}</em></div>
          <div class="panel list-panel">
            <div v-for="(f, i) in digestFollowups.slice(0, 20)" :key="'f' + i" class="file-row" :title="f.project + ' / ' + f.file + ':' + f.line + (f.resolvable ? '（点击在笔记中打开，勾选 = 已跟进并回写 [x]）' : '（点击在笔记中打开）')" @click="openFollowupSource(f)">
              <button
                v-if="f.resolvable"
                class="todo-box ro-box"
                :disabled="checkingFu === f.project + '/' + f.file + ':' + f.line"
                :title="checkingFu === f.project + '/' + f.file + ':' + f.line ? '正在回写跟进清单…' : '已跟进：结清并回写 [x] 到跟进清单'"
                @click.stop="checkDigestFollowup(f)"
              >
                <AppIcon v-if="checkingFu === f.project + '/' + f.file + ':' + f.line" name="loader" :size="11" />
              </button>
              <AppIcon v-else name="bookmark" :size="14" />
              <span class="plan-tx"><b>{{ f.text }}</b><small>{{ f.file.split('/').pop() }}</small></span>
            </div>
            <div v-if="!digestFollowups.length" class="empty-row">没有待跟进事项（工作日志等历史记录不算跟进）</div>
          </div>
        </section>
        <section>
          <div class="sec-label"><AppIcon name="history" :size="13" />工作日志<em>{{ digestLogs.length }}</em></div>
          <div class="panel list-panel">
            <div v-for="(g, date) in digestLogGroups" :key="date" class="file-row" :title="g[0].file + ':' + g[0].line">
              <AppIcon name="file-text" :size="14" />
              <span class="plan-tx"><b>{{ date }} 日志</b><small>{{ g[0].preview || '（无正文摘要）' }}</small></span>
              <span class="row-src">{{ g[0].file }}</span>
            </div>
            <div v-if="!digestLogs.length" class="empty-row">没有日期命名的日志文件</div>
          </div>
        </section>
      </div>

      <!-- ========== 最新更新（垫底板块，与上方拉开距离） ========== -->
      <section class="tail-sec">
        <div class="sec-label"><AppIcon name="file-text" :size="13" />最新更新<em>{{ recentFiles.length }}</em></div>
        <div class="panel list-panel">
          <div v-for="f in recentFiles" :key="f.projectName + '/' + f.rel" class="file-row" :title="f.projectName + ' / ' + f.rel">
            <AppIcon name="file-text" :size="14" />
            <span class="plan-tx">
              <b>{{ f.rel.split('/').pop() }}</b>
              <small>{{ f.projectName }}/{{ f.rel.split('/').slice(0, -1).join('/') }}</small>
            </span>
            <span class="todo-dt">{{ fileTime(f.mtime) }}</span>
          </div>
          <div v-if="!recentFiles.length" class="empty-row">笔记库最近没有文件改动</div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import NotesGate from '@/components/NotesGate.vue';
import AppIcon from '@/components/AppIcon.vue';

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
    const df = digestFollowups.value.length;
    if (dp || df) {
      lines.push(`笔记库扫描 <b>${digest.value.scannedFiles ?? 0}</b> 个文件：发现未勾待办 <b>${dp}</b> 项、待跟进 <b>${df}</b> 项。`);
    }
  }
  return lines.slice(0, 4);
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== 雷达统计（复用雷达页 dashboard，一次取全；radar:event 时刷新） ==========
const radarStats = ref<any>(null);
const radarCards = ref<any[]>([]);

const RADAR_TOOL_LABELS: Record<string, string> = {
  zcode: 'ZCode', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode',
  qoder: 'Qoder', trae: 'Trae', dsh: 'DSH', pi: 'Pi',
};
const toolLabel = (t: string) => RADAR_TOOL_LABELS[t] || t;

function relTime(diff: number): string {
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

function radarToolSub(c: any): string {
  if ((c.running || 0) > 0) return `运行中 ${c.running} · 共 ${c.sessions}`;
  if (!c.lastActivity) return '暂无活动';
  return `${c.sessions} 会话 · ${relTime(Date.now() - c.lastActivity)}`;
}

async function loadRadarStats() {
  try {
    const d = await API.radar.dashboard();
    radarStats.value = d.stats || null;
    radarCards.value = d.cards || [];
  } catch { radarStats.value = null; radarCards.value = []; }
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

// 跟进事项点击：跳到笔记页打开来源文件（带项目与相对路径，笔记页按 query 定位）
function openFollowupSource(f: any) {
  router.push({ path: '/notes', query: { lib: String(f.project_id), file: f.file } });
}

// 跟进清单（跟进.md）条目一键结清：回写 [x]，再次扫描后不再展示；
// 工作日志等历史来源的命中没有结清入口，本就不该挂在这里（提炼层已排除）
const checkingFu = ref('');
async function checkDigestFollowup(f: any) {
  const key = f.project + '/' + f.file + ':' + f.line;
  if (checkingFu.value) return;
  checkingFu.value = key;
  try {
    const r = await API.noteDigest.checkFollowup(f.project_id, f.file, f.line, f.text);
    if (r?.ok) {
      await loadNoteDigest();
    } else {
      alert(r?.error || '回写失败');
    }
  } catch (e: any) {
    alert('回写失败: ' + (e?.message || e));
  }
  checkingFu.value = '';
}

async function toggleTodo(t: any) {
  const newStatus = t.status === 'done' ? 'pending' : 'done';
  await API.todo.update(t.id, { status: newStatus });
  t.status = newStatus;
}

async function loadOverviewData() {
  const d = new Date();
  todayStr.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  try { stats.value = await API.insights.stats(); } catch {}
  try { reports.value = await API.insights.reports(); } catch {}
  try { todos.value = (await API.todo.list()).filter((t: any) => t.status !== 'done').slice(0, 8); } catch {}
  try { recentFiles.value = await API.insights.recentFiles(); } catch {}
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
const digestFollowups = computed(() => digest.value?.followups || []);
const digestLogs = computed(() => (digest.value?.logs || []).slice(0, 6));
const digestLogGroups = computed(() => {
  const m: Record<string, any[]> = {};
  for (const g of digestLogs.value) (m[g.date] = m[g.date] || []).push(g);
  return m;
});
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
  loadRadarStats();
  API.on('report:generated', () => {
    loadOverviewData();
  });
  API.on('radar:event', () => {
    loadRadarStats();
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

/* ========== 雷达统计 ========== */
/* 标题在面板内，没有外置 sec-label 的 16px 上边距，需自行与上一区块留白 */
.radar-sec { padding: 12px 16px 14px; margin-top: 16px; }
.radar-sec .sec-label { margin: 0 0 10px; }
.sec-more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--text-muted);
  text-decoration: none;
  flex-shrink: 0;
}
.sec-more:hover { color: var(--primary); }

.radar-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
.rs-item {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 8px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.rs-item b {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.rs-item small { font-size: 11px; color: var(--text-muted); }
/* 有会话运行时，"运行中"块与下方运行徽章同色系呼应 */
.rs-item.run { background: var(--primary-soft); border-color: var(--primary); }
.rs-item.run b { color: var(--primary); }

.radar-tools { display: flex; flex-wrap: wrap; gap: 6px; }
.radar-tool {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--surface);
}
.radar-tool.run { border-color: var(--primary); background: var(--primary-soft); color: var(--text-primary); }
.rt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); opacity: 0.45; flex-shrink: 0; }
.radar-tool.run .rt-dot { background: var(--primary); opacity: 1; }
.rt-name { font-weight: 600; color: var(--text-primary); }

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

/* ========== 双栏区 ========== */
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
  /* grid2 里 section 的首个子元素就是 sec-label，其 ：first-child 上边距会被全局清零，
     这里补回与其他区块一致的 16px 节奏 */
  margin-top: 16px;
  margin-bottom: 4px;
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
