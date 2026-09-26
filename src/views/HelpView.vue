<template>
  <div class="help-view">
    <div class="content-header">
      <h1 class="content-title">帮助中心</h1>
    </div>

    <div class="content-body">
      <div style="margin-bottom:24px;">
        <h2 style="font-size:22px;font-weight:600;margin-bottom:4px;">帮助中心</h2>
        <p class="text-muted">启航AI工作台 — 功能指南与常见问题</p>
        <span class="version-badge" v-if="appVersion">v{{ appVersion }}</span>
      </div>

      <div class="card card-index">
        <h2 style="font-size:17px;">📑 快速索引</h2>
        <p class="text-muted mb-2">点击跳转到对应章节：</p>
        <div class="index-grid">
          <button v-for="s in sections" :key="s.id" class="index-item" @click="scrollToSection(s.id)">
            <span class="index-icon">{{ s.icon }}</span>
            <span>{{ s.label }}</span>
          </button>
        </div>
      </div>

      <div class="card" id="sec-core">
        <h2 style="font-size:17px;">✨ 核心卖点：一条完整的自动化链路</h2>
        <p class="text-muted mb-2">启航AI工作台不是"对话框 + 一堆孤立功能"，而是一套完整的自动化流程：</p>
        <div style="text-align:center;padding:12px 0;font-size:14px;font-weight:600;color:var(--primary);">
          采集 → 分析 → 建议 → 执行 → 推送
        </div>
        <ol style="margin:8px 0;padding-left:20px;font-size:13px;line-height:1.8;">
          <li><strong>采集</strong>：Markdown 笔记随手记，JSON 数据批量导入，自动归档进本地笔记库</li>
          <li><strong>分析</strong>：AI 基于你的笔记、数据和项目管理回答提问、查数据集、读文件，而不是凭空瞎编</li>
          <li><strong>建议</strong>：AI 不只是回答问题，还给出可执行的建议——该做的事、该记的档、该跟进的事项</li>
          <li><strong>执行</strong>：对话落成定时任务和数据集记录，AI 还能读写笔记文件、操作本地数据</li>
          <li><strong>推送</strong>：定时提醒、每日 AI 日报自动汇总，通过飞书推送到你的群和联系人</li>
        </ol>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;">
          <div style="flex:1;min-width:140px;padding:10px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;font-size:12px;line-height:1.5;">
            <strong style="color:#16a34a;">🔒 数据安全</strong><br>
            <span class="text-muted">笔记、对话、待办、数据全部存在本机，不上传云端</span>
          </div>
          <div style="flex:1;min-width:140px;padding:10px;background:#f0f7ff;border-radius:8px;border:1px solid #b3d4f7;font-size:12px;line-height:1.5;">
            <strong style="color:#2563eb;">🧠 模型自由</strong><br>
            <span class="text-muted">DeepSeek、OpenAI 兼容、Ollama 本地模型，配置多个随时切换</span>
          </div>
          <div style="flex:1;min-width:140px;padding:10px;background:#fefce8;border-radius:8px;border:1px solid #fde68a;font-size:12px;line-height:1.5;">
            <strong style="color:#d97706;">🚀 持续进化</strong><br>
            <span class="text-muted">超过能力自动升级，无需手动安装任何终端工具</span>
          </div>
        </div>
      </div>

      <div class="card card-prereq" id="sec-prereq">
        <h2 style="font-size:17px;">📋 使用前必读：两个前置条件</h2>
        <p class="text-muted mb-2">应用启动后，需要完成以下两项配置。其中笔记库是 AI 功能的前置条件：未配置时，AI 对话、任务执行、日报生成、知识库浏览会被门禁拦截并提示；数据集、提醒、日志不受影响。</p>

        <div class="prereq-item">
          <div class="prereq-number">1</div>
          <div class="prereq-content">
            <strong>配置 AI 对话大模型</strong>
            <p class="text-muted">所有 AI 对话、工具调用、日报生成都由大模型驱动。进入「设置 → 💬 对话模型配置」，填写接入点信息（接入名称、服务地址、API Key、模型名称），支持 OpenAI 兼容接口（如 DeepSeek、Ollama、LM Studio 等），可配置多个接入，每个接入可包含多个模型。改动自动保存并立即生效，点「测试」可验证连接是否正常。</p>
          </div>
        </div>

        <div class="prereq-item">
          <div class="prereq-number">2</div>
          <div class="prereq-content">
            <strong>设置笔记库目录</strong>
            <p class="text-muted">进入「设置 → 📚 笔记库设置」，选择一个包含 Markdown 文件的本地文件夹作为笔记库。保存后即可在「概览」页点击「📚 笔记库」卡片浏览文件，并让 AI 基于你的笔记回答问题、自动保存任务执行结果。未配置时，AI 相关入口会提示先配置笔记库。</p>
          </div>
        </div>
      </div>

      <div class="card" id="sec-quickstart">
        <h2>🚀 快速开始</h2>
        <p class="text-muted mb-2">启航AI工作台是一款桌面应用，将本地笔记知识库、结构化数据、任务提醒、飞书推送和 AI 智能体整合成一套完整的工作流。所有数据保存在本机，模型自由选择。</p>
        <ol style="margin:8px 0;padding-left:20px;font-size:13px;line-height:1.8;">
          <li>完成上方两个前置条件配置</li>
          <li>在「对话」页开始与 AI 对话（支持图片粘贴/上传、切换模型），在「概览」页查看综合看板</li>
          <li>在「任务」页创建定时/循环任务，让 AI 定期自动执行（也可交由飞书 Bot 下发指令）</li>
          <li>在「数据」页管理结构化数据集，支持内置模板一键安装、JSON/URL 批量导入</li>
          <li>在「工具箱」页使用演示生成、周报日报、思维导图、抓取等 AI 工具</li>
          <li>在「设置」页配置飞书集成、日报、云端数据库、数据备份等高级功能</li>
        </ol>
      </div>

      <div class="card" id="sec-nav">
        <h2>🧭 页面导航</h2>
        <table class="help-table">
          <thead><tr><th>菜单</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📊 概览</td><td>综合看板：统计卡片（笔记库、待办、提醒、对话、今日数据）、综合日报、待办列表、提醒列表、待处理记录；点击「笔记库」卡片进入知识库浏览</td></tr>
          <tr><td>💬 对话</td><td>对话工作台，支持多轮对话、图片识别、模型切换；可查询数据集、检索笔记库、联网搜索</td></tr>
          <tr><td>📋 任务</td><td>任务中心，管理挂在笔记库下的定时/循环任务，支持立即执行、指定时间、周期循环</td></tr>
          <tr><td>🗃️ 数据</td><td>多数据集管理，自定义 Schema，内置模板、AI 业务分析、JSON/URL 批量导入</td></tr>
          <tr><td>🔔 提醒</td><td>定时提醒统一管理，支持每日/每周/每月/每年/一次性，系统通知 + 飞书推送</td></tr>
          <tr><td>🔧 工具箱（beta）</td><td>AI 内容生成工具集：演示、周报/日报、思维导图、文案、网站抓取、图片生成</td></tr>
          <tr><td>⚙️ 设置</td><td>系统配置：笔记库、对话模型、飞书、云端数据库、数据备份、日报等</td></tr>
          <tr><td>📋 日志</td><td>操作日志查看，支持级别过滤、文件切换、自动刷新</td></tr>
          <tr><td>❓ 帮助</td><td>使用指南（当前页面）</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-chat">
        <h2>💬 AI 对话</h2>
        <p class="text-muted mb-2">本地 AI 助理，支持多轮对话、图片上传/粘贴、图片理解、模型切换（切换当前接入下的不同模型）。</p>
        <table class="help-table">
          <thead><tr><th>能力</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>💬 日常问答</td><td>通用对话，无需绑定项目即可提问</td></tr>
          <tr><td>📚 笔记库检索</td><td>配置笔记库目录后，AI 自动携带笔记上下文回答</td></tr>
          <tr><td>💾 数据集操作</td><td>查询数据集记录，AI 可帮你新建、插入、更新数据</td></tr>
          <tr><td>📁 笔记读写</td><td>在笔记库目录中浏览、新建、编辑 Markdown 文件</td></tr>
          <tr><td>🌐 联网搜索</td><td>网页搜索与抓取，实时信息补充回答</td></tr>
          <tr><td>🖼️ 图片识别</td><td>支持粘贴或上传图片，AI 自动识别内容</td></tr>
          </tbody>
        </table>
        <p class="text-muted" style="margin-top:8px;">对话模型在「设置 → 💬 对话模型配置」中增减配置，维护多条接入后可在输入框上方切换模型。</p>
      </div>

      <div class="card" id="sec-kb">
        <h2>📚 知识库与概览</h2>
        <p class="text-muted mb-2">「概览」为左侧栏独立菜单；知识库从概览页的「📚 笔记库」卡片进入。</p>
        <ul>
          <li><strong>📚 知识库</strong> — 左侧目录树浏览笔记库文件，右侧预览 Markdown 渲染内容，支持文件名关键词搜索，也可让 AI 基于它们回答问题</li>
          <li><strong>📊 概览</strong> — 综合看板：统计卡片（笔记库、待办、提醒、对话、今日数据）、综合日报、待办列表、提醒列表、待处理记录；未配置笔记库时「综合日报」区域会提示先配置</li>
        </ul>
      </div>

      <div class="card" id="sec-tasks">
        <h2>📋 任务中心</h2>
        <p class="text-muted mb-2">任务中心在左侧栏「任务」页，管理挂在笔记库下的任务：</p>
        <table class="help-table">
          <thead><tr><th>能力</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📚 笔记任务</td><td>挂在「笔记库」项目下的任务：让 AI 定时读书、写周报、汇总文档，结果自动保存到笔记库目录，可推送到飞书</td></tr>
          </tbody>
        </table>
        <p class="text-muted" style="margin-top:8px;">任务触发方式支持：⚡ 立即执行 / ⏰ 指定时间 / 🔁 定时循环（每天/每周/每月/Cron）。任务详情可全屏查看，支持「对话记录」「执行记录」回放与「追问」续跑。任务完成后结果保存在笔记库指定相对路径。</p>
      </div>

      <div class="card" id="sec-data">
        <h2>🗃️ 数据</h2>
        <p class="text-muted mb-2">模块化数据集管理，支持内置行业模板、自定义字段和批量导入。</p>
        <ul>
          <li><strong>内置模板</strong> — 一键安装「内置套件」，快速体验预置数据集与示例数据</li>
          <li><strong>模块管理</strong> — 按模块分组组织数据集，可新建/编辑/删除模块</li>
          <li><strong>数据集 Schema</strong> — 自定义字段列表，支持文本、多行文本、数字、金额、日期、日期时间、下拉选项、必填等</li>
          <li><strong>记录管理</strong> — 基于 Schema 动态生成表单，支持增删改查、搜索、条件筛选</li>
          <li><strong>批量导入</strong> — 支持 JSON 粘贴或 URL 远程数据导入</li>
          <li><strong>🤖 AI 业务分析</strong> — 一键生成数据集分析与洞察，可刷新并馆存分析结果到笔记库</li>
        </ul>
      </div>

      <div class="card" id="sec-reminders">
        <h2>🔔 提醒</h2>
        <p class="text-muted mb-2">独立提醒页，支持多种频率提醒，触发时发送系统通知；已配置飞书 Webhook 时同步推送消息到飞书群。</p>
        <ul>
          <li><strong>每日</strong> — 每天固定时间触发（如每天 09:00）</li>
          <li><strong>每周</strong> — 选择周一~周日中若干天触发</li>
          <li><strong>每月</strong> — 每月某一天触发（如每月 5 号）</li>
          <li><strong>每年</strong> — 纪念日提醒（如每年 1 月 1 日）</li>
          <li><strong>一次</strong> — 指定日期时间触发一次</li>
        </ul>
        <p class="text-muted">每条提醒可开关、可「测试触发」验证通知是否送达。</p>
      </div>

      <div class="card" id="sec-tools">
        <h2>🔧 工具箱（beta）</h2>
        <p class="text-muted mb-2">AI 内容工具集，每个工具都有「生成 / 历史」两个 Tab，历史记录可复制、导出、删除。</p>
        <table class="help-table">
          <thead><tr><th>工具</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📊 生成演示</td><td>按主题/页数/风格（商务汇报、教学课件、学术汇报、产品发布、创意提案等）生成演示大纲，可导出 PPTX 或 HTML</td></tr>
          <tr><td>📝 写周报/日报</td><td>选择日报或周报、时间范围，自动生成工作报告并导出 Markdown</td></tr>
          <tr><td>🧠 思维导图</td><td>按主题自动生成思维导图，导出 FreeMind（.mm）格式</td></tr>
          <tr><td>✍️ 写文案</td><td>公众号文章、朋友圈、短视频脚本、广告文案等类型，按主题与风格生成</td></tr>
          <tr><td>🌐 网络抓取</td><td>输入 URL 抓取网页内容，可存入临时数据集或导出文本</td></tr>
          <tr><td>🎨 生成图片</td><td>按提示词生成图片并保存到本机（需配置图像服务 API）</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-config">
        <h2>⚙️ 系统配置</h2>
        <p class="text-muted mb-2">所有配置通过「设置」页面管理，无需手动编辑文件。</p>
        <table class="help-table">
          <thead><tr><th>配置项</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📚 笔记库设置</td><td>选择/更换笔记库目录，知识浏览、AI 检索与任务输出共用</td></tr>
          <tr><td>💬 对话模型配置</td><td>新增/编辑多个模型接入点（名称、服务地址、API Key、模型列表），内置 DeepSeek、硅基流动、Ollama、自定义等快捷模板，支持连接测试</td></tr>
          <tr><td>🔗 飞书 Webhook</td><td>消息推送 URL，用于发送日报和提醒到飞书群（仅发送）</td></tr>
          <tr><td>📩 飞书 Bot</td><td>App ID / Secret，WebSocket 长连接接收消息，可在飞书内直接对话、下发任务</td></tr>
          <tr><td>☁️ 云端数据库</td><td>可选启用 MySQL 云端数据库替代本地 SQLite，支持一键迁移本地数据</td></tr>
          <tr><td>💾 数据备份与恢复</td><td>一键备份、每日自动备份（保留 N 份）、从备份文件恢复</td></tr>
          <tr><td>📊 综合日报设置</td><td>日报保留天数管理</td></tr>
          <tr><td>🤖 日报 AI 提示词</td><td>自定义日报生成提示词（系统级工具说明可展开查看），支持恢复默认</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-log">
        <h2>📋 日志</h2>
        <p class="text-muted mb-2">查看应用运行日志，用于排查问题。</p>
        <ul>
          <li><strong>级别过滤</strong> — 全部级别 / ERROR / WARN / INFO / DEBUG</li>
          <li><strong>日志文件切换</strong> — 查看不同日志文件（app.log 等）</li>
          <li><strong>自动刷新</strong> — 勾选后每 3 秒自动拉取最新日志</li>
          <li>双击任意日志行可复制内容</li>
        </ul>
      </div>

      <div class="card" id="sec-faq">
        <h2>❓ 常见问题</h2>
        <table class="help-table">
          <thead><tr><th>问题</th><th>原因</th><th>解决</th></tr></thead>
          <tbody>
          <tr><td>对话为空或超时</td><td>对话模型未配置或配置有误</td><td>在「设置 → 💬 对话模型配置」填写服务地址、API Key 和模型名称，并点「测试」验证</td></tr>
          <tr><td>AI 答非所问，没有用到笔记</td><td>笔记库未设置或内容较少</td><td>在「设置 → 📚 笔记库设置」选择包含 Markdown 文件的文件夹，重新提问</td></tr>
          <tr><td>模型下拉是空的/不可用</td><td>接入点没有可用模型</td><td>到「设置 → 💬 对话模型配置」为接入添加模型 ID（管理模型）并测试连接</td></tr>
          <tr><td>飞书消息收不到</td><td>Webhook 或 Bot 配置有误</td><td>在设置页检查飞书配置，点「测试」验证</td></tr>
          <tr><td>任务没有按计划执行</td><td>任务触发方式或时间设置不对</td><td>到「任务」页检查任务的触发方式（立即/指定时间/定时循环）与最近执行记录</td></tr>
          <tr><td>提醒没弹出</td><td>提醒未启用或时间/日期不对</td><td>到「提醒」页检查开关状态，点「测试触发」验证通知</td></tr>
          <tr><td>可以完全离线使用吗</td><td>—</td><td>可以。对话模型配置为 Ollama 本地模型即可完全离线</td></tr>
          <tr><td>提示"模型连接失败"</td><td>模型配置有误或 Ollama 未启动</td><td>到「设置 → 💬 对话模型配置」检查服务地址、模型名称并点「测试」；Ollama 需先 <code>ollama pull</code> 模型并确保服务运行</td></tr>
          <tr><td>数据会丢失吗</td><td>—</td><td>数据保存在本机数据库，正常退出不丢失；可在「设置 → 数据备份与恢复」一键备份、每日自动备份（保留 N 份）或从备份恢复</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-privacy">
        <h2>🔒 数据与隐私</h2>
        <ul>
          <li>数据保存在本机数据库（<code>~/.qihang-ai-desktop/qihang-ai-desktop.db</code>）与你的笔记文件夹中，不上传任何云端（除非你手动启用云端数据库）</li>
          <li>对话内容默认会发送给你配置的模型服务商（DeepSeek 等）用于生成回复</li>
          <li>如需<strong>完全离线</strong>：使用 Ollama 作为对话模型即可（除软件自动更新外无任何网络请求）</li>
          <li>「设置 → 数据备份与恢复」支持一键备份、每日自动备份（保留 N 份）与一键恢复</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

