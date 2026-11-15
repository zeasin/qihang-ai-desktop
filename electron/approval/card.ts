import type { ApprovalRequest, Decision, AgentKind } from './types';
import type { TaskReport } from './task-notify';

export const DECISION_LABEL: Record<Decision, string> = {
  allow_once: '允许一次',
  allow_session: '本会话放行',
  deny: '拒绝',
};

const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude',
  dsh: 'DSH',
  pi: 'Pi',
  opencode: 'OpenCode',
};

function dirName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function fence(detail: string): string {
  if (!detail) return '';
  return `\n**内容**：\n\`\`\`\n${detail.replace(/```/g, '〰〰〰')}\n\`\`\``;
}

/**
 * 审批按钮文案。
 * opencode 的语义与 claude/dsh 不同：opencode 只有 once / always / reject 三种回复，
 * 其中 always 会**持久保存成项目级放行规则**（不是「本会话」），所以这里单独用词，
 * 避免用户以为只是临时放行，结果后面同类命令全被免检。
 */
const APPROVAL_BUTTONS: Record<AgentKind, { label: string; decision: Decision }[]> = {
  claude: [
    { label: '允许一次', decision: 'allow_once' },
    { label: '本会话放行', decision: 'allow_session' },
    { label: '拒绝', decision: 'deny' },
  ],
  dsh: [
    { label: '允许一次', decision: 'allow_once' },
    { label: '本会话放行', decision: 'allow_session' },
    { label: '拒绝', decision: 'deny' },
  ],
  pi: [
    { label: '允许一次', decision: 'allow_once' },
    { label: '本会话放行', decision: 'allow_session' },
    { label: '拒绝', decision: 'deny' },
  ],
  opencode: [
    { label: '允许一次', decision: 'allow_once' },
    { label: '允许并记住（项目级）', decision: 'allow_session' },
    { label: '拒绝', decision: 'deny' },
  ],
};

/** 审批卡：三按钮（允许一次 / 本会话放行 / 拒绝），点击经 card.action.trigger 回传 value */
export function buildApprovalCard(req: ApprovalRequest): string {
  const agentLabel = AGENT_LABEL[req.agent] || req.agent;
  const buttons = APPROVAL_BUTTONS[req.agent] || APPROVAL_BUTTONS.claude;
  const note =
    req.agent === 'opencode'
      ? '决策会回灌到你正在用的 opencode 窗口；「允许并记住」会在该项目里保存放行规则（以后同类命令不再询问）'
      : '审批在终端原会话内执行；60 分钟无人处理将自动过期';
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `[${agentLabel} 审批] ${dirName(req.cwd)}` },
    },
    elements: [
      {
        tag: 'markdown',
        content: `**工具**：${req.tool}\n**摘要**：${req.inputSummary || '-'}${fence(req.detail)}`,
      },
      {
        tag: 'action',
        actions: buttons.map((b) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: b.label },
          type: b.decision === 'deny' ? 'danger' : 'primary',
          value: { act: 'approval', approvalId: req.id, decision: b.decision },
        })),
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: note }] },
    ],
  });
}

/** 已决卡：决策后原位替换（im.message.patch） */
export function buildDecidedCard(req: ApprovalRequest): string {
  const agentLabel = AGENT_LABEL[req.agent] || req.agent;
  const approved = req.decision === 'allow_once' || req.decision === 'allow_session';
  // 终端先答复 → 卡片作废（不是拒绝）
  const voided = req.decidedBy === 'terminal-answered';
  const label = voided ? '终端已处理' : req.decision ? DECISION_LABEL[req.decision] : '已处理';
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: approved ? 'green' : 'grey',
      title: { tag: 'plain_text', content: `[${agentLabel} 审批] ${dirName(req.cwd)} · ${label}` },
    },
    elements: [
      {
        tag: 'markdown',
        content: `**工具**：${req.tool}\n**摘要**：${req.inputSummary || '-'}\n**结果**：${label}（${req.decidedBy || '-'} · ${req.decidedAt || '-'}）`,
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `审批 ${req.id.slice(0, 8)} · 已处理` }] },
    ],
  });
}

/** 「接着问」的目标：托管会话直接 prompt；外部会话按 agent 原生 id resume */
export interface TaskFollowupRef {
  agent: AgentKind;
  cwd: string;
  /** managed=本进程会话 id；resume=agent 侧原生会话 id */
  sessionId?: string;
  resume: boolean;
}

/**
 * 任务完成/失败交互卡片：markdown 摘要 + 输入框 + 「接着问」提交按钮。
 * form 必须在卡片根节点（JSON 1.0 限制），输入内容经 card.action.trigger 的 action.form_value 回传。
 */
export function buildTaskCard(text: string, r: TaskReport, ref: TaskFollowupRef): string {
  const agentLabel = AGENT_LABEL[r.agent] || r.agent;
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: r.ok ? 'green' : 'red',
      title: { tag: 'plain_text', content: `[${agentLabel}] ${r.ok ? '任务完成' : '任务失败'} · ${dirName(r.cwd)}` },
    },
    elements: [
      { tag: 'markdown', content: text },
      // 外部会话专属「继续」预设按钮：免输入，终端会话还在快速通道窗口内就原会话直接执行
      ...(ref.resume ? [{
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '▶️ 继续' },
          type: 'primary',
          value: {
            act: 'task_followup_quick',
            text: '继续',
            agent: r.agent,
            cwd: r.cwd,
            sessionId: ref.sessionId || '',
            resume: ref.resume ? '1' : '0',
          },
        }],
      }] : []),
      {
        tag: 'form',
        name: 'followup_form',
        elements: [
          {
            tag: 'input',
            name: 'followup',
            placeholder: { tag: 'plain_text', content: '输入要追问的内容…' },
            // 飞书输入框 max_length 上限 1000，超了整张卡片 400 拒收
            max_length: 1000,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '💬 接着问' },
            type: 'primary',
            name: 'followup_submit',
            // JSON 1.0 的提交按钮属性是 action_type（2.0 才是 form_action_type）
            action_type: 'form_submit',
            value: {
              act: 'task_followup',
              agent: r.agent,
              cwd: r.cwd,
              sessionId: ref.sessionId || '',
              resume: ref.resume ? '1' : '0',
            },
          },
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '「▶️ 继续」原会话直接执行；输入后点「接着问」：终端在等待窗口内原会话执行，否则由工作台接管续跑，完成后回新卡片' }] },
    ],
  });
}
