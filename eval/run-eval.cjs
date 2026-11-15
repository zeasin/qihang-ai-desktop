/**
 * 问雷达检索层评测：走真实链路（extractKeywords → searchHits → 真库），
 * 不调 AI、可反复跑。用法：node eval/run-eval.cjs [-v]
 * 指标：recall@5 / recall@10（去重会话前 K 含期望比例）、MRR（首个期望命中位次倒数）。
 * 输出：每题明细 + 宏平均。基线分数是后续检索优化（摘要注入、向量）的对照。
 */
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const MOD = path.resolve(__dirname, '..', 'dist-electron', 'electron', 'radar', 'radar-ask.js');
const req = Module.createRequire(MOD);
const dbPath = path.join(os.homedir(), '.qihang-ai-desktop', 'radar', 'radar.db');

// 桩掉 radar-ask 拉进来的 electron 服务链（agent-radar 换成真实 RadarDb 只读壳；ai-tools/logger 评测用不到）
const { RadarDb } = require(path.resolve(__dirname, '..', 'dist-electron', 'electron', 'radar', 'radar-db.js'));
const radarDb = new RadarDb(path.dirname(dbPath), { readonly: true });
const svcDir = path.resolve(path.dirname(req.resolve(MOD)), '..', 'services');
const stubs = {
  [path.join(svcDir, 'agent-radar.js')]: { agentRadar: { isEnabled: () => true, searchMessages: (kw, n) => radarDb.searchMessages(kw, n) } },
  [path.join(svcDir, 'ai-tools.js')]: { generateWithPi: async () => { throw new Error('评测不应调 AI'); } },
  [path.join(svcDir, 'logger.js')]: { info() {}, warn() {}, error() {}, debug() {} },
};
for (const [p, exports] of Object.entries(stubs)) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { extractKeywords, searchHits } = require(MOD);
const suite = require(path.join(__dirname, 'radar-retrieval.json'));

const verbose = process.argv.includes('-v');
let sumR5 = 0, sumR10 = 0, sumMRR = 0, full = 0;

console.log(`评测集 ${suite.cases.length} 题（库: ${dbPath}）\n`);
for (const c of suite.cases) {
  const kws = extractKeywords(c.question);
  const hits = searchHits(kws);
  // 消息级命中 → 会话去重，保留首现位次
  const seen = new Map();
  for (const h of hits) {
    const key = `${h.tool}|${h.sessionId}`;
    if (!seen.has(key)) seen.set(key, { tool: h.tool, sessionId: h.sessionId, hits: h._hits });
  }
  const ranked = [...seen.values()];
  let r5 = 0, r10 = 0, firstRank = 0;
  const missed = [];
  for (const [tool, sid] of c.expect) {
    const idx = ranked.findIndex((s) => s.tool === tool && s.sessionId === sid);
    if (idx < 0) { missed.push(`${tool}/${sid.slice(0, 10)}`); continue; }
    if (idx < 5) r5++;
    if (idx < 10) r10++;
    if (!firstRank || idx + 1 < firstRank) firstRank = idx + 1;
  }
  const r = 1 / firstRank;
  sumR5 += r5 / c.expect.length;
  sumR10 += r10 / c.expect.length;
  sumMRR += firstRank ? r : 0;
  if (firstRank && r5 === c.expect.length) full++;
  const tag = missed.length ? `未中: ${missed.join(', ')}` : '全中';
  console.log(`${c.id} 关键词[${kws.join(',')}] 去重会话${ranked.length}个 @5=${r5}/${c.expect.length} @10=${r10}/${c.expect.length} MRR=${firstRank ? r.toFixed(2) : '0'} ${tag}`);
  if (verbose) {
    for (let i = 0; i < Math.min(10, ranked.length); i++) {
      console.log(`   #${i + 1} ${ranked[i].tool}/${ranked[i].sessionId.slice(0, 14)} (命中${ranked[i].hits}词)`);
    }
  }
}
const n = suite.cases.length;
console.log(`\n基线: recall@5=${(sumR5 / n * 100).toFixed(1)}% recall@10=${(sumR10 / n * 100).toFixed(1)}% MRR=${(sumMRR / n).toFixed(3)} 全中题=${full}/${n}`);
