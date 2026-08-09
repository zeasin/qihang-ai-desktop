<template>
  <div class="chat-home">
    <!-- ========== 顶部视图切换 ========== -->
    <div class="view-tabs">
      <button class="view-tab" :class="{ active: activeView === 'chat' }" @click="activeView = 'chat'">💬 对话</button>
      <button class="view-tab" :class="{ active: activeView === 'kb' }" @click="activeView = 'kb'">📚 知识库</button>
    </div>

    <!-- ========== 对话视图 ========== -->
    <div v-show="activeView === 'chat'" class="chat-body">
    <!-- ========== 左栏：对话列表 ========== -->
    <div class="chat-sidebar">
      <div class="sidebar-header">
        <h3 class="sidebar-title">对话</h3>
        <button class="btn btn-sm btn-primary" @click="newSession">+ 新对话</button>
      </div>

      <div class="conversation-list" v-if="sessions.length" ref="conversationListRef">
        <div
          v-for="session in sessions"
          :key="session.session_id || session.id"
          class="conversation-item"
          :class="{ active: currentSessionId === (session.session_id || String(session.id)) }"
          @click="selectSession(session)"
        >
          <span class="conv-icon">🗨️</span>
          <div class="conv-info">
            <div class="conv-title">{{ session.title || '新对话' }}</div>
            <div class="conv-preview">{{ session.last_message || '' }}</div>
          </div>
          <span class="conv-delete" @click.stop="deleteSession(session.session_id || session.id)" title="删除">×</span>
        </div>
      </div>
      <div v-else class="sidebar-empty">
        <div class="empty-icon">💬</div>
        <div class="empty-text">还没有对话，开始第一个吧</div>
      </div>
    </div>

    <!-- ========== 右栏：对话区 ========== -->
    <div class="chat-main">
      <!-- 无对话时：分步引导 -->
      <div v-if="!currentSessionId && kbLoaded" class="chat-empty">
        <div class="empty-icon">🚀</div>
        <div class="empty-title">欢迎使用启航 AI 工作台</div>
        <div class="empty-desc">首次使用？跟着以下步骤快速上手</div>

        <div class="guide-card">
          <div class="guide-step" :class="{ done: !!defaultKbId }">
            <div class="step-index">{{ defaultKbId ? '✓' : '1' }}</div>
            <div class="step-content">
              <div class="step-title">配置本地笔记库</div>
              <div class="step-desc">
                <template v-if="defaultKbId">笔记库已配置，AI 问答将基于你的笔记进行</template>
                <template v-else>笔记库用于知识检索与 AI 问答，可在设置页随时修改</template>
              </div>
              <button v-if="!defaultKbId" class="btn btn-primary" @click="setupNotesDir">📂 选择笔记库目录</button>
            </div>
          </div>

          <div class="guide-step">
            <div class="step-index">2</div>
            <div class="step-content">
              <div class="step-title">开始第一个对话</div>
              <div class="step-desc">支持 日常问答 · 笔记库检索 · 数据查询 · 图片识别</div>
              <button class="btn btn-primary" @click="newSession">💬 开始对话</button>
            </div>
          </div>

          <div class="guide-step">
            <div class="step-index">3</div>
            <div class="step-content">
              <div class="step-title">探索更多功能</div>
              <div class="step-desc">任务待办 · 数据集管理 · 定时提醒 · AI 工具箱</div>
              <div class="guide-links">
                <router-link to="/planner" class="guide-link">📋 任务</router-link>
                <router-link to="/data" class="guide-link">🗃️ 数据</router-link>
                <router-link to="/reminders" class="guide-link">🔔 提醒</router-link>
                <router-link to="/tools" class="guide-link">🔧 工具箱</router-link>
                <router-link to="/help" class="guide-link">❓ 帮助中心</router-link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 有对话时 -->
      <template v-else>
        <div class="chat-header">
          <div class="chat-header-left">
            <h3 class="chat-title">{{ currentSession?.title || '对话' }}</h3>
          </div>
        </div>

        <div class="chat-messages" ref="messagesContainer">
          <div v-for="(msg, idx) in messages" :key="idx" class="message" :class="msg.role">
            <div class="message-avatar">
              <span v-if="msg.role === 'user'">👤</span>
              <span v-else-if="msg.role === 'tool'">🔧</span>
              <span v-else-if="msg.role === 'system'">⚡</span>
              <span v-else>🤖</span>
            </div>
            <div class="message-content-wrapper">
              <div class="message-bubble">
                <div class="message-header">
                  <span class="message-author">
                    {{ msg.role === 'user' ? '我' : msg.role === 'tool' ? '工具' : msg.role === 'system' ? '系统' : 'AI 助理' }}
                  </span>
                  <span class="message-status" v-if="msg.status">{{ msg.status }}</span>
                </div>
                <div class="message-content" :class="{ 'markdown-body': msg.role === 'assistant' }">
                  <div v-if="thinkingText && idx === messages.length - 1" class="thinking-status">{{ thinkingText }}</div>
                  <div v-if="msg.images?.length" class="message-images">
                    <img v-for="(img, i) in msg.images" :key="i" :src="`data:${img.mimeType};base64,${img.data}`" class="chat-image" />
                  </div>
                  <div v-html="msg.role === 'user' ? formatUserMessage(msg.content) : renderMarkdown(msg.content)"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="chat-input-area">
          <div class="input-wrapper">
            <textarea
              v-model="inputText"
              class="chat-input"
              :placeholder="defaultKbId ? '输入问题，Enter 发送... (已附加笔记库上下文)' : '输入问题，Enter 发送...'"
              @keydown.enter.exact.prevent="sendMessage"
              @paste="handlePaste"
              @compositionstart="composing = true"
              @compositionend="composing = false"
              ref="inputRef"
              :disabled="isStreaming"
              rows="1"
            ></textarea>
            <div v-if="pendingImages.length" class="image-preview-bar">
              <div v-for="(img, i) in pendingImages" :key="i" class="image-preview-item">
                <img :src="`data:${img.mimeType};base64,${img.data}`" class="image-preview-thumb" />
                <button class="image-preview-remove" @click="removeImage(i)">×</button>
              </div>
            </div>
            <div class="input-footer">
              <div class="input-left">
                <button class="toolbar-btn" @click="handleImageClick" title="上传图片">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                </button>
                <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="handleImageUpload" />
                <select class="model-selector" v-model="selectedModel" :disabled="isStreaming" title="选择模型">
                  <option value="">默认模型</option>
                  <option v-for="m in piModels" :key="m.pattern" :value="m.pattern">
                    {{ m.providerLabel }} · {{ m.name }}
                  </option>
                </select>
                <span class="input-hint">Enter 发送 · Shift+Enter 换行 · AI 驱动</span>
              </div>
              <div class="input-right">
                <button
                  class="send-btn"
                  :disabled="(!inputText.trim() && !pendingImages.length) || isStreaming"
                  @click="sendMessage"
                  :title="isStreaming ? '正在处理...' : '发送'"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
    </div>

    <!-- ========== 知识库视图 ========== -->
    <div v-show="activeView === 'kb'" class="chat-body kb-body">
      <NotesView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
