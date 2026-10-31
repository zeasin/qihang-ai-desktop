<template>
  <div class="insights-view">
    <div class="content-header">
      <h1 class="content-title">概览</h1>
    </div>
    <div class="content-body">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-icon" style="background:rgba(139,92,246,0.1);color:#8b5cf6;">📦</div><div class="stat-num">{{ stats.projectCount }}</div><div class="stat-label">项目</div></div>
        <div class="stat-card"><div class="stat-icon" style="background:rgba(34,197,94,0.1);color:#22c55e;">✅</div><div class="stat-num">{{ stats.todoPending }}</div><div class="stat-label">待办 {{ stats.todoOverdue ? '(' + stats.todoOverdue + ' 逾期)' : '' }}</div></div>
        <div class="stat-card"><div class="stat-icon" style="background:rgba(239,68,68,0.1);color:#ef4444;">🔔</div><div class="stat-num">{{ stats.remindersActive }}</div><div class="stat-label">提醒</div></div>
        <div class="stat-card"><div class="stat-icon" style="background:rgba(99,102,241,0.1);color:#6366f1;">💬</div><div class="stat-num">{{ stats.totalChats }}</div><div class="stat-label">对话</div></div>
        <div class="stat-card"><div class="stat-icon" style="background:rgba(251,146,60,0.1);color:#fb923c;">📊</div><div class="stat-num">{{ stats.todayDataRecords }}</div><div class="stat-label">今日数据</div></div>
      </div>

      <!-- 项目文件（实时扫盘统计） -->
      <div class="card index-card">
        <div class="index-card-header">
          <span class="index-model">项目文件 · 实时统计</span>
          <button class="btn btn-secondary btn-sm" :disabled="scanning" @click="reloadLibraryStats">{{ scanning ? '扫描中…' : '↻ 重新扫描' }}</button>
        </div>
        <div v-if="indexProjects.length">
          <div class="index-lib-list">
            <div v-for="p in indexProjects" :key="p.id" class="index-lib-section">
              <div class="index-lib-header">
                <span class="index-lib-name">{{ p.name }}<span v-if="p.isDefault" style="font-size:11px;color:#6366f1;margin-left:4px;">默认</span></span>
                <div class="index-lib-header-actions">
                  <span class="index-lib-dir text-muted">{{ p.dir }}</span>
                </div>
              </div>
              <div class="index-lib-summary">
                <div class="index-stat-card"><div class="index-stat-icon" style="background:rgba(59,130,246,0.1);color:#3b82f6;">📄</div><div class="index-stat-lib-num">{{ libStats(p.id)?.docCount || 0 }}</div><div class="index-stat-lib-label">笔记文件</div></div>
                <div class="index-stat-card"><div class="index-stat-icon" style="background:rgba(251,146,60,0.1);color:#fb923c;">🕒</div><div class="index-stat-lib-num">{{ libStats(p.id)?.todayModified || 0 }}</div><div class="index-stat-lib-label">今日更新</div></div>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="index-empty">
          <div class="index-empty-icon">📭</div>
          <div class="index-empty-text">一个项目都没有</div>
          <div class="index-empty-desc">请到「设置 → 项目」添加项目。AI 会直接读取项目目录里的 Markdown 文件；这里的文件数是实时扫出来的，不存在索引。</div>
        </div>
      </div>

      <div class="dashboard-grid">
        <div class="dashboard-left">
          <!-- 搜索 -->
          <div class="search-card">
            <div class="search-bar">
              <input v-model="searchQuery" class="search-input" placeholder="搜索笔记..." @keyup.enter="performSearch">
              <button class="search-btn" @click="performSearch">搜索</button>
            </div>
          </div>

          <!-- 日报 -->
          <div class="section-header">📊 综合日报 <span class="report-schedule">{{ reportScheduleText }}</span></div>
          <div class="card" v-if="reportDetail">
            <div class="preview" v-html="renderMarkdown(reportDetail)"></div>
          </div>
          <div class="card">
            <div v-if="reports.length" class="report-list">
              <div v-for="(r, i) in reports" :key="r.id" class="report-item" :class="{ active: expandedReport === i }" @click="selectReport(i, r)">
                <div class="report-header">
                  <span class="report-date">{{ r.report_date || '日报' }}</span>
                  <span class="report-time" style="margin:0;">{{ r.created_at }}</span>
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
          <!-- 待办 -->
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

          <!-- 提醒 -->
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

          <!-- 待处理记录 -->
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

    <!-- 搜索结果弹窗 -->
    <div class="modal-overlay" :class="{ active: showSearchResults }" @click.self="closeSearchResults">
      <div class="modal search-modal">
        <div class="modal-header">
          <span class="modal-title">搜索结果：{{ lastQuery }}（全部项目）</span>
          <button class="modal-close" @click="closeSearchResults">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="searchResults.length === 0" class="empty-state">
            <div class="empty-icon">😔</div>
            <div class="empty-title">未找到相关结果</div>
          </div>
          <div v-for="result in searchResults" :key="result.id" class="search-result-item" @click="openResult(result)">
            <div class="result-title"><span v-if="result.libName" style="color:#6366f1;font-weight:400;font-size:12px;">[{{ result.libName }}]</span> {{ result.title }}</div>
            <div class="result-path">{{ result.path }}</div>
            <div class="result-preview">{{ result.preview }}</div>
            <div class="result-score">{{ result.score }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 预览详情弹窗 -->
    <div class="modal-overlay" :class="{ active: showPreview }" @click.self="closePreview">
      <div class="modal preview-modal">
        <div class="modal-header">
          <span class="modal-title">{{ previewTitle }}</span>
          <button class="modal-close" @click="closePreview">✕</button>
        </div>
        <div class="modal-body preview-body" v-html="previewHtml"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const API = window.electronAPI;

const kbList = ref<any[]>([]);
const searchQuery = ref('');
const searchResults = ref<any[]>([]);
const showSearchResults = ref(false);
const lastQuery = ref('');
const scanning = ref(false);
const showPreview = ref(false);
const previewTitle = ref('');
const previewHtml = ref('');
const todos = ref<any[]>([]);
const reminders = ref<any[]>([]);
const pendingRecords = ref<any[]>([]);
const todayStr = ref('');

const stats = ref({
  fileCount: 0, notesFileCount: 0, todayModified: 0, projectCount: 0, totalChats: 0, todoPending: 0, todoOverdue: 0, remindersActive: 0, todayDataRecords: 0
});

const libraryStats = ref<any[]>([]);
const indexProjects = computed(() => kbList.value);

const reports = ref<any[]>([]);
const expandedReport = ref<number | null>(null);
const reportDetail = ref('');
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

// ========== 工具函数 ==========
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

// ========== 搜索 ==========
const stripMd = (s: string) => s.replace(/```[\s\S]*?```/g, '').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/(\*{1,3}|_{1,3})/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/>\s+/g, '').replace(/\n{3,}/g, '\n\n').trim();

