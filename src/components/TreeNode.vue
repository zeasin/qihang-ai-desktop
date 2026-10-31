<template>
  <div class="tree-node">
    <div
      class="tree-row"
      :class="{ active: isActive, 'is-folder': node.type === 'folder' }"
      :style="{ paddingLeft: 12 + depth * 16 + 'px' }"
      @click="handleClick"
    >
      <span v-if="node.type === 'folder'" class="toggle" @click.stop="toggle">
        {{ expanded ? '▼' : '▶' }}
      </span>
      <span v-else class="toggle-placeholder"></span>
      <span class="icon">{{ node.type === 'folder' ? (expanded ? '📂' : '📁') : '📄' }}</span>
      <span class="name" :title="node.name">{{ node.name }}</span>
    </div>
    <div v-if="node.type === 'folder' && expanded" class="tree-children">
      <div v-if="loading" class="loading-row">
        <span class="loading-spinner"></span>
        <span>加载中...</span>
      </div>
      <div v-else-if="children.length === 0" class="loading-row empty-row">
        <span>空文件夹</span>
      </div>
      <TreeNode
        v-for="child in children"
        v-else
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :kb-id="kbId"
        @select="(n: TreeNode) => emit('select', n)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  node: TreeNode;
  depth: number;
  kbId?: string;
}>();

const emit = defineEmits<{
  select: [node: TreeNode];
}>();

const expanded = ref(false);
const children = ref<TreeNode[]>([]);
const loaded = ref(false);
const loading = ref(false);

const isActive = ref(false);

async function loadChildren() {
  if (loaded.value) return;
  if (props.node.type !== 'folder') return;
  loading.value = true;
  try {
    children.value = await (window as any).electronAPI?.notes?.treeChildren(props.node.path) || [];
    loaded.value = true;
  } catch (e) {
    console.warn('加载子目录失败:', e);
  }
  loading.value = false;
}

async function toggle() {
  if (!expanded.value) {
    await loadChildren();
  }
  expanded.value = !expanded.value;
}

function handleClick() {
  if (props.node.type === 'folder') {
    toggle();
  }
  emit('select', props.node);
}
</script>

<style scoped>
.tree-node {
  user-select: none;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 4px;
  margin: 0 4px;
  white-space: nowrap;
  overflow: hidden;
  transition: background 0.1s;
}
.tree-row:hover {
  background: var(--hover);
}
.tree-row.active {
  background: rgba(var(--primary-rgb), 0.08);
  color: var(--primary);
}

.toggle {
  font-size: 10px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.15s;
}
.toggle-placeholder {
  width: 14px;
  flex-shrink: 0;
}

.icon {
  font-size: 14px;
  flex-shrink: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-children {
  /* indent handled by paddingLeft on tree-row */
}

.loading-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 28px;
  font-size: 12px;
  color: var(--text-muted);
}
.loading-row.empty-row {
  padding-left: 28px;
}

.loading-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