const NotesView = defineAsyncComponent(() => import('@/views/NotesView.vue'));

// 配置 marked 以启用换行和 GFM
marked.setOptions({
  breaks: true,
  gfm: true
});

const API = window.electronAPI;
const route = useRoute();

// ========== 状态 ==========
const sessions = ref<any[]>([]);
const currentSessionId = ref('');
const currentSession = ref<any>(null);
const messages = ref<any[]>([]);
const inputText = ref('');
const isStreaming = ref(false);
const composing = ref(false);
const thinkingText = ref('');
const defaultKbId = ref<number | null>(null);
const kbDir = ref('');
const kbLoaded = ref(false);
const inputRef = ref<HTMLTextAreaElement>();
const messagesContainer = ref<HTMLElement>();
const conversationListRef = ref<HTMLElement>();
const pendingImages = ref<{ data: string; mimeType: string }[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);
const piModels = ref<{ provider: string; providerLabel: string; id: string; name: string; pattern: string; configured: boolean }[]>([]);
const selectedModel = ref('');
const modelsLoaded = ref(false);

const CHAT_STATE_KEY = 'chat_home_state';
const CHAT_MODEL_KEY = 'chat_home_model';

const activeView = ref<'chat' | 'kb'>('chat');

// ========== 加载数据 ==========
async function loadKbLibraries() {
  try {
    kbDir.value = await API.kb.getDir();
    defaultKbId.value = kbDir.value ? 1 : null;
  } catch { defaultKbId.value = null; kbDir.value = ''; }
  kbLoaded.value = true;
}

