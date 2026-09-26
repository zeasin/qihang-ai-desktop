# 贡献指南

欢迎为 启航AI工作台 贡献代码！本指南帮你快速上手。

## 开发环境

- Node.js 18+
- Git
- 可选：Ollama（本地嵌入模型）

## 常用命令

```bash
npm install             # 安装依赖
npm run dev             # 仅启动 Vite 前端开发服务器
npm run compile:electron  # 编译 Electron 主进程（TS → dist-electron）
npm run electron:dev    # 编译主进程 + 前端 + 启动应用（开发模式）
npm run build           # 仅构建前端产物
npm run electron:build  # 完整打包（前端 + 主进程 + electron-builder）
```

## 代码约定

- **主进程**（`electron/`）：TypeScript，CommonJS 模块（`tsconfig.electron.json`）。注意不要引入 ESM-only 的依赖（或参考 `pi-agent.ts`/`tools.ts` 用动态 `import()` 的方式）。
- **渲染进程**（`src/`）：Vue 3 + Vite。
- 不添加与功能无关的注释；必要的注释用中文。
- 提交前运行 `npm run compile:electron` 和 `npm run build` 确认无编译错误。

## 提交 PR 前的检查清单

- [ ] 改动通过 `npm run compile:electron` 与 `npm run build`
- [ ] 未引入新的敏感信息（API Key、个人路径等）
- [ ] 新功能在 README 中有对应说明（如有需要）
- [ ] 涉及飞书/定时任务的改动尽量补冒烟验证（参考 `dist-electron/electron/services/` 下模块的可测试性）

## 新增依赖的注意点

- Electron 主进程是 CommonJS。添加依赖前先确认该包是否为 ESM-only；若是，参考现有 `pi-agent.ts` 中 `new Function('spec','return import(spec)')` 的写法。
- 原生模块（如 better-sqlite3）需要 electron-rebuild，安装后请验证 `npm run electron:dev` 能正常启动。

## 分支与提交

- 直接向 `main` 提 PR 即可。
- 提交信息建议用一句简明中文概括，如 `feat: 支持飞书任务指令`、`fix: 修复定时任务重复触发`。

## 协议

本项目以 MIT 协议开源，见 [LICENSE](../LICENSE)。
