<!--
  ChatListPanel —— 对话列表面板（页面内嵌，非全局侧栏）
  全局侧栏固定为 64px 图标栏后，对话列表挪进对话相关页面（ChatView / NewChatView）左侧。
  包含：新建对话（Ctrl+N）、搜索、按项目分组的会话树；可整体折叠成细条（记忆折叠状态）。
-->
<template>
  <div class="clp" :class="{ folded }">
    <template v-if="!folded">
      <!-- 快捷新建对话 -->
      <button class="new-chat" type="button" @click="quickNewChat()">
        <AppIcon name="plus" :size="14" />
        <span>新建对话</span>
        <span class="kbd">Ctrl+N</span>
      </button>

      <!-- 对话列表区头 -->
      <div class="sec-head">
        <span class="sec-title">对话列表</span>
        <button class="sec-ic" :title="searchOpen ? '关闭搜索' : '搜索对话'" @click="toggleSearch">
          <AppIcon :name="searchOpen ? 'x' : 'search'" :size="13" />
        </button>
        <button class="sec-ic" title="收起面板" @click="toggleFold">
          <AppIcon name="chevron-right" :size="13" style="transform: rotate(180deg);" />
        </button>
      </div>
      <div v-if="searchOpen" class="search-box">
        <input v-model="keyword" type="text" placeholder="搜索对话标题…" />
      </div>

      <!-- 对话树 -->
      <div class="tree">
        <template v-for="grp in visibleGroups" :key="grp.key">
          <div class="prj-row" :title="grp.dir || grp.name" @click="toggleProject(grp.key)">
            <AppIcon :name="isProjectOpen(grp.key) ? 'folder-open' : 'folder'" :size="13" class="f-ic" />
            <span class="nm">{{ grp.name }}</span>
          </div>
          <template v-if="isProjectOpen(grp.key)">
            <div
              v-for="s in grp.sessions"
              :key="sid(s)"
              class="leaf"
              :class="{ cur: sid(s) === currentSid }"
              :title="s.title || '新对话'"
              @click="openSession(s)"
            >
              <AppIcon name="message-square" :size="13" class="l-ic" />
              <span v-if="s.source === 'feishu'" class="fs-badge" title="来自飞书">飞书</span>
              <span v-else-if="s.source === 'mobile'" class="fs-badge" title="来自移动端">手机</span>
              <span class="nm">{{ s.title || '新对话' }}</span>
              <span class="tm">{{ fmtRelTime(s) }}</span>
              <button class="leaf-del" title="删除对话" @click.stop="removeSession(s)">×</button>
            </div>
            <div v-if="!grp.sessions.length" class="tree-empty">{{ searchOpen ? '无匹配对话' : '暂无对话' }}</div>
          </template>
        </template>
        <div v-if="!treeGroups.length" class="tree-empty">{{ searchOpen ? '无匹配对话' : '还没有对话' }}</div>
        <button v-if="hasMoreProjects" class="more-btn" type="button" @click="showAll = !showAll">
          {{ showAll ? '收起' : '显示更多' }}
        </button>
      </div>
    </template>
    <button v-else class="unfold" title="展开对话列表" @click="toggleFold">
      <AppIcon name="chevron-right" :size="14" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from './AppIcon.vue';

const API = window.electronAPI;
const route = useRoute();
const router = useRouter();

function quickNewChat() {
  router.push('/new');
}

// ========== 面板折叠（记忆状态） ==========
const FOLD_KEY = 'chat_list_folded';
const folded = ref(localStorage.getItem(FOLD_KEY) === '1');
function toggleFold() {
  folded.value = !folded.value;
  try { localStorage.setItem(FOLD_KEY, folded.value ? '1' : '0'); } catch {}
}

// ========== 对话树 ==========
const projects = ref<any[]>([]);
const sessions = ref<any[]>([]);
const searchOpen = ref(false);
const keyword = ref('');
const showAll = ref(false);
const collapsedProjects = ref<string[]>([]);
const currentSid = ref('');

// 与 ChatView 共享的当前会话标识（chat_home_state 由 ChatView.saveState 写入）
const CHAT_STATE_KEY = 'chat_home_state';
function loadCurrentSid() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_STATE_KEY) || '{}');
    currentSid.value = typeof saved?.sessionId === 'string' ? saved.sessionId : '';
  } catch { currentSid.value = ''; }
}

function sid(s: any): string {
  return s.session_id || String(s.id);
}

function sessionTime(s: any): number {
  const raw = String(s.updated_at || s.created_at || '').replace(' ', 'T');
  const t = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/** 相对时间：8分 / 2小时 / 3天 / MM-DD */
function fmtRelTime(s: any): string {
  const t = sessionTime(s);
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}小时`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)}天`;
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface TreeGroup { key: string; name: string; dir: string; sessions: any[] }

const treeGroups = computed<TreeGroup[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const sorted = [...sessions.value]
    .filter((s) => !kw || String(s.title || '').toLowerCase().includes(kw) || String(s.last_message || '').toLowerCase().includes(kw))
    .sort((a, b) => sessionTime(b) - sessionTime(a));
  const groups: TreeGroup[] = projects.value.map((p: any) => ({
    key: 'p' + p.id,
    name: p.name,
    dir: p.dir || '',
    sessions: [] as any[],
  }));
  const byId = new Map(groups.map((g) => [Number(g.key.slice(1)), g]));
  const loose: any[] = [];
  for (const s of sorted) {
    const pid = s.project_id === null || s.project_id === undefined ? null : Number(s.project_id);
    const g = pid !== null ? byId.get(pid) : undefined;
    (g ? g.sessions : loose).push(s);
  }
  // 搜索时只保留有匹配的组；未分组对话挂在末尾的「未分组」
  if (loose.length || (!kw && !projects.value.length)) {
    groups.push({ key: 'loose', name: '未分组', dir: '', sessions: loose });
  } else if (!kw && loose.length) {
    groups.push({ key: 'loose', name: '未分组', dir: '', sessions: loose });
  }
  return kw ? groups.filter((g) => g.sessions.length) : groups;
});