async function loadPiModels() {
  try {
    const res = await API.pi.models();
    piModels.value = (res?.models || []).filter((m) => m.pattern);
    const saved = localStorage.getItem(CHAT_MODEL_KEY);
    if (saved && piModels.value.some((m) => m.pattern === saved)) {
      selectedModel.value = saved;
    } else if (!selectedModel.value && piModels.value.some((m) => m.configured)) {
      // 已配置模型但没有历史选择时，默认选中第一个，降低使用门槛
      const first = piModels.value.find((m) => m.configured);
      if (first) selectedModel.value = first.pattern;
    }
  } catch { piModels.value = []; }
  modelsLoaded.value = true;
}

async function setupNotesDir() {
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir) return;
    const p = await API.kb.setDir(dir);
    await loadKbLibraries();
    await loadSessions();
    await newSession();
  } catch (e: any) {
    alert('配置失败: ' + (e.message || e));
  }
}

async function loadSessions() {
  try {
    const all = await API.chat.getSessionsBySource('ui');
    sessions.value = (all || []).filter((s: any) => s.mode === 'general' || !s.project_id);
  } catch { sessions.value = []; }
}

async function loadMessages(sessionId: string) {
  try {
    const msgs = await API.chat.getMessages(sessionId);
    messages.value = msgs.map((m: any) => ({
      role: m.role,
      content: m.content,
      images: m.images || undefined,
    }));
    for (const m of messages.value) {
      if (m.images && typeof m.images === 'string') {
        try { m.images = JSON.parse(m.images); } catch { m.images = undefined; }
      }
    }
  } catch { messages.value = []; }
  scrollToBottom();
}

// ========== 对话操作 ==========
async function selectSession(session: any) {
  if (isStreaming.value) return;
  currentSessionId.value = session.session_id || String(session.id);
  currentSession.value = session;
  await loadMessages(currentSessionId.value);
  saveState();
}

async function newSession() {
  if (isStreaming.value) return;
  const id = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    const session = await API.chat.createSession(id, null, '新对话', 'general', 'general', 'ui');
    currentSessionId.value = id;
    currentSession.value = session;
    messages.value = [];
    inputText.value = '';
    await loadSessions();
    saveState();
    scrollToActiveConversation();
    nextTick(() => inputRef.value?.focus());
  } catch (e: any) {
    console.error('创建对话失败:', e);
  }
}

async function deleteSession(sessionId: string) {
  if (!confirm('确定删除此对话？')) return;
  try {
    await API.chat.deleteSession(sessionId);
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = '';
      currentSession.value = null;
      messages.value = [];
      localStorage.removeItem(CHAT_STATE_KEY);
    }
    await loadSessions();
  } catch (e: any) {
    console.error('删除失败:', e);
  }
}

// ========== 状态持久化 ==========
function saveState() {
  try {
    localStorage.setItem(CHAT_STATE_KEY, JSON.stringify({ sessionId: currentSessionId.value }));
  } catch (e) {
    console.error('保存对话状态失败:', e);
  }
}

async function restoreState() {
  try {
    const saved = localStorage.getItem(CHAT_STATE_KEY);
    if (!saved) return false;
    const { sessionId } = JSON.parse(saved);
    if (!sessionId) return false;
    const session = sessions.value.find((s) => s.session_id === sessionId || String(s.id) === String(sessionId));
    if (!session) return false;
    currentSessionId.value = session.session_id || String(session.id);
    currentSession.value = session;
    await loadMessages(currentSessionId.value);
    return true;
  } catch { return false; }
}

// ========== 图片处理 ==========
function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        pendingImages.value.push({ data: dataUrl.split(',')[1], mimeType: file.type });
      };
      reader.readAsDataURL(file);
    }
  }
}

function handleImageClick() {
  fileInputRef.value?.click();
}

function handleImageUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files) return;
  for (const file of Array.from(input.files)) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      pendingImages.value.push({ data: dataUrl.split(',')[1], mimeType: file.type });
    };
    reader.readAsDataURL(file);
  }
  input.value = '';
}

