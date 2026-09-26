<template>
  <div class="tools-view">
    <aside class="tool-sidebar">
      <div class="sidebar-title">AI 工具箱</div>
      <div v-for="group in groups" :key="group.name" class="group">
        <div class="group-title">{{ group.name }}</div>
        <div
          v-for="t in group.items"
          :key="t.id"
          class="tool-item"
          :class="{ active: activeId === t.id }"
          @click="switchTool(t.id)"
        >
          <span class="tool-item-icon">{{ t.icon }}</span>
          <span class="tool-item-name">{{ t.name }}</span>
        </div>
      </div>
    </aside>

    <main class="tool-main">
      <template v-if="activeTool">
        <div class="tool-head">
          <h2 class="tool-head-title">{{ activeTool.icon }} {{ activeTool.name }}</h2>
          <span class="tool-head-desc">{{ activeTool.desc }}</span>
        </div>

        <div class="tab-bar">
          <div class="tab-item" :class="{ active: activeTab === 'generate' }" @click="switchTab('generate')">生成</div>
          <div class="tab-item" :class="{ active: activeTab === 'history' }" @click="switchTab('history')">历史</div>
        </div>

        <!-- 生成 Tab：表单区 -->
        <div v-if="activeTab === 'generate' && !running && !outputText && !imgDataUrl && !error" class="form-area">
          <div v-for="f in activeTool.fields" :key="f.key" class="form-row">
            <label class="form-label">{{ f.label }}</label>
            <textarea
              v-if="f.type === 'textarea'"
              v-model="form[f.key]"
              class="form-input form-textarea"
              :placeholder="f.placeholder"
              rows="3"
            ></textarea>
            <select
              v-else-if="f.type === 'select'"
              v-model="form[f.key]"
              class="form-input"
            >
              <option v-for="opt in f.options" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else
              v-model="form[f.key]"
              class="form-input"
              :type="f.type === 'number' ? 'number' : 'text'"
              :placeholder="f.placeholder"
            />
          </div>

          <!-- 图片生成：服务配置 -->
          <div v-if="activeTool.id === 'image'" class="img-config">
            <div class="img-config-toggle" @click="imgConfigOpen = !imgConfigOpen">
              {{ imgConfigOpen ? '收起图像服务设置 ▲' : '图像服务设置 ▼' }}
            </div>
            <div v-if="imgConfigOpen" class="img-config-body">
              <div class="form-row">
                <label class="form-label">API 地址</label>
                <input v-model="imgConfig.baseUrl" class="form-input" placeholder="https://api.openai.com/v1" />
              </div>
              <div class="form-row">
                <label class="form-label">API Key</label>
                <input v-model="imgConfig.apiKey" class="form-input" type="password" placeholder="sk-..." />
              </div>
              <div class="form-row">
                <label class="form-label">模型</label>
                <input v-model="imgConfig.model" class="form-input" placeholder="dall-e-3 / sd 或兼容模型" />
              </div>
              <button class="btn btn-secondary btn-sm" @click="saveImgConfig">保存图像服务配置</button>
            </div>
          </div>

          <!-- 网络抓取：目标数据集 -->
          <div v-if="activeTool.id === 'fetch'" class="form-row">
            <label class="form-label">存到数据集（可选）</label>
            <select v-model="form.datasetId" class="form-input">
              <option value="">不存储，仅预览</option>
              <option v-for="d in datasets" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </div>

          <div class="form-actions">
            <button class="btn btn-primary" :disabled="!canRun" @click="run">{{ activeTool.actionLabel || '开始生成' }}</button>
          </div>
        </div>

        <!-- 生成 Tab：结果区 -->
        <div v-else-if="activeTab === 'generate'" class="output-area">
          <div class="output-head">
            <span class="output-status">
              <span class="spinner"></span>
              {{ running ? '生成中，请稍候...' : '完成' }}
            </span>
            <div class="output-actions">
              <button v-if="activeTool.id !== 'image'" class="btn btn-secondary btn-sm" @click="copyResult">复制</button>
              <button v-if="activeTool.export" class="btn btn-secondary btn-sm" @click="exportResult">
                {{ activeTool.exportLabel || '导出' }}
              </button>
              <button class="btn btn-secondary btn-sm" @click="resetView">重新开始</button>
            </div>
          </div>

          <div v-if="activeTool.id === 'image'" class="img-result">
            <img v-if="imgDataUrl" :src="imgDataUrl" class="img-preview" />
            <div v-else-if="running" class="img-placeholder">图片生成中...</div>
            <div v-if="error" class="output-error">{{ error }}</div>
            <div v-if="imgDataUrl && !running" class="output-actions">
              <button class="btn btn-primary btn-sm" @click="saveImage">保存图片</button>
            </div>
          </div>

          <div v-else class="output-text">{{ displayText }}</div>

          <!-- 历史相关操作 -->
          <div v-if="!running && outputText" class="history-hint">
            <button class="btn btn-secondary btn-sm" @click="switchTab('history')">查看历史记录</button>
          </div>
        </div>

        <!-- 历史 Tab -->
        <div v-if="activeTab === 'history'" class="history-view">
          <div class="history-head">
            <div class="history-head-title">{{ activeTool.icon }} {{ activeTool.name }} · 历史记录</div>
            <div class="history-head-actions">
              <button class="btn btn-secondary btn-sm" @click="clearHistory">清空</button>
            </div>
          </div>
          <div v-if="historyList.length === 0" class="history-empty">暂无历史记录。生成过的内容会自动保存在这里。</div>
          <div class="history-layout">
            <div class="history-list">
              <div
                v-for="h in historyList"
                :key="h.id"
                class="history-item"
                :class="{ active: h.id === selectedHistoryId }"
                @click="openHistoryItem(h)"
              >
                <div class="history-item-title">{{ h.name || '(未命名)' }}</div>
                <div class="history-item-time">{{ h.created_at }}</div>
              </div>
            </div>
            <div class="history-detail">
              <template v-if="selectedHistory">
                <div class="history-detail-actions">
                  <span class="history-detail-time">生成于 {{ selectedHistory.created_at }}</span>
                  <div>
                    <button v-if="selectedHistory.result_type === 'image'" class="btn btn-secondary btn-sm" @click="copyResultText">复制路径</button>
                    <button v-else class="btn btn-secondary btn-sm" @click="copyResultText">复制内容</button>
                    <button v-if="selectedHistory.result_type !== 'image'" class="btn btn-secondary btn-sm" @click="exportHistory">导出</button>
                    <button class="btn btn-secondary btn-sm" @click="removeHistory">删除</button>
                  </div>
                </div>
                <img v-if="selectedHistory.result_type === 'image'" :src="historyImageSrc" class="img-preview" />
                <div v-else class="history-content" v-html="renderMarkdown(selectedHistory.result)"></div>
              </template>
              <div v-else class="history-empty">选择左侧一条记录查看内容</div>
            </div>
          </div>
        </div>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { marked } from 'marked';

