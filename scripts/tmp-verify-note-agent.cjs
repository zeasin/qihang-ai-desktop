// 临时脚本：隔离验证昨日简报笔记库子 agent（小数据量 / 大数据量入池 / 失败降级）。验证后删除。
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const briefPath = path.resolve('dist-electron/electron/radar/radar-brief.js');
const originalLoad = Module._load;

const DOC_A = '---\ntitle: A\nFRONTSECRET: 不应出现\n---\n\n# 文档A\n\n文档A正文标记：完成了接口合并改造，遗留打印模板问题。';
const DOC_B = '# 文档B\n\n文档B正文标记：整理了官网线索台账，新增三条线索。';

async function runCase({ sessionCount, docs, failNote }) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    tool: 'mock', sessionId: 's' + (i + 1), title: 'session-' + (i + 1),
    sourceUpdatedAt: Date.now(), summary: 'summary-' + (i + 1),
  }));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-note-'));
  const fileEntries = docs.map((d) => {
    const full = path.join(tmp, d.name);
    fs.writeFileSync(full, d.body, 'utf-8');
    return { projectId: 1, projectName: 'P', rel: d.name, full, mtime: Date.now() - 3600e3 };
  });
  const mocks = {
    '../services/app-config': { getConfig: () => '' },
    '../services/database': { project: { getDefault: () => null, list: () => [] }, task: { listTodos: () => [] } },
    '../services/feishu': { setWebhook: () => {}, sendViaWebhook: async () => ({ ok: true }) },
    '../services/project-scan': { collectRecentFiles: () => fileEntries },
    '../services/agent-radar': { agentRadar: {
      sessionsByRange: (_s, _e, limit) => ({ total: sessionCount, rows: limit === null ? sessions : sessions.slice(0, limit) }),
      sessionMessages: () => [],
    } },
    '../services/note-digest': { extractDigest: () => ({ todos: [], followups: [] }) },
    '../services/ai-tools': { generateWithPi: async ({ prompt, sessionId }) => {
      calls.push({ prompt, sessionId });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      if (failNote && sessionId.includes('_note')) throw new Error('mock note failure');
      if (sessionId.includes('_note')) return 'NOTE-SUMMARY-MARKER 文档A要点；文档B要点';
      if (sessionId.includes('_shard_')) return 'SHARD-DIGEST ' + sessionId;
      return 'MASTER-BRIEF';
    } },
    '../services/logger': { info: () => {}, warn: () => {} },
  };
  Module._load = function (request, parent, isMain) {
    if (parent && path.resolve(parent.filename) === briefPath && mocks[request]) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[briefPath];
  try {
    const result = await require(briefPath).getBrief(true);
    return { result, calls, maxActive, tmp };
  } finally {
    Module._load = originalLoad;
  }
}

(async () => {
  const tmps = [];
  try {
    // 用例1：小数据量（2 会话 + 2 文档）→ note 子助手先行，主汇总单次
    const small = await runCase({ sessionCount: 2, docs: [{ name: 'A.md', body: DOC_A }, { name: 'B.md', body: DOC_B }], failNote: false });
    tmps.push(small.tmp);
    assert.equal(small.result.ok, true);
    assert.equal(small.calls.length, 2);
    const noteCall = small.calls[0];
    const masterCall = small.calls[1];
    assert.ok(noteCall.sessionId.includes('_note'));
    assert.ok(!noteCall.sessionId.includes('_shard_'));
    assert.ok(noteCall.prompt.includes('文档A正文标记') && noteCall.prompt.includes('文档B正文标记'));
    assert.ok(!noteCall.prompt.includes('FRONTSECRET'));
    assert.equal(masterCall.sessionId, 'brief_' + small.calls[0].sessionId.split('brief_')[1].split('_')[0] + '_' + small.calls[0].sessionId.split('_')[3] + '');
    assert.ok(masterCall.prompt.includes('NOTE-SUMMARY-MARKER'));
    assert.ok(!masterCall.prompt.includes('文档A正文标记'));

    // 用例2：大数据量（22 会话 + 2 文档）→ 3 个会话分片 + note 入池，主汇总合并
    const large = await runCase({ sessionCount: 22, docs: [{ name: 'A.md', body: DOC_A }, { name: 'B.md', body: DOC_B }], failNote: false });
    tmps.push(large.tmp);
    assert.equal(large.result.ok, true);
    const shards = large.calls.filter((c) => c.sessionId.includes('_shard_'));
    const notes = large.calls.filter((c) => c.sessionId.includes('_note'));
    const masters = large.calls.filter((c) => !c.sessionId.includes('_shard_') && !c.sessionId.includes('_note'));
    assert.equal(shards.length, 3);
    assert.equal(notes.length, 1);
    assert.equal(masters.length, 1);
    assert.ok(notes[0].prompt.includes('文档A正文标记'));
    assert.ok(shards.every((c) => !c.prompt.includes('[文档]')));
    assert.ok(large.maxActive > 1 && large.maxActive <= 3);
    assert.ok(masters[0].prompt.includes('NOTE-SUMMARY-MARKER'));
    assert.ok(masters[0].prompt.includes('SHARD-DIGEST'));
    assert.ok(masters[0].prompt.includes('22 个会话'));

    // 用例3：note 子助手失败（1 会话 + 2 文档）→ 原始摘录降级进主汇总
    const failed = await runCase({ sessionCount: 1, docs: [{ name: 'A.md', body: DOC_A }, { name: 'B.md', body: DOC_B }], failNote: true });
    tmps.push(failed.tmp);
    assert.equal(failed.result.ok, true);
    assert.equal(failed.result.brief, 'MASTER-BRIEF');
    const master3 = failed.calls.find((c) => !c.sessionId.includes('_shard_') && !c.sessionId.includes('_note'));
    assert.ok(master3.prompt.includes('笔记库子助手提炼失败'));
    assert.ok(master3.prompt.includes('文档A正文标记') && master3.prompt.includes('文档B正文标记'));

    console.log('PASS: 小路径 note 先行且剥 frontmatter；大路径 3 分片 + note 入池（实测并行 %s）；note 失败原文降级', large.maxActive);
  } finally {
    Module._load = originalLoad;
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
