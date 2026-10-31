<template>
  <div class="chat-home">
    <!-- ========== 对话视图 ========== -->
    <div class="chat-body">
    <!-- ========== 左栏：对话列表 ========== -->
    <div class="chat-sidebar">
      <div class="sidebar-header">
        <h3 class="sidebar-title">对话</h3>
        <button class="btn btn-sm btn-primary" @click="newSession()">+ 新对话</button>
      </div>

      <div class="conversation-groups" v-if="sessions.length || workProjects.length" ref="conversationListRef">
        <div v-for="group in convGroups" :key="group.key" class="conv-group">
          <div
            class="conv-group-header"
            :class="{ current: groupIsCurrent(group) }"
            :title="group.project ? (group.project.dir || group.project.name) + ' · 点击折叠/展开' : '未绑定项目的对话'"
            @click="toggleGroup(group.key)"
          >
            <span class="group-arrow" :class="{ collapsed: isGroupCollapsed(group.key) }">▾</span>
            <span class="group-icon">{{ group.project ? '📁' : '💬' }}</span>
            <span class="group-name">{{ group.project ? group.project.name : '未分组' }}</span>
            <span class="group-count">{{ group.sessions.length }}</span>
            <button
              v-if="group.project"
              class="group-add"
              title="在此项目下新建对话"
              @click.stop="newSession(group.project.id)"
            >＋</button>
          </div>

          <div v-show="!isGroupCollapsed(group.key)" class="conversation-list">
            <div
              v-for="session in group.sessions"
              :key="session.session_id || session.id"
              class="conversation-item"
              :class="{ active: currentSessionId === (session.session_id || String(session.id)) }"
              @click="selectSession(session)"
            >
              <span class="conv-icon">{{ runningSessionIds.has(session.session_id || String(session.id)) ? '⏳' : '🗨️' }}</span>
              <div class="conv-info">
                <div class="conv-title">{{ session.title || '新对话' }}</div>
                <div class="conv-preview">{{ session.last_message || '' }}</div>
              </div>
              <span class="conv-delete" @click.stop="deleteSession(session.session_id || session.id)" title="删除">×</span>
            </div>
            <div v-if="!group.sessions.length" class="group-empty">暂无对话</div>
          </div>
        </div>
      </div>
      <div v-else class="sidebar-empty">
        <div class="empty-icon">💬</div>
        <div class="empty-text">还没有对话，开始第一个吧</div>
      </div>
    </div>

    <!-- ========== 右栏：对话区 ========== -->
    <div class="chat-main">
      <!-- 未添加项目：AI 功能门禁 -->
      <NotesGate v-if="kbLoaded && !kbLibraries.length" @ready="onGateReady" />

      <!-- 无对话时：分步引导 -->
      <div v-else-if="!currentSessionId && kbLoaded" class="chat-empty">
        <div class="empty-icon">🚀</div>
        <div class="empty-title">欢迎使用启航 AI 工作台</div>
        <div class="empty-desc">首次使用？跟着以下步骤快速上手</div>

        <div class="guide-card">
          <div class="guide-step">
            <div class="step-index">1</div>
            <div class="step-content">
              <div class="step-title">开始第一个对话</div>
              <div class="step-desc">支持 日常问答 · 知识库检索 · 数据查询 · 图片识别 · 按项目工作目录运行</div>
              <div class="step-actions">
                <select
                  class="model-selector project-selector"
                  v-model="selectedProjectId"
                  :disabled="isStreaming"
                  title="选择对话所属项目（决定 AI 的工作目录）"
                  @change="onProjectChange"
                >
                  <option :value="null">📁 不绑定项目</option>
                  <option v-for="p in workProjects" :key="p.id" :value="p.id">📁 {{ p.name }}</option>
                  <option :value="NEW_PROJECT">＋ 新建项目…</option>
                </select>
                <button class="btn btn-primary" @click="newSession()">💬 开始对话</button>
              </div>
            </div>
          </div>

          <div class="guide-step">
            <div class="step-index">2</div>
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
            <span v-if="currentProject" class="chat-project-badge" :title="currentProject.dir || ''">📁 {{ currentProject.name }}</span>
          </div>
          <div class="chat-header-right">
            <span class="agent-status-dot" :class="isStreaming ? 'busy' : 'ready'"></span>
            <span class="agent-state">{{ isStreaming ? '生成中' : '空闲' }}</span>
          </div>
        </div>

        <div class="chat-messages" ref="messagesContainer">
          <div v-for="(msg, idx) in viewMessages" :key="idx" class="msg" :class="msg.role">
            <div class="msg-avatar">
              <span v-if="msg.role === 'user'">👤</span>
              <span v-else-if="msg.role === 'tool'">🔧</span>
              <span v-else-if="msg.role === 'system'">⚡</span>
              <span v-else>🤖</span>
            </div>
            <div class="msg-body">
              <div class="msg-author">
                <span class="msg-name">{{ msg.role === 'user' ? '我' : msg.role === 'tool' ? '工具' : msg.role === 'system' ? '系统' : 'AI 助理' }}</span>
                <span v-if="fmtTime(msg.time)" class="msg-time">{{ fmtTime(msg.time) }}</span>
                <span v-if="msg.status" class="msg-flag">{{ msg.status }}</span>
                <button
                  v-if="msg.content"
                  class="msg-copy"
                  :class="{ ok: copiedIndex === idx }"
                  :title="copiedIndex === idx ? '已复制' : '复制这条消息'"
                  @click="copyMsg(idx, msg.content)"
                >{{ copiedIndex === idx ? '已复制' : '复制' }}</button>
              </div>
              <details v-if="msg.thinking" class="msg-thinking">
                <summary>💭 思考过程（{{ msg.thinking.length }} 字）</summary>
                <pre>{{ msg.thinking }}</pre>
              </details>
              <div v-if="msg.content" class="msg-content" :class="{ 'markdown-body': msg.role !== 'user' }"
                   v-html="msg.role === 'user' ? formatUserMessage(msg.content) : renderMarkdown(msg.content)"></div>
              <div v-if="msg.images?.length" class="msg-images">
                <img v-for="(img, i) in msg.images" :key="i" :src="`data:${img.mimeType};base64,${img.data}`" class="msg-image" />
              </div>
            </div>
          </div>

          <div v-if="isStreaming" class="msg-status">
            <span class="spin">◌</span> {{ currentStream.status || 'AI 正在生成，切走再回来不会中断' }}
          </div>
        </div>

        <div class="chat-input-area">
          <div class="input-wrapper">
            <textarea
              v-model="inputText"
              class="chat-input"
              :placeholder="currentProject ? '输入问题，Enter 发送... (项目：' + currentProject.name + '，工作目录：' + (currentProject.dir || '未设置') + ')' : '输入问题，Enter 发送...'"
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
                <select
                  class="model-selector project-selector"
                  v-model="selectedProjectId"
                  :disabled="isStreaming"
                  title="对话所属项目（决定 AI 的工作目录，发送后仍可切换）"
                  @change="onProjectChange"
                >
                  <option :value="null">📁 不绑定项目</option>
                  <option v-for="p in workProjects" :key="p.id" :value="p.id">📁 {{ p.name }}</option>
                  <option :value="NEW_PROJECT">＋ 新建项目…</option>
                </select>
                <select class="model-selector" v-model="selectedModel" :disabled="isStreaming || modelsLoading" title="选择模型">
                  <option value="">默认模型</option>
                  <option v-if="modelsLoading" value="" disabled>模型加载中…</option>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import NotesGate from '@/components/NotesGate.vue';

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
const composing = ref(false);
const kbLibraries = ref<any[]>([]);
const kbLoaded = ref(false);
// ===== 项目（本地目录；笔记库也是项目，统一管理） =====
const workProjects = ref<any[]>([]);
const NEW_PROJECT = '__new__';
const PROJECT_PICK_KEY = 'chat_home_project';
const GROUP_COLLAPSE_KEY = 'chat_home_collapsed_groups';
const selectedProjectId = ref<number | null | typeof NEW_PROJECT>(null);
const collapsedGroups = ref<string[]>(loadCollapsedGroups());
const currentProject = computed(() => {
  const id = Number(selectedProjectId.value);
  return Number.isFinite(id) ? workProjects.value.find((p: any) => p.id === id) || null : null;
});
const defaultKb = computed(() => kbLibraries.value.find((l: any) => l.isDefault) || kbLibraries.value[0] || null);
const convGroups = computed(() => {
  const groups = workProjects.value.map((p: any) => ({ key: 'p' + p.id, project: p, sessions: [] as any[] }));
  const byId = new Map(groups.map((g) => [g.project.id, g]));
  const loose: any[] = [];
  for (const s of sessions.value) {
    const pid = s.project_id === null || s.project_id === undefined ? null : Number(s.project_id);
    const g = pid !== null ? byId.get(pid) : undefined;
    (g ? g.sessions : loose).push(s);
  }
  if (loose.length || !groups.length) groups.push({ key: 'loose', project: null, sessions: loose });
  return groups;
});
const inputRef = ref<HTMLTextAreaElement>();
const messagesContainer = ref<HTMLElement>();
const conversationListRef = ref<HTMLElement>();
const pendingImages = ref<{ data: string; mimeType: string }[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);
const piModels = ref<{ provider: string; providerLabel: string; id: string; name: string; pattern: string; configured: boolean }[]>([]);
const selectedModel = ref('');
const modelsLoaded = ref(false);
const modelsLoading = ref(false);