interface Field {
  key: string;
  label: string;
  type: 'text' | 'number' | 'textarea' | 'select';
  placeholder?: string;
  options?: string[];
  default?: string | number;
}

interface Tool {
  id: string;
  name: string;
  icon: string;
  desc: string;
  actionLabel?: string;
  export?: boolean;
  exportLabel?: string;
  fields: Field[];
}

const groups = [
  {
    name: '内容生成',
    items: [
      { id: 'ppt', name: '生成演示', icon: '📊', desc: '输入主题与详细要求，AI 基于笔记库内容生成演示文稿，可导出 HTML 或 PPTX。', actionLabel: '生成演示大纲', export: true, exportLabel: '导出', fields: [
        { key: 'topic', label: '主题', type: 'text', placeholder: '如：公司产品季度汇报' },
        { key: 'pages', label: '页数', type: 'number', default: 8, placeholder: '约多少页' },
        { key: 'style', label: '风格', type: 'select', options: ['商务汇报', '教学课件', '学术汇报', '产品发布', '创意提案'], default: '商务汇报' },
        { key: 'exportFormat', label: '导出格式', type: 'select', options: ['HTML 演示（单文件，浏览器打开）', 'PPTX（Office 演示文稿）', '两者都要'], default: 'HTML 演示（单文件，浏览器打开）' },
        { key: 'requirements', label: '详细要求（可选）', type: 'textarea', placeholder: '补充目标听众、重点内容、数据要求、页面结构等，如：面向投资人的融资路演，重点突出市场规模和财务数据，最后附风险提示页' },
      ] },
      { id: 'report', name: '写周报/日报', icon: '📝', desc: '自动查询本地待办、数据集与笔记库，生成结构化日报/周报。', actionLabel: '生成报告', export: true, exportLabel: '导出 .md', fields: [
        { key: 'type', label: '报告类型', type: 'select', options: ['日报', '周报'], default: '周报' },
        { key: 'period', label: '时间范围（可选）', type: 'text', placeholder: '如：2026-07-27 ~ 2026-08-02' },
        { key: 'notes', label: '补充要点（可选）', type: 'textarea', placeholder: '补充希望写进报告的进展、成果或问题...' },
      ] },
      { id: 'mindmap', name: '思维导图', icon: '🧠', desc: '输入主题，AI 生成结构化大纲，可导出 FreeMind .mm 文件。', actionLabel: '生成导图', export: true, exportLabel: '导出 .mm', fields: [
        { key: 'topic', label: '主题', type: 'text', placeholder: '如：2026 年个人成长计划' },
        { key: 'branches', label: '主分支数', type: 'number', default: 4, placeholder: '几个主分支' },
      ] },
      { id: 'copywriting', name: '写文案', icon: '✍️', desc: '生成公众号文章、朋友圈、短视频脚本或广告文案。', actionLabel: '生成文案', export: true, exportLabel: '导出 .md', fields: [
        { key: 'kind', label: '文案类型', type: 'select', options: ['公众号文章', '朋友圈', '短视频脚本', '广告文案'], default: '公众号文章' },
        { key: 'topic', label: '主题', type: 'text', placeholder: '如：AI 工具如何提升工作效率' },
        { key: 'style', label: '风格要求（可选）', type: 'text', placeholder: '如：轻松口语化、专业严谨' },
      ] },
    ],
  },
  {
    name: '数据工具',
    items: [
      { id: 'fetch', name: '网络抓取', icon: '🌐', desc: '抓取网页/JSON 接口内容，预览并可存入数据集。', actionLabel: '开始抓取', export: true, exportLabel: '导出 .txt', fields: [
        { key: 'url', label: 'URL 地址', type: 'text', placeholder: 'https://example.com/data.json' },
      ] },
      { id: 'image', name: '生成图片', icon: '🎨', desc: '输入提示词，调用图像服务生成图片并保存到本地。', actionLabel: '生成图片', export: false, fields: [
        { key: 'prompt', label: '提示词', type: 'textarea', placeholder: '如：一只戴着宇航员头盔的柯基犬，数字艺术风格' },
        { key: 'size', label: '尺寸', type: 'select', options: ['1024x1024', '1024x1792', '1792x1024', '512x512'], default: '1024x1024' },
      ] },
    ],
  },
];

