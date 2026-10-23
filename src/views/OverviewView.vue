<template>
  <div class="overview-view">
    <!-- ========== 顶部条：笔记库看板 ========== -->
    <div class="board-bar">
      <div class="board-brand">
        <span class="board-title">📚 笔记库看板</span>
        <span class="board-sub">{{ digestMeta }}</span>
      </div>
      <div class="board-actions">
        <button class="btn btn-sm btn-secondary" :disabled="digestLoading" @click="loadNoteDigest">{{ digestLoading ? '扫描中…' : '↻ 重新扫描' }}</button>
        <button class="btn btn-sm btn-secondary" :disabled="syncing" @click="syncDone" title="把笔记里已勾选的 - [x] 对应任务标记完成">⇄ 同步完成项</button>
        <button class="btn btn-sm btn-secondary" @click="openNotes">浏览笔记</button>
        <button class="btn btn-sm btn-secondary" @click="openConfig" title="管理项目">⚙</button>
      </div>
    </div>

    <!-- 一个笔记库都没有：AI 功能门禁 -->
    <NotesGate
      v-if="notesLoaded && !kbCount"
      compact
      desc="概览的待办、跟进、工作日志全部由笔记库提炼，添加至少一个笔记库后自动可用；数据集、提醒不受影响。"
      @ready="onGateReady"
    />

    <template v-else>
      <!-- ========== KPI：全部来自笔记提炼 ========== -->
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-num accent">{{ digestPending.length }}</div><div class="kpi-label">未勾待办</div></div>
        <div class="kpi"><div class="kpi-num ok">{{ digestDoneCount }}</div><div class="kpi-label">笔记已勾</div></div>
        <div class="kpi"><div class="kpi-num warn">{{ digestFollowups.length }}</div><div class="kpi-label">待跟进</div></div>
        <div class="kpi"><div class="kpi-num">{{ digestLogs.length }}</div><div class="kpi-label">工作日志</div></div>
        <div class="kpi clickable" @click="openNotes" title="浏览笔记库"><div class="kpi-num">{{ stats.notesFileCount }}</div><div class="kpi-label">笔记文件</div></div>
      </div>

      <!-- ========== 三栏看板 ========== -->
      <div class="board-grid">
        <section class="board-col">
          <header class="col-head">☐ 待办<span class="col-count">{{ digestPending.length }}</span></header>
          <div class="col-body">
            <div v-for="g in digestTodoGroups" :key="g.file" class="src-group">
              <div class="src-title" :title="g.file">{{ g.file }}<span class="src-count">{{ g.items.length }}</span></div>
              <div v-for="(t, i) in g.items" :key="g.file + ':' + i" class="row" :title="g.file + ':' + t.line">
                <span class="row-mark">☐</span>
                <span class="row-text">{{ t.text }}</span>
                <span class="row-line" v-if="t.line">{{ t.line }}</span>
              </div>
            </div>
            <div v-if="digestPending.length > shownTodoCount" class="col-more">仅列出前 {{ shownTodoCount }} 条，共 {{ digestPending.length }} 条</div>
            <div v-if="!digestPending.length" class="col-empty">{{ digestLoading ? '正在扫描笔记…' : '笔记里没有未勾选的待办' }}</div>
          </div>
        </section>

        <section class="board-col">
          <header class="col-head">📌 跟进<span class="col-count">{{ digestFollowups.length }}</span></header>
          <div class="col-body">
            <div v-for="(f, i) in digestFollowups.slice(0, 30)" :key="'f' + i" class="row" :title="f.file + ':' + f.line">
              <span class="row-mark">📌</span>
              <span class="row-text">{{ f.text }}</span>
              <span class="row-line">{{ f.file.split('/').pop() }}</span>
            </div>
            <div v-if="!digestFollowups.length" class="col-empty">没有命中「待跟进 / 跟进中」这类话术</div>
          </div>
        </section>

        <section class="board-col">
          <header class="col-head">🗓️ 工作日志<span class="col-count">{{ digestLogs.length }}</span></header>
          <div class="col-body">
            <div v-for="(g, date) in digestLogGroups" :key="date" class="log-row" :title="g[0].file + ':' + g[0].line">
              <div class="log-date">{{ date }}<span class="log-src">{{ g[0].file }}</span></div>
              <div class="log-preview">{{ g[0].preview || '（无正文摘要）' }}</div>
            </div>
            <div v-if="!digestLogs.length" class="col-empty">没有日期命名的日志文件</div>
          </div>
        </section>
      </div>

      <!-- ========== 次级区：综合日报 + 本地库 ========== -->
      <div class="sub-grid">
        <section class="sub-card">
          <header class="col-head">📊 综合日报<span class="col-sub">{{ reportScheduleText }}</span></header>
          <div class="card" v-if="latestReport">
            <div class="latest-header">
              <div class="latest-info">
                <div class="latest-date">{{ latestReport.report_date || '最新日报' }}</div>
                <div class="latest-time">{{ latestReport.created_at }}</div>
              </div>
              <button class="btn btn-sm btn-secondary" @click="openReportModal(latestReport)">查看详情</button>
            </div>
            <div v-if="keyPointGroups.length" class="key-points">
              <div v-for="g in keyPointGroups" :key="g.label" class="key-point-group">
                <div class="key-points-title">{{ g.label }}</div>
                <div v-for="(p, i) in g.items" :key="i" class="key-point">• {{ p }}</div>
              </div>
            </div>
            <div v-else class="key-points"><div class="key-point">{{ (latestReport.summary || '').slice(0, 200) }}</div></div>
          </div>
          <div class="card">
            <div v-if="reports.length" class="report-list">
              <div v-for="r in reports" :key="r.id" class="report-item" @click="openReportModal(r)">
                <div class="report-header">
                  <span class="report-date">{{ r.report_date || '日报' }}</span>
                  <span class="report-time" style="margin:0;">{{ r.created_at }}</span>
                  <span class="report-expand">查看详情</span>
                </div>
                <div class="report-summary">{{ (r.summary || '').slice(0, 200) }}</div>
              </div>
            </div>
            <div v-else class="empty-state" style="padding:20px;">
              <div class="empty-icon">📊</div>
              <div class="empty-title">暂无日报</div>
            </div>
          </div>
        </section>

        <section class="sub-card">
          <div class="tab-bar">
            <button :class="{ on: subTab === 'todo' }" @click="subTab = 'todo'">本地待办 {{ stats.todoPending }}</button>
            <button :class="{ on: subTab === 'reminder' }" @click="subTab = 'reminder'">提醒 {{ stats.remindersActive }}</button>
            <button :class="{ on: subTab === 'pending' }" @click="subTab = 'pending'">待处理记录</button>
          </div>
          <div class="card tab-body">
            <div v-if="subTab === 'todo'" class="stack">
              <div v-for="t in todos" :key="t.id" class="todo-item" :class="{ overdue: t.due_date && t.due_date < todayStr && t.status !== 'done' }">
                <div class="todo-priority" :class="t.priority">{{ t.priority === 'high' ? '🔴' : t.priority === 'mid' ? '🟡' : '🟢' }}</div>
                <div class="todo-body">
                  <div class="todo-title">{{ t.title }}</div>
                  <div class="todo-meta" v-if="t.due_date">{{ t.due_date }}</div>
                </div>
                <button class="todo-done-btn" @click="toggleTodo(t)">{{ t.status === 'done' ? '↩' : '✓' }}</button>
              </div>
              <div v-if="!todos.length" class="col-empty">本地库暂无待办</div>
            </div>

            <div v-else-if="subTab === 'reminder'" class="stack">
              <div v-for="r in reminders" :key="r.id" class="reminder-item">
                <div class="reminder-name">{{ r.name }}</div>
                <div class="reminder-time">{{ r.time || '09:00' }}{{ r.date ? ' · ' + r.date : '' }}</div>
              </div>
              <div v-if="!reminders.length" class="col-empty">暂无提醒</div>
            </div>

            <div v-else class="stack">
              <div v-for="group in pendingRecords" :key="group.datasetId" class="pending-group">
                <div class="pending-group-title">{{ group.datasetName }}</div>
                <div v-for="rec in group.records" :key="rec.id" class="pending-item">
                  <div class="pending-text">{{ Object.values(rec).filter(v => typeof v === 'string' && v.length < 80 && v !== rec._created_at).slice(0, 2).join(' · ') || '(无标题)' }}</div>
                  <div class="pending-time">{{ rec._created_at || '' }}</div>
                </div>
              </div>
              <div v-if="!pendingRecords.length" class="col-empty">暂无待处理记录</div>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>

  <!-- ========== 日报详情弹窗 ========== -->
  <div v-if="showReportModal" class="modal-overlay" @click.self="closeReportModal">
    <div class="modal-box modal-box-lg">
      <div class="modal-header">
        <h3>📊 综合日报{{ modalReport?.report_date ? ' · ' + modalReport.report_date : '' }}</h3>
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
      return `每日 ${hour}:${min} 自动生成`;
    }
  }
  return '每日自动生成综合日报';
});

