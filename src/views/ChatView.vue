<template>
  <div class="chat-home">
    <!-- ========== 对话视图 ========== -->
    <div class="chat-body">
    <!-- ========== 左栏：对话列表 ========== -->
    <div v-show="sessionsOpen" class="chat-sidebar session-flyout" @click.stop>
      <div class="sidebar-header">
        <h3 class="sidebar-title">会话记录</h3>
        <button class="btn btn-sm btn-primary" @click="newSession()">+ 新对话</button>
      </div>

      <div class="conversation-groups" v-if="sessions.length || workProjects.length" ref="conversationListRef">
        <div v-for="group in convGroups" :key="group.key" class="conv-group">
          <div
            class="conv-group-header"
            :class="{ current: groupIsCurrent(group) }"
            :title="group.key === 'recent' ? '最近 72 小时内活跃的对话 · 点击折叠/展开' : (group.project ? (group.project.dir || group.project.name) + ' · 点击折叠/展开' : '未绑定项目的对话')"
            @click="toggleGroup(group.key)"
          >
            <span class="group-arrow" :class="{ collapsed: isGroupCollapsed(group.key) }">▾</span>
            <span class="group-icon">{{ group.key === 'recent' ? '🕘' : (group.project ? '📁' : '💬') }}</span>
            <span class="group-name">{{ group.key === 'recent' ? '最近' : (group.project ? group.project.name : '未分组') }}</span>
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
                <div class="conv-title">
                  <span v-if="session.source === 'feishu'" class="conv-badge" title="来自飞书">飞书</span>{{ session.title || '新对话' }}
                </div>
                <div class="conv-preview">{{ session.last_message || '' }}</div>
              </div>
              <span class="conv-time">{{ fmtSessionTime(session) }}</span>
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

      <!-- 新建对话页（懒创建：真正发送后才创建会话） -->
      <div v-else-if="kbLoaded && (draftMode || !currentSessionId)" class="draft-page">
        <div class="draft-top">
          <button class="sessions-toggle" title="会话记录" @click.stop="sessionsOpen = !sessionsOpen">
            <AppIcon name="list-checks" :size="14" />
            <span>会话</span>
            <AppIcon name="chevron-down" :size="12" />
          </button>
        </div>
        <div class="draft-inner">
          <h1 class="draft-title">新建对话</h1>
          <p class="draft-sub">
            在
            <select class="draft-project" v-model="selectedProjectId" :disabled="isStreaming" @change="onProjectChange">
              <option :value="null">不绑定项目</option>
              <option v-for="p in workProjects" :key="p.id" :value="p.id">{{ p.name }}</option>
              <option :value="NEW_PROJECT">＋ 新建项目…</option>
            </select>
            里把要做的事说清楚，回车即开始
          </p>
          <div class="draft-composer">
            <div v-if="pendingImages.length" class="draft-images">
              <div v-for="(img, i) in pendingImages" :key="i" class="draft-img">
                <img :src="'data:' + img.mimeType + ';base64,' + img.data" alt="" />
                <button class="draft-img-del" @click="removeImage(i)">×</button>
              </div>
            </div>
            <textarea
              ref="draftInputRef"
              v-model="inputText"
              class="draft-input"
              rows="3"
              placeholder="描述这次对话要做的事，Enter 发送…"
              @keydown.enter.exact.prevent="sendMessage()"
            ></textarea>
            <div class="draft-toolbar">
              <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="handleImageUpload" />
              <button class="draft-tool" title="添加图片" @click="pickImage()"><AppIcon name="paperclip" :size="14" /></button>
              <select class="draft-select" v-model="selectedModel" :disabled="isStreaming || modelsLoading" title="选择模型">
                <option value="">默认模型</option>
                <option v-if="modelsLoading" value="" disabled>模型加载中…</option>
                <option v-for="m in piModels" :key="m.pattern" :value="m.pattern">{{ m.providerLabel }} · {{ m.name }}</option>
              </select>
              <span class="draft-hint">Enter 发送 · Shift+Enter 换行</span>
              <button class="draft-send" :disabled="(!inputText.trim() && !pendingImages.length) || isStreaming" title="发送" @click="sendMessage()">
                <AppIcon name="send" :size="15" />
              </button>
            </div>
          </div>
          <div class="draft-meta">
            <template v-if="draftProject">
              <span>📁 {{ draftProject.name }}</span>
              <span class="draft-meta-dim">{{ draftProject.dir }}</span>
            </template>
            <span v-else>未绑定项目 · 发送后可随时切换</span>
          </div>
        </div>
      </div>

      <!-- 有对话时 -->
      <template v-else>
        <div class="chat-header">
          <div class="chat-header-left">
            <button class="sessions-toggle" title="会话记录" @click.stop="sessionsOpen = !sessionsOpen">
              <AppIcon name="list-checks" :size="14" />
              <span>会话</span>
              <AppIcon name="chevron-down" :size="12" />
            </button>
            <h3 class="chat-title">{{ currentSession?.title || '对话' }}</h3>
            <span
              v-if="currentSession?.source === 'feishu'"
              class="chat-source-badge"
              title="来自飞书 · 在软件内回复不会推送到飞书"
            >飞书</span>
            <span v-if="currentProject" class="chat-project-badge" :title="currentProject.dir || ''">📁 {{ currentProject.name }}</span>
          </div>
          <div class="chat-header-right">
            <button class="btn btn-primary btn-sm" @click="newSession()" title="新建对话"><AppIcon name="plus" :size="13" />新对话</button>
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
import { ref, computed, watch, onMounted, nextTick, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import NotesGate from '@/components/NotesGate.vue';
import AppIcon from '@/components/AppIcon.vue';

// 配置 marked 以启用换行和 GFM
marked.setOptions({
  breaks: true,
  gfm: true
});

const API = window.electronAPI;
const route = useRoute();
const router = useRouter();

// ========== 状态 ==========
const sessions = ref<any[]>([]);
const sessionsOpen = ref(false);
const currentSessionId = ref('');
const currentSession = ref<any>(null);

// 会话浮层：点击外部 / Esc 关闭
function onGlobalClickCloseSessions() { sessionsOpen.value = false; }
function onEscCloseSessions(e: KeyboardEvent) { if (e.key === 'Escape') sessionsOpen.value = false; }
onMounted(() => {
  document.addEventListener('click', onGlobalClickCloseSessions);
  document.addEventListener('keydown', onEscCloseSessions);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onGlobalClickCloseSessions);
  document.removeEventListener('keydown', onEscCloseSessions);
});
// 侧栏「新对话」：同路由下点击也能触发草稿页
watch(() => route.query.new, (v) => {
  if (v === '1') {
    newSession();
    router.replace({ path: '/chat' });
  }
});
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
// 会话活跃时间：列表排序与「最近」分组的依据（updated_at 为最后一条消息落库时间）
function sessionTime(s: any): number {
  const raw = String(s.updated_at || s.created_at || '').replace(' ', 'T');
  const t = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function fmtSessionTime(s: any): string {
  const t = sessionTime(s);
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const diff = now.getTime() - t;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 5 * 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const RECENT_WINDOW = 72 * 3600 * 1000;

const convGroups = computed(() => {
  // 全列表按最近对话时间倒序
  const sorted = [...sessions.value].sort((a, b) => sessionTime(b) - sessionTime(a));
  const groups: { key: string; project: any; sessions: any[] }[] = [];
  // 「最近」分组：72 小时内活跃的前 8 条，置顶快达（条目同时保留在各自项目分组里）
  const recent = sorted.filter((s) => Date.now() - sessionTime(s) < RECENT_WINDOW).slice(0, 8);
  if (recent.length) groups.push({ key: 'recent', project: null, sessions: recent });
  const projGroups = workProjects.value.map((p: any) => ({ key: 'p' + p.id, project: p, sessions: [] as any[] }));
  const byId = new Map(projGroups.map((g) => [g.project.id, g]));
  const loose: any[] = [];
  for (const s of sorted) {
    const pid = s.project_id === null || s.project_id === undefined ? null : Number(s.project_id);
    const g = pid !== null ? byId.get(pid) : undefined;
    (g ? g.sessions : loose).push(s);
  }
  if (loose.length || !projGroups.length) projGroups.push({ key: 'loose', project: null, sessions: loose });
  groups.push(...projGroups);
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

// ========== 新建对话（懒创建：真正发送后才建数据库会话） ==========
const draftMode = ref(false);
const draftInputRef = ref<HTMLTextAreaElement | null>(null);
const draftProject = computed(() => {
  const id = Number(selectedProjectId.value);
  return Number.isFinite(id) && id > 0 ? workProjects.value.find((p: any) => p.id === id) || null : null;
});
function enterDraft(projectId?: number | null) {
  draftMode.value = true;
  if (projectId !== undefined && projectId !== null) {
    selectedProjectId.value = projectId;
  } else if (typeof selectedProjectId.value !== 'number') {
    const def = kbLibraries.value.find((l: any) => l.isDefault) || kbLibraries.value[0] || null;
    selectedProjectId.value = def ? def.id : null;
  }
  sessionsOpen.value = false;
  nextTick(() => draftInputRef.value?.focus());
}

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
    // 统一收件箱：UI 发起 + 飞书发起的会话合并展示（飞书会话带「飞书」徽标）。
    // ui 来源的 kb 模式会话（后台任务会话）仍按原规则排除。
    const [ui, feishu] = await Promise.all([
      API.chat.getSessionsBySource('ui'),
      API.chat.getSessionsBySource('feishu'),
    ]);
    const all = [...(ui || []), ...(feishu || [])];
    sessions.value = all.filter((s: any) => s.source === 'feishu' || s.mode === 'general' || !s.project_id);
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
  draftMode.value = false;
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
  sessionsOpen.value = false;
  saveState();
}

// 「新建对话」只进入草稿页，不再立刻写库；真正发送时才 createSession
function newSession(projectId?: number | null) {
  enterDraft(projectId);
}

async function createSessionNow(pid: number | null): Promise<string | null> {
  const id = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    const session = await API.chat.createSession(id, pid, '新对话', 'general', 'general', 'ui');
    currentSessionId.value = id;
    currentSession.value = session;
    selectedProjectId.value = pid;
    expandGroup(pid !== null ? 'p' + pid : 'loose');
    rememberProjectPick();
    messages.value = [];
    await loadSessions();
    saveState();
    return id;
  } catch (e: any) {
    console.error('创建对话失败:', e);
    return null;
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

// 会话恢复策略已改为「进页展示最近活跃的一条」（见 onMounted），旧的状态恢复逻辑废弃

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

  // 草稿页首次发送：此刻才创建数据库会话
  if (draftMode.value || !currentSessionId.value) {
    const pid = selectedProjectId.value === NEW_PROJECT
      ? null
      : (typeof selectedProjectId.value === 'number' ? selectedProjectId.value : null);
    const sid = await createSessionNow(pid);
    if (!sid) return;
    draftMode.value = false;
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

  // 侧栏「新对话」快速入口：/chat?new=1 直接进草稿页
  if (route.query.new === '1') {
    newSession();
    router.replace({ path: '/chat' });
  } else if (sessions.value.length > 0) {
    // 进入对话页默认展示最近活跃的一条（以最后一条消息时间为准）
    const latest = [...sessions.value].sort((a, b) => sessionTime(b) - sessionTime(a))[0];
    await selectSession(latest);
    scrollToActiveConversation();
  } else {
    // 没有会话时进入新建对话页，沿用上次选的项目作为默认归属
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
  position: relative;
}

/* ========== 会话浮层（从对话页头部唤出，不再常驻三栏） ========== */
.session-flyout {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 348px;
  max-height: calc(100% - 24px);
  z-index: 60;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sessions-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.sessions-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-soft);
}

/* 会话条目时间 */
.conv-time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* ========== 新建对话页（懒创建） ========== */
.draft-page {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  background: var(--bg-main);
}
.draft-top {
  position: absolute;
  top: 14px;
  left: 16px;
  z-index: 5;
}
.draft-inner {
  width: 100%;
  max-width: 720px;
  padding: 9vh 24px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.draft-title {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.01em;
}
.draft-sub {
  margin-top: 12px;
  font-size: 14px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}
.draft-project {
  border: none;
  border-bottom: 1px dashed var(--primary);
  background: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--primary);
  cursor: pointer;
  outline: none;
  padding: 0 2px;
}
.draft-composer {
  width: 100%;
  margin-top: 26px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
}
.draft-composer:focus-within { border-color: var(--primary); }
.draft-images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 14px 0;
}
.draft-img {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.draft-img img { width: 100%; height: 100%; object-fit: cover; }
.draft-img-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.draft-input {
  width: 100%;
  border: none;
  outline: none;
  background: none;
  resize: none;
  font: inherit;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  padding: 16px 18px 8px;
  min-height: 88px;
}
.draft-input::placeholder { color: var(--text-muted); }
.draft-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--border);
}
.draft-tool {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.draft-tool:hover { background: var(--hover); color: var(--text-primary); }
.draft-select {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-primary);
  font: inherit;
  font-size: 12.5px;
  padding: 6px 10px;
  outline: none;
  cursor: pointer;
}
.draft-hint {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-muted);
}
.draft-send {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.draft-send:hover:not(:disabled) { background: var(--primary-dark); }
.draft-send:disabled { opacity: 0.4; cursor: not-allowed; }
.draft-meta {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-wrap: wrap;
  justify-content: center;
}
.draft-meta-dim {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: var(--surface);
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
  color: var(--text-secondary);
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
  color: var(--text-muted);
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
  color: var(--text-muted);
  background: var(--hover);
  border-radius: 8px;
  padding: 1px 6px;
}

.group-add {
  border: none;
  background: transparent;
  color: var(--text-muted);
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
  background: rgba(var(--primary-rgb), 0.1);
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
  background: var(--surface);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  transform: translateX(2px);
}

.conversation-item.active {
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.12), rgba(139, 92, 246, 0.08));
  border-left: 3px solid var(--primary);
  box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.1);
}

