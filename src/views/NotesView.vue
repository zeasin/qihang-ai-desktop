<template>
  <div class="notes-view">
    <!-- 未配置笔记库：AI 功能门禁 -->
    <NotesGate v-if="notesLoaded && !notesDir" @ready="loadNotesDir" />

    <!-- ========== 文件浏览 ========== -->
    <div v-else class="notes-body">
      <div class="left-panel">
        <div class="panel-header">
          <div class="panel-title">文件浏览</div>
        </div>
        <div class="project-bar">
          <span v-if="notesDir" class="proj-name">{{ notesDir }}</span>
          <span v-else class="proj-name text-muted">未配置笔记库</span>
        </div>
        <div class="search-bar">
          <input v-model="searchQuery" class="search-input" placeholder="搜索当前项目..." @keydown.enter="doSearch" />
          <button class="btn-icon" @click="doSearch" title="搜索">🔍</button>
          <button v-if="searchActive" class="btn-icon" @click="clearSearch" title="返回文件树">✕</button>
        </div>
        <div class="tree-container">
          <div v-if="searchActive" class="search-results">
            <div v-if="searchResults.length === 0 && searched" class="tree-placeholder"><span class="placeholder-text">未找到结果</span></div>
            <div v-for="(r,i) in searchResults" :key="i" class="search-result-item" @click="openSearchResult(r)">
              <div class="search-result-name">{{ r.name }}</div>
              <div class="search-result-path">{{ r.path.replace(notesDir||"","") }}</div>
              <div v-if="r.match" class="search-result-match">{{ r.match }}</div>
            </div>
          </div>

          <template v-if="!searchActive">
          <div v-if="treeData.length === 0" class="tree-placeholder">
            <div class="placeholder-text">暂无文件</div>
          </div>
          <TreeNode
            v-else
            v-for="node in treeData"
            :key="node.path"
            :node="node"
            :depth="0"
            :kb-id="notesDir"
            @select="selectFile"
          />
          </template>
        </div>
      </div>

      <div class="right-panel">
        <div v-if="!selectedFile" class="empty-state">
          <div class="empty-icon">📄</div>
          <div class="empty-title">选择笔记文件</div>
          <div class="empty-desc">在左侧文件树中选择一个 Markdown 文件查看内容</div>
        </div>
        <template v-else>
          <div class="preview-header">
            <div class="preview-info">
              <div class="preview-title">{{ selectedFile.name }}</div>
              <div class="preview-path">{{ selectedFile.path }}</div>
            </div>
          </div>
          <div class="preview-content" v-html="renderedContent"></div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import TreeNode from '@/components/TreeNode.vue';
import NotesGate from '@/components/NotesGate.vue';

const API = window.electronAPI;

// ========== 文件浏览 ==========
const notesDir = ref('');
const notesLoaded = ref(false);
const treeData = ref<TreeNode[]>([]);
const selectedFile = ref<any>(null);
const fileContent = ref('');
const searchQuery = ref('');
const searchActive = ref(false);
const searched = ref(false);
const searchResults = ref<any[]>([]);

const renderedContent = computed(() => {
  if (!fileContent.value) return '';
  const name = selectedFile.value?.name || '';
  if (name.endsWith('.md')) {
    try { return marked(fileContent.value); } catch { return '<pre>' + escapeHtml(fileContent.value) + '</pre>'; }
  }
  const ext = name.includes('.') ? name.split('.').pop() || '' : '';
  const lang = hljs.getLanguage(ext) ? ext : '';
  const highlighted = lang ? hljs.highlight(fileContent.value, { language: lang }).value : escapeHtml(fileContent.value);
  return '<pre><code class="hljs ' + (lang ? 'language-' + lang : '') + '">' + highlighted + '</code></pre>';
});

async function loadNotesDir() {
  try {
    notesDir.value = await API.kb.getDir();
    if (notesDir.value) {
      await loadFileTree();
    }
  } catch (e) {
    console.warn('加载笔记库失败:', e);
  }
  notesLoaded.value = true;
}

async function loadFileTree() {
  if (!notesDir.value) return;
  try {
    treeData.value = await API.notes.tree(notesDir.value);
  } catch (e) {
    console.warn('加载文件树失败:', e);
    treeData.value = [];
  }
}

async function selectFile(item: TreeNode) {
  if (item.type === 'folder') return;
  selectedFile.value = item;
  try {
    const result = await API.notes.read(notesDir.value, item.path);
    if (result.ok) {
      fileContent.value = result.content;
    } else {
      fileContent.value = '⚠️ 读取失败: ' + (result.error || '未知错误');
    }
  } catch (e: any) {
    fileContent.value = '⚠️ 读取失败: ' + e.message;
  }
}

