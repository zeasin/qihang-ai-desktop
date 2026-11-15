// 临时排查脚本：查看某个 opencode 会话在库里的消息序列（验证「接着问」是否落在原会话）
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os");
const path = require("node:path");

const sid = process.argv[2] || "";
if (!sid) {
  console.error("usage: node eval/oc-session-dump.cjs <sessionId>");
  process.exit(1);
}

const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("SELECT seq, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC")
  .all(sid);
for (const r of rows) {
  let d = {};
  try { d = JSON.parse(r.data); } catch {}
  const text =
    d.text ||
    (Array.isArray(d.content)
      ? d.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" | ")
      : "");
  console.log(r.seq, r.type, new Date(Number(r.time_created)).toISOString(), String(text).slice(0, 160));
}
db.close();