function removeImage(index: number) {
  pendingImages.value.splice(index, 1);
}

// ========== 发送消息 ==========
async function sendMessage() {
  const text = inputText.value.trim();
  if ((!text && !pendingImages.value.length) || isStreaming.value) return;

  if (!currentSessionId.value) {
    await newSession();
    nextTick(() => { doSend(text); });
    return;
  }
  doSend(text);
}

async function doSend(text: string) {
  const images = pendingImages.value.map(img => ({ data: img.data, mimeType: img.mimeType }));
  pendingImages.value = [];

  const userMsg: any = { role: 'user', content: text };
  if (images.length) userMsg.images = images;
  messages.value.push(userMsg);

  inputText.value = '';
  autoResizeTextarea();

  const msgIdx = messages.value.length;
  messages.value.push({ role: 'assistant', content: '', status: '准备中...' });

  isStreaming.value = true;
  scrollToBottom();

  const sid = currentSessionId.value;
  const kbIds = defaultKbId.value ? [defaultKbId.value] : undefined;

  API.removeAllListeners('chat:delta');
  API.removeAllListeners('chat:status');
  API.removeAllListeners('chat:tool');
  API.removeAllListeners('chat:done');
  API.removeAllListeners('chat:error');

  const onDelta = (data: { sessionId: string; text: string }) => {
    if (data.sessionId !== sid) return;
    const msg = messages.value[msgIdx];
    if (msg) { msg.content += data.text; msg.status = ''; }
    scrollToBottom();
  };

  const onStatus = (data: { sessionId: string; text: string }) => {
    if (data.sessionId !== sid) return;
    const msg = messages.value[msgIdx];
    if (msg) msg.status = data.text;
  };

  const onTool = (data: { sessionId: string; type: string; name: string; text?: string; error?: boolean }) => {
    if (data.sessionId !== sid) return;
    if (data.type === 'thinking') {
      thinkingText.value = `💭 ${data.text || ''}`;
    } else if (data.type === 'start') {
      thinkingText.value = `🔧 正在执行: ${data.name}`;
    } else if (data.type === 'end') {
      thinkingText.value = `${data.error ? '❌' : '✅'} ${data.name} ${data.error ? '失败' : '完成'}`;
    }
    scrollToBottom();
  };

  const cleanup = () => {
    API.removeAllListeners('chat:delta');
    API.removeAllListeners('chat:status');
    API.removeAllListeners('chat:tool');
    API.removeAllListeners('chat:done');
    API.removeAllListeners('chat:error');
  };

  const onDone = (data: { sessionId: string }) => {
    if (data.sessionId !== sid) return;
    isStreaming.value = false;
    const msg = messages.value[msgIdx];
    if (msg) msg.status = '✓ 完成';
    thinkingText.value = '';
    cleanup();
    loadSessions();
  };

  const onError = (data: { sessionId: string; text: string }) => {
    if (data.sessionId !== sid) return;
    isStreaming.value = false;
    const msg = messages.value[msgIdx];
    if (msg) { msg.content = '❌ ' + data.text; msg.status = '错误'; }
    cleanup();
    scrollToBottom();
  };

  API.on('chat:delta', onDelta);
  API.on('chat:status', onStatus);
  API.on('chat:tool', onTool);
  API.on('chat:done', onDone);
  API.on('chat:error', onError);

  try {
    await API.chat.send(text, sid, kbDir.value, kbIds, images.length ? images : undefined, 'general', selectedModel.value || undefined);
    if (selectedModel.value) localStorage.setItem(CHAT_MODEL_KEY, selectedModel.value);
    else localStorage.removeItem(CHAT_MODEL_KEY);
  } catch (err: any) {
    isStreaming.value = false;
    const msg = messages.value[msgIdx];
    if (msg) msg.content = '❌ ' + (err.message || '发送失败');
    cleanup();
  }
}

// ========== 工具函数 ==========
const renderMarkdown = (content: string) => {
  if (!content) return '';
  try { return marked(content); } catch { return escHtml(content).replace(/\n/g, '<br>'); }
};

const escHtml = (text: string) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

const formatUserMessage = (text: string) => {
  return escHtml(text).replace(/\n/g, '<br>');
};

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
};

