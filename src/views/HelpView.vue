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
        <h2 style="font-size:17px;">✨ 核心卖点：一条完整的 AI 工作闭环</h2>
        <p class="text-muted mb-2">启航AI工作台不是"对话框 + 一堆孤立功能"，而是一套覆盖「记录 → 派活 → 观测 → 审批 → 推送」的完整闭环：</p>
        <div style="text-align:center;padding:12px 0;font-size:14px;font-weight:600;color:var(--primary);">
          记录 → 派活 → 观测 → 审批 → 推送
        </div>
        <ol style="margin:8px 0;padding-left:20px;font-size:13px;line-height:1.8;">
          <li><strong>记录</strong>：笔记库随手记，待办、工作日志、引擎简报自动从笔记提炼</li>
          <li><strong>派活</strong>：桌面对话、定时任务、飞书 Bot 三个入口把活派给 AI，由本地引擎（pi / opencode）执行</li>
          <li><strong>观测</strong>：雷达自动采集本机各 AI 编码工具（Trae、Qoder、Claude Code、Codex 等）的会话，今天页集中看动态</li>
          <li><strong>审批</strong>：Claude Code / pi / DSH 的敏感工具调用推送飞书审批卡，回合完成、失败实时通知</li>
          <li><strong>推送</strong>：综合日报、定时提醒、任务结果、审批卡片全部推送到飞书，出门也不掉线</li>
        </ol>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;">
          <div style="flex:1;min-width:140px;padding:10px;background:var(--success-soft);border-radius:8px;border:1px solid var(--success-soft);font-size:12px;line-height:1.5;">
            <strong style="color:var(--success);">🔒 数据安全</strong><br>
            <span class="text-muted">笔记、对话、待办、采集数据全部存在本机，不上传云端</span>
          </div>
          <div style="flex:1;min-width:140px;padding:10px;background:var(--surface-2);border-radius:8px;border:1px solid #b3d4f7;font-size:12px;line-height:1.5;">
            <strong style="color:#2563eb;">🧠 模型自由</strong><br>
            <span class="text-muted">DeepSeek、OpenAI 兼容、Ollama 本地模型，配置多个随时切换</span>
          </div>
          <div style="flex:1;min-width:140px;padding:10px;background:#fefce8;border-radius:8px;border:1px solid #fde68a;font-size:12px;line-height:1.5;">
            <strong style="color:var(--warning);">📱 随身可用</strong><br>
            <span class="text-muted">frp 内网穿透 + 手机浏览器 PWA，出差在外照样遥控家里电脑的 AI</span>
          </div>
        </div>
      </div>

      <div class="card card-prereq" id="sec-prereq">
        <h2 style="font-size:17px;">📋 使用前必读：两个前置条件</h2>
        <p class="text-muted mb-2">应用启动后，需要完成以下两项配置。其中笔记库（项目）是 AI 功能的前置条件：支持添加多个，一个都没有时，AI 对话、任务执行、日报生成、待办/工作日志提炼会被门禁拦截并提示；数据源、提醒、日志不受影响。</p>

        <div class="prereq-item">
          <div class="prereq-number">1</div>
          <div class="prereq-content">
            <strong>配置 AI 对话大模型</strong>
            <p class="text-muted">所有 AI 对话、工具调用、日报生成都由大模型驱动。进入「设置 → 💬 对话模型配置」，填写接入点信息（接入名称、服务地址、API Key、模型 ID），支持 OpenAI 兼容接口（如 DeepSeek、硅基流动、Ollama、LM Studio 等），可配置多个接入，每个接入可管理多个模型（上下文窗口、推理模型、是否支持图片等属性可逐个设置）。改动自动保存并立即生效，点「测试」可验证连接是否正常。</p>
          </div>
        </div>

        <div class="prereq-item">
          <div class="prereq-number">2</div>
          <div class="prereq-content">
            <strong>添加笔记库（项目）</strong>
            <p class="text-muted">进入「设置 → 📁 项目」，点击「➕ 添加项目」选择一个本地文件夹作为笔记库，可添加多个并指定默认项目。添加后即可在「笔记」页浏览文件、在对话与任务中选择目标项目，让 AI 基于你的笔记回答问题、自动保存任务执行结果。综合日报则始终基于全部项目生成。待办、工作日志、引擎简报也从笔记库自动提炼。一个笔记库都没有时，AI 相关入口会提示先添加。</p>
          </div>
        </div>
      </div>

      <div class="card" id="sec-quickstart">
        <h2>🚀 快速开始</h2>
        <p class="text-muted mb-2">启航AI工作台是一款桌面应用，将本地笔记库、AI 编码工具会话采集、任务执行、飞书推送和 AI 智能体整合成一套完整的工作流。所有数据保存在本机，模型自由选择。</p>
        <ol style="margin:8px 0;padding-left:20px;font-size:13px;line-height:1.8;">
          <li>完成上方两个前置条件配置</li>
          <li>在「今天」页查看引擎简报、AI 工具动态与工作日志，用「问雷达」向已采集的 AI 会话提问</li>
          <li>在「对话」页开始与 AI 对话（支持图片粘贴/上传、切换模型），左侧面板管理会话列表</li>
          <li>在「任务」页创建定时/循环任务，让 AI 定期自动执行（也可交由飞书 Bot 下发指令）</li>
          <li>在「数据源」页接入外部 MCP 数据源（可选）：AI 对话即可查询外部系统的业务数据</li>
          <li>在「待办」页管理待办清单与定时提醒，在「笔记」页浏览笔记库</li>
          <li>在「设置」页配置飞书集成、审批通道、移动端、雷达采集、数据备份等高级功能</li>
        </ol>
      </div>

      <div class="card" id="sec-nav">
        <h2>🧭 页面导航</h2>
        <p class="text-muted mb-2">侧栏为 64px 图标栏，图标上、小字下，悬停即见名称：</p>
        <table class="help-table">
          <thead><tr><th>菜单</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📅 今天</td><td>每日工作台：引擎简报、AI 工具动态（雷达已并入）、最近活动、等你处理、工作日志、最近活跃会话；运行中的 AI 会话数徽标挂在此入口</td></tr>
          <tr><td>💬 对话</td><td>对话工作台：会话列表内嵌在页面左侧（可折叠），支持多轮对话、图片识别、模型切换、新建对话独立页</td></tr>
          <tr><td>📈 任务</td><td>任务中心，管理挂在项目下的定时/循环任务，支持立即执行、指定时间、周期循环，任务详情含对话记录与执行记录</td></tr>
          <tr><td>🔌 数据源</td><td>接入外部 MCP server（Streamable HTTP）：配置/连接测试、业务域数据浏览、AI 分类打标、「让 AI 分析」直达对话</td></tr>
          <tr><td>✅ 待办</td><td>本地待办清单（逾期/今日/即将到来分组）+ 定时提醒（每日/每周/每月/每年/一次性），系统通知 + 飞书推送</td></tr>
          <tr><td>📚 笔记</td><td>笔记库：目录树浏览项目文件、Markdown 渲染预览、文件名关键词搜索</td></tr>
          <tr><td>✨ 技能（beta）</td><td>AI 内容生成工具集：演示、周报/日报、思维导图、文案、网站抓取、图片生成</td></tr>
          <tr><td>⚙️ 设置</td><td>系统配置：项目、对话模型、飞书、审批通道、移动端、雷达采集、数据备份等</td></tr>
          <tr><td>🖥️ 日志</td><td>运行日志查看，支持级别过滤、文件切换、自动刷新</td></tr>
          <tr><td>❓ 帮助</td><td>使用指南（当前页面，入口在顶栏右侧）</td></tr>
          </tbody>
        </table>
        <p class="text-muted" style="margin-top:8px;">今天页的二级页面：「问雷达」（向采集的会话提问）、「会话详情」（查看单条会话完整消息流）、「会话档案」（全部采集会话的筛选与搜索）。</p>
      </div>

      <div class="card" id="sec-radar">
        <h2>📡 今天页与雷达（AI 会话观测）</h2>
        <p class="text-muted mb-2">雷达已并入「今天」页，作为其中的 AI 工具动态区域。雷达自动采集本机常用的 AI 编码工具会话（Trae、Qoder、Claude Code、Codex、pi、DSH 等），无需任何手动操作，采集到的会话成为「问雷达」和会话档案的数据基础。</p>
        <table class="help-table">
          <thead><tr><th>板块</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📜 引擎简报</td><td>由笔记库与任务数据自动汇编的当日简报</td></tr>
          <tr><td>🤖 AI 工具动态</td><td>左右两栏：左侧为各 AI 工具的会话统计卡片（一行 2 个），右侧为最近活动；同一会话的连续运行事件自动合并为带持续时长的时段条目，运行中的会话标注「运行中」</td></tr>
          <tr><td>🫵 等你处理</td><td>笔记提炼的待处理事项 + 本地待办汇总；与工作日志一行两列并排，窄窗口自动回落单列</td></tr>
          <tr><td>📔 工作日志</td><td>笔记库最近更新的文档流（含日期日志与普通文档），按修改时间倒序，点击直接跳进笔记页对应文件</td></tr>
          <tr><td>🗂️ 最近活跃会话</td><td>最近采集的 AI 会话列表，点标题右侧「查看全部」进入会话档案</td></tr>
          <tr><td>🔍 问雷达</td><td>基于全部已采集会话的智能问答：输入问题（如「上周我为支付模块做过哪些改动」），AI 检索相关会话片段后汇总作答并标注来源；支持选择大模型；点击来源可跳转对应会话详情</td></tr>
          <tr><td>📄 会话档案</td><td>全部采集会话的独立页（/radar/all）：按工具筛选、全文搜索（标题命中优先、正文相关度次之）、每页 50 条分页浏览</td></tr>
          <tr><td>💬 会话详情</td><td>单条会话的完整消息流：白纸面板通高排版、连续助手消息自动合并、思考过程与工具调用默认折叠、支持插入对话（追问）；顶部纯箭头返回，默认定位到最新消息</td></tr>
          <tr><td>🔔 通知栈</td><td>今天页右上角浮动通知：回合完成/失败、待审批三类事件实时推送；待审批可就地「允许一次/拒绝」或输入追问，完成的通知 30 秒自动消退</td></tr>
          </tbody>
        </table>
        <p class="text-muted" style="margin-top:8px;">采集行为在「设置 → 雷达采集」中调整：对话入库间隔、状态探针间隔、排除目录。未开启雷达或无数据时，「问雷达」会直接给出换词建议，不调用 AI。</p>
      </div>

      <div class="card" id="sec-chat">
        <h2>💬 AI 对话</h2>
        <p class="text-muted mb-2">本地 AI 助理，支持多轮对话、图片上传/粘贴、图片理解、模型切换。会话列表内嵌在对话页左侧（可折叠，折叠状态会记住），新建对话走独立页面。</p>
        <table class="help-table">
          <thead><tr><th>能力</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>💬 日常问答</td><td>通用对话，无需绑定项目即可提问</td></tr>
          <tr><td>📚 知识库检索</td><td>添加笔记库并在对话中选择项目后，AI 会自己到该项目目录里搜、读笔记并回答</td></tr>
          <tr><td>🔌 MCP 数据源查询</td><td>已接入数据源（「数据源」页配置）的业务数据，AI 直接调用对应工具查询并在回答中注明来源</td></tr>
          <tr><td>📁 笔记读写</td><td>在笔记库目录中浏览、新建、编辑 Markdown 文件</td></tr>
          <tr><td>🌐 联网搜索</td><td>网页搜索与抓取，实时信息补充回答（搜索通道在设置页配置）</td></tr>
          <tr><td>🖼️ 图片识别</td><td>支持粘贴或上传图片，AI 自动识别内容</td></tr>
          <tr><td>🔀 会话管理</td><td>左侧面板新建/切换/折叠会话列表；会话列表同时覆盖桌面对话、飞书、手机端三个来源，自动刷新</td></tr>
          </tbody>
        </table>
        <p class="text-muted" style="margin-top:8px;">对话模型在「设置 → 💬 对话模型配置」中增减配置，维护多条接入后可在输入框上方切换模型。</p>
      </div>

      <div class="card" id="sec-tasks">
        <h2>📈 任务中心</h2>
        <p class="text-muted mb-2">任务中心在侧栏「任务」页，管理挂在项目下的任务（每个任务需选择所属项目，执行基于该项目）：</p>
        <table class="help-table">
          <thead><tr><th>能力</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📚 笔记任务</td><td>挂在某个项目下的任务：让 AI 定时读书、写周报、汇总文档，结果自动保存到该项目目录，可推送到飞书</td></tr>
          <tr><td>📊 综合日报（内置）</td><td>任务页默认内置「生成综合日报」任务：绑定笔记库并开启后，每天定时聚合所有项目生成日报，展示在「今天」页并可推送飞书；日报提示词在该任务的编辑弹窗中修改，任务不可删除、只能暂停</td></tr>
          <tr><td>🤖 引擎运行时</td><td>任务由本地 AI 引擎执行：优先使用内置 opencode，其次全局安装，均不可用时回落 pi；对话页可按会话切换引擎与模型，仅当前会话生效</td></tr>
          </tbody>
        </table>
        <p class="text-muted" style="margin-top:8px;">任务触发方式支持：⚡ 立即执行 / ⏰ 指定时间 / 🔁 定时循环（每天/每周/每月/Cron），循环任务可随时「开启/暂停调度」。任务详情可全屏查看，含「对话记录」与「执行记录」回放（每次运行的状态与结果都会留档）。任务完成后结果保存在所属项目的指定相对路径。</p>
      </div>

      <div class="card" id="sec-data">
        <h2>🔌 数据源（MCP）</h2>
        <p class="text-muted mb-2">把外部系统的数据接进来：工作台作为 MCP 客户端连接任意 Streamable HTTP 的 MCP server，AI 对话即可直接查询其数据。</p>
        <ul>
          <li><strong>源管理</strong> — 填 URL + Token 即可接入，名称自动取服务端自报标识；支持启停、编辑、删除与连接测试</li>
          <li><strong>业务域浏览</strong> — 按服务端工具分域（如线索/客户/跟进/工单）浏览原始记录，表头中文对照、列按内容相关度排序</li>
          <li><strong>🤖 AI 分类</strong> — AI 根据数据内容设计分类维度（如线索的意图/优先级）并逐条打标，可按维度筛选，结果本地缓存</li>
          <li><strong>让 AI 分析</strong> — 一键创建对话并自动发出分析请求，AI 自己拉最新数据、可追问、可存档</li>
          <li><strong>对话直查</strong> — 已接入源的工具进入对话工具面，回答注明数据来源；接入新源只是添加一条配置，无需开发</li>
        </ul>
        <p class="text-muted" style="margin-top:8px;">工作台自己也会对外提供一个本机 MCP 服务（知识库检索），配置方法见 <a href="#" @click.prevent="scrollToSection('sec-kbmcp')">🔗 本机 MCP 服务与智能体接入</a>。</p>
      </div>

      <div class="card" id="sec-kbmcp">
        <h2>🔗 本机 MCP 服务（qihang-kb）与智能体接入</h2>
        <p class="text-muted mb-2">
          工作台会把本机知识资产以标准 MCP 工具对外提供：<b>笔记库</b>、<b>已采集的外部 AI 会话（含摘要）</b>、<b>应用内对话</b>、<b>日报周报</b>。
          Claude Code、Codex、opencode、Trae、ZCode 等外部智能体接上后，就能直接检索「我之前写过/做过什么」；工作台自带对话会自动注入，无需配置。
        </p>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">一、服务状态与开关（数据源页顶部卡片）</p>
        <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li><b>状态</b>：显示「运行中 · 端口」，默认 <code>127.0.0.1:8792</code>，随 App 自启（配置键 <code>kbMcpEnabled</code>，<code>"0"</code> 关闭）</li>
          <li><b>MCP 地址</b>：<code>http://127.0.0.1:8792/mcp</code>（配置键 <code>kbMcpPort</code>，改端口后要重启服务）</li>
          <li><b>Token</b>：首次启动自动生成，卡片上可「显示 / 复制」；「重置 Token」会让旧 Token 立即失效，已接入的客户端都要改</li>
          <li><b>重建索引</b>：强制全量重建笔记索引；平时无需手动，启动差量同步 + 文件变更监听已自动维护</li>
          <li><b>已索引 N 篇笔记</b>：只统计笔记项目下（<code>type='note'</code>）的 <code>.md</code> 文件</li>
        </ul>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">二、提供的工具（全部只读）</p>
        <table class="help-table">
          <thead><tr><th>工具</th><th>用途</th><th>主要参数</th></tr></thead>
          <tbody>
            <tr><td><code>search</code></td><td>统一检索四类数据源，命中后可用 get_note / get_session 看详情</td><td><code>query</code>（必填）、<code>scope</code>=all/notes/sessions/chat/reports、<code>agent</code>、<code>days</code>、<code>limit</code></td></tr>
            <tr><td><code>get_note</code></td><td>读一篇笔记的 Markdown 全文（超长截断并标注）</td><td><code>path</code>：绝对路径或「项目名/相对路径」</td></tr>
            <tr><td><code>list_notes</code></td><td>列出笔记项目及篇数；传项目名列出该项目文件清单</td><td><code>project</code>、<code>limit</code></td></tr>
            <tr><td><code>get_session</code></td><td>读外部 AI 会话的元信息、AI 摘要、最近消息</td><td><code>session_id</code>、<code>messages</code>（0-200）</td></tr>
            <tr><td><code>recent_activity</code></td><td>最近 N 天活跃的外部 AI 会话 + 最近日报周报</td><td><code>days</code>（默认 7）、<code>limit</code></td></tr>
          </tbody>
        </table>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">三、鉴权方式</p>
        <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>服务只监听 <code>127.0.0.1</code>，公网访问不到；<b>不要做端口映射</b></li>
          <li>每个请求必须带请求头 <code>Authorization: Bearer &lt;kbMcpToken&gt;</code>，缺失或错误返回 <code>401</code></li>
          <li>Token 存在本机 <code>config.json</code> 的 <code>kbMcpToken</code>，服务端用 <code>sha256 + timingSafeEqual</code> 恒时比较</li>
          <li>客户端配置里的 Token 就是数据源页卡片上那串，直接复制粘贴，不要加引号空格</li>
        </ul>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">四、各智能体接入配置</p>
        <p class="text-muted" style="margin:0 0 4px;">地址统一为 <code>http://127.0.0.1:8792/mcp</code>（端口以卡片为准），Token 从卡片复制。</p>

        <p style="font-weight:600;margin:10px 0 4px;font-size:13px;">1. Claude Code（项目根 <code>.mcp.json</code>）</p>
        <pre class="help-pre">{
  "mcpServers": {
    "qihang-kb": {
      "type": "http",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}</pre>
        <p class="text-muted" style="margin:0 0 4px;">也可用 CLI：<code>claude mcp add --transport http qihang-kb http://127.0.0.1:8792/mcp</code>，再在 Claude Code 内补 Token。</p>

        <p style="font-weight:600;margin:10px 0 4px;font-size:13px;">2. Codex（<code>~/.codex/config.toml</code>）</p>
        <pre class="help-pre">[mcp_servers.qihang-kb]
url = "http://127.0.0.1:8792/mcp"
http_headers = { "Authorization" = "Bearer YOUR_TOKEN" }</pre>

        <p style="font-weight:600;margin:10px 0 4px;font-size:13px;">3. opencode（项目根 <code>opencode.json</code>）</p>
        <pre class="help-pre">{
  "mcp": {
    "qihang-kb": {
      "type": "remote",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "enabled": true
    }
  }
}</pre>

        <p style="font-weight:600;margin:10px 0 4px;font-size:13px;">4. Trae（项目根 <code>.trae/mcp.json</code>）</p>
        <pre class="help-pre">{
  "mcpServers": {
    "qihang-kb": {
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}</pre>
        <p class="text-muted" style="margin:0 0 4px;">若当前 Trae 版本不支持 headers，需在其 MCP 配置界面里单独填 Token；仍不行时可临时改为内网免鉴权（不建议）。</p>

        <p style="font-weight:600;margin:10px 0 4px;font-size:13px;">5. ZCode / 其他 Streamable HTTP 客户端</p>
        <pre class="help-pre">{
  "mcpServers": {
    "qihang-kb": {
      "type": "http",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}</pre>

        <p style="font-weight:600;margin:10px 0 4px;font-size:13px;">6. 工作台自带对话</p>
        <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>pi 引擎：服务运行时自动注入，工具以 <code>mcp__qihang_kb__search</code> 等形式出现在工具面，直接提问即可</li>
          <li>opencode 引擎：不经过自动注入，按第 3 节给 opencode 单独配置</li>
          <li>重置 Token 后会自动重建会话，新会话立即使用新 Token</li>
        </ul>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">五、验证与常见问题</p>
        <table class="help-table">
          <thead><tr><th>现象</th><th>原因</th><th>处理</th></tr></thead>
          <tbody>
            <tr><td>返回 401 unauthorized</td><td>Token 缺失或不一致</td><td>重新复制卡片上的 Token；重置过 Token 的客户端要同步更新</td></tr>
            <tr><td>连接被拒绝</td><td>服务未启动 / App 已退出</td><td>看卡片是否「运行中」；服务随 App 启停，App 关闭即不可用</td></tr>
            <tr><td>启动报「端口 8792 已被占用」</td><td>端口被其他进程占用</td><td>改 <code>kbMcpPort</code> 或停掉占用进程，重启应用</td></tr>
            <tr><td>客户端提示 Not Acceptable</td><td>手工 curl 时 Accept 头不完整</td><td>同时带 <code>Accept: application/json, text/event-stream</code></td></tr>
            <tr><td>搜不到刚写的笔记</td><td>文件不在笔记项目 / 非 .md / 防抖未完成</td><td>确认项目类型为笔记，等 1.5 秒或点「重建索引」</td></tr>
            <tr><td>会话类结果为空</td><td>雷达尚未采集过外部会话</td><td>先确认今天页/雷达已有采集数据；笔记类工具不受影响</td></tr>
          </tbody>
        </table>
        <p class="tip">安全提醒：知识库语料可能包含密钥、内网路径等敏感内容。保持仅本机监听，不要把 8792 映射到公网；不需要时直接在卡片上关闭服务。</p>
      </div>

      <div class="card" id="sec-todo">
        <h2>✅ 待办与提醒</h2>
        <p class="text-muted mb-2">侧栏「待办」页集中管理需要你动手的事：上半区是待办清单，下半区是定时提醒。待办会同步写入笔记库，并与「今天」页「等你处理」板块联动。</p>
        <table class="help-table">
          <thead><tr><th>板块</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>🗒️ 待办清单</td><td>顶部输入框回车快速添加（可选截止日期），按逾期/今日/即将到来自动分组，逾期标红；可标记完成、删除、切换「显示已完成」</td></tr>
          <tr><td>🔔 定时提醒</td><td>每日（如每天 09:00）/ 每周（选周几）/ 每月（如每月 5 号）/ 每年（纪念日）/ 一次性（指定日期时间）；触发时发系统通知，已配置飞书 Webhook 时同步推送飞书群；每条可开关、可「测试触发」</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-notes">
        <h2>📚 笔记库</h2>
        <p class="text-muted mb-2">侧栏「笔记」页：左侧目录树浏览笔记库文件（顶部可切换项目），右侧 Markdown 渲染预览，支持文件名关键词搜索。</p>
        <ul>
          <li>笔记库是整个工作台的数据底座：待办、工作日志、引擎简报都从笔记库自动提炼</li>
          <li>AI 对话与任务可直接读写笔记库中的 Markdown 文件，无需建索引</li>
          <li>「今天」页工作日志条目点击后直接跳转到对应笔记文件</li>
          <li>任务执行结果默认落盘到所属项目的指定相对路径，在笔记页即可查看</li>
        </ul>
      </div>

      <div class="card" id="sec-tools">
        <h2>✨ 技能（beta）</h2>
        <p class="text-muted mb-2">AI 内容工具集，每个工具都有「生成 / 历史」两个 Tab，历史记录可复制、导出、删除。</p>
        <table class="help-table">
          <thead><tr><th>工具</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>📊 生成演示</td><td>按主题/页数/风格（商务汇报、教学课件、学术汇报、产品发布、创意提案等）生成演示大纲，可导出 PPTX 或 HTML</td></tr>
          <tr><td>📝 写周报/日报</td><td>选择日报或周报、时间范围，自动生成工作报告并导出 Markdown</td></tr>
          <tr><td>🧠 思维导图</td><td>按主题自动生成思维导图，导出 FreeMind（.mm）格式</td></tr>
          <tr><td>✍️ 写文案</td><td>公众号文章、朋友圈、短视频脚本、广告文案等类型，按主题与风格生成</td></tr>
          <tr><td>🌐 网络抓取</td><td>输入 URL 抓取网页内容，导出为文本或存为笔记素材</td></tr>
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
          <tr><td>📁 项目</td><td>统一管理笔记库：添加/重命名/换目录/删除项目，指定默认项目；AI 直接读取项目目录里的 Markdown 文件作答，无需建索引；飞书对话与任务归档固定使用默认项目，桌面对话与任务可逐条选择项目</td></tr>
          <tr><td>💬 对话模型配置</td><td>新增/编辑多个模型接入点（名称、服务地址、API Key、模型列表），内置 DeepSeek、硅基流动、Ollama、自定义等快捷模板，模型可逐个设置上下文窗口/推理/图片能力，支持连接测试</td></tr>
          <tr><td>🔍 搜索通道</td><td>AI 联网搜索使用的通道与 API Key（选填）</td></tr>
          <tr><td>🔗 飞书 Webhook</td><td>消息推送 URL，用于发送日报和提醒到飞书群（仅发送）</td></tr>
          <tr><td>📩 飞书 Bot</td><td>App ID / Secret，WebSocket 长连接接收消息，可在飞书内直接对话、下发任务；卡片按钮选项目见下方「📩 飞书卡片交互」</td></tr>
          <tr><td>🛡️ 审批通道</td><td>飞书审批卡接收会话 chat_id、本地审批服务端口（默认 8790）、DSH / claude 路径、pi 终端审批扩展部署状态；详见下方「🛡️ 飞书审批通道」</td></tr>
          <tr><td>📱 移动端</td><td>移动网关端口（默认 8791）、frpc 程序与配置路径、随 App 启动；详见下方「📱 手机访问（frp）」</td></tr>
          <tr><td>📡 雷达采集</td><td>对话入库间隔、状态探针间隔、排除目录（逗号分隔前缀匹配）</td></tr>
          <tr><td>💾 数据备份与恢复</td><td>一键备份、每日自动备份（保留 N 份）、从备份文件恢复；备份目录建议选其他盘符</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-approval">
        <h2>🛡️ 飞书审批通道</h2>
        <p class="text-muted mb-2">针对外部 AI 工具会话的「拦截通道」：当 Claude Code / DSH 要执行敏感操作（如写文件、跑命令）时，推送飞书审批卡，你在手机上就能放行或拒绝；外部 pi 会话不拦截工具调用，只在任务回合完成、失败时实时通知到飞书。</p>
        <table class="help-table">
          <thead><tr><th>通道</th><th>说明</th></tr></thead>
          <tbody>
          <tr><td>Claude Code</td><td>通过本地 HTTP hook（127.0.0.1:8790）拦截工具调用，仅 CLI 会话生效（App 内会话走原生弹框）；hook 覆盖全部工具</td></tr>
          <tr><td>pi</td><td>通过 pi 扩展（pi-approver-gate）实现，随审批通道启动自动部署；<b>不做工具审批拦截</b>（拍板 2026-11-15 删除，pi 终端全自动原生速度运行），仅保留回合完成/失败通知与「接着问」追问能力</td></tr>
          <tr><td>DSH</td><td>通过 ACP 反向请求拦截，DSH 桌面端默认安装路径已内置</td></tr>
          </tbody>
        </table>
        <ul style="margin:8px 0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>审批卡可就地操作：允许一次 / 拒绝 / 允许本会话；也可在卡片输入框输入内容点「💬 接着问」继续对话（30 秒快速追问窗口，配置为 0 才关闭）</li>
          <li>人工决策<b>不设超时</b>，一直挂起等你处理；会话死亡按拒绝收口；挂起超 60 分钟自动过期</li>
          <li>任务回合收口三路通知：飞书任务卡片 + 桌面系统通知 + 今天页通知栈（失败任务会明确标注，不会假报「任务完成」）</li>
          <li>「接着问」会注入原终端会话触发新回合：pi/DSH 需终端保持打开，Claude Code 仅 30 秒窗口内可用</li>
          <li>审计日志落 <code>~/.qihang-ai-desktop/approval/history.jsonl</code></li>
        </ul>
      </div>

      <div class="card" id="sec-feishu-card">
        <h2>📩 飞书卡片交互（Bot 派活）</h2>
        <p class="text-muted mb-2">配置飞书 Bot 后，机器人通过交互卡片与你确认每条消息落在哪个项目，再执行。核心策略：<strong>每条消息先确认落点，再执行</strong>——即使会话之前选过项目，也会作为默认选项让你再确认一次，绝不静默落错项目。</p>

        <p style="font-weight:600;margin:10px 0 6px;font-size:13px;">三种卡片</p>
        <table class="help-table">
          <thead><tr><th>卡片</th><th>何时出现</th><th>怎么用</th></tr></thead>
          <tbody>
          <tr><td>📂 请选择项目</td><td>消息未指明项目且项目数 &gt; 1（包括之前选过项目的情况）</td><td>点项目按钮直接派活；之前选过项目时，第一个按钮是「就用当前项目「X」」（沿用绑定的项目执行这条消息）</td></tr>
          <tr><td>🤖 AI 结果卡片</td><td>任务执行完成</td><td>底部标注「本条已发到「X」」；点「💬 接着问」后直接回复，可接在那条对话后面继续问（30 分钟内有效），不用每条消息重新派活</td></tr>
          <tr><td>状态卡片</td><td>全程反馈</td><td>已接单、项目已切换、处理出错、工作单已记录等</td></tr>
          </tbody>
        </table>

        <p style="font-weight:600;margin:10px 0 6px;font-size:13px;">项目指派方式（按钮点不了时照样能用）</p>
        <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>点卡片按钮（推荐）：点击即派活，立刻看到「已派活到「X」」轻提示</li>
          <li>回复序号：<code>2</code> 或 <code>/项目 2</code>（序号即卡片列表里的编号）</li>
          <li>回复项目名：<code>/项目 笔记库</code>；行内标记 <code>[笔记库：项目名]</code> 只对这一条生效</li>
          <li>追问最近一条对话：<code>继续 把刚才的报告补充一段风险说明</code>；或点结果卡片「💬 接着问」后直接回复（续聊期间发 <code>/</code> 开头的命令即开始新话题）</li>
        </ul>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">飞书卡片回调配置（一次性开通，按钮功能必需）</p>
        <ol style="margin:0;padding-left:20px;font-size:13px;line-height:2;">
          <li>登录 <a href="#" @click.prevent="openExternal('https://open.feishu.cn/')">飞书开放平台</a>，进入你的自建应用 → 「开发配置」→「事件与回调」</li>
          <li>切到「回调配置」Tab，订阅方式选择「<strong>长连接</strong>」（推荐，无需公网域名）</li>
          <li>在「已订阅的回调」中添加「<strong>卡片回传交互（card.action.trigger）</strong>」</li>
          <li>创建版本并发布生效，然后重启本应用，使长连接生效</li>
          <li>验证：在飞书里给机器人发一条消息 → 点弹出的项目选择卡片按钮，应立即看到「已派活」提示</li>
        </ol>
        <p class="text-muted" style="margin-top:8px;">未订阅回调时按钮点击无响应，但回复序号 /「/项目 名称」不受影响，功能不丢。</p>
      </div>

      <div class="card" id="sec-mobile">
        <h2>📱 手机访问与内网穿透（frp）</h2>
        <p class="text-muted mb-2">
          用手机浏览器直接访问本机工作台：手机 → 公网入口（云服务器 frps）→ 家里电脑 frpc（<b>由 App 托管</b>）→ 本机网关 <code>127.0.0.1:8791</code>。
          网关只监听本机，不直接暴露公网；frpc 随 App 自启，异常退出会自动重连（3s 起、最长 60s 退避）。
        </p>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">一、下载安装 frp</p>
        <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>打开 <a href="#" @click.prevent="openExternal('https://github.com/fatedier/frp/releases')">frp Releases</a>，按平台下载发行包（以 <code>frp_0.72.0</code> 为例）
            <ul style="margin:4px 0;padding-left:18px;">
              <li>云服务器：<code>frp_0.72.0_linux_amd64.tar.gz</code>（服务端 <code>frps</code>）</li>
              <li>家里电脑：<code>frp_0.72.0_windows_amd64.zip</code>（客户端 <code>frpc.exe</code>）</li>
            </ul>
          </li>
          <li>解压后只需要可执行文件与各自的 <code>*.toml</code> 配置。</li>
        </ol>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">二、服务端 frps（云服务器）</p>
        <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>上传 <code>frps</code> 与 <code>frps.toml</code> 到服务器，如 <code>/opt/frp/</code></li>
          <li>安全组 + 系统防火墙放行 <code>7000</code>（控制端口）与 <code>18791</code>（对外映射端口）</li>
          <li>启动：<code>./frps -c frps.toml</code>；常驻建议用 systemd（<code>Restart=always</code>）</li>
        </ol>
        <pre class="help-pre">bindPort = 7000
# 两端必须一致，请改成你自己的强随机串
auth.token = "YOUR_STRONG_TOKEN"

# 可选管理面板，建议只绑 127.0.0.1
webServer.addr = "127.0.0.1"
webServer.port = 7500</pre>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">三、客户端 frpc（运行工作台的电脑）</p>
        <pre class="help-pre">serverAddr = "你的云服务器IP"
serverPort = 7000
auth.token = "YOUR_STRONG_TOKEN"

[[proxies]]
name = "qihang-mobile"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8791
remotePort = 18791</pre>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">四、在 App 内开启（推荐，不用手动跑 frpc）</p>
        <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li>「设置 → 📱 移动端」打开「启用移动端网关」，端口保持 <code>8791</code></li>
          <li>「🔗 frpc 内网穿透」里选择 <code>frpc.exe</code> 路径与 <code>frpc.toml</code> 路径，勾选「随 App 启动 frpc」，点「应用 / 重启」</li>
          <li>状态区显示「运行中 + PID」即成功；关闭 App 会一并关闭 frpc</li>
          <li>点「生成配对码」，手机访问 <code>http://公网IP:18791/</code> 输入 6 位配对码（5 分钟有效、一次性）</li>
        </ol>
        <p class="text-muted" style="margin-top:8px;">手机端是独立的移动界面：新建对话选项目/模型、会话列表带项目标签、SSE 实时流式回答；长期使用建议域名 + HTTPS（nginx 反代，SSE 需关闭 proxy_buffering）。</p>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">五、安全建议</p>
        <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;">
          <li><code>frpc.toml</code> 是本机私密配置，不要提交到代码仓库（文档中的 token 均为占位符）</li>
          <li>公网 <code>18791</code> 适合联调期，长期建议域名 + HTTPS（nginx 反代到 18791）后关闭公网端口，最终仅开放 443 / 80 / 7000</li>
          <li>更换/丢失手机：清空 <code>~/.qihang-ai-desktop/mobile-devices.json</code> 撤销全部设备，再重新配对</li>
        </ul>

        <p style="font-weight:600;margin:14px 0 6px;font-size:13px;">六、常见问题</p>
        <table class="help-table">
          <thead><tr><th>现象</th><th>原因</th><th>处理</th></tr></thead>
          <tbody>
            <tr><td>frpc 显示未运行</td><td>程序/配置路径不存在</td><td>检查两个路径，查看日志中的 <code>[Frpc]</code> 行</td></tr>
            <tr><td><code>token in login doesn't match</code></td><td>两端 token 不一致</td><td>统一 <code>auth.token</code> 后重启 frps / frpc</td></tr>
            <tr><td><code>port already used</code></td><td><code>remotePort</code> 被占用</td><td>改 <code>remotePort</code> 或停掉占用进程</td></tr>
            <tr><td>手机打不开页面</td><td>端口未放行或未连通</td><td>先测 <code>http://IP:18791/api/health</code>，再查安全组/防火墙</td></tr>
            <tr><td>frpc 反复重启</td><td>网络抖动或地址错误</td><td>自动退避重连；持续失败看设置页 <code>lastError</code></td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-log">
        <h2>🖥️ 日志</h2>
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
          <tr><td>对话为空或超时</td><td>对话模型未配置或配置有误</td><td>在「设置 → 💬 对话模型配置」填写服务地址、API Key 和模型 ID，并点「测试」验证</td></tr>
          <tr><td>AI 答非所问，没有用到笔记</td><td>笔记库未添加或所选项目内容较少</td><td>在「设置 → 📁 项目」添加包含 Markdown 文件的文件夹，或在对话左上角切换项目后重新提问</td></tr>
          <tr><td>模型下拉是空的/不可用</td><td>接入点没有可用模型</td><td>到「设置 → 💬 对话模型配置」为接入添加模型 ID（管理模型）并测试连接</td></tr>
          <tr><td>问雷达答非所问或无结果</td><td>雷达未采集到会话，或关键词太泛</td><td>确认今天页 AI 工具动态里已有该工具的会话；换更具体的关键词（工具名、功能名）重试；采集配置见「设置 → 雷达采集」</td></tr>
          <tr><td>某个 AI 工具的会话没被采集</td><td>该工具在本机无会话数据，或目录被排除</td><td>先在该工具里正常使用一轮对话，等待下一轮自动采集（约 1-2 分钟）；检查排除目录配置是否误伤</td></tr>
          <tr><td>飞书审批卡不弹 / 收不到</td><td>审批通道未开启，或机器人不在配置的群里</td><td>确认「设置 → 审批通道」已启用，chat_id 对应的群里已加入机器人；点「测试」验证</td></tr>
          <tr><td>审批卡提示「审批服务不可用」</td><td>审批服务端口被占用或未启动</td><td>检查 8790 端口是否被旧进程占用，重启应用；pi 默认零拦截，不影响 pi 正常使用</td></tr>
          <tr><td>追问提交了但 pi 终端没收到</td><td>终端里的 pi 未加载新版扩展或终端已关闭</td><td>pi CLI 终端退出重进以加载扩展；终端需保持打开，追问暂存 10 分钟内有效</td></tr>
          <tr><td>飞书消息收不到</td><td>Webhook 或 Bot 配置有误</td><td>在设置页检查飞书配置，点「测试」验证</td></tr>
          <tr><td>飞书卡片按钮点了没反应</td><td>飞书后台未订阅「卡片回传交互」回调</td><td>按上方「📩 飞书卡片交互」的开通步骤，在「回调配置」订阅 <code>card.action.trigger</code>（长连接）并发布生效；或直接回复序号 /「/项目 名称」</td></tr>
          <tr><td>点卡片按钮提示"目标回调服务超时未响应"</td><td>旧版本应用把任务执行等在了回调里，超过飞书 3 秒响应时限</td><td>升级/重启本应用后重试；该报错不代表任务没执行——出现「已接单」即已派活，结果卡片会稍后送达</td></tr>
          <tr><td>任务没有按计划执行</td><td>任务触发方式或时间设置不对</td><td>到「任务」页检查任务的触发方式（立即/指定时间/定时循环）与最近执行记录</td></tr>
          <tr><td>提醒没弹出</td><td>提醒未启用或时间/日期不对</td><td>到「待办」页检查提醒开关状态，点「测试触发」验证通知</td></tr>
          <tr><td>可以完全离线使用吗</td><td>—</td><td>可以。对话模型配置为 Ollama 本地模型即可完全离线</td></tr>
          <tr><td>提示"模型连接失败"</td><td>模型配置有误或 Ollama 未启动</td><td>到「设置 → 💬 对话模型配置」检查服务地址、模型名称并点「测试」；Ollama 需先 <code>ollama pull</code> 模型并确保服务运行</td></tr>
          <tr><td>数据会丢失吗</td><td>—</td><td>数据保存在本机数据库，正常退出不丢失；可在「设置 → 数据备份与恢复」一键备份、每日自动备份（保留 N 份）或从备份恢复</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" id="sec-privacy">
        <h2>🔒 数据与隐私</h2>
        <ul>
          <li>数据保存在本机数据库（<code>~/.qihang-ai-desktop/qihang-ai-desktop.db</code>）与你的笔记库文件夹中，不上传任何云端</li>
          <li>对话内容默认会发送给你配置的模型服务商（DeepSeek 等）用于生成回复</li>
          <li>雷达采集的 AI 工具会话只读取本机工具的本地数据目录，仅在设备上留存</li>
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

/** 外部链接交给系统默认浏览器打开，避免应用窗口被导航走 */
const openExternal = (url: string) => { try { API?.app?.openExternal?.(url); } catch {} };

const sections = [
  { id: 'sec-core', icon: '✨', label: '核心卖点' },
  { id: 'sec-prereq', icon: '📋', label: '使用前必读' },
  { id: 'sec-quickstart', icon: '🚀', label: '快速开始' },
  { id: 'sec-nav', icon: '🧭', label: '页面导航' },
  { id: 'sec-radar', icon: '📡', label: '今天页与雷达' },
  { id: 'sec-chat', icon: '💬', label: 'AI 对话' },
  { id: 'sec-tasks', icon: '📈', label: '任务中心' },
  { id: 'sec-data', icon: '🔌', label: '数据源' },
  { id: 'sec-kbmcp', icon: '🔗', label: '本机 MCP 服务' },
  { id: 'sec-todo', icon: '✅', label: '待办与提醒' },
  { id: 'sec-notes', icon: '📚', label: '笔记库' },
  { id: 'sec-tools', icon: '🎨', label: '技能' },
  { id: 'sec-config', icon: '⚙️', label: '系统配置' },
  { id: 'sec-approval', icon: '🛡️', label: '飞书审批通道' },
  { id: 'sec-feishu-card', icon: '📩', label: '飞书卡片交互' },
  { id: 'sec-mobile', icon: '📱', label: '手机访问（frp）' },
  { id: 'sec-log', icon: '🖥️', label: '日志' },
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
  background: var(--surface);
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
  background: rgba(var(--primary-rgb), 0.1);
  border: 1px solid rgba(var(--primary-rgb), 0.2);
}

.card {
  background: var(--surface);
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

.help-pre {
  background: var(--hover);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre;
  margin: 4px 0 12px;
}

.help-table code {
  font-size: 12px;
  background: var(--hover);
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
  background: var(--primary-soft);
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
  background: linear-gradient(135deg, var(--surface-2) 0%, var(--primary-soft) 100%);
}

.card-index {
  border-color: rgba(var(--primary-rgb), 0.3);
  background: linear-gradient(135deg, var(--surface-2) 0%, var(--primary-soft) 100%);
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
  background: var(--surface);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: all 0.15s;
  text-align: left;
}

.index-item:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(var(--primary-rgb), 0.06);
  transform: translateY(-1px);
}

.index-icon {
  font-size: 15px;
}

.card-feishu {
  border-color: #bbd7fb;
  background: linear-gradient(135deg, #f8fbff 0%, var(--surface-2) 100%);
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