// 项目数超过 5 个时默认折叠，用「显示更多」展开（搜索时不限量）
const visibleGroups = computed(() => {
  if (showAll.value || keyword.value.trim() || treeGroups.value.length <= 5) return treeGroups.value;
  return treeGroups.value.slice(0, 5);
});
const hasMoreProjects = computed(() =>
  !keyword.value.trim() && treeGroups.value.length > 5,
);

function isProjectOpen(key: string): boolean {
  return !collapsedProjects.value.includes(key);
}
function toggleProject(key: string) {
  collapsedProjects.value = isProjectOpen(key)
    ? collapsedProjects.value.concat(key)
    : collapsedProjects.value.filter((k) => k !== key);
}
/** 默认展开当前会话所在项目 */
function expandProjectOf(sidValue: string) {
  for (const g of treeGroups.value) {
    if (g.sessions.some((s) => sid(s) === sidValue)) {
      collapsedProjects.value = collapsedProjects.value.filter((k) => k !== g.key);
      return;
    }
  }
}

async function openSession(s: any) {
  currentSid.value = sid(s);
  expandProjectOf(currentSid.value);
  router.push({ path: '/chat', query: { session: currentSid.value } });
}

/** 删除对话 */
async function removeSession(s: any) {
  const id = sid(s);
  if (!confirm('确定删除此对话？')) return;
  try {
    await API.chat.deleteSession(id);
    if (currentSid.value === id) {
      currentSid.value = '';
      try { localStorage.removeItem(CHAT_STATE_KEY); } catch {}
      if (route.path.startsWith('/chat')) router.push('/new');
    }
    await loadChatTree();
  } catch {}
}

async function loadChatTree() {
  try {
    const [ui, feishu, mobile] = await Promise.all([
      API.chat.getSessionsBySource('ui'),
      API.chat.getSessionsBySource('feishu'),
      API.chat.getSessionsBySource('mobile'),
    ]);
    // 与 ChatView 同一口径：ui 来源的 kb 模式后台会话不进树
    sessions.value = [...(ui || []), ...(feishu || []), ...(mobile || [])].filter(
      (s: any) => s.source === 'feishu' || s.source === 'mobile' || s.mode === 'general' || !s.project_id,
    );
  } catch { sessions.value = []; }
  try { projects.value = (await API.project.list()) || []; } catch { projects.value = []; }
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) keyword.value = '';
}

onMounted(() => {
  loadCurrentSid();
  loadChatTree();
  // ChatView 选定会话后广播，同步树上的当前会话高亮
  window.addEventListener('chat-state-changed', onChatStateChanged);
});

function onChatStateChanged() {
  loadCurrentSid();
  // 切换会话后树可能已有新会话入库，静默刷新一次
  loadChatTree();
}

onUnmounted(() => {
  window.removeEventListener('chat-state-changed', onChatStateChanged);
});
</script>

<style scoped>
.clp {
  width: 232px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 10px 10px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  box-sizing: border-box;
  min-height: 0;
  overflow: visible;
}
.clp.folded {
  width: 30px;
  padding: 12px 4px;
  align-items: center;
}
.unfold {
  margin-top: 2px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}
.unfold:hover { background: var(--hover); color: var(--text-primary); }

/* ===== 新建对话（轻量虚线框，与图标栏的轻盈风格一致） ===== */
.new-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.new-chat:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-soft);
}
.new-chat svg { color: var(--primary); }
.kbd {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}

/* ===== 区头（对话列表） ===== */
.sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 8px 4px;
  font-size: 11.5px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.sec-title { flex: 1; }
.sec-ic {
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: 5px;
  display: flex;
  flex-shrink: 0;
}
.sec-ic:hover { background: var(--hover); color: var(--text-primary); }

.search-box { padding: 2px 2px 4px; flex-shrink: 0; }
.search-box input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  padding: 5px 9px;
  outline: none;
}
.search-box input:focus { border-color: var(--primary); }
.search-box input::placeholder { color: var(--text-muted); }

/* ===== 对话树 ===== */
.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-bottom: 4px;
}
/* 项目/笔记库组头：与「对话列表」区头同级的弱化小字，形成 区头 → 组 → 会话 层级 */
.prj-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px 4px 10px;
  margin-top: 5px;
  border-radius: 7px;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}
.prj-row:hover { background: var(--hover); color: var(--text-primary); }
.prj-row .f-ic { color: var(--text-muted); flex-shrink: 0; }
.prj-row .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.leaf {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5.5px 8px 5.5px 30px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}
.leaf:hover { background: var(--hover); color: var(--text-primary); }
.leaf.cur { background: var(--primary-soft); color: var(--primary); }
.leaf .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leaf .l-ic { opacity: 0.75; flex-shrink: 0; }
.leaf .tm {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  font-family: var(--font-mono);
}
.leaf-del {
  display: none;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.leaf:hover .leaf-del { display: flex; }
.leaf-del:hover { color: var(--danger); background: var(--hover); }
.fs-badge {
  font-size: 10px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--primary-soft);
  color: var(--primary);
  flex-shrink: 0;
}

.tree-empty {
  padding: 8px 10px 8px 30px;
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.more-btn {
  margin: 4px 8px;
  padding: 5px 10px;
  text-align: left;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-muted);
  border-radius: 7px;
  cursor: pointer;
  flex-shrink: 0;
}
.more-btn:hover { background: var(--hover); color: var(--text-primary); }
</style>
