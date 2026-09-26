import { contextBridge, ipcRenderer } from 'electron';

const VALID_CHANNELS = [
  'chat:delta', 'chat:status', 'chat:tool', 'chat:done', 'chat:error',
  'kb:scan-progress', 'service:status', 'service:toggle', 'feishu:message',
  'indexer:progress', 'report:generated', 'aitool:delta', 'task:changed',
  'task:followup:delta', 'task:followup:done', 'task:followup:error',
];

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    firstRun: () => ipcRenderer.invoke('app:firstRun'),
    firstRunDone: () => ipcRenderer.invoke('app:firstRun:done'),
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  },
  notes: {
    tree: (dir: string) => ipcRenderer.invoke('notes:tree', { dir }),
    treeChildren: (dirPath: string) => ipcRenderer.invoke('notes:treeChildren', { dirPath }),
    read: (dir: string, filePath: string) => ipcRenderer.invoke('notes:read', { dir, filePath }),
  },
  log: {
    lines: (options: unknown) => ipcRenderer.invoke('log:lines', options),
    files: () => ipcRenderer.invoke('log:files'),
    readFile: (fileName: string, options: unknown) => ipcRenderer.invoke('log:readFile', { fileName, options }),
    clear: () => ipcRenderer.invoke('log:clear'),
    dir: () => ipcRenderer.invoke('log:dir'),
  },
  feishu: {
    setWebhook: (url: string) => ipcRenderer.invoke('feishu:webhook:set', { url }),
    testWebhook: (url: string) => ipcRenderer.invoke('feishu:webhook:test', { url }),
    send: (message: string) => ipcRenderer.invoke('feishu:send', { message }),
    saveBot: (app_id: string, app_secret: string) => ipcRenderer.invoke('feishu:bot:save', { app_id, app_secret }),
    testBot: (app_id: string, app_secret: string) => ipcRenderer.invoke('feishu:testBot', { app_id, app_secret }),
  },

  kb: {
    getDir: () => ipcRenderer.invoke('kb:getDir'),
    list: () => ipcRenderer.invoke('kb:list'),
    add: (name: string, path: string) => ipcRenderer.invoke('kb:add', { name, path }),
    setDir: (dir: string) => ipcRenderer.invoke('kb:setDir', { dir }),
    remove: () => ipcRenderer.invoke('kb:remove'),
    scan: (dir: string) => ipcRenderer.invoke('kb:scan', { dir }),
    search: (dir: string, query: string) => ipcRenderer.invoke('kb:search', { dir, query }),
    status: () => ipcRenderer.invoke('kb:status'),
    setDefault: () => ipcRenderer.invoke('kb:setDefault'),
    getDefault: () => ipcRenderer.invoke('kb:getDefault'),
  },

  // Module
  dm: {
    list: () => ipcRenderer.invoke('module:list'),
    get: (id: number) => ipcRenderer.invoke('module:get', { id }),
    add: (name: string, description: string, icon: string) => ipcRenderer.invoke('module:add', { name, description, icon }),
    update: (id: number, data: unknown) => ipcRenderer.invoke('module:update', { id, data }),
    remove: (id: number) => ipcRenderer.invoke('module:remove', { id }),
  },

  // Dataset
  ds: {
    list: () => ipcRenderer.invoke('ds:list'),
    get: (id: number) => ipcRenderer.invoke('ds:get', { id }),
    query: (datasetId: number, conditions: string) => ipcRenderer.invoke('ds:query', { datasetId, conditions }),
    add: (params: unknown) => ipcRenderer.invoke('ds:add', params),
    updateMeta: (id: number, data: unknown) => ipcRenderer.invoke('ds:updateMeta', { id, data }),
    insert: (datasetId: number, data: unknown) => ipcRenderer.invoke('ds:insert', { datasetId, data }),
    updateRecord: (id: number, data: unknown) => ipcRenderer.invoke('ds:updateRecord', { id, data }),
    deleteRecord: (id: number) => ipcRenderer.invoke('ds:deleteRecord', { id }),
    remove: (id: number) => ipcRenderer.invoke('ds:remove', { datasetId: id }),
    pendingRecords: () => ipcRenderer.invoke('ds:pendingRecords'),
  },

  // Builtin dataset suites
  suites: {
    list: () => ipcRenderer.invoke('ds:suites:list'),
    apply: (ids: string[]) => ipcRenderer.invoke('ds:suites:apply', { ids }),
  },

  // Backup / Restore
  backup: {
    create: (dir?: string) => ipcRenderer.invoke('backup:create', { dir }),
    list: () => ipcRenderer.invoke('backup:list'),
    restore: (file: string) => ipcRenderer.invoke('backup:restore', { file }),
    prune: (retention: number) => ipcRenderer.invoke('backup:prune', { retention }),
    setAuto: (enabled: boolean) => ipcRenderer.invoke('backup:auto:set', { enabled }),
    autoStatus: () => ipcRenderer.invoke('backup:auto:status'),
    pickFile: () => ipcRenderer.invoke('backup:pickFile'),
    deleteFile: (file: string) => ipcRenderer.invoke('backup:deleteFile', { file }),
    openDir: (dir?: string) => ipcRenderer.invoke('backup:openDir', { dir }),
    setDir: (dir: string) => ipcRenderer.invoke('backup:setDir', { dir }),
    pickDir: () => ipcRenderer.invoke('backup:pickDir'),
  },

  // Chat (general)
  chat: {
    send: (question: string, sessionId: string, projectDir: string, kbIds: number[], images: unknown, agent: string, modelName: string) =>
      ipcRenderer.invoke('chat:send', { question, sessionId, projectDir, kbIds, images, agent, modelName }),
    createSession: (sessionId: string, projectId: number, title: string, mode: string, agent: string, source: string) =>
      ipcRenderer.invoke('chat:session:create', { id: sessionId, projectId, title, mode, source, agent }),
    getSessions: (projectId?: number) => projectId ? ipcRenderer.invoke('chat:session:listByProject', { projectId }) : ipcRenderer.invoke('chat:session:list'),
    getSessionsBySource: (source: string, projectId?: number) => ipcRenderer.invoke('chat:session:listBySource', { source, projectId }),
    getMessages: (sessionId: string) => ipcRenderer.invoke('chat:session:messages', { sessionId }),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('chat:session:delete', { sessionId }),
    updateSessionTitle: (sessionId: string, title: string) => ipcRenderer.invoke('chat:session:updateTitle', { sessionId, title }),
    updateAgent: (sessionId: string, agent: string) => ipcRenderer.invoke('chat:session:updateAgent', { sessionId, agent }),
  },

  // Projects
  project: {
    list: (type?: string) => ipcRenderer.invoke('project:list', { type }),
    get: (id: number) => ipcRenderer.invoke('project:get', { id }),
    add: (name: string, type: string, dir: string, description: string, defaultBranch: string) =>
      ipcRenderer.invoke('project:add', { name, type: type || 'note', dir, description, defaultBranch }),
    update: (id: number, data: unknown) => ipcRenderer.invoke('project:update', { id, data }),
    delete: (id: number) => ipcRenderer.invoke('project:delete', { id }),
  },

  // Agent
  agent: {
    status: () => ipcRenderer.invoke('agent:status'),
  },

  // pi agent 模型
  pi: {
    models: () => ipcRenderer.invoke('pi:models'),
    configGet: () => ipcRenderer.invoke('pi:config:get'),
    configSet: (providers: unknown) => ipcRenderer.invoke('pi:config:set', { providers }),
    configTest: (cfg: { baseUrl: string; apiKey: string; modelName: string }) => ipcRenderer.invoke('pi:config:test', cfg),
  },

  // 网络搜索（多引擎聚合）
  search: {
    configGet: () => ipcRenderer.invoke('search:config:get'),
    configSet: (cfg: { provider: string; apiKey: string }) => ipcRenderer.invoke('search:config:set', cfg),
    test: () => ipcRenderer.invoke('search:test'),
  },

  // Service Management
  service: {
    status: () => ipcRenderer.invoke('service:status'),
    startFeishu: (config: unknown) => ipcRenderer.invoke('service:startFeishu', config),
    stopFeishu: () => ipcRenderer.invoke('service:stopFeishu'),
    startScheduler: () => ipcRenderer.invoke('service:startScheduler'),
    stopScheduler: () => ipcRenderer.invoke('service:stopScheduler'),
    reloadScheduler: () => ipcRenderer.invoke('service:reloadScheduler'),
    startIndexer: () => ipcRenderer.invoke('service:startIndexer'),
    stopIndexer: () => ipcRenderer.invoke('service:stopIndexer'),
    indexAll: () => ipcRenderer.invoke('service:indexAll'),
  },

  // Reminders
  reminder: {
    list: () => ipcRenderer.invoke('reminder:list'),
    add: (data: unknown) => ipcRenderer.invoke('reminder:add', data),
    update: (id: number, data: unknown) => ipcRenderer.invoke('reminder:update', id, data),
    remove: (id: number) => ipcRenderer.invoke('reminder:remove', id),
    setEnabled: (id: number, enabled: boolean) => ipcRenderer.invoke('reminder:setEnabled', id, enabled),
    test: (id: string) => ipcRenderer.invoke('reminder:test', id),
  },

  // Todos
  todo: {
    list: () => ipcRenderer.invoke('todo:list'),
    add: (data: unknown) => ipcRenderer.invoke('todo:add', data),
    update: (id: number, data: unknown) => ipcRenderer.invoke('todo:update', id, data),
    remove: (id: number) => ipcRenderer.invoke('todo:remove', id),
  },

  // AI 自执行任务
  task: {
    list: () => ipcRenderer.invoke('task:list'),
    add: (data: unknown) => ipcRenderer.invoke('task:add', data),
    update: (id: number, data: unknown) => ipcRenderer.invoke('task:update', id, data),
    remove: (id: number) => ipcRenderer.invoke('task:remove', id),
    execute: (id: number) => ipcRenderer.invoke('task:execute', id),
    followup: (taskId: number, question: string) => ipcRenderer.invoke('task:followup', { taskId, question }),
    executions: (taskId: number) => ipcRenderer.invoke('task:executions', taskId),
    executionList: (page: number, pageSize: number) => ipcRenderer.invoke('task:execution:list', page, pageSize),
    executionGet: (id: number) => ipcRenderer.invoke('task:execution:get', id),
  },

  // Insights
  insights: {
    stats: () => ipcRenderer.invoke('insights:stats'),
    reports: () => ipcRenderer.invoke('insights:reports'),
    weeklyReports: () => ipcRenderer.invoke('insights:weeklyReports'),
    indexerInfo: () => ipcRenderer.invoke('insights:indexerInfo'),
    libraryStats: () => ipcRenderer.invoke('insights:libraryStats'),
    clearIndex: () => ipcRenderer.invoke('insights:clearIndex'),
    reportGenerating: () => ipcRenderer.invoke('insights:reportGenerating'),
  },

  // Archive
  archive: {
    report: (moduleId: string) => ipcRenderer.invoke('archive:report', { moduleId }),
    moduleAnalysis: (moduleId: string, force?: boolean) => ipcRenderer.invoke('archive:moduleAnalysis', { moduleId, force }),
    moduleAnalysisLatest: (moduleId: string) => ipcRenderer.invoke('archive:moduleAnalysisLatest', { moduleId }),
    moduleAnalysisList: (moduleId: string) => ipcRenderer.invoke('archive:moduleAnalysisList', { moduleId }),
    saveAnalysisToNotes: (moduleId: string, analysisId: number) => ipcRenderer.invoke('archive:saveAnalysisToNotes', { moduleId, analysisId }),
    moduleOverview: (moduleId: string) => ipcRenderer.invoke('archive:moduleOverview', { moduleId }),
  },

  // AI 工具箱
  aitool: {
    generate: (tool: string, prompt: string, sessionId: string, name?: string, params?: string) =>
      ipcRenderer.invoke('aitool:generate', { tool, prompt, sessionId, name, params }),
    exportPptx: (md: string, defaultName: string) =>
      ipcRenderer.invoke('aitool:exportPptx', { md, defaultName }),
    exportHtml: (md: string, defaultName: string) =>
      ipcRenderer.invoke('aitool:exportHtml', { md, defaultName }),
    exportMindmap: (md: string, defaultName: string) =>
      ipcRenderer.invoke('aitool:exportMindmap', { md, defaultName }),
    exportText: (text: string, defaultName: string, ext?: string) =>
      ipcRenderer.invoke('aitool:exportText', { text, defaultName, ext }),
    fetch: (url: string) => ipcRenderer.invoke('aitool:fetch', { url }),
    imageGenerate: (prompt: string, width: number, height: number, name?: string) =>
      ipcRenderer.invoke('aitool:image:generate', { prompt, width, height, name }),
    imageSave: (b64: string, mimeType: string, defaultName: string) =>
      ipcRenderer.invoke('aitool:image:save', { b64, mimeType, defaultName }),
    imageConfig: () => ipcRenderer.invoke('aitool:image:config'),
    imageSetConfig: (baseUrl: string, apiKey: string, model: string) =>
      ipcRenderer.invoke('aitool:image:setConfig', { baseUrl, apiKey, model }),
    historyList: (tool?: string) => ipcRenderer.invoke('aitool:history:list', { tool }),
    historyGet: (id: number) => ipcRenderer.invoke('aitool:history:get', { id }),
    historyRemove: (id: number) => ipcRenderer.invoke('aitool:history:remove', { id }),
    historyClear: (tool?: string) => ipcRenderer.invoke('aitool:history:clear', { tool }),
    historyImage: (filePath: string) => ipcRenderer.invoke('aitool:history:image', { filePath }),
  },

  // Config
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (cfg: unknown) => ipcRenderer.invoke('config:set', cfg),
  },

  // Embedding Model
  embedding: {
    test: (model: string, host: string, apiKey: string) => ipcRenderer.invoke("embedding:test", { model, host, apiKey }),
  },

  // Event listeners (streaming)
  on: (channel: string, callback: (...args: any[]) => void) => {
    if (VALID_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
