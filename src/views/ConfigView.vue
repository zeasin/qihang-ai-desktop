<template>
  <div class="config-view">
    <div class="content-header">
      <h1 class="content-title">设置</h1>
    </div>

    <div class="content-body">

      <!-- Project Management -->
      <div class="card">
        <h2>📁 项目</h2>
        <div class="text-muted mb-2">项目就是本地目录。AI 对话按所选项目目录运行，AI 直接读取项目目录里的 Markdown 文件作答；综合日报聚合<b>所有项目 + 数据集</b>；飞书派活、任务结果存档与数据归档默认写入<b>默认项目</b>。</div>
        <div v-if="!kbLibraries.length" class="text-muted mb-2" style="font-size:13px;">尚未添加任何项目。添加后 AI 对话、任务执行、日报生成、知识库浏览方可使用。</div>
        <div v-for="lib in kbLibraries" :key="lib.id" class="kb-lib-row">
          <div class="kb-lib-main">
            <span class="kb-lib-name">📁 {{ lib.name }}</span>
            <span v-if="lib.isDefault" class="kb-lib-badge">默认</span>
            <span class="kb-lib-dir text-muted">{{ lib.dir }}</span>
            <span class="text-muted kb-lib-count">{{ lib.docCount || 0 }} 个笔记文件</span>
          </div>
          <div class="kb-lib-actions">
            <button v-if="!lib.isDefault" class="text-btn" @click="setDefaultLib(lib)">设为默认</button>
            <button class="text-btn" @click="renameLib(lib)">重命名</button>
            <button class="text-btn" @click="changeLibDir(lib)">换目录</button>
            <button class="text-btn" style="color:#ef4444;" @click="removeLib(lib)">删除</button>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
          <button class="btn btn-primary" @click="addLib">➕ 添加项目</button>
          <span v-if="notesDirStatus" class="text-muted" :style="{ color: notesDirStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }">{{ notesDirStatus }}</span>
        </div>
      </div>

      <!-- 对话模型配置 -->
      <div class="card">
        <h2>💬 对话模型配置</h2>
        <div class="text-muted mb-2">配置 AI 对话使用的模型接入点。选择「默认（DeepSeek）」只需填入 API Key 即可快速开始；选择「自定义」可配置任意 OpenAI 兼容接口（如 DeepSeek、Ollama、LM Studio 等）。配置完成后所有 AI 对话、日报生成即可直接使用，无需安装终端工具。</div>

        <div v-if="!llmProviders.length" class="llm-empty">
          <div class="llm-empty-icon">🤖</div>
          <div class="text-muted" style="font-size:13px;">尚未配置任何 AI 接入点，使用下方「⚡ 快速配置」选择供应商并填入 API Key</div>
        </div>

        <div v-else class="llm-provider-table">
          <div class="llm-provider-thead">
            <span class="col-name">接入名称</span>
            <span class="col-url">服务地址</span>
            <span class="col-type">API 类型</span>
            <span class="col-models">模型数</span>
            <span class="col-actions">操作</span>
          </div>
          <div v-for="(prov, idx) in llmProviders" :key="idx" class="llm-provider-row">
            <div class="col-name">
              <span class="llm-prov-name">{{ prov.name || '未命名' }}</span>
            </div>
            <div class="col-url">
              <span class="llm-prov-url" :title="prov.baseUrl">{{ prov.baseUrl || '-' }}</span>
            </div>
            <div class="col-type">
              <span class="llm-prov-type">{{ apiTypeLabel(prov.api) }}</span>
            </div>
            <div class="col-models">
              <span class="badge badge-primary">{{ (prov.models || []).length }}</span>
            </div>
            <div class="col-actions">
              <button class="btn btn-sm btn-secondary" @click="openProviderModal(idx)">编辑</button>
              <button class="btn btn-sm btn-secondary" @click="openModelModal(idx)">管理模型</button>
              <button class="btn btn-sm btn-secondary" @click="testLlmProvider(idx)" :disabled="prov.testing">{{ prov.testing ? '测试中' : '测试' }}</button>
              <button class="btn btn-sm btn-danger" @click="removeLlmProvider(idx)">删除</button>
            </div>
          </div>
        </div>

        <div v-if="llmStatus" class="text-muted" :style="{ color: llmStatus.startsWith('✅') ? '#22c55e' : llmStatus.startsWith('⏳') ? '#f59e0b' : '#ef4444' }" style="margin-top:8px;display:block;">{{ llmStatus }}</div>

        <div class="text-muted" style="font-size:12px;margin-top:12px;">⚡ 快速配置：选择供应商，填写对应字段后点击「添加并生效」</div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:4px;">
          <div class="form-group" style="flex:0 0 210px;">
            <label style="font-size:12px;">供应商</label>
            <select v-model="quickKey" class="form-control" @change="onQuickKeyChange">
              <option v-for="(opt, k) in QUICK_OPTIONS" :key="k" :value="k">{{ opt.label }}</option>
            </select>
          </div>
          <template v-if="quickKey === 'custom'">
            <div class="form-group" style="flex:1;min-width:130px;">
              <label style="font-size:12px;">接入名称</label>
              <input v-model="quickName" type="text" class="form-control" placeholder="如 my-llm">
            </div>
            <div class="form-group" style="flex:1;min-width:220px;">
              <label style="font-size:12px;">服务地址（API Base URL）</label>
              <input v-model="quickBaseUrl" type="text" class="form-control" placeholder="https://api.example.com/v1">
            </div>
            <div class="form-group" style="flex:1;min-width:180px;">
              <label style="font-size:12px;">模型 ID（逗号分隔）</label>
              <input v-model="quickModels" type="text" class="form-control" placeholder="deepseek-chat, deepseek-reasoner">
            </div>
            <div class="form-group" style="flex:0 0 170px;">
              <label style="font-size:12px;">API 类型</label>
              <select v-model="quickApi" class="form-control">
                <option value="openai-completions">Chat Completions</option>
                <option value="openai-responses">Responses API</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
          </template>
          <div class="form-group" :style="quickKey === 'custom' ? 'flex:1;min-width:200px;' : 'flex:1;min-width:280px;'">
            <label style="font-size:12px;">API Key{{ quickKey === 'ollama' ? '（本地可留空）' : '' }}</label>
            <input v-model="quickApiKey" type="password" class="form-control" :placeholder="quickApiKeyPlaceholder">
          </div>
          <button class="btn btn-primary" @click="applyQuickConfig" :disabled="quickBusy">{{ quickBusy ? '保存中...' : quickKey === 'custom' ? '添加并生效' : '填入并生效' }}</button>
        </div>

        <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center;">
          <button class="btn btn-primary" @click="openProviderModal(-1)">+ 自定义 Provider</button>
          <span v-if="llmProviders.length" class="badge badge-success">● 已配置 {{ llmProviders.length }} 个 Provider</span>
          <span class="text-muted" style="font-size:12px;">改动自动保存并立即生效</span>
        </div>
      </div>

      <!-- AI 引擎版本 -->
      <div class="card">
        <h2>🧩 AI 引擎版本</h2>
        <div class="text-muted mb-2">pi 引擎运行在应用主进程内（使用应用内置 SDK，无需本机 CLI）。下列版本用于排查「模型/对话异常」这类版本不匹配问题。</div>
        <div class="engine-version-table">
          <div class="engine-version-row engine-version-head">
            <span>引擎</span>
            <span>应用内置 SDK</span>
            <span>本机安装版本</span>
            <span>状态</span>
          </div>
          <div class="engine-version-row">
            <span class="engine-version-name">pi agent</span>
            <span>{{ agentVersions?.pi?.sdk || (versionsLoading ? '检测中…' : '—') }}</span>
            <span>{{ agentVersions?.pi?.installed || (versionsLoading ? '检测中…' : '未安装（不影响使用）') }}</span>
            <span><span class="badge badge-success">应用内置运行</span></span>
          </div>
        </div>
        <div class="flex" style="gap:10px;margin-top:10px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-secondary" @click="loadAgentVersions" :disabled="versionsLoading">{{ versionsLoading ? '检测中…' : '重新检测' }}</button>
          <span v-if="versionsError" class="text-muted" style="font-size:12px;color:#ef4444;">{{ versionsError }}</span>
        </div>
      </div>

      <!-- 网络搜索配置 -->
      <div class="card">
        <h2>🔍 网络搜索配置</h2>
        <div class="text-muted mb-2">AI 对话、任务执行中使用的外网搜索。默认「自动引擎」免费可用（百度/Bing/DuckDuckGo 自动降级）；如需更稳定、中文效果更好的搜索，可配置 API Key（博查或 Serper，保存后自动优先使用）。</div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:end;">
          <div class="form-group" style="flex:0 0 220px;">
            <label style="font-size:12px;">搜索通道</label>
            <select v-model="searchProvider" class="form-control">
              <option value="auto">自动引擎（免费）</option>
              <option value="bocha">博查 Bocha（推荐，中文强）</option>
              <option value="serper">Serper (Google)</option>
            </select>
          </div>
          <div class="form-group" style="flex:1;min-width:260px;">
            <label style="font-size:12px;">API Key（选填）</label>
            <input v-model="searchApiKey" type="password" class="form-control" placeholder="选择博查/Serper 后填写对应 API Key">
          </div>
          <button class="btn btn-primary" @click="saveSearchConfig" style="margin-bottom:12px;">保存</button>
          <button class="btn btn-secondary" @click="testSearchConfig" style="margin-bottom:12px;" :disabled="searchTesting">{{ searchTesting ? '测试中...' : '测试' }}</button>
        </div>
        <span v-if="searchStatus" class="text-muted" :style="{ color: searchStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }" style="display:block;margin-top:8px;">{{ searchStatus }}</span>
      </div>

      <!-- Provider Edit Modal -->
      <div v-if="providerModalOpen" class="modal-overlay" @click.self="closeProviderModal">
        <div class="modal" style="width:520px;">
          <div class="modal-header">
            <h3>{{ editingProviderIndex === -1 ? '添加 Provider' : '编辑 Provider' }}</h3>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>接入名称</label>
              <input v-model="providerForm.name" type="text" class="form-control" placeholder="如 deepseek / ollama / sensenova">
            </div>
            <div class="form-group">
              <label>服务地址（API Base URL）</label>
              <input v-model="providerForm.baseUrl" type="text" class="form-control" placeholder="https://api.deepseek.com/v1">
            </div>
            <div class="form-group">
              <label>API 类型</label>
              <select v-model="providerForm.api" class="form-control">
                <option value="openai-completions">Chat Completions (默认)</option>
                <option value="openai-responses">Responses API</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div class="form-group">
              <label>API Key（Ollama 本地留空）</label>
              <input v-model="providerForm.apiKey" type="password" class="form-control" placeholder="sk-...">
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeProviderModal">取消</button>
            <button class="btn btn-primary" @click="saveProviderFromModal">确定</button>
          </div>
        </div>
      </div>

      <!-- Model Management Modal -->
      <div v-if="modelModalOpen" class="modal-overlay" @click.self="closeModelModal">
        <div class="modal" style="width:720px;">
          <div class="modal-header">
            <h3>管理模型 — {{ llmProviders[modelModalProviderIndex]?.name || 'Provider' }}</h3>
          </div>
          <div class="modal-body">
            <div v-if="!modelEditList.length" class="text-muted" style="text-align:center;padding:20px;">暂无模型，点击下方按钮添加</div>
            <div v-for="(m, mi) in modelEditList" :key="mi" class="llm-model-edit-row">
              <div class="form-row" style="gap:8px;">
                <div class="form-group" style="flex:2;min-width:160px;margin-bottom:6px;">
                  <label style="font-size:11px;">模型 ID</label>
                  <input v-model="m.id" type="text" class="form-control" placeholder="如 deepseek-chat">
                </div>
                <div class="form-group" style="flex:1;min-width:120px;margin-bottom:6px;">
                  <label style="font-size:11px;">显示名称（可选）</label>
                  <input v-model="m.name" type="text" class="form-control" placeholder="Deepseek Chat">
                </div>
              </div>
              <div class="form-row" style="gap:8px;align-items:flex-end;">
                <div class="form-group" style="flex:1;min-width:100px;margin-bottom:6px;">
                  <label style="font-size:11px;">上下文窗口</label>
                  <input v-model.number="m.contextWindow" type="number" class="form-control" placeholder="1000000">
                </div>
                <div class="form-group" style="flex:1;min-width:100px;margin-bottom:6px;">
                  <label style="font-size:11px;">最大 Token</label>
                  <input v-model.number="m.maxTokens" type="number" class="form-control" placeholder="65535">
                </div>
                <div class="form-group" style="flex:0 0 auto;margin-bottom:6px;display:flex;align-items:center;gap:4px;padding-bottom:4px;">
                  <label style="font-size:11px;margin:0;">推理模型</label>
                  <input v-model="m.reasoning" type="checkbox" style="margin:0;">
                </div>
                <div class="form-group" style="flex:0 0 auto;margin-bottom:6px;display:flex;align-items:center;gap:4px;padding-bottom:4px;">
                  <label style="font-size:11px;margin:0;">支持图片</label>
                  <input type="checkbox" :checked="hasImageInput(m)" @change="toggleImageInput(m)" style="margin:0;">
                </div>
                <button class="btn btn-sm btn-danger" @click="removeModelRow(mi)">删除</button>
              </div>
            </div>
            <div style="margin-top:8px;">
              <button class="btn btn-secondary" @click="addModelRow">+ 添加模型</button>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeModelModal">取消</button>
            <button class="btn btn-primary" @click="saveModelsFromModal">保存模型</button>
          </div>
        </div>
      </div>

      <!-- 移动端（飞书 + 中继） -->
      <div class="card">
        <h2>📱 移动端</h2>
        <div class="text-muted mb-2">手机指挥桌面端的两条通道，互相独立、可任选或同时开启：<b>飞书</b>在飞书里 @助手 下发任务、收日报；<b>中继连接</b>让手机 App 直连桌面端完整对话与浏览历史。</div>

        <h3>🔗 飞书 Webhook（群通知推送）</h3>
        <div class="text-muted mb-2">用于发送通知消息到飞书群（如日报、提醒等）。仅支持发送。</div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:end;">
          <div class="form-group" style="flex:1;min-width:300px;">
            <label style="font-size:12px;">Webhook URL</label>
            <input v-model="webhookUrl" type="text" class="form-control" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/...">
          </div>
          <button class="btn btn-primary" @click="saveWebhook" style="margin-bottom:12px;">保存</button>
          <button class="btn btn-secondary" @click="testWebhook" style="margin-bottom:12px;">测试</button>
        </div>
        <span v-if="webhookStatus" class="text-muted" :style="{ color: webhookStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }">{{ webhookStatus }}</span>

        <hr class="mobile-divider">

        <h3>📩 飞书 Bot（飞书内对话）</h3>
        <div class="text-muted mb-2">配置飞书自建应用凭据，连接到飞书事件订阅，实时接收和回复消息。</div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:end;">
          <div class="form-group" style="flex:1;min-width:200px;">
            <label style="font-size:12px;">App ID</label>
            <input v-model="feishuAppId" type="text" class="form-control" placeholder="飞书自建应用的 App ID">
          </div>
          <div class="form-group" style="flex:1;min-width:200px;">
            <label style="font-size:12px;">App Secret</label>
            <input v-model="feishuAppSecret" type="password" class="form-control" placeholder="飞书自建应用的 App Secret">
          </div>
        </div>
        <div class="flex" style="gap:8px;margin-top:8px;">
          <button class="btn btn-primary" @click="saveFeishuBot">保存</button>
          <button class="btn btn-primary" @click="startFeishuBot">{{ feishuRunning ? '重启 Bot' : '启动 Bot' }}</button>
          <button v-if="feishuRunning" class="btn btn-danger" @click="stopFeishuBot">停止 Bot</button>
          <button class="btn btn-secondary" @click="testFeishuBot">测试</button>
          <span v-if="feishuRunning" class="badge badge-success">● 运行中</span>
          <span v-else class="badge badge-gray">○ 已停止</span>
        </div>
        <span v-if="feishuStatus" class="text-muted" :style="{ color: feishuStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }">{{ feishuStatus }}</span>

        <hr class="mobile-divider">

        <h3>📶 中继连接（手机 App 远程对话）</h3>
        <div class="text-muted mb-2">
          桌面端出站连接中继服务，手机 App 经同一条中继读数据快照并下发对话。
          笔记本关机时手机仍可浏览历史，但不能发起新对话。
        </div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:end;">
          <div class="form-group" style="flex:1;min-width:300px;">
            <label style="font-size:12px;">中继服务地址（只填到域名或 IP:端口，不要带 /relay 路径）</label>
            <input v-model="relayUrl" type="text" class="form-control" placeholder="https://work.qihangerp.cn">
          </div>
          <button class="btn btn-secondary" @click="probeRelay" style="margin-bottom:12px;" :disabled="relayBusy">探活</button>
          <button class="btn btn-primary" @click="saveRelayUrl" style="margin-bottom:12px;" :disabled="relayBusy">保存并重连</button>
        </div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:end;">
          <div class="form-group" style="flex:1;min-width:300px;">
            <label style="font-size:12px;">连接密码（至少 6 位；移动端凭它配对，全服务器唯一）</label>
            <input v-model="relayPassword" type="password" class="form-control"
                   :placeholder="relayDevice.hasPassword ? '已设置；输入新值可修改' : '设置一个仅你知晓的密码'">
          </div>
          <button class="btn btn-primary" @click="enableRelay" style="margin-bottom:12px;" :disabled="relayBusy">
            {{ relayDevice.remoteEnabled ? '更新密码并开启' : '设置密码并开启' }}
          </button>
          <button v-if="relayDevice.remoteEnabled" class="btn btn-danger" @click="disableRelay" style="margin-bottom:12px;" :disabled="relayBusy">关闭</button>
        </div>
        <div class="flex" style="gap:12px;flex-wrap:wrap;align-items:center;">
          <span v-if="relayConnected" class="badge badge-success">● 已连接中继</span>
          <span v-else-if="relayDevice.remoteEnabled" class="badge badge-gray">○ 已开启，未连接</span>
          <span v-else class="badge badge-gray">○ 未开启</span>
          <span class="text-muted" style="font-size:12px;">设备 ID：{{ relayDevice.deviceId || '—' }}</span>
          <span class="text-muted" style="font-size:12px;">设备名：{{ relayDevice.name || '—' }}</span>
        </div>
        <div v-if="relayStatus" class="text-muted" style="font-size:12px;margin-top:6px;"
             :style="{ color: relayStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }">{{ relayStatus }}</div>
        <div v-if="relayClients.length" style="margin-top:12px;">
          <div class="text-muted" style="font-size:12px;margin-bottom:6px;">已接入的客户端（{{ relayClients.length }}）</div>
          <div v-for="c in relayClients" :key="c.sessionId" class="flex" style="gap:8px;align-items:center;font-size:13px;margin-bottom:6px;">
            <span>{{ c.name || '未命名客户端' }}</span>
            <span class="text-muted">{{ c.platform }}</span>
            <button class="btn btn-secondary" @click="kickRelayClient(c.sessionId)">踢下线</button>
          </div>
        </div>
      </div>

      <!-- Backup / Restore -->
      <div class="card">
        <h2>💾 数据备份与恢复</h2>
        <div class="text-muted mb-2">备份本地 SQLite 快照（会话、项目、待办、数据中心等全部数据）；恢复后需重启应用生效。</div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:12px;">
          <div class="form-group" style="flex:1;min-width:300px;margin:0;">
            <label style="font-size:12px;">备份目录（建议选择其他盘符）</label>
            <div class="input-with-btn">
              <input v-model="backupDir" type="text" class="form-control" placeholder="默认 ~/.qihang-ai-desktop/backups" readonly>
              <button class="btn btn-secondary" @click="pickBackupDir">选择</button>
            </div>
          </div>
        </div>
        <div class="flex" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <button class="btn btn-primary" @click="createBackup" :disabled="backupBusy">{{ backupBusy ? '备份中...' : '一键备份' }}</button>
          <button class="btn btn-secondary" @click="restoreBackup">从备份恢复...</button>
          <button class="btn btn-secondary" @click="openBackupDir">打开备份目录</button>
        </div>
        <div class="flex" style="gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">
          <label class="toggle" title="应用运行期间每小时检查一次，距上次备份超过 24 小时自动补一份">
            <input type="checkbox" v-model="autoBackupEnabled" @change="saveAutoBackup">
            <span class="slider"></span>
          </label>
          <span class="text-muted">自动备份（运行期间，距上次超 24 小时自动补一份）</span>
          <div class="form-group" style="margin:0 0 0 16px;display:flex;align-items:center;gap:6px;">
            <label style="font-size:12px;margin:0;">保留份数</label>
            <input v-model="backupRetention" type="number" min="1" max="365" class="form-control" style="width:80px;" @change="saveAutoBackup">
          </div>
        </div>
        <span v-if="backupStatus" class="text-muted" :style="{ color: backupStatus.startsWith('✅') ? '#22c55e' : backupStatus.startsWith('⏳') ? '#f59e0b' : '#ef4444' }">{{ backupStatus }}</span>
        <div v-if="backupList.length" class="backup-list">
          <div class="backup-item" v-for="b in backupList" :key="b.path">
            <span class="backup-name">{{ b.name }}</span>
            <span class="backup-size">{{ formatSize(b.size) }}</span>
            <span class="backup-time">{{ formatTime(b.createdAt) }}</span>
            <button class="btn btn-sm btn-secondary" @click="restoreBackupFile(b)">恢复</button>
            <button class="btn btn-sm btn-danger" @click="deleteBackup(b)">删除</button>
          </div>
        </div>
      </div>

      <!-- Report Settings -->
      <div class="card">
        <h2>📊 综合日报设置</h2>
        <div class="text-muted mb-2">管理综合日报的生成和保存策略。</div>
        <div class="form-row" style="gap:8px;flex-wrap:wrap;align-items:center;">
          <div class="form-group" style="flex:0 0 160px;">
            <label style="font-size:12px;">保留天数</label>
            <input v-model="reportRetentionDays" type="number" class="form-control" min="1" max="365" style="width:100px;">
          </div>
          <button class="btn btn-primary" @click="saveReportSettings">保存</button>
        </div>
        <span v-if="reportSettingsStatus" class="text-muted" :style="{ color: reportSettingsStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }" style="margin-top:8px;display:block;">{{ reportSettingsStatus }}</span>
      </div>

      <!-- Report Template Editor -->
      <div class="card">
        <h2>🤖 日报 AI 提示词</h2>
        <div class="text-muted mb-2">
          编辑下方提示词（Prompt），AI 会据此生成日报的格式和内容。
        </div>
        <div class="info-box" style="background:#f0f7ff;border:1px solid #b3d4f7;border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px;line-height:1.6;">
          <strong>💡 提示词分两级：</strong><br>
          <strong>系统级</strong>（不可修改）：工具定义、执行步骤 — AI 会自动调用工具查询待办、对话、笔记等数据<br>
          <strong>用户级</strong>（下方编辑）：日报格式要求、展示方式、注意事项 — 按你的偏好定制
        </div>
        <div class="template-help" @click="showTemplateHelp = !showTemplateHelp">
          <span>{{ showTemplateHelp ? '▼' : '▶' }}</span>
          📖 查看系统级工具说明（供参考）
        </div>
        <div v-if="showTemplateHelp" class="template-help-content">
          <table class="vars-table">
            <thead><tr><th>工具</th><th>说明</th></tr></thead>
            <tbody>
              <tr><td><code>get_today_info()</code></td><td>获取今天的日期、项目信息，以及笔记的实时统计（总数 / 今日更新数 / 分项目文件数）</td></tr>
              <tr><td><code>query_todos(status, date_from)</code></td><td>查询待办事项，可按状态( done/in_progress/pending )和日期范围过滤</td></tr>
              <tr><td><code>query_messages(date_from, role)</code></td><td>查询对话记录，可按日期和角色( user/assistant )过滤</td></tr>
              <tr><td><code>query_data_records(dataset_name, date_from)</code></td><td>查询数据中心记录，可按数据集名称过滤</td></tr>
              <tr><td><code>query_reminders()</code></td><td>查询所有已启用的提醒</td></tr>
            </tbody>
          </table>
        </div>
        <textarea v-model="reportPrompt" class="code-editor" rows="20" spellcheck="false" placeholder="例如：&#10;请按以下格式生成日报：&#10;&#10;## 日报格式要求&#10;使用 Markdown 格式，包含今日概览、完成事项、待办事项、对话沟通、综合评估等板块。&#10;&#10;## 注意事项&#10;- 数据为空的部分略过&#10;- 给出效率评分和建议&#10;- 语言简洁专业"></textarea>
        <div class="flex" style="gap:8px;margin-top:8px;">
          <button class="btn btn-primary" @click="saveReportTemplate">保存提示词</button>
          <button class="btn btn-secondary" @click="resetReportTemplate">恢复默认</button>
          <span v-if="templateStatus" class="text-muted" :style="{ color: templateStatus.startsWith('✅') ? '#22c55e' : '#ef4444' }" style="margin-left:8px;">{{ templateStatus }}</span>
        </div>
      </div>

      </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const API = window.electronAPI;

