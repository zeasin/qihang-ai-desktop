<template>
  <div class="app-root">
    <div
      v-if="isElectron"
      class="titlebar"
      :class="{ 'is-mac': isMac }"
      @dblclick="onTitlebarDblclick"
    >
      <template v-if="!isMac">
        <div class="tb-brand">
          <span class="tb-mark"><AppIcon name="sailboat" :size="15" /></span>
          <span class="tb-text"><b>启航</b><small>AI 工作台</small></span>
        </div>
        <div class="tb-spacer"></div>
        <router-link to="/help" class="tb-link" title="帮助">
          <AppIcon name="circle-help" :size="15" />
        </router-link>
        <div class="tb-controls">
          <button class="tb-btn" title="最小化" @click="minimizeWindow">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1" /></svg>
          </button>
          <button class="tb-btn" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize">
            <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" /></svg>
            <svg v-else width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" />
              <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" stroke-width="1" />
            </svg>
          </button>
          <button class="tb-btn close" title="关闭" @click="closeWindow">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" /></svg>
          </button>
        </div>
      </template>
    </div>
    <div class="app-container">
      <AppSidebar />
      <main class="main-content">
        <router-view />
      </main>
    </div>
    <WelcomeGuide v-if="showWelcome" @close="showWelcome = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import AppSidebar from './components/AppSidebar.vue';
import AppIcon from './components/AppIcon.vue';
import WelcomeGuide from './components/WelcomeGuide.vue';
import { initTheme } from './composables/theme';

const isMac = window.electronAPI ? window.electronAPI.platform === 'darwin' : false;
const isElectron = !!window.electronAPI;
const isMaximized = ref(false);
const showWelcome = ref(false);

initTheme();

function minimizeWindow() { window.electronAPI?.win.minimize(); }
async function toggleMaximize() { await window.electronAPI?.win.toggleMaximize(); }
function closeWindow() { window.electronAPI?.win.close(); }
function onTitlebarDblclick() { if (!isMac) toggleMaximize(); }

onMounted(async () => {
  if (isElectron && !isMac) {
    try { isMaximized.value = await window.electronAPI.win.isMaximized(); } catch {}
    window.electronAPI.on('win:maximized', (v: boolean) => { isMaximized.value = !!v; });
  }
  try {
    const res = await window.electronAPI.app.firstRun();
    showWelcome.value = !!(res && res.firstRun);
  } catch { showWelcome.value = false; }
});
</script>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.titlebar {
  flex-shrink: 0;
  height: 38px;
  background: var(--bg-sidebar);
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
  display: flex;
  align-items: center;
}

/* 品牌区（从侧栏上移，样式与侧栏 brand 保持一致；左缩进对齐侧栏：10px 侧栏内边距 + 6px 品牌内边距） */
.tb-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-left: 16px;
  flex-shrink: 0;
}

.tb-mark {
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

.tb-text b { display: block; font-size: 13px; font-weight: 600; line-height: 1.25; color: var(--text-primary); }
.tb-text small { display: block; font-size: 11px; color: var(--text-muted); line-height: 1.3; }

.tb-spacer {
  flex: 1;
  height: 100%;
}

/* 帮助入口（从侧栏底部上移，位于窗口按钮左侧） */
.tb-link {
  width: 36px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  -webkit-app-region: no-drag;
}

.tb-link:hover {
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-primary);
}

/* 顶栏图标类控件不需要焦点外框（点击后会残留一圈系统强调色描边） */
.tb-link:focus,
.tb-link:focus-visible,
.tb-btn:focus,
.tb-btn:focus-visible {
  outline: none;
}

.tb-controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.tb-btn {
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.tb-btn:hover {
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-primary);
}

.tb-btn.close:hover {
  background: #e81123;
  color: #fff;
}

.app-container {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.main-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
