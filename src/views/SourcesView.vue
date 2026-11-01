<template>
  <div class="page sources-view">
    <!-- ========== 页头 ========== -->
    <header class="page-head">
      <div>
        <h1 class="page-title">数据源<small>MCP</small></h1>
        <p class="page-sub">通过 MCP 协议接入外部系统的数据；AI 对话可直接查询，这里负责配置、浏览与分类</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-primary" @click="showAddServer"><AppIcon name="plus" :size="13" />添加数据源</button>
      </div>
    </header>

    <!-- ========== 加载中 ========== -->
    <section v-if="!loaded" class="panel"><div class="none-row">加载中…</div></section>

    <!-- ========== 空态 ========== -->
    <section v-else-if="servers.length === 0" class="panel empty-panel">
      <div class="empty-icon">🔌</div>
      <div class="empty-title">还没有外部数据源</div>
      <p class="empty-desc">
        添加一个 MCP 数据源（Streamable HTTP），例如启航官网后台：<code>http://qihangerp.cn:6111/mcp</code><br>
        添加后，AI 在对话里即可直接查询它的数据；本页提供数据一览与 AI 分类。
      </p>
      <button class="btn btn-primary" @click="showAddServer">添加数据源</button>
    </section>

    <template v-else>
      <!-- ========== 数据源卡片 ========== -->
      <section class="panel">
        <div class="src-grid">
          <div
            v-for="s in servers" :key="s.id"
            class="src-card" :class="{ active: s.id === selectedId }"
            @click="selectServer(s)"
          >
            <div class="src-head">
              <span class="src-name" :title="s.url">🔌 {{ s.name || s.url }}</span>
              <span class="badge" :class="statusBadgeClass(s)">{{ statusText(s) }}</span>
            </div>
            <div class="src-url">{{ s.url }}</div>
            <div class="src-foot" @click.stop>
              <label class="toggle" title="启用后 AI 对话可查询该数据源">
                <input type="checkbox" :checked="s.enabled" @change="toggleEnabled(s)">
                <span class="slider"></span>
              </label>
              <button class="text-btn" @click="testServer(s)" :disabled="s.testing">{{ s.testing ? '测试中…' : '测试' }}</button>
              <button class="text-btn" @click="editServer(s)">编辑</button>
              <button class="text-btn text-btn-del" @click="removeServer(s)">删除</button>
            </div>
          </div>
          <button class="src-card src-add" @click="showAddServer">
            <AppIcon name="plus" :size="14" /><span>添加数据源</span>
          </button>
        </div>
      </section>

      <!-- ========== 数据一览（选中源） ========== -->
      <section v-if="selected" class="panel">
        <div class="dom-head">
          <div class="dom-title">
            <h2>{{ selected.name }} 数据一览</h2>
            <span class="dom-meta" v-if="overview.counts && countsText">{{ countsText }}</span>
          </div>
          <div class="dom-actions">
            <button class="text-btn" @click="loadOverview(true)" :disabled="overviewLoading">
              {{ overviewLoading ? '加载中…' : '刷新' }}
            </button>
            <button class="btn btn-sm btn-primary" @click="askAi"><AppIcon name="sparkles" :size="13" />让 AI 分析</button>
          </div>
        </div>
        <p class="src-instructions" v-if="overview.instructions">{{ overview.instructions }}</p>

        <!-- 业务域 chips -->
        <div class="dom-chips" v-if="domains.length">
          <button
            v-for="d in domains" :key="d.tool"
            class="mod-chip" :class="{ active: d.tool === currentTool }"
            :title="d.description"
            @click="selectDomain(d)"
          >{{ d.label }}<b v-if="d.count">{{ d.count }}</b></button>
        </div>
        <div v-else-if="!overviewLoading" class="none-row">没有可用工具</div>

        <!-- 分类维度筛选 -->
        <div class="dim-box" v-if="dimensions.length">
          <div v-for="dim in dimensions" :key="dim.name" class="dim-row">
            <span class="dim-name">{{ dim.name }}</span>
            <button
              class="chip" :class="{ on: !filter[dim.name] }"
              @click="removeFilter(dim.name)"
            >全部</button>
            <button
              v-for="v in dim.values" :key="v"
              class="chip" :class="{ on: filter[dim.name] === v }"
              @click="filter[dim.name] = filter[dim.name] === v ? '' : v"
            >{{ v }}</button>
          </div>
        </div>

        <!-- 记录表 -->
        <div class="table-wrap" v-if="currentTool">
          <table class="data-table" v-if="filteredRows.length">
            <thead>
              <tr>
                <th v-for="c in columns" :key="c" :title="c">{{ fieldHints[c] || c }}</th>
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
          <div v-else class="none-row">该域暂无记录（默认拉取近 30 天）</div>
        </div>

        <div class="fetch-bar" v-if="currentTool">
          <span class="total-hint" v-if="totalCount">共 {{ totalCount }} 条</span>
          <button class="text-btn" :disabled="fetching || !hasMore" @click="nextPage">
            {{ fetching ? '加载中…' : (hasMore ? '下一页' : '没有更多了') }}
          </button>
          <span class="grow"></span>
          <button class="text-btn" :disabled="classifying" @click="classifyCurrent(false)">
            {{ classifying ? 'AI 分类中…' : 'AI 分类' }}
          </button>
          <button class="text-btn" v-if="hasLabels" :disabled="classifying" @click="classifyCurrent(true)">重新分类</button>
        </div>
      </section>
    </template>

    <!-- ========== 添加/编辑弹窗 ========== -->
    <div v-if="showModal" class="modal-overlay" @click="showModal = false">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>{{ editingId ? '编辑数据源' : '添加 MCP 数据源' }}</h3>
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
              启用（AI 对话可查询该数据源）
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
import { useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';

const API = (window as any).electronAPI;
const router = useRouter();

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

interface DomainInfo {
  tool: string;
  label: string;
  description: string;
  count?: number;
}

// ========== 数据源列表 ==========
const servers = ref<ServerConf[]>([]);
const loaded = ref(false);
const selectedId = ref('');
const selected = computed(() => servers.value.find(s => s.id === selectedId.value) || null);

async function loadServers() {
  if (!API) { loaded.value = true; return; }
  try {
    const res = await API.mcp.list();
    servers.value = (res.servers || []).map((s: any) => ({ ...s, testing: false }));
    // 默认选中第一个启用的源
    if (!servers.value.find(s => s.id === selectedId.value)) {
      const first = servers.value.find(s => s.enabled) || servers.value[0];
      if (first) { selectedId.value = first.id; void loadOverview(); }
      else selectedId.value = '';
    }
    // 未验证的源自动补一次握手（触发主进程 saveServers 的探测，结果落库；已验证的不再打扰）
    void autoProbeUntested();
  } catch (e) { console.error('加载数据源失败:', e); }
  loaded.value = true;
}

/** 对「未验证」的启用源补一次握手：一次 mcp:save 由主进程探测并返回最新状态，UI 原地应用 */
async function autoProbeUntested() {
  if (!API) return;
  const hasPending = servers.value.some(s => s.enabled && (s.status === 'untested' || !s.lastTestedAt));
  if (!hasPending) return;
  try {
    const res = await API.mcp.save(servers.value.map(x => ({ id: x.id, url: x.url, token: x.token, enabled: x.enabled })));
    if (res.ok && Array.isArray(res.servers)) {
      for (const upd of res.servers) {
        const s = servers.value.find(x => x.id === upd.id);
        if (s) Object.assign(s, { ...upd, testing: false });
      }
    }
  } catch { /* 静默：用户仍可手动「测试」 */ }
}

function statusBadgeClass(s: ServerConf): string {
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
    // 保存后选中新加/编辑的那个
    const saved = (res.servers || []).find((x: any) => x.url === form.value.url.trim());
    if (saved) { selectedId.value = saved.id; void loadOverview(); }
    if (res.fingerprintChanged) {
      // 会话已在主进程重建；提示用户工具面已更新
      console.info('[Sources] MCP 配置变更，pi 会话已重建');
    }
  } catch (e: any) {
    alert('保存失败：' + ((e && e.message) || e));
  }
  saving.value = false;
}