const projects = ref<any[]>([]);

const webhookUrl = ref('');
const webhookStatus = ref('');

const feishuAppId = ref('');
const feishuAppSecret = ref('');
const feishuRunning = ref(false);
const feishuStatus = ref('');

const schedulerRunning = ref(false);

// Report settings
const reportRetentionDays = ref('30');
const reportPrompt = ref('');
const reportSettingsStatus = ref('');
const showTemplateHelp = ref(false);
const templateStatus = ref('');

// 网络搜索
const searchProvider = ref('auto');
const searchApiKey = ref('');
const searchStatus = ref('');
const searchTesting = ref(false);

// 对话模型（支持多个接入，每个接入可含多个模型）
interface LlmModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: any;
  [k: string]: any;
}
interface LlmProviderRow {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: LlmModelEntry[];
  modelNamesText: string;
  testing: boolean;
  status: string;
}
const llmProviders = ref<LlmProviderRow[]>([]);
const llmStatus = ref('');
const notesDirStatus = ref('');

// AI 引擎版本（应用内置 SDK vs 本机安装 CLI）
const agentVersions = ref<{
  pi: { sdk: string | null; installed: string | null };
} | null>(null);
const versionsLoading = ref(false);
const versionsError = ref('');

async function loadAgentVersions() {
  versionsLoading.value = true;
  versionsError.value = '';
  try { agentVersions.value = await API.agent.versions(); }
  catch {
    agentVersions.value = null;
    versionsError.value = '版本检测失败，请重启应用后再试';
  }
  finally { versionsLoading.value = false; }
}

