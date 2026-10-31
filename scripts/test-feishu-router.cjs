/**
 * feishu 链路回归测试。
 * 覆盖：显式指令 / 行内标记 / 开头项目名 / 会话绑定 / 数字 id 防误判 / 单项目 / 多项目歧义 /
 *       待指派暂存 / 卡片按钮与重跑记忆 / 交互卡片 JSON 结构。
 *
 * 运行：npm run compile:electron && npm run test:router
 */
const router = require('../dist-electron/electron/services/feishu-router.js');
const feishu = require('../dist-electron/electron/services/feishu.js');

const PROJECTS = [
  { id: 1, name: '金箔雲项目', dir: '/d/jfy' },
  { id: 2, name: '门店运营', dir: '/d/store' },
  { id: 3, name: '618大促', dir: '/d/618' },
];

const bindings = new Map();
const db = {
  project: {
    list: () => PROJECTS.slice(),
    get: (id) => PROJECTS.find(p => p.id === id) || null,
  },
  feishuContext: {
    get: (chatId) => bindings.get(chatId) || null,
    set: (chatId, chatType, projectId) => bindings.set(chatId, { chat_id: chatId, chat_type: chatType, project_id: projectId }),
    remove: (chatId) => bindings.delete(chatId),
    list: () => [...bindings.values()],
  },
};

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      实际: ' + a + '\n      期望: ' + e); }
}

function resolve(text, chatId, chatType = 'group') {
  return router.resolveFeishuTarget({ text, chatId, chatType, db });
}

console.log('\n[1] 显式指令');
check('/项目 金箔雲项目', resolve('/项目 金箔雲项目', 'c1').projectId, 1);
check('/项目 2', resolve('/项目 2', 'c1').projectId, 2);
check('/项目 618大促 的库存', resolve('/项目 618大促 的库存', 'c1').projectId, 3);
check('/p 金箔雲', resolve('/p 金箔雲', 'c1').projectId, 1);
check('/p:3', resolve('/p:3', 'c1').projectId, 3);
check('#项目 门店运营', resolve('#项目 门店运营', 'c1').projectId, 2);
check('指令正文被剥离', resolve('/项目 2 帮我查库存', 'c1').cleanText, '帮我查库存');
check('指令+正文 项目正确', resolve('/项目 2 帮我查库存', 'c1').projectId, 2);
check('不误吃 /post', resolve('/post 内容', 'c1').projectId, null);
check('不误吃 /post → 走歧义', resolve('/post 内容', 'c1').needChoice, true);
check('不误吃 /项目表', resolve('/项目表 内容', 'c1').projectId, null);
check('未知项目名 → 走歧义', resolve('/项目 不存在的名字', 'c1').needChoice, true);
check('未知项目名 → 正文保留', resolve('/项目 不存在的名字 帮我查', 'c1').cleanText, '不存在的名字 帮我查');

console.log('\n[2] 行内标记');
check('[笔记库：金箔雲项目]', resolve('[笔记库：金箔雲项目] 帮我看下库存', 'c2').projectId, 1);
check('标记被剥离', resolve('[笔记库：金箔雲项目] 帮我看下库存', 'c2').cleanText, '帮我看下库存');
check('项目：门店运营', resolve('项目：门店运营 补货', 'c2').projectId, 2);
check('标记是单条生效（不写绑定）', bindings.has('c2'), false);

console.log('\n[3] 开头项目名');
check('金箔雲项目 帮我看下', resolve('金箔雲项目 帮我看下', 'c3').projectId, 1);
check('开头项目名被剥离', resolve('金箔雲项目 帮我看下', 'c3').cleanText, '帮我看下');

console.log('\n[4] 会话绑定（粘性上下文）');
router.bindChatToProject(db, 'c4', 'group', 3);
check('绑定后自动落项目 3', resolve('随便问点什么', 'c4').projectId, 3);
check('来源标记为绑定', resolve('随便问点什么', 'c4').viaBinding, true);
check('绑定时正文原样保留', resolve('随便问点什么', 'c4').cleanText, '随便问点什么');
router.bindChatToProject(db, 'c4', 'group', 1);
check('绑定可被覆盖', resolve('随便问点什么', 'c4').projectId, 1);
check('显式指令优先于绑定', resolve('/项目 2 查库存', 'c4').projectId, 2);
check('行内标记优先于绑定', resolve('[笔记库：618大促] 查库存', 'c4').projectId, 3);