const scrollToActiveConversation = () => {
  nextTick(() => {
    if (conversationListRef.value && currentSessionId.value) {
      const activeItem = conversationListRef.value.querySelector('.conversation-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
  });
};

const autoResizeTextarea = () => {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto';
    inputRef.value.style.height = Math.min(inputRef.value.scrollHeight, 120) + 'px';
  }
};

// ========== 生命周期 ==========
onMounted(async () => {
  await Promise.all([loadKbLibraries(), loadSessions(), loadPiModels()]);
  
  // 尝试恢复上次的会话状态
  const restored = await restoreState();
  
  if (restored) {
    // 恢复成功，滚动到已恢复的会话
    scrollToActiveConversation();
  } else if (sessions.value.length > 0) {
    // 如果没有恢复到上次状态，但有会话存在，自动选择最新的会话（最后一条）
    await selectSession(sessions.value[sessions.value.length - 1]);
    scrollToActiveConversation();
  }
  
  // 工具箱跳转：?prompt= 预填输入框
  const qp = route.query.prompt;
  if (typeof qp === 'string' && qp.trim()) {
    inputText.value = qp.trim();
    nextTick(() => inputRef.value?.focus());
  }
});

onBeforeUnmount(() => {
  API.removeAllListeners('chat:delta');
  API.removeAllListeners('chat:status');
  API.removeAllListeners('chat:tool');
  API.removeAllListeners('chat:done');
  API.removeAllListeners('chat:error');
});
</script>

<style scoped>
.chat-home {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-main);
}

/* ========== 顶部视图切换 ========== */
.view-tabs {
  display: flex;
  border-bottom: 1px solid #e8ecf1;
  background: white;
  flex-shrink: 0;
  padding: 0 16px;
  gap: 4px;
}

.view-tab {
  padding: 10px 20px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  border: none;
  background: none;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  border-radius: 0;
}

.view-tab:hover {
  color: var(--text-primary);
  background: var(--hover);
}

.view-tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.kb-body {
  background: white;
}

.kb-body :deep(.notes-view) {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ========== 左栏 ========== */
.chat-sidebar {
  width: 280px;
  min-width: 280px;
  background: #f8fafc;
  border-right: 1px solid #e8ecf1;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid #e8ecf1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: white;
}

.sidebar-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.conversation-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  border-radius: 10px;
  margin-bottom: 4px;
}

.conversation-item:hover {
  background: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  transform: translateX(2px);
}

.conversation-item.active {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(139, 92, 246, 0.08));
  border-left: 3px solid var(--primary);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.1);
}

.conv-icon {
  font-size: 14px;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.1);
  border-radius: 6px;
}

.conv-info {
  flex: 1;
  overflow: hidden;
  min-width: 0;
}

.conv-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-preview {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 3px;
}

.conv-delete {
  font-size: 16px;
  color: var(--text-muted);
  cursor: pointer;
  visibility: hidden;
  width: 24px;
  height: 24px;
  text-align: center;
  border-radius: 6px;
  flex-shrink: 0;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.conversation-item:hover .conv-delete {
  visibility: visible;
}

.conv-delete:hover {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
  transform: scale(1.1);
}

.sidebar-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
  gap: 8px;
}

.sidebar-empty .empty-icon {
  font-size: 32px;
  opacity: 0.3;
}

.sidebar-empty .empty-text {
  font-size: 13px;
  color: var(--text-muted);
}

/* ========== 右栏 ========== */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #ffffff;
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 60px 20px;
  gap: 16px;
  background: linear-gradient(135deg, #fafbfc 0%, #ffffff 50%, #f8fafc 100%);
}

.chat-empty .empty-icon {
  font-size: 72px;
  opacity: 0.4;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.1));
}

.chat-empty .empty-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 8px;
}

.chat-empty .empty-desc {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.btn-lg {
  padding: 12px 28px;
  font-size: 15px;
  border-radius: 12px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
  transition: all 0.2s;
}

.btn-lg:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
}

/* ========== 空状态引导卡 ========== */
.guide-card {
  width: 520px;
  max-width: 100%;
  background: white;
  border: 1px solid #e8ecf1;
  border-radius: 16px;
  padding: 8px 24px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
  text-align: left;
}

.guide-step {
  display: flex;
  gap: 14px;
  padding: 16px 0;
  border-bottom: 1px solid #f1f5f9;
}