// Provider modal state
const providerModalOpen = ref(false);
const editingProviderIndex = ref(-1);
const providerForm = ref<{ name: string; baseUrl: string; apiKey: string; api: string }>({ name: '', baseUrl: '', apiKey: '', api: 'openai-completions' });

// Model modal state
const modelModalOpen = ref(false);
const modelModalProviderIndex = ref(-1);
const modelEditList = ref<LlmModelEntry[]>([]);

function apiTypeLabel(api: string): string {
  if (api === 'openai-responses') return 'Responses API';
  if (api === 'ollama') return 'Ollama';
  return 'Chat Completions';
}

function openProviderModal(idx: number) {
  editingProviderIndex.value = idx;
  if (idx >= 0 && llmProviders.value[idx]) {
    const p = llmProviders.value[idx];
    providerForm.value = { name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, api: p.api || 'openai-completions' };
  } else {
    providerForm.value = { name: '', baseUrl: '', apiKey: '', api: 'openai-completions' };
  }
  providerModalOpen.value = true;
}

function closeProviderModal() {
  providerModalOpen.value = false;
}

async function saveProviderFromModal() {
  const form = providerForm.value;
  if (!form.name.trim()) { llmStatus.value = '❌ 请填写接入名称'; return; }
  if (!form.baseUrl.trim()) { llmStatus.value = '❌ 请填写服务地址'; return; }
  const isNew = editingProviderIndex.value === -1;
  if (isNew) {
    const entry: LlmProviderRow = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      api: form.api,
      models: [],
      modelNamesText: '',
      testing: false,
      status: '',
    };
    llmProviders.value.push(entry);
  } else {
    const p = llmProviders.value[editingProviderIndex.value];
    p.name = form.name.trim();
    p.baseUrl = form.baseUrl.trim();
    p.apiKey = form.apiKey.trim();
    p.api = form.api;
  }
  providerModalOpen.value = false;
  await saveLlmConfig(isNew ? '✅ 已新增接入点并生效' : '✅ 已保存接入点并生效');
}

