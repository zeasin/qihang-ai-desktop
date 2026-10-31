<!--
  AppSidebar —— 全新固定左右结构外壳（宽导航版）
  结构：品牌区 → 默认项目切换 → 引擎状态 → 主导航（今天/对话/任务/待办/笔记/数据）
        → 次级导航（技能/设置）→ 底部（运行日志/帮助/主题切换）
-->
<template>
  <aside class="sidebar">
    <!-- 品牌区 -->
    <div class="brand">
      <span class="brand-mark"><AppIcon name="sailboat" :size="15" /></span>
      <span class="brand-text"><b>启航</b><small>AI 工作台</small></span>
    </div>

    <!-- 默认项目切换 -->
    <div v-if="projects.length" class="pop-wrap">
      <button class="proj-btn" title="切换默认项目" @click.stop="projOpen = !projOpen">
        <span class="proj-text"><small>默认项目</small><b>{{ defaultName }}</b></span>
        <AppIcon name="chevrons-up-down" :size="13" class="proj-caret" />
      </button>
      <div v-if="projOpen" class="pop proj-pop" @click.stop>
        <div class="pop-label">切换默认项目</div>
        <button
          v-for="p in projects"
          :key="p.id"
          class="pop-item"
          :class="{ on: p.id === defaultId }"
          @click="chooseDefault(p)"
        >
          <span class="mini"></span>
          <span class="pop-item-name">{{ p.name }}</span>
          <small v-if="p.is_default">默认</small>
        </button>
        <div class="pop-sep"></div>
        <router-link class="pop-item" to="/config" @click="projOpen = false">
          <AppIcon name="settings" :size="13" />
          <span class="pop-item-name">管理项目…</span>
        </router-link>
      </div>
    </div>

    <!-- 引擎状态 -->
    <div class="pop-wrap">
      <button class="engine-chip" title="引擎与服务状态" @click.stop="engOpen = !engOpen">
        <span class="status-dot pulse" :class="services.scheduler ? 'ok' : 'idle'"></span>
        <span class="engine-text">{{ engineText }}</span>
        <AppIcon name="chevron-right" :size="12" class="engine-caret" />
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

    <!-- 主导航 -->
    <nav class="nav">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ active: isActive(item.path) }"
      >
        <AppIcon :name="item.icon" :size="15" />
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.badge" class="ct" :class="item.badgeClass">{{ item.badge }}</span>
      </router-link>
    </nav>

    <!-- 次级导航 -->
    <nav class="nav nav2">
      <router-link to="/tools" class="nav-item" :class="{ active: isActive('/tools') }">
        <AppIcon name="sparkles" :size="15" />
        <span class="nav-label">技能</span>
        <span class="beta-tag">beta</span>
      </router-link>
      <router-link to="/config" class="nav-item" :class="{ active: isActive('/config') }">
        <AppIcon name="settings" :size="15" />
        <span class="nav-label">设置</span>
      </router-link>
    </nav>

    <!-- 底部 -->
    <div class="foot">
      <router-link to="/log" class="foot-link" title="运行日志"><AppIcon name="terminal" :size="15" /></router-link>
      <router-link to="/help" class="foot-link" title="帮助"><AppIcon name="circle-help" :size="15" /></router-link>
      <span class="foot-sp"></span>
      <button class="foot-link" :title="isDark ? '切换到浅色模式' : '切换到暗色模式'" @click="toggleTheme">
        <AppIcon :name="isDark ? 'sun' : 'moon'" :size="15" />
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { toggleTheme, useTheme } from '../composables/theme';

const API = window.electronAPI;
const route = useRoute();
const isDark = useTheme();

// ========== 导航 ==========
const navItems = computed(() => [
  { path: '/overview', label: '今天', icon: 'sun', badge: 0, badgeClass: '' },
  { path: '/chat', label: '对话', icon: 'message-square', badge: 0, badgeClass: '' },
  { path: '/planner', label: '任务', icon: 'workflow', badge: taskRunning.value, badgeClass: 'run' },
  { path: '/reminders', label: '待办', icon: 'list-checks', badge: todoOpen.value, badgeClass: '' },
  { path: '/notes', label: '笔记', icon: 'library', badge: 0, badgeClass: '' },
  { path: '/data', label: '数据', icon: 'database', badge: pendingCount.value, badgeClass: 'warm' },
]);