.conv-icon {
  font-size: 14px;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--primary-rgb), 0.1);
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

/* 飞书来源会话的来源徽标（列表条目 + 聊天区头部共用飞书品牌蓝） */
.conv-badge,
.chat-source-badge {
  display: inline-block;
  vertical-align: 1px;
  padding: 0 5px;
  margin-right: 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  font-weight: 600;
  flex-shrink: 0;
  background: rgba(51, 112, 255, 0.12);
  color: #3370ff;
}

.chat-source-badge {
  padding: 1px 7px;
  font-size: 11px;
  line-height: 17px;
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
  background: var(--surface);
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
  background: linear-gradient(135deg, var(--surface-2) 0%, var(--surface) 50%, var(--bg-main) 100%);
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
  background: linear-gradient(135deg, var(--primary), var(--primary-light));
  box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.3);
  transition: all 0.2s;
}

.btn-lg:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(var(--primary-rgb), 0.4);
}

/* ========== 空状态引导卡 ========== */
.guide-card {
  width: 520px;
  max-width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 8px 24px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
  text-align: left;
}

.guide-step {
  display: flex;
  gap: 14px;
  padding: 16px 0;
  border-bottom: 1px solid var(--hover);
}

.guide-step:last-child {
  border-bottom: none;
}

.step-index {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--primary), var(--primary-light));
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
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.2);
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
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
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
  color: var(--text-primary);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-project-badge {
  font-size: 11px;
  color: var(--primary-dark);
  background: rgba(var(--primary-rgb), 0.1);
  border: 1px solid rgba(var(--primary-rgb), 0.2);
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
  color: var(--text-secondary);
}