function openModelModal(idx: number) {
  modelModalProviderIndex.value = idx;
  const p = llmProviders.value[idx];
  if (p) {
    modelEditList.value = (p.models || []).map((m: any) => ({
      id: m.id || '',
      name: m.name || '',
      reasoning: !!m.reasoning,
      input: Array.isArray(m.input) ? [...m.input] : undefined,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: m.compat,
    }));
  } else {
    modelEditList.value = [];
  }
  modelModalOpen.value = true;
}

function closeModelModal() {
  modelModalOpen.value = false;
}

function addModelRow() {
  modelEditList.value.push({ id: '', name: '', reasoning: false, input: ['text'], contextWindow: undefined, maxTokens: undefined });
}

function removeModelRow(mi: number) {
  modelEditList.value.splice(mi, 1);
}

function hasImageInput(m: LlmModelEntry): boolean {
  return Array.isArray(m.input) && m.input.includes('image');
}

function toggleImageInput(m: LlmModelEntry) {
  if (!Array.isArray(m.input)) m.input = ['text'];
  const idx = m.input.indexOf('image');
  if (idx >= 0) m.input.splice(idx, 1);
  else m.input.push('image');
}

async function saveModelsFromModal() {
  const p = llmProviders.value[modelModalProviderIndex.value];
  if (!p) { modelModalOpen.value = false; return; }
  const cleanList = modelEditList.value.filter((m) => m.id && m.id.trim());
  if (!cleanList.length) {
    llmProviders.value.splice(modelModalProviderIndex.value, 1);
    modelModalOpen.value = false;
    await saveLlmConfig(`✅ 「${p.name || '未命名'}」模型已清空，接入点已一并删除`);
    return;
  }
  const models = cleanList.map((m) => {
    const entry: any = { id: m.id.trim() };
    if (m.name && m.name.trim()) entry.name = m.name.trim();
    if (m.reasoning) entry.reasoning = true;
    if (Array.isArray(m.input) && m.input.length) entry.input = [...m.input];
    if (m.contextWindow) entry.contextWindow = Number(m.contextWindow);
    if (m.maxTokens) entry.maxTokens = Number(m.maxTokens);
    return entry;
  });
  p.models = models;
  p.modelNamesText = models.map((m: any) => m.id).join('\n');
  modelModalOpen.value = false;
  await saveLlmConfig('✅ 模型变更已生效');
}