const tools: Tool[] = groups.flatMap(g => g.items);

const activeId = ref<string>('ppt');
const activeTool = computed(() => tools.find(t => t.id === activeId.value)!);

const form = reactive<Record<string, any>>({});
const resetForm = () => {
  for (const k of Object.keys(form)) delete form[k];
  for (const f of activeTool.value.fields) form[f.key] = f.default ?? '';
};

const running = ref(false);
const outputText = ref('');
const error = ref('');
let streamId = '';
let sessionSeq = 0;

const datasets = ref<any[]>([]);
const imgDataUrl = ref('');
const imgConfig = reactive({ baseUrl: '', apiKey: '', model: '' });
const imgConfigOpen = ref(false);

const canRun = computed(() => {
  const t = activeTool.value;
  if (t.id === 'ppt' || t.id === 'mindmap' || t.id === 'copywriting') return !!form.topic;
  if (t.id === 'report') return true;
  if (t.id === 'fetch') return !!form.url;
  if (t.id === 'image') return !!form.prompt;
  return false;
});

/** 输出区展示：JSON（演示）转为可读大纲，其余原样 */
const displayText = computed(() => {
  const raw = outputText.value;
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === 'object' && (obj.pages || Array.isArray(obj))) {
      const pages: any[] = Array.isArray(obj) ? obj : (obj.pages || []);
      const lines: string[] = [`# ${obj.title || ''}`, ''];
      for (const p of pages) {
        lines.push(`## ${p.title || ''}`);
        const pts: string[] = p.points || p.items || [];
        for (const pt of pts) lines.push(`- ${pt}`);
        lines.push('');
      }
      return lines.join('\n').trim();
    }
  } catch {}
  return raw;
});

