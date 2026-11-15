/**
 * 验证「今日待办挑选」：跑真实笔记库 + 昨日真实 AI 会话，输出筛选前后的对比。
 * 用法：ELECTRON_RUN_AS_NODE=1 electron scripts/verify-todo-picker.cjs
 */
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');

// 以 ELECTRON_RUN_AS_NODE 运行时没有 electron.app，桩一个给 app-config 用
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: false, getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};

const { extractDigest } = require(path.join(root, 'dist-electron/electron/services/note-digest.js'));
const { pickTodayTodos, renderTodoCandidates } = require(path.join(root, 'dist-electron/electron/radar/todo-picker.js'));
const { agentRadar } = require(path.join(root, 'dist-electron/electron/services/agent-radar.js'));
const projectScan = require(path.join(root, 'dist-electron/electron/services/project-scan.js'));
const fs = require('node:fs');

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
const now = Date.now();
const ys = new Date(now); ys.setDate(ys.getDate() - 1); ys.setHours(0, 0, 0, 0);
const ye = new Date(ys); ye.setDate(ye.getDate() + 1);

const res = agentRadar.sessionsByRange(ys.getTime(), ye.getTime(), null);
const docs = res.rows.map((s) => {
  let firstAsk = '';
  try {
    const msgs = agentRadar.sessionMessages(String(s.tool), String(s.sessionId)) || [];
    const u = msgs.find((m) => String(m.role) === 'user' && String(m.content || '').trim());
    if (u) firstAsk = String(u.content).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch { /* ignore */ }
  return { title: String(s.title || '（无标题）'), text: [s.summary || '', firstAsk].filter(Boolean).join(' ') };
});
console.log('昨日会话主题数:', docs.length);
console.log('\n===== 昨日会话主题（title || 首段摘要）=====');
docs.forEach((d, i) => console.log(`${i + 1}. ${d.title.slice(0, 60)} || ${String(d.text).slice(0, 80)}`));

// 昨日更新的笔记文档（与 radar-brief 同一口径），作为主题上下文
const noteFiles = projectScan.collectRecentFiles(null, { start: ys.getTime(), end: ye.getTime() });
const noteDocs = noteFiles.map((f) => {
  let content = '';
  try { content = fs.readFileSync(f.full, 'utf-8').replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim().slice(0, 1500); } catch { /* ignore */ }
  const segs = String(f.rel).split('/');
  const base = (segs.pop() || '').replace(/\.md$/i, '');
  const parent = segs[segs.length - 1] || '';
  return { title: parent ? `${base}（${parent}）` : base, text: content };
});
console.log('\n昨日更新笔记数:', noteDocs.length);
noteDocs.forEach((d) => console.log('- ' + d.title));

const digest = extractDigest();
const pending = digest.todos.filter((t) => !t.done);
console.log('\n===== 筛选前：旧逻辑取前 8 条未勾待办 =====');
pending.slice(0, 8).forEach((t) => console.log('- ' + t.text + '  《' + t.file + '》'));

const picked = pickTodayTodos({ digest, localTasks: [], contextDocs: [...docs, ...noteDocs], now, activeSince: ys.getTime() });
console.log('\n===== 筛选统计 =====');
console.log(JSON.stringify(picked.stats));
console.log('\n===== 被剔除的条目 =====');
for (const r of picked.rejected) console.log('- [' + r.reason + '] ' + r.text + '  《' + r.file + '》');
console.log('\n===== 筛选后：交给 AI 的候选清单 =====');
console.log(renderTodoCandidates(picked.items));
console.log('\n===== 候选明细 =====');
for (const it of picked.items) {
  console.log(`[${it.origin}] score=${it.score.toFixed(1)} days=${it.days} 《${it.file}》`);
  console.log('   ' + it.text);
  console.log('   依据：' + it.evidence.join('；'));
}