type ProviderPresetKey = 'deepseek' | 'siliconflow' | 'ollama' | 'sensenova';
const PROVIDER_PRESETS: Record<ProviderPresetKey, Partial<LlmProviderRow> & { presetModels: LlmModelEntry[] }> = {
  deepseek: {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-responses',
    apiKey: '',
    presetModels: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 65535 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 65535 },
    ],
  },
  siliconflow: {
    name: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    api: 'openai-completions',
    apiKey: '',
    presetModels: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 16384 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 16384 },
    ],
  },
  ollama: {
    name: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'ollama',
    apiKey: '',
    presetModels: [
      { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },
      { id: 'llama3.1:8b', name: 'Llama 3.1 8B', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  sensenova: {
    name: 'sensenova',
    baseUrl: 'https://token.sensenova.cn/v1',
    api: 'openai-completions',
    apiKey: '',
    presetModels: [
      { id: 'sensenova-6.7-flash-lite', name: 'SenseNova 6.7 Flash Lite', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 65535 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 65535, compat: { supportsDeveloperRole: false } },
      { id: 'glm-5.2', name: 'GLM 5.2', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 65535, compat: { supportsDeveloperRole: false } },
    ],
  },
};

/** 按预设键构建一个完整的 Provider 行（含模型列表），未配置 API Key */
function buildPresetProvider(key: ProviderPresetKey): LlmProviderRow {
  const preset = PROVIDER_PRESETS[key];
  const models = [...(preset?.presetModels || [])];
  return {
    name: preset?.name || '',
    baseUrl: preset?.baseUrl || '',
    apiKey: preset?.apiKey || '',
    api: preset?.api || 'openai-completions',
    models,
    modelNamesText: models.map((m: any) => m.id).join('\n'),
    testing: false,
    status: '',
  };
}

// ---- 快速配置（供应商下拉） ----
type QuickProviderKey = ProviderPresetKey | 'custom';
const QUICK_OPTIONS: Record<QuickProviderKey, { label: string }> = {
  deepseek: { label: '🔷 DeepSeek' },
  siliconflow: { label: '🟣 硅基流动 SiliconFlow' },
  ollama: { label: '🐳 Ollama 本地' },
  sensenova: { label: '🟦 SensNova' },
  custom: { label: '⚙️ 自定义' },
};
const quickKey = ref<QuickProviderKey>('deepseek');
const quickApiKey = ref('');
const quickName = ref('');
const quickBaseUrl = ref('');
const quickApi = ref('openai-completions');
const quickModels = ref('');
const quickBusy = ref(false);

const quickApiKeyPlaceholder = computed(() => {
  if (quickKey.value === 'ollama') return '本地 Ollama 可留空';
  if (quickKey.value === 'deepseek') return 'sk-...（仅需填 API Key，服务地址与模型已内置）';
  return 'sk-...';
});

const quickApiKeyRequired = computed(() => quickKey.value !== 'ollama');

function onQuickKeyChange() {
  // 切到非自定义时，清掉自定义专用字段，避免误带
  quickName.value = '';
  quickBaseUrl.value = '';
  quickModels.value = '';
  quickApi.value = quickKey.value === 'deepseek' ? 'openai-responses' : 'openai-completions';
}

async function applyQuickConfig() {
  quickBusy.value = true;
  try {
    if (quickKey.value !== 'custom') {
      const key = quickKey.value;
      const preset = PROVIDER_PRESETS[key];
      if (!preset) return;
      if (quickApiKeyRequired.value && !quickApiKey.value.trim()) {
        llmStatus.value = key === 'deepseek' ? '❌ 请填写 DeepSeek API Key' : `❌ 请填写「${preset.name}」的 API Key`;
        return;
      }
      let row = llmProviders.value.find((p) => p.name === preset.name);
      if (!row) {
        row = buildPresetProvider(key);
        llmProviders.value.push(row);
      }
      if (!row.models || !row.models.length) row.models = [...(preset.presetModels || [])];
      if (quickApiKey.value.trim()) row.apiKey = quickApiKey.value.trim();
      llmStatus.value = `✅ 已填写「${preset.name}」配置，正在保存生效`;
    } else {
      if (!quickName.value.trim()) { llmStatus.value = '❌ 请填写接入名称'; return; }
      if (!quickBaseUrl.value.trim()) { llmStatus.value = '❌ 请填写服务地址'; return; }
      const modelIds = quickModels.value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      if (!modelIds.length) { llmStatus.value = '❌ 请至少填写一个模型 ID'; return; }
      llmProviders.value.push({
        name: quickName.value.trim(),
        baseUrl: quickBaseUrl.value.trim(),
        apiKey: quickApiKey.value.trim(),
        api: quickApi.value,
        models: modelIds.map((id) => ({ id, input: ['text'] })),
        modelNamesText: modelIds.join('\n'),
        testing: false,
        status: '',
      });
      llmStatus.value = '✅ 已添加自定义 Provider，正在保存...';
    }
    await saveLlmConfig();
    quickApiKey.value = '';
    quickName.value = '';
    quickBaseUrl.value = '';
    quickModels.value = '';
  } catch (e: any) {
    llmStatus.value = '❌ ' + (e.message || '保存失败');
  } finally {
    quickBusy.value = false;
  }
}

// Backup
const backupBusy = ref(false);
const backupStatus = ref('');
const backupList = ref<any[]>([]);
const autoBackupEnabled = ref(false);
const backupRetention = ref('30');
const backupDir = ref('');

async function loadBackups() {
  try { backupList.value = await API.backup.list(); } catch { backupList.value = []; }
}

async function loadAutoBackup() {
  try {
    const s = await API.backup.autoStatus();
    autoBackupEnabled.value = !!s.enabled;
    backupRetention.value = String(s.retention || 30);
    backupDir.value = s.dir || '';
  } catch {}
}

async function pickBackupDir() {
  try {
    const dir = await API.backup.pickDir();
    if (!dir) return;
    const res = await API.backup.setDir(dir);
    if (res.ok) {
      backupDir.value = res.dir || dir;
      backupStatus.value = `✅ 备份目录已设置为: ${dir}`;
      await loadBackups();
      setTimeout(() => { if (backupStatus.value.startsWith('✅')) backupStatus.value = ''; }, 5000);
    } else {
      backupStatus.value = '❌ ' + (res.error || '设置失败');
    }
  } catch (e: any) { backupStatus.value = '❌ ' + (e.message || '设置失败'); }
}

function formatSize(size: number): string {
  if (!size) return '0 B';
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch { return iso; }
}

async function createBackup() {
  backupBusy.value = true;
  backupStatus.value = '⏳ 正在备份...';
  try {
    const res = await API.backup.create();
    if (res.ok) {
      backupStatus.value = `✅ 备份完成: ${res.path}`;
      await loadBackups();
    } else {
      backupStatus.value = '❌ ' + (res.error || '备份失败');
    }
  } catch (e: any) { backupStatus.value = '❌ ' + (e.message || '备份失败'); }
  backupBusy.value = false;
  setTimeout(() => { if (backupStatus.value.startsWith('✅')) backupStatus.value = ''; }, 6000);
}

async function restoreBackup() {
  try {
    const file = await API.backup.pickFile();
    if (!file) return;
    if (!confirm('恢复会替换当前全部数据，且需要重启应用。确定继续？')) return;
    const res = await API.backup.restore(file);
    if (res.ok) {
      alert('✅ 恢复成功，请重启应用生效');
    } else {
      alert('❌ 恢复失败: ' + (res.error || '未知错误'));
    }
  } catch (e: any) { alert('❌ 恢复失败: ' + (e.message || e)); }
}

async function restoreBackupFile(b: any) {
  if (!confirm(`从备份「${b.name}」恢复？\n将替换当前全部数据，且需要重启应用。`)) return;
  try {
    const res = await API.backup.restore(b.path);
    if (res.ok) {
      alert('✅ 恢复成功，请重启应用生效');
    } else {
      alert('❌ 恢复失败: ' + (res.error || '未知错误'));
    }
  } catch (e: any) { alert('❌ 恢复失败: ' + (e.message || e)); }
}

async function deleteBackup(b: any) {
  if (!confirm(`删除备份「${b.name}」？`)) return;
  try {
    const res = await API.backup.deleteFile(b.path);
    if (!res.ok) alert('❌ 删除失败: ' + (res.error || '未知错误'));
    await loadBackups();
  } catch (e: any) { alert('❌ 删除失败: ' + (e.message || e)); }
}

async function saveAutoBackup() {
  try {
    await API.config.set({ autoBackupEnabled: autoBackupEnabled.value ? '1' : '0', backupRetention: backupRetention.value || '30' });
    await API.backup.setAuto(autoBackupEnabled.value);
    backupStatus.value = autoBackupEnabled.value ? '✅ 自动备份已开启' : '✅ 自动备份已关闭';
    setTimeout(() => { if (backupStatus.value.startsWith('✅')) backupStatus.value = ''; }, 3000);
  } catch (e: any) { backupStatus.value = '❌ ' + (e.message || '保存失败'); }
}

async function openBackupDir() {
  try {
    const s = await API.backup.autoStatus();
    await API.backup.openDir(s.dir);
  } catch {}
}


async function loadProjects() {
  try { projects.value = await API.project.list(); } catch { projects.value = []; }
}

// ===== 项目管理 =====
const kbLibraries = ref<any[]>([]);
async function loadKbLibraries() {
  try { kbLibraries.value = await API.kb.list(); } catch { kbLibraries.value = []; }
}
function kbFlash(msg: string) {
  notesDirStatus.value = msg;
  setTimeout(() => notesDirStatus.value = '', 4000);
}
async function addLib() {
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir) return;
    const name = prompt('为这个项目起个名字（留空则用目录名）', dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '') ?? '';
    const r = await API.kb.add(name.trim(), dir);
    if (r?.error) { kbFlash('❌ ' + r.error); return; }
    kbFlash('✅ 已添加项目「' + (r?.name || '') + '」');
    await loadKbLibraries();
    await loadProjects();
  } catch (e: any) { kbFlash('❌ ' + (e.message || '添加失败')); }
}
async function renameLib(lib: any) {
  const name = prompt('新的项目名称', lib.name);
  if (!name || !name.trim() || name.trim() === lib.name) return;
  const r = await API.kb.update(lib.id, { name: name.trim() });
  if (r?.error) { kbFlash('❌ ' + r.error); return; }
  await loadKbLibraries();
}
async function changeLibDir(lib: any) {
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir || dir === lib.dir) return;
    if (!confirm(`项目「${lib.name}」将改指向新目录，磁盘上的文件不受影响。继续？`)) return;
    const r = await API.kb.update(lib.id, { dir });
    if (r?.error) { kbFlash('❌ ' + r.error); return; }
    kbFlash('✅ 已更新目录');
    await loadKbLibraries();
  } catch {}
}
async function setDefaultLib(lib: any) {
  await API.kb.setDefault(lib.id);
  await loadKbLibraries();
  kbFlash('✅ 已将「' + lib.name + '」设为默认项目');
}
async function removeLib(lib: any) {
  if (!confirm(`删除项目「${lib.name}」？\n\n· 磁盘上的文件不会被删除\n· 该项目的执行结果归档记录会一并清除\n· 该项目下的对话会变为未分组`)) return;
  await API.kb.remove(lib.id);
  await loadKbLibraries();
  await loadProjects();
  kbFlash('✅ 已删除「' + lib.name + '」');
}
async function loadSchedulerStatus() {
  try { const s = await API.service.status(); schedulerRunning.value = s.scheduler; } catch {}
}

