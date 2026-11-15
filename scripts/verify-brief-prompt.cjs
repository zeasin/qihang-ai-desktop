/**
 * 端到端验证昨日简报的提示词：真实笔记库 + 真实待办筛选，只把 AI 调用与落盘/推送打桩。
 * 用法：ELECTRON_RUN_AS_NODE=1 electron scripts/verify-brief-prompt.cjs
 *
 * 注意：REAL_AI=1 会真的调 pi 智能体生成简报——它以本仓库为工作目录，
 * 有可能顺手改动仓库文件；只在明确需要看真实产出时开启，跑完记得 git status 核对。
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');

const briefPath = path.join(root, 'dist-electron/electron/radar/radar-brief.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-prompt-'));
const captured = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: false, getPath: () => os.tmpdir() } };
  if (parent && path.resolve(parent.filename) === briefPath) {
    if (request === '../services/database') {
      return { project: { getDefault: () => ({ dir: tmp }), list: () => [] }, task: { listTodos: () => [] } };
    }
    if (request === '../services/app-config') return { getConfig: () => '' };
    if (request === '../services/feishu') return { setWebhook: () => {}, sendViaWebhook: async () => ({ ok: true }) };
    if (request === '../services/ai-tools') {
      if (process.env.REAL_AI === '1') return originalLoad.call(this, request, parent, isMain);
      return {
        generateWithPi: async ({ prompt, sessionId }) => {
          captured.push({ sessionId, prompt });
          return 'MOCK-BRIEF';
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const { getBrief } = require(briefPath);
    const r = await getBrief(true);
    console.log('getBrief 结果:', JSON.stringify(r).slice(0, 200));
    if (process.env.REAL_AI === '1') {
      console.log('\n================ 真实生成的简报 ================\n');
      console.log(r.brief || '(空)');
      return;
    }
    console.log('AI 调用次数:', captured.length);
    const master = captured.find((c) => !c.sessionId.includes('_note') && !c.sessionId.includes('_shard_'));
    if (!master) { console.error('没有拿到主汇总提示词'); process.exitCode = 1; return; }
    const p = master.prompt;
    const start = p.indexOf('## 今日待办');
    console.log('\n===== 提示词里的「今日待办」段 =====');
    console.log(p.slice(start, p.indexOf('## 要求')));
    console.log('\n===== 要求段 =====');
    console.log(p.slice(p.indexOf('## 要求')));
    console.log('\n===== 笔记库动态标题 =====');
    const m = p.match(/## 昨日笔记库动态（[^）]*）/);
    console.log(m ? m[0] : '(未找到)');
    console.log('\n===== 旧待办是否泄漏（应为 0）=====');
    for (const s of ['每月25日：社保', '金箔雲项目实施', 'POS桌面端']) {
      console.log(`  "${s}" 出现次数: ${(p.split(s).length - 1)}`);
    }
  } finally {
    Module._load = originalLoad;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
