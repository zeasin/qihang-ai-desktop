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
        <span class="warm">数据待确认 <b>{{ pendingRecordCount }}</b></span>
      </div>

      <!-- ========== 引擎简报 ========== -->
      <section class="brief panel">
        <div class="sec-label"><AppIcon name="sparkles" :size="13" />引擎简报<em>由笔记库与任务数据自动汇编</em></div>
        <div v-if="briefLines.length" class="brief-body">
          <p v-for="(line, i) in briefLines" :key="i" v-html="line"></p>
        </div>
        <div v-else class="brief-body"><p>暂无数据。扫描笔记库后，这里会汇总你的待办、跟进与最新产出。</p></div>
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
        <!-- 来自笔记的待办（只读，按来源文件分组） -->
        <template v-for="g in digestTodoGroups" :key="g.file">
          <div class="src-title" :title="g.file"><AppIcon name="file-text" :size="11" />{{ g.file }}<span class="src-count">{{ g.items.length }}</span></div>
          <div v-for="(t, i) in g.items" :key="g.file + ':' + i" class="todo-row ro" :title="g.file + ':' + t.line">
            <span class="todo-box ro-box"></span>
            <span class="todo-tx">{{ t.text }}</span>
            <span class="todo-src">来自笔记</span>
            <span class="todo-dt">{{ t.line || '' }}</span>
          </div>
        </template>
        <div v-if="digestPending.length > shownTodoCount" class="empty-row">仅列出前 {{ shownTodoCount }} 条，共 {{ digestPending.length }} 条</div>
        <div v-if="!digestPending.length && !todos.length" class="empty-row">{{ digestLoading ? '正在扫描笔记…' : '笔记里没有未勾选的待办' }}</div>
      </section>

      <!-- ========== 今日节奏 + 新产出 ========== -->
      <div class="grid2">
        <section>
          <div class="sec-label"><AppIcon name="clock" :size="13" />今日节奏</div>
          <div class="panel list-panel">
            <div v-if="reportScheduleText" class="plan-row">
              <AppIcon name="clock" :size="14" />
              <span class="plan-tx"><b>{{ reportScheduleText }}</b><small>综合日报自动生成{{ reportPushText }}</small></span>
            </div>
            <div v-for="r in activeReminders" :key="r.id" class="plan-row">
              <AppIcon name="bell-ring" :size="14" />
              <span class="plan-tx"><b>{{ r.time || '09:00' }} {{ r.name }}</b><small>{{ reminderTypeText(r.type) }}{{ r.date ? ' · ' + r.date : '' }}</small></span>
            </div>
            <div v-if="!reportScheduleText && !activeReminders.length" class="empty-row">暂无定时安排</div>
          </div>
        </section>
        <section>
          <div class="sec-label"><AppIcon name="file-text" :size="13" />新产出<em>{{ reports.length }}</em></div>
          <div class="panel list-panel">
            <div v-for="r in reports.slice(0, 6)" :key="r.id" class="file-row" @click="openReportModal(r)">
              <AppIcon name="file-text" :size="14" />
              <span class="plan-tx">
                <b>{{ r.report_date || '日报' }} 综合日报</b>
                <small>{{ (r.summary || '').slice(0, 60) || '（无摘要）' }}</small>
              </span>
              <span class="badge badge-primary">日报</span>
            </div>
            <div v-if="!reports.length" class="empty-row">暂无日报</div>
          </div>
        </section>
      </div>

      <!-- ========== 跟进事项 + 工作日志 ========== -->
      <div class="grid2">
        <section>
          <div class="sec-label"><AppIcon name="bookmark" :size="13" />跟进事项<em>{{ digestFollowups.length }}</em></div>
          <div class="panel list-panel">
            <div v-for="(f, i) in digestFollowups.slice(0, 20)" :key="'f' + i" class="file-row" :title="f.file + ':' + f.line">
              <AppIcon name="bookmark" :size="14" />
              <span class="plan-tx"><b>{{ f.text }}</b><small>{{ f.file.split('/').pop() }}</small></span>
            </div>
            <div v-if="!digestFollowups.length" class="empty-row">没有命中「待跟进 / 跟进中」这类话术</div>
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
    </template>
  </div>

  <!-- ========== 日报详情弹窗 ========== -->
  <div v-if="showReportModal" class="modal-overlay" @click.self="closeReportModal">
    <div class="modal-box modal-box-lg">
      <div class="modal-header">
        <h3>综合日报{{ modalReport?.report_date ? ' · ' + modalReport.report_date : '' }}</h3>
        <button class="modal-close" @click="closeReportModal">&times;</button>
      </div>
      <div class="modal-body report-modal-body">
        <div v-html="renderMarkdown(reportBody(modalReport?.content || ''))"></div>
      </div>
    </div>
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