async function saveWebhook() {
  const url = webhookUrl.value.trim();
  if (!url.startsWith('https://')) { webhookStatus.value = '❌ URL 必须以 https:// 开头'; return; }
  try {
    await API.feishu.setWebhook(url);
    webhookStatus.value = '✅ 已保存';
    setTimeout(() => webhookStatus.value = '', 3000);
  } catch (e: any) { webhookStatus.value = '❌ ' + (e.message || '保存失败'); }
}

async function testWebhook() {
  const url = webhookUrl.value.trim();
  if (!url) { webhookStatus.value = '❌ 请先输入 Webhook URL'; return; }
  try {
    const result = await API.feishu.testWebhook(url);
    webhookStatus.value = result.ok ? '✅ 测试消息已发送，请查看飞书！' : '❌ ' + (result.error || '发送失败');
  } catch (e: any) { webhookStatus.value = '❌ ' + (e.message || '请求失败'); }
  setTimeout(() => webhookStatus.value = '', 5000);
}

async function saveFeishuBot() {
  try {
    await API.feishu.saveBot(feishuAppId.value, feishuAppSecret.value);
    feishuStatus.value = '✅ 配置已保存';
    setTimeout(() => feishuStatus.value = '', 3000);
  } catch (e: any) { feishuStatus.value = '❌ ' + (e.message || '保存失败'); }
}

async function startFeishuBot() {
  if (!feishuAppId.value || !feishuAppSecret.value) { feishuStatus.value = '❌ 请先填写 App ID 和 App Secret'; return; }
  try {
    await API.feishu.saveBot(feishuAppId.value, feishuAppSecret.value);
    const ok = await API.service.startFeishu({ app_id: feishuAppId.value, app_secret: feishuAppSecret.value });
    feishuRunning.value = true;
    feishuStatus.value = ok ? '✅ Bot 已启动' : '❌ 启动失败，请检查配置';
    if (!ok) feishuRunning.value = false;
    setTimeout(() => feishuStatus.value = '', 5000);
  } catch (e: any) { feishuStatus.value = '❌ ' + (e.message || '启动失败'); }
}

async function stopFeishuBot() {
  try {
    await API.service.stopFeishu();
    feishuRunning.value = false;
    feishuStatus.value = '✅ Bot 已停止';
    setTimeout(() => feishuStatus.value = '', 3000);
  } catch (e: any) { feishuStatus.value = '❌ ' + (e.message || '停止失败'); }
}

async function testFeishuBot() {
  if (!feishuAppId.value || !feishuAppSecret.value) { feishuStatus.value = '❌ 请先填写 App ID 和 App Secret'; return; }
  feishuStatus.value = '⏳ 正在验证...';
  try {
    const result = await API.feishu.testBot(feishuAppId.value, feishuAppSecret.value);
    if (result.ok) {
      feishuStatus.value = result.botName ? `✅ 验证成功，Bot: ${result.botName}` : '✅ 验证成功';
    } else {
      feishuStatus.value = '❌ ' + (result.error || '验证失败');
    }
  } catch (e: any) { feishuStatus.value = '❌ ' + (e.message || '请求失败'); }
  setTimeout(() => { if (feishuStatus.value.startsWith('⏳')) feishuStatus.value = ''; }, 5000);
}

async function loadConfig() {
  try {
    const cfg = await API.config.get();
    webhookUrl.value = cfg.feishuWebhookUrl || '';
    feishuAppId.value = cfg.feishuAppId || '';
    feishuAppSecret.value = cfg.feishuAppSecret || '';
    reportRetentionDays.value = cfg.dailyReportRetentionDays || '30';
    reportPrompt.value = cfg.dailyReportPrompt || '';
  } catch { console.warn('加载配置失败'); }
}

async function loadLlmConfig() {
  try {
    const res = await API.pi.configGet();
    const providers = res?.providers || [];
    llmProviders.value = providers.map((p: any) => ({
      name: p.name || '',
      baseUrl: p.baseUrl || '',
      apiKey: p.apiKey || '',
      api: p.api || 'openai-completions',
      models: (p.models || []).map((m: any) => ({
        id: m.id || '',
        name: m.name || '',
        reasoning: m.reasoning,
        input: m.input,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        compat: m.compat,
      })).filter((m: any) => m.id),
      modelNamesText: (p.models || []).map((m: any) => m.id || '').filter(Boolean).join('\n'),
      testing: false,
      status: '',
    }));
  } catch { llmProviders.value = []; }
}

async function removeLlmProvider(idx: number) {
  const p = llmProviders.value[idx];
  if (!p) return;
  if (!confirm(`删除接入点「${p.name || '未命名'}」？删除后立即生效。`)) return;
  llmProviders.value.splice(idx, 1);
  await saveLlmConfig(`✅ 已删除接入点「${p.name || '未命名'}」并生效`);
}

async function loadSearchConfig() {
  try {
    const cfg = await API.search.configGet();
    searchProvider.value = cfg?.provider || 'auto';
    searchApiKey.value = cfg?.apiKey || '';
  } catch { /* 默认 auto */ }
}

async function saveSearchConfig() {
  try {
    const res = await API.search.configSet({ provider: searchProvider.value, apiKey: searchApiKey.value });
    if (res?.ok) {
      searchStatus.value = '✅ 已保存' + (searchProvider.value === 'auto' ? '（免费引擎通道）' : '，AI 搜索将优先使用该通道');
    } else {
      searchStatus.value = '❌ ' + (res?.error || '保存失败');
    }
    setTimeout(() => { if (searchStatus.value.startsWith('✅')) searchStatus.value = ''; }, 5000);
  } catch (e: any) {
    searchStatus.value = '❌ ' + (e?.message || '保存失败');
  }
}

