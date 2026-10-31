<!--
  NewChatView —— 新建对话页（独立页面）
  只负责「发起一条新对话」：选项目、写内容、选模型。
  发送时才懒创建会话，然后把首条消息经 sessionStorage 交接给对话详情页
  （ChatView）去发送并接收流式回包——事件监听都挂在详情页，切页不丢流。
-->
<template>
  <div class="new-chat-view">
    <!-- 未添加项目：AI 功能门禁 -->
    <NotesGate v-if="kbLoaded && !kbLibraries.length" @ready="onGateReady" />

    <template v-else>
      <div class="nc-inner">
        <div class="nc-hero">
          <AppIcon name="sailboat" :size="140" :stroke-width="1" class="hero-mark" />
          <h1 class="hero-greet">{{ greetingText }}</h1>
        </div>

        <div class="nc-composer">
          <div v-if="pendingImages.length" class="nc-images">
            <div v-for="(img, i) in pendingImages" :key="i" class="nc-img">
              <img :src="'data:' + img.mimeType + ';base64,' + img.data" alt="" />
              <button class="nc-img-del" @click="removeImage(i)">×</button>
            </div>
          </div>
          <div class="nc-top-row">
            <span class="proj-pick" title="选择归属项目（发送后不可更换）">
              <AppIcon name="folder" :size="14" />
              <select class="nc-project" v-model="selectedProjectId" :disabled="sending" @change="onProjectChange">
                <option :value="null">不绑定项目</option>
                <option v-for="p in workProjects" :key="p.id" :value="p.id">{{ p.name }}</option>
                <option :value="NEW_PROJECT">＋ 新建项目…</option>
              </select>
              <AppIcon name="chevron-down" :size="12" />
            </span>
          </div>
          <textarea
            ref="ncInputRef"
            v-model="inputText"
            class="nc-input"
            rows="3"
            placeholder="描述这次对话要做的事，Enter 发送…"
            @keydown.enter.exact.prevent="sendMessage()"
            @paste="handlePaste"
          ></textarea>
          <div class="nc-bar">
            <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="handleImageUpload" />
            <button class="nc-tool" title="添加图片" @click="handleImageClick()"><AppIcon name="paperclip" :size="15" /></button>
            <span class="model-pick" title="选择模型">
              <select class="nc-model" v-model="selectedModel" :disabled="modelsLoading">
                <option value="">默认模型</option>
                <option v-if="modelsLoading" value="" disabled>模型加载中…</option>
                <option v-for="m in piModels" :key="m.pattern" :value="m.pattern">{{ m.providerLabel }} · {{ m.name }}</option>
              </select>
              <AppIcon name="chevron-down" :size="12" />
            </span>
            <span class="nc-sp"></span>
            <button class="nc-send" :disabled="(!inputText.trim() && !pendingImages.length) || sending" title="发送" @click="sendMessage()">
              <AppIcon name="arrow-up" :size="16" />
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import NotesGate from '@/components/NotesGate.vue';
import AppIcon from '@/components/AppIcon.vue';

const API = window.electronAPI;
const router = useRouter();

// ========== 项目（会话归属在发送时一次性确定） ==========
const workProjects = ref<any[]>([]);
const NEW_PROJECT = '__new__';
const PROJECT_PICK_KEY = 'chat_home_project';
const selectedProjectId = ref<number | null | typeof NEW_PROJECT>(null);

// ========== 门禁与数据 ==========
const kbLibraries = ref<any[]>([]);
const kbLoaded = ref(false);
const piModels = ref<{ provider: string; providerLabel: string; id: string; name: string; pattern: string; configured: boolean }[]>([]);
const selectedModel = ref('');
const modelsLoading = ref(false);
const CHAT_MODEL_KEY = 'chat_home_model_pi';

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
    piModels.value = (res?.models || []).filter((m: any) => m.pattern);
    const saved = localStorage.getItem(CHAT_MODEL_KEY);
    if (saved && piModels.value.some((m) => m.pattern === saved)) {
      selectedModel.value = saved;
    } else if (!selectedModel.value && piModels.value.some((m) => m.configured)) {
      const first = piModels.value.find((m) => m.configured);
      if (first) selectedModel.value = first.pattern;
    }
  } catch { piModels.value = []; }
  finally { modelsLoading.value = false; }
}

async function onGateReady() {
  await Promise.all([loadKbLibraries(), loadWorkProjects(), loadPiModels()]);
  restoreProjectPick();
  nextTick(() => ncInputRef.value?.focus());
}

// ========== 问候语 ==========
const greetingText = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '夜深啦，别忘了照顾好自己哦';
  if (h < 12) return '早上好，准备好开始今天了吗';
  if (h < 14) return '中午好，劳逸结合更重要';
  if (h < 18) return '下午好，继续保持节奏';
  return '晚上好，今天辛苦了';
});