const performSearch = async () => {
  const query = searchQuery.value.trim();
  if (!query) return;
  lastQuery.value = query;
  try {
    // 全项目搜索：逐个项目检索后合并结果
    const libs = kbList.value.filter((l: any) => l.dir);
    const merged: any[] = [];
    const chunks = await Promise.all(libs.map(async (l: any) => {
      try {
        const rs = await API.kb.search(l.dir, query);
        return rs.map((r: any) => ({ ...r, _lib: l.name }));
      } catch { return []; }
    }));
    for (const c of chunks) merged.push(...c);
    const sliced = merged.slice(0, 30);
    searchResults.value = sliced.map((r: any, i: number) => ({
      id: i,
      title: r.source ? r.source.split(/[\\/]/).pop() : '未知',
      path: r.source || '',
      preview: stripMd(r.text || '').slice(0, 200),
      score: r.score ? (r.score * 100).toFixed(1) + '%' : '0%',
      fullText: r.text || '',
      source: r.source || '',
      libName: r._lib || '',
      project_id: r.project_id
    }));
    showSearchResults.value = true;
  } catch {
    searchResults.value = [];
    showSearchResults.value = true;
  }
};

const closeSearchResults = () => {
  showSearchResults.value = false;
};

const openResult = async (result: any) => {
  previewTitle.value = result.title;
  const content = stripMd(result.fullText || '');
  previewHtml.value = renderMarkdown(content);
  showPreview.value = true;
};

const closePreview = () => {
  showPreview.value = false;
};

// ========== 日报选择 ==========
function selectReport(i: number, r: any) {
  expandedReport.value = i;
  reportDetail.value = r.content || '无内容';
}

