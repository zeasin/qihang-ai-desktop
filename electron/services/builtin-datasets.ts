import { run, qOne } from './database';

// ========== 内置数据集套件定义 ==========
// 用户初始化时可选择安装一套或多套（见 DataView 初始化向导）。

export interface BuiltinField {
  name: string;
  displayName?: string;
  type?: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'datetime' | 'select';
  required?: boolean;
  options?: string[];
}

export interface BuiltinDatasetDef {
  datasetId: string;
  name: string;
  description: string;
  schema: {
    fields: BuiltinField[];
    typeOptions?: string[];
    statusOptions?: string[];
  };
  records: Record<string, string>[];
}

export interface BuiltinModuleDef {
  moduleId: string;
  name: string;
  icon: string;
  description: string;
  datasets: BuiltinDatasetDef[];
}

export interface BuiltinSuiteDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  modules: BuiltinModuleDef[];
}

export const BUILTIN_SUITES: BuiltinSuiteDef[] = [
  {
    id: 'crm',
    name: 'CRM 客户管理',
    icon: '🤝',
    description: '客户信息、商机线索、跟进记录，销售全流程管理',
    modules: [
      {
        moduleId: 'builtin_crm',
        name: 'CRM 客户管理',
        icon: '🤝',
        description: '客户、线索与跟进的一体化管理',
        datasets: [
          {
            datasetId: 'builtin_crm_customers',
            name: '客户信息',
            description: '客户基本信息与分级',
            schema: {
              fields: [
                { name: '客户名称', type: 'text', required: true },
                { name: '联系人', type: 'text' },
                { name: '电话', type: 'text' },
                { name: '邮箱', type: 'text' },
                { name: '地址', type: 'textarea' },
                { name: '行业', type: 'select', options: ['互联网', '贸易', '教育', '制造', '金融'] },
                { name: '来源', type: 'select', options: ['官网咨询', '老客户转介绍', '展会', '广告投放', '电话营销'] },
                { name: '客户等级', type: 'select', options: ['A', 'B', 'C', 'D'] },
              ],
              typeOptions: ['企业', '个人'],
              statusOptions: ['潜在客户', '跟进中', '已成交', '已流失'],
            },
            records: [
              { status: '跟进中', type: '企业', 客户名称: '云帆科技有限公司', 联系人: '张伟', 电话: '13800000001', 邮箱: 'zhangwei@yunfan.com', 地址: '上海市浦东新区', 行业: '互联网', 来源: '官网咨询', 客户等级: 'A' },
              { status: '已成交', type: '企业', 客户名称: '蓝海贸易有限公司', 联系人: '李娜', 电话: '13800000002', 邮箱: 'lina@lanhai.com', 地址: '北京市朝阳区', 行业: '贸易', 来源: '老客户转介绍', 客户等级: 'A' },
              { status: '潜在客户', type: '个人', 客户名称: '王强', 联系人: '王强', 电话: '13800000003', 邮箱: 'wangqiang@qq.com', 地址: '广州市天河区', 行业: '教育', 来源: '展会', 客户等级: 'C' },
            ],
          },
          {
            datasetId: 'builtin_crm_leads',
            name: '商机线索',
            description: '销售机会与推进阶段',
            schema: {
              fields: [
                { name: '线索名称', type: 'text', required: true },
                { name: '关联客户', type: 'text' },
                { name: '预计金额', type: 'money' },
                { name: '负责人', type: 'text' },
                { name: '预计成交日期', type: 'date' },
                { name: '备注', type: 'textarea' },
              ],
              statusOptions: ['新线索', '洽谈中', '已成交', '已流失'],
            },
            records: [
              { status: '洽谈中', 线索名称: '云帆科技年度采购', 关联客户: '云帆科技有限公司', 预计金额: '500000', 负责人: '赵敏', 预计成交日期: '2026-09-30', 备注: '客户意向较强，重点关注' },
              { status: '新线索', 线索名称: '蓝海贸易仓储系统', 关联客户: '蓝海贸易有限公司', 预计金额: '200000', 负责人: '钱进', 预计成交日期: '2026-10-31', 备注: '' },
            ],
          },
          {
            datasetId: 'builtin_crm_followups',
            name: '跟进记录',
            description: '客户拜访与沟通记录',
            schema: {
              fields: [
                { name: '关联客户', type: 'text', required: true },
                { name: '跟进方式', type: 'select', options: ['电话', '拜访', '微信', '邮件', '线上会议'] },
                { name: '跟进内容', type: 'textarea' },
                { name: '负责人', type: 'text' },
                { name: '下次跟进时间', type: 'date' },
              ],
              statusOptions: ['待跟进', '已跟进'],
            },
            records: [
              { status: '已跟进', 关联客户: '云帆科技有限公司', 跟进方式: '电话', 跟进内容: '确认采购需求，约下周面谈', 负责人: '赵敏', 下次跟进时间: '2026-08-05' },
              { status: '待跟进', 关联客户: '蓝海贸易有限公司', 跟进方式: '拜访', 跟进内容: '演示产品，客户反馈良好', 负责人: '赵敏', 下次跟进时间: '2026-08-08' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'erp',
    name: '进销存管理',
    icon: '📦',
    description: '商品、供应商、采购入库、销售出库全流程',
    modules: [
      {
        moduleId: 'builtin_erp',
        name: '进销存管理',
        icon: '📦',
        description: '商品与库存流转管理',
        datasets: [
          {
            datasetId: 'builtin_erp_products',
            name: '商品信息',
            description: '商品档案与库存预警',
            schema: {
              fields: [
                { name: '商品名称', type: 'text', required: true },
                { name: '商品编码', type: 'text' },
                { name: '分类', type: 'text' },
                { name: '单位', type: 'select', options: ['个', '件', '张', '台', '箱'] },
                { name: '成本价', type: 'money' },
                { name: '销售价', type: 'money' },
                { name: '当前库存', type: 'number' },
                { name: '库存预警值', type: 'number' },
              ],
              typeOptions: ['原材料', '成品', '耗材'],
              statusOptions: ['在售', '停售'],
            },
            records: [
              { status: '在售', type: '成品', 商品名称: '智能水杯', 商品编码: 'P1001', 分类: '家居用品', 单位: '个', 成本价: '45', 销售价: '99', 当前库存: '320', 库存预警值: '50' },
              { status: '在售', type: '成品', 商品名称: '无线键盘', 商品编码: 'P1002', 分类: '数码配件', 单位: '个', 成本价: '80', 销售价: '199', 当前库存: '25', 库存预警值: '30' },
              { status: '在售', type: '原材料', 商品名称: '304不锈钢板', 商品编码: 'R2001', 分类: '金属材料', 单位: '张', 成本价: '120', 销售价: '160', 当前库存: '40', 库存预警值: '10' },
            ],
          },
          {
            datasetId: 'builtin_erp_suppliers',
            name: '供应商',
            description: '供应商档案与结算信息',
            schema: {
              fields: [
                { name: '供应商名称', type: 'text', required: true },
                { name: '联系人', type: 'text' },
                { name: '电话', type: 'text' },
                { name: '地址', type: 'textarea' },
                { name: '主营商品', type: 'text' },
                { name: '账期天数', type: 'number' },
              ],
              statusOptions: ['合作中', '已停用'],
            },
            records: [
              { status: '合作中', 供应商名称: '恒通五金有限公司', 联系人: '刘洋', 电话: '13900000001', 地址: '东莞市长安镇', 主营商品: '不锈钢板', 账期天数: '30' },
              { status: '合作中', 供应商名称: '科达塑胶厂', 联系人: '陈静', 电话: '13900000002', 地址: '佛山市顺德区', 主营商品: '塑胶外壳', 账期天数: '15' },
            ],
          },
          {
            datasetId: 'builtin_erp_purchases',
            name: '采购入库',
            description: '采购单与入库记录',
            schema: {
              fields: [
                { name: '采购单号', type: 'text', required: true },
                { name: '供应商', type: 'text' },
                { name: '商品', type: 'text' },
                { name: '数量', type: 'number' },
                { name: '单价', type: 'money' },
                { name: '总金额', type: 'money' },
                { name: '入库日期', type: 'date' },
                { name: '经办人', type: 'text' },
              ],
              statusOptions: ['已入库'],
            },
            records: [
              { status: '已入库', 采购单号: 'CG2026072801', 供应商: '恒通五金有限公司', 商品: '304不锈钢板', 数量: '30', 单价: '120', 总金额: '3600', 入库日期: '2026-07-28', 经办人: '孙悦' },
              { status: '已入库', 采购单号: 'CG2026073001', 供应商: '科达塑胶厂', 商品: '无线键盘外壳', 数量: '200', 单价: '18', 总金额: '3600', 入库日期: '2026-07-30', 经办人: '孙悦' },
            ],
          },
          {
            datasetId: 'builtin_erp_sales',
            name: '销售出库',
            description: '销售单与出库记录',
            schema: {
              fields: [
                { name: '销售单号', type: 'text', required: true },
                { name: '客户', type: 'text' },
                { name: '商品', type: 'text' },
                { name: '数量', type: 'number' },
                { name: '单价', type: 'money' },
                { name: '总金额', type: 'money' },
                { name: '出库日期', type: 'date' },
                { name: '经办人', type: 'text' },
              ],
              statusOptions: ['已出库'],
            },
            records: [
              { status: '已出库', 销售单号: 'XS2026072901', 客户: '云帆科技有限公司', 商品: '智能水杯', 数量: '100', 单价: '99', 总金额: '9900', 出库日期: '2026-07-29', 经办人: '周磊' },
              { status: '已出库', 销售单号: 'XS2026073101', 客户: '蓝海贸易有限公司', 商品: '无线键盘', 数量: '50', 单价: '199', 总金额: '9950', 出库日期: '2026-07-31', 经办人: '周磊' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'ticket',
    name: '工单管理',
    icon: '🛠️',
    description: '工单受理、指派、处理与回访闭环',
    modules: [
      {
        moduleId: 'builtin_ticket',
        name: '工单管理',
        icon: '🛠️',
        description: '客户服务工单全流程管理',
        datasets: [
          {
            datasetId: 'builtin_ticket_tickets',
            name: '工单',
            description: '工单受理与处理记录',
            schema: {
              fields: [
                { name: '工单编号', type: 'text', required: true },
                { name: '标题', type: 'text' },
                { name: '客户', type: 'text' },
                { name: '负责人', type: 'text' },
                { name: '优先级', type: 'select', options: ['高', '中', '低'] },
                { name: '创建日期', type: 'date' },
                { name: '完成日期', type: 'date' },
                { name: '问题描述', type: 'textarea' },
              ],
              typeOptions: ['故障报修', '咨询', '投诉', '需求'],
              statusOptions: ['待受理', '处理中', '已完成', '已关闭'],
            },
            records: [
              { status: '处理中', type: '故障报修', 工单编号: 'GD20260801001', 标题: '打印机无法连接', 客户: '云帆科技有限公司', 负责人: '吴工', 优先级: '高', 创建日期: '2026-08-01', 完成日期: '', 问题描述: '公司打印机无法通过局域网连接' },
              { status: '已完成', type: '咨询', 工单编号: 'GD20260731001', 标题: '软件使用咨询', 客户: '蓝海贸易有限公司', 负责人: '郑工', 优先级: '低', 创建日期: '2026-07-31', 完成日期: '2026-07-31', 问题描述: '咨询报表导出功能用法' },
            ],
          },
          {
            datasetId: 'builtin_ticket_customers',
            name: '服务客户',
            description: '签约服务客户档案',
            schema: {
              fields: [
                { name: '客户名称', type: 'text', required: true },
                { name: '联系人', type: 'text' },
                { name: '电话', type: 'text' },
                { name: '服务类型', type: 'select', options: ['远程支持+季度巡检', '全年驻场', '季度巡检'] },
                { name: '合同编号', type: 'text' },
                { name: '到期日期', type: 'date' },
              ],
              typeOptions: ['驻场服务', '远程服务', '巡检服务'],
              statusOptions: ['服务中', '已到期'],
            },
            records: [
              { status: '服务中', type: '远程服务', 客户名称: '云帆科技有限公司', 联系人: '张伟', 电话: '13800000001', 服务类型: '远程支持+季度巡检', 合同编号: 'HT-2026-001', 到期日期: '2027-06-30' },
              { status: '服务中', type: '驻场服务', 客户名称: '蓝海贸易有限公司', 联系人: '李娜', 电话: '13800000002', 服务类型: '全年驻场', 合同编号: 'HT-2026-002', 到期日期: '2027-01-31' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'project',
    name: '项目管理',
    icon: '📋',
    description: '项目、任务、里程碑三层管理',
    modules: [
      {
        moduleId: 'builtin_project',
        name: '项目管理',
        icon: '📋',
        description: '项目进度与交付管理',
        datasets: [
          {
            datasetId: 'builtin_project_projects',
            name: '项目',
            description: '项目主档案',
            schema: {
              fields: [
                { name: '项目名称', type: 'text', required: true },
                { name: '项目编号', type: 'text' },
                { name: '负责人', type: 'text' },
                { name: '开始日期', type: 'date' },
                { name: '截止日期', type: 'date' },
                { name: '预算', type: 'money' },
                { name: '客户', type: 'text' },
              ],
              statusOptions: ['立项', '进行中', '已结项', '已暂停'],
            },
            records: [
              { status: '进行中', 项目名称: '智慧园区平台二期', 项目编号: 'XM-2026-015', 负责人: '钱进', 开始日期: '2026-06-01', 截止日期: '2026-11-30', 预算: '800000', 客户: '云帆科技有限公司' },
              { status: '已结项', 项目名称: '仓储管理系统', 项目编号: 'XM-2026-008', 负责人: '钱进', 开始日期: '2026-03-01', 截止日期: '2026-07-15', 预算: '200000', 客户: '蓝海贸易有限公司' },
            ],
          },
          {
            datasetId: 'builtin_project_tasks',
            name: '项目任务',
            description: '项目任务分解与执行',
            schema: {
              fields: [
                { name: '任务名称', type: 'text', required: true },
                { name: '所属项目', type: 'text' },
                { name: '负责人', type: 'text' },
                { name: '优先级', type: 'select', options: ['高', '中', '低'] },
                { name: '截止日期', type: 'date' },
                { name: '进度', type: 'text' },
              ],
              statusOptions: ['待办', '进行中', '已完成'],
            },
            records: [
              { status: '进行中', 任务名称: '需求评审', 所属项目: '智慧园区平台二期', 负责人: '钱进', 优先级: '高', 截止日期: '2026-08-10', 进度: '60%' },
              { status: '已完成', 任务名称: '部署上线', 所属项目: '仓储管理系统', 负责人: '孙悦', 优先级: '高', 截止日期: '2026-07-15', 进度: '100%' },
            ],
          },
          {
            datasetId: 'builtin_project_milestones',
            name: '里程碑',
            description: '项目关键节点',
            schema: {
              fields: [
                { name: '里程碑名称', type: 'text', required: true },
                { name: '所属项目', type: 'text' },
                { name: '计划日期', type: 'date' },
                { name: '实际日期', type: 'date' },
                { name: '说明', type: 'textarea' },
              ],
              statusOptions: ['未达成', '已达成'],
            },
            records: [
              { status: '已达成', 里程碑名称: '一期上线', 所属项目: '智慧园区平台二期', 计划日期: '2026-07-01', 实际日期: '2026-07-05', 说明: '一期功能提前上线' },
              { status: '未达成', 里程碑名称: '二期验收', 所属项目: '智慧园区平台二期', 计划日期: '2026-11-30', 实际日期: '', 说明: '' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'hr',
    name: '招聘管理',
    icon: '👥',
    description: '职位需求、候选人、面试安排管理',
    modules: [
      {
        moduleId: 'builtin_hr',
        name: '招聘管理',
        icon: '👥',
        description: '招聘流程数字化管理',
        datasets: [
          {
            datasetId: 'builtin_hr_jobs',
            name: '职位需求',
            description: '招聘职位与编制',
            schema: {
              fields: [
                { name: '职位名称', type: 'text', required: true },
                { name: '部门', type: 'text' },
                { name: '招聘人数', type: 'number' },
                { name: '薪资范围', type: 'text' },
                { name: '负责人', type: 'text' },
                { name: '发布日期', type: 'date' },
                { name: '招聘渠道', type: 'select', options: ['BOSS直聘', '猎聘', '智联招聘', '内推', '校园招聘'] },
              ],
              statusOptions: ['招聘中', '已招满', '已暂停'],
            },
            records: [
              { status: '招聘中', 职位名称: '前端开发工程师', 部门: '研发部', 招聘人数: '2', 薪资范围: '15-25K', 负责人: '王芳', 发布日期: '2026-07-01', 招聘渠道: 'BOSS直聘' },
              { status: '招聘中', 职位名称: '销售经理', 部门: '销售部', 招聘人数: '1', 薪资范围: '10-20K', 负责人: '赵敏', 发布日期: '2026-07-20', 招聘渠道: '猎聘' },
            ],
          },
          {
            datasetId: 'builtin_hr_candidates',
            name: '候选人',
            description: '候选人档案',
            schema: {
              fields: [
                { name: '姓名', type: 'text', required: true },
                { name: '应聘职位', type: 'text' },
                { name: '电话', type: 'text' },
                { name: '学历', type: 'select', options: ['大专', '本科', '硕士', '博士'] },
                { name: '工作经验', type: 'text' },
                { name: '来源', type: 'select', options: ['BOSS直聘', '猎聘', '智联招聘', '内推', '校园招聘'] },
              ],
              statusOptions: ['待筛选', '已初筛', '已面试', '已录用', '已淘汰'],
            },
            records: [
              { status: '已面试', 姓名: '李明', 应聘职位: '前端开发工程师', 电话: '13700000001', 学历: '本科', 工作经验: '5年', 来源: 'BOSS直聘' },
              { status: '待筛选', 姓名: '周芳', 应聘职位: '销售经理', 电话: '13700000002', 学历: '大专', 工作经验: '8年', 来源: '猎聘' },
            ],
          },
          {
            datasetId: 'builtin_hr_interviews',
            name: '面试安排',
            description: '面试计划与结果',
            schema: {
              fields: [
                { name: '候选人', type: 'text', required: true },
                { name: '面试职位', type: 'text' },
                { name: '面试官', type: 'text' },
                { name: '面试时间', type: 'datetime' },
                { name: '面试方式', type: 'select', options: ['现场面试', '视频面试', '电话面试'] },
                { name: '评价', type: 'textarea' },
              ],
              typeOptions: ['现场面试', '视频面试', '电话面试'],
              statusOptions: ['待面试', '已通过', '未通过'],
            },
            records: [
              { status: '已通过', 候选人: '李明', 面试职位: '前端开发工程师', 面试官: '钱进', 面试时间: '2026-08-02 10:00', 面试方式: '现场面试', 评价: '技术基础扎实，通过' },
              { status: '待面试', 候选人: '周芳', 面试职位: '销售经理', 面试官: '赵敏', 面试时间: '2026-08-05 14:00', 面试方式: '视频面试', 评价: '' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'contract',
    name: '合同管理',
    icon: '📄',
    description: '合同档案、应收款项与到期提醒',
    modules: [
      {
        moduleId: 'builtin_contract',
        name: '合同管理',
        icon: '📄',
        description: '合同全生命周期管理',
        datasets: [
          {
            datasetId: 'builtin_contract_contracts',
            name: '合同',
            description: '合同主档案',
            schema: {
              fields: [
                { name: '合同编号', type: 'text', required: true },
                { name: '合同名称', type: 'text' },
                { name: '甲方', type: 'text' },
                { name: '乙方', type: 'text' },
                { name: '金额', type: 'money' },
                { name: '签订日期', type: 'date' },
                { name: '到期日期', type: 'date' },
                { name: '负责人', type: 'text' },
              ],
              typeOptions: ['采购合同', '销售合同', '服务合同', '劳动合同'],
              statusOptions: ['履行中', '已到期', '已终止', '已完成'],
            },
            records: [
              { status: '履行中', type: '服务合同', 合同编号: 'HT-2026-001', 合同名称: '年度技术支持服务合同', 甲方: '云帆科技有限公司', 乙方: '启航软件', 金额: '120000', 签订日期: '2026-07-01', 到期日期: '2027-06-30', 负责人: '郑工' },
              { status: '已到期', type: '采购合同', 合同编号: 'HT-2025-088', 合同名称: '服务器采购合同', 甲方: '启航软件', 乙方: '恒通五金有限公司', 金额: '56000', 签订日期: '2025-06-15', 到期日期: '2026-06-15', 负责人: '孙悦' },
            ],
          },
          {
            datasetId: 'builtin_contract_payments',
            name: '收款记录',
            description: '合同回款明细',
            schema: {
              fields: [
                { name: '关联合同', type: 'text', required: true },
                { name: '收款日期', type: 'date' },
                { name: '金额', type: 'money' },
                { name: '收款方式', type: 'select', options: ['银行转账', '支付宝', '微信', '现金', '支票'] },
                { name: '经办人', type: 'text' },
              ],
              statusOptions: ['已到账'],
            },
            records: [
              { status: '已到账', 关联合同: 'HT-2026-001', 收款日期: '2026-07-10', 金额: '60000', 收款方式: '银行转账', 经办人: '赵敏' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'asset',
    name: '设备资产管理',
    icon: '🖥️',
    description: '资产台账、领用与维修记录',
    modules: [
      {
        moduleId: 'builtin_asset',
        name: '设备资产管理',
        icon: '🖥️',
        description: '固定资产全流程管理',
        datasets: [
          {
            datasetId: 'builtin_asset_assets',
            name: '资产台账',
            description: '资产卡片',
            schema: {
              fields: [
                { name: '资产编号', type: 'text', required: true },
                { name: '资产名称', type: 'text' },
                { name: '类别', type: 'select', options: ['电脑', '打印机', '服务器', '办公家具', '其他'] },
                { name: '型号', type: 'text' },
                { name: '负责人', type: 'text' },
                { name: '购置日期', type: 'date' },
                { name: '金额', type: 'money' },
                { name: '存放位置', type: 'text' },
              ],
              typeOptions: ['电脑', '打印机', '服务器', '办公家具', '其他'],
              statusOptions: ['在用', '闲置', '维修中', '已报废'],
            },
            records: [
              { status: '在用', type: '电脑', 资产编号: 'ZC-2026-001', 资产名称: '办公笔记本', 类别: '电脑', 型号: 'ThinkPad X1', 负责人: '钱进', 购置日期: '2026-03-01', 金额: '9800', 存放位置: '3F 研发区' },
              { status: '维修中', type: '打印机', 资产编号: 'ZC-2025-012', 资产名称: '激光打印机', 类别: '打印机', 型号: 'HP M405', 负责人: '行政部', 购置日期: '2025-05-20', 金额: '2600', 存放位置: '2F 打印区' },
            ],
          },
          {
            datasetId: 'builtin_asset_repairs',
            name: '维修记录',
            description: '资产维修历史',
            schema: {
              fields: [
                { name: '资产名称', type: 'text', required: true },
                { name: '报修日期', type: 'date' },
                { name: '故障描述', type: 'textarea' },
                { name: '维修费用', type: 'money' },
                { name: '维修商', type: 'text' },
                { name: '完成日期', type: 'date' },
              ],
              statusOptions: ['维修中', '已修复'],
            },
            records: [
              { status: '已修复', 资产名称: '办公笔记本', 报修日期: '2026-06-20', 故障描述: '屏幕闪屏', 维修费用: '450', 维修商: '联想官方售后', 完成日期: '2026-06-25' },
              { status: '维修中', 资产名称: '激光打印机', 报修日期: '2026-07-30', 故障描述: '卡纸频繁', 维修费用: '', 维修商: '惠普服务商', 完成日期: '' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'finance',
    name: '财务收支',
    icon: '💰',
    description: '收入支出流水记录与分类统计',
    modules: [
      {
        moduleId: 'builtin_finance',
        name: '财务收支',
        icon: '💰',
        description: '企业收支流水管理',
        datasets: [
          {
            datasetId: 'builtin_finance_income',
            name: '收入记录',
            description: '营业收入明细',
            schema: {
              fields: [
                { name: '日期', type: 'date' },
                { name: '来源', type: 'text' },
                { name: '金额', type: 'money' },
                { name: '收款方式', type: 'select', options: ['银行转账', '支付宝', '微信', '现金', '支票'] },
                { name: '经办人', type: 'text' },
                { name: '备注', type: 'textarea' },
              ],
              typeOptions: ['销售回款', '服务费', '其他收入'],
              statusOptions: ['已到账'],
            },
            records: [
              { status: '已到账', type: '销售回款', 日期: '2026-07-29', 来源: '云帆科技有限公司-智能水杯货款', 金额: '9900', 收款方式: '银行转账', 经办人: '周磊', 备注: '销售单 XS2026072901' },
              { status: '已到账', type: '服务费', 日期: '2026-07-10', 来源: '年度技术支持服务费（首期）', 金额: '60000', 收款方式: '银行转账', 经办人: '赵敏', 备注: '合同 HT-2026-001' },
            ],
          },
          {
            datasetId: 'builtin_finance_expense',
            name: '支出记录',
            description: '费用支出明细',
            schema: {
              fields: [
                { name: '日期', type: 'date' },
                { name: '用途', type: 'text' },
                { name: '金额', type: 'money' },
                { name: '付款方式', type: 'select', options: ['对公转账', '支付宝', '微信', '现金', '其他'] },
                { name: '经办人', type: 'text' },
                { name: '备注', type: 'textarea' },
              ],
              typeOptions: ['采购', '办公', '差旅', '人力', '其他'],
              statusOptions: ['已支付'],
            },
            records: [
              { status: '已支付', type: '采购', 日期: '2026-07-28', 用途: '304不锈钢板采购', 金额: '3600', 付款方式: '对公转账', 经办人: '孙悦', 备注: '采购单 CG2026072801' },
              { status: '已支付', type: '办公', 日期: '2026-07-15', 用途: '办公用品采购', 金额: '860', 付款方式: '支付宝', 经办人: '行政部', 备注: '' },
            ],
          },
        ],
      },
    ],
  },
];

// ========== 对外 API ==========

/** 返回套件元信息（不含示例数据），供初始化向导展示 */
export function listBuiltinSuites() {
  return BUILTIN_SUITES.map(s => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    description: s.description,
    moduleCount: s.modules.length,
    datasetCount: s.modules.reduce((n, m) => n + m.datasets.length, 0),
    sampleCount: s.modules.reduce((n, m) => n + m.datasets.reduce((x, d) => x + d.records.length, 0), 0),
    modules: s.modules.map(m => ({
      moduleId: m.moduleId,
      name: m.name,
      icon: m.icon,
      description: m.description,
      datasets: m.datasets.map(d => ({
        name: d.name,
        description: d.description,
        fields: d.schema.fields.map(f => f.name),
        typeOptions: d.schema.typeOptions || [],
        statusOptions: d.schema.statusOptions || [],
      })),
    })),
  }));
}

/** 升级旧版内置数据集：为已安装的内置数据集补齐字段类型/必填/选项（保留用户自定义字段与修改） */
export function upgradeBuiltinSchemas(): number {
  let upgraded = 0;
  for (const suite of BUILTIN_SUITES) {
    for (const mod of suite.modules) {
      for (const ds of mod.datasets) {
        const row = qOne<{ schema_json?: string }>('SELECT schema_json FROM data_center_datasets WHERE dataset_id = ?', ds.datasetId);
        if (!row || !row.schema_json) continue;
        let schema: any;
        try { schema = JSON.parse(row.schema_json); } catch { continue; }
        if (!schema || !Array.isArray(schema.fields)) continue;
        const defMap = new Map<string, BuiltinField>();
        ds.schema.fields.forEach(f => defMap.set(f.name, f));
        let changed = false;
        const fields = schema.fields.map((f: any) => {
          if (!f || !f.name) return f;
          const def = defMap.get(f.name);
          if (!def) return f;
          const out = { ...f };
          if (!out.type && def.type) { out.type = def.type; changed = true; }
          if (out.required === undefined && def.required !== undefined) { out.required = def.required; changed = true; }
          if (!Array.isArray(out.options) && Array.isArray(def.options) && def.options.length) { out.options = def.options; changed = true; }
          return out;
        });
        if (changed) {
          run(
            "UPDATE data_center_datasets SET schema_json = ?, updated_at = datetime('now', '+8 hours') WHERE dataset_id = ?",
            JSON.stringify({ ...schema, fields }), ds.datasetId
          );
          upgraded++;
        }
      }
    }
  }
  return upgraded;
}

export function applyBuiltinSuites(ids: string[]): { applied: string[]; skipped: string[]; failed: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const suite = BUILTIN_SUITES.find(s => s.id === id);
    if (!suite) { failed.push(id); continue; }
    for (const mod of suite.modules) {
      const existing = qOne('SELECT id FROM data_center_modules WHERE module_id = ?', mod.moduleId);
      if (existing) { skipped.push(`${suite.name}/${mod.name}`); continue; }
      run(
        'INSERT INTO data_center_modules (module_id, name, description, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
        mod.moduleId, mod.name, mod.description, mod.icon, 0
      );
      for (const ds of mod.datasets) {
        run(
          'INSERT INTO data_center_datasets (dataset_id, name, description, type, status, schema_json, module_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ds.datasetId, ds.name, ds.description, '内置', '', JSON.stringify(ds.schema), mod.moduleId
        );
        const dsRow = qOne<{ id: number }>('SELECT id FROM data_center_datasets WHERE module_id = ? AND dataset_id = ? ORDER BY id DESC LIMIT 1', mod.moduleId, ds.datasetId);
        const datasetPk = dsRow ? dsRow.id : null;
        for (const rec of ds.records) {
          run('INSERT INTO data_center_records (dataset_id, data_json) VALUES (?, ?)', datasetPk, JSON.stringify(rec));
        }
      }
      applied.push(`${suite.name}/${mod.name}`);
    }
  }
  return { applied, skipped, failed };
}