async function removeServer(s: ServerConf) {
  if (!confirm(`确定删除数据源「${s.name || s.url}」？AI 对话将不再能查询它。`)) return;
  if (!API) return;
  try {
    await API.mcp.save(servers.value.filter(x => x.id !== s.id).map(x => ({ id: x.id, url: x.url, token: x.token, enabled: x.enabled })));
    if (selectedId.value === s.id) { selectedId.value = ''; currentTool.value = ''; }
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

async function testServer(s: ServerConf) {
  if (!API) return;
  s.testing = true;
  try {
    const r = await API.mcp.test(s.url, s.token);
    if (r.ok) {
      s.status = 'ok';
      s.statusText = `已连接 · ${(r.tools || []).length} 个工具`;
      s.toolCount = (r.tools || []).length;
      s.lastTestedAt = new Date().toISOString();
      // 顺手把测试结果落库（回填名称等）
      await API.mcp.save(servers.value.map(x => ({ id: x.id, url: x.url, token: x.token, enabled: x.enabled })));
      await loadServers();
    } else {
      s.status = 'error';
      s.statusText = r.error || '连接失败';
    }
  } catch (e: any) {
    s.status = 'error';
    s.statusText = (e && e.message) || String(e);
  }
  s.testing = false;
}

// ========== 数据一览 ==========
const overview = ref<any>({});
const overviewLoading = ref(false);
const domains = ref<DomainInfo[]>([]);
const currentTool = ref('');
const rows = ref<any[]>([]);
const hasMore = ref(false);
const totalCount = ref(0);
const fetching = ref(false);
const page = ref(1);
const instructions = computed(() => overview.value.instructions || '');

/** 业务域：list_* 工具按域分组（list_leads → leads），计数尽力从 count_index 结果里对上 */
const TOOL_LABELS: Record<string, string> = {
  leads: '线索', customers: '客户', contacts: '联系人', followups: '跟进',
  opportunities: '商机', stage_histories: '阶段变化', touches: '触点行为',
  payments: '收款', projects: '项目', tasks: '任务', work_items: '需求/缺陷',
  work_orders: '服务工单', service_orders: '服务订单', ai_chats: 'AI 对话',
  assist_messages: '助手消息', feishu_messages: '飞书消息', contact_messages: '表单消息',
};
/** 归一化键的标签表（服务端 camelCase / 工具 snake_case 两种形态都能查到中文） */
const NORM_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_LABELS).map(([k, v]) => [k.replace(/[^a-z0-9]/g, ''), v]),
);

