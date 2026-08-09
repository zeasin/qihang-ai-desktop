<template>
  <div class="app-root">
    <div v-if="isMac" class="mac-titlebar"></div>
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
import WelcomeGuide from './components/WelcomeGuide.vue';

const isMac = window.electronAPI ? window.electronAPI.platform === 'darwin' : false;
const showWelcome = ref(false);

onMounted(async () => {
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

.mac-titlebar {
  flex-shrink: 0;
  height: 38px;
  background: var(--bg-sidebar);
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
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
