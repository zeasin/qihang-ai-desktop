/**
 * AI 引擎版本检测
 *
 * - sdk：应用内实际安装的 SDK 版本（开发与打包均从 app 根目录 node_modules 读取）
 * - installed：本机全局安装的 CLI 版本（pi / opencode），未安装为 null
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { ocBinaryPath, ocInstalledVersion, isOcAvailable, resetOcAvailability } from './opencode-process';

function readPkgVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

let globalRootCache: string | null | undefined;

function globalNpmRoot(): string | null {
  if (globalRootCache !== undefined) return globalRootCache;
  try {
    globalRootCache = execSync('npm root -g', { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim() || null;
  } catch {
    globalRootCache = null;
  }
  return globalRootCache;
}

export function agentVersions() {
  const appRoot = app.getAppPath();
  const root = globalNpmRoot();
  resetOcAvailability();
  const ocAvailable = isOcAvailable();
  return {
    pi: {
      sdk: readPkgVersion(path.join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')),
      installed: root ? readPkgVersion(path.join(root, '@earendil-works', 'pi-coding-agent')) : null,
    },
    opencode: {
      sdk: readPkgVersion(path.join(appRoot, 'node_modules', '@opencode-ai', 'sdk')),
      installed: ocAvailable ? ocInstalledVersion() : null,
      available: ocAvailable,
      bin: ocBinaryPath(),
    },
  };
}