console.log('\n[5] 数字 id 只走显式指令');
check('"3个商品要补货" 不误判', resolve('3个商品要补货', 'c5').projectId, null);
check('"3 个商品要补货" 不误判', resolve('3 个商品要补货', 'c5').projectId, null);
check('"3 个商品要补货" → 走歧义', resolve('3 个商品要补货', 'c5').needChoice, true);
check('数字 id 显式指定可用', resolve('/项目 2 帮我查库存', 'c5').projectId, 2);

console.log('\n[6] 歧义与单项目');
check('多项目无线索 → needChoice', resolve('帮我看下库存', 'c6').needChoice, true);
check('多项目无线索 → 不给默认项目', resolve('帮我看下库存', 'c6').projectId, null);
check('纯指令无参数 → needChoice', resolve('/项目', 'c6').needChoice, true);
check('纯指令无参数 → 正文为空', resolve('/项目', 'c6').cleanText, '');

const single = {
  project: { list: () => [{ id: 9, name: '唯一项目', dir: '/d/only' }], get: (id) => ({ id: 9, name: '唯一项目', dir: '/d/only' }) },
  feishuContext: db.feishuContext,
};
const singleResolve = router.resolveFeishuTarget({ text: '随便说点什么', chatId: 'c7', chatType: 'p2p', db: single });
check('只有一个项目 → 直接落它', singleResolve.projectId, 9);
check('只有一个项目 → 不需要问', singleResolve.needChoice, false);
const singleCmd = router.resolveFeishuTarget({ text: '/项目', chatId: 'c7', chatType: 'p2p', db: single });
check('单项目时 /项目 → 切到它', singleCmd.projectId, 9);
check('单项目时 /项目 → 无正文', singleCmd.cleanText, '');

console.log('\n[7] 待指派正文暂存');
router.stashPendingBody('c8', '帮我看下库存');
check('暂存后可取回', router.takePendingBody('c8'), '帮我看下库存');
check('取一次后即清空', router.takePendingBody('c8'), null);
router.stashPendingBody('c8b', '帮我看下库存');
check('hasPendingBody 能看到', router.hasPendingBody('c8b'), true);
router.takePendingBody('c8b');
check('取走后 hasPendingBody 为 false', router.hasPendingBody('c8b'), false);
check('无待指派时 hasPendingBody 为 false', router.hasPendingBody('c8c'), false);
router.markAskedChoice('c8d');
check('markAskedChoice → isAwaitingChoice', router.isAwaitingChoice('c8d'), true);
check('未询问过的会话不是等待状态', router.isAwaitingChoice('c8e'), false);
router.clearAskedChoice('c8d');
check('clearAskedChoice 后不再等待', router.isAwaitingChoice('c8d'), false);

console.log('\n[8] 选择文案');
const txt = router.buildProjectChoiceText(PROJECTS, '需要指定一下：');
check('文案含项目序号', txt.includes('1. 金箔雲项目') && txt.includes('3. 618大促'), true);
check('文案含指派指令提示', txt.includes('/项目 2') && txt.includes('直接回复序号'), true);
check('文案含按名称指派提示', txt.includes('/项目 笔记库'), true);

console.log('\n[9] 空项目');
const empty = { project: { list: () => [], get: () => null }, feishuContext: db.feishuContext };
const r9 = router.resolveFeishuTarget({ text: '你好', chatId: 'c9', chatType: 'p2p', db: empty });
check('无项目 → needChoice', r9.needChoice, true);
check('无项目 → projectId 为 null', r9.projectId, null);

