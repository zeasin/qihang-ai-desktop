<!--
  AppSidebar —— 全局固定图标导航栏（64px 迷你导航，所有页面统一）
  图标+小字纵向排列，宽度让给内容区；对话列表已挪进对话页内的 ChatListPanel 面板。
  结构：品牌区（仅浏览器模式）→ 顶部菜单（今天/对话/任务/数据源）→ 底部功能区（待办/笔记/技能/雷达）
        → 最底部（日志/主题；帮助在 Electron 下位于顶栏右侧，设置在右下角）
-->
<template>
  <aside class="sidebar">
    <!-- 品牌区 -->
    <div v-if="isBrowser" class="brand">
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

    <!-- 最底部（窄栏内纵向排列，引擎状态点贴住最底） -->
    <div class="foot">
      <router-link to="/log" class="foot-link" title="运行日志"><AppIcon name="terminal" :size="15" /></router-link>
      <!-- 帮助入口已上移到顶栏右侧；浏览器模式下此处兜底显示 -->
      <router-link v-if="isBrowser" to="/help" class="foot-link" title="帮助"><AppIcon name="circle-help" :size="15" /></router-link>
      <button class="foot-link" :title="isDark ? '切换到浅色模式' : '切换到暗色模式'" @click="toggleTheme">
        <AppIcon :name="isDark ? 'sun' : 'moon'" :size="15" />
      </button>
      <router-link to="/config" class="foot-link" title="设置"><AppIcon name="settings" :size="15" /></router-link>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { toggleTheme, useTheme } from '../composables/theme';

const API = window.electronAPI;
const isBrowser = !API;
const route = useRoute();
const router = useRouter();
const isDark = useTheme();

// 快捷新建对话：独立新建页（Ctrl+N 同样直达）
function quickNewChat() {
  router.push('/new');
}

// ========== 导航 ==========
const topMenu = computed(() => [
  { path: '/overview', label: '今天', icon: 'calendar', badge: 0, badgeClass: '' },
  { path: '/chat', label: '对话', icon: 'message-square', badge: 0, badgeClass: '' },
  { path: '/planner', label: '任务', icon: 'workflow', badge: taskRunning.value, badgeClass: 'run' },
  { path: '/sources', label: '数据源', icon: 'database', badge: 0, badgeClass: '' },
]);

const footMenu = computed(() => [
  { path: '/reminders', label: '待办', icon: 'list-checks', badge: todoOpen.value, badgeClass: '', beta: false },
  { path: '/notes', label: '笔记', icon: 'library', badge: 0, badgeClass: '', beta: false },
  { path: '/tools', label: '技能', icon: 'sparkles', badge: 0, badgeClass: '', beta: true },
  { path: '/radar', label: '雷达', icon: 'radar', badge: radarRunning.value, badgeClass: 'run', beta: false },
]);

const isActive = (path: string) => {
  if (path === '/planner' && route.path.startsWith('/task/')) return true;
  // 对话项覆盖 /chat 与 /new（新建对话也算对话场景）
  if (path === '/chat' && (route.path === '/new' || route.path.startsWith('/chat'))) return true;
  return route.path === path || route.path.startsWith(path + '/');
};

// ========== 雷达运行徽标 ==========
/** 雷达运行中的会话数（徽标）：仅在雷达页之外显示提醒 */
const radarRunning = ref(0);

async function loadRadarBadge() {
  if (route.path === '/radar') { radarRunning.value = 0; return; }
  try {
    const stats = await API.radar.toolStats();
    radarRunning.value = (stats || []).reduce((n: number, t: any) => n + (Number(t.running) || 0), 0);
  } catch { radarRunning.value = 0; }
}

// ========== 徽标计数 ==========
const todoOpen = ref(0);
const taskRunning = ref(0);

async function loadBadges() {
  try {
    const todos = await API.todo.list();
    todoOpen.value = (todos || []).filter((t: any) => t.status !== 'done').length;
  } catch { todoOpen.value = 0; }
  try {
    const tasks = await API.task.list();
    taskRunning.value = (tasks || []).filter((t: any) => t.status === 'in_progress').length;
  } catch { taskRunning.value = 0; }
}

let timer: number | undefined;
function refreshAll() {
  loadBadges();
  loadRadarBadge();
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
  timer = window.setInterval(refreshAll, 5_000);
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.sidebar {
  width: 64px;
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 12px 6px 10px;
  box-sizing: border-box;
  overflow: visible;
  min-height: 0;
}

/* ========== 品牌区 ========== */
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
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
.brand-text { display: none; }

/* ========== 菜单项（顶部菜单 / 底部功能区共用）：图标在上、小字在下 ========== */
.menu,
.foot-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.foot-nav { margin-top: auto; }
.menu-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 9px 2px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.menu-item:hover { background: var(--hover); color: var(--text-primary); }
.menu-item.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.mi-label {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 1.2;
}

/* 徽标/beta 缩成右上角小角标，避免在纵向布局里单独占一行 */
.ct {
  position: absolute;
  top: 3px;
  right: 5px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 6px;
  background: var(--primary);
  color: #fff;
  flex-shrink: 0;
}
.ct.run { background: var(--warning-soft); color: var(--warning); }
.ct.warm { background: var(--warning-soft); color: var(--warning); }

.beta-tag {
  position: absolute;
  top: 3px;
  right: 5px;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--warning-soft);
  color: var(--warning);
  flex-shrink: 0;
}

.sep { height: 1px; background: var(--border); margin: 10px 4px; flex-shrink: 0; }

/* ========== 最底部（纵向排列） ========== */
.foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0 0;
  margin-top: 8px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
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
