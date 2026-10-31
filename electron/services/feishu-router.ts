/**
 * 飞书 → 项目 路由。
 *
 * 背景：工作台支持多个「项目」（每个项目 = 一个本地目录 + 一套笔记/数据集），
 * 而飞书只是消息入口，本身没有「选项目」的控件。原先的规则是
 * 「解析不到就静默落到默认项目」，这在多项目下会造成跨项目数据错位。
 *
 * 本模块把「这条飞书消息该落到哪个项目」收敛成唯一入口，首条消息与追问续跑共用：
 *
 * 解析优先级（先命中先用）：
 *   1. 显式指令   /项目 名称、/项目 3、/p 名称、#项目 名称
 *   2. 行内标记   [笔记库：X]、项目：X
 *   3. 开头项目名 「金箔雲项目 帮我看下库存」（强信号）
 *   4. 会话绑定   某个飞书会话（群/私聊）此前选过项目 → 作为默认上下文带出
 *   5. 只有一个项目 → 无歧义，直接落它
 *   6. 其余情况   → needChoice：绝不静默落默认项目，交给调用方询问用户
 *
 * 数字 id 只能通过显式指令「/项目 3」指定：裸数字开头（「3 个商品要补货」）
 * 歧义太大，误判一次就会把数据写进错项目，宁可问一句。
 *
 * 绑定语义：只有「显式指令」和「卡片选择」会写入会话绑定，它代表本会话的默认上下文；
 * 行内标记只影响当前这一条消息，不改变绑定。
 * 注意：绑定 ≠ 自动执行 —— 上层仍会先弹一次项目选择卡片让用户确认（见 needsProjectChoice）。
 */
import logger from './logger';

export interface FeishuTarget {
  /** 目标项目 id；needChoice 时为 null */
  projectId: number | null;
  /** 目标项目行；needChoice 时为 null */
  project: any | null;
  /** 去掉路由指令/标记后的正文 */
  cleanText: string;
  /** 是否来自用户显式指定 */
  explicit: boolean;
  /** 是否来自会话绑定（而非本条消息的显式指定） */
  viaBinding: boolean;
  /** 多项目且无法判定 → 必须先问用户 */
  needChoice: boolean;
  /** 本条消息整体只是一个路由指令 */
  isCommand: boolean;
  /** 命中时的项目名（便于回显） */
  matchedName: string | null;
}