const switchTool = (id: string) => {
  if (running.value) return;
  activeTab.value = 'generate';
  activeId.value = id;
  resetView();
};

const resetView = () => {
  running.value = false;
  outputText.value = '';
  error.value = '';
  imgDataUrl.value = '';
  resetForm();
};

// ========== Tab ==========
const activeTab = ref<'generate' | 'history'>('generate');

const switchTab = (tab: 'generate' | 'history') => {
  if (tab === 'generate') {
    activeTab.value = 'generate';
  } else {
    activeTab.value = 'history';
    loadHistory();
  }
};

// ========== 历史记录 ==========
const historyList = ref<any[]>([]);
const selectedHistoryId = ref<number | null>(null);
const selectedHistory = ref<any>(null);
const historyImageSrc = ref('');

const loadHistory = async () => {
  try {
    historyList.value = await window.electronAPI.aitool.historyList(activeTool.value.id) || [];
    selectedHistory.value = null;
    selectedHistoryId.value = null;
    historyImageSrc.value = '';
  } catch {
    historyList.value = [];
  }
};

const openHistoryItem = async (h: any) => {
  selectedHistoryId.value = h.id;
  try {
    const full = await window.electronAPI.aitool.historyGet(h.id);
    selectedHistory.value = full;
    if (full.result_type === 'image') {
      const res = await window.electronAPI.aitool.historyImage(full.result).catch(() => ({ ok: false }));
      if (res && res.ok && res.dataUrl) {
        historyImageSrc.value = res.dataUrl;
      }
    }
  } catch {
    selectedHistory.value = null;
  }
};

const copyResultText = async () => {
  if (!selectedHistory.value) return;
  const text = selectedHistory.value.result_type === 'image' ? selectedHistory.value.result : selectedHistory.value.result;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
};

const exportHistory = async () => {
  if (!selectedHistory.value) return;
  const h = selectedHistory.value;
  const name = h.name || activeTool.value.name;
  try {
    const res = await window.electronAPI.aitool.exportText(h.result, name, '.md');
    if (!res.ok && !res.canceled) error.value = res.error || '导出失败';
  } catch (e: any) {
    error.value = e.message || String(e);
  }
};

const removeHistory = async () => {
  if (!selectedHistory.value) return;
  await window.electronAPI.aitool.historyRemove(selectedHistory.value.id);
  selectedHistory.value = null;
  selectedHistoryId.value = null;
  historyImageSrc.value = '';
  loadHistory();
};

const clearHistory = async () => {
  await window.electronAPI.aitool.historyClear(activeTool.value.id);
  selectedHistory.value = null;
  selectedHistoryId.value = null;
  historyImageSrc.value = '';
  loadHistory();
};

const renderMarkdown = (content: string) => {
  if (!content) return '';
  try { return marked(content); } catch { return content; }
};

const onDelta = (e: any) => {
  if (e && e.sessionId === streamId) {
    outputText.value += e.text || '';
  }
};

onMounted(() => {
  resetForm();
  window.electronAPI?.on('aitool:delta', onDelta);
  window.electronAPI?.ds.list().then((list: any[]) => { datasets.value = list || []; }).catch(() => {});
  window.electronAPI?.aitool.imageConfig().then((cfg: any) => {
    imgConfig.baseUrl = cfg?.baseUrl || 'https://api.openai.com/v1';
    imgConfig.apiKey = cfg?.apiKey || '';
    imgConfig.model = cfg?.model || 'dall-e-3';
  }).catch(() => {});
});

onBeforeUnmount(() => {
  window.electronAPI?.removeAllListeners('aitool:delta');
});