const API = (window as any).electronAPI;
const appVersion = ref('');

const sections = [
  { id: 'sec-core', icon: '✨', label: '核心卖点' },
  { id: 'sec-prereq', icon: '📋', label: '使用前必读' },
  { id: 'sec-quickstart', icon: '🚀', label: '快速开始' },
  { id: 'sec-nav', icon: '🧭', label: '页面导航' },
  { id: 'sec-chat', icon: '💬', label: 'AI 对话' },
  { id: 'sec-kb', icon: '📚', label: '知识库与概览' },
  { id: 'sec-tasks', icon: '📋', label: '任务中心' },
  { id: 'sec-data', icon: '🗃️', label: '数据' },
  { id: 'sec-reminders', icon: '🔔', label: '提醒' },
  { id: 'sec-tools', icon: '🔧', label: '工具箱' },
  { id: 'sec-config', icon: '⚙️', label: '系统配置' },
  { id: 'sec-log', icon: '📋', label: '日志' },
  { id: 'sec-faq', icon: '❓', label: '常见问题' },
  { id: 'sec-privacy', icon: '🔒', label: '数据与隐私' },
];

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const body = document.querySelector('.content-body');
  if (body) {
    body.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

onMounted(async () => {
  try {
    if (API?.app?.version) appVersion.value = await API.app.version();
  } catch { /* ignore */ }
});
</script>

<style scoped>
.help-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.content-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: white;
}