const reportPushText = '，可推送飞书';

const todos = ref<any[]>([]);
const reminders = ref<any[]>([]);
const pendingRecords = ref<any[]>([]);
const todayStr = ref('');

const pendingRecordCount = computed(() =>
  (pendingRecords.value || []).reduce((n: number, g: any) => n + (g.records?.length || 0), 0));

const activeReminders = computed(() => (reminders.value || []).filter((r: any) => r.enabled !== 0));

function reminderTypeText(type: string): string {
  const m: Record<string, string> = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年', once: '仅一次' };
  return m[type] || type || '提醒';
}

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
    for (const p of points) lines.push(escapeHtml(p) + '。');
  }
  if (digest.value) {
    const dp = digestPending.value.length;
    const df = digestFollowups.value.length;
    if (dp || df) {
      lines.push(`笔记库扫描 <b>${digest.value.scannedFiles ?? 0}</b> 个文件：发现未勾待办 <b>${dp}</b> 项、待跟进 <b>${df}</b> 项。`);
    }
  }
  const topPending = (pendingRecords.value || [])[0];
  if (topPending && topPending.records?.length) {
    lines.push(`<b>「${topPending.datasetName}」</b>数据集新增 <b>${topPending.records.length}</b> 条待确认记录，去数据页确认入库。`);
  }
  return lines.slice(0, 4);
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const renderMarkdown = (text: string) => {
  if (!text) return '';
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^> /.test(line)) {
      let cnt = line.slice(2)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        .replace(/`(.+?)`/g,'<code>$1</code>')
        .replace(/\[(.+?)\]\((.+?)\)/g,'<a href="$2">$1</a>');
      out.push('<blockquote style="border-left:3px solid var(--primary);padding:6px 12px;margin:8px 0;background:var(--primary-soft);border-radius:4px;color:var(--text-secondary)">' + cnt + '</blockquote>');
      continue;
    }
    if (/^\|/.test(line)) {
      const trows: string[] = [line];
      while (i + 1 < lines.length && /^\|/.test(lines[i + 1])) { i++; trows.push(lines[i]); }
      let thtml = '';
      if (trows.length > 1 && /^\|[-:| ]+\|$/.test(trows[1])) {
        thtml += '<thead><tr>';
        const hcells = trows[0].split('|').filter(c => c.trim() !== '');
        for (const hc of hcells) {
          const hv = hc.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          thtml += '<th style="padding:6px 10px;border:1px solid var(--border);background:var(--surface-2);font-weight:600;text-align:left;font-size:13px">' + hv + '</th>';
        }
        thtml += '</tr></thead><tbody>';
        for (let tj = 2; tj < trows.length; tj++) {
          const dcells = trows[tj].split('|').filter(c => c.trim() !== '');
          thtml += '<tr>';
          for (const dc of dcells) {
            const dv = dc.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            thtml += '<td style="padding:6px 10px;border:1px solid var(--border);font-size:13px">' + dv + '</td>';
          }
        }
        thtml += '</tbody>';
      } else {
        thtml += '<tbody>';
        for (const row of trows) {
          const dcells = row.split('|').filter(c => c.trim() !== '');
          thtml += '<tr>';
          for (const dc of dcells) {
            const dv = dc.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            thtml += '<td style="padding:6px 10px;border:1px solid var(--border);font-size:13px">' + dv + '</td>';
          }
        }
        thtml += '</tbody>';
      }
      out.push('<table style="width:100%;border-collapse:collapse;margin:8px 0">' + thtml + '</table>');
      continue;
    }
    const esc = line
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/`(.+?)`/g,'<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g,'<a href="$2">$1</a>');
    if (/^### /.test(line)) { out.push('<h3>' + esc.slice(4) + '</h3>'); continue; }
    if (/^## /.test(line)) { out.push('<h2 style="font-size:16px;margin:12px 0 6px">' + esc.slice(3) + '</h2>'); continue; }
    if (/^# /.test(line)) { out.push('<h1 style="font-size:18px;margin:16px 0 8px">' + esc.slice(2) + '</h1>'); continue; }
    if (/^---$/.test(line)) { out.push('<hr>'); continue; }
    if (/^☀️ /.test(line)) { out.push('<div style="font-size:20px;font-weight:700;margin:16px 0 8px">' + esc + '</div>'); continue; }
    if (/^📅 /.test(line)) { out.push('<div style="font-size:14px;color:var(--text-muted);margin-bottom:16px">' + esc + '</div>'); continue; }
    if (/^✅ /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px;color:var(--success)">' + esc + '</div>'); continue; }
    if (/^⚠️ /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px;color:var(--danger)">' + esc + '</div>'); continue; }
    if (/^(📋|⏰|💬|📝|🗂️|📊) /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^(🌅|🌤️|🌇|🌙) /.test(line)) { out.push('<div style="font-size:14px;color:var(--primary);margin:8px 0">' + esc + '</div>'); continue; }
    if (/^💡 /.test(line)) { out.push('<div style="font-size:13px;color:var(--text-muted);margin-top:8px">' + esc + '</div>'); continue; }
    if (/^  - 🔴 /.test(line)) { out.push('<div style="padding:2px 0 2px 16px;color:var(--danger)">' + esc.slice(6) + '</div>'); continue; }
    if (/^  - /.test(line)) { out.push('<div style="padding:2px 0 2px 16px">' + esc.slice(4) + '</div>'); continue; }
    if (line === '') { out.push('<br>'); continue; }
    out.push('<div>' + esc + '</div>');
  }
  return out.join('\n');
};

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

function reportBody(content: string): string {
  if (!content) return '';
  const lines = content.split('\n');
  const start = lines.findIndex((l) => {
    const t = l.trim();
    return /^#{1,4}\s/.test(t) || /^-{3,}\s*$/.test(t);
  });
  return start > 0 ? lines.slice(start).join('\n') : content;
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

// ========== 日报详情弹窗 ==========
const showReportModal = ref(false);
const modalReport = ref<any>(null);

function openReportModal(r: any) {
  modalReport.value = r;
  showReportModal.value = true;
}
function closeReportModal() {
  showReportModal.value = false;
  modalReport.value = null;
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
  try { reminders.value = await API.reminder.list(); } catch {}
  try { pendingRecords.value = await API.ds.pendingRecords(); } catch {}
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
const digestLogs = computed(() => (digest.value?.logs || []).slice(0, 20));
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

// 待办按来源文件分组展示；一屏最多 40 条，多了不截断出处信息
const shownTodoCount = 40;
const digestTodoGroups = computed(() => {
  const groups: { file: string; items: any[] }[] = [];
  const byFile: Record<string, { file: string; items: any[] }> = {};
  let n = 0;
  for (const t of digestPending.value) {
    if (n >= shownTodoCount) break;
    n++;
    let g = byFile[t.file];
    if (!g) { g = byFile[t.file] = { file: t.file, items: [] }; groups.push(g); }
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
  API.on('report:generated', () => {
    loadOverviewData();
  });
});
onUnmounted(() => {
  API.removeAllListeners('report:generated');
});
</script>

<style scoped>
.today-view { display: flex; flex-direction: column; }

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
.brief { border-left: 3px solid var(--primary); padding: 12px 16px 14px; }
.brief .sec-label { margin: 0 0 8px; }
.brief-body { display: flex; flex-direction: column; gap: 5px; }
.brief-body p { font-size: 12.5px; line-height: 1.7; color: var(--text-secondary); }
.brief-body p :deep(b) { color: var(--text-primary); font-weight: 600; }

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
.ro-box { cursor: default; background: none; }
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