const buildPrompt = (): string => {
  const t = activeTool.value;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  switch (t.id) {
    case 'ppt': {
      const bodyPages = Math.max((form.pages || 8) - 1, 4);
      return `请为以下主题设计一份演示文稿。\n\n主题：${form.topic}\n正文页数：必须正好 ${bodyPages} 页（多了少了都算不合格）\n风格：${form.style || '商务汇报'}\n${form.requirements ? `详细要求：\n${form.requirements}\n` : ''}\n\n请基于上方笔记库资料创作，引用其中的真实项目、数据、名称，每页要点要具体详实，禁止空话套话。\n\n只输出一个 JSON 对象（不要输出任何其他文字，不要用 markdown 代码块包裹），格式严格如下：\n{"title":"演示标题","pages":[{"title":"第1页标题","points":["要点1","要点2","要点3"]},{"title":"第2页标题","points":["要点1","要点2"]}]}\n\n要求：\n1. title 为主题名\n2. pages 数组必须有 ${bodyPages} 个元素，每个元素是一页\n3. 每页 points 写 3-5 条要点，具体、有数据、有结论\n4. 第一页为主题介绍，最后一页为总结或行动建议\n5. 只输出 JSON，不要出现任何解释性文字`;
    }
    case 'report':
      return `请生成一份${form.type}。\n\n当前日期：${today}\n${form.period ? `时间范围：${form.period}\n` : ''}\n\n上方已提供笔记库文件内容，你可以结合笔记中的工作记录、项目进展来写；也可以调用工具查询待办、数据集等本地数据：\n\n要求：\n1. 开头概述整体情况\n2. 分模块列出完成的事项与进展（引用具体笔记内容、数据）\n3. 列出未完成/待跟进事项\n4. 下一步计划\n5. 遇到的问题与需要的支持\n${form.notes ? `补充要点：\n${form.notes}\n` : ''}\n用 Markdown 格式输出，标题用 ##。`;
    case 'mindmap':
      return `请为主题「${form.topic}」设计一张思维导图大纲，用 Markdown 格式输出：\n\n格式要求：\n- 第一行 "# ${form.topic}" 作为中心主题\n- 主分支用 "## 主分支名"\n- 子分支用 "- 子节点"（每个主分支下 2-4 个子节点）\n- 约 ${form.branches || 4} 个主分支，内容有层次、逻辑清晰`;
    case 'copywriting':
      return `请撰写一篇${form.kind}。\n\n主题：${form.topic}\n${form.style ? `风格要求：${form.style}\n` : ''}\n\n要求：内容精炼、有吸引力、符合目标读者阅读习惯，用 Markdown 格式输出。`;
    default:
      return '';
  }
};

const run = async () => {
  if (running.value) return;
  if (activeTool.value.id === 'fetch') { doFetch(); return; }
  if (activeTool.value.id === 'image') { doImage(); return; }
  running.value = true;
  error.value = '';
  outputText.value = '';
  const sid = activeTool.value.id + '_' + (++sessionSeq);
  streamId = sid;
  const name = form.topic || (activeTool.value.id === 'report' ? (form.type === '日报' ? '日报' : '周报') : activeTool.value.name);
  const params = JSON.stringify({ ...form });
  try {
    const res = await window.electronAPI.aitool.generate(activeTool.value.id, buildPrompt(), sid, name, params);
    if (res.ok) {
      outputText.value = res.text || '';
    } else {
      error.value = res.error || '生成失败';
    }
  } catch (e: any) {
    error.value = e.message || String(e);
  } finally {
    running.value = false;
  }
};

const doFetch = async () => {
  running.value = true;
  error.value = '';
  outputText.value = '';
  try {
    const res = await window.electronAPI.aitool.fetch(form.url);
    if (!res.ok) {
      error.value = res.error || '抓取失败';
      return;
    }
    outputText.value = `URL: ${res.url}\n标题: ${res.title || ''}\n类型: ${res.contentType || ''}\n\n${res.text || ''}`;
    if (form.datasetId) {
      const obj: any = { url: res.url, title: res.title || '', content_type: res.contentType || '' };
      if (res.contentType && res.contentType.includes('json')) {
        try {
          const parsed = JSON.parse(res.text || '[]');
          if (Array.isArray(parsed)) {
            for (const item of parsed.slice(0, 200)) {
              await window.electronAPI.ds.insert(Number(form.datasetId), { ...obj, ...item });
            }
            outputText.value += `\n\n已导入 ${Math.min(parsed.length, 200)} 条记录到数据集。`;
            return;
          }
          obj.data = res.text;
        } catch {}
      } else {
        obj.text = (res.text || '').slice(0, 3000);
      }
      await window.electronAPI.ds.insert(Number(form.datasetId), obj);
      outputText.value += '\n\n已存入数据集。';
    }
  } catch (e: any) {
    error.value = e.message || String(e);
  } finally {
    running.value = false;
  }
};