// ========== 每会话进行中的流 ==========
// 监听只绑一次，事件按 sessionId 落到各自的缓冲：切走再切回来仍能看到这一轮的真实进度，
// 移动端发起的那一轮也一样能演出来（旧写法是发送时临时绑、收口即解绑，做不到）。
interface ChatStream { running: boolean; text: string; thinking: string; status: string; error: string }
function emptyStream(): ChatStream { return { running: false, text: '', thinking: '', status: '', error: '' }; }
const streams = ref<Record<string, ChatStream>>({});

function streamOf(sid: string): ChatStream {
  if (!streams.value[sid]) streams.value[sid] = emptyStream();
  return streams.value[sid];
}

const currentStream = computed(() =>
  currentSessionId.value ? streams.value[currentSessionId.value] || emptyStream() : emptyStream(),
);
/** 进行中的那条：正文 + 可折叠的思考过程，切走再回来还是这一条 */
const liveMessage = computed(() => {
  const s = currentStream.value;
  // 只有状态没有内容时不占一条气泡，交给下面的进度条说；
  // 但 reasoning 也算内容——模型闷头查工具时那一段就是用户唯一能看到的进展
  if (!s.text.trim() && !s.thinking && !s.error) return null;
  return {
    role: 'assistant',
    live: true,
    content: s.error ? '❌ ' + s.error : (s.text.trim() ? s.text : ''),
    thinking: s.thinking,
    status: s.error ? '错误' : '',
  };
});
/** 只有当前会话在跑才锁输入：别的会话在回答不影响这里打字 */
const isStreaming = computed(() => currentStream.value.running);
const runningSessionIds = computed(() => new Set(Object.keys(streams.value).filter((sid) => streams.value[sid].running)));