const isActive = (path: string) => {
  if (path === '/planner' && route.path.startsWith('/task/')) return true;
  return route.path === path || route.path.startsWith(path + '/');
};

// ========== 默认项目 ==========
const projects = ref<any[]>([]);
const defaultId = ref<number | null>(null);
const defaultName = computed(() => {
  const d = projects.value.find((p) => p.id === defaultId.value);
  return d ? d.name : '未设置';
});
const projOpen = ref(false);

async function loadProjects() {
  try {
    projects.value = (await API.kb.list()) || [];
  } catch { projects.value = []; }
  try {
    const d = await API.kb.getDefault();
    defaultId.value = d && d.id != null ? d.id : null;
  } catch { defaultId.value = null; }
}

async function chooseDefault(p: any) {
  projOpen.value = false;
  if (p.id === defaultId.value) return;
  try {
    await API.kb.setDefault(p.id);
    defaultId.value = p.id;
  } catch {}
}

// ========== 引擎状态 ==========
const services = ref({ feishu: false, scheduler: false });
const engineText = computed(() => (services.value.scheduler ? '引擎就绪' : '引擎待机'));
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
}

function onDocClick() {
  projOpen.value = false;
  engOpen.value = false;
}

onMounted(() => {
  loadProjects();
  refreshAll();
  timer = window.setInterval(refreshAll, 60_000);
  document.addEventListener('click', onDocClick);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  document.removeEventListener('click', onDocClick);
});

watch(() => route.path, () => {
  projOpen.value = false;
  engOpen.value = false;
});
</script>

<style scoped>
.sidebar {
  width: 216px;
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 12px 10px 10px;
  overflow: visible;
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

/* ========== 弹出层通用 ========== */
.pop-wrap { position: relative; }
.pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 60;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 8px;
}
.pop-label { font-size: 11px; color: var(--text-muted); padding: 4px 8px 6px; letter-spacing: 0.05em; }
.pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-primary);
  text-decoration: none;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
}
.pop-item:hover { background: var(--hover); }
.pop-item.on { color: var(--primary); font-weight: 600; }
.pop-item small { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.pop-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini { width: 8px; height: 8px; border-radius: 3px; background: var(--primary); flex-shrink: 0; }
.pop-sep { height: 1px; background: var(--border); margin: 6px 4px; }
.pop-more {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--primary);
  margin: 8px 4px 2px;
  text-decoration: none;
}

/* ========== 项目切换 ========== */
.proj-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s;
}
.proj-btn:hover { border-color: var(--text-muted); }
.proj-text { flex: 1; min-width: 0; text-align: left; }
.proj-text small { display: block; font-size: 11px; color: var(--text-muted); line-height: 1.3; }
.proj-text b { display: block; font-size: 12.5px; font-weight: 600; line-height: 1.3; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proj-caret { color: var(--text-muted); flex-shrink: 0; }

/* ========== 引擎状态 ========== */
.engine-chip {
  margin-top: 8px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border-radius: 7px;
  border: none;
  background: none;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.engine-chip:hover { background: var(--primary-soft); color: var(--text-primary); }
.engine-text { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; }
.engine-caret { color: var(--text-muted); flex-shrink: 0; }

.eng-pop { width: 224px; right: auto; }
.svc {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 5px 8px;
}
.svc b { display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 11.5px; color: var(--text-primary); }

/* ========== 导航 ========== */
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 12px;
}
.nav2 {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--hover); color: var(--text-primary); }
.nav-item.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.nav-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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

/* ========== 底部 ========== */
.foot {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 2px 0;
  margin-top: 8px;
  border-top: 1px solid var(--border);
}
.foot-sp { flex: 1; }
.foot-link {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
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
