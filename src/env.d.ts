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
    setDir: (dir: string) => Promise<any>;
    remove: () => Promise<void>;
    scan: (dir: string) => Promise<any>;
    search: (dir: string, query: string) => Promise<any[]>;
    status: () => Promise<any>;
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
    send: (question: string, sessionId?: string, projectDir?: string, kbIds?: string[], images?: any[], agent?: string, modelName?: string) => Promise<void>;
    createSession: (sessionId?: string, projectId?: number, title?: string, mode?: string, agent?: string, source?: string) => Promise<any>;
    getSessions: (projectId?: number) => Promise<any[]>;
    getSessionsBySource: (source: string, projectId?: number) => Promise<any[]>;
    getMessages: (sessionId: string) => Promise<any[]>;
    deleteSession: (sessionId: string) => Promise<void>;
    updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
    updateAgent: (sessionId: string, agent: string) => Promise<void>;
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
    runtimeGet: () => Promise<{ runtime: string; oc?: any }>;
    runtimeSet: (runtime: string) => Promise<{ runtime: string; oc?: any }>;
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
    status: () => Promise<{ feishu: boolean; scheduler: boolean; indexer: boolean }>;
    startFeishu: (config: any) => Promise<boolean>;
    stopFeishu: () => Promise<boolean>;
    startScheduler: () => Promise<boolean>;
    stopScheduler: () => Promise<boolean>;
    startIndexer: () => Promise<boolean>;
    stopIndexer: () => Promise<boolean>;
    indexAll: () => Promise<boolean>;
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
    followup: (taskId: number, question: string) => Promise<boolean>;
    executions: (taskId: number) => Promise<any[]>;
    executionList: (page: number, pageSize: number) => Promise<{ total: number; rows: any[] }>;
    executionGet: (id: number) => Promise<any>;
  };
  llm: {
    test: (opts: { provider?: string; model?: string; apiKey?: string; baseUrl?: string }) => Promise<{ ok: boolean; message: string; response?: string }>;
  };
  embedding: {
    test: (model: string, host: string, apiKey: string) => Promise<any>;
  };
  on: (channel: string, callback: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
