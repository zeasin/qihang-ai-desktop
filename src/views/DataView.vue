<template>
  <div class="page data-view">
    <!-- ========== 加载中 ========== -->
    <div v-if="!loaded" class="none-row">加载中…</div>

    <template v-else-if="modules.length > 0">
      <!-- ========== 页头 ========== -->
      <header class="page-head">
        <div>
          <h1 class="page-title">数据<small>{{ pageDateStr }}</small></h1>
          <p class="page-sub statline">
            <span><b>{{ modules.length }}</b> 个模块</span>
            <span><b>{{ totalDatasets }}</b> 个数据集</span>
            <span><b>{{ totalRecords }}</b> 条记录</span>
            <span>今日新增 <b class="acc">{{ todayRecords }}</b></span>
          </p>
        </div>
        <div class="page-actions">
          <input type="text" class="form-control filter-input" v-model="keyword" placeholder="筛选模块 / 数据集…">
          <button class="btn btn-sm btn-primary" @click="showAddModule"><AppIcon name="plus" :size="13" />模块</button>
          <button class="btn btn-sm btn-secondary" @click="showSuitesModal"><AppIcon name="archive" :size="13" />内置模板</button>
        </div>
      </header>

      <!-- ========== 模块筛选 chips ========== -->
      <div class="mod-chips" v-if="modules.length > 1">
        <button class="mod-chip" :class="{ active: filterId === 'all' }" @click="filterId = 'all'">
          全部<b>{{ totalRecords }}</b>
        </button>
        <button
          v-for="mod in modules" :key="mod.id"
          class="mod-chip" :class="{ active: filterId === mod.id }"
          @click="filterId = filterId === mod.id ? 'all' : mod.id"
        >
          <span>{{ mod.icon }}</span>{{ mod.name }}<b>{{ mod.totalRecords }}</b>
        </button>
      </div>

      <!-- ========== 模块区块（全景铺开） ========== -->
      <section v-for="mod in visibleModules" :key="mod.id" class="panel mod-panel">
        <div class="mod-head">
          <span class="mod-icon">{{ mod.icon }}</span>
          <div class="mod-t">
            <h2 class="mod-name">{{ mod.name }}</h2>
            <span class="mod-meta">{{ mod.datasets.length }} 个数据集 · {{ mod.totalRecords }} 条记录{{ mod.description ? ' · ' + mod.description : '' }}</span>
          </div>
          <div class="mod-actions">
            <button class="text-btn" :class="{ on: !mod.aiCollapsed }" title="AI 业务分析" @click="toggleAi(mod)">
              <AppIcon name="sparkles" :size="13" />AI 分析
              <em v-if="!mod.aiLoading && mod.aiAnalysis">{{ formatDate(mod.aiAnalysis.created_at) }}</em>
            </button>
            <button class="text-btn" title="新建数据集" @click="showAddDatasetFor(mod)">
              <AppIcon name="plus" :size="13" />数据集
            </button>
            <button class="icon-btn" title="编辑模块" @click="showEditModule(mod)"><AppIcon name="pencil" :size="13" /></button>
            <button class="icon-btn" title="删除模块" @click="deleteModule(mod)"><AppIcon name="trash" :size="13" /></button>
          </div>
        </div>

        <!-- AI 业务分析抽屉 -->
        <div v-if="!mod.aiCollapsed" class="ai-drawer">
          <div v-if="mod.aiLoading" class="ai-loading">
            <div class="spinner"></div>
            <span>AI 正在分析业务数据...</span>
          </div>
          <div v-else-if="mod.aiAnalysis" class="ai-content">
            <div class="ai-text markdown-body" v-html="renderMarkdown(mod.aiAnalysis.content)"></div>
            <div class="ai-bar">
              <button class="text-btn" @click="refreshAiAnalysis(mod, true)"><AppIcon name="refresh-cw" :size="12" />刷新</button>
              <button class="text-btn" @click="archiveAnalysis(mod)" :disabled="mod.saving"><AppIcon name="download" :size="12" />存档到默认项目</button>
            </div>
          </div>
          <div v-else class="ai-loading">
            <div class="spinner"></div>
            <span>AI 正在分析...</span>
          </div>
        </div>

        <!-- 数据集卡片网格 -->
        <div class="ds-grid">
          <div v-for="ds in visibleDatasets(mod)" :key="ds.datasetId" class="ds-card">
            <div class="ds-card-head" title="查看全部记录" @click="openFullView(mod, ds)">
              <span class="ds-name">{{ ds.name }}</span>
              <span class="ds-count">{{ ds.recordCount }} 条</span>
            </div>
            <div class="ds-status" v-if="statusChips(ds).length">
              <span v-for="sc in statusChips(ds)" :key="sc.status" class="badge" :class="statusTone(sc.status)">
                {{ sc.status }}<b>{{ sc.count }}</b>
              </span>
            </div>
            <table class="mini-table" v-if="ds.recentRecords && ds.recentRecords.length > 0">
              <thead>
                <tr>
                  <th v-for="col in getPreviewColumns(ds)" :key="col">{{ displayName(ds, col) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="rec in ds.recentRecords.slice(0, 3)" :key="rec.id" @click="viewRecordPortal(rec, ds)">
                  <td v-for="col in getPreviewColumns(ds)" :key="col" :title="rec[col] || ''">{{ truncateText(formatFieldValue(schemaFieldsMap(ds)[col], rec[col]), 24) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="ds-none">暂无记录</div>
            <div class="ds-foot">
              <button class="text-btn" @click="openFullView(mod, ds)">查看全部<AppIcon name="chevron-right" :size="11" /></button>
              <button class="text-btn" @click="showAddRecord(ds)"><AppIcon name="plus" :size="12" />记录</button>
              <span class="grow"></span>
              <button class="text-btn" @click="showEditDatasetPortal(mod, ds)">编辑</button>
              <button class="text-btn text-btn-del" @click="deleteDatasetPortal(mod, ds)">删除</button>
            </div>
          </div>
          <button class="ds-card ds-add" @click="showAddDatasetFor(mod)">
            <AppIcon name="plus" :size="14" /><span>新建数据集</span>
          </button>
        </div>
      </section>

      <div v-if="visibleModules.length === 0" class="none-row">没有匹配「{{ keyword }}」的模块或数据集</div>
    </template>

    <!-- ========== 空状态：内置模板向导 ========== -->
    <template v-else>
      <header class="page-head">
        <div>
          <h1 class="page-title">数据</h1>
          <p class="page-sub">选择一套或多套内置模板一键初始化，也可以手动新建模块</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" @click="showAddModule"><AppIcon name="plus" :size="13" />新建模块</button>
        </div>
      </header>
      <section class="panel suite-panel">
        <div class="sec-label"><AppIcon name="archive" :size="13" />内置数据集模板<em>勾选后一键初始化，含示例数据</em></div>
        <div class="suite-grid">
          <div
            v-for="s in suites"
            :key="s.id"
            class="suite-card"
            :class="{ selected: selectedSuiteIds.includes(s.id) }"
            @click="toggleSuite(s.id)"
          >
            <div class="suite-check">✓</div>
            <div class="suite-icon">{{ s.icon }}</div>
            <div class="suite-name">{{ s.name }}</div>
            <div class="suite-desc">{{ s.description }}</div>
            <div class="suite-meta">{{ s.datasetCount }} 个数据集 · {{ s.sampleCount }} 条示例数据</div>
          </div>
        </div>
        <div class="suite-actions">
          <button class="btn btn-primary" @click="applySelectedSuites" :disabled="selectedSuiteIds.length === 0">
            初始化所选（{{ selectedSuiteIds.length }} 套）
          </button>
        </div>
      </section>
    </template>

    <!-- 内置模板弹窗 -->
    <div v-if="showSuitesModalFlag" class="modal-overlay" @click="showSuitesModalFlag = false">
      <div class="modal-box modal-box-wide" @click.stop>
        <div class="modal-header">
          <h3><AppIcon name="archive" :size="14" />内置数据集模板</h3>
          <button class="btn btn-secondary" @click="showSuitesModalFlag = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="suite-grid">
            <div
              v-for="s in suites"
              :key="s.id"
              class="suite-card"
              :class="{ selected: selectedSuiteIds.includes(s.id), installed: installedSuiteIds().includes(s.id) }"
              @click="toggleSuite(s.id)"
            >
              <div class="suite-check">✓</div>
              <div class="suite-icon">{{ s.icon }}</div>
              <div class="suite-name">{{ s.name }}</div>
              <div class="suite-desc">{{ s.description }}</div>
              <div class="suite-meta">{{ s.datasetCount }} 个数据集 · {{ s.sampleCount }} 条示例数据</div>
              <div class="suite-badge" v-if="installedSuiteIds().includes(s.id)">已安装</div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <span class="footer-hint">已安装的模板可再次点击跳过</span>
          <button class="btn btn-secondary" @click="showSuitesModalFlag = false">取消</button>
          <button class="btn btn-primary" @click="applySelectedSuites" :disabled="selectedSuiteIds.length === 0">
            初始化所选（{{ selectedSuiteIds.length }} 套）
          </button>
        </div>
      </div>
    </div>

    <!-- 全量数据查看模态框 -->
    <div v-if="fullViewVisible" class="modal-overlay" @click="closeFullView">
      <div class="modal-box modal-box-wide" @click.stop>
        <div class="modal-header">
          <h3><AppIcon name="clipboard-list" :size="14" />{{ fullViewDs?.name || '数据集' }}</h3>
          <div class="modal-header-actions">
            <span class="modal-badge">{{ fullViewDs?.recordCount || 0 }} 条记录</span>
            <button class="btn btn-secondary" @click="closeFullView">✕</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="fullview-toolbar">
            <div class="search-box">
              <input type="text" v-model="fullViewKeyword" placeholder="搜索记录..." @keyup.enter="loadFullViewRecords()">
            </div>
            <button class="btn btn-sm btn-secondary" @click="loadFullViewRecords()">搜索</button>
            <button class="btn btn-sm btn-primary" @click="showAddRecord()"><AppIcon name="plus" :size="12" />记录</button>
            <button class="btn btn-sm btn-secondary" @click="showImportModal">导入</button>
          </div>
          <table class="data-table" v-if="fullViewRecords.length > 0">
            <thead>
              <tr>
                <th class="th-status">状态</th>
                <th v-for="col in fullViewColumns" :key="col" class="th-data">{{ (fullViewFieldsMap[col] && fullViewFieldsMap[col].displayName) || col }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="rec in fullViewRecords" :key="rec.id" class="fv-row" @click="viewRecordPortal(rec, fullViewDs)">
                <td class="td-status" @click.stop><span class="badge badge-gray">{{ rec.status || '无' }}</span></td>
                <td v-for="col in fullViewColumns" :key="col" class="td-data" :title="rec[col] || ''">{{ truncateText(formatFieldValue(fullViewFieldsMap[col], rec[col]), 30) || '' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="right-empty">
            <div class="empty-icon">📝</div>
            <div class="empty-title">暂无记录</div>
            <button class="btn btn-primary btn-sm" @click="showAddRecord()">+ 新增记录</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 数据集模态框 -->
    <div v-if="showDsModal" class="modal-overlay">
      <div class="modal-box modal-box-ds" @click.stop>
        <div class="modal-header">
          <h3>{{ editingDsId ? '编辑数据集' : '新建数据集' }}</h3>
          <button class="btn btn-secondary" @click="showDsModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>名称 *</label>
            <input type="text" class="form-control" v-model="dsForm.name" placeholder="例如：客户信息、项目列表">
          </div>
          <div class="form-group">
            <label>所属模块</label>
            <select v-model="dsForm.moduleId" class="form-control">
              <option value="">（无模块）</option>
              <option v-for="mod in modules" :key="mod.id" :value="mod.id">{{ mod.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <div class="label-row">
              <label>字段定义</label>
              <button class="btn btn-sm btn-secondary" @click="addFieldRow">+ 添加字段</button>
            </div>
            <div class="field-editor">
              <div v-for="(row, idx) in dsForm.fields" :key="idx" class="field-row">
                <div class="field-row-grid">
                  <input
                    type="text" class="form-control form-control-sm"
                    :placeholder="'显示名，如：客户名称'"
                    :value="row.displayName"
                    @input="row.displayName = ($event.target as HTMLInputElement).value; autoFillFieldName(row, idx)"
                  >
                  <input
                    type="text" class="form-control form-control-sm"
                    :value="row.name"
                    @input="row.name = ($event.target as HTMLInputElement).value"
                    placeholder="字段名(field_N)"
                  >
                  <select
                    class="form-control form-control-sm field-type"
                    :value="row.type"
                    @change="row.type = ($event.target as HTMLSelectElement).value"
                  >
                    <option v-for="t in FIELD_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
                  </select>
                  <input
                    v-if="row.type === 'select'"
                    type="text" class="form-control form-control-sm field-options"
                    :value="(row.options || []).join(',')"
                    @input="row.options = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)"
                    placeholder="选项，逗号分隔"
                  >
                  <label class="field-required">
                    <input type="checkbox" v-model="row.required"> 必填
                  </label>
                  <button class="btn btn-sm btn-secondary field-del" @click="removeFieldRow(idx)">×</button>
                </div>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>类型选项（每行一个，可选）</label>
            <textarea class="form-control" v-model="dsForm.typeOptions" rows="4" placeholder="例如：&#10;个人&#10;企业"></textarea>
          </div>
          <div class="form-group">
            <label>状态选项（每行一个，可选）</label>
            <textarea class="form-control" v-model="dsForm.statusOptions" rows="4" placeholder="例如：&#10;待办&#10;进行中&#10;已完成"></textarea>
          </div>
          <div class="form-group">
            <label>描述（可选）</label>
            <textarea class="form-control" v-model="dsForm.description" rows="2" placeholder="数据集的简要说明"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showDsModal = false">取消</button>
          <button class="btn btn-primary" @click="saveDataset">保存</button>
        </div>
      </div>
    </div>

    <!-- 模块模态框 -->
    <div v-if="showModuleModal" class="modal-overlay">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>{{ editingModuleId ? '编辑模块' : '新建模块' }}</h3>
          <button class="btn btn-secondary" @click="showModuleModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>名称 *</label>
            <input type="text" class="form-control" v-model="moduleForm.name" placeholder="例如：客户管理、项目管理">
          </div>
          <div class="form-group">
            <label>图标（可选）</label>
            <input type="text" class="form-control" v-model="moduleForm.icon" placeholder="📁">
          </div>
          <div class="form-group">
            <label>描述（可选）</label>
            <textarea class="form-control" v-model="moduleForm.description" rows="3" placeholder="模块的简要说明"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showModuleModal = false">取消</button>
          <button class="btn btn-primary" @click="saveModule">保存</button>
        </div>
      </div>
    </div>

    <!-- 记录模态框 -->
    <div v-if="showRecordModal" class="modal-overlay" @click="showRecordModal = false">
      <div class="modal-box modal-box-record" @click.stop>
        <div class="modal-header">
          <h3>{{ editingRecordId ? '编辑记录' : '新增记录' }}</h3>
          <button class="btn btn-secondary" @click="showRecordModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>状态</label>
            <select class="form-control" v-model="recordForm.status">
              <option v-for="opt in recordStatusOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>
          <div class="form-group" v-if="recordTypeOptions.length">
            <label>类型</label>
            <select class="form-control" v-model="recordForm.type">
              <option v-for="opt in recordTypeOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>
          <div v-for="field in recordFormFields" :key="field.name" class="form-group">
            <label>{{ field.displayName || field.name }}<span v-if="field.required" class="req-mark"> *</span></label>
            <select
              v-if="field.type === 'select'"
              class="form-control" :value="recordForm[field.name] ?? ''"
              @change="recordForm[field.name] = ($event.target as HTMLSelectElement).value"
            >
              <option value="" disabled>请选择</option>
              <option v-for="opt in (field.options || [])" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <textarea
              v-else-if="field.type === 'textarea'" class="form-control" rows="3"
              :value="recordForm[field.name] ?? ''"
              @input="recordForm[field.name] = ($event.target as HTMLTextAreaElement).value"
            ></textarea>
            <input
              v-else-if="field.type === 'number'"
              type="number" step="any" class="form-control"
              :value="recordForm[field.name] ?? ''"
              @input="recordForm[field.name] = ($event.target as HTMLInputElement).value"
            >
            <input
              v-else-if="field.type === 'money'"
              type="number" step="0.01" class="form-control"
              :value="recordForm[field.name] ?? ''"
              @input="recordForm[field.name] = ($event.target as HTMLInputElement).value"
            >
            <input
              v-else-if="field.type === 'date'" type="date" class="form-control"
              :value="recordForm[field.name] ?? ''"
              @input="recordForm[field.name] = ($event.target as HTMLInputElement).value"
            >
            <input
              v-else-if="field.type === 'datetime'" type="datetime-local" class="form-control"
              :value="recordForm[field.name] ?? ''"
              @input="recordForm[field.name] = ($event.target as HTMLInputElement).value"
            >
            <input
              v-else type="text" class="form-control"
              :value="recordForm[field.name] ?? ''"
              @input="recordForm[field.name] = ($event.target as HTMLInputElement).value"
            >
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showRecordModal = false">取消</button>
          <button class="btn btn-primary" @click="saveRecord">保存</button>
        </div>
      </div>
    </div>

    <!-- 详情模态框 -->
    <div v-if="showDetailModal" class="modal-overlay" @click="showDetailModal = false">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>记录详情</h3>
          <button class="btn btn-secondary" @click="showDetailModal = false">✕</button>
        </div>
        <div class="modal-body" v-if="viewingRecord">
          <div class="detail-row">
            <span class="label">状态</span>
            <span class="value"><span class="badge badge-gray">{{ viewingRecord.status || '无' }}</span></span>
          </div>
          <div v-for="field in viewingRecordFields" :key="field" class="detail-row">
            <span class="label">{{ (viewingRecordFieldsMap[field] && viewingRecordFieldsMap[field].displayName) || field }}</span>
            <span class="value">{{ formatFieldValue(viewingRecordFieldsMap[field], viewingRecord[field]) || '' }}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-danger" @click="deleteFromDetail">删除</button>
          <button class="btn btn-primary" @click="editFromDetail">编辑</button>
          <button class="btn btn-secondary" @click="showDetailModal = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 导入模态框 -->
    <div v-if="showImportModalFlag" class="modal-overlay" @click="showImportModalFlag = false">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>数据导入</h3>
          <button class="btn btn-secondary" @click="showImportModalFlag = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>导入方式</label>
            <div class="import-type-btns">
              <button class="btn" :class="importType === 'json' ? 'btn-primary' : 'btn-secondary'" @click="importType = 'json'">JSON</button>
              <button class="btn" :class="importType === 'url' ? 'btn-primary' : 'btn-secondary'" @click="importType = 'url'">URL</button>
            </div>
          </div>
          <div v-if="importType === 'json'" class="form-group">
            <label>JSON 数据</label>
            <textarea class="form-control" v-model="importJsonData" rows="8"></textarea>
          </div>
          <div v-if="importType === 'url'" class="form-group">
            <label>数据 URL</label>
            <input type="text" class="form-control" v-model="importUrl">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showImportModalFlag = false">取消</button>
          <button class="btn btn-primary" @click="doImport">开始导入</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import AppIcon from '@/components/AppIcon.vue';

const API = (window as any).electronAPI;
const route = useRoute();

interface FieldDef {
  name: string;
  displayName?: string;
  type: string;
  required?: boolean;
  options?: string[];
  defaultValue?: string;
}

function normalizeType(t: string | undefined | null): string {
  const valid = FIELD_TYPES.some(f => f.value === t);
  return valid ? (t as string) : 'text';
}

const FIELD_TYPES: { value: string; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'money', label: '金额' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期时间' },
  { value: 'select', label: '下拉选项' },
];

function newFieldRow(): FieldDef {
  return { name: '', displayName: '', type: 'text', required: false, options: [], defaultValue: '' };
}

interface ModuleData {
  id: string;
  name: string;
  description: string;
  icon: string;
  totalRecords: number;
  aiLoading: boolean;
  aiAnalysis: any;
  aiCollapsed: boolean;
  saving: boolean;
  datasets: DatasetData[];
}

interface DatasetData {
  datasetId: string | number;
  name: string;
  description: string;
  schema: any;
  recordCount: number;
  statusCounts?: { status: string; count: number }[];
  recentRecords: any[];
}

const modules = ref<ModuleData[]>([]);
const loaded = ref(false);

// ========== 全景筛选 ==========
const filterId = ref<string>('all');
const keyword = ref('');

const kw = computed(() => keyword.value.trim().toLowerCase());

const visibleModules = computed(() => {
  const k = kw.value;
  return modules.value.filter(m => {
    if (filterId.value !== 'all' && filterId.value !== m.id) return false;
    if (!k) return true;
    return m.name.toLowerCase().includes(k)
      || m.datasets.some(d => d.name.toLowerCase().includes(k) || (d.description || '').toLowerCase().includes(k));
  });
});

function visibleDatasets(mod: ModuleData): DatasetData[] {
  const k = kw.value;
  if (!k || mod.name.toLowerCase().includes(k)) return mod.datasets;
  return mod.datasets.filter(d =>
    d.name.toLowerCase().includes(k) || (d.description || '').toLowerCase().includes(k));
}

const totalDatasets = computed(() => modules.value.reduce((s, m) => s + m.datasets.length, 0));
const totalRecords = computed(() => modules.value.reduce((s, m) => s + m.totalRecords, 0));
const todayRecords = ref(0);

const pageDateStr = computed(() => {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
});

// 状态语气：完结类→绿，停滞/流失类→灰，待动类→橙，其余→主色
const POSITIVE_STATUS = ['完成', '成交', '到账', '达成', '通过', '录用', '出库', '入库', '修复', '招满'];
const NEGATIVE_STATUS = ['流失', '淘汰', '报废', '停用', '终止', '失败', '未通过', '逾期', '关闭', '暂停', '闲置'];
function statusTone(status: string): string {
  if (status === '无') return 'badge-gray';
  if (NEGATIVE_STATUS.some(s => status.includes(s))) return 'badge-gray';
  if (POSITIVE_STATUS.some(s => status.includes(s))) return 'badge-success';
  if (status.includes('待')) return 'badge-warning';
  return 'badge-primary';
}

/** 状态分布展示：无状态(无)桶是噪音——有其他状态时单独丢弃，只剩「无」时整行隐藏 */
function statusChips(ds: DatasetData): { status: string; count: number }[] {
  const chips = (ds.statusCounts || []).filter(sc => sc.status !== '无');
  return chips;
}

// ========== 数据加载 ==========

async function loadAll() {
  if (!API) { loaded.value = true; return; }
  try {
    const modList = await API.dm.list();
    const overviews = await Promise.all(
      modList.map((m: any) => API.archive.moduleOverview(m.module_id || m.id).catch(() => null))
    );
    const result: ModuleData[] = [];
    for (let i = 0; i < modList.length; i++) {
      const m = modList[i];
      const ov = overviews[i];
      const mid = m.module_id || m.id;
      result.push({
        id: mid,
        name: m.name,
        description: m.description || '',
        icon: m.icon || '📁',
        totalRecords: ov?.datasets?.reduce((s: number, d: any) => s + (d.recordCount || 0), 0) || 0,
        aiLoading: false,
        aiAnalysis: ov?.analysis || null,
        aiCollapsed: true,
        saving: false,
        datasets: ov?.datasets || [],
      });
    }
    modules.value = result;
  } catch (e) { console.error('加载模块数据失败:', e); }
  loaded.value = true;
}

async function loadTodayStats() {
  if (!API) return;
  try {
    const s = await API.insights.stats();
    todayRecords.value = s.todayDataRecords || 0;
  } catch { /* 统计失败不影响页面 */ }
}

// ========== 内置模板 ==========

interface SuiteInfo {
  id: string;
  name: string;
  icon: string;
  description: string;
  datasetCount: number;
  sampleCount: number;
  moduleIds: string[];
}

const suites = ref<SuiteInfo[]>([]);
const selectedSuiteIds = ref<string[]>([]);
const showSuitesModalFlag = ref(false);

async function loadSuites() {
  if (!API) return;
  try {
    const list = await API.suites.list();
    suites.value = list.map((s: any) => ({
      id: s.id, name: s.name, icon: s.icon, description: s.description,
      datasetCount: s.datasetCount, sampleCount: s.sampleCount,
      moduleIds: (s.modules || []).map((m: any) => m.moduleId),
    }));
  } catch (e) { console.error('加载内置模板失败:', e); }
}

function showSuitesModal() {
  showSuitesModalFlag.value = true;
}

function toggleSuite(id: string) {
  const i = selectedSuiteIds.value.indexOf(id);
  if (i >= 0) selectedSuiteIds.value.splice(i, 1);
  else selectedSuiteIds.value.push(id);
}

function installedSuiteIds() {
  const installed: string[] = [];
  const modIds = new Set(modules.value.map((m: any) => m.id));
  suites.value.forEach((s: any) => {
    if (s.moduleIds.some((mid: string) => modIds.has(mid))) installed.push(s.id);
  });
  return installed;
}

async function applySelectedSuites() {
  if (!API || selectedSuiteIds.value.length === 0) return;
  showSuitesModalFlag.value = false;
  try {
    // 注意：不要直接传 selectedSuiteIds.value（Vue reactive Proxy），
    // Electron IPC 用 structured clone 序列化参数，无法克隆 Proxy，
    // 会报 "An object could not be cloned"，且主进程根本收不到请求。
    const res = await API.suites.apply([...selectedSuiteIds.value]);
    selectedSuiteIds.value = [];
    await loadAll();
    if (res.error) {
      alert('初始化失败：' + res.error);
      return;
    }
    alert(`初始化完成：${res.applied?.length || 0} 个模块已创建${res.skipped?.length ? `，${res.skipped.length} 个已存在已跳过` : ''}${res.failed?.length ? `，${res.failed.length} 个失败` : ''}`);
  } catch (e) {
    console.error('初始化内置模板失败:', e);
    alert('初始化失败: ' + e);
    await loadAll();
  }
}

// ========== 模块管理 ==========

const showModuleModal = ref(false);
const editingModuleId = ref('');
const moduleForm = ref({ name: '', icon: '📁', description: '' });

function showAddModule() {
  editingModuleId.value = '';
  moduleForm.value = { name: '', icon: '📁', description: '' };
  showModuleModal.value = true;
}

function showEditModule(mod: ModuleData) {
  editingModuleId.value = mod.id;
  moduleForm.value = { name: mod.name, icon: mod.icon || '📁', description: mod.description };
  showModuleModal.value = true;
}

async function saveModule() {
  if (!moduleForm.value.name.trim()) { alert('请输入模块名称'); return; }
  if (!API) return;
  try {
    if (editingModuleId.value) {
      await API.dm.update(editingModuleId.value, {
        name: moduleForm.value.name,
        icon: moduleForm.value.icon,
        description: moduleForm.value.description,
      });
    } else {
      await API.dm.add(moduleForm.value.name, moduleForm.value.description, moduleForm.value.icon);
    }
    showModuleModal.value = false;
    await loadAll();
  } catch (e) { console.error('保存模块失败:', e); }
}

async function deleteModule(mod: ModuleData) {
  if (!confirm(`确定删除模块「${mod.name}」及其下所有数据集？`)) return;
  if (!API) return;
  try {
    await API.dm.remove(mod.id);
    if (filterId.value === mod.id) filterId.value = 'all';
    await loadAll();
  } catch (e) { console.error('删除模块失败:', e); }
}

// ========== 数据集管理 ==========

const showDsModal = ref(false);
const editingDsId = ref<string | number>('');
const dsForm = ref({ name: '', moduleId: '', description: '', fields: [] as FieldDef[], typeOptions: '', statusOptions: '' });

function showAddDatasetFor(mod?: ModuleData) {
  editingDsId.value = '';
  dsForm.value = { name: '', moduleId: mod ? mod.id : '', description: '', fields: [newFieldRow()], typeOptions: '', statusOptions: '' };
  showDsModal.value = true;
}

function showEditDatasetPortal(mod: ModuleData, ds: DatasetData) {
  editingDsId.value = ds.datasetId;
  const schema = (typeof ds.schema === 'string' ? JSON.parse(ds.schema) : ds.schema) || {};
  dsForm.value = {
    name: ds.name || '',
    moduleId: mod.id,
    description: ds.description || '',
    fields: (schema.fields && schema.fields.length ? schema.fields : [newFieldRow()]).map((f: any) => ({
      name: f.name || f.displayName || '',
      displayName: f.displayName || f.name || '',
      type: normalizeType(f.type),
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options : [],
      defaultValue: f.defaultValue !== undefined && f.defaultValue !== null ? String(f.defaultValue) : '',
    })),
    typeOptions: (schema.typeOptions || []).join('\n'),
    statusOptions: (schema.statusOptions || []).join('\n'),
  };
  showDsModal.value = true;
}

function addFieldRow() {
  dsForm.value.fields.push(newFieldRow());
}

function removeFieldRow(idx: number) {
  dsForm.value.fields.splice(idx, 1);
}

function autoFillFieldName(row: FieldDef, idx: number) {
  const raw = (row.name || '').trim();
  if (!raw) {
    row.name = 'field_' + (idx + 1);
  }
}

async function saveDataset() {
  if (!dsForm.value.name.trim()) { alert('请输入数据集名称'); return; }
  if (!API) return;
  const seen = new Set<string>();
  const fields: any[] = [];
  dsForm.value.fields.forEach((f, idx) => {
    const displayName = (f.displayName || '').trim();
    let name = (f.name || '').trim();
    if (!name) name = 'field_' + (idx + 1);
    if (!displayName && !name) return;
    if (seen.has(name)) {
      name = name + '_' + (seen.size + 1);
    }
    seen.add(name);
    const field: any = {
      name,
      displayName: displayName || name,
      type: normalizeType(f.type),
      required: !!f.required,
    };
    if (field.type === 'select' && f.options && f.options.length) field.options = f.options.filter(Boolean);
    fields.push(field);
  });
  const schemaJson = JSON.stringify({
    fields,
    typeOptions: dsForm.value.typeOptions.split('\n').map(s => s.trim()).filter(Boolean),
    statusOptions: dsForm.value.statusOptions.split('\n').map(s => s.trim()).filter(Boolean),
  });
  try {
    const moduleId = dsForm.value.moduleId;
    if (editingDsId.value) {
      await API.ds.updateMeta(editingDsId.value, {
        name: dsForm.value.name, description: dsForm.value.description,
        schema_json: schemaJson, module_id: moduleId,
      });
    } else {
      await API.ds.add({ name: dsForm.value.name, description: dsForm.value.description, schemaJson, module_id: moduleId });
    }
    showDsModal.value = false;
    await loadAll();
  } catch (e) { console.error('保存数据集失败:', e); }
}

async function deleteDatasetPortal(mod: ModuleData, ds: DatasetData) {
  if (!confirm(`确定删除数据集「${ds.name}」及所有数据？`)) return;
  if (!API) return;
  try {
    await API.ds.remove(ds.datasetId);
    await loadAll();
  } catch (e) { console.error('删除数据集失败:', e); }
}

// ========== AI 分析 ==========

function isTodayAnalysis(analysis: any): boolean {
  if (!analysis || !analysis.created_at) return false;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const d = new Date(analysis.created_at);
    const dStr = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return dStr === today;
  } catch { return String(analysis.created_at).slice(0, 10) === today; }
}

function ensureAiAnalysis(mod: ModuleData) {
  if (!isTodayAnalysis(mod.aiAnalysis)) {
    refreshAiAnalysis(mod);
  }
}

function toggleAi(mod: ModuleData) {
  mod.aiCollapsed = !mod.aiCollapsed;
  if (!mod.aiCollapsed) ensureAiAnalysis(mod);
}

async function refreshAiAnalysis(mod: ModuleData, force?: boolean) {
  if (!API) return;
  mod.aiLoading = true;
  try {
    const res = await API.archive.moduleAnalysis(mod.id, force);
    if (res.ok && res.content) {
      mod.aiAnalysis = { id: res.analysisId, content: res.content, created_at: new Date().toISOString() };
      if (res.fromCache) {
        mod.aiAnalysis.created_at = res.date || mod.aiAnalysis.created_at;
      }
    }
  } catch (e) {
    console.error('AI 分析失败:', e);
  }
  mod.aiLoading = false;
}

async function archiveAnalysis(mod: ModuleData) {
  if (!API || !mod.aiAnalysis) return;
  const analysisId = mod.aiAnalysis.id;
  if (!analysisId) {
    alert('请先保存分析结果');
    return;
  }
  mod.saving = true;
  try {
    const res = await API.archive.saveAnalysisToNotes(mod.id, analysisId);
    if (res.ok) {
      alert('已存档到默认项目: ' + res.filePath);
    } else {
      alert('存档失败: ' + (res.error || '未知错误'));
    }
  } catch (e) {
    alert('存档失败: ' + e);
  }
  mod.saving = false;
}

// ========== 全量数据查看 ==========

const fullViewVisible = ref(false);
const fullViewMod = ref<ModuleData | null>(null);
const fullViewDs = ref<DatasetData | null>(null);
const fullViewRecords = ref<any[]>([]);
const fullViewColumns = ref<string[]>([]);
const fullViewFieldsMap = ref<Record<string, FieldDef>>({});
const fullViewKeyword = ref('');

function openFullView(mod: ModuleData, ds: DatasetData) {
  fullViewMod.value = mod;
  fullViewDs.value = ds;
  fullViewKeyword.value = '';
  fullViewFieldsMap.value = schemaFieldsMap(ds);
  fullViewVisible.value = true;
  loadFullViewRecords();
}

function closeFullView() {
  fullViewVisible.value = false;
  fullViewMod.value = null;
  fullViewDs.value = null;
  fullViewRecords.value = [];
  fullViewColumns.value = [];
  fullViewFieldsMap.value = {};
}

async function loadFullViewRecords() {
  if (!fullViewDs.value || !API) return;
  try {
    const rows = await API.ds.query(fullViewDs.value.datasetId, fullViewKeyword.value || null);
    fullViewRecords.value = rows;
    fullViewColumns.value = buildRecordColumns(rows);
  } catch (e) { console.error('加载记录失败:', e); fullViewRecords.value = []; fullViewColumns.value = []; }
}

// ========== 记录 CRUD（复用） ==========

const showRecordModal = ref(false);
const editingRecordId = ref('');
const recordForm = ref<any>({ status: '进行中' });
const recordFormFields = ref<FieldDef[]>([]);
const recordStatusOptions = ref<string[]>(['待办', '进行中', '已完成']);
const recordTypeOptions = ref<string[]>([]);

const showDetailModal = ref(false);
const viewingRecord = ref<any>(null);
const viewingRecordDs = ref<any>(null);
const viewingRecordFields = ref<string[]>([]);
const viewingRecordFieldsMap = ref<Record<string, FieldDef>>({});

const showImportModalFlag = ref(false);
const importType = ref('json');
const importJsonData = ref('');
const importUrl = ref('');

let currentRecordDs: any = null;

function getSchemaFields(ds: any): FieldDef[] {
  if (!ds) return [];
  const schema = typeof ds.schema === 'string' ? JSON.parse(ds.schema) : ds.schema;
  const fields = (schema && schema.fields) || [];
  return fields.map((f: any) => ({
    name: f.name || f.displayName || '',
    displayName: f.displayName || f.name || '',
    type: normalizeType(f.type),
    required: !!f.required,
    options: Array.isArray(f.options) ? f.options : [],
    defaultValue: f.defaultValue !== undefined && f.defaultValue !== null ? String(f.defaultValue) : '',
  })).filter((f: FieldDef) => f.name && f.name !== 'status' && f.name !== 'id' && f.name !== 'type' && f.name !== '类型');
}

function getSchemaOptions(ds: any, key: string) {
  if (!ds) return [];
  const schema = typeof ds.schema === 'string' ? JSON.parse(ds.schema) : ds.schema;
  const opts = schema?.[key];
  return Array.isArray(opts) && opts.length ? opts : [];
}

function fieldDefaultValue(field: FieldDef) {
  if (field.defaultValue !== undefined && field.defaultValue !== null && String(field.defaultValue) !== '') {
    return String(field.defaultValue);
  }
  return '';
}

function showAddRecord(dsArg?: any) {
  const ds = dsArg || fullViewDs.value;
  if (!ds) return;
  currentRecordDs = ds;
  editingRecordId.value = '';
  recordFormFields.value = getSchemaFields(ds);
  recordStatusOptions.value = [...getSchemaOptions(ds, 'statusOptions'), '待办', '进行中', '已完成'];
  recordTypeOptions.value = getSchemaOptions(ds, 'typeOptions');
  const form: any = { status: '进行中' };
  if (recordTypeOptions.value.length) form.type = recordTypeOptions.value[0];
  recordFormFields.value.forEach((f) => { form[f.name] = fieldDefaultValue(f); });
  recordForm.value = form;
  showRecordModal.value = true;
}

function editRecordPortal(mod: ModuleData | null, ds: DatasetData, rec: any) {
  currentRecordDs = ds;
  editingRecordId.value = rec.id;
  recordFormFields.value = getSchemaFields(ds);
  recordStatusOptions.value = [...getSchemaOptions(ds, 'statusOptions'), '待办', '进行中', '已完成'];
  recordTypeOptions.value = getSchemaOptions(ds, 'typeOptions');
  const form: any = { status: rec.status || '', type: rec.type || '' };
  recordFormFields.value.forEach((f) => { form[f.name] = rec[f.name] ?? ''; });
  recordForm.value = form;
  showRecordModal.value = true;
}

async function saveRecord() {
  const ds = currentRecordDs || fullViewDs.value;
  if (!ds || !API) return;
  const missingReq: string[] = [];
  const record: any = {};
  recordFormFields.value.forEach(f => {
    const v = recordForm.value[f.name];
    if ((v === null || v === undefined || v === '') && f.required) missingReq.push(f.displayName || f.name);
    record[f.name] = v;
  });
  if (missingReq.length) {
    alert('以下必填字段不能为空：' + missingReq.join('、'));
    return;
  }
  if (recordForm.value.status) record.status = recordForm.value.status;
  if (recordForm.value.type) record.type = recordForm.value.type;
  try {
    if (editingRecordId.value) {
      await API.ds.updateRecord(editingRecordId.value, record);
    } else {
      await API.ds.insert(ds.datasetId, record);
    }
    showRecordModal.value = false;
    if (fullViewVisible.value) {
      await loadFullViewRecords();
    }
    await loadAll();
    alert('已保存');
  } catch (e: any) {
    console.error('保存记录失败:', e);
    alert('保存失败：' + ((e && e.message) || '未知错误'));
  }
}

async function deleteRecordPortal(rec: any) {
  if (!confirm('确定删除这条记录？') || !API) return;
  try {
    await API.ds.deleteRecord(rec.id);
    if (fullViewVisible.value) {
      await loadFullViewRecords();
    }
    await loadAll();
  } catch (e) { console.error('删除记录失败:', e); }
}

function viewRecordPortal(rec: any, dsArg?: any) {
  viewingRecord.value = rec;
  viewingRecordDs.value = dsArg || null;
  viewingRecordFieldsMap.value = dsArg ? schemaFieldsMap(dsArg) : {};
  viewingRecordFields.value = Object.keys(rec).filter(k => k !== 'id' && !k.startsWith('_'));
  showDetailModal.value = true;
}

function editFromDetail() {
  if (viewingRecord.value && viewingRecordDs.value) {
    showDetailModal.value = false;
    editRecordPortal(null, viewingRecordDs.value, viewingRecord.value);
  }
}

function deleteFromDetail() {
  if (viewingRecord.value) { showDetailModal.value = false; deleteRecordPortal(viewingRecord.value); }
}

// ========== 导入 ==========

function showImportModal() {
  importType.value = 'json';
  importJsonData.value = '';
  importUrl.value = '';
  showImportModalFlag.value = true;
}

async function doImport() {
  const ds = fullViewDs.value;
  if (!ds || !API) { alert('请先选择数据集'); return; }
  try {
    if (importType.value === 'json') {
      if (!importJsonData.value.trim()) { alert('请输入JSON数据'); return; }
      let arr;
      try { arr = JSON.parse(importJsonData.value); if (!Array.isArray(arr)) throw 0; }
      catch (e) { alert('JSON格式错误，需要数组'); return; }
      for (const item of arr) await API.ds.insert(ds.datasetId, item);
    } else {
      if (!importUrl.value.trim()) { alert('请输入URL'); return; }
      const r = await fetch(importUrl.value.trim());
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) await API.ds.insert(ds.datasetId, item);
    }
    showImportModalFlag.value = false;
    alert('导入完成');
    if (fullViewVisible.value) await loadFullViewRecords();
    await loadAll();
  } catch (e) { console.error('导入失败:', e); alert('导入失败: ' + e); }
}

// ========== 工具函数 ==========

function schemaFieldsMap(ds: any): Record<string, FieldDef> {
  const map: Record<string, FieldDef> = {};
  getSchemaFields(ds).forEach((f) => { map[f.name] = f; });
  return map;
}

function displayName(ds: any, col: string): string {
  const f = schemaFieldsMap(ds)[col];
  return (f && f.displayName) || col;
}

function formatFieldValue(field: FieldDef | undefined, value: any): string {
  if (value === null || value === undefined || value === '') return '';
  if (field && field.type === 'money') {
    const n = Number(value);
    if (!isNaN(n)) return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

function buildRecordColumns(recs: any[]): string[] {
  const cols = new Set<string>();
  recs.forEach((r: any) => { Object.keys(r).forEach(k => { if (k !== 'id' && k !== '_created_at' && !k.startsWith('_')) cols.add(k); }); });
  return Array.from(cols).slice(0, 8);
}

function getPreviewColumns(ds: DatasetData): string[] {
  if (!ds.recentRecords || ds.recentRecords.length === 0) return [];
  const schemaCols = getSchemaFields(ds).map(f => f.name).filter(n => !['status', 'id', 'type', '类型'].includes(n));
  const cols = schemaCols.length ? schemaCols : buildRecordColumns(ds.recentRecords);
  return cols.slice(0, 4);
}

function truncateText(text: string, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toISOString().slice(0, 10);
  } catch { return dateStr.slice(0, 10); }
}

function renderMarkdown(text: string): string {
  if (!text) return '';
  try { return marked(text); } catch { return text; }
}

onMounted(async () => {
  await loadAll();
  await loadSuites();
  loadTodayStats();
  // 工具箱跳转：?action=import 自动打开导入弹窗
  if (route.query.action === 'import') showImportModal();
});
</script>

<style scoped>
/* ========== 页头 ========== */
.filter-input { width: 190px; padding: 6px 10px; font-size: 12.5px; }
.statline { display: flex; gap: 14px; flex-wrap: wrap; }
.statline b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.statline .acc { color: var(--primary); }

/* ========== 模块筛选 chips ========== */
.mod-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
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

/* ========== 模块区块 ========== */
.mod-panel { margin-bottom: 16px; }
.mod-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.mod-icon { font-size: 18px; flex-shrink: 0; }
.mod-t { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.mod-name { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.mod-meta {
  font-size: 11.5px; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mod-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

/* AI 抽屉 */
.ai-drawer { padding: 14px 16px 16px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.ai-loading { display: flex; align-items: center; gap: 10px; color: var(--text-muted); font-size: 13px; padding: 4px 0; }
.ai-text { font-size: 13px; }
.ai-bar { display: flex; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }

/* ========== 数据集卡片网格 ========== */
.ds-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px; padding: 14px 16px;
}
.ds-card {
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-md); overflow: hidden;
  display: flex; flex-direction: column;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.ds-card:hover { border-color: rgba(var(--primary-rgb), 0.45); box-shadow: var(--shadow-sm); }
.ds-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px 8px; cursor: pointer;
}
.ds-name {
  font-size: 13.5px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ds-card-head:hover .ds-name { color: var(--primary); }
.ds-count {
  font-size: 11px; color: var(--text-muted); background: var(--hover);
  padding: 1px 8px; border-radius: 10px; flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.ds-status { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 10px; }
.ds-status .badge { font-size: 10.5px; padding: 2px 7px; gap: 3px; }
.ds-status .badge b { font-weight: 600; }

/* 迷你预览表 */
.mini-table { width: 100%; border-collapse: collapse; font-size: 12px; border-top: 1px solid var(--border); }
.mini-table th {
  text-align: left; padding: 6px 12px; background: var(--surface);
  border-bottom: 1px solid var(--border); font-weight: 500;
  color: var(--text-muted); font-size: 11px; white-space: nowrap;
}
.mini-table td {
  padding: 6px 12px; border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mini-table tbody tr { cursor: pointer; }
.mini-table tbody tr:hover { background: var(--hover); }
.mini-table tbody tr:hover td { color: var(--text-primary); }
.mini-table tbody tr:last-child td { border-bottom: none; }
.ds-none { padding: 16px 12px; font-size: 12px; color: var(--text-muted); text-align: center; }
.ds-foot {
  display: flex; align-items: center; gap: 2px;
  padding: 6px 8px; border-top: 1px solid var(--border); margin-top: auto;
}
.ds-foot .grow { flex: 1; }
.ds-add {
  border-style: dashed; background: transparent;
  color: var(--text-muted); align-items: center; justify-content: center;
  flex-direction: row; gap: 6px; min-height: 64px;
  cursor: pointer; font-size: 13px; font-family: inherit;
}
.ds-add:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); box-shadow: none; }

/* ========== 文本按钮 ========== */
.text-btn {
  background: none; border: none; cursor: pointer; font-size: 12px;
  color: var(--text-secondary); padding: 4px 8px; border-radius: 4px;
  display: inline-flex; align-items: center; gap: 4px; font-family: inherit;
}
.text-btn:hover { background: var(--hover); color: var(--primary); }
.text-btn-del:hover { color: var(--danger); }
.text-btn:disabled { opacity: 0.5; cursor: default; }
.text-btn.on { background: var(--primary-soft); color: var(--primary); }
.text-btn em { font-style: normal; font-size: 10.5px; color: var(--text-muted); }

/* ========== 空状态 ========== */
.none-row { padding: 40px 0; text-align: center; color: var(--text-muted); font-size: 13px; }
.empty-icon { font-size: 40px; margin-bottom: 10px; opacity: 0.4; }
.empty-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; color: var(--text-primary); }
.right-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: var(--text-muted);
  padding: 40px 0;
}

/* ========== 内置模板 ========== */
.suite-panel { padding: 16px; }
.suite-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px; margin-top: 4px;
}
.suite-card {
  position: relative; border: 1px solid var(--border);
  border-radius: 8px; padding: 14px 16px; cursor: pointer;
  background: var(--surface); text-align: left; transition: all 0.2s;
}
.suite-card:hover { border-color: var(--primary); box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.12); }
.suite-card.selected { border-color: var(--primary); background: var(--primary-soft); box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15); }
.suite-check {
  position: absolute; top: 10px; right: 10px;
  width: 18px; height: 18px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--surface);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: transparent;
}
.suite-card.selected .suite-check { background: var(--primary); border-color: var(--primary); color: white; }
.suite-icon { font-size: 22px; margin-bottom: 6px; }
.suite-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.suite-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5; }
.suite-meta { font-size: 11px; color: var(--text-muted); margin-top: 8px; }
.suite-badge {
  position: absolute; top: 10px; left: 10px;
  font-size: 11px; color: #fff; background: #10b981;
  padding: 1px 8px; border-radius: 10px;
}
.suite-card.installed { opacity: 0.55; cursor: default; }
.suite-actions { margin-top: 16px; display: flex; justify-content: flex-end; }
.footer-hint { font-size: 12px; color: var(--text-muted); margin-right: auto; }

/* ========== 全量查看弹窗 ========== */
.fv-row { cursor: pointer; }
.fv-row:hover { background: var(--hover); }
.fv-row td { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-header-actions { display: flex; align-items: center; gap: 8px; }
.modal-badge { font-size: 12px; color: var(--text-muted); background: var(--hover); padding: 2px 8px; border-radius: 10px; }
.fullview-toolbar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;
}
.search-box { position: relative; flex: 1; min-width: 160px; max-width: 260px; }
.search-box input {
  width: 100%; padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 13px; outline: none;
}
.search-box input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.1); }
.data-table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  background: var(--surface); border-spacing: 0;
}
.data-table th {
  text-align: left; padding: 10px 16px; background: var(--bg-main);
  border-bottom: 2px solid var(--border); font-weight: 600;
  color: var(--text-secondary); position: sticky; top: 0; z-index: 1;
}
.data-table td { padding: 10px 16px; border-bottom: 1px solid var(--border); }
.data-table tr:hover { background: var(--hover); }
.th-status { width: 80px; }
.td-status { text-align: center; }
.td-data { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ========== 通用弹窗 ========== */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); display: flex;
  justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
  background: var(--surface); border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg); max-width: 90%;
  max-height: 90vh; overflow-y: auto; width: 480px;
}
.modal-box-ds { width: 720px; max-width: 720px; }
.modal-box-record { width: 520px; max-width: 520px; }
.modal-box-wide { width: 1200px; max-width: 1200px; height: 90vh; display: flex; flex-direction: column; }
.modal-box-wide .modal-header { flex-shrink: 0; }
.modal-box-wide .modal-body { flex: 1; overflow-y: auto; }
.modal-header {
  padding: 14px 20px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.modal-header h3 { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.modal-body { padding: 18px 20px; }
.modal-footer {
  padding: 14px 20px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
}

/* ========== 表单 ========== */
.form-group { margin-bottom: 12px; }
.form-group label {
  display: block; font-size: 12px; font-weight: 500;
  color: var(--text-secondary); margin-bottom: 5px;
}
.label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.label-row label { margin-bottom: 0; }
.form-control-sm { padding: 5px 8px; font-size: 12px; }
textarea.form-control { resize: vertical; font-family: inherit; }
.field-editor {
  display: flex; flex-direction: column; gap: 8px;
  max-height: 300px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 10px; background: var(--surface-2);
}
.field-row-grid {
  display: grid; grid-template-columns: 1fr 1fr 130px 1fr auto auto;
  gap: 8px; align-items: center;
}
.field-required { display: flex; align-items: center; gap: 3px; font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.field-del { color: var(--danger); }
.req-mark { color: var(--danger); }
.detail-row {
  display: flex; justify-content: space-between; padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.detail-row:last-child { border-bottom: none; }
.detail-row .label { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.detail-row .value { font-size: 13px; color: var(--text-primary); }
.import-type-btns { display: flex; gap: 8px; }

.spinner {
  width: 16px; height: 16px; border: 2px solid var(--border);
  border-top-color: var(--primary); border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
