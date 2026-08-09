<template>
  <div class="projects-view">
    <ProjectWorkbenchView view="all" />
  </div>
</template>

<script setup lang="ts">
import ProjectWorkbenchView from '@/views/ProjectWorkbenchView.vue';
</script>

<style scoped>
.projects-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.projects-view :deep(.coding-workbench) {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>