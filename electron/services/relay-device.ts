/**
 * 移动端连接的设备身份与配对凭证
 *
 * 与数据库、日志同目录（~/.qihang-ai-desktop），不写 config.json：
 * 连接密码是移动端配对的唯一凭证，单独存放便于备份时排除、也避免随配置导入导出外泄。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

const DEVICE_PATH = path.join(os.homedir(), '.qihang-ai-desktop', 'relay-device.json');

export interface RelayDeviceInfo {
  deviceId: string;
  token: string;
  relayUrl: string;
  name: string;
  /** 允许移动端连接开关；只有经「设置密码」流程通过才会写入 true，存量缺字段按关闭处理 */
  remoteEnabled?: boolean;
  /** 本机连接密码（移动端凭它配对），仅存本机与中继 */
  password?: string;
}

export function hostName(): string {
  return os.hostname() || '未命名设备';
}

/**
 * 中继地址归一化：只接受 origin（scheme://host[:port]），去掉尾部斜杠。
 * 带路径（如误填 /relay）判为不合法：三端约定由代码自己拼 /relay/...
 */
export function normalizeRelayUrl(raw: string): string | null {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return null;
  return /^https?:\/\/[^/\s:?#]+(:\d{1,5})?$/i.test(value) ? value : null;
}

let cache: RelayDeviceInfo | null = null;

function read(): RelayDeviceInfo | null {
  if (cache) return cache;
  try {
    if (!fs.existsSync(DEVICE_PATH)) return null;
    cache = JSON.parse(fs.readFileSync(DEVICE_PATH, 'utf-8')) as RelayDeviceInfo;
    return cache;
  } catch {
    return null;
  }
}

function write(info: RelayDeviceInfo): RelayDeviceInfo {
  cache = info;
  try {
    const dir = path.dirname(DEVICE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEVICE_PATH, JSON.stringify(info, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn('[RELAY-STORE] save failed:', e && e.message ? e.message : e);
  }
  return info;
}

function blank(relayUrl: string, name?: string): RelayDeviceInfo {
  return {
    deviceId: randomUUID().replace(/-/g, ''),
    token: randomUUID().replace(/-/g, ''),
    relayUrl,
    name: name || hostName(),
  };
}

/** 取设备信息；不存在则当场生成（deviceId/token 一经生成不再变化） */
export function getOrCreate(relayUrl: string): RelayDeviceInfo {
  const existing = read();
  if (existing) {
    if (!existing.relayUrl && relayUrl) write({ ...existing, relayUrl });
    return existing;
  }
  return write(blank(relayUrl));
}

export function load(): RelayDeviceInfo | null {
  return read();
}

/** 合并写入本机字段（开关、连接密码、中继地址） */
export function patch(partial: Partial<RelayDeviceInfo>): RelayDeviceInfo {
  const current = read() || blank(String(partial.relayUrl || ''));
  return write({ ...current, ...partial });
}

/** 回环用的本机设备视图：去掉明文密码，只告诉渲染层有没有设过 */
export type RelayDeviceInfoView = Omit<RelayDeviceInfo, 'password'> & { hasPassword: boolean };

export function toView(info: RelayDeviceInfo): RelayDeviceInfoView {
  const { password, ...rest } = info;
  return { ...rest, hasPassword: !!password };
}
