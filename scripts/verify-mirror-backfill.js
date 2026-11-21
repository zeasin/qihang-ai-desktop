/**
 * 镜像列回填 SQL 的探针验证（跑在内存 SQLite 上，不碰真实库）。
 * 验证点：
 *   1. 中文键（类型/状态/来源）能回填；
 *   2. 英文键（type/status/source）兜底生效；
 *   3. WHERE 只补空值，重复跑幂等（第二次 changes = 0）。
 */
const path = require('path');
const projectRoot = path.resolve(__dirname, '..');
const Database = require(path.join(projectRoot, 'node_modules', 'better-sqlite3'));

const db = new Database(':memory:');
db.exec(`CREATE TABLE data_center_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT, dataset_id TEXT, data_json TEXT,
  source TEXT, content_hash TEXT, record_num TEXT, record_type TEXT, record_status TEXT,
  created_at TEXT, updated_at TEXT)`);
db.exec(`INSERT INTO data_center_records (dataset_id, data_json) VALUES ('1', JSON_OBJECT('标题','测试工单','类型','需求','来源','微信','状态','处理中'))`);
db.exec(`INSERT INTO data_center_records (dataset_id, data_json) VALUES ('1', JSON_OBJECT('title','english keys','type','bug','status','open','source','email'))`);
db.exec(`INSERT INTO data_center_records (dataset_id, data_json) VALUES ('1', JSON_OBJECT('标题','无类型来源','状态','已完成'))`);

const before = db.prepare('SELECT id, record_type, record_status, source FROM data_center_records').all();
console.log('BEFORE:', JSON.stringify(before, null, 0));

const SQL = `UPDATE data_center_records SET
  record_type   = COALESCE(json_extract(data_json, '$."类型"'), json_extract(data_json, '$.type')),
  record_status = COALESCE(json_extract(data_json, '$."状态"'), json_extract(data_json, '$.status')),
  source        = COALESCE(json_extract(data_json, '$."来源"'), json_extract(data_json, '$.source'))
WHERE ((record_type IS NULL OR record_type = '')
        AND (json_extract(data_json, '$."类型"') IS NOT NULL OR json_extract(data_json, '$.type') IS NOT NULL))
   OR ((record_status IS NULL OR record_status = '')
        AND (json_extract(data_json, '$."状态"') IS NOT NULL OR json_extract(data_json, '$.status') IS NOT NULL))
   OR ((source IS NULL OR source = '')
        AND (json_extract(data_json, '$."来源"') IS NOT NULL OR json_extract(data_json, '$.source') IS NOT NULL))`;

const r1 = db.prepare(SQL).run();
console.log('RUN1 changes:', r1.changes);
const r2 = db.prepare(SQL).run();
console.log('RUN2 changes (expect 0):', r2.changes);

const after = db.prepare('SELECT id, record_type, record_status, source FROM data_center_records').all();
console.log('AFTER:', JSON.stringify(after, null, 0));
db.close();