async function testSearchConfig() {
  searchTesting.value = true;
  searchStatus.value = '⏳ 正在测试网络搜索...';
  try {
    const res = await API.search.test();
    if (res?.ok) {
      searchStatus.value = `✅ 搜索正常（${res.text || res.source || '免费引擎'}）`;
    } else {
      searchStatus.value = '❌ ' + (res?.error || '搜索失败');
    }
  } catch (e: any) {
    searchStatus.value = '❌ ' + (e?.message || '请求失败');
  }
  searchTesting.value = false;
  setTimeout(() => { if (searchStatus.value.startsWith('✅')) searchStatus.value = ''; }, 8000);
}

async function saveLlmConfig(okMsg = '✅ 已保存并生效') {
  const providers = llmProviders.value
    .map((p) => ({
      name: p.name.trim(),
      displayName: p.name.trim(),
      baseUrl: p.baseUrl.trim(),
      apiKey: p.apiKey.trim(),
      api: p.api || 'openai-completions',
      modelNames: (p.models || []).map((m: any) => (m.id || '').trim()).filter(Boolean),
      models: (p.models || []).map((m: any) => {
        const entry: any = { id: (m.id || '').trim() };
        if (m.name) entry.name = m.name.trim();
        if (m.reasoning) entry.reasoning = true;
        if (Array.isArray(m.input) && m.input.length) entry.input = [...m.input];
        else entry.input = ['text'];
        if (m.contextWindow) entry.contextWindow = Number(m.contextWindow);
        if (m.maxTokens) entry.maxTokens = Number(m.maxTokens);
        if (m.compat) entry.compat = JSON.parse(JSON.stringify(m.compat));
        return entry;
      }).filter((m: any) => m.id),
    }))
    .filter((p) => p.name && p.baseUrl);
  llmStatus.value = '⏳ 正在保存...';
  try {
    const r = await API.pi.configSet(JSON.parse(JSON.stringify(providers)));
    if (r.ok) {
      llmStatus.value = okMsg;
      await loadLlmConfig();
      setTimeout(() => { if (llmStatus.value.startsWith('✅')) llmStatus.value = ''; }, 4000);
    } else {
      llmStatus.value = '❌ ' + (r.error || '保存失败');
    }
  } catch (e: any) {
    llmStatus.value = '❌ ' + (e.message || '保存失败');
  }
}

async function testLlmProvider(idx: number) {
  const prov = llmProviders.value[idx];
  if (!prov) return;
  if (!prov.baseUrl.trim() || !(prov.models || []).length) {
    prov.status = '❌ 请先配置服务地址和模型';
    llmStatus.value = '❌ 请先配置服务地址和模型';
    return;
  }
  const firstModel = (prov.models || []).map((m: any) => (m.id || '').trim()).find(Boolean);
  if (!firstModel) { llmStatus.value = '❌ 模型 ID 不能为空'; return; }
  prov.testing = true;
  prov.status = '⏳ 正在测试连接...';
  try {
    const r = await API.pi.configTest({
      baseUrl: prov.baseUrl.trim(),
      apiKey: prov.apiKey.trim(),
      modelName: firstModel,
    });
    if (r.ok) {
      prov.status = `✅ 连接成功（延迟 ${r.latencyMs ?? '?'}ms）`;
    } else {
      prov.status = '❌ ' + (r.error || '连接失败');
    }
  } catch (e: any) {
    prov.status = '❌ ' + (e.message || '测试异常');
  }
  prov.testing = false;
  llmStatus.value = prov.status;
  setTimeout(() => { prov.status = ''; }, 8000);
}

async function saveReportSettings() {
  try {
    await API.config.set({
      daily_report_retention_days: reportRetentionDays.value,
    });
    reportSettingsStatus.value = '✅ 已保存';
    setTimeout(() => reportSettingsStatus.value = '', 3000);
  } catch (e: any) {
    reportSettingsStatus.value = '❌ ' + (e.message || '保存失败');
  }
}

async function saveReportTemplate() {
  try {
    await API.config.set({ daily_report_prompt: reportPrompt.value });
    templateStatus.value = '✅ 已保存';
    setTimeout(() => templateStatus.value = '', 3000);
  } catch (e: any) {
    templateStatus.value = '❌ ' + (e.message || '保存失败');
  }
}

async function resetReportTemplate() {
  reportPrompt.value = '';
  await saveReportTemplate();
}
// ===== 移动端远程连接（中继服务） =====
const relayUrl = ref('');
const relayPassword = ref('');
const relayDevice = ref<any>({ hasPassword: false, remoteEnabled: false });
const relayConnected = ref(false);
const relayStatus = ref('');
const relayClients = ref<any[]>([]);
const relayBusy = ref(false);
let relayPoll: ReturnType<typeof setInterval> | null = null;

async function loadRelay(): Promise<void> {
  try {
    const s = await API.relay.status();
    relayDevice.value = s.device || { hasPassword: false, remoteEnabled: false };
    relayConnected.value = !!s.connected;
    if (s.device && s.device.relayUrl && !relayUrl.value) relayUrl.value = s.device.relayUrl;
    relayStatus.value = s.connected ? '' : String(s.error || '');
  } catch {}
  if (relayDevice.value.remoteEnabled) {
    try {
      const r = await API.relay.clients();
      relayClients.value = r && r.ok ? (r.clients || []) : [];
    } catch {}
  } else {
    relayClients.value = [];
  }
}

function pickError(r: any, fallback: string): string {
  return r && r.error ? String(r.error) : fallback;
}

async function probeRelay(): Promise<void> {
  relayBusy.value = true;
  relayStatus.value = '';
  try {
    const r = await API.relay.probe(relayUrl.value.trim());
    relayStatus.value = r.ok
      ? `✅ 中继在线，当前在线设备 ${String(r.devicesOnline ?? 0)} 台`
      : '❌ ' + pickError(r, '探活失败');
  } catch (e: any) {
    relayStatus.value = '❌ ' + (e?.message || String(e));
  } finally {
    relayBusy.value = false;
  }
}

async function saveRelayUrl(): Promise<void> {
  relayBusy.value = true;
  relayStatus.value = '';
  try {
    const r = await API.relay.setUrl(relayUrl.value.trim());
    if (!r.ok) { relayStatus.value = '❌ ' + pickError(r, '保存失败'); return; }
    relayDevice.value = r.device || relayDevice.value;
    relayConnected.value = !!r.connected;
    relayStatus.value = r.connected ? '✅ 已连接中继' : '⚠️ 地址已保存，但 ' + pickError(r, '未完成握手');
  } catch (e: any) {
    relayStatus.value = '❌ ' + (e?.message || String(e));
  } finally {
    relayBusy.value = false;
    void loadRelay();
  }
}

async function enableRelay(): Promise<void> {
  const url = relayUrl.value.trim();
  if (!url) { relayStatus.value = '❌ 请先填写中继服务地址'; return; }
  const pwd = relayPassword.value.trim();
  if (pwd.length < 6) { relayStatus.value = '❌ 密码至少 6 位'; return; }
  relayBusy.value = true;
  relayStatus.value = '';
  try {
    const r = await API.relay.enable(pwd, url);
    if (!r.ok) { relayStatus.value = '❌ ' + pickError(r, '开启失败'); return; }
    relayDevice.value = r.device || relayDevice.value;
    relayConnected.value = !!r.connected;
    relayPassword.value = '';
    relayStatus.value = r.connected ? '✅ 已开启并连接中继，在手机 App 输入这个密码配对' : '⚠️ 已开启，但 ' + pickError(r, '未完成握手');
  } catch (e: any) {
    relayStatus.value = '❌ ' + (e?.message || String(e));
  } finally {
    relayBusy.value = false;
    void loadRelay();
  }
}

async function disableRelay(): Promise<void> {
  relayBusy.value = true;
  try {
    const r = await API.relay.disable();
    relayStatus.value = r.ok ? '✅ 已关闭，移动端连接全部断开' : '❌ ' + pickError(r, '关闭失败');
  } finally {
    relayBusy.value = false;
    void loadRelay();
  }
}

async function kickRelayClient(sessionId: string): Promise<void> {
  const r = await API.relay.kick(sessionId);
  if (!r.ok) relayStatus.value = '❌ ' + pickError(r, '踢下线失败');
  void loadRelay();
}

