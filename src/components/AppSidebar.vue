<template>
  <aside class="sidebar">
    <nav class="nav-menu">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ active: isActive(item.path) }"
        :title="item.label"
      >
        <span v-if="item.beta" class="beta-tag">beta</span>
        <span class="nav-icon" v-html="item.icon"></span>
        <span class="nav-label">{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="sidebar-footer">
      <div class="footer-divider"></div>
      <router-link to="/config" class="nav-item" :class="{ active: isActive('/config') }" title="设置">
        <span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
        <span class="nav-label">设置</span>
      </router-link>
      <router-link to="/log" class="nav-item" :class="{ active: isActive('/log') }" title="日志">
        <span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>
        <span class="nav-label">日志</span>
      </router-link>
      <router-link to="/help" class="nav-item" :class="{ active: isActive('/help') }" title="帮助">
        <span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>
        <span class="nav-label">帮助</span>
      </router-link>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();

const navItems = [
  {
    path: '/overview',
    label: '概览',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
  },
  {
    path: '/chat',
    label: '对话',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  },
  {
    path: '/planner',
    label: '任务',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
  },
  {
    path: '/data',
    label: '数据',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>'
  },
  {
    path: '/projects',
    label: '项目',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
  },
  {
    path: '/reminders',
    label: '提醒',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
  },
];

const isActive = (path: string) => {
  if (path === '/planner' && route.path.startsWith('/task/')) return true;
  return route.path === path || route.path.startsWith(path + '/');
};
</script>

<style scoped>
.sidebar {
  width: 68px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.nav-menu {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 4px;
  overflow-y: auto;
}

.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 2px 6px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 10px;
  transition: all 0.15s;
  border-radius: var(--radius-sm);
  text-decoration: none;
  line-height: 1.2;
}

.beta-tag {
  position: absolute;
  top: 3px;
  right: 2px;
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: #f59e0b;
  color: #fff;
  letter-spacing: 0.3px;
  transform: rotate(8deg);
}

.nav-item:hover {
  background: var(--hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: rgba(99, 102, 241, 0.1);
  color: var(--primary);
}

.nav-item.active .nav-icon :deep(svg) {
  stroke: var(--primary);
}

.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-icon :deep(svg) {
  width: 22px;
  height: 22px;
}

.nav-item:hover .nav-icon :deep(svg) {
  stroke-width: 2.2;
}

.nav-label {
  font-size: 10px;
  text-align: center;
  white-space: nowrap;
}

.nav-item:active {
  transform: scale(0.96);
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-top: 1px solid var(--border);
}

.sidebar-footer .nav-item:hover {
  background: rgba(99, 102, 241, 0.05);
  color: var(--primary);
}

.footer-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 8px;
}
</style>
