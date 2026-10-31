<!--
  AppSidebar —— ZCode 风格侧栏
  结构：品牌区 → 顶部菜单（今天/任务/数据）→ 新建对话（Ctrl+N）
        → 对话树（按项目分组，标题 + 相对时间，可搜索/折叠/显示更多）
        → 底部功能区（待办/笔记/技能/设置）→ 最底部（引擎状态/日志/帮助/主题）
-->
<template>
  <aside class="sidebar">
    <!-- 品牌区 -->
    <div class="brand">
      <span class="brand-mark"><AppIcon name="sailboat" :size="15" /></span>
      <span class="brand-text"><b>启航</b><small>AI 工作台</small></span>
    </div>

    <!-- 顶部菜单 -->
    <nav class="menu">
      <router-link
        v-for="item in topMenu"
        :key="item.path"
        :to="item.path"
        class="menu-item"
        :class="{ active: isActive(item.path) }"
      >
        <AppIcon :name="item.icon" :size="15" />
        <span class="mi-label">{{ item.label }}</span>
        <span v-if="item.badge" class="ct" :class="item.badgeClass">{{ item.badge }}</span>
      </router-link>
    </nav>

    <div class="sep"></div>

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
    </div>
    <div v-if="searchOpen" class="search-box">
      <input v-model="keyword" type="text" placeholder="搜索对话标题…" />
    </div>

    <!-- 对话树 -->
    <div class="tree">
      <template v-for="grp in visibleGroups" :key="grp.key">
        <div class="prj-row" :title="grp.dir || grp.name" @click="toggleProject(grp.key)">
          <AppIcon :name="isProjectOpen(grp.key) ? 'folder-open' : 'folder'" :size="14" class="f-ic" />
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

    <!-- 底部功能区 -->
    <nav class="foot-nav">
      <router-link
        v-for="item in footMenu"
        :key="item.path"
        :to="item.path"
        class="menu-item"
        :class="{ active: isActive(item.path) }"
      >
        <AppIcon :name="item.icon" :size="15" />
        <span class="mi-label">{{ item.label }}</span>
        <span v-if="item.beta" class="beta-tag">beta</span>
        <span v-else-if="item.badge" class="ct" :class="item.badgeClass">{{ item.badge }}</span>
      </router-link>
    </nav>

    <!-- 最底部 -->
    <div class="foot">
      <div class="pop-wrap">
        <button
          class="foot-link"
          :title="services.scheduler ? '引擎运行中' : '引擎待机'"
          @click.stop="engOpen = !engOpen"
        >
          <span class="status-dot" :class="services.scheduler ? 'ok pulse' : 'idle'"></span>
        </button>
        <div v-if="engOpen" class="pop eng-pop" @click.stop>
          <div class="pop-label">服务状态</div>
          <div class="svc">
            <span>定时调度</span>
            <b><i class="status-dot" :class="services.scheduler ? 'ok' : 'idle'"></i>{{ services.scheduler ? '运行中' : '已停止' }}</b>
          </div>
          <div class="svc">
            <span>飞书 Bot</span>
            <b><i class="status-dot" :class="services.feishu ? 'ok' : 'idle'"></i>{{ services.feishu ? '已连接' : '未启用' }}</b>
          </div>
          <router-link class="pop-more" to="/log" @click="engOpen = false">
            打开运行日志
            <AppIcon name="chevron-right" :size="12" />
          </router-link>
        </div>
      </div>
      <router-link to="/log" class="foot-link" title="运行日志"><AppIcon name="terminal" :size="15" /></router-link>
      <router-link to="/help" class="foot-link" title="帮助"><AppIcon name="circle-help" :size="15" /></router-link>
      <span class="foot-sp"></span>
      <button class="foot-link" :title="isDark ? '切换到浅色模式' : '切换到暗色模式'" @click="toggleTheme">
        <AppIcon :name="isDark ? 'sun' : 'moon'" :size="15" />
      </button>
      <router-link to="/config" class="foot-link" title="设置"><AppIcon name="settings" :size="15" /></router-link>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { toggleTheme, useTheme } from '../composables/theme';

const API = window.electronAPI;
const route = useRoute();
const router = useRouter();
const isDark = useTheme();

// 快捷新建对话：独立新建页（Ctrl+N 同样直达）
function quickNewChat() {
  engOpen.value = false;
  router.push('/new');
}

// ========== 导航 ==========
const topMenu = computed(() => [
  { path: '/overview', label: '今天', icon: 'sun', badge: 0, badgeClass: '' },
  { path: '/planner', label: '任务', icon: 'workflow', badge: taskRunning.value, badgeClass: 'run' },
  { path: '/data', label: '数据', icon: 'database', badge: pendingCount.value, badgeClass: 'warm' },
]);

