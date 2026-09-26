/**
 * 数据中心记录落库归一化（dataset-normalize）
 *
 * 在"落库层"统一处理记录：不干预 AI/前端怎么解析，只要数据进库前按数据集 schema
 * 做一次归一化 ——
 *   1. 字段同义词映射：AI 回显的消息短键（姓名/手机/留言/产品 等）映射到数据集正名字段
 *   2. 类型/状态补全：按 typeOptions/statusOptions 校验、推断或填充默认值
 *
 * 覆盖线索池/客户信息/跟进记录/项目数据/项目工单/项目日志/营销账号/账号每日数据等所有数据集。
 */
import { qOne } from './database';

/** 字段同义词 → 候选字段名（按优先级，取第一个存在于该数据集 schema 的字段） */
const FIELD_CANDIDATES: Record<string, string[]> = {
  姓名: ['联系人', '名称', '客户名称', '联系人名称'],
  联系人: ['联系人', '客户名称', '名称'],
  名字: ['联系人', '名称', '客户名称'],
  称呼: ['联系人'],
  手机: ['联系电话', '电话'],
  电话: ['联系电话', '电话'],
  联系电话: ['联系电话', '电话'],
  手机号: ['联系电话', '电话'],
  电话号码: ['联系电话', '电话'],
  微信号: ['微信号', '微信'],
  微信: ['微信号', '微信'],
  留言: ['需求', '内容', '跟进内容', '描述', '备注'],
  需求: ['需求', '内容', '描述', '备注'],
  意向: ['需求', '内容', '备注'],
  产品: ['产品', '需求', '备注'],
  意向产品: ['产品', '需求', '备注'],
  来源: ['来源', '渠道'],
  渠道: ['来源'],
  公司: ['公司', '公司名称', '客户名称', '名称'],
  公司名称: ['公司', '客户名称'],
  企业: ['公司', '公司名称', '客户名称'],
  单位: ['公司'],
  客户: ['客户', '客户名称', '公司'],
  客户名称: ['客户名称', '名称'],
  名称: ['名称', '客户名称', '线索名称', '项目名称'],
  客户编号: ['客户编号', '客户编码', '编号'],
  客户编码: ['客户编码', '客户编号'],
  编号: ['编号', '客户编号', '客户编码', '项目编码', '账号ID'],
  项目: ['项目', '项目编码', '项目名称'],
  项目名称: ['名称', '项目'],
  项目编码: ['项目编码', '项目'],
  内容: ['内容', '跟进内容', '描述', '需求', '备注'],
  描述: ['描述', '内容', '需求', '备注'],
  详细: ['详细', '内容', '描述', '备注'],
  金额: ['合同金额', '预计金额', '已付金额', '金额'],
  合同金额: ['合同金额'],
  已付金额: ['已付金额', '合同金额'],
  备注: ['备注', '补充说明'],
  地区: ['地区', '区域'],
  城市: ['地区', '区域'],
  下次跟进: ['下次跟进', '跟进时间', '下次跟进时间'],
  跟进时间: ['下次跟进', '跟进时间'],
  时间: ['时间', '日期', '开始时间', '下次跟进时间'],
  日期: ['日期', '开始时间', '结束时间', '更新日期'],
  负责人: ['负责人', '联系人', '经办人'],
  经办人: ['负责人', '联系人'],
  类型: ['类型'],
  状态: ['状态', '阶段'],
  平台: ['平台'],
  粉丝: ['粉丝'],
  阅读: ['阅读'],
  链接: ['链接'],
  主页: ['主页'],
  更新节奏: ['更新节奏'],
  更新日期: ['更新日期'],
  事务: ['事务', '内容', '描述'],
  完成情况: ['完成情况', '完成时间', '内容'],
  期限: ['完成时间', '结束时间', '预计成交日期'],
  预计成交日期: ['预计成交日期', '日期'],
  付款: ['付款情况', '已付金额', '合同金额'],
  优先级: ['优先级'],
  端: ['端'],
};

/** 各数据集的兜底默认状态（未显式给出且文本无法推断时使用） */
const STATUS_DEFAULTS: Record<string, string> = {
  线索池: '询客',
  客户信息: '正常',
  项目工单: '待处理',
  营销账号: '运营中',
  合同: '实施中',
};