function buildDomains(): DomainInfo[] {
  const tools: any[] = overview.value.tools || [];
  const counts = overview.value.counts;
  // 键归一化：服务端域名是 camelCase（aiChats），工具后缀是 snake（ai_chats），去符号后比对
  const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const countMap: Record<string, number> = {};
  if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
    for (const [k, v] of Object.entries(counts)) {
      if (typeof v === 'number') countMap[norm(k)] = v;
    }
  } else if (Array.isArray(counts)) {
    for (const item of counts) {
      if (item && typeof item === 'object') {
        const domain = String((item as any).domain || (item as any).name || '');
        const n = Number((item as any).count ?? (item as any).rows ?? NaN);
        if (domain && Number.isFinite(n)) countMap[norm(domain)] = n;
      }
    }
  }
  return tools
    .filter(t => t.name && t.name !== 'describe_metrics' && t.name !== 'count_index')
    .map(t => {
      const suffix = t.name.replace(/^list_/, '').toLowerCase();
      const count = countMap[norm(suffix)] ?? countMap[norm(t.name)];
      return {
        tool: t.name,
        label: NORM_LABELS[norm(suffix)] || suffix,
        description: t.description || '',
        count: typeof count === 'number' ? count : undefined,
      };
    });
}

async function selectServer(s: ServerConf) {
  if (selectedId.value === s.id) return;
  selectedId.value = s.id;
  currentTool.value = '';
  rows.value = [];
  dimensions.value = [];
  classMap.value = new Map();
  await loadOverview();
}

async function loadOverview(refresh = false) {
  if (!selected.value || !API) return;
  overviewLoading.value = true;
  try {
    const res = await API.mcp.overview(selected.value.id, refresh);
    if (res.ok) {
      overview.value = res;
      domains.value = buildDomains();
      if (!currentTool.value && domains.value.length) await selectDomain(domains.value[0]);
    } else {
      overview.value = {};
      domains.value = [];
      alert('读取数据源失败：' + (res.error || '未知错误'));
    }
  } catch (e: any) {
    console.error('读取概览失败:', e);
  }
  overviewLoading.value = false;
}

/** count_index 汇总文案（近 30 天各域行数，取前 6 个非零域） */
const countsText = computed(() => {
  const counts = overview.value.counts;
  if (!Array.isArray(counts)) return '';
  const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = (counts as any[])
    .filter(c => c && Number(c.rows) > 0)
    .map(c => {
      const label = NORM_LABELS[norm(c.domain)] || String(c.domain);
      return `${label} ${c.rows}`;
    });
  if (!parts.length) return '';
  return `近 30 天：${parts.slice(0, 6).join(' · ')}${parts.length > 6 ? ' …' : ''}`;
});

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