const footMenu = computed(() => [
  { path: '/reminders', label: '待办', icon: 'list-checks', badge: todoOpen.value, badgeClass: '', beta: false },
  { path: '/notes', label: '笔记', icon: 'library', badge: 0, badgeClass: '', beta: false },
  { path: '/tools', label: '技能', icon: 'sparkles', badge: 0, badgeClass: '', beta: true },
]);

const isActive = (path: string) => {
  if (path === '/planner' && route.path.startsWith('/task/')) return true;
  return route.path === path || route.path.startsWith(path + '/');
};

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

/** 删除对话（原会话浮层的删除入口移到树上） */
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
    const [ui, feishu] = await Promise.all([
      API.chat.getSessionsBySource('ui'),
      API.chat.getSessionsBySource('feishu'),
    ]);
    // 与 ChatView 同一口径：ui 来源的 kb 模式后台会话不进树
    sessions.value = [...(ui || []), ...(feishu || [])].filter(
      (s: any) => s.source === 'feishu' || s.mode === 'general' || !s.project_id,
    );
  } catch { sessions.value = []; }
  try { projects.value = (await API.project.list()) || []; } catch { projects.value = []; }
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) keyword.value = '';
}

// ========== 引擎状态 ==========
const services = ref({ feishu: false, scheduler: false });
const engOpen = ref(false);

async function loadServices() {
  try { services.value = await API.service.status(); } catch {}
}

// ========== 徽标计数 ==========
const todoOpen = ref(0);
const taskRunning = ref(0);
const pendingCount = ref(0);

async function loadBadges() {
  try {
    const todos = await API.todo.list();
    todoOpen.value = (todos || []).filter((t: any) => t.status !== 'done').length;
  } catch { todoOpen.value = 0; }
  try {
    const tasks = await API.task.list();
    taskRunning.value = (tasks || []).filter((t: any) => t.status === 'in_progress').length;
  } catch { taskRunning.value = 0; }
  try {
    const groups = await (API as any).ds.pendingRecords();
    pendingCount.value = (groups || []).reduce((n: number, g: any) => n + (g.records?.length || 0), 0);
  } catch { pendingCount.value = 0; }
}

let timer: number | undefined;
function refreshAll() {
  loadServices();
  loadBadges();
  loadChatTree();
  loadCurrentSid();
}

function onDocClick() {
  engOpen.value = false;
}

// Ctrl+N 新建对话
function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    quickNewChat();
  }
}

onMounted(() => {
  refreshAll();
  timer = window.setInterval(refreshAll, 60_000);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
  // ChatView 选定会话后广播，同步树上的当前会话高亮
  window.addEventListener('chat-state-changed', loadCurrentSid);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('chat-state-changed', loadCurrentSid);
});

watch(() => route.path, () => {
  engOpen.value = false;
  loadCurrentSid();
  loadChatTree();
});
</script>

<style scoped>
.sidebar {
  width: 250px;
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 12px 10px 10px;
  overflow: visible;
  min-height: 0;
}

/* ========== 品牌区 ========== */
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px 6px 12px;
}
.brand-mark {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.brand-text b { display: block; font-size: 13px; font-weight: 600; line-height: 1.25; color: var(--text-primary); }
.brand-text small { display: block; font-size: 11px; color: var(--text-muted); line-height: 1.3; }

/* ========== 菜单行（顶部菜单 / 底部功能区共用） ========== */
.menu,
.foot-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.menu-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.menu-item:hover { background: var(--hover); color: var(--text-primary); }
.menu-item.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.mi-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ct {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--primary);
  color: #fff;
  flex-shrink: 0;
}
.ct.run { background: var(--warning-soft); color: var(--warning); }
.ct.warm { background: var(--warning-soft); color: var(--warning); }

.beta-tag {
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--warning-soft);
  color: var(--warning);
  flex-shrink: 0;
}

.sep { height: 1px; background: var(--border); margin: 10px 4px; flex-shrink: 0; }

/* ========== 新建对话 ========== */
.new-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
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

/* ========== 区头（对话列表 / 项目） ========== */
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

/* ========== 对话树 ========== */
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
.prj-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}
.prj-row:hover { background: var(--hover); }
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

/* ========== 弹出层通用 ========== */
.pop-wrap { position: relative; }
.pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 60;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 8px;
  width: 224px;
}
.pop-label { font-size: 11px; color: var(--text-muted); padding: 4px 8px 6px; letter-spacing: 0.05em; }
.pop-more {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--primary);
  margin: 8px 4px 2px;
  text-decoration: none;
}
.svc {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 5px 8px;
}
.svc b { display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 11.5px; color: var(--text-primary); }

/* ========== 最底部 ========== */
.foot {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 2px 0;
  margin-top: 8px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.foot-sp { flex: 1; }
.foot-link {
  height: 28px;
  min-width: 28px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 7px;
  color: var(--text-muted);
  text-decoration: none;
  border: none;
  background: none;
  cursor: pointer;
  transition: all 0.15s;
}
.foot-link:hover { background: var(--hover); color: var(--text-primary); }
</style>