.guide-step:last-child {
  border-bottom: none;
}

.step-index {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
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
  margin-bottom: 4px;
}

.step-desc {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.guide-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.guide-link {
  font-size: 12px;
  color: var(--primary);
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.2);
  padding: 5px 12px;
  border-radius: 20px;
  text-decoration: none;
  transition: all 0.15s;
}

.guide-link:hover {
  background: var(--primary);
  color: white;
}


.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid #e8ecf1;
  background: white;
  flex-shrink: 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.chat-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  scroll-behavior: smooth;
}

/* ========== 消息样式 ========== */
.message {
  display: flex;
  gap: 12px;
  max-width: 100%;
  animation: fadeInUp 0.3s ease-out;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.assistant {
  align-items: flex-start;
}

.message.user {
  flex-direction: row-reverse;
}

.message.user .message-content-wrapper {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--hover);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.message.user .message-avatar {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.1));
}

.message.assistant .message-avatar {
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.12), rgba(99, 102, 241, 0.08));
}

.message-content-wrapper {
  flex: 1;
  min-width: 0;
  max-width: 85%;
}

.message.user .message-content-wrapper {
  max-width: 70%;
}

.message-bubble {
  position: relative;
}

.message.assistant .message-bubble {
  background: white;
  border: 1px solid #e8ecf1;
  border-radius: 16px;
  padding: 16px 20px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
}

.message.user .message-bubble {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  border-radius: 16px;
  padding: 12px 18px;
  color: white;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.2);
}

.message.tool .message-bubble,
.message.system .message-bubble {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 16px;
}

.message.user .message-bubble .message-content {
  color: white;
}

.message.user .message-bubble .message-header {
  justify-content: flex-end;
}

.message.user .message-bubble .message-author {
  color: rgba(255, 255, 255, 0.85);
}

.message.user .message-bubble .message-status {
  color: rgba(255, 255, 255, 0.65);
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.message-author {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.message-status {
  font-size: 11px;
  color: var(--text-muted);
}

.message-content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
}

.thinking-status {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 10px;
  padding: 8px 12px;
  background: rgba(99, 102, 241, 0.06);
  border-radius: 8px;
  display: inline-block;
}

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.chat-image {
  max-width: 300px;
  max-height: 300px;
  border-radius: 12px;
  border: 1px solid var(--border);
  object-fit: contain;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: transform 0.2s;
}

.chat-image:hover {
  transform: scale(1.02);
}

/* ========== 输入区 ========== */
.chat-input-area {
  padding: 16px 24px 20px;
  border-top: 1px solid #e8ecf1;
  background: linear-gradient(to top, #ffffff, #fafbfc);
  flex-shrink: 0;
}

.input-wrapper {
  max-width: 900px;
  margin: 0 auto;
  border: 2px solid transparent;
  border-radius: 18px;
  background: white;
  padding: 14px 18px;
  transition: all 0.25s ease;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04), 0 0 0 1px #e8ecf1;
}

.input-wrapper:focus-within {
  border-color: var(--primary);
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.12), 0 0 0 4px rgba(99, 102, 241, 0.08);
}

.chat-input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-primary);
  background: transparent;
  max-height: 150px;
  font-family: inherit;
}

.chat-input::placeholder {
  color: var(--text-muted);
}

.image-preview-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 10px;
}

.image-preview-item {
  position: relative;
}

.image-preview-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--border);
}

.image-preview-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid white;
  background: var(--danger);
  color: white;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s;
}

.image-preview-remove:hover {
  transform: scale(1.1);
}

.input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
  margin-top: 4px;
}

.input-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  transition: all 0.2s;
}

.toolbar-btn:hover {
  color: var(--primary);
  background: rgba(99, 102, 241, 0.08);
  transform: scale(1.05);
}

.model-selector {
  font-size: 12px;
  padding: 5px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  color: var(--text-primary);
  max-width: 180px;
  outline: none;
  cursor: pointer;
  transition: all 0.2s;
}

.model-selector:hover {
  border-color: var(--primary);
  background: white;
}

.input-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.send-btn {
  border: none;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: white;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
}

.send-btn:hover:not(:disabled) {
  transform: scale(1.05);
  box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
}

.send-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}
</style>