// ========== 项目选择 ==========
function rememberProjectPick() {
  try {
    if (typeof selectedProjectId.value === 'number') localStorage.setItem(PROJECT_PICK_KEY, String(selectedProjectId.value));
    else localStorage.removeItem(PROJECT_PICK_KEY);
  } catch {}
}
function restoreProjectPick() {
  const saved = Number(localStorage.getItem(PROJECT_PICK_KEY) || '');
  if (Number.isFinite(saved) && workProjects.value.some((p: any) => p.id === saved)) selectedProjectId.value = saved;
}
function savedProjectPick(): number | null {
  const n = Number(localStorage.getItem(PROJECT_PICK_KEY) || '');
  return Number.isFinite(n) && workProjects.value.some((p: any) => p.id === n) ? n : null;
}

async function onProjectChange() {
  if (selectedProjectId.value === NEW_PROJECT) {
    await createProjectFromPicker();
    return;
  }
  rememberProjectPick();
}

async function createProjectFromPicker() {
  const previous = savedProjectPick();
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir) { selectedProjectId.value = previous; return; }
    const base = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '新项目';
    const name = (prompt('项目名称', base) || '').trim() || base;
    const p = await API.project.add(name, 'note', dir, '', '');
    await loadWorkProjects();
    selectedProjectId.value = p.id;
    rememberProjectPick();
  } catch (e: any) {
    selectedProjectId.value = previous;
    alert('创建项目失败: ' + (e?.message || e));
  }
}

// ========== 图片 ==========
const pendingImages = ref<{ data: string; mimeType: string }[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);

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

// ========== 发送：懒创建会话，交接给详情页发首条消息 ==========
const inputText = ref('');
const sending = ref(false);
const ncInputRef = ref<HTMLTextAreaElement | null>(null);
const HANDOFF_KEY = 'new_chat_handoff';

async function sendMessage() {
  const text = inputText.value.trim();
  if ((!text && !pendingImages.value.length) || sending.value) return;
  sending.value = true;
  const pid = selectedProjectId.value === NEW_PROJECT
    ? null
    : (typeof selectedProjectId.value === 'number' ? selectedProjectId.value : null);
  const id = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    await API.chat.createSession(id, pid, '新对话', 'general', 'general', 'ui');
    rememberProjectPick();
    const images = pendingImages.value.map((img) => ({ data: img.data, mimeType: img.mimeType }));
    // 首条消息交给详情页发送：它的 chat 事件监听已就绪，流式回包不丢
    try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ sessionId: id, text, images })); } catch {}
    inputText.value = '';
    pendingImages.value = [];
    await router.replace({ path: '/chat', query: { session: id } });
  } catch (e: any) {
    alert('创建对话失败: ' + (e?.message || e));
  } finally {
    sending.value = false;
  }
}

// ========== 生命周期 ==========
onMounted(async () => {
  await Promise.all([loadKbLibraries(), loadWorkProjects(), loadPiModels()]);
  restoreProjectPick();
  nextTick(() => ncInputRef.value?.focus());
});
</script>

<style scoped>
.new-chat-view {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  background: var(--bg-main);
}
.nc-inner {
  width: 100%;
  max-width: 640px;
  padding: 13vh 24px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.nc-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 30px;
}
.hero-mark {
  color: var(--text-primary);
  opacity: 0.13;
}
.hero-greet {
  margin: 8px 0 0;
  font-size: 26px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: 0.01em;
  text-align: center;
}
.proj-pick {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 9px;
  border-radius: 7px;
  color: var(--text-secondary);
  transition: background 0.15s;
}
.proj-pick:hover { background: var(--hover); }
.proj-pick svg { color: var(--text-muted); flex-shrink: 0; }
.nc-project {
  appearance: none;
  -webkit-appearance: none;
  border: none;
  background: none;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  outline: none;
  max-width: 260px;
}
.nc-project:hover { color: var(--text-primary); }
.nc-project option { color: var(--text-primary); background: var(--surface); }
.nc-composer {
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
.nc-composer:focus-within { border-color: var(--primary); }
.nc-images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 14px 0;
}
.nc-img {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.nc-img img { width: 100%; height: 100%; object-fit: cover; }
.nc-img-del {
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
.nc-input {
  width: 100%;
  border: none;
  outline: none;
  background: none;
  resize: none;
  font: inherit;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  padding: 8px 16px 4px;
  min-height: 84px;
}
.nc-input::placeholder { color: var(--text-muted); }
.nc-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 10px;
}
.nc-sp { flex: 1; }
.model-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 7px;
  color: var(--text-secondary);
  transition: background 0.15s;
}
.model-pick:hover { background: var(--hover); }
.model-pick svg { color: var(--text-muted); flex-shrink: 0; }
.nc-model {
  appearance: none;
  -webkit-appearance: none;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  outline: none;
  cursor: pointer;
  max-width: 220px;
}
.nc-model:hover { color: var(--text-primary); }
.nc-model option { color: var(--text-primary); background: var(--surface); }
.nc-tool {
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
.nc-tool:hover { background: var(--hover); color: var(--text-primary); }
.nc-send {
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
.nc-send:hover:not(:disabled) { background: var(--primary-dark); }
.nc-send:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