/** 历史消息 + 当前会话正在进行的那条 */
const viewMessages = computed(() => {
  const live = liveMessage.value;
  return live ? messages.value.concat([live]) : messages.value;
});

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 今天的日期前缀，与库里的 created_at 同为东八区口径 */
function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 消息行上的时间：今天的只显示时分，其余显示完整日期时间（created_at 已是 'YYYY-MM-DD HH:mm:ss'） */
const fmtTime = (t: any) =>
  typeof t === 'string' && t.length >= 16
    ? (t.slice(0, 10) === todayDate() ? t.slice(11, 16) : `${t.slice(0, 10)} ${t.slice(11, 16)}`)
    : '';

/** 本地刚发出去的那条还没有落库时间，按同一格式造一个 */
function nowLabel(): string {
  const d = new Date();
  return `${todayDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

const copiedIndex = ref(-1);
async function copyMsg(idx: number, content: string) {
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    copiedIndex.value = idx;
    setTimeout(() => { if (copiedIndex.value === idx) copiedIndex.value = -1; }, 1600);
  } catch { /* 剪贴板被系统拒了，不拦用户 */ }
}

const CHAT_STATE_KEY = 'chat_home_state';
const CHAT_MODEL_KEY = 'chat_home_model_pi';

// ========== 加载数据 ==========
// ===== 项目：会话通过 project_id 归属，项目目录即 AI 的工作目录 =====
function loadCollapsedGroups(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((k: any) => typeof k === 'string') : [];
  } catch { return []; }
}
function isGroupCollapsed(key: string): boolean {
  return collapsedGroups.value.includes(key);
}
function toggleGroup(key: string) {
  collapsedGroups.value = isGroupCollapsed(key)
    ? collapsedGroups.value.filter((k) => k !== key)
    : collapsedGroups.value.concat(key);
  try { localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(collapsedGroups.value)); } catch {}
}
function expandGroup(key: string) {
  if (!isGroupCollapsed(key)) return;
  collapsedGroups.value = collapsedGroups.value.filter((k) => k !== key);
  try { localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(collapsedGroups.value)); } catch {}
}
function groupIsCurrent(group: { sessions: any[] }): boolean {
  return !!currentSessionId.value && group.sessions.some((s) => (s.session_id || String(s.id)) === currentSessionId.value);
}

/** 当前会话绑定的项目（历史会话可能挂在项目或 null） */
function sessionProjectId(): number | null {
  const pid = currentSession.value?.project_id;
  if (pid === null || pid === undefined) return null;
  const n = Number(pid);
  return Number.isFinite(n) && workProjects.value.some((p: any) => p.id === n) ? n : null;
}

function syncProjectFromSession() {
  selectedProjectId.value = sessionProjectId();
  expandGroup(selectedProjectId.value !== null ? 'p' + selectedProjectId.value : 'loose');
}
function rememberProjectPick() {
  try {
    if (typeof selectedProjectId.value === 'number') localStorage.setItem(PROJECT_PICK_KEY, String(selectedProjectId.value));
    else localStorage.removeItem(PROJECT_PICK_KEY);
  } catch {}
}
function restoreProjectPick() {
  if (currentSessionId.value) return;
  const saved = Number(localStorage.getItem(PROJECT_PICK_KEY) || '');
  if (Number.isFinite(saved) && workProjects.value.some((p: any) => p.id === saved)) selectedProjectId.value = saved;
}

/** 会话这一轮的工作目录：项目目录即该项目的库目录；日常对话沿用默认项目 */
function chatContext(): { projectDir: string } {
  const proj = currentProject.value;
  if (proj) {
    const kb = kbLibraries.value.find((l: any) => sameDir(l.dir, proj.dir));
    return { projectDir: proj.dir || kb?.dir || '' };
  }
  const boundKb = kbLibraries.value.find((l: any) => l.id === Number(currentSession.value?.project_id));
  const kb = boundKb || defaultKb.value;
  return { projectDir: kb?.dir || '' };
}
function sameDir(a: string, b: string): boolean {
  const norm = (s: string) => String(s || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

async function loadWorkProjects() {
  try { workProjects.value = (await API.project.list()) || []; } catch { workProjects.value = []; }
}
async function loadKbLibraries() {
  try { kbLibraries.value = await API.kb.list(); } catch { kbLibraries.value = []; }
  kbLoaded.value = true;
}

async function loadPiModels() {
  modelsLoading.value = true;
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
  finally { modelsLoading.value = false; }
  modelsLoaded.value = true;
}

async function onGateReady() {
  await Promise.all([loadKbLibraries(), loadWorkProjects(), loadSessions(), loadPiModels()]);
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
    // 早期入库的空白 assistant 行（模型只吐了换行）渲染出来是空框，直接不显示
    messages.value = msgs
      .filter((m: any) => m.role !== 'assistant' || String(m.content || '').trim())
      .map((m: any) => ({
        role: m.role,
        content: m.content,
        images: m.images || undefined,
        thinking: m.thinking || '',
        time: m.created_at,
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
  const sid = session.session_id || String(session.id);
  const stale = streams.value[sid];
  if (stale && !stale.running) {
    // 不在跑的那轮以落库历史为准，别把上一轮的错误/残留气泡带回来
    stale.text = '';
    stale.error = '';
    stale.status = '';
  }
  currentSessionId.value = sid;
  currentSession.value = session;
  syncProjectFromSession();
  await loadMessages(sid);
  saveState();
}

async function newSession(projectId?: number | null) {
  const pid = typeof projectId === 'number'
    ? projectId
    : (typeof selectedProjectId.value === 'number' ? selectedProjectId.value : null);
  const id = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    const session = await API.chat.createSession(id, pid, '新对话', 'general', 'general', 'ui');
    currentSessionId.value = id;
    currentSession.value = session;
    selectedProjectId.value = pid;
    expandGroup(pid !== null ? 'p' + pid : 'loose');
    rememberProjectPick();
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
    delete streams.value[sessionId];
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

// ========== 项目切换 ==========
function savedProjectPick(): number | null {
  const n = Number(localStorage.getItem(PROJECT_PICK_KEY) || '');
  return Number.isFinite(n) && workProjects.value.some((p: any) => p.id === n) ? n : null;
}

async function onProjectChange() {
  if (selectedProjectId.value === NEW_PROJECT) {
    await createProjectFromPicker();
    return;
  }
  const pid = typeof selectedProjectId.value === 'number' ? selectedProjectId.value : null;
  if (!currentSessionId.value) {
    rememberProjectPick();
    if (pid !== null) expandGroup('p' + pid);
    return;
  }
  try {
    const r = await API.chat.updateProject(currentSessionId.value, pid);
    if (r && r.ok === false) throw new Error(r.error || '切换项目失败');
    if (currentSession.value) currentSession.value.project_id = pid;
    rememberProjectPick();
    await loadSessions();
    expandGroup(pid !== null ? 'p' + pid : 'loose');
  } catch (e: any) {
    selectedProjectId.value = sessionProjectId();
    alert('切换项目失败: ' + (e?.message || e));
  }
}

async function createProjectFromPicker() {
  const previous = currentSessionId.value ? sessionProjectId() : savedProjectPick();
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir) { selectedProjectId.value = previous; return; }
    const base = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '新项目';
    const name = (prompt('项目名称', base) || '').trim() || base;
    const p = await API.project.add(name, 'note', dir, '', '');
    await loadWorkProjects();
    selectedProjectId.value = p.id;
    rememberProjectPick();
    if (currentSessionId.value) {
      const r = await API.chat.updateProject(currentSessionId.value, p.id);
      if (r && r.ok === false) throw new Error(r.error || '绑定项目失败');
      if (currentSession.value) currentSession.value.project_id = p.id;
      await loadSessions();
    }
    expandGroup('p' + p.id);
  } catch (e: any) {
    selectedProjectId.value = previous;
    alert('创建项目失败: ' + (e?.message || e));
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
    syncProjectFromSession();
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

  const userMsg: any = { role: 'user', content: text, time: nowLabel() };
  if (images.length) userMsg.images = images;
  messages.value.push(userMsg);

  inputText.value = '';
  autoResizeTextarea();

  const sid = currentSessionId.value;
  const stream = streamOf(sid);
  stream.running = true;
  stream.text = '';
  stream.thinking = '';
  stream.error = '';
  stream.status = '准备中...';
  scrollToBottom();

  const { projectDir } = chatContext();

  try {
    await API.chat.send(text, sid, projectDir, images.length ? images : undefined, 'general', selectedModel.value || undefined);
    if (selectedModel.value) localStorage.setItem(CHAT_MODEL_KEY, selectedModel.value);
    else localStorage.removeItem(CHAT_MODEL_KEY);
  } catch (err: any) {
    stream.running = false;
    stream.thinking = '';
    stream.error = err.message || '发送失败';
  }
}

// ========== 全局事件绑定（只绑一次） ==========
async function settleStream(sid: string) {
  const stream = streamOf(sid);
  stream.running = false;
  stream.thinking = '';
  stream.status = '';
  await loadSessions();
  if (sid === currentSessionId.value) await loadMessages(sid);
  stream.text = '';
}

function bindChatEvents() {
  API.on('chat:status', (data: { sessionId: string; text: string }) => {
    const stream = streamOf(String(data.sessionId));
    stream.running = true;
    stream.error = '';
    stream.status = data.text || '';
  });

  API.on('chat:delta', (data: { sessionId: string; text: string }) => {
    const stream = streamOf(String(data.sessionId));
    if (!stream.running) { stream.running = true; stream.text = ''; stream.thinking = ''; }
    stream.error = '';
    stream.text += data.text || '';
    stream.status = '';
    if (String(data.sessionId) === currentSessionId.value) scrollToBottom();
  });

  API.on('chat:thinking', (data: { sessionId: string; text: string }) => {
    const stream = streamOf(String(data.sessionId));
    if (!stream.running) { stream.running = true; stream.text = ''; stream.thinking = ''; }
    stream.error = '';
    stream.thinking += data.text || '';
    if (String(data.sessionId) === currentSessionId.value) scrollToBottom();
  });

  API.on('chat:tool', (data: { sessionId: string; type: string; name: string; text?: string; error?: boolean }) => {
    const stream = streamOf(String(data.sessionId));
    if (data.type === 'start') {
      stream.status = `🔧 正在执行: ${data.name}`;
    } else if (data.type === 'end') {
      stream.status = `${data.error ? '❌' : '✅'} ${data.name} ${data.error ? '失败' : '完成'}`;
    }
    if (String(data.sessionId) === currentSessionId.value) scrollToBottom();
  });

  API.on('chat:done', (data: { sessionId: string }) => { void settleStream(String(data.sessionId)); });

  API.on('chat:error', (data: { sessionId: string; text: string }) => {
    const stream = streamOf(String(data.sessionId));
    stream.running = false;
    stream.thinking = '';
    stream.status = '';
    stream.text = '';
    stream.error = data.text || '未知错误';
    void loadSessions();
  });
}

// ========== 移动端发起的对话 ==========
// 进行中的那一轮已经由全局 chat:delta/status/tool 按会话缓冲演出来了；
// 这两个通道只补「移动端刚发来的那条问题」和「桌面没在看着它时的落库结果」。
async function onRemoteMessage(data: any) {
  const sid = String(data?.sessionId || '');
  if (!sid) return;
  // 先推问题气泡再 await：runChatTurn 的 chat:status 几乎同时到，
  // 等 loadSessions 回来 running 已被置真，原来的 guard 会把气泡永久跳过。
  // 落库结果在 chat:remote-settled 时整段重拉，不会重复。
  if (sid === currentSessionId.value) {
    messages.value.push({ role: 'user', content: String(data.text || ''), time: nowLabel() });
    scrollToBottom();
  }
  await loadSessions();
}

async function onRemoteSettled(data: any) {
  await loadSessions();
  const sid = String(data?.sessionId || '');
  if (sid && sid === currentSessionId.value && !currentStream.value.running) await loadMessages(sid);
}

/** 点系统通知跳过来的会话 */
async function onOpenSession(data: any) {
  const sid = String(data?.sessionId || '');
  if (!sid || sid === currentSessionId.value) return;
  const find = () => sessions.value.find((s: any) => (s.session_id || String(s.id)) === sid);
  let target = find();
  if (!target) { await loadSessions(); target = find(); }
  if (target) await selectSession(target);
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
  await Promise.all([loadKbLibraries(), loadWorkProjects(), loadSessions(), loadPiModels()]);
  
  // 尝试恢复上次的会话状态
  const restored = await restoreState();
  
  if (restored) {
    // 恢复成功，滚动到已恢复的会话
    scrollToActiveConversation();
  } else if (sessions.value.length > 0) {
    // 如果没有恢复到上次状态，但有会话存在，自动选择最新的会话（最后一条）
    await selectSession(sessions.value[sessions.value.length - 1]);
    scrollToActiveConversation();
  } else {
    // 没有会话时，沿用上次选的项目作为新对话的默认归属
    restoreProjectPick();
  }
  
  // 工具箱跳转：?prompt= 预填输入框
  const qp = route.query.prompt;
  if (typeof qp === 'string' && qp.trim()) {
    inputText.value = qp.trim();
    nextTick(() => inputRef.value?.focus());
  }

  // 对话事件全程只绑这一次：桌面自己发的、移动端发的都走同一套缓冲
  bindChatEvents();

  // 移动端经中继打进来的动态：全程挂着，不随切会话收放
  API.on('chat:remote', onRemoteMessage);
  API.on('chat:remote-settled', onRemoteSettled);
  API.on('chat:created', () => { void loadSessions(); });
  API.on('nav:open-session', onOpenSession);
});

onBeforeUnmount(() => {
  for (const channel of ['chat:delta', 'chat:status', 'chat:tool', 'chat:done', 'chat:error',
    'chat:remote', 'chat:remote-settled', 'chat:created', 'nav:open-session']) {
    API.removeAllListeners(channel);
  }
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

/* ========== 对话视图 ========== */
.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
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

.conversation-groups {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.conv-group {
  margin-bottom: 6px;
}

.conv-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  color: #475569;
  transition: background 0.15s;
}

.conv-group-header:hover {
  background: #eef2f7;
}

.conv-group-header.current .group-name {
  color: var(--primary);
}

.group-arrow {
  font-size: 10px;
  width: 12px;
  text-align: center;
  color: #94a3b8;
  transition: transform 0.15s;
}

.group-arrow.collapsed {
  transform: rotate(-90deg);
}

.group-icon {
  font-size: 12px;
}

.group-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  font-size: 10px;
  color: #94a3b8;
  background: #f1f5f9;
  border-radius: 8px;
  padding: 1px 6px;
}

.group-add {
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 5px;
  cursor: pointer;
  visibility: hidden;
}

.conv-group-header:hover .group-add {
  visibility: visible;
}

.group-add:hover {
  color: var(--primary);
  background: rgba(99, 102, 241, 0.1);
}

.conversation-list {
  padding: 2px 0 2px 12px;
}

.group-empty {
  font-size: 11px;
  color: #b0bac7;
  padding: 6px 12px;
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

.step-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
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
  padding: 0 20px;
  height: 48px;
  border-bottom: 1px solid #e8ecf1;
  background: #fafbfc;
  flex-shrink: 0;
}

.chat-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.chat-title {
  font-size: 14px;
  font-weight: 600;
  color: #1e293b;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-project-badge {
  font-size: 11px;
  color: #4f46e5;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 6px;
  padding: 2px 8px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.chat-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.agent-state {
  font-size: 11px;
  color: #64748b;
}

.agent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.agent-status-dot.ready {
  background: #22c55e;
}

.agent-status-dot.busy {
  background: #fbbf24;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-behavior: smooth;
}

/* ========== 消息（版式对齐 qihang-coding-assist 的对话详情） ========== */
.msg {
  display: flex;
  gap: 10px;
  max-width: 98%;
  animation: fadeInUp 0.2s ease-out;
}

.msg.user {
  flex-direction: row-reverse;
  align-self: flex-end;
}

.msg.assistant {
  align-self: flex-start;
}

.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 12px;
  flex-shrink: 0;
}

.msg.user .msg-avatar {
  background: #6366f1;
  color: white;
}

.msg.assistant .msg-avatar {
  background: #f1f5f9;
}

.msg.tool .msg-avatar,
.msg.system .msg-avatar {
  background: #ecfeff;
}

.msg-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
}

.msg-author {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  color: #64748b;
}

.msg.user .msg-author {
  justify-content: flex-end;
}

.msg-name {
  font-weight: 600;
}

.msg-time {
  font-size: 10px;
  font-weight: 400;
  color: #94a3b8;
}

.msg-flag {
  font-size: 10px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 4px;
  padding: 1px 5px;
}

.msg-copy {
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #94a3b8;
  font-size: 10px;
  padding: 0 6px;
  cursor: pointer;
}

.msg-copy:hover {
  border-color: #c7d2fe;
  color: #4f46e5;
}

.msg-copy.ok {
  border-color: #bbf7d0;
  color: #16a34a;
}

.msg-content {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.msg.user .msg-content {
  background: #eef2ff;
  color: #1e293b;
  border: 1px solid #e0e7ff;
  border-bottom-right-radius: 4px;
}

.msg.assistant .msg-content {
  background: transparent;
  color: #1e293b;
  border: 1px solid #e2e8f0;
  border-bottom-left-radius: 4px;
}

.msg.tool .msg-content,
.msg.system .msg-content {
  background: #f8fafc;
  color: #334155;
  border: 1px solid #e2e8f0;
}

/* 思考过程：默认折叠，生成中也能点开看全文 */
.msg-thinking {
  background: transparent;
  border: 1px dashed #cbd5e1;
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 11px;
  color: #64748b;
}

.msg-thinking summary {
  cursor: pointer;
  user-select: none;
  font-weight: 500;
}

.msg-thinking pre {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.55;
  color: #475569;
  max-height: 240px;
  overflow-y: auto;
}

.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.msg-image {
  max-width: 200px;
  max-height: 200px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  object-fit: contain;
}

/* 进行中的那一行：切走再回来看得到，不靠气泡里塞占位 */
.msg-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  color: #6366f1;
  background: #eef2ff;
  border-radius: 8px;
  align-self: flex-start;
}

.spin {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: white;
  padding: 10px 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.input-wrapper:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.chat-input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  background: transparent;
  max-height: 120px;
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
  padding-top: 8px;
  margin-top: 2px;
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
  background: #6366f1;
  color: white;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  flex-shrink: 0;
}

.send-btn:hover:not(:disabled) {
  background: #4f46e5;
}

.send-btn:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
}
</style>