const doImage = async () => {
  running.value = true;
  error.value = '';
  imgDataUrl.value = '';
  try {
    const [w, h] = (form.size || '1024x1024').split('x').map(Number);
    const res = await window.electronAPI.aitool.imageGenerate(form.prompt, w, h, form.prompt.slice(0, 30));
    if (res.ok) {
      imgDataUrl.value = `data:${res.mimeType || 'image/png'};base64,${res.b64}`;
    } else {
      error.value = res.error || '生成失败';
    }
  } catch (e: any) {
    error.value = e.message || String(e);
  } finally {
    running.value = false;
  }
};

const copyResult = async () => {
  try {
    await navigator.clipboard.writeText(outputText.value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = outputText.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
};

const exportResult = async () => {
  const t = activeTool.value;
  const baseName = form.topic || (t.id === 'report' ? (form.type === '日报' ? '日报' : '周报') : t.name);
  let res: any;
  try {
    if (t.id === 'ppt') {
      const fmt = form.exportFormat || '';
      const wantBoth = fmt.includes('两者');
      let wantPptx = wantBoth || fmt.includes('PPTX');
      let wantHtml = wantBoth || fmt.includes('HTML');
      if (!wantPptx && !wantHtml) wantHtml = true;
      let paths: string[] = [];
      if (wantPptx) {
        res = await window.electronAPI.aitool.exportPptx(outputText.value, baseName);
        if (res.ok) paths.push(res.path);
        else if (!res.canceled) { error.value = res.error || '导出 PPTX 失败'; return; }
      }
      if (wantHtml) {
        res = await window.electronAPI.aitool.exportHtml(outputText.value, baseName);
        if (res.ok) paths.push(res.path);
        else if (!res.canceled) { error.value = res.error || '导出 HTML 失败'; return; }
      }
      if (paths.length) {
        outputText.value = '✓ 已导出:\n' + paths.map(p => '  ' + p).join('\n') + '\n\n' + outputText.value;
      }
      return;
    }
    if (t.id === 'mindmap') res = await window.electronAPI.aitool.exportMindmap(outputText.value, baseName);
    else if (t.id === 'fetch') res = await window.electronAPI.aitool.exportText(outputText.value, baseName, '.txt');
    else res = await window.electronAPI.aitool.exportText(outputText.value, baseName, '.md');
    if (res.ok) {
      outputText.value = '✓ 已导出: ' + res.path + '\n\n' + outputText.value;
    } else if (!res.canceled) {
      error.value = res.error || '导出失败';
    }
  } catch (e: any) {
    error.value = e.message || String(e);
  }
};

const saveImage = async () => {
  const dataUrl = imgDataUrl.value;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return;
  try {
    const res = await window.electronAPI.aitool.imageSave(m[2], m[1], form.prompt.slice(0, 30));
    if (res.ok) {
      error.value = '';
      outputText.value = '✓ 已保存: ' + res.path;
      running.value = false;
    }
  } catch (e: any) {
    error.value = e.message || String(e);
  }
};

const saveImgConfig = async () => {
  try {
    await window.electronAPI.aitool.imageSetConfig(imgConfig.baseUrl, imgConfig.apiKey, imgConfig.model);
    imgConfigOpen.value = false;
    outputText.value = '✓ 图像服务配置已保存';
  } catch (e: any) {
    error.value = e.message || String(e);
  }
};
</script>

<style scoped>
.tools-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.tool-sidebar {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: white;
  overflow-y: auto;
  padding: 16px 0;
}

.sidebar-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 0 16px 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.group-title {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 10px 16px 4px;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: all 0.15s;
}

.tool-item:hover {
  background: var(--bg-hover, #f5f5f5);
}

.tool-item.active {
  background: color-mix(in srgb, var(--primary) 12%, white);
  color: var(--primary);
  font-weight: 600;
  border-right: 3px solid var(--primary);
}

/* ===== Tab 栏 ===== */
.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.tab-item {
  padding: 8px 18px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all 0.15s;
  user-select: none;
}

.tab-item:hover {
  color: var(--primary);
}

.tab-item.active {
  color: var(--primary);
  font-weight: 600;
  border-bottom-color: var(--primary);
}

.tool-main {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  min-width: 0;
}

.tool-head {
  margin-bottom: 20px;
}

.tool-head-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.tool-head-desc {
  font-size: 13px;
  color: var(--text-secondary);
}

.form-area {
  max-width: 560px;
}

.form-row {
  margin-bottom: 14px;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  background: white;
  outline: none;
  transition: border-color 0.2s;
}

.form-input:focus {
  border-color: var(--primary);
}

.form-textarea {
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
}

.form-actions {
  margin-top: 20px;
}

.img-config {
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  padding: 12px;
  margin-bottom: 14px;
}

.img-config-toggle {
  font-size: 13px;
  color: var(--primary);
  cursor: pointer;
  user-select: none;
}

.img-config-body {
  margin-top: 12px;
}

.output-area {
  max-width: 720px;
}

.output-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.output-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.output-actions {
  display: flex;
  gap: 8px;
}

.output-text {
  background: white;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 16px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
  min-height: 200px;
  max-height: 60vh;
  overflow-y: auto;
}

.output-error {
  color: #dc2626;
  font-size: 13px;
  margin-top: 10px;
  white-space: pre-wrap;
}

.img-result {
  text-align: center;
}

.img-preview {
  max-width: 100%;
  max-height: 55vh;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-md);
}

.img-placeholder {
  padding: 80px 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.btn {
  padding: 9px 20px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: white;
  border-color: var(--border);
  color: var(--text-primary);
}

.btn-secondary:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}

/* ===== 历史记录 ===== */
.history-hint {
  margin-top: 12px;
}

.history-view {
  max-width: 960px;
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.history-head-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.history-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.history-list {
  width: 260px;
  flex-shrink: 0;
  background: white;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow-y: auto;
  max-height: 60vh;
}

.history-item {
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
}

.history-item:last-child {
  border-bottom: none;
}

.history-item:hover {
  background: var(--bg-hover, #f5f5f5);
}

.history-item.active {
  background: color-mix(in srgb, var(--primary) 10%, white);
}

.history-item-title {
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-item-time {
  font-size: 11px;
  color: var(--text-secondary);
}

.history-detail {
  flex: 1;
  min-width: 0;
}

.history-detail-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  gap: 8px;
}

.history-detail-time {
  font-size: 12px;
  color: var(--text-secondary);
}

.history-content {
  background: white;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 16px 20px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
  color: var(--text-primary);
  max-height: 60vh;
  overflow-y: auto;
}

.history-content :deep(h1) {
  font-size: 20px;
  margin: 14px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.history-content :deep(h2) {
  font-size: 17px;
  margin: 12px 0 6px;
}

.history-content :deep(h3),
.history-content :deep(h4) {
  font-size: 15px;
  margin: 10px 0 4px;
}

.history-content :deep(p) {
  margin: 6px 0;
}

.history-content :deep(ul),
.history-content :deep(ol) {
  padding-left: 22px;
  margin: 6px 0;
}

.history-content :deep(li) {
  margin: 3px 0;
}

.history-content :deep(code) {
  background: #f1f5f9;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  font-family: Consolas, monospace;
}

.history-content :deep(pre) {
  background: #0f172a;
  color: #e2e8f0;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 8px 0;
}

.history-content :deep(pre code) {
  background: none;
  color: inherit;
  padding: 0;
}

.history-content :deep(blockquote) {
  border-left: 3px solid var(--primary);
  margin: 8px 0;
  padding: 4px 12px;
  background: #f8fafc;
  color: #475569;
  border-radius: 4px;
}

.history-content :deep(a) {
  color: var(--primary);
}

.history-content :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}

.history-content :deep(th),
.history-content :deep(td) {
  border: 1px solid var(--border);
  padding: 4px 10px;
}

.history-content :deep(strong) {
  font-weight: 600;
}

.history-empty {
  padding: 40px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