/** describe_metrics 的 keyFields 提供「字段=中文说明」对照，用作表头显示与悬浮提示 */
const fieldHints = computed<Record<string, string>>(() => {
  const domains = overview.value.metrics?.domains;
  if (!Array.isArray(domains)) return {};
  const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = currentTool.value;
  const dom = domains.find((d: any) => d && norm(d.tool) === norm(tool))
    || domains.find((d: any) => d && norm(d.domain) === norm(tool.replace(/^list_/, '')));
  const hints: Record<string, string> = {};
  for (const kf of dom?.keyFields || []) {
    const m = String(kf).match(/^([A-Za-z_][A-Za-z0-9_]*)=([\u4e00-\u9fa5][^ ]*)/);
    if (m) hints[m[1]] = m[2];
  }
  return hints;
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
  classifying.value = true;
  try {
    const res = await API.mcp.classify(selected.value.id, currentTool.value, { force });
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

// ========== 让 AI 分析 ==========
// 分析发生在对话里（AI 自己调 MCP 工具拉数、可追问、可存档），页面只负责把请求送过去：
// 创建专属会话 → sessionStorage 交接 → 跳对话页自动发出（复用新建对话的交接机制，落地即分析）
const NEW_CHAT_HANDOFF_KEY = 'new_chat_handoff';
async function askAi() {
  if (!selected.value || !API) return;
  const toolPart = currentTool.value ? `，重点看 ${currentTool.value.replace(/^list_/, '')} 域` : '';
  const prompt = `请分析「${selected.value.name}」数据源（MCP）的数据${toolPart}：先用 describe_metrics 和 count_index 了解业务域与数据量，再拉取近 7 天明细，给我一份中文摘要（含关键数字与值得注意的变化）。`;
  const id = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    await API.chat.createSession(id, null, `${selected.value.name} 分析`, 'general', 'general', 'ui');
    try { sessionStorage.setItem(NEW_CHAT_HANDOFF_KEY, JSON.stringify({ sessionId: id, text: prompt, images: [] })); } catch {}
    await router.replace({ path: '/chat', query: { session: id } });
  } catch (e: any) {
    // 创建会话失败：退化为预填模式，用户手动发送
    router.push({ path: '/chat', query: { prompt } });
  }
}

function removeFilter(dim: string) {
  delete filter.value[dim];
  filter.value = { ...filter.value };
}

onMounted(() => { void loadServers(); });
</script>

<style scoped>
/* ========== 页头 ========== */
.page-sub { display: flex; align-items: center; gap: 6px; }
.empty-panel { padding: 48px 20px; text-align: center; }
.empty-icon { font-size: 40px; margin-bottom: 10px; opacity: 0.45; }
.empty-title { font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.empty-desc { font-size: 13px; color: var(--text-muted); line-height: 1.7; margin-bottom: 16px; }
.empty-desc code { background: var(--hover); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

/* ========== 源卡片 ========== */
.src-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; padding: 14px 16px; }
.src-card {
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 12px 14px; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
}
.src-card:hover { border-color: rgba(var(--primary-rgb), 0.45); }
.src-card.active { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(var(--primary-rgb), 0.12); }
.src-add {
  border-style: dashed; background: transparent; color: var(--text-muted);
  display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 84px; font-size: 13px; font-family: inherit; cursor: pointer;
}
.src-add:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); box-shadow: none; }
.src-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.src-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-url { font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 10px; }
.src-foot { display: flex; align-items: center; gap: 4px; }
.src-foot .toggle { margin-right: 6px; }

/* ========== 数据一览 ========== */
.dom-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.dom-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex-wrap: wrap; }
.dom-title h2 { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.dom-meta { font-size: 11.5px; color: var(--text-muted); }
.dom-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.src-instructions { padding: 10px 16px 0; font-size: 12px; color: var(--text-muted); line-height: 1.6; }
.dom-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 16px 4px; }
.mod-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text-secondary); font: inherit; font-size: 12px;
  cursor: pointer; transition: all 0.15s;
}
.mod-chip b { font-size: 10.5px; color: var(--text-muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.mod-chip:hover { border-color: var(--primary); color: var(--primary); }
.mod-chip.active { background: var(--primary); border-color: var(--primary); color: #fff; }
.mod-chip.active b { color: rgba(255, 255, 255, 0.8); }

/* ========== 分类维度筛选 ========== */
.dim-box { padding: 8px 16px 4px; display: flex; flex-direction: column; gap: 6px; }
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
.table-wrap { overflow-x: auto; padding: 10px 16px 4px; }
.data-table {
  width: 100%; border-collapse: collapse; font-size: 12.5px;
  background: var(--surface); border-spacing: 0;
}
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
.fetch-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px 14px; }
.fetch-bar .grow { flex: 1; }
.total-hint { font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

/* ========== 文本按钮 / 徽标 / 弹窗 / 表单（与既有页面同款） ========== */
.text-btn {
  background: none; border: none; cursor: pointer; font-size: 12px;
  color: var(--text-secondary); padding: 4px 8px; border-radius: 4px;
  display: inline-flex; align-items: center; gap: 4px; font-family: inherit;
}
.text-btn:hover { background: var(--hover); color: var(--primary); }
.text-btn-del:hover { color: var(--danger); }
.text-btn:disabled { opacity: 0.5; cursor: default; }
.none-row { padding: 32px 0; text-align: center; color: var(--text-muted); font-size: 13px; }
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
</style>
