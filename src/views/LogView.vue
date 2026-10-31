<template>
  <div class="log-view">
    <div class="content-header">
      <h1 class="content-title">日志</h1>
      <div class="header-actions">
        <select v-model="levelFilter" class="form-control" style="width:auto;">
          <option value="">全部级别</option>
          <option value="ERROR">ERROR</option>
          <option value="WARN">WARN</option>
          <option value="INFO">INFO</option>
          <option value="DEBUG">DEBUG</option>
        </select>
        <select v-model="currentFile" class="form-control" style="width:auto;">
          <option v-for="f in files" :key="f.name" :value="f.name">{{ f.name }} ({{ formatSize(f.size) }})</option>
        </select>
        <label class="tail-toggle">
          <input type="checkbox" v-model="autoTail">
          <span>自动刷新</span>
        </label>
        <button class="btn btn-secondary" @click="loadLogs">刷新</button>
        <button class="btn btn-danger" @click="clearLog" :disabled="clearing">{{ clearing ? '清空中...' : '清空' }}</button>
      </div>
    </div>

    <div class="content-body" ref="logContainer">
      <div v-if="filteredLines.length === 0" class="empty-state">
        <div style="font-size:48px;margin-bottom:16px;">📋</div>
        <div>暂无日志。</div>
      </div>
      <div v-else class="log-lines">
        <div v-for="(line, i) in filteredLines" :key="i"
          class="log-line"
          :class="levelClass(line)"
          @dblclick="copyLine(line)">
          <span class="log-ts">{{ formatTs(line) }}</span>
          <span class="log-level" :class="levelClass(line)">{{ extractLevel(line) }}</span>
          <span class="log-msg">{{ extractMsg(line) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';

const API = window.electronAPI;

const lines = ref<string[]>([]);
const files = ref<{ name: string; size: number; mtime: string }[]>([]);
const currentFile = ref('app.log');
const levelFilter = ref('');
const autoTail = ref(true);
const clearing = ref(false);
const logContainer = ref<HTMLElement | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

function extractLevel(line: string) {
  const m = line.match(/\[(DEBUG|INFO|WARN|ERROR)\]/);
  return m ? m[1] : 'INFO';
}

function extractMsg(line: string) {
  return line.replace(/^\S+\s+\[(DEBUG|INFO|WARN|ERROR)\]\s+/, '');
}

function formatTs(line: string) {
  const m = line.match(/^(\S+)/);
  if (!m) return '';
  try {
    const d = new Date(m[1]);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return m[1];
  }
}

function levelClass(line: string) {
  const level = extractLevel(line);
  return level.toLowerCase();
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

async function loadLogs() {
  try {
    if (currentFile.value === 'app.log') {
      lines.value = await API.log.lines({ count: 200, tail: true });
    } else {
      lines.value = await API.log.readFile(currentFile.value, { count: 500, tail: true });
    }
    await loadFiles();
    if (autoTail.value) await nextTick(() => scrollToBottom());
  } catch (e) {
    console.warn('加载日志失败:', e);
  }
}

async function loadFiles() {
  try {
    files.value = await API.log.files();
  } catch {}
}

function scrollToBottom() {
  const el = logContainer.value;
  if (el) el.scrollTop = el.scrollHeight;
}

const filteredLines = computed(() => {
  if (!levelFilter.value) return lines.value;
  return lines.value.filter(l => extractLevel(l) === levelFilter.value);
});

async function clearLog() {
  clearing.value = true;
  try {
    await API.log.clear();
    lines.value = [];
  } catch {}
  clearing.value = false;
}

function copyLine(line: string) {
  navigator.clipboard.writeText(line).catch(() => {});
}

watch(currentFile, () => loadLogs());

onMounted(async () => {
  await loadLogs();
  pollTimer = setInterval(() => {
    if (autoTail.value) loadLogs();
  }, 3000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.log-view { display: flex; flex-direction: column; height: 100%; }
.content-header { padding: 12px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: var(--surface); gap: 12px; flex-wrap: wrap; }
.content-title { font-size: 18px; font-weight: 600; color: var(--text-primary); margin: 0; }
.header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tail-toggle { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-muted); cursor: pointer; user-select: none; }
.tail-toggle input { margin: 0; }
.content-body { flex: 1; overflow-y: auto; padding: 0; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 12px; line-height: 1.6; background: var(--surface); color: var(--text-primary); }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); }
.log-lines { padding: 8px 0; }
.log-line { padding: 2px 16px; cursor: pointer; display: flex; gap: 12px; white-space: pre-wrap; word-break: break-all; }
.log-line:hover { background: var(--hover); }
.log-line.debug .log-ts { color: #6c7086; }
.log-line.info .log-ts { color: var(--primary); }
.log-line.warn .log-ts { color: var(--warning); }
.log-line.error .log-ts { color: var(--danger); }
.log-ts { color: #6c7086; flex-shrink: 0; width: 160px; }
.log-level { font-weight: 700; flex-shrink: 0; width: 48px; text-align: center; }
.log-level.debug { color: #6c7086; }
.log-level.info { color: var(--primary); }
.log-level.warn { color: var(--warning); }
.log-level.error { color: var(--danger); }
.log-msg { color: var(--text-primary); }
.form-control { padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; background: var(--surface); color: var(--text-primary); }
.btn { padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; background: var(--surface); color: var(--text-primary); }
.btn-secondary { background: var(--hover); }
.btn-danger { background: var(--danger-soft); border-color: var(--danger-soft); color: var(--danger); }
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
</style>