console.log('\n[10] 序号 ≠ 项目 id（真实场景：id 8/9，卡片显示 1/2）');
const REAL = [
  { id: 9, name: 'qihang-ai-desktop', dir: '/d/app' },
  { id: 8, name: '笔记库', dir: '/d/notes' },
];
const realDb = {
  project: { list: () => REAL.slice(), get: (id) => REAL.find(p => p.id === id) || null },
  feishuContext: db.feishuContext,
};
const rr = (text, awaitingChoice) => router.resolveFeishuTarget({ text, chatId: 'rz', chatType: 'group', db: realDb, awaitingChoice });
check('卡片序号 1 → 列表第1个', rr('/项目 1').projectId, 9);
check('卡片序号 2 → 列表第2个', rr('/项目 2').projectId, 8);
check('序号越界 → 回退按 id 解析', rr('/项目 9').projectId, 9);
check('按名称指派', rr('/项目 笔记库').projectId, 8);
check('名称模糊指派', rr('/项目 笔记').projectId, 8);
check('等选择时裸数字可用', rr('2', true).projectId, 8);
check('等选择时裸数字 → 无正文', rr('2', true).cleanText, '');
check('不等选择时裸数字不认', rr('2', false).projectId, null);
check('不等选择时裸数字 → 走歧义', rr('2', false).needChoice, true);
check('@机器人提及 + 指令', rr('@启航编程AI /项目 2').projectId, 8);
check('@机器人提及 + 指令 + 正文', rr('@启航编程AI /项目 2 帮我查库存').cleanText, '帮我查库存');
check('@机器人提及不影响普通消息', rr('@启航编程AI 帮我查库存').needChoice, true);

console.log('\n[9] 卡片按钮与重跑记忆');
// 按钮组：序号与卡片文字里的列表序号一致
const btns = router.buildProjectButtons(PROJECTS);
check('按钮数量 = 项目数', btns.length, 3);
check('按钮文本带序号', btns[0].text, '1. 金箔雲项目');
check('按钮 value 带项目 id', btns[1].value, { act: 'pick_project', pid: 2, seq: 2, rerun: false });
check('重跑模式加 ↻ 前缀', router.buildProjectButtons(PROJECTS, { rerun: true })[0].text, '↻ 1. 金箔雲项目');
check('重跑模式排除当前项目', router.buildProjectButtons(PROJECTS, { rerun: true, excludeId: 2 }).map(b => b.value.pid), [1, 3]);
check('排除后序号仍连续', router.buildProjectButtons(PROJECTS, { rerun: true, excludeId: 2 }).map(b => b.text), ['↻ 1. 金箔雲项目', '↻ 2. 618大促']);
check('有绑定时首个按钮是继续上下文对话', router.buildProjectButtons(PROJECTS, { keepLabel: '继续上下文对话（金箔雲项目）', keepId: 1 })[0].text, '继续上下文对话（金箔雲项目）');
check('继续上下文按钮带绑定项目 id', router.buildProjectButtons(PROJECTS, { keepLabel: 'x', keepId: 1 })[0].value.pid, 1);
check('无绑定时不加继续上下文按钮', router.buildProjectButtons(PROJECTS)[0].text, '1. 金箔雲项目');

// 上一条消息记忆：供「换个项目重跑」取回正文
check('初始没有上一条消息', router.recallLastBody('cm1'), null);
router.rememberLastBody('cm1', '帮我查库存');
check('记住后可取回', router.recallLastBody('cm1'), '帮我查库存');
check('取回不消费记忆', router.recallLastBody('cm1'), '帮我查库存');
router.rememberLastBody('cm2', '别的会话');
check('不同会话互不干扰', router.recallLastBody('cm1'), '帮我查库存');
check('会话绑定查询', router.boundProjectId(db, 'cb1'), null);
db.feishuContext.set('cb1', 'group', 2);
check('已绑定会话能查到项目 id', router.boundProjectId(db, 'cb1'), 2);