const todos = ref<any[]>([]);
const reminders = ref<any[]>([]);
const pendingRecords = ref<any[]>([]);
const todayStr = ref('');

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
      out.push('<blockquote style="border-left:3px solid #6366f1;padding:6px 12px;margin:8px 0;background:#f8fafc;border-radius:4px;color:#475569">' + cnt + '</blockquote>');
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
          thtml += '<th style="padding:6px 10px;border:1px solid #d0d5dd;background:#f0f0f5;font-weight:600;text-align:left;font-size:13px">' + hv + '</th>';
        }
        thtml += '</tr></thead><tbody>';
        for (let tj = 2; tj < trows.length; tj++) {
          const dcells = trows[tj].split('|').filter(c => c.trim() !== '');
          thtml += '<tr>';
          for (const dc of dcells) {
            const dv = dc.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            thtml += '<td style="padding:6px 10px;border:1px solid #d0d5dd;font-size:13px">' + dv + '</td>';
          }
          thtml += '</tr>';
        }
        thtml += '</tbody>';
      } else {
        thtml += '<tbody>';
        for (const row of trows) {
          const dcells = row.split('|').filter(c => c.trim() !== '');
          thtml += '<tr>';
          for (const dc of dcells) {
            const dv = dc.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            thtml += '<td style="padding:6px 10px;border:1px solid #d0d5dd;font-size:13px">' + dv + '</td>';
          }
          thtml += '</tr>';
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
    if (/^📅 /.test(line)) { out.push('<div style="font-size:14px;color:#64748b;margin-bottom:16px">' + esc + '</div>'); continue; }
    if (/^✅ /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px;color:#16a34a">' + esc + '</div>'); continue; }
    if (/^⚠️ /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px;color:#ef4444">' + esc + '</div>'); continue; }
    if (/^📋 /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^⏰ /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^💬 /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^📝 /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^🗂️ /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^📊 /.test(line)) { out.push('<div style="font-size:15px;font-weight:600;margin:12px 0 6px">' + esc + '</div>'); continue; }
    if (/^🌅 /.test(line)) { out.push('<div style="font-size:14px;color:#6366f1;margin:8px 0">' + esc + '</div>'); continue; }
    if (/^🌤️ /.test(line)) { out.push('<div style="font-size:14px;color:#6366f1;margin:8px 0">' + esc + '</div>'); continue; }
    if (/^🌇 /.test(line)) { out.push('<div style="font-size:14px;color:#6366f1;margin:8px 0">' + esc + '</div>'); continue; }
    if (/^🌙 /.test(line)) { out.push('<div style="font-size:14px;color:#6366f1;margin:8px 0">' + esc + '</div>'); continue; }
    if (/^💡 /.test(line)) { out.push('<div style="font-size:13px;color:#94a3b8;margin-top:8px">' + esc + '</div>'); continue; }
    if (/^  - 🔴 /.test(line)) { out.push('<div style="padding:2px 0 2px 16px;color:#ef4444">' + esc.slice(6) + '</div>'); continue; }
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
  try { todos.value = (await API.todo.list()).filter((t: any) => t.status !== 'done').slice(0, 10); } catch {}
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
  return `${digest.value?.scannedFiles ?? 0} 个文件 · ${digestAt.value}`;
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

const subTab = ref<'todo' | 'reminder' | 'pending'>('todo');

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
.overview-view {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px;
  background: var(--bg-main);
}

/* ========== 顶部条 ========== */
.board-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.board-brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.board-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }
.board-sub { font-size: 12px; color: var(--text-muted); }
.board-actions { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; }

/* ========== KPI ========== */
.kpi-row { display: flex; gap: 8px; margin-bottom: 14px; }
.kpi {
  flex: 1;
  min-width: 0;
  background: white;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 8px;
  text-align: center;
}
.kpi.clickable { cursor: pointer; transition: all 0.15s; }
.kpi.clickable:hover { border-color: var(--primary); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.kpi-num { font-size: 20px; font-weight: 700; color: var(--text-primary); line-height: 1.2; }
.kpi-num.accent { color: var(--primary); }
.kpi-num.ok { color: #16a34a; }
.kpi-num.warn { color: #ef4444; }
.kpi-label { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

.card {
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  padding: 20px;
  margin-bottom: 16px;
}

/* ========== 三栏看板 ========== */
.board-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
  margin-bottom: 18px;
}
.board-col {
  background: white;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border);
}
.col-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-main);
  border-radius: 10px;
  padding: 1px 7px;
}
.col-sub { font-size: 11px; font-weight: 400; color: var(--text-muted); margin-left: auto; }
.col-body { padding: 8px 10px; max-height: 420px; overflow-y: auto; }
.col-empty { font-size: 12px; color: var(--text-muted); padding: 14px 6px; text-align: center; }
.col-more { font-size: 11px; color: var(--text-muted); padding: 6px; text-align: center; }

.src-group { margin-bottom: 8px; }
.src-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.src-count { margin-left: auto; flex-shrink: 0; }

.row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.row:hover { background: var(--hover); }
.row-mark { flex-shrink: 0; font-size: 11px; opacity: 0.75; }
.row-text { flex: 1; min-width: 0; color: var(--text-secondary); line-height: 1.5; }
.row-line { flex-shrink: 0; font-size: 10px; color: var(--text-muted); }

.log-row { padding: 6px; border-radius: var(--radius-sm); }
.log-row:hover { background: var(--hover); }
.log-date { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--text-primary); }
.log-src { font-size: 10px; font-weight: 400; color: var(--text-muted); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-preview { font-size: 12px; color: var(--text-secondary); margin-top: 2px; line-height: 1.5; }

/* ========== 次级区 ========== */
.sub-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.sub-card { min-width: 0; }
.tab-bar { display: flex; gap: 4px; margin-bottom: 8px; }
.tab-bar button {
  flex: 1;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: white;
  color: var(--text-secondary);
  cursor: pointer;
}
.tab-bar button.on { border-color: var(--primary); color: var(--primary); background: var(--hover); font-weight: 600; }
.tab-body { min-height: 160px; max-height: 420px; overflow-y: auto; }
.stack { display: flex; flex-direction: column; gap: 6px; }

@media (max-width: 1180px) {
  .board-grid { grid-template-columns: minmax(0, 1fr); }
  .sub-grid { grid-template-columns: minmax(0, 1fr); }
}

.todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.todo-item.overdue { border-color: #fca5a5; background: #fef2f2; }
.todo-item:hover { border-color: var(--primary); }
.todo-priority { flex-shrink: 0; font-size: 12px; }
.todo-body { flex: 1; min-width: 0; }
.todo-title { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.todo-done-btn { flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 50%; background: white; cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.todo-done-btn:hover { border-color: var(--primary); color: var(--primary); }

.reminder-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.reminder-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.reminder-time { font-size: 11px; color: var(--text-muted); }

.pending-group-title { font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; padding: 4px 0; border-bottom: 1px solid var(--border); }
.pending-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-radius: var(--radius-sm); }
.pending-item:hover { background: var(--hover); }
.pending-text { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.pending-time { font-size: 11px; color: var(--text-muted); flex-shrink: 0; margin-left: 8px; }

.report-list { display: flex; flex-direction: column; gap: 4px; }
.report-item { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.report-item:hover { border-color: var(--primary); }
.report-item.active { border-color: var(--primary); background: rgba(99,102,241,0.03); }
.report-header { display: flex; align-items: center; justify-content: space-between; }
.report-date { font-size: 13px; font-weight: 600; color: var(--primary); }
.report-summary { font-size: 12px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; }
.report-time { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
.report-expand { font-size: 11px; color: var(--primary); margin-left: auto; padding-left: 8px; }
.latest-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.latest-date { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.latest-time { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.key-points {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: rgba(99, 102, 241, 0.04);
  border: 1px solid rgba(99, 102, 241, 0.12);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.key-point-group { display: flex; flex-direction: column; gap: 4px; }
.key-points-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
}
.key-point {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.report-item { cursor: pointer; }


/* ========== 日报详情弹窗 ========== */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
  background: white; border-radius: var(--radius-md); box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
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
.report-detail {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
}
</style>
