/**
 * 摘要质量规则检查：不调 AI、可反复跑。用法：node eval/check-summaries.cjs [-v]
 * 检查项：
 *  1. 结构完整度——四段卡片格式（做了什么/关键决策/涉及文件/结果与遗留）
 *  2. 忠实度——摘要里引用的文件名在该会话消息正文中是否出现（防 AI 编造）
 *  3. 空泛摘要——四段全是「无/未提及」（调 AI 白调，值得排查门槛或素材）
 *  4. 覆盖统计——高价值会话的摘要覆盖率与补摘进度
 * 摘要层评测（与人工/标准摘要对比）不在此脚本，等补摘完成后另行构建。
 */
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(os.homedir(), '.qihang-ai-desktop', 'radar', 'radar.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const SECTIONS = ['做了什么', '关键决策', '涉及文件', '结果与遗留'];
// 段标记用子串匹配：模型实际输出「**关键决策/结论**」等变体，严格匹配 `**关键决策**` 会全量误报
const hasSection = (sum, k) => sum.includes(k);
const FILE_TOKEN_RE = /[A-Za-z0-9_.\-/\\]+\.(?:tsx?|jsx?|vue|json|md|sql|py|css|scss|html|yaml|yml|sh|cjs|mjs)/g;
const EMPTY_WORDS = /^(?:无|未提及|暂无|没有|（无）|\(无\))[\s。.]*$/;

const verbose = process.argv.includes('-v');
const sessions = db.prepare(`
  SELECT tool, session_id, substr(title, 1, 40) AS title, summary, message_count,
         (SELECT count(*) FROM radar_message m WHERE m.tool = radar_session.tool AND m.session_id = radar_session.session_id) AS msgs
  FROM radar_session WHERE value_score >= 3 AND frozen = 0 AND summary <> ''
  ORDER BY summary_at DESC
`).all();

let fmtOk = 0;
const suspicious = [];
const empties = [];
let withFiles = 0;

for (const s of sessions) {
  const sum = String(s.summary || '');
  const missing = SECTIONS.filter((k) => !hasSection(sum, k));
  if (!missing.length) fmtOk++;
  else { suspicious.push({ s, why: `缺段: ${missing.join('/')}` }); continue; }

  // 空泛：四个段的值全是「无/未提及」
  const vals = sum.split(/\*\*[^*]+\*\*/g).map((x) => x.replace(/^[：:\s]+/m, '').trim()).filter(Boolean);
  if (vals.length && vals.every((v) => EMPTY_WORDS.test(v))) { empties.push(s); continue; }

  // 忠实度：摘要中文件名 basename 在会话消息正文中核对
  const tokens = [...new Set((sum.match(FILE_TOKEN_RE) || []).map((t) => {
    const base = t.split(/[\\/]/).pop();
    return base && base.length >= 4 ? base : null;
  }).filter(Boolean))];
  if (!tokens.length) continue;
  withFiles++;
  let content = '';
  try {
    const rows = db.prepare('SELECT content FROM radar_message WHERE tool = ? AND session_id = ?').all(s.tool, s.session_id);
    content = rows.map((r) => r.content).join('\n');
  } catch { /* 单会话失败跳过核对 */ }
  const fabricated = tokens.filter((t) => !content.includes(t));
  if (fabricated.length) suspicious.push({ s, why: `文件未在消息中出现: ${fabricated.join(', ')}` });
}

const total = db.prepare("SELECT count(*) c FROM radar_session WHERE value_score >= 3 AND frozen = 0").get().c;
const stale = db.prepare("SELECT count(*) c FROM radar_session WHERE value_score >= 3 AND frozen = 0 AND summary <> '' AND message_count - summary_msg_count >= 4").get().c;
console.log(`覆盖率: ${sessions.length}/${total} 高价值会话已摘（待摘 ${total - sessions.length}，其中过期需重摘 ${stale}）`);
console.log(`结构完整: ${fmtOk}/${sessions.length}（${(fmtOk / sessions.length * 100).toFixed(0)}%）`);
console.log(`含文件引用: ${withFiles} 条 | 编造嫌疑: ${suspicious.length} 条 | 空泛摘要: ${empties.length} 条\n`);
for (const x of suspicious) console.log(`  可疑 ${x.s.tool}/${String(x.s.session_id).slice(0, 12)} 「${x.s.title}」— ${x.why}`);
for (const e of empties) console.log(`  空泛 ${e.tool}/${String(e.session_id).slice(0, 12)} 「${e.title}」— 四段全无，AI 调用白调`);
if (verbose) {
  console.log('\n最近 5 条摘要样例:');
  for (const s of sessions.slice(0, 5)) console.log(`\n=== ${s.tool}/${String(s.session_id).slice(0, 12)} 「${s.title}」===\n${s.summary}`);
}