console.log('\n[10] 交互卡片 JSON 结构');
const els = feishu.buildCardElements('正文内容', {
  note: '本条发到：笔记库',
  buttons: [{ text: '↻ 1. 金箔雲项目', type: 'default', value: { act: 'pick_project', pid: 1, seq: 1, rerun: true } }],
});
check('元素数量 = 正文+note+action', els.length, 3);
check('首个是 markdown', els[0].tag, 'markdown');
check('正文内容正确', els[0].content, '正文内容');
check('note 元素结构', els[1].elements[0].content, '本条发到：笔记库');
check('action 元素', els[2].tag, 'action');
check('按钮数量', els[2].actions.length, 1);
check('按钮文案', els[2].actions[0].text.content, '↻ 1. 金箔雲项目');
check('按钮类型', els[2].actions[0].type, 'default');
check('按钮 value 带动作与项目', els[2].actions[0].value, { act: 'pick_project', pid: 1, seq: 1, rerun: true });
check('无按钮时不产生 action 元素', feishu.buildCardElements('x').length, 1);
check('无 note 时不产生 note 元素', feishu.buildCardElements('x', { buttons: [{ text: 'b', value: {} }] })[1].tag, 'action');

console.log('\n[11] 内部 id 指令（卡片按钮派活用）');
// 9 个项目、id 与序号完全错位：普通「/项目 2」按序号解析到第 2 个（id 8），
// 内部「/项目#2」必须严格按 id 解析到 id 2（第 9 个）。
const MANY = Array.from({ length: 9 }, (_, i) => ({ id: 9 - i, name: 'P' + (9 - i), dir: '/d/p' + (9 - i) }));
const manyDb = {
  project: { list: () => MANY.slice(), get: (id) => MANY.find(p => p.id === id) || null },
  feishuContext: db.feishuContext,
};
const rm = (text) => router.resolveFeishuTarget({ text, chatId: 'rm', chatType: 'group', db: manyDb });
check('普通 /项目 2 → 列表序号第2个', rm('/项目 2').projectId, 8);
check('内部 /项目#2 → 严格按 id', rm('/项目#2').projectId, 2);
check('内部 /项目#9 → id 9', rm('/项目#9').projectId, 9);
check('内部 /项目#1 → id 1', rm('/项目#1').projectId, 1);
check('内部指令无正文', rm('/项目#2').cleanText, '');
check('内部指令是显式指定', rm('/项目#2').explicit, true);
check('内部指令不触发歧义', rm('/项目#2').needChoice, false);
check('内部指令 id 不存在 → 走歧义', rm('/项目#99').needChoice, true);

console.log('\n[12] 每条消息都先问项目（needsProjectChoice）');
const npc = (text, chatId, projectCount) => router.needsProjectChoice(
  router.resolveFeishuTarget({ text, chatId, chatType: 'group', db }), projectCount
);
// 无线索 + 有绑定 → 也要问（绑定只是默认选项，不再静默执行）
db.feishuContext.set('cbind', 'group', 1);
check('无线索 + 有绑定 → 仍需确认', npc('帮我查库存', 'cbind', 3), true);
check('无线索 + 无绑定 → 需确认', npc('帮我查库存', 'cnone', 3), true);
// 消息本身已明确指定项目 → 不问
check('/项目 指定 → 不问', npc('/项目 门店运营 帮我查库存', 'cnone', 3), false);
check('行内标记 → 不问', npc('[笔记库：门店运营] 帮我查库存', 'cnone', 3), false);
check('开头项目名 → 不问', npc('门店运营 帮我查库存', 'cnone', 3), false);
// 只有一个项目 → 没得选，不问（用只有 1 个项目的库来测）
const ONE = [{ id: 1, name: '唯一项目', dir: '/d/only' }];
const oneDb = {
  project: { list: () => ONE.slice(), get: (id) => ONE.find(p => p.id === id) || null },
  feishuContext: db.feishuContext,
};
check('单项目 + 无线索 → 不问', router.needsProjectChoice(
  router.resolveFeishuTarget({ text: '帮我查库存', chatId: 'cone', chatType: 'group', db: oneDb }), 1), false);
// 认不出项目 → 必须问
check('认不出项目 → 需确认', npc('/项目 999', 'cnone', 3), true);

console.log('\n————————————————');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
