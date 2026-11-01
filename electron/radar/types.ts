/** 雷达共享类型。tool 枚举：qoder/zcode/trae/dsh/claude-code/opencode/codex/pi */

export interface SessionInfo {
  id: string;
  label?: string;
  /** 源存储定位（sqlite 会话 id / jsonl 文件路径） */
  file: string;
  messageCount: number;
  createdAt: string;
  /** 源库里的最后更新时间（ISO）——增量检测依据 */
  updatedAt?: string;
  projectDir?: string;
  /** 工具侧已归档 */
  archived?: boolean;
}

export interface SerializedMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: { name: string; args?: string; result?: string; status?: string }[];
  timestamp: number;
}

/**
 * 一个工具一个 collector：全量列举 + 拉取会话消息 + 轻探针。
 * probe 只回答"哪些会话刚动了"（id → 最近活动毫秒），绝不解析消息内容——
 * 这是实时监控通道的成本保障（毫秒级、每 3s 一次），消息解析全部留给同步轮。
 */
export interface HubCollector {
  readonly tool: string;
  listAll(): Promise<SessionInfo[]>;
  loadMessages(s: SessionInfo): Promise<SerializedMessage[]>;
  probe(): Promise<Map<string, number>>;
  dispose(): Promise<void>;
}