.agent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.agent-status-dot.ready {
  background: var(--success);
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
  background: var(--primary);
  color: white;
}

.msg.assistant .msg-avatar {
  background: var(--hover);
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
  color: var(--text-secondary);
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
  color: var(--text-muted);
}

.msg-flag {
  font-size: 10px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 4px;
  padding: 1px 5px;
}

.msg-copy {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 10px;
  padding: 0 6px;
  cursor: pointer;
}

.msg-copy:hover {
  border-color: #c7d2fe;
  color: var(--primary-dark);
}

.msg-copy.ok {
  border-color: var(--success-soft);
  color: var(--success);
}

.msg-content {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.msg.user .msg-content {
  background: var(--primary-soft);
  color: var(--text-primary);
  border: 1px solid #e0e7ff;
  border-bottom-right-radius: 4px;
}

.msg.assistant .msg-content {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}

.msg.tool .msg-content,
.msg.system .msg-content {
  background: var(--bg-main);
  color: #334155;
  border: 1px solid var(--border);
}

/* 思考过程：默认折叠，生成中也能点开看全文 */
.msg-thinking {
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  border: 1px solid var(--border);
  object-fit: contain;
}

/* 进行中的那一行：切走再回来看得到，不靠气泡里塞占位 */
.msg-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-soft);
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
  border-top: 1px solid var(--border);
  background: linear-gradient(to top, var(--surface), var(--surface-2));
  flex-shrink: 0;
}

.input-wrapper {
  max-width: 900px;
  margin: 0 auto;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  padding: 10px 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.input-wrapper:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(var(--primary-rgb), 0.1);
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
  background: rgba(var(--primary-rgb), 0.08);
  transform: scale(1.05);
}

.model-selector {
  font-size: 12px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  max-width: 180px;
  outline: none;
  cursor: pointer;
  transition: all 0.2s;
}

.model-selector:hover {
  border-color: var(--primary);
  background: var(--surface);
}

.input-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.send-btn {
  border: none;
  background: var(--primary);
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
  background: var(--primary-dark);
}

.send-btn:disabled {
  background: var(--border);
  cursor: not-allowed;
}
</style>