/** 中文指令：/项目 名称、#项目 3 ——「项目」后必须是空白/冒号/结尾，避免误吃「项目表」 */
const CMD_ZH = /^\s*[/#]\s*(?:项目|工程)(?=\s|[:：]|$)\s*[:：]?\s*([\s\S]*)$/;
/** 英文指令：/project 名称、/p:3 —— p 后面必须跟空白或冒号，避免误吃 /post */
const CMD_EN = /^\s*[/#]\s*(?:project|proj|p)(?=\s|[:：])\s*[:：]?\s*([\s\S]*)$/i;

function normName(s: any): string {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * 按名称 / 数字 匹配项目；匹配不到返回 null。
 *
 * 数字的优先级是「列表序号」优先、项目 id 兜底：
 * 「请选择项目」卡片上显示的就是列表序号，用户照着卡片回「/项目 2」必须能选到第 2 个；
 * 但项目 id 是稳定标识，序号越界时（如只有 2 个项目却回「/项目 9」）仍按 id 解析。
 */
function findProject(projects: any[], keyRaw: string): any | null {
  const key = normName(keyRaw);
  if (!key) return null;
  if (/^\d+$/.test(key)) {
    const idx = parseInt(key, 10);
    if (idx >= 1 && idx <= projects.length) return projects[idx - 1];
    const byId = projects.find(p => String(p.id) === key);
    if (byId) return byId;
  }
  const exact = projects.find(p => normName(p.name) === key);
  if (exact) return exact;
  // 名称包含关键字（关键字至少 2 个字符，避免单字误命中）
  const inc = projects.find(p => normName(p.name).includes(key) && key.length >= 2);
  if (inc) return inc;
  // 关键字包含名称
  const rev = projects.find(p => key.includes(normName(p.name)) && normName(p.name).length >= 2);
  if (rev) return rev;
  return null;
}

/**
 * 解析一条飞书消息的目标项目。
 * @param db 需要提供 db.project.list() / db.project.get() / db.feishuContext
 * @param awaitingChoice 机器人刚问过「这条消息落哪个项目」时为 true，
 *        此时允许只回一个裸数字（上下文明确，不会误伤「3个商品」这类计数）
 */
export function resolveFeishuTarget(opts: {
  text: string;
  chatId?: string;
  chatType?: string;
  db: any;
  awaitingChoice?: boolean;
}): FeishuTarget {
  const raw = String(opts.text || '');
  const db = opts.db;
  const projects: any[] = db && db.project && db.project.list ? db.project.list() : [];

  let cleanText = raw;
  let explicit = false;
  let isCommand = false;
  let matched: any | null = null;

  // 飞书群里 @ 机器人时，事件文本里可能残留 @名称 前缀 —— 命令匹配要能跳过它
  const cmdText = /^\s*@\S+\s+/.test(raw) ? raw.replace(/^\s*@\S+\s+/, '') : raw;

  // —— 1. 显式指令 ——
  // 内部指令「/项目#<id>」：严格按项目 id 解析，不走「序号优先」。
  // 卡片按钮回调用它派活 —— 按钮里存的是项目 id，若复用普通「/项目 N」，
  // 项目数 ≥ id 时会被当成列表序号，落到别的项目去。
  const idCmd = cmdText.match(/^\s*[/#]\s*(?:项目|工程)\s*#\s*(\d+)\s*$/);
  if (idCmd) {
    const byId = projects.find(x => x.id === parseInt(idCmd[1], 10));
    if (byId) {
      return {
        projectId: byId.id, project: byId, cleanText: '',
        explicit: true, viaBinding: false, needChoice: false,
        isCommand: true, matchedName: byId.name,
      };
    }
  }

  const cmd = cmdText.match(CMD_ZH) || cmdText.match(CMD_EN);
  if (cmd) {
    const argRaw = String(cmd[1] || '').trim();
    isCommand = true;
    // 项目名先按整段匹配，匹配不上再退到首个空白前（「/项目 2 帮我查库存」→ 名称 2 + 正文）
    let keyLen = 0;
    if (argRaw) {
      matched = findProject(projects, argRaw);
      if (matched) keyLen = argRaw.length;
      else {
        const sp = argRaw.search(/\s/);
        if (sp > 0) {
          const head = argRaw.slice(0, sp);
          const byHead = findProject(projects, head);
          if (byHead) { matched = byHead; keyLen = head.length; }
        }
      }
    }
    if (matched) {
      explicit = true;
      cleanText = argRaw.slice(keyLen).trim();
    } else {
      // 项目名没认出来：正文先留着，整体交给上层走「请选择项目」
      cleanText = argRaw;
      logger.info('[FeishuRouter] 指令未匹配到项目: %s', argRaw);
    }
  }

  // —— 2. 行内标记 ——
  if (!explicit) {
    const bracket = raw.match(/\[(?:笔记库|项目|工程)\s*[：:]\s*([^\]]+)\]/);
    if (bracket) {
      matched = findProject(projects, bracket[1]);
      if (matched) { explicit = true; cleanText = cleanText.replace(bracket[0], '').trim(); }
    }
  }
  if (!explicit) {
    const colon = cleanText.match(/(?:笔记库|项目|工程)\s*[：:]\s*(\S+)/);
    if (colon) {
      matched = findProject(projects, colon[1]);
      if (matched) { explicit = true; cleanText = cleanText.replace(colon[0], '').trim(); }
    }
  }

  // —— 3. 开头项目名（强信号：整名出现在开头） ——
  if (!explicit) {
    for (const p of projects) {
      const n = normName(p.name);
      if (n && normName(cleanText).startsWith(n)) {
        matched = p;
        explicit = true;
        cleanText = cleanText.slice(String(p.name).length).trim();
        break;
      }
    }
  }

  if (matched) {
    return {
      projectId: matched.id,
      project: matched,
      cleanText: cleanText || raw,
      explicit: true,
      viaBinding: false,
      needChoice: false,
      isCommand,
      matchedName: matched.name,
    };
  }

  // —— 纯指令（没给项目名，或项目名没认出来） → 需要用户选择 ——
  if (isCommand) {
    // 只有一个项目时，「/项目」就等于切到它，没必要问
    if (projects.length === 1) {
      const p = projects[0];
      return {
        projectId: p.id, project: p, cleanText: '',
        explicit: true, viaBinding: false, needChoice: false, isCommand: true, matchedName: p.name,
      };
    }
    return {
      projectId: null, project: null, cleanText: cleanText || '',
      explicit: false, viaBinding: false,
      needChoice: projects.length > 1,
      isCommand: true, matchedName: null,
    };
  }

  // —— 4. 机器人刚问过「落哪个项目」→ 允许只回一个裸数字 ——
  //    仅在 awaitingChoice 时生效：此时上下文明确是选项目，
  //    不会把「3个商品要补货」这类计数误判成项目序号。
  if (opts.awaitingChoice) {
    const bare = String(cleanText || '').trim();
    if (/^\d{1,4}$/.test(bare)) {
      const byIdx = findProject(projects, bare);
      if (byIdx) {
        return {
          projectId: byIdx.id, project: byIdx, cleanText: '',
          explicit: true, viaBinding: false, needChoice: false, isCommand: true, matchedName: byIdx.name,
        };
      }
    }
  }

  // —— 5. 会话绑定（群 / 私聊） ——
  const chatId = String(opts.chatId || '');
  if (chatId && db && db.feishuContext) {
    try {
      const bind = db.feishuContext.get(chatId);
      if (bind && bind.project_id) {
        const p = projects.find(x => x.id === bind.project_id) || db.project.get(bind.project_id);
        if (p) {
          return {
            projectId: p.id, project: p, cleanText,
            explicit: false, viaBinding: true, needChoice: false,
            isCommand: false, matchedName: p.name,
          };
        }
      }
    } catch (e: any) {
      logger.warn('[FeishuRouter] read binding failed: %s', e?.message);
    }
  }

  // —— 5. 只有一个项目 → 无歧义 ——
  if (projects.length === 1) {
    const p = projects[0];
    return {
      projectId: p.id, project: p, cleanText,
      explicit: false, viaBinding: false, needChoice: false, isCommand: false, matchedName: p.name,
    };
  }

  // —— 6. 多项目且无线索 → 绝不静默落默认项目 ——
  return {
    projectId: null, project: null, cleanText,
    explicit: false, viaBinding: false, needChoice: true, isCommand: false, matchedName: null,
  };
}

/** 绑定会话 → 项目（粘性上下文：绑定后该群/私聊的后续消息自动落该项目） */
export function bindChatToProject(db: any, chatId: string, chatType: string, projectId: number): boolean {
  if (!db || !db.feishuContext || !chatId) return false;
  try {
    db.feishuContext.set(chatId, chatType || '', projectId);
    return true;
  } catch (e: any) {
    logger.warn('[FeishuRouter] bind failed: %s', e?.message);
    return false;
  }
}

/** 解除会话绑定（该会话后续消息需重新指派） */
export function unbindChat(db: any, chatId: string): boolean {
  if (!db || !db.feishuContext || !chatId) return false;
  try { db.feishuContext.remove(chatId); return true; } catch { return false; }
}

/** 列出全部会话绑定 */
export function listBindings(db: any): any[] {
  if (!db || !db.feishuContext) return [];
  try { return db.feishuContext.list(); } catch { return []; }
}

/**
 * 决定这条消息是否需要先问用户选项目。
 *
 * 策略（2026-10-31 起）：**除消息本身已明确指定项目外，一律先弹项目选择卡片**。
 * 会话绑定不再是「直接执行」，而是变成卡片上的默认选项「继续上下文对话（当前项目）」——
 * 这样上下文始终由用户确认一次，不会静默落到某个项目。
 *
 * 不问的情况只有三种：
 *   1. 消息里已明确指定项目（/项目 X、[笔记库：X]、开头项目名）—— 指定本身就是选择；
 *   2. 只有一个项目 —— 没得选;
 *   3. 消息本身就是纯指令且未指明项目（交给上层按歧义处理）。
 */
export function needsProjectChoice(target: FeishuTarget, projectCount: number): boolean {
  if (!target || !target.project) return true;   // 认不出来 → 必须问
  if (target.needChoice) return true;
  if (target.explicit) return false;             // 消息已明确指定 → 不问
  if (projectCount <= 1) return false;           // 只有一个项目 → 没得选
  return true;                                   // 其余（含会话绑定）→ 一律先问
}

/**
 * 生成「请选择项目」的回复文本。
 * 列表序号即用户可用的指派编号（解析时序号优先、项目 id 兜底），
 * 另给出按名称指派的写法，两种都能落到同一个项目。
 */
export function buildProjectChoiceText(projects: any[], hint = ''): string {
  const lines = (projects || []).map((p, i) => `${i + 1}. ${p.name}`);
  return [
    `📂 这条消息要落到哪个项目？`,
    hint ? `\n${hint}` : '',
    `\n${lines.join('\n')}`,
    `\n直接回复序号（如「2」或「/项目 2」）即可指派；也可以写项目名（如「/项目 笔记库」）。`,
    `选中的项目会成为本会话的默认上下文，下一条消息默认带出它（仍会让你确认一次）。`,
    `只对这一条生效请写「[笔记库：项目名]」。`,
  ].join('\n');
}

/**
 * 供追问续跑复用：任务已记录的项目 → 目录。
 * 与首条消息同一口径，避免「首条跑 A、追问跑 B」。
 */
export function projectDirOf(project: any): string {
  return String((project && project.dir) || '').trim();
}

// ========== 待指派正文暂存 ==========
// 多项目无线索时先把原消息正文存下来：用户回复「/项目 2」时，
// 自动执行刚才那条被挂起的消息，而不是只做一次项目切换。
// 仅存于内存（30 分钟过期）——飞书侧对话在桌面进程存活期间连续发生。

const PENDING_BODY_TTL = 30 * 60 * 1000;
const pendingBodies = new Map<string, { text: string; at: number }>();
/** 机器人已就本会话问过「落哪个项目」——允许用户只回一个裸数字 */
const askedChoice = new Map<string, number>();

export function stashPendingBody(chatId: string, text: string): void {
  if (!chatId || !text) return;
  const now = Date.now();
  for (const [k, v] of pendingBodies) {
    if (now - v.at > PENDING_BODY_TTL) pendingBodies.delete(k);
  }
  pendingBodies.set(chatId, { text, at: now });
}

/** 该会话是否有待指派的正文（机器人刚问过「落哪个项目」） */
export function hasPendingBody(chatId: string): boolean {
  if (!chatId) return false;
  const v = pendingBodies.get(chatId);
  if (!v) return false;
  if (Date.now() - v.at > PENDING_BODY_TTL) { pendingBodies.delete(chatId); return false; }
  return true;
}

/** 标记：已就该会话询问过项目选择 */
export function markAskedChoice(chatId: string): void {
  if (!chatId) return;
  askedChoice.set(chatId, Date.now());
}

/** 是否正在等待用户选择项目（此时允许只回一个裸数字） */
export function isAwaitingChoice(chatId: string): boolean {
  if (!chatId) return false;
  const t = askedChoice.get(chatId);
  if (!t) return false;
  if (Date.now() - t > PENDING_BODY_TTL) { askedChoice.delete(chatId); return false; }
  return true;
}

/** 项目已确定，清掉「等待选择」状态 */
export function clearAskedChoice(chatId: string): void {
  if (chatId) askedChoice.delete(chatId);
}

/** 取出并清除某会话待指派的正文；没有或已过期返回 null */
export function takePendingBody(chatId: string): string | null {
  if (!chatId) return null;
  const v = pendingBodies.get(chatId);
  if (!v) return null;
  pendingBodies.delete(chatId);
  if (Date.now() - v.at > PENDING_BODY_TTL) return null;
  return v.text;
}

/** 查某会话当前绑定的项目 id；没有绑定返回 null */
export function boundProjectId(db: any, chatId: string): number | null {
  if (!chatId || !db || !db.feishuContext) return null;
  try {
    const bind = db.feishuContext.get(chatId);
    return bind && bind.project_id ? Number(bind.project_id) : null;
  } catch { return null; }
}

// ========== 「接着问」续聊模式（结果卡片 → 同一会话继续对话） ==========
// 点结果卡片的「💬 接着问」后记下那条对话的 sessionId；此后本会话的普通消息不再
// 每条新开会话，而是接在该 sessionId 后面继续对话（滑动 30 分钟窗口：续聊一次刷新一次）。
// 命令（/ 开头）与卡片选项目是显式的新话题动作，会退出该模式。
const pendingFollowups = new Map<string, { sid: string; at: number }>();

/** 进入/刷新某会话的「接着问」模式（记下要续聊的 sessionId） */
export function stashPendingFollowup(chatId: string, sessionId: string): void {
  if (!chatId || !sessionId) return;
  const now = Date.now();
  for (const [k, v] of pendingFollowups) {
    if (now - v.at > PENDING_BODY_TTL) pendingFollowups.delete(k);
  }
  pendingFollowups.set(chatId, { sid: sessionId, at: now });
}

/** 查看某会话「接着问」的目标 sessionId；没有或已过期返回 null（不消费） */
export function peekPendingFollowup(chatId: string): string | null {
  if (!chatId) return null;
  const v = pendingFollowups.get(chatId);
  if (!v) return null;
  if (Date.now() - v.at > PENDING_BODY_TTL) { pendingFollowups.delete(chatId); return null; }
  return v.sid;
}

/** 退出「接着问」模式 */
export function clearPendingFollowup(chatId: string): void {
  if (chatId) pendingFollowups.delete(chatId);
}

/**
 * 生成项目选择按钮组。按钮 value 携带动作类型与项目 id，
 * 点击后由 card.action.trigger 回调接管（需要飞书后台订阅卡片回调事件）。
 *
 * opts.keepLabel：设置时第一个按钮是「继续上下文对话」（用于选择卡片，沿用会话绑定的项目）。
 */
export function buildProjectButtons(
  projects: any[],
  opts: { keepLabel?: string; keepId?: number | null } = {},
): Array<{ text: string; value: any; type?: 'default' | 'primary' | 'danger' }> {
  const buttons: Array<{ text: string; value: any; type?: 'default' | 'primary' | 'danger' }> = (projects || []).map((p: any, i: number) => ({
    text: `${i + 1}. ${p.name}`,
    type: 'default',
    value: { act: 'pick_project', pid: p.id, seq: i + 1 },
  }));
  // 「继续上下文对话」放在最前，语义上就是「沿用当前会话绑定的项目」
  if (opts.keepLabel && opts.keepId) {
    buttons.unshift({
      text: opts.keepLabel,
      type: 'primary',
      value: { act: 'pick_project', pid: opts.keepId, seq: 0 },
    });
  }
  return buttons;
}
