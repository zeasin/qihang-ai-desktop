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

/** 探针信号：会话心跳 + 可选的精确运行状态 */
export interface ProbeSignal {
  /** 最近活动毫秒（源库最近一次写入） */
  ts: number;
  /**
   * 精确运行状态（源工具自己维护的回合状态机，如 ZCode 的 turn_usage）：
   * true=回合进行中；false=回合已结束（含完成/出错/被打断）；缺省=无精确信号，退回时间窗口推断。
   * 实报 true 的 collector 必须保证僵死回合（崩溃没写结束状态）会在有限时间内翻转为 false。
   */
  running?: boolean;
}

/**
 * 一个工具一个 collector：全量列举 + 拉取会话消息 + 轻探针。
 * probe 只读元数据（mtime/回合状态等），绝不解析消息正文——
 * 这是实时监控通道的成本保障（毫秒级、每 3s 一次），消息解析全部留给同步轮。
 */
export interface HubCollector {
  readonly tool: string;
  listAll(): Promise<SessionInfo[]>;
  loadMessages(s: SessionInfo): Promise<SerializedMessage[]>;
  probe(): Promise<Map<string, ProbeSignal>>;
  dispose(): Promise<void>;
}
