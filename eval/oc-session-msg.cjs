// 临时排查脚本：打印某会话最后一条 assistant 消息的完整数据（含错误信息）
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os");
const path = require("node:path");

const sid = process.argv[2] || "";
const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("SELECT seq, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 3")
  .all(sid);
for (const r of rows) {
  console.log("=====", r.seq, r.type, new Date(Number(r.time_created)).toISOString());
  try {
    console.log(JSON.stringify(JSON.parse(r.data)).slice(0, 2500));
  } catch {
    console.log(String(r.data).slice(0, 2500));
  }
}
db.close();