.content-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.content-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.version-badge {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  color: var(--primary);
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
}

.card {
  background: white;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 20px;
  margin-bottom: 16px;
}

.card h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--text-primary);
}

.card h3 {
  font-size: 14px;
  font-weight: 500;
  margin: 12px 0 8px;
  color: #5c5f66;
}

.text-muted {
  color: var(--text-muted);
  font-size: 13px;
}

.mb-2 {
  margin-bottom: 8px;
}

.help-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-bottom: 12px;
}

.help-table th, .help-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.help-table th {
  background: var(--hover);
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 12px;
}

.help-table code {
  font-size: 12px;
  background: #f5f5f7;
  padding: 2px 6px;
  border-radius: 4px;
}

.code-block {
  background: #1e1e2e;
  color: #cdd6f4;
  padding: 12px 14px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 0;
}

.tip {
  font-size: 12px;
  color: var(--primary);
  background: #f5f3ff;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 8px;
}

.card ul {
  padding-left: 20px;
  margin: 8px 0;
}

.card ul li {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  margin-bottom: 3px;
}

.card ol li {
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-primary);
}

.card-prereq {
  border-color: var(--primary);
  background: linear-gradient(135deg, #fafaff 0%, #f5f3ff 100%);
}

.card-index {
  border-color: rgba(99, 102, 241, 0.3);
  background: linear-gradient(135deg, #fafaff 0%, #f5f3ff 100%);
}

.index-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}

.index-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: white;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: all 0.15s;
  text-align: left;
}

.index-item:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(99, 102, 241, 0.06);
  transform: translateY(-1px);
}

.index-icon {
  font-size: 15px;
}

.card-feishu {
  border-color: #bbd7fb;
  background: linear-gradient(135deg, #f8fbff 0%, #f0f7ff 100%);
}

.prereq-item {
  display: flex;
  gap: 14px;
  margin-bottom: 18px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}

.prereq-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.prereq-number {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--primary);
  color: white;
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.prereq-content {
  flex: 1;
  min-width: 0;
}

.prereq-content strong {
  font-size: 14px;
  color: var(--text-primary);
  display: block;
  margin-bottom: 4px;
}

.prereq-content .code-block {
  margin: 6px 0;
}

.prereq-content ul {
  padding-left: 16px;
  margin: 4px 0;
}

.prereq-content ul li {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  margin-bottom: 1px;
}
</style>