// ========== 待办 ==========
async function toggleTodo(t: any) {
  const newStatus = t.status === 'done' ? 'pending' : 'done';
  await API.todo.update(t.id, { status: newStatus });
  t.status = newStatus;
}

async function loadTodos() {
  try {
    const list = await API.todo.list();
    todos.value = list.filter((t: any) => t.status !== 'done').slice(0, 10);
  } catch { todos.value = []; }
}

async function loadReminders() {
  try {
    reminders.value = await API.reminder.list();
  } catch { reminders.value = []; }
}

async function loadPendingRecords() {
  try {
    pendingRecords.value = await API.ds.pendingRecords();
  } catch { pendingRecords.value = []; }
}

// ========== 加载数据 ==========
async function loadDailyReports() {
  try {
    reports.value = await API.insights.reports();
    if (reports.value.length && expandedReport.value === null) {
      expandedReport.value = 0;
      reportDetail.value = reports.value[0].content || '无内容';
    }
  } catch { reports.value = []; }
}

function libStats(projectId: number) {
  return libraryStats.value.find(s => s.projectId === projectId) || null;
}

// 文件统计是实时扫盘得到的，没有索引也就没有「重建」这回事 —— 手动刷新就是重新扫一遍
async function reloadLibraryStats() {
  if (scanning.value) return;
  scanning.value = true;
  try {
    libraryStats.value = await API.insights.libraryStats();
    stats.value = await API.insights.stats();
  } catch {}
  setTimeout(() => { scanning.value = false; }, 300);
}

onMounted(async () => {
  const d = new Date();
  todayStr.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  try { stats.value = await API.insights.stats(); } catch {}
  try { const list = await API.kb.list(); kbList.value = list; } catch {}
  await loadDailyReports();
  await reloadLibraryStats();
  await loadTodos();
  await loadReminders();
  await loadPendingRecords();
  API.on('report:generated', () => {
    loadDailyReports();
  });
});

onBeforeUnmount(() => {
  API.removeAllListeners('report:generated');
});
</script>

<style scoped>
.insights-view { display: flex; flex-direction: column; height: 100%; }
.content-header { padding: 12px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: white; }
.content-title { font-size: 16px; font-weight: 600; color: var(--text-primary); }
.content-body { flex: 1; overflow-y: auto; padding: 16px 20px; }

/* stats 卡片网格 */
.stats-grid { display: flex; gap: 8px; margin-bottom: 14px; }
.stat-card { flex: 1; min-width: 0; background: white; border-radius: var(--radius-sm); border: 1px solid var(--border); padding: 10px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; transition: 0.15s; }
.stat-icon { width: 28px; height: 28px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; font-size: 14px; }
.stat-num { font-size: 18px; font-weight: 700; color: var(--text-primary); line-height: 1.2; }
.stat-label { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }

.card { background: white; border-radius: var(--radius-md); border: 1px solid var(--border); box-shadow: var(--shadow-sm); padding: 20px; margin-bottom: 16px; }
.card-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }

/* 项目文件统计卡片（实时扫盘） */
.index-card { margin-bottom: 14px; }
.index-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.index-stat-card { background: white; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; }
.index-stat-icon { width: 32px; height: 32px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; font-size: 16px; }
.index-lib-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.index-lib-section { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; }
.index-lib-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 12px; }
.index-lib-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.index-lib-header-actions { display: flex; gap: 4px; min-width: 0; }
.index-lib-dir { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.index-lib-summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.index-stat-lib-num { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.index-stat-lib-label { font-size: 10px; color: var(--text-muted); }
.index-model { font-size: 11px; color: var(--text-muted); }

.index-empty { text-align: center; padding: 24px 20px; }
.index-empty-icon { font-size: 36px; margin-bottom: 8px; opacity: 0.5; }
.index-empty-text { font-size: 15px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }
.index-empty-desc { font-size: 12px; color: var(--text-muted); margin-bottom: 14px; line-height: 1.5; }

/* 搜索栏 */
.search-card { background: white; border-radius: var(--radius-md); border: 1px solid var(--border); box-shadow: var(--shadow-sm); padding: 12px 16px; margin-bottom: 12px; }
.search-bar { display: flex; gap: 8px; align-items: center; }
.search-kb-select { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; outline: none; background: white; color: var(--text-primary); cursor: pointer; flex-shrink: 0; max-width: 140px; }
.search-kb-select:focus { border-color: var(--primary); }
.search-input { flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; outline: none; background: white; }
.search-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(99,102,241,0.1); }
.search-btn { padding: 8px 16px; background: var(--primary); color: white; border: none; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; transition: 0.15s; white-space: nowrap; }
.search-btn:hover { background: var(--primary-dark); }

/* 双栏布局 */
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.dashboard-left { display: flex; flex-direction: column; gap: 12px; }
.dashboard-right { display: flex; flex-direction: column; gap: 12px; }
.section-header { font-size: 14px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.section-header .report-schedule { font-size: 11px; font-weight: 400; color: var(--text-muted); margin-left: auto; }

/* 待办列表 */
.todo-list { display: flex; flex-direction: column; gap: 4px; }
.todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); transition: 0.15s; }
.todo-item.overdue { border-color: #fca5a5; background: #fef2f2; }
.todo-item:hover { border-color: var(--primary); }
.todo-priority { flex-shrink: 0; font-size: 12px; }
.todo-body { flex: 1; min-width: 0; }
.todo-title { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.todo-done-btn { flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 50%; background: white; cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); transition: 0.15s; }
.todo-done-btn:hover { border-color: var(--primary); color: var(--primary); }

/* 提醒列表 */
.reminder-list { display: flex; flex-direction: column; gap: 4px; }
.reminder-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.reminder-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.reminder-time { font-size: 11px; color: var(--text-muted); }

/* 待处理记录 */
.pending-list { display: flex; flex-direction: column; gap: 8px; }
.pending-group { }
.pending-group-title { font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; padding: 4px 0; border-bottom: 1px solid var(--border); }
.pending-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-radius: var(--radius-sm); }
.pending-item:hover { background: var(--hover); }
.pending-text { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.pending-time { font-size: 11px; color: var(--text-muted); flex-shrink: 0; margin-left: 8px; }

/* 搜索结果弹窗 */
.modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.35); z-index: 1000; align-items: flex-start; justify-content: center; padding-top: 60px; }
.modal-overlay.active { display: flex; }
.modal-overlay.visible { display: flex; }
.modal { background: white; border-radius: var(--radius-lg); width: 90%; max-width: 800px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.15); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.modal-title { font-size: 15px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-close { background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text-muted); padding: 4px 8px; border-radius: 4px; }
.modal-close:hover { background: var(--hover); color: var(--text-primary); }
.modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; }

.search-result-item { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 8px; cursor: pointer; transition: 0.15s; }
.search-result-item:hover { border-color: var(--primary); background: var(--hover); }
.result-title { font-size: 14px; font-weight: 500; color: var(--text-primary); margin-bottom: 2px; }
.result-path { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-preview { font-size: 13px; color: var(--text-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.result-score { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

/* 预览弹窗 */
.preview-modal { max-width: 900px; }
.preview-body { font-size: 14px; line-height: 1.8; color: var(--text-secondary); }

.empty-state { text-align: center; padding: 40px 20px; color: var(--text-muted); }
.empty-icon { font-size: 40px; margin-bottom: 8px; opacity: 0.5; }
.empty-title { font-size: 15px; font-weight: 500; margin-bottom: 6px; color: var(--text-secondary); }

/* 报告 */
.report-header-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.report-schedule { font-size: 11px; color: var(--text-muted); }
.report-list { display: flex; flex-direction: column; gap: 4px; }
.report-item { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: 0.15s; }
.report-item:hover { border-color: var(--primary); }
.report-item.active { border-color: var(--primary); background: rgba(99,102,241,0.03); }
.report-header { display: flex; align-items: center; justify-content: space-between; }
.report-date { font-size: 13px; font-weight: 600; color: var(--primary); }
.report-toggle { font-size: 11px; color: var(--text-muted); }
.report-summary { font-size: 12px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; }
.report-time { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
.report-detail { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.report-detail .preview { font-size: 13px; line-height: 1.7; }

/* 新建笔记库名称输入弹窗 */
.prompt-box { background: white; border-radius: var(--radius-lg); padding: 24px; width: 360px; box-shadow: 0 20px 60px rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 12px; margin-top: 80px; }
.prompt-title { font-size: 16px; font-weight: 600; color: var(--text-primary); }
.prompt-input { padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; outline: none; }
.prompt-input:focus { border-color: var(--primary); }
.prompt-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
