<template>
  <div class="overview-view">
    <div class="stats-grid">
      <div class="stat-card kb-card" @click="openNotes" title="浏览知识库">
        <div class="stat-icon" style="background:rgba(16,185,129,0.1);color:#10b981;">📚</div>
        <div class="stat-num">{{ stats.notesFileCount }}</div>
        <div class="stat-label">笔记库<span class="kb-settings" @click.stop="openConfig" title="设置笔记库目录">⚙</span></div>
      </div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(59,130,246,0.1);color:#3b82f6;">📂</div><div class="stat-num">{{ stats.codeProjectCount }}</div><div class="stat-label">项目</div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(34,197,94,0.1);color:#22c55e;">✅</div><div class="stat-num">{{ stats.todoPending }}</div><div class="stat-label">待办 {{ stats.todoOverdue ? '(' + stats.todoOverdue + ' 逾期)' : '' }}</div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(239,68,68,0.1);color:#ef4444;">🔔</div><div class="stat-num">{{ stats.remindersActive }}</div><div class="stat-label">提醒</div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(99,102,241,0.1);color:#6366f1;">💬</div><div class="stat-num">{{ stats.totalChats }}</div><div class="stat-label">对话</div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(251,146,60,0.1);color:#fb923c;">📊</div><div class="stat-num">{{ stats.todayDataRecords }}</div><div class="stat-label">今日数据</div></div>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-left">
        <div class="section-header">📊 综合日报 <span class="report-schedule">{{ reportScheduleText }}</span></div>
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
          <div v-else class="key-points">
            <div class="key-point">{{ (latestReport.summary || '').slice(0, 200) }}</div>
          </div>
        </div>
        <div class="card">
          <div v-if="reports.length" class="report-list">
            <div v-for="(r, i) in reports" :key="r.id" class="report-item" @click="openReportModal(r)">
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
      </div>

      <div class="dashboard-right">
        <div class="section-header">✅ 待办事项</div>
        <div class="card">
          <div v-if="todos.length" class="todo-list">
            <div v-for="t in todos" :key="t.id" class="todo-item" :class="{ overdue: t.due_date && t.due_date < todayStr && t.status !== 'done' }">
              <div class="todo-priority" :class="t.priority">{{ t.priority === 'high' ? '🔴' : t.priority === 'mid' ? '🟡' : '🟢' }}</div>
              <div class="todo-body">
                <div class="todo-title">{{ t.title }}</div>
                <div class="todo-meta" v-if="t.due_date">{{ t.due_date }}</div>
              </div>
              <button class="todo-done-btn" @click="toggleTodo(t)">{{ t.status === 'done' ? '↩' : '✓' }}</button>
            </div>
          </div>
          <div v-else class="empty-state" style="padding:20px;">
            <div class="empty-title" style="font-size:13px;">暂无待办</div>
          </div>
        </div>

        <div class="section-header">🔔 提醒</div>
        <div class="card">
          <div v-if="reminders.length" class="reminder-list">
            <div v-for="r in reminders" :key="r.id" class="reminder-item">
              <div class="reminder-name">{{ r.name }}</div>
              <div class="reminder-time">{{ r.time || '09:00' }}{{ r.date ? ' · ' + r.date : '' }}</div>
            </div>
          </div>
          <div v-else class="empty-state" style="padding:20px;">
            <div class="empty-title" style="font-size:13px;">暂无提醒</div>
          </div>
        </div>

        <div class="section-header">📋 待处理记录</div>
        <div class="card">
          <div v-if="pendingRecords.length" class="pending-list">
            <div v-for="group in pendingRecords" :key="group.datasetId" class="pending-group">
              <div class="pending-group-title">{{ group.datasetName }}</div>
              <div v-for="rec in group.records" :key="rec.id" class="pending-item">
                <div class="pending-text">{{ Object.values(rec).filter(v => typeof v === 'string' && v.length < 80 && v !== rec._created_at).slice(0, 2).join(' · ') || '(无标题)' }}</div>
                <div class="pending-time">{{ rec._created_at || '' }}</div>
              </div>
            </div>
          </div>
          <div v-else class="empty-state" style="padding:20px;">
            <div class="empty-title" style="font-size:13px;">暂无待处理记录</div>
          </div>
        </div>
      </div>
    </div>
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

const API = window.electronAPI;
const router = useRouter();

const openNotes = () => router.push('/notes');
const openConfig = () => router.push('/config');

const stats = ref({
  fileCount: 0, notesFileCount: 0, chunkCount: 0, todayModified: 0, projectCount: 0, codeProjectCount: 0, totalChats: 0, todoPending: 0, todoOverdue: 0, remindersActive: 0, todayDataRecords: 0
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

onMounted(() => {
  loadOverviewData();
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

.stats-grid {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.stat-card {
  flex: 1;
  min-width: 0;
  background: white;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 2px;
}
.kb-card {
  cursor: pointer;
  transition: all 0.15s;
}
.kb-card:hover {
  border-color: var(--primary);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}
.kb-settings {
  margin-left: 4px;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.6;
}
.kb-settings:hover {
  opacity: 1;
}
.stat-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.stat-num {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}
.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.card {
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  padding: 20px;
  margin-bottom: 16px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.dashboard-left {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dashboard-right {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-header {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-header .report-schedule {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: auto;
}

.todo-list { display: flex; flex-direction: column; gap: 4px; }
.todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.todo-item.overdue { border-color: #fca5a5; background: #fef2f2; }
.todo-item:hover { border-color: var(--primary); }
.todo-priority { flex-shrink: 0; font-size: 12px; }
.todo-body { flex: 1; min-width: 0; }
.todo-title { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.todo-done-btn { flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 50%; background: white; cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.todo-done-btn:hover { border-color: var(--primary); color: var(--primary); }

.reminder-list { display: flex; flex-direction: column; gap: 4px; }
.reminder-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.reminder-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.reminder-time { font-size: 11px; color: var(--text-muted); }

.pending-list { display: flex; flex-direction: column; gap: 8px; }
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
