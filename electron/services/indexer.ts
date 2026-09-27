import * as fs from 'fs';
import * as path from 'path';
import * as db from './database';
import * as rag from './rag';
import logger from './logger';

let watchers = new Map();
let running = false;

async function indexSingle(target: any, onProgress?) {
  // 兼容传 dir 字符串：解析为对应笔记库项目；按库索引只清空该库旧索引
  const proj = (target && typeof target === 'object')
    ? target
    : db.project.list('note').find((p: any) => p.dir === target);
  if (!proj || !proj.dir) {
    logger.warn(`[Indexer] skip indexing: note project not found for ${typeof target === 'string' ? target : (proj && proj.name)}`);
    return { totalChunks: 0, files: 0 };
  }
  const dir = proj.dir;
  logger.info(`[Indexer] indexing: ${proj.name} (${dir})`);

  // 清空该库旧索引
  db.project.deleteDocs(proj.id);

  // 扫描文件，写入 kb_documents 和 kb_chunks（纯文本）
  const files: any[] = [];
  const ignoreDirs = proj.ignore_dirs ? proj.ignore_dirs.split(',').map((s: string) => s.trim()) : [];
  const ignoreFiles = proj.ignore_files ? proj.ignore_files.split(',').map((s: string) => s.trim()) : [];
  walkDir(dir, files, ignoreDirs, ignoreFiles);
  const total = files.length;
  for (let i = 0; i < total; i++) {
    const file = files[i];
    if (onProgress) onProgress({ phase: 'scan', current: i + 1, total, file: path.basename(file) });
    const content = fs.readFileSync(file, 'utf-8');
    const stat = fs.statSync(file);
    const title = rag.extractTitle(content) || path.basename(file, '.md');
    const docId = db.project.insertDoc(file, content, stat.mtimeMs, title, proj.id);
    const chunks = rag.chunkText(content);
    for (const chunk of chunks) {
      db.project.insertChunk(docId, chunk, null);
    }
  }
  logger.info(`[Indexer] indexed ${total} files, generating embeddings...`);

  // 为所有新 chunk 生成向量嵌入
  if (onProgress) onProgress({ phase: 'embed', current: 0, total: 0, file: '' });
  const embedded = await rag.indexProjectChunks(db, onProgress);
  logger.info(`[Indexer] done: ${total} files, ${embedded} chunks embedded`);
  return { totalChunks: embedded, files: total };
}

async function indexAll(onProgress?) {
  const noteProjects = db.project.list('note');
  for (const p of noteProjects) {
    try {
      await indexSingle(p, onProgress);
    } catch (e) {
      logger.error(`[Indexer] error indexing ${p.name}:`, e.message);
    }
  }
}

function watchAll() {
  stopWatching();
  const noteProjects = db.project.list('note');
  for (const p of noteProjects) {
    if (!fs.existsSync(p.dir)) continue;
    try {
      const watcher = fs.watch(p.dir, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        logger.info(`[Indexer] change detected: ${filename}`);
        debounceIndex(p.id);
      });
      watchers.set(p.dir, watcher);
    } catch (e) {
      logger.error(`[Indexer] watch error for ${p.name}:`, e.message);
    }
  }
}

const debounceTimers = new Map();
function debounceIndex(projectId) {
  if (debounceTimers.has(projectId)) clearTimeout(debounceTimers.get(projectId));
  debounceTimers.set(projectId, setTimeout(async () => {
    debounceTimers.delete(projectId);
    try {
      await indexSingle(db.project.get(projectId));
    } catch (e) {
      logger.error(`[Indexer] debounce index error:`, e.message);
    }
  }, 10000));
}

function stopWatching() {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}

function start() {
  if (running) return;
  running = true;
  watchAll();
  logger.info('[Indexer] started');
}

function stop() {
  running = false;
  stopWatching();
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  logger.info('[Indexer] stopped');
}

function isRunning() { return running; }

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache']);

function walkDir(dir, files, ignoreDirs: any[] = [], ignoreFiles: any[] = []) {
  if (!fs.existsSync(dir)) return;
  const skipDirs = new Set([...IGNORED_DIRS, ...ignoreDirs.map(d => d.trim()).filter(Boolean)]);
  const skipFilePatterns = ignoreFiles.map(f => f.trim()).filter(Boolean).map(f => new RegExp(f.replace(/\*/g, '.*').replace(/\?/g, '.')));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      walkDir(path.join(dir, entry.name), files, ignoreDirs, ignoreFiles);
    } else if (entry.name.endsWith('.md')) {
      if (skipFilePatterns.some(p => p.test(entry.name))) continue;
      files.push(path.join(dir, entry.name));
    }
  }
}

export { start, stop, isRunning, indexSingle, indexAll, watchAll };
