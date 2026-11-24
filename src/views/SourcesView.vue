<template>
  <div class="page sources-view">
    <!-- ========== 页头 ========== -->
    <header class="page-head">
      <div>
        <h1 class="page-title">MCP<small>服务与接入</small></h1>
        <p class="page-sub">本机知识库对外提供 MCP 服务；外部 MCP 服务接入后，工具与数据由 AI 在对话中按需调用</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-primary" @click="showAddServer"><AppIcon name="plus" :size="13" />添加 MCP 服务</button>
      </div>
    </header>

    <!-- ========== 服务端：本机知识库服务 ========== -->
    <div class="section-head">
      <span class="section-tag">服务端</span>
      <span class="section-desc">对外提供能力 · 本机知识库 qihang-kb</span>
    </div>

    <section v-if="kb" class="panel kb-panel">
      <div class="kb-head">
        <div class="kb-title">
          <span class="kb-name">📚 本机知识库服务<small>qihang-kb · MCP</small></span>
          <span class="badge" :class="kb.running ? 'badge-success' : (kb.enabled ? 'badge-danger' : 'badge-gray')">
            {{ kb.running ? `运行中 · ${kb.port}` : (kb.enabled ? (kb.lastError || '未运行') : '已停用') }}
          </span>
          <span class="kb-meta">已索引 {{ kb.notesIndexed }} 篇笔记 · {{ kb.tools.length }} 个工具</span>
        </div>
        <div class="kb-actions">
          <label class="toggle" title="启用后外部 AI 工具可通过 MCP 检索本地知识库">
            <input type="checkbox" :checked="kb.enabled" :disabled="kbBusy" @change="toggleKb">
            <span class="slider"></span>
          </label>
          <button class="text-btn" :disabled="kbBusy || !kb.running" @click="reindexKb">{{ kbBusy ? '处理中…' : '重建索引' }}</button>
          <button class="text-btn" @click="regenKbToken">重置 Token</button>
        </div>
      </div>
      <div class="kb-body">
        <div class="kb-row">
          <span class="kb-label">MCP 地址</span>
          <code class="kb-code">{{ kb.url || '服务未运行' }}</code>
        </div>
        <div class="kb-row">
          <span class="kb-label">Token</span>
          <code class="kb-code kb-token">{{ kbTokenVisible ? kb.token : '••••••••••••' }}</code>
          <button class="text-btn" @click="kbTokenVisible = !kbTokenVisible">{{ kbTokenVisible ? '隐藏' : '显示' }}</button>
          <button class="text-btn" :disabled="!kb.token" @click="copyKbToken">复制</button>
        </div>
        <p class="kb-hint">给 Claude Code / Codex / Trae / opencode 接入时填「地址 + Bearer Token」；应用内对话自动注入，无需配置。仅监听 127.0.0.1，不对外暴露。</p>
      </div>
    </section>

    <!-- ========== 客户端：外部 MCP 服务 ========== -->
    <div class="section-head">
      <span class="section-tag client">客户端</span>
      <span class="section-desc">接入外部 MCP 服务 · 工具清单与数据按需读取，进入页面不主动请求</span>
    </div>

    <section class="panel client-panel">
      <!-- 左侧：服务列表（只读本地配置，不发起远端请求） -->
      <aside class="srv-list">
        <div class="srv-list-head">
          <span class="srv-list-title">外部服务<b>{{ servers.length }}</b></span>
          <button class="icon-btn" title="添加 MCP 服务" @click="showAddServer"><AppIcon name="plus" :size="14" /></button>
        </div>

        <div v-if="!loaded" class="list-hint">加载中…</div>
        <div v-else-if="servers.length === 0" class="list-empty">
          <p>还没有接入外部 MCP 服务</p>
          <button class="btn btn-sm btn-primary" @click="showAddServer"><AppIcon name="plus" :size="13" />添加服务</button>
        </div>
        <div v-else class="srv-items">
          <button
            v-for="s in servers" :key="s.id"
            class="srv-item" :class="{ active: s.id === openId }"
            @click="openServer(s)"
          >
            <span class="status-dot" :class="dotClass(s)"></span>
            <span class="srv-main">
              <span class="srv-name" :title="s.name || s.url">{{ s.name || hostOf(s.url) }}</span>
              <span class="srv-url" :title="s.url">{{ hostOf(s.url) }}</span>
            </span>
            <span v-if="s.toolCount" class="srv-tools">{{ s.toolCount }}</span>
          </button>
        </div>

        <button v-if="loaded && servers.length" class="srv-add" @click="showAddServer">
          <AppIcon name="plus" :size="13" />添加服务
        </button>
      </aside>

      <!-- 右侧：服务详情（选中后才读取工具清单，点业务域才拉数据） -->
      <div class="srv-detail">
        <div v-if="!selected" class="detail-empty">
          <AppIcon name="network" :size="26" class="empty-icon" />
          <p>选择左侧的 MCP 服务查看工具与配置</p>
          <p class="sub">进入本页不会主动读取远端数据。工具清单在打开服务时读取，业务数据在你选择业务域后才拉取；日常查询直接交给对话里的 AI。</p>
        </div>

        <template v-else>
          <div class="detail-head">
            <div class="detail-title">
              <h2>{{ selected.name || hostOf(selected.url) }}</h2>
              <span class="badge" :class="badgeClass(selected)" :title="selected.statusText || ''">{{ statusText(selected) }}</span>
            </div>
            <div class="detail-actions">
              <label class="toggle" title="启用后 AI 对话可调用该服务的工具">
                <input type="checkbox" :checked="selected.enabled" @change="toggleEnabled(selected)">
                <span class="slider"></span>
              </label>
              <button class="text-btn" @click="openToolModal">
                <AppIcon name="network" :size="12" />工具 {{ tools.length || (selected.toolCount || 0) }}
              </button>
              <button class="text-btn" :disabled="selected.testing" @click="testServer(selected)">
                <AppIcon name="refresh-cw" :size="12" />{{ selected.testing ? '测试中…' : '测试连接' }}
              </button>
              <button class="text-btn" @click="editServer(selected)"><AppIcon name="edit" :size="12" />编辑</button>
              <button class="text-btn text-btn-del" @click="removeServer(selected)"><AppIcon name="trash-2" :size="12" />删除</button>
            </div>
          </div>
          <div class="detail-url-row"><code class="detail-url">{{ selected.url }}</code></div>

          <div class="detail-tabs">
            <button :class="{ on: detailTab === 'chat' }" @click="detailTab = 'chat'">
              <AppIcon name="message-square" :size="12" />对话
            </button>
            <button :class="{ on: detailTab === 'data' }" @click="detailTab = 'data'">数据浏览</button>
          </div>

          <!-- 专属对话：只允许调用当前 MCP 服务的工具 -->
          <McpChatPanel
            v-show="detailTab === 'chat'"
            :key="selected.id"
            :server-id="selected.id"
            :server-name="selected.name || hostOf(selected.url)"
            :tools="tools"
          />

          <!-- 数据浏览 -->
          <div v-if="detailTab === 'data'" class="pane-body">
            <div class="pane-head">
              <span class="pane-hint">选择业务域后才拉取记录；日常查询可直接在「对话」里让 AI 调用。</span>
              <button class="text-btn" :disabled="toolsLoading" @click="loadTools(selected.id, true)">
                <AppIcon name="refresh-cw" :size="12" />{{ toolsLoading ? '读取中…' : '刷新工具' }}
              </button>
            </div>

            <div v-if="!toolsLoaded" class="none-row">
              请先读取工具清单，再浏览数据
              <button class="text-btn" @click="loadTools(selected.id)">读取工具清单</button>
            </div>
            <template v-else>
              <div class="dom-chips" v-if="domains.length">
                <button
                  v-for="d in domains" :key="d.tool"
                  class="mod-chip" :class="{ active: d.tool === currentTool }"
                  :title="d.description"
                  @click="selectDomain(d)"
                >{{ d.label }}</button>
              </div>
              <div v-else class="none-row">该服务没有可浏览的 list_* 工具</div>

              <div v-if="domains.length && !currentTool" class="none-row">选择一个业务域，按需拉取记录</div>

              <div class="table-wrap" v-if="currentTool">
                <table class="data-table" v-if="filteredRows.length">
                  <thead>
                    <tr>
                      <th v-for="c in columns" :key="c" :title="c">{{ c }}</th>
                      <th v-if="dimensions.length" class="th-ai">AI 分类</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(r, i) in filteredRows" :key="i">
                      <td v-for="c in columns" :key="c" :title="cellTitle(r[c])">{{ shortCell(r[c]) }}</td>
                      <td v-if="dimensions.length" class="td-ai">
                        <span v-for="(v, k) in rowLabels(r)" :key="k" class="badge badge-primary ai-label">{{ k }}:{{ v }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="none-row">{{ fetching ? '拉取中…' : '该域暂无记录（默认拉取近 30 天）' }}</div>
              </div>

              <div class="dim-box" v-if="dimensions.length">
                <div v-for="dim in dimensions" :key="dim.name" class="dim-row">
                  <span class="dim-name">{{ dim.name }}</span>
                  <button class="chip" :class="{ on: !filter[dim.name] }" @click="removeFilter(dim.name)">全部</button>
                  <button
                    v-for="v in dim.values" :key="v"
                    class="chip" :class="{ on: filter[dim.name] === v }"
                    @click="filter[dim.name] = filter[dim.name] === v ? '' : v"
                  >{{ v }}</button>
                </div>
              </div>

              <div class="fetch-bar" v-if="currentTool">
                <span class="total-hint" v-if="totalCount">共 {{ totalCount }} 条</span>
                <button class="text-btn" :disabled="fetching || !hasMore" @click="nextPage">
                  {{ fetching ? '加载中…' : (hasMore ? '下一页' : '没有更多了') }}
                </button>
                <span class="grow"></span>
                <button class="text-btn" :disabled="classifying" @click="openClassifyModal(false)">
                  {{ classifying ? 'AI 分类中…' : 'AI 分类' }}
                </button>
                <button class="text-btn" v-if="hasLabels" :disabled="classifying" @click="openClassifyModal(true)">重新分类</button>
              </div>
            </template>
          </div>
        </template>
      </div>
    </section>

    <!-- ========== 工具清单弹窗 ========== -->
    <div v-if="toolModalOpen && selected" class="modal-overlay" @click="toolModalOpen = false">
      <div class="modal-box tool-modal" @click.stop>
        <div class="modal-header">
          <h3>工具清单<small class="tool-count">{{ tools.length }}</small></h3>
          <button class="btn btn-secondary" @click="toolModalOpen = false">✕</button>
        </div>
        <div class="tool-search">
          <AppIcon name="search" :size="13" class="ts-ic" />
          <input v-model="toolKeyword" type="text" placeholder="搜索工具名或描述…">
          <button class="text-btn" :disabled="toolsLoading" @click="loadTools(selected.id, true)">
            {{ toolsLoading ? '读取中…' : '刷新' }}
          </button>
        </div>
        <div class="tool-modal-body">
          <p v-if="instructions" class="srv-instructions">{{ instructions }}</p>
          <div v-if="filteredTools.length" class="tool-list">
            <div v-for="t in filteredTools" :key="t.name" class="tool-item">
              <code class="tool-name">{{ t.name }}</code>
              <p class="tool-desc">{{ t.description || '（服务端未提供描述）' }}</p>
            </div>
          </div>
          <div v-else class="none-row">
            {{ toolsLoading ? '正在连接服务端…' : (toolsLoaded ? '没有匹配的工具' : '尚未读取工具清单') }}
          </div>
        </div>
      </div>
    </div>

    <!-- ========== AI 分类选模型弹窗 ========== -->
    <div v-if="classifyModalOpen" class="modal-overlay" @click="classifyModalOpen = false">
      <div class="modal-box" style="width:440px;" @click.stop>
        <div class="modal-header">
          <h3>{{ classifyForce ? '重新分类' : 'AI 分类' }}<small class="tool-count">{{ currentToolLabel }}</small></h3>
          <button class="btn btn-secondary" @click="classifyModalOpen = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>本次使用的模型</label>
            <select v-model="classifyModel" class="form-control">
              <option value="">默认（pi 默认模型）</option>
              <option v-for="m in classifyModels" :key="m.pattern" :value="m.pattern">{{ m.providerLabel }} · {{ m.name }}{{ m.configured ? '' : '（未配置 Key）' }}</option>
            </select>
          </div>
          <p class="form-hint">分类是手动触发的 AI 调用（一次最多 60 条），选个便宜的模型即可；已打标的记录不重复调用，只有新记录消耗 token。</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="classifyModalOpen = false">取消</button>
          <button class="btn btn-primary" @click="classifyCurrent(classifyForce)" :disabled="classifying">{{ classifying ? '分类中…' : '开始分类' }}</button>
        </div>
      </div>
    </div>

    <!-- ========== 添加/编辑弹窗 ========== -->
    <div v-if="showModal" class="modal-overlay" @click="showModal = false">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>{{ editingId ? '编辑 MCP 服务' : '添加 MCP 服务' }}</h3>
          <button class="btn btn-secondary" @click="showModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>URL *</label>
            <input type="text" class="form-control" v-model="form.url" placeholder="https://example.com/mcp">
          </div>
          <div class="form-group">
            <label>Token（Bearer，可空）</label>
            <input type="text" class="form-control" v-model="form.token" placeholder="qh_mcp_…">
          </div>
          <div class="form-group">
            <label class="toggle-label">
              <label class="toggle">
                <input type="checkbox" v-model="form.enabled">
                <span class="slider"></span>
              </label>
              启用（AI 对话可调用该 MCP 服务的工具）
            </label>
          </div>
          <p class="form-hint">名称无需填写：保存时自动读取服务端自报的名称。Token 明文保存在本机 config.json。</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showModal = false">取消</button>
          <button class="btn btn-primary" @click="saveServer" :disabled="saving">{{ saving ? '保存中（正在与服务端握手）…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import McpChatPanel from '@/components/McpChatPanel.vue';

const API = (window as any).electronAPI;

interface ServerConf {
  id: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  status?: 'ok' | 'error' | 'untested';
  statusText?: string;
  toolCount?: number;
  lastTestedAt?: string;
  testing?: boolean;
}

interface McpTool {
  name: string;
  description: string;
}

interface DomainInfo {
  tool: string;
  label: string;
  description: string;
}

interface ToolState {
  loaded: boolean;
  loading: boolean;
  tools: McpTool[];
  instructions: string;
}

// ========== 服务列表（只读本地配置） ==========
const servers = ref<ServerConf[]>([]);
const loaded = ref(false);
const openId = ref('');
const selected = computed(() => servers.value.find(s => s.id === openId.value) || null);

async function loadServers() {
  if (!API) { loaded.value = true; return; }
  try {
    const res = await API.mcp.list();
    servers.value = (res.servers || []).map((s: any) => ({ ...s, testing: false }));
    if (openId.value && !servers.value.some(s => s.id === openId.value)) {
      openId.value = '';
      resetData();
    }
  } catch (e) { console.error('加载 MCP 服务失败:', e); }
  loaded.value = true;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function dotClass(s: ServerConf): string {
  if (!s.enabled) return 'idle';
  if (s.status === 'ok') return 'ok';
  if (s.status === 'error') return 'bad';
  return 'idle';
}

function badgeClass(s: ServerConf): string {
  if (!s.enabled) return 'badge-gray';
  if (s.status === 'ok') return 'badge-success';
  if (s.status === 'error') return 'badge-danger';
  return 'badge-gray';
}

function statusText(s: ServerConf): string {
  if (!s.enabled) return '已停用';
  if (s.status === 'ok') return `已连接 · ${s.toolCount || 0} 个工具`;
  if (s.status === 'error') return '连接异常';
  return '未验证';
}

// ========== 工具清单（打开详情时才读取） ==========
const detailTab = ref<'chat' | 'data'>('chat');
const toolStates = ref<Record<string, ToolState>>({});

function toolState(id: string): ToolState {
  if (!toolStates.value[id]) {
    toolStates.value[id] = { loaded: false, loading: false, tools: [], instructions: '' };
  }
  return toolStates.value[id];
}

const currentTools = computed(() => (selected.value ? toolStates.value[selected.value.id] : undefined));
const tools = computed<McpTool[]>(() => currentTools.value?.tools || []);
const toolsLoaded = computed(() => !!currentTools.value?.loaded);
const toolsLoading = computed(() => !!currentTools.value?.loading);
const instructions = computed(() => currentTools.value?.instructions || '');

// 工具清单弹窗：长清单不再占用详情主区域
const toolModalOpen = ref(false);
const toolKeyword = ref('');
const filteredTools = computed(() => {
  const kw = toolKeyword.value.trim().toLowerCase();
  if (!kw) return tools.value;
  return tools.value.filter(t =>
    t.name.toLowerCase().includes(kw) || (t.description || '').toLowerCase().includes(kw));
});

function openToolModal() {
  toolKeyword.value = '';
  toolModalOpen.value = true;
  if (selected.value && !toolsLoaded.value) void loadTools(selected.value.id);
}

async function openServer(s: ServerConf) {
  if (openId.value === s.id) return;
  openId.value = s.id;
  detailTab.value = 'chat';
  toolModalOpen.value = false;
  resetData();
  const st = toolState(s.id);
  // 首次打开才读一次工具清单（用户主动点击触发；已有缓存则秒显）
  if (!st.loaded && !st.loading) await loadTools(s.id);
}

async function loadTools(serverId: string, refresh = false) {
  if (!API) return;
  const st = toolState(serverId);
  if (st.loading) return;
  st.loading = true;
  try {
    const res = await API.mcp.tools(serverId, refresh);
    const s = servers.value.find(x => x.id === serverId);
    if (res.ok) {
      st.tools = res.tools || [];
      st.instructions = res.instructions || '';
      st.loaded = true;
      if (s) {
        s.status = 'ok';
        s.toolCount = st.tools.length;
        s.statusText = `已连接 · ${st.tools.length} 个工具`;
      }
    } else {
      if (s) { s.status = 'error'; s.statusText = res.error || '连接失败'; }
      alert('读取工具清单失败：' + (res.error || '未知错误'));
    }
  } catch (e: any) {
    alert('读取工具清单失败：' + ((e && e.message) || e));
  }
  st.loading = false;
}

// ========== 增删改 ==========
const showModal = ref(false);
const editingId = ref('');
const form = ref({ url: '', token: '', enabled: true });
const saving = ref(false);

function showAddServer() {
  editingId.value = '';
  form.value = { url: '', token: '', enabled: true };
  showModal.value = true;
}

function editServer(s: ServerConf) {
  editingId.value = s.id;
  form.value = { url: s.url, token: s.token, enabled: s.enabled };
  showModal.value = true;
}

async function saveServer() {
  if (!form.value.url.trim()) { alert('请填写 URL'); return; }
  if (!API) return;
  saving.value = true;
  try {
    const list = servers.value
      .filter(x => x.id !== editingId.value)
      .map(x => ({ id: x.id, url: x.url, token: x.token, enabled: x.enabled }));
    list.push({ id: editingId.value || undefined as any, url: form.value.url.trim(), token: form.value.token.trim(), enabled: form.value.enabled });
    const res = await API.mcp.save(list);
    if (!res.ok) { alert('保存失败：' + (res.error || '未知错误')); return; }
    showModal.value = false;
    await loadServers();
    // 保存后打开该服务；握手结果已缓存，工具清单可直接读取
    const saved = (res.servers || []).find((x: any) => x.url === form.value.url.trim());
    if (saved) {
      openId.value = saved.id;
      detailTab.value = 'chat';
      toolModalOpen.value = false;
      resetData();
      await loadTools(saved.id);
    }
  } catch (e: any) {
    alert('保存失败：' + ((e && e.message) || e));
  }
  saving.value = false;
}

async function removeServer(s: ServerConf) {
  if (!confirm(`确定删除 MCP 服务「${s.name || s.url}」？AI 对话将不再能调用它的工具。`)) return;
  if (!API) return;
  try {
    await API.mcp.save(servers.value.filter(x => x.id !== s.id).map(x => ({ id: x.id, url: x.url, token: x.token, enabled: x.enabled })));
    if (openId.value === s.id) { openId.value = ''; toolModalOpen.value = false; resetData(); }
    await loadServers();
  } catch (e) { console.error('删除失败:', e); }
}

async function toggleEnabled(s: ServerConf) {
  if (!API) return;
  try {
    await API.mcp.save(servers.value.map(x => ({ id: x.id, url: x.url, token: x.token, enabled: x.id === s.id ? !x.enabled : x.enabled })));
    await loadServers();
  } catch (e) { console.error('切换失败:', e); }
}

/** 测试连接 = 重新握手 + 刷新工具清单（轻量，不拉业务数据） */
async function testServer(s: ServerConf) {
  if (!API) return;
  s.testing = true;
  await loadTools(s.id, true);
  s.testing = false;
}

// ========== 数据浏览（选中业务域后才拉取） ==========
const TOOL_LABELS: Record<string, string> = {
  leads: '线索', customers: '客户', contacts: '联系人', followups: '跟进',
  opportunities: '商机', stage_histories: '阶段变化', touches: '触点行为',
  payments: '收款', projects: '项目', tasks: '任务', work_items: '需求/缺陷',
  work_orders: '服务工单', service_orders: '服务订单', ai_chats: 'AI 对话',
  assist_messages: '助手消息', feishu_messages: '飞书消息', contact_messages: '表单消息',
};

const domains = computed<DomainInfo[]>(() => {
  return tools.value
    .filter(t => /^list[_-]/i.test(t.name))
    .map(t => {
      const suffix = t.name.replace(/^list[_-]/i, '').toLowerCase();
      return { tool: t.name, label: TOOL_LABELS[suffix] || suffix, description: t.description || '' };
    });
});

const currentTool = ref('');
const rows = ref<any[]>([]);
const hasMore = ref(false);
const totalCount = ref(0);
const fetching = ref(false);
const page = ref(1);

function resetData() {
  currentTool.value = '';
  rows.value = [];
  dimensions.value = [];
  filter.value = {};
  classMap.value = new Map();
  page.value = 1;
  totalCount.value = 0;
  hasMore.value = false;
}

async function selectDomain(d: DomainInfo) {
  currentTool.value = d.tool;
  page.value = 1;
  totalCount.value = 0;
  dimensions.value = [];
  filter.value = {};
  classMap.value = new Map();
  await fetchRows();
}

async function fetchRows() {
  if (!selected.value || !currentTool.value || !API) return;
  fetching.value = true;
  try {
    const res = await API.mcp.fetch(selected.value.id, currentTool.value, { page: page.value });
    if (res.ok) {
      rows.value = res.rows || [];
      hasMore.value = !!res.hasMore;
      totalCount.value = Number(res.total) || rows.value.length;
      await loadClassifications();
    } else {
      rows.value = [];
      alert('拉取失败：' + (res.error || '未知错误'));
    }
  } catch (e: any) {
    console.error('拉取失败:', e);
    rows.value = [];
  }
  fetching.value = false;
}

async function nextPage() {
  page.value += 1;
  await fetchRows();
}

// ========== 表格渲染 ==========
const IGNORE_COLS = new Set(['_mcp_key']);
const columns = computed(() => {
  const list = rows.value.filter(r => r && typeof r === 'object');
  if (!list.length) return [];
  const keys = Object.keys(list[0]).filter(k => !IGNORE_COLS.has(k) && !k.startsWith('_'));
  // 按非空率排序：正文列排前；id/外键列（assigneeId/contactMessageId…）是噪音，大幅降级
  const isNoise = (k: string) => /Id$/.test(k) || k === 'id';
  const nonEmpty = (k: string) => list.filter(r => r[k] !== null && r[k] !== undefined && r[k] !== '').length;
  const score = (k: string) => (isNoise(k) ? nonEmpty(k) - 1000 : nonEmpty(k));
  return [...keys].sort((a, b) => score(b) - score(a)).slice(0, 8);
});

function shortCell(v: any): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

function cellTitle(v: any): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ========== AI 分类 ==========
const dimensions = ref<Array<{ name: string; values: string[] }>>([]);
const filter = ref<Record<string, string>>({});
const classMap = ref<Map<string, Record<string, string>>>(new Map());
const classifying = ref(false);
const hasLabels = computed(() => classMap.value.size > 0);

// 分类是手动触发的 AI 消耗：点按钮先弹窗选本次模型，不读设置页后台模型
const classifyModalOpen = ref(false);
const classifyForce = ref(false);
const classifyModel = ref('');
const classifyModels = ref<{ providerLabel: string; name: string; pattern: string; configured: boolean }[]>([]);
const currentToolLabel = computed(() => domains.value.find(d => d.tool === currentTool.value)?.label || currentTool.value || '');

async function openClassifyModal(force: boolean) {
  classifyForce.value = force;
  classifyModel.value = '';
  if (!classifyModels.value.length) {
    try {
      const res = await API.pi.models();
      classifyModels.value = (res?.models || []).filter((m: any) => m.pattern);
    } catch { classifyModels.value = []; }
  }
  classifyModalOpen.value = true;
}

const filteredRows = computed(() => {
  const f = filter.value;
  const active = Object.entries(f).filter(([, v]) => v);
  if (!active.length) return rows.value;
  return rows.value.filter(r => {
    const labels = classMap.value.get(r._mcp_key) || {};
    return active.every(([dim, val]) => labels[dim] === val);
  });
});

function rowLabels(r: any): Record<string, string> {
  return classMap.value.get(r._mcp_key) || {};
}

async function loadClassifications() {
  if (!selected.value || !currentTool.value || !API) return;
  try {
    const res = await API.mcp.classifications(selected.value.id, currentTool.value);
    const map = new Map<string, Record<string, string>>();
    for (const item of res.items || []) map.set(item.key, item.labels || {});
    classMap.value = map;
  } catch { classMap.value = new Map(); }
}

async function classifyCurrent(force: boolean) {
  if (!selected.value || !currentTool.value || !API) return;
  classifyModalOpen.value = false;
  classifying.value = true;
  try {
    const res = await API.mcp.classify(selected.value.id, currentTool.value, { force, model: classifyModel.value || undefined });
    if (res.ok) {
      dimensions.value = res.dimensions || [];
      await loadClassifications();
      if (!res.dimensions?.length && !res.cached) console.info('[Sources] 该域暂无可分类记录');
    } else {
      alert('AI 分类失败：' + (res.error || '未知错误'));
    }
  } catch (e: any) {
    alert('AI 分类失败：' + ((e && e.message) || e));
  }
  classifying.value = false;
}

function removeFilter(dim: string) {
  delete filter.value[dim];
  filter.value = { ...filter.value };
}

// ========== 本机知识库服务（qihang-kb MCP） ==========
const kb = ref<KbMcpStatus | null>(null);
const kbBusy = ref(false);
const kbTokenVisible = ref(false);

async function loadKb() {
  if (!API?.kbmcp) return;
  try { kb.value = await API.kbmcp.status(); } catch { /* 旧版本无该接口 */ }
}

async function toggleKb() {
  if (!API || !kb.value) return;
  kbBusy.value = true;
  try {
    const r = await API.kbmcp.setEnabled(!kb.value.enabled);
    kb.value = r.status;
    if (!r.ok) alert('操作失败：' + (r.error || '未知错误'));
  } catch (e: any) {
    alert('操作失败：' + ((e && e.message) || e));
  }
  kbBusy.value = false;
}

async function regenKbToken() {
  if (!API) return;
  if (!confirm('重置后旧 Token 立即失效，已接入的客户端需要更新配置。继续？')) return;
  try {
    const r = await API.kbmcp.regenToken();
    kb.value = r.status;
  } catch (e: any) {
    alert('重置失败：' + ((e && e.message) || e));
  }
}

async function reindexKb() {
  if (!API) return;
  kbBusy.value = true;
  try {
    const r = await API.kbmcp.reindex();
    if (r.status) kb.value = r.status;
    alert(r.ok
      ? `重建完成：更新 ${r.indexed ?? 0} 篇，清理 ${r.removed ?? 0} 篇，共 ${r.total ?? 0} 篇`
      : '重建失败：' + (r.error || '未知错误'));
  } catch (e: any) {
    alert('重建失败：' + ((e && e.message) || e));
  }
  kbBusy.value = false;
}

async function copyKbToken() {
  if (!kb.value?.token) return;
  try { await navigator.clipboard.writeText(kb.value.token); } catch { alert('复制失败，请手动选择文本复制'); }
}

onMounted(() => { void loadServers(); void loadKb(); });
</script>

<style scoped>
/* ========== 分区标题 ========== */
.section-head { display: flex; align-items: center; gap: 8px; margin: 18px 2px 8px; }
.section-head:first-of-type { margin-top: 4px; }
.section-tag {
  font-size: 11px; font-weight: 600; line-height: 1;
  padding: 4px 9px; border-radius: 999px;
  background: var(--primary-soft); color: var(--primary);
}
.section-tag.client { background: var(--hover); color: var(--text-secondary); }
.section-desc { font-size: 11.5px; color: var(--text-muted); }

/* ========== 本机知识库服务 ========== */
.kb-panel { padding: 14px 16px; }
.kb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.kb-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.kb-name { font-size: 14px; font-weight: 600; color: var(--text-primary); display: flex; align-items: baseline; gap: 6px; }
.kb-name small { font-size: 11px; font-weight: 400; color: var(--text-muted); }
.kb-meta { font-size: 11.5px; color: var(--text-muted); }
.kb-actions { display: flex; align-items: center; gap: 8px; }
.kb-actions .toggle { margin-right: 4px; }
.kb-body { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.kb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-label { font-size: 12px; color: var(--text-muted); min-width: 64px; }
.kb-code { font-size: 12px; background: var(--hover); padding: 3px 8px; border-radius: 4px; color: var(--text-secondary); word-break: break-all; }
.kb-token { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-hint { font-size: 11.5px; color: var(--text-muted); line-height: 1.6; margin-top: 2px; }

/* ========== 客户端：主从布局 ========== */
.client-panel { display: flex; height: calc(100vh - 300px); min-height: 460px; }
.srv-list {
  width: 280px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
  display: flex; flex-direction: column; min-height: 0;
}
.srv-list-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--border);
}
.srv-list-title { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
.srv-list-title b { margin-left: 6px; font-weight: 500; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.srv-items { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.srv-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px; border: none; border-radius: 6px;
  background: none; text-align: left; font: inherit; cursor: pointer;
  transition: background 0.15s;
}
.srv-item:hover { background: var(--hover); }
.srv-item.active { background: var(--primary-soft); }
.srv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.srv-name { font-size: 12.5px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srv-item.active .srv-name { color: var(--primary); font-weight: 600; }
.srv-url { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srv-tools {
  font-size: 10.5px; color: var(--text-muted); font-variant-numeric: tabular-nums;
  padding: 1px 6px; border-radius: 999px; background: var(--hover); flex-shrink: 0;
}
.srv-add {
  margin: 8px; padding: 8px;
  border: 1px dashed var(--border); border-radius: 6px;
  background: none; color: var(--text-muted);
  font: inherit; font-size: 12px;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  cursor: pointer; transition: all 0.15s;
}
.srv-add:hover { color: var(--primary); border-color: var(--primary); }
.list-hint { padding: 24px 16px; text-align: center; color: var(--text-muted); font-size: 12px; }
.list-empty {
  padding: 28px 16px; text-align: center; color: var(--text-muted); font-size: 12px;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}

/* ========== 详情区 ========== */
.srv-detail { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.detail-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  padding: 40px 24px; text-align: center; color: var(--text-muted);
}
.detail-empty .empty-icon { opacity: 0.45; }
.detail-empty p { font-size: 13px; }
.detail-empty .sub { font-size: 11.5px; line-height: 1.7; max-width: 460px; }
.detail-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 12px 18px 8px; flex-wrap: wrap;
}
.detail-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.detail-title h2 { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.detail-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.detail-actions .toggle { margin-right: 4px; }
.detail-url-row { padding: 0 18px 10px; }
.detail-url {
  font-size: 11.5px; color: var(--text-muted);
  background: var(--hover); padding: 2px 8px; border-radius: 4px;
  word-break: break-all;
}
.detail-tabs { display: flex; gap: 2px; padding: 0 18px; border-bottom: 1px solid var(--border); }
.detail-tabs button {
  border: none; background: none; font: inherit; font-size: 12.5px;
  color: var(--text-secondary); padding: 8px 12px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s;
  display: inline-flex; align-items: center; gap: 5px;
}
.detail-tabs button:hover { color: var(--text-primary); }
.detail-tabs button.on { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }
.detail-tabs b { font-size: 10.5px; color: var(--text-muted); font-weight: 500; margin-left: 4px; }

.pane-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 18px 16px; }
.pane-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.pane-hint { font-size: 11.5px; color: var(--text-muted); line-height: 1.6; }
.srv-instructions {
  font-size: 12px; color: var(--text-secondary); line-height: 1.7;
  background: var(--hover); border-radius: 6px; padding: 8px 10px;
  margin-bottom: 10px; white-space: pre-wrap;
}
.tool-list { display: flex; flex-direction: column; gap: 6px; }
.tool-item { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); }
.tool-name { font-size: 12px; color: var(--primary); font-family: var(--font-mono); }
.tool-desc { font-size: 11.5px; color: var(--text-muted); line-height: 1.6; margin-top: 3px; }

/* ========== 业务域 / 分类筛选 ========== */
.dom-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.mod-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text-secondary); font: inherit; font-size: 12px;
  cursor: pointer; transition: all 0.15s;
}
.mod-chip:hover { border-color: var(--primary); color: var(--primary); }
.mod-chip.active { background: var(--primary); border-color: var(--primary); color: #fff; }

.dim-box { padding: 6px 0 4px; display: flex; flex-direction: column; gap: 6px; }
.dim-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dim-name { font-size: 12px; color: var(--text-secondary); font-weight: 500; min-width: 56px; }
.chip {
  padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text-secondary);
  font: inherit; font-size: 11.5px; cursor: pointer; transition: all 0.15s;
}
.chip:hover { border-color: var(--primary); color: var(--primary); }
.chip.on { background: var(--primary-soft); border-color: var(--primary); color: var(--primary); }

/* ========== 记录表 ========== */
.table-wrap { overflow-x: auto; padding: 4px 0; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; background: var(--surface); border-spacing: 0; }
.data-table th {
  text-align: left; padding: 8px 12px; background: var(--bg-main);
  border-bottom: 2px solid var(--border); font-weight: 600;
  color: var(--text-secondary); white-space: nowrap;
}
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.data-table tr:hover { background: var(--hover); }
.th-ai, .td-ai { white-space: normal; }
.ai-label { margin: 1px 3px 1px 0; font-size: 10.5px; }

/* ========== 底部操作条 ========== */
.fetch-bar { display: flex; align-items: center; gap: 10px; padding: 10px 0 2px; }
.fetch-bar .grow { flex: 1; }
.total-hint { font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

/* ========== 文本按钮 / 开关 / 弹窗 / 表单 ========== */
.text-btn {
  background: none; border: none; cursor: pointer; font-size: 12px;
  color: var(--text-secondary); padding: 4px 8px; border-radius: 4px;
  display: inline-flex; align-items: center; gap: 4px; font-family: inherit;
}
.text-btn:hover { background: var(--hover); color: var(--primary); }
.text-btn-del:hover { color: var(--danger); }
.text-btn:disabled { opacity: 0.5; cursor: default; }
.none-row { padding: 28px 0; text-align: center; color: var(--text-muted); font-size: 12.5px; }

.toggle { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle .slider { position: absolute; inset: 0; background: #d1d5db; border-radius: 20px; transition: 0.2s; }
.toggle .slider::before {
  content: ''; position: absolute; height: 16px; width: 16px; left: 2px; bottom: 2px;
  background: #fff; border-radius: 50%; transition: 0.2s;
}
.toggle input:checked + .slider { background: var(--primary); }
.toggle input:checked + .slider::before { transform: translateX(16px); }

/* ========== 工具清单弹窗 ========== */
.tool-modal { width: 620px; max-height: 80vh; display: flex; flex-direction: column; }
.tool-count {
  margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  background: var(--primary-soft); color: var(--primary);
  font-size: 11px; font-weight: 600;
}
.tool-search {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 18px; border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tool-search .ts-ic { color: var(--text-muted); flex-shrink: 0; }
.tool-search input {
  flex: 1; min-width: 0; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-main); color: var(--text-primary);
  font: inherit; font-size: 12.5px; outline: none;
}
.tool-search input:focus { border-color: var(--primary); }
.tool-modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 18px 18px; }

.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); display: flex;
  justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
  background: var(--surface); border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg); max-width: 90%; width: 480px;
  max-height: 90vh; overflow-y: auto;
}
.modal-header {
  padding: 14px 20px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.modal-header h3 { font-size: 15px; font-weight: 600; }
.modal-body { padding: 18px 20px; }
.modal-footer {
  padding: 14px 20px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
}
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 5px; }
.form-hint { font-size: 11.5px; color: var(--text-muted); line-height: 1.6; }
.toggle-label { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-secondary); cursor: pointer; }

/* ========== 窄窗口：上下堆叠 ========== */
@media (max-width: 900px) {
  .client-panel { flex-direction: column; height: auto; }
  .srv-list { width: 100%; border-right: none; border-bottom: 1px solid var(--border); max-height: 260px; }
  .srv-detail { min-height: 520px; }
}
</style>
