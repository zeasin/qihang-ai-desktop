<template>
  <div class="welcome-overlay">
    <div class="welcome-modal">
      <div class="welcome-header">
        <img class="welcome-logo" src="../assets/app-icon.png" alt="启航 AI 工作台" />
        <h1 class="welcome-title">欢迎使用启航 AI 工作台</h1>
        <p class="welcome-subtitle">首次使用？跟着以下步骤，3 分钟快速上手</p>
      </div>

      <div class="welcome-body">
        <!-- 步骤 1：配置对话大模型 -->
        <div class="guide-step" :class="{ done: llmReady }">
          <div class="step-index">1</div>
          <div class="step-content">
            <div class="step-title">
              配置 AI 对话大模型
              <span class="step-status" v-if="llmReady">✓ 已就绪</span>
            </div>
            <p class="step-desc">所有 AI 对话、工具调用、日报生成都由大模型驱动，无需安装任何终端工具。在「设置」页填写接入点信息即可（OpenAI 兼容接口，如 DeepSeek、Ollama 等）：</p>
            <button class="btn btn-sm btn-primary" @click="go('/config')">⚙️ 前往「设置」配置大模型</button>
            <p class="step-desc" style="margin-top:8px;">配置后应用自动识别，立即生效。也可随时在「设置 → 💬 对话模型配置」修改或添加多个接入点。</p>
          </div>
        </div>

        <!-- 步骤 2：添加项目 -->
        <div class="guide-step" :class="{ done: kbCount > 0 }">
          <div class="step-index">2</div>
          <div class="step-content">
            <div class="step-title">
              添加项目
              <span class="step-status" v-if="kbCount > 0">✓ 已有 {{ kbCount }} 个</span>
            </div>
            <p class="step-desc">项目就是本地目录，是本应用所有 AI 功能的数据基础，可添加多个；一个都没有时 AI 对话、任务执行、知识库浏览均不可用。选择一个本地文件夹即可添加，之后在「设置」页统一管理。</p>
            <button class="btn btn-sm btn-primary" @click="setupNotesDir" :disabled="kbDirLoading">
              {{ kbDirLoading ? '正在添加...' : '📂 选择文件夹添加项目' }}
            </button>
            <p class="step-path" v-if="kbDir">{{ kbDir }}</p>
          </div>
        </div>

        <!-- 步骤 3：认识各功能页 -->
        <div class="guide-step">
          <div class="step-index">3</div>
          <div class="step-content">
            <div class="step-title">认识各功能页</div>
            <p class="step-desc">所有数据保存在本机，模型自由选择。点击即可前往对应页面：</p>
            <div class="page-grid">
              <a v-for="p in pages" :key="p.path" class="page-item" :href="'#' + p.path" @click.prevent="go(p.path)">
                <span class="page-icon">{{ p.icon }}</span>
                <span class="page-label">{{ p.label }}</span>
              </a>
            </div>
          </div>
        </div>
      </div>

      <div class="welcome-footer">
        <span class="welcome-hint">完整指南可在左下角「帮助」随时查看</span>
        <button class="btn btn-primary" @click="finish">开始使用</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';

const API = window.electronAPI;
const router = useRouter();

const emit = defineEmits<{ (e: 'close'): void }>();

const kbDir = ref('');
const kbCount = ref(0);
const kbDirLoading = ref(false);
const llmReady = ref(false);

const pages = [
  { path: '/chat', icon: '💬', label: 'AI 对话' },
  { path: '/planner', icon: '📋', label: '任务' },
  { path: '/data', icon: '🗃️', label: '数据' },
  { path: '/reminders', icon: '🔔', label: '提醒' },
  { path: '/tools', icon: '🔧', label: '工具箱' },
  { path: '/config', icon: '⚙️', label: '设置' },
  { path: '/log', icon: '📋', label: '日志' },
  { path: '/help', icon: '❓', label: '帮助中心' },
];

async function setupNotesDir() {
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir) return;
    kbDirLoading.value = true;
    let r: any = null;
    if (kbCount.value === 0) {
      await API.kb.setDir(dir); // 首个库：创建并设为默认
    } else {
      r = await API.kb.add('', dir); // 已有库：追加新库
      if (r && r.error) { alert('添加失败: ' + r.error); return; }
    }
    kbDir.value = dir;
    await refreshKb();
  } catch (e: any) {
    alert('配置失败: ' + (e.message || e));
  } finally {
    kbDirLoading.value = false;
  }
}

async function refreshKb() {
  try {
    const libs = (await API.kb.list()) || [];
    kbCount.value = libs.length;
    kbDir.value = (libs.find((l: any) => l.isDefault) || libs[0])?.dir || '';
  } catch { kbCount.value = 0; kbDir.value = ''; }
}

function go(path: string) {
  router.push(path);
  finish();
}

async function finish() {
  try { await API.app.firstRunDone(); } catch { /* ignore */ }
  emit('close');
}

onMounted(async () => {
  await refreshKb();
  try {
    const cfg = await API.pi.configGet().catch(() => ({ providers: [] }));
    llmReady.value = !!(cfg && Array.isArray(cfg.providers) && cfg.providers.length);
  } catch { /* ignore */ }
});
</script>

<style scoped>
.welcome-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.welcome-modal {
  width: 640px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  background: var(--surface);
  border-radius: 20px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.25s ease-out;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

.welcome-header {
  text-align: center;
  padding: 28px 32px 20px;
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
  color: white;
  flex-shrink: 0;
}

.welcome-logo {
  width: 56px;
  height: 56px;
  display: block;
  margin: 0 auto 10px;
  border-radius: 13px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}

.welcome-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 6px;
}

.welcome-subtitle {
  font-size: 13px;
  opacity: 0.9;
  margin: 0;
}

.welcome-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 28px 8px;
}

.guide-step {
  display: flex;
  gap: 14px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}

.guide-step:last-child {
  border-bottom: none;
}

.step-index {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--primary);
  color: white;
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.guide-step.done .step-index {
  background: var(--success);
}

.step-content {
  flex: 1;
  min-width: 0;
}

.step-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-status {
  font-size: 11px;
  font-weight: 500;
  color: var(--success);
  background: var(--success-soft);
  border: 1px solid var(--success-soft);
  padding: 1px 8px;
  border-radius: 20px;
}

.step-desc {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
  margin: 0 0 8px;
}

.step-desc code {
  font-size: 11px;
  background: var(--hover);
  padding: 1px 6px;
  border-radius: 4px;
}

.step-code {
  background: #1e1e2e;
  color: #cdd6f4;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 0 0 8px;
  user-select: text;
}

.step-path {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  word-break: break-all;
}

.page-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.page-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  text-decoration: none;
  color: var(--text-primary);
  transition: all 0.15s;
}

.page-item:hover {
  border-color: var(--primary);
  background: rgba(var(--primary-rgb), 0.06);
  color: var(--primary);
}

.page-icon {
  font-size: 20px;
}

.page-label {
  font-size: 11px;
  font-weight: 500;
}

.welcome-footer {
  padding: 14px 28px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  background: var(--surface-2);
}

.welcome-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.welcome-footer .btn-primary {
  padding: 9px 28px;
  font-size: 14px;
}
</style>