function escapeHtml(text: string): string {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

async function doSearch() {
  const q = searchQuery.value.trim();
  if (!q) { searchActive.value = false; return; }
  searchActive.value = true;
  searched.value = true;
  try {
    if (notesDir.value) {
      const results = await API.kb.search(notesDir.value, q);
      searchResults.value = results.map((r: any) => ({
        path: r.source, name: r.title, score: r.score, match: (r.text || '').slice(0, 200),
      }));
    } else {
      searchResults.value = [];
    }
  } catch { searchResults.value = []; }
}

function clearSearch() {
  searchActive.value = false;
  searchQuery.value = '';
  searchResults.value = [];
  searched.value = false;
}

function openSearchResult(r: any) {
  selectFile({ name: r.name, path: r.path, type: 'file' });
}

onMounted(() => {
  loadNotesDir();
});
</script>

<style scoped>
.notes-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-main);
}

/* ===== 文件浏览 ===== */
.notes-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.left-panel {
  width: 280px;
  min-width: 200px;
  max-width: 400px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease, min-width 0.2s ease;
  flex-shrink: 0;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.project-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.project-bar .proj-select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: white;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
}
.project-bar .proj-select:focus {
  border-color: var(--primary);
}

.project-bar .proj-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 15px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-icon:hover {
  background: var(--hover);
  color: var(--text-primary);
}
.btn-icon:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.tree-container {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
}
.placeholder-text {
  font-size: 13px;
  color: var(--text-muted);
}

.right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: white;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.empty-desc {
  font-size: 13px;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px;
  border-bottom: 1px solid var(--border);
  background: white;
  flex-shrink: 0;
}
.preview-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.preview-path {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  word-break: break-all;
}

.preview-content {
  flex: 1;
  overflow-y: auto;
  padding: 36px 52px;
  font-size: 14px;
  line-height: 1.85;
  color: var(--text-primary);
}
.preview-content:deep(h1) {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 20px;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--border);
}
.preview-content:deep(h2) {
  font-size: 22px;
  font-weight: 600;
  margin: 32px 0 16px;
  padding-left: 12px;
  border-left: 4px solid var(--primary);
}
.preview-content:deep(h3) {
  font-size: 18px;
  font-weight: 600;
  margin: 24px 0 12px;
}
.preview-content:deep(h4) {
  font-size: 16px;
  font-weight: 600;
  margin: 20px 0 10px;
}
.preview-content:deep(p) {
  margin-bottom: 16px;
}
.preview-content:deep(ul),
.preview-content:deep(ol) {
  margin-bottom: 16px;
  padding-left: 24px;
}
.preview-content:deep(li) {
  margin-bottom: 6px;
}
.preview-content:deep(blockquote) {
  margin: 16px 0;
  padding: 8px 16px;
  border-left: 4px solid var(--primary-light);
  background: #f8fafc;
  color: var(--text-secondary);
  border-radius: 0 6px 6px 0;
}
.preview-content:deep(code) {
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 13px;
  color: var(--primary-dark);
}
.preview-content:deep(pre) {
  background: #1e293b;
  color: #e2e8f0;
  padding: 16px 20px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 16px 0;
  font-size: 13px;
  line-height: 1.6;
}
.preview-content:deep(pre code) {
  background: none;
  color: inherit;
  padding: 0;
  font-size: inherit;
}
.preview-content:deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
}
.preview-content:deep(th),
.preview-content:deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--border);
  text-align: left;
  font-size: 13px;
}
.preview-content:deep(th) {
  background: var(--hover);
  font-weight: 600;
}
.preview-content:deep(img) {
  max-width: 100%;
  border-radius: 8px;
  margin: 16px 0;
}
.preview-content:deep(a) {
  color: var(--primary);
  text-decoration: none;
}
.preview-content:deep(a:hover) {
  text-decoration: underline;
}
.preview-content:deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 24px 0;
}

.text-muted { color: var(--text-muted); font-size: 13px; }

.search-bar { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.search-bar .search-input { flex:1; padding:5px 8px; border:1px solid var(--border); border-radius:6px; font-size:13px; outline:none; background:white; }
.search-bar .search-input:focus { border-color:var(--primary); }
.search-result-item { padding: 8px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search-result-item:hover { background: var(--hover); }
.search-result-name { font-size:13px; font-weight:500; color:var(--text-primary); }
.search-result-path { font-size:11px; color:var(--text-muted); margin-top:2px; word-break:break-all; }
.search-result-match { font-size:12px; color:var(--text-secondary); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

:deep(.btn) {
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
:deep(.btn-primary) { background: var(--primary); color: white; }
:deep(.btn-primary:hover) { background: var(--primary-dark); }
:deep(.btn-secondary) { background: white; color: var(--text-secondary); border: 1px solid var(--border); }
:deep(.btn-secondary:hover) { background: var(--hover); }
:deep(.form-control) {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  outline: none;
  transition: all 0.2s;
  background: white;
}
:deep(.form-control:focus) {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}
</style>