function resolveField(key: string, fieldNames: string[]): string | null {
  if (fieldNames.includes(key)) return key;
  const cands = FIELD_CANDIDATES[key];
  if (cands) for (const c of cands) if (fieldNames.includes(c)) return c;
  return null;
}

function pickOption(value: string, options: string[]): string | null {
  if (options.includes(value)) return value;
  return options.find(o => o.includes(value) || value.includes(o)) || null;
}

/** 最长命中长度（含中英混排），用于从整条记录文本推断类型 */
function longestMatch(option: string, text: string): number {
  if (!option) return 0;
  if (text.includes(option)) return option.length;
  let best = 0;
  for (let i = 0; i < option.length; i++) {
    for (let j = i + 2; j <= option.length; j++) {
      if (text.includes(option.slice(i, j)) && j - i > best) best = j - i;
    }
  }
  return best;
}

/**
 * 按数据集 schema 归一化一条待落库记录：
 *  - 字段同义词映射（姓名→联系人、手机→联系电话、留言/产品→需求…）
 *  - type / status 校验、推断、填充
 * 返回归一化后的记录对象（不抛错，无 schema 时原样返回）。
 */
export function normalizeDatasetRecord(datasetId: string | number, record: any): any {
  if (!record || typeof record !== 'object') return record;
  const dsRow = qOne<{ id: number; name: string; schema_json?: string }>(
    'SELECT id, name, schema_json FROM data_center_datasets WHERE id = ? OR dataset_id = ?',
    datasetId, datasetId
  );
  if (!dsRow || !dsRow.schema_json) return record;

  let schema: any = null;
  try { schema = JSON.parse(dsRow.schema_json); } catch { return record; }
  const fields: any[] = (schema && schema.fields) || [];
  const fieldNames = fields.map((f: any) => f.name);
  const typeOptions: string[] = (schema && schema.typeOptions) || [];
  const statusOptions: string[] = (schema && schema.statusOptions) || [];

  const out: any = {};
  let heldType = '';
  let heldStatus = '';
  const mergeInto = (target: string, val: string) => {
    out[target] = out[target] != null && String(out[target]).trim() !== '' ? String(out[target]) + '\n' + val : val;
  };

  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null) continue;
    const val = typeof v === 'string' ? v.trim() : v;
    if (k === 'type') { heldType = String(val); continue; }
    if (k === 'status') {
      if (fieldNames.includes('状态')) { mergeInto('状态', String(val)); }
      else heldStatus = String(val);
      continue;
    }
    const field = fieldNames.includes(k) ? k : resolveField(k, fieldNames);
    if (field && field !== 'type' && field !== 'status') {
      mergeInto(field, String(val));
    } else {
      out[k] = val;
    }
  }

  const text = Object.values(out).map(String).join('\n');

  // type
  if (typeOptions.length) {
    if (heldType) {
      out.type = pickOption(heldType, typeOptions) || typeOptions[0];
    } else {
      let best: string | null = null;
      let bestLen = 0;
      for (const o of typeOptions) {
        const len = longestMatch(o, text);
        if (len > bestLen) { best = o; bestLen = len; }
      }
      out.type = best || typeOptions[0];
    }
  } else if (fieldNames.includes('类型')) {
    if (heldType) mergeInto('类型', heldType);
  } else {
    delete out.type;
  }

  // status
  if (statusOptions.length) {
    if (heldStatus) {
      const p = pickOption(heldStatus, statusOptions);
      if (p) out.status = p;
      else if (fieldNames.includes('状态')) mergeInto('状态', heldStatus);
    } else {
      let inf: string | null = null;
      for (const s of statusOptions) {
        if (text.includes(s)) { inf = s; break; }
      }
      const st = inf || STATUS_DEFAULTS[dsRow.name] || '';
      if (st) out.status = st;
    }
  } else if (fieldNames.includes('状态')) {
    if (heldStatus) mergeInto('状态', heldStatus);
  } else {
    delete out.status;
  }

  return out;
}
