<template>
  <div class="welcome-overlay">
    <div class="welcome-modal">
      <div class="welcome-header">
        <div class="welcome-logo">🚀</div>
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

        <!-- 步骤 2：设置笔记库 -->
        <div class="guide-step" :class="{ done: kbDir }">
          <div class="step-index">2</div>
          <div class="step-content">
            <div class="step-title">
              设置笔记库目录
              <span class="step-status" v-if="kbDir">✓ 已配置</span>
            </div>
            <p class="step-desc">笔记库是本应用所有 AI 功能的数据基础，未配置时 AI 对话、任务执行、日报生成、知识库浏览均不可用。选择一个包含 Markdown 文件的本地文件夹，让 AI 基于你的笔记工作。</p>
            <button class="btn btn-sm btn-primary" @click="setupNotesDir" :disabled="kbDirLoading">
              {{ kbDirLoading ? '正在保存...' : kbDir ? '重新选择目录' : '📂 选择笔记库目录' }}
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
    await API.kb.setDir(dir);
    kbDir.value = dir;
  } catch (e: any) {
    alert('配置失败: ' + (e.message || e));
  } finally {
    kbDirLoading.value = false;
  }
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
  try {
    const [dir, cfg] = await Promise.all([
      API.kb.getDir().catch(() => ''),
      API.pi.configGet().catch(() => ({ providers: [] })),
    ]);
    kbDir.value = dir || '';
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
  background: white;
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
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: white;
  flex-shrink: 0;
}

.welcome-logo {
  font-size: 40px;
  margin-bottom: 8px;
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
  background: #16a34a;
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
  color: #16a34a;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
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
  background: #f5f5f7;
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
  background: rgba(99, 102, 241, 0.06);
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
  background: #fafbfc;
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