onMounted(async () => {
  await loadConfig();
  await loadLlmConfig();
  await loadSearchConfig();
  await loadAgentVersions();
  await loadProjects();
  await loadKbLibraries();
  await loadSchedulerStatus();
  await loadBackups();
  await loadAutoBackup();
  await loadRelay();
  relayPoll = setInterval(() => { void loadRelay(); }, 10000);
  try {
    const svc = await API.service.status();
    feishuRunning.value = svc.feishu;
  } catch {}
});

onBeforeUnmount(() => {
  if (relayPoll) clearInterval(relayPoll);
});
</script>

<style scoped>
.config-view { display: flex; flex-direction: column; height: 100%; }
.content-header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: white; }
.content-title { font-size: 18px; font-weight: 600; color: var(--text-primary); }
.content-body { flex: 1; overflow-y: auto; padding: 24px; }
.card { background: white; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px; margin-bottom: 16px; }

.template-help {
  padding: 6px 10px;
  margin-bottom: 8px;
  background: var(--hover);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--primary);
  display: flex;
  align-items: center;
  gap: 4px;
  user-select: none;
}
.template-help:hover { background: #e8eaed; }
.template-help-content {
  margin-bottom: 8px;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fafbfc;
}

.vars-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.vars-table th { text-align: left; padding: 6px 10px; background: var(--hover); font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border); position: sticky; top: 0; }
.vars-table td { padding: 4px 10px; border-bottom: 1px solid var(--border); color: var(--text-primary); }
.vars-table code { font-size: 11px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; color: var(--primary); }
.code-editor {
  width: 100%;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #1e293b;
  color: #e2e8f0;
  resize: vertical;
  min-height: 200px;
  tab-size: 2;
}
.code-editor:focus { outline: none; border-color: var(--primary); }
.code-editor::placeholder { color: #64748b; }
.card h2 { font-size: 16px; font-weight: 600; margin: 0 0 8px; color: var(--text-primary); }
.card h3 { font-size: 14px; font-weight: 600; margin: 0 0 8px; color: var(--text-primary); }
.mobile-divider { border: none; border-top: 1px solid var(--border); margin: 18px 0; }

/* AI 引擎版本 */
.engine-version-table { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.engine-version-row {
  display: grid;
  grid-template-columns: 1.1fr 1.1fr 1.4fr 0.8fr;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  align-items: center;
  font-size: 13px;
}
.engine-version-row:last-child { border-bottom: none; }
.engine-version-head { background: var(--hover); font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.engine-version-name { font-weight: 500; color: var(--text-primary); }
.card-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.card-title-row h2 { margin: 0; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: #5c5f66; margin-bottom: 4px; }
.form-row { display: flex; gap: 8px; flex-wrap: wrap; }
.input-with-btn { display: flex; gap: 8px; }
.input-with-btn .form-control { flex: 1; }
.flex { display: flex; align-items: center; }
.text-muted { color: var(--text-muted); font-size: 13px; }
.mb-2 { margin-bottom: 8px; }
.config-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
.config-table th, .config-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
.config-table th { background: var(--hover); font-weight: 600; color: var(--text-secondary); font-size: 12px; }
.config-table td code { font-size: 12px; background: #f5f5f7; padding: 2px 6px; border-radius: 4px; }
.config-table .task-project-name { font-size: 12px; color: var(--text-secondary); }
.badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 20px; font-size: 12px; font-weight: 500; margin-right: 6px; }
.badge-gray { background: #f5f5f7; color: #909296; }
.badge-primary { background: rgba(99, 102, 241, 0.1); color: var(--primary); }
.badge-success { background: rgba(34, 197, 94, 0.1); color: var(--success); }
.badge-warning { background: rgba(251, 146, 60, 0.1); color: var(--warning); }
.badge-danger { background: rgba(220, 38, 38, 0.1); color: #dc2626; }

/* Agent grid */
.agent-grid { display: flex; gap: 12px; }
.agent-card { flex: 1; display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 10px; border: 1px solid var(--border); }
.agent-card.installed { background: #f0fdf4; border-color: #bbf7d0; }
.agent-card.missing { background: #fef2f2; border-color: #fecaca; }
.agent-icon { font-size: 28px; }
.agent-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.agent-version { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.agent-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }

/* Modal */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; border-radius: 12px; width: 520px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.15); max-height: 80vh; display: flex; flex-direction: column; }
.modal-header { padding: 20px 24px 0; }
.modal-header h3 { font-size: 16px; font-weight: 600; margin: 0; }
.modal-body { padding: 16px 24px; overflow-y: auto; }
.modal-footer { padding: 12px 24px 20px; display: flex; gap: 8px; justify-content: flex-end; }
.help-section { margin-bottom: 20px; }
.help-section h4 { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: var(--text-primary); }
.help-section p { font-size: 13px; color: var(--text-muted); margin: 0 0 8px; line-height: 1.5; }
.help-code { background: #1e293b; color: #e2e8f0; padding: 10px 14px; border-radius: 8px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 13px; }

.btn { padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; background: white; color: var(--text-primary); }
.btn-sm { padding: 2px 8px; font-size: 12px; }
.btn-primary { background: var(--primary); color: white; border-color: var(--primary); }
.btn-secondary { background: #f5f5f7; }
.btn-danger { background: #fef2f2; border-color: #fecaca; color: #dc2626; }
.btn-outline { background: white; border: 1px solid #e5e7eb; color: var(--text-secondary); }
.btn-outline:hover { background: rgba(99,102,241,0.05); border-color: rgba(99,102,241,0.3); color: var(--primary); }

/* Toggle switch */
.toggle { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle .slider { position: absolute; inset: 0; background: #d1d5db; border-radius: 20px; transition: 0.2s; }
.toggle .slider::before { content: ''; position: absolute; height: 16px; width: 16px; left: 2px; bottom: 2px; background: white; border-radius: 50%; transition: 0.2s; }
.toggle input:checked + .slider { background: var(--primary); }
.toggle input:checked + .slider::before { transform: translateX(16px); }

.task-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }

.backup-list { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
.backup-item { display: flex; align-items: center; gap: 10px; padding: 6px 4px; font-size: 13px; border-bottom: 1px solid var(--border); }
.backup-item:last-child { border-bottom: none; }
.backup-name { flex: 1; font-family: 'SF Mono', 'Consolas', monospace; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.backup-size { font-size: 12px; color: var(--text-muted); min-width: 60px; text-align: right; }
.backup-time { font-size: 12px; color: var(--text-muted); min-width: 140px; }

/* LLM Provider table */
.llm-empty { text-align: center; padding: 32px 16px; }

.kb-lib-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 10px; border: 1px solid var(--border-color, #2a2f3a); border-radius: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.kb-lib-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.kb-lib-name { font-weight: 600; font-size: 13px; }
.kb-lib-badge { font-size: 11px; padding: 1px 7px; border-radius: 8px; background: rgba(34,197,94,.15); color: #22c55e; }
.kb-lib-dir { font-size: 11px; word-break: break-all; }
.kb-lib-count { font-size: 11px; white-space: nowrap; }
.kb-lib-actions { display: flex; gap: 8px; flex-shrink: 0; }
.llm-empty-icon { font-size: 32px; margin-bottom: 8px; }
.llm-provider-table { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.llm-provider-thead {
  display: grid;
  grid-template-columns: 1.2fr 2fr 1fr 0.6fr auto;
  gap: 8px;
  padding: 10px 14px;
  background: var(--hover);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
.llm-provider-row {
  display: grid;
  grid-template-columns: 1.2fr 2fr 1fr 0.6fr auto;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  align-items: center;
  font-size: 13px;
}
.llm-provider-row:last-child { border-bottom: none; }
.llm-provider-row:hover { background: rgba(99,102,241,0.03); }
.llm-prov-name { font-weight: 500; color: var(--text-primary); }
.llm-prov-url { color: var(--text-muted); font-family: monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-prov-type { color: var(--text-secondary); font-size: 12px; }

/* Model edit rows */
.llm-model-edit-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fafbfc;
}
</style>