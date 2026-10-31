/// <reference types="vite/client" />

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface ElectronAPI {
  platform: string;
  app: {
    version: () => Promise<string>;
    firstRun: () => Promise<{ firstRun: boolean }>;
    firstRunDone: () => Promise<boolean>;
    /** 用系统默认浏览器打开外部链接（仅 http/https） */
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  };
  dialog: {
    openDirectory: () => Promise<string | null>;
  };
  notes: {
    tree: (dir: string) => Promise<TreeNode[]>;
    treeChildren: (dirPath: string) => Promise<TreeNode[]>;
    read: (dir: string, filePath: string) => Promise<{ ok: boolean; content?: string; error?: string; filePath?: string }>;
  };
  log: {
    lines: (options?: { count?: number; tail?: boolean }) => Promise<string[]>;
    files: () => Promise<{ name: string; size: number; mtime: string }[]>;
    readFile: (fileName: string, options?: { count?: number; tail?: boolean }) => Promise<string[]>;
    dir: () => Promise<string>;
  };
  feishu: {
    setWebhook: (url: string) => Promise<{ ok: boolean }>;
    testWebhook: (url: string) => Promise<{ ok: boolean; error?: string }>;
    send: (message: string) => Promise<{ ok: boolean; error?: string }>;
    testBot: (appId: string, appSecret: string) => Promise<{ ok: boolean; botName?: string; error?: string }>;
  };
  kb: {
    getDir: () => Promise<string>;
    list: () => Promise<any[]>;
    add: (name: string, path: string) => Promise<any>;
    update: (id: number, data: { name?: string; dir?: string }) => Promise<any>;
    setDir: (dir: string) => Promise<any>;
    remove: (id: number) => Promise<any>;
    search: (dir: string, query: string) => Promise<any[]>;
    setDefault: (id: number) => Promise<any>;
    getDefault: () => Promise<any>;
  };
  ds: {
    list: () => Promise<any[]>;
    query: (datasetId: string, conditions?: string) => Promise<any[]>;
    add: (name: string, schemaJson: string) => Promise<any>;
    insert: (datasetId: string, data: any) => Promise<void>;
    update: (id: number, data: any) => Promise<void>;
    delete: (id: number) => Promise<void>;
    remove: (datasetId: string) => Promise<void>;
  };
  chat: {
    send: (question: string, sessionId?: string, projectDir?: string, images?: any[], agent?: string, modelName?: string) => Promise<void>;
    createSession: (sessionId?: string, projectId?: number, title?: string, mode?: string, agent?: string, source?: string) => Promise<any>;
    getSessions: (projectId?: number) => Promise<any[]>;
    getSessionsBySource: (source: string, projectId?: number) => Promise<any[]>;
    getMessages: (sessionId: string) => Promise<any[]>;
    deleteSession: (sessionId: string) => Promise<void>;
    updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
    updateAgent: (sessionId: string, agent: string) => Promise<void>;
    updateProject: (sessionId: string, projectId: number | null) => Promise<{ ok: boolean; error?: string }>;
  };
  relay: {
    status: () => Promise<{ connected: boolean; error: string; device: any }>;
    probe: (url: string) => Promise<{ ok: boolean; error?: string; devicesOnline?: number }>;
    setUrl: (url: string) => Promise<{ ok: boolean; device?: any; connected?: boolean; error?: string }>;
    enable: (password: string, url?: string) => Promise<{ ok: boolean; device?: any; connected?: boolean; error?: string }>;
    disable: () => Promise<{ ok: boolean; device?: any; error?: string }>;
    clients: () => Promise<{ ok: boolean; clients: any[]; error?: string }>;
    kick: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  };
  project: {
    list: (type?: string) => Promise<any[]>;
    get: (id: number) => Promise<any>;
    add: (name: string, type?: string, dir?: string, description?: string, defaultBranch?: string) => Promise<any>;
    update: (id: number, data: any) => Promise<void>;
    delete: (id: number) => Promise<void>;
  };
  agent: {
    status: () => Promise<{ pi: any; langchain?: any }>;
    versions: () => Promise<{
      pi: { sdk: string | null; installed: string | null };
    }>;
  };
  pi: {
    models: () => Promise<{
      models: { provider: string; providerLabel: string; id: string; name: string; pattern: string; configured: boolean }[];
      error?: string;
    }>;
    configGet: () => Promise<{ providers: { name: string; displayName: string; baseUrl: string; apiKey: string; models: { id: string; name?: string }[] }[] }>;
    configSet: (providers: { name: string; displayName?: string; baseUrl: string; apiKey: string; modelNames: string[] }[]) => Promise<{ ok: boolean; error?: string }>;
    configTest: (cfg: { baseUrl: string; apiKey: string; modelName: string }) => Promise<{ ok: boolean; error?: string; latencyMs?: number }>;
  };
  service: {
    status: () => Promise<{ feishu: boolean; scheduler: boolean }>;
    startFeishu: (config: any) => Promise<boolean>;
    stopFeishu: () => Promise<boolean>;
    startScheduler: () => Promise<boolean>;
    stopScheduler: () => Promise<boolean>;
  };
  config: {
    get: () => Promise<any>;
    set: (config: any) => Promise<boolean>;
  };
  archive: {
    report: (moduleId: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  };
  todo: {
    list: () => Promise<any[]>;
    add: (data: any) => Promise<{ id: number }>;
    update: (id: number, data: any) => Promise<void>;
    remove: (id: number) => Promise<void>;
  };
  noteDigest: {
    extract: () => Promise<{ todos: any[]; followups: any[]; logs: any[]; scannedFiles: number; generated_at: string }>;
    syncDone: () => Promise<{ touched: number }>;
  };
  reminder: {
    list: () => Promise<any[]>;
    add: (data: any) => Promise<{ id: string }>;
    update: (id: string, data: any) => Promise<void>;
    remove: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    test: (id: string) => Promise<boolean>;
  };
  task: {
    list: () => Promise<any[]>;
    add: (data: any) => Promise<{ id: number }>;
    update: (id: number, data: any) => Promise<void>;
    remove: (id: number) => Promise<void>;
    execute: (id: number) => Promise<boolean>;
    executions: (taskId: number) => Promise<any[]>;
    executionList: (page: number, pageSize: number) => Promise<{ total: number; rows: any[] }>;
    executionGet: (id: number) => Promise<any>;
  };
  llm: {
    test: (opts: { provider?: string; model?: string; apiKey?: string; baseUrl?: string }) => Promise<{ ok: boolean; message: string; response?: string }>;
  };
  insights: {
    stats: () => Promise<{
      fileCount: number; notesFileCount: number; todayModified: number;
      projectCount: number; totalChats: number; todoPending: number; todoOverdue: number;
      remindersActive: number; todayDataRecords: number;
    }>;
    reports: () => Promise<any[]>;
    weeklyReports: () => Promise<any[]>;
    reportGenerating: () => Promise<{ generating: boolean }>;
    subProjects: () => Promise<Array<{ name: string; fileCount: number; totalSize: number; files: string[]; analysis?: string; hasAnalysis: boolean }>>;
    tags: () => Promise<Array<{ name: string; count: number }>>;
    heatmap: () => Promise<Record<string, number>>;
    /** 实时扫盘得到的每项目文件统计（原先读索引表） */
    libraryStats: () => Promise<Array<{ projectId: number; name: string; isDefault: boolean; docCount: number; todayModified: number }>>;
  };
  on: (channel: string, callback: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
