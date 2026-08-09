<template>
  <div class="coding-workbench">
    <!-- ========== 顶部视图切换（仅全功能模式） ========== -->
    <div v-if="props.view === 'all'" class="workbench-tabs">
      <button class="workbench-tab" :class="{ active: rightTab === 'chat' }" @click="rightTab = 'chat'">💬 对话</button>
      <button class="workbench-tab" :class="{ active: rightTab === 'tasks' }" @click="rightTab = 'tasks'">⏰ 任务</button>
    </div>

    <!-- ========== 对话视图：自带左侧会话列表 ========== -->
    <div v-if="props.view !== 'tasks'" v-show="props.view === 'all' ? rightTab === 'chat' : true" class="wb-view">
      <div class="workbench-sidebar wb-sidebar-chat">
        <div class="sidebar-header">
          <h3 class="sidebar-title">代码库</h3>
          <button class="btn btn-primary btn-xs" @click="openAddProject">+ 代码库</button>
        </div>
        <div class="project-tree" v-if="projects.length">
          <div
            v-for="project in projects"
            :key="project.id"
            class="project-node"
          >
            <div
              class="project-header"
              :class="{ expanded: expandedProjects.has(project.id) }"
            >
              <span class="project-arrow" @click="toggleProject(project.id)">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 4 10 8 6 12"/></svg>
              </span>
              <span class="project-icon" @click="selectProject(project)">📁</span>
              <span class="project-name" @click="selectProject(project)">{{ project.name }}</span>
              <span class="project-actions">
                <span class="project-edit-btn" @click.stop="openEditProject(project)" title="编辑项目">✏️</span>
                <span class="project-delete-btn" @click.stop="deleteProject(project)" title="删除项目">🗑️</span>
              </span>
            </div>

            <div v-if="expandedProjects.has(project.id)" class="conversation-list">
              <div
                v-for="session in sessionsWithoutTask(project.id)"
                :key="session.session_id || session.id"
                class="conversation-item"
                :class="{ active: currentSessionId === (session.session_id || String(session.id)) }"
                @click="selectSession(session)"
              >
                <span class="conv-icon">🗨️</span>
                <span class="conv-title">{{ session.title || '新对话' }}</span>
                <span class="conv-delete" @click.stop="deleteSession(session.session_id || session.id)" title="删除">×</span>
              </div>
              <div class="conversation-item new-conversation" @click="newSession(project.id)">
                <span class="conv-icon">➕</span>
                <span class="conv-title new">新对话</span>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="sidebar-empty">
          <div class="empty-icon">📁</div>
          <div class="empty-text">还没有项目，创建一个开始吧</div>
          <button class="btn btn-primary btn-sm" @click="openAddProject">新建项目</button>
        </div>
      </div>

    <!-- ========== 对话视图主体 ========== -->
    <div class="workbench-chat">
        <!-- 无对话时 -->
        <div v-if="!currentSessionId" class="workbench-empty">
          <div class="empty-icon">💻</div>
          <div class="empty-title">自由对话</div>
          <div class="empty-desc">
            从左侧选择一个项目下的对话，或新建一个对话开始<br>
            数据集查询 · 笔记库检索 · 项目文件操作，一个助理全部搞定
          </div>
        </div>

        <!-- 有对话时 -->
        <template v-else>
          <!-- 对话头部 -->
          <div class="chat-header">
            <div class="chat-header-left">
              <h3 class="chat-title">{{ currentSession?.title || '对话' }}</h3>
              <span class="chat-project-badge" v-if="currentProject">📁 {{ currentProject.name }}</span>
            </div>
            <div class="chat-header-right">
              <button class="btn btn-sm btn-secondary" :disabled="isStreaming" @click="openChangesModal" title="查看该会话在隔离 worktree 中的改动，可合并/提交/丢弃">🛠️ 审查变更</button>
            </div>
          </div>

          <!-- 消息列表 -->
          <div class="chat-messages" ref="messagesContainer">
            <div v-for="(msg, idx) in messages" :key="idx" class="message" :class="msg.role">
              <div class="message-avatar">
                <span v-if="msg.role === 'user'">👤</span>
                <span v-else-if="msg.role === 'tool'">🔧</span>
                <span v-else-if="msg.role === 'system'">⚡</span>
                <span v-else>🤖</span>
              </div>
              <div class="message-content-wrapper">
                <div class="message-header">
                  <span class="message-author">
                    {{ msg.role === 'user' ? '我' : msg.role === 'tool' ? '工具' : msg.role === 'system' ? '系统' : 'AI 助理' }}
                  </span>
                  <span class="message-status" v-if="msg.status">{{ msg.status }}</span>
                </div>
                <div
                  class="message-content"
                  :class="{ 'markdown-body': msg.role === 'assistant' }"
                >
                  <div v-if="thinkingText && idx === messages.length - 1" class="thinking-status">{{ thinkingText }}</div>
                  <div v-if="msg.images?.length" class="message-images">
                      <img v-for="(img, i) in msg.images" :key="i" :src="`data:${img.mimeType};base64,${img.data}`" class="chat-image" />
                    </div>
                  <div v-html="msg.role === 'user' ? escHtml(msg.content) : renderMarkdown(msg.content)"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 输入区 -->
          <div class="chat-input-area">
            <div class="input-wrapper">
              <textarea
                v-model="inputText"
                class="chat-input"
                :placeholder="`输入问题，Enter 发送... (支持 数据集 · 笔记库 · 代码操作)`"
                @keydown.enter.exact.prevent="sendMessage"
                @paste="handlePaste"
                @compositionstart="composing = true"
                @compositionend="composing = false"
                ref="inputRef"
                :disabled="isStreaming"
                rows="1"
              ></textarea>
              <div v-if="pendingImages.length" class="image-preview-bar">
                  <div v-for="(img, i) in pendingImages" :key="i" class="image-preview-item">
                    <img :src="`data:${img.mimeType};base64,${img.data}`" class="image-preview-thumb" />
                    <button class="image-preview-remove" @click="removeImage(i)">×</button>
                  </div>
                </div>
              <div class="input-footer">
                <div class="input-left">
                  <button class="toolbar-btn" @click="handleImageClick" title="上传图片">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                      </svg>
                    </button>
                    <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="handleImageUpload" />
                    <select class="model-selector" v-model="selectedModel" :disabled="isStreaming" title="选择模型">
                      <option value="">默认模型</option>
                      <option v-for="m in piModels" :key="m.pattern" :value="m.pattern">
                        {{ m.providerLabel }} · {{ m.name }}
                      </option>
                    </select>
                  <span class="input-hint">Enter 发送 · Shift+Enter 换行 · AI 驱动</span>
                </div>
                <div class="input-right">
                  <button
                    class="send-btn"
                    :disabled="!inputText.trim() || isStreaming"
                    @click="sendMessage"
                    :title="isStreaming ? '正在处理...' : '发送'"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                      <line x1="22" y1="2" x2="11" y2="13"/>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ========== 任务视图：自带左侧任务列表 ========== -->
    <div v-if="props.view !== 'chat'" v-show="props.view === 'all' ? rightTab === 'tasks' : true" class="wb-view">
      <div class="workbench-sidebar wb-sidebar-tasks">
        <div class="sidebar-header">
          <h3 class="sidebar-title">任务列表</h3>
          <button class="btn btn-primary btn-xs" @click="openAddProject">+ 代码库</button>
        </div>
        <div class="tasks-tree-list">
          <div v-if="projects.length === 0" class="tasks-list-empty">
            <div class="empty-icon">📁</div>
            <div class="empty-text">暂无代码库，点击「+ 代码库」创建</div>
          </div>
          <div
            v-for="project in projects"
            :key="project.id"
            class="project-node"
          >
            <div
              class="project-header"
              :class="{ expanded: taskExpandedProjects.has(project.id), active: projectHasSelectedTask(project.id) }"
              @click="toggleTaskProject(project.id)"
            >
              <span class="project-arrow">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 4 10 8 6 12"/></svg>
              </span>
              <span class="project-icon">📁</span>
              <span class="project-name">{{ project.name }}</span>
              <span v-if="projectTaskList(project.id).length" class="project-count">{{ projectTaskList(project.id).length }}</span>
              <span class="project-actions">
                <span class="project-edit-btn" @click.stop="openEditProject(project)" title="编辑代码库">✏️</span>
                <span class="project-delete-btn" @click.stop="deleteProject(project)" title="删除代码库">🗑️</span>
              </span>
            </div>

            <div v-if="taskExpandedProjects.has(project.id)" class="task-project-body">
              <div v-if="projectTaskList(project.id).length === 0" class="tasks-proj-empty">暂无任务</div>
              <div
                v-for="t in projectTaskList(project.id)"
                :key="t.id"
                class="tasks-list-item"
                :class="{ active: taskSelectedId === t.id, running: t.status === 'in_progress' }"
                @click="selectWorkbenchTask(t)"
              >
                <div class="list-item-head">
                  <span class="list-item-title">{{ t.title }}</span>
                  <span class="task-status-badge" :class="'status-' + t.status">{{ taskStatusText(t.status) }}</span>
                  <span v-if="t.status === 'in_progress'" class="running-dot"></span>
                </div>
                <div class="list-item-meta">{{ taskTriggerText(t) }}</div>
                <div v-if="t.last_run_at" class="list-item-meta list-item-last">
                  最近执行：{{ t.last_run_at }}（{{ t.last_status === 'SUCCESS' ? '成功' : t.last_status === 'FAILED' ? '失败' : t.last_status || '未执行' }}）
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ========== 任务视图主体 ========== -->
      <div class="workbench-tasks">
        <div v-if="!taskSelected" class="tasks-detail-empty">
          <div class="empty-icon">🗂️</div>
          <div class="empty-text">选择左侧任务查看详情</div>
        </div>
        <template v-else>
            <div class="tasks-detail-header">
              <div class="detail-title-wrap">
                <h3 class="tasks-detail-title">{{ taskSelected.title }}</h3>
                <div class="detail-badges">
                  <span class="task-status-badge" :class="'status-' + taskSelected.status">{{ taskStatusText(taskSelected.status) }}</span>
                  <span v-if="taskSelected.last_status === 'FAILED'" class="task-status-badge status-FAILED">执行失败</span>
                  <span v-if="taskSelected.status === 'in_progress'" class="running-dot"></span>
                </div>
              </div>
              <div class="tasks-detail-actions">
                <button class="btn btn-primary btn-sm" :disabled="taskSelected.status === 'in_progress' || taskSelected.followupRunning" @click="runTaskNow(taskSelected)">{{ taskSelected.status === 'in_progress' ? '执行中…' : '▶ 立即执行' }}</button>
                <button class="btn btn-secondary btn-sm" @click="openTaskModal(taskSelected.project_id, taskSelected)">编辑</button>
                <button class="btn btn-secondary btn-sm" @click="gotoTaskSession(taskSelected)">💬 进入对话</button>
                <button class="btn btn-danger btn-sm" @click="deleteTaskFromWorkbench(taskSelected)">删除</button>
              </div>
            </div>

            <div class="tasks-detail-scroll">
              <div class="tasks-detail-info">
                <span class="di-item">📁 {{ projectNameById(taskSelected.project_id) }}</span>
                <span class="di-item">⏱ {{ taskTriggerText(taskSelected) }}</span>
                <span class="di-item">🕐 {{ taskSelected.created_at || '-' }}</span>
              </div>

              <div v-if="taskSelected.prompt" class="tasks-detail-section">
                <div class="section-title">任务诉求</div>
                <div class="prompt-text">{{ taskSelected.prompt }}</div>
              </div>

              <div class="tasks-detail-section">
                <div class="section-title">对话记录</div>
                <div v-if="taskMessages.length === 0" class="empty-sub">暂无对话记录</div>
                <div v-for="(msg, idx) in taskMessages" :key="idx" class="message" :class="msg.role">
                  <div class="message-avatar">
                    <span v-if="msg.role === 'user'">👤</span>
                    <span v-else-if="msg.role === 'assistant'">🤖</span>
                    <span v-else>🔧</span>
                  </div>
                  <div class="message-content-wrapper">
                    <div class="message-header">
                      <span class="message-author">{{ msg.role === 'user' ? '我' : msg.role === 'assistant' ? 'AI 助理' : msg.role === 'tool' ? '工具' : '系统' }}</span>
                    </div>
                    <div class="message-content" :class="{ 'markdown-body': msg.role === 'assistant' }">
                      <div v-html="msg.role === 'user' ? escHtml(msg.content) : renderMarkdown(msg.content)"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="tasks-detail-section">
                <div class="section-title">执行记录</div>
                <div v-if="taskExecutions.length === 0" class="empty-sub">暂无执行记录</div>
                <div v-for="ex in taskExecutions" :key="ex.id" class="execution-card">
                  <div class="exec-header">
                    <span class="task-status-badge" :class="'status-' + ex.status">{{ ex.status }}</span>
                    <span class="exec-trigger">{{ triggerLabel(ex.trigger_type) }}</span>
                    <span class="exec-time">{{ ex.start_time }}</span>
                    <span v-if="ex.end_time" class="exec-time">→ {{ ex.end_time }}</span>
                  </div>
                  <div v-if="ex.error_message" class="exec-error">❌ {{ ex.error_message }}</div>
                  <div v-if="ex.result_text" class="exec-result markdown-body" v-html="renderMarkdown(ex.result_text)"></div>
                </div>
              </div>

              <div class="tasks-detail-section">
                <div class="section-title">追问</div>
                <div v-if="taskSelected.followupDone" class="followup-reply markdown-body" v-html="renderMarkdown(taskSelected.followupReply)"></div>
                <div v-if="taskSelected.followupRunning" class="followup-reply markdown-body followup-streaming" v-html="renderMarkdown(taskSelected.followupReply)"></div>
                <div class="followup-input-row">
                  <textarea
                    v-model="taskSelected.followupText"
                    class="followup-input"
                    rows="2"
                    placeholder="输入追问内容，将沿用该任务的原对话上下文继续执行…"
                    @keydown.enter.exact.prevent="sendTaskFollowup(taskSelected)"
                  ></textarea>
                  <button class="btn btn-primary btn-sm" :disabled="!(taskSelected.followupText || '').trim() || taskSelected.followupRunning" @click="sendTaskFollowup(taskSelected)">{{ taskSelected.followupRunning ? '执行中…' : '发送' }}</button>
                </div>
              </div>
            </div>
          </template>
      </div>
    </div>

      <!-- 项目详情弹窗 -->
      <div v-if="showDetailModal" class="modal-overlay" @click.self="closeDetailModal">
        <div class="project-detail-modal">
          <div class="project-detail-header">
            <span class="project-detail-icon">📁</span>
            <span class="project-detail-name">{{ detailProject?.name }}</span>
            <button class="modal-close" @click="closeDetailModal">✕</button>
          </div>
          <div class="project-detail-body">
            <div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">{{ detailProject?.type }}</span></div>
            <div class="detail-row"><span class="detail-label">文件夹</span><span class="detail-value">{{ detailProject?.dir || '未设置' }}</span></div>
            <div class="detail-row" v-if="detailProject?.description"><span class="detail-label">描述</span><span class="detail-value">{{ detailProject?.description }}</span></div>
          </div>
        </div>
      </div>

      <!-- 变更审查弹窗 -->
      <div v-if="showChangesModal" class="modal-overlay" @click.self="closeChangesModal">
        <div class="modal-box changes-modal" @click.stop>
          <div class="modal-header">
            <h3>🛠️ 变更审查</h3>
            <button class="modal-close" @click="closeChangesModal">&times;</button>
          </div>
          <div class="modal-body">
            <div v-if="changesLoading" class="changes-loading">正在收集改动...</div>
            <template v-else-if="changesError">
              <div class="changes-error">{{ changesError }}</div>
            </template>
            <template v-else>
              <div class="changes-meta" v-if="changes">
                <span class="meta-badge" :class="{ isolated: changes.isolated }">{{ changes.isolated ? '🔒 隔离 worktree' : '📂 原目录执行' }}</span>
                <span class="meta-badge">{{ changes.integrationStatus === 'integrated' ? '✅ 已合并' : changes.integrationStatus === 'pending_review' ? '⏳ 待提交' : '🧩 待合并' }}</span>
                <span class="meta-badge" v-if="changes.pendingCommits">⬆ {{ changes.pendingCommits }} 待合并提交</span>
              </div>
              <div class="changes-summary" v-if="changes && changes.files">
                <span>改动文件: {{ changes.files.length }}</span>
                <span v-if="changes.latestCommit">最近提交: {{ changes.latestCommit.message.slice(0, 40) }}</span>
              </div>
              <div class="changes-files" v-if="changes && changes.files.length">
                <div v-for="(f, i) in changes.files" :key="i" class="change-file">
                  <span class="change-type" :class="f.changeType">{{ typeLabel(f.changeType) }}</span>
                  <span class="change-path">{{ f.path }}</span>
                  <span class="change-stat" v-if="!f.binary">+{{ f.additions }} -{{ f.deletions }}</span>
                </div>
              </div>
              <div class="changes-diff" v-if="changes && changes.diff">
                <pre>{{ changes.diff.slice(0, 30000) }}</pre>
              </div>
            </template>
          </div>
          <div class="modal-footer changes-actions">
            <span class="changes-hint" v-if="changes && changes.isolated">改动合并到主项目后仍不提交，需手动提交</span>
            <button class="btn btn-secondary" @click="closeChangesModal">关闭</button>
            <button v-if="changes?.integrationStatus === 'not_applied'" class="btn btn-primary" :disabled="changesBusy" @click="doApply">合并到主项目</button>
            <button v-if="changes?.integrationStatus === 'pending_review'" class="btn btn-primary" :disabled="changesBusy" @click="doCommit">提交变更</button>
            <button v-if="changes?.integrationStatus === 'pending_review'" class="btn btn-secondary" :disabled="changesBusy" @click="doAbort">撤销合并</button>
            <button class="btn btn-danger" :disabled="changesBusy" @click="doDiscard">丢弃改动</button>
          </div>
        </div>
      </div>

    <!-- ========== 新建/编辑项目弹窗 ========== -->
    <div v-if="showProjectModal" class="modal-overlay" @click.self="closeProjectModal">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>{{ editingProject ? '编辑项目' : '新建项目' }}</h3>
          <button class="modal-close" @click="closeProjectModal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>项目名称 *</label>
            <input v-model="projectForm.name" class="form-control" placeholder="例如: CRM系统">
          </div>
          <div class="form-group">
            <label>类型</label>
            <div class="type-radio-group">
              <label class="type-radio" :class="{ active: projectForm.type === 'code' }">
                <input type="radio" v-model="projectForm.type" value="code"> 代码库
              </label>
            </div>
          </div>
          <div class="form-group">
            <label>描述</label>
            <textarea v-model="projectForm.description" class="form-control" rows="2" placeholder="项目描述"></textarea>
          </div>
          <div class="form-group">
            <label>目录</label>
            <div class="input-with-btn">
              <input v-model="projectForm.dir" class="form-control" placeholder="选择目录..." readonly>
              <button class="btn btn-secondary" @click="pickFolder">选择</button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="closeProjectModal">取消</button>
          <button class="btn btn-primary" :disabled="!projectForm.name.trim()" @click="saveProject">
            {{ editingProject ? '保存' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ========== 定时任务弹窗 ========== -->
    <div v-if="showTaskModal" class="modal-overlay" @click.self="closeTaskModal">
      <div class="modal-box task-modal" @click.stop>
        <div class="modal-header">
          <h3>{{ taskIsEditing ? '编辑定时任务' : '新建定时任务' }}</h3>
          <button class="modal-close" @click="closeTaskModal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>归属项目 *</label>
            <select class="form-control" v-model="taskForm.project_id" :disabled="taskIsEditing">
              <option :value="null" disabled>请选择项目</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>任务标题 *</label>
            <input v-model="taskForm.title" class="form-control" placeholder="例如：每日代码审查 / 修复登录超时">
          </div>
          <div class="form-group">
            <label>任务诉求（AI 将据此执行）</label>
            <textarea v-model="taskForm.prompt" class="form-control" rows="4" placeholder="描述要让 AI 做什么"></textarea>
          </div>
          <div class="form-group">
            <label>执行方式</label>
            <select class="form-control" v-model="taskForm.trigger_type">
              <option value="now">⚡ 立即执行 - 创建后马上运行</option>
              <option value="once">⏰ 指定时间 - 到点执行一次</option>
              <option value="cycle">🔁 定时循环 - 按周期自动执行</option>
            </select>
          </div>
          <div class="form-row" v-if="taskForm.trigger_type === 'once'">
            <div class="form-group">
              <label>执行时间 *</label>
              <input type="datetime-local" class="form-control" v-model="taskForm.scheduled_start">
            </div>
          </div>
          <template v-if="taskForm.trigger_type === 'cycle'">
            <div class="form-row">
              <div class="form-group">
                <label>循环类型</label>
                <select class="form-control" v-model="taskForm.cycle_type">
                  <option value="daily">📅 每天</option>
                  <option value="weekly">📆 每周</option>
                  <option value="monthly">🗓️ 每月</option>
                  <option value="cron">⚙️ Cron 表达式</option>
                </select>
              </div>
              <div class="form-group" v-if="taskForm.cycle_type !== 'cron'">
                <label>执行时间</label>
                <input type="time" class="form-control" v-model="taskForm.cycle_time">
              </div>
            </div>
            <div class="form-group" v-if="taskForm.cycle_type === 'weekly'">
              <label>星期几（可多选）</label>
              <div class="week-select">
                <label v-for="d in weekDays" :key="d.value" class="week-chip">
                  <input type="checkbox" :value="d.value" v-model="taskWeekDays">
                  {{ d.label }}
                </label>
              </div>
            </div>
            <div class="form-group" v-if="taskForm.cycle_type === 'monthly'">
              <label>每月几号</label>
              <input type="number" class="form-control" v-model.number="taskMonthDays" min="1" max="31" placeholder="如 1 或 1,15">
            </div>
            <div class="form-group" v-if="taskForm.cycle_type === 'cron'">
              <label>Cron 表达式</label>
              <input type="text" class="form-control" v-model="taskForm.cycle_value" placeholder="如 0 9 * * *（每天早上 9 点）">
            </div>
          </template>
          <div class="form-group">
            <label>&nbsp;</label>
            <label class="check-item">
              <input type="checkbox" v-model="taskForm.notify_feishu">
              完成后推送飞书
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="closeTaskModal">取消</button>
          <button class="btn btn-danger" v-if="taskIsEditing" @click="deleteTaskFromWorkbench(taskEditingTask)">🗑️ 删除</button>
          <button class="btn btn-primary" :disabled="!taskForm.title.trim()" @click="saveTaskModal">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, onBeforeUnmount } from 'vue';
import { marked } from 'marked';

const API = window.electronAPI;

const props = defineProps<{ view?: 'all' | 'chat' | 'tasks' }>();
const emit = defineEmits<{ (e: 'go-chat', task: any): void }>();

// ========== 状态 ==========
const projects = ref<any[]>([]);
const selectedProject = ref<any>(null);
const showDetailModal = ref(false);
const detailProject = ref<any>(null);
const expandedProjects = reactive(new Set<number>());
const projectSessions = reactive<Record<number, any[]>>({});
const currentSessionId = ref('');
const currentSession = ref<any>(null);
const messages = ref<any[]>([]);
const inputText = ref('');
const isStreaming = ref(false);
const composing = ref(false);
const thinkingText = ref('');
const inputRef = ref<HTMLTextAreaElement>();
const messagesContainer = ref<HTMLElement>();
const pendingImages = ref<{ data: string; mimeType: string }[]>([]);const fileInputRef = ref<HTMLInputElement | null>(null);
const showProjectModal = ref(false);
const editingProject = ref<any>(null);
const projectForm = ref({ name: '', description: '', dir: '', type: 'code' });
const piModels = ref<{ provider: string; providerLabel: string; id: string; name: string; pattern: string; configured: boolean }[]>([]);
const selectedModel = ref('');
const WORKBENCH_MODEL_KEY = 'workbench_model';

// ========== 计算属性 ==========
const currentProject = computed(() => {
  if (!currentSession.value?.project_id) return null;
  return projects.value.find(p => p.id === currentSession.value.project_id) || null;
});

// ========== 加载数据 ==========
async function loadProjects() {
  try {
    projects.value = await API.project.list('code');
  } catch { projects.value = []; }
}

async function loadPiModels() {
  try {
    const res = await API.pi.models();
    piModels.value = (res?.models || []).filter((m) => m.pattern);
    const saved = localStorage.getItem(WORKBENCH_MODEL_KEY);
    if (saved && piModels.value.some((m) => m.pattern === saved)) {
      selectedModel.value = saved;
    } else if (!selectedModel.value && piModels.value.some((m) => m.configured)) {
      // 已配置模型但没有历史选择时，默认选中第一个，降低使用门槛
      const first = piModels.value.find((m) => m.configured);
      if (first) selectedModel.value = first.pattern;
    }
  } catch { piModels.value = []; }
}

async function loadSessions(projectId: number) {
  try {
    const sessions = await API.coding.listSessionsByProject(String(projectId));
    projectSessions[projectId] = sessions || [];
  } catch {
    projectSessions[projectId] = [];
  }
}

// ========== 定时任务 ==========
const codeTasks = ref<any[]>([]);

async function loadTasks() {
  try {
    const list = await API.task.list();
    const codeIds = new Set(projects.value.map(p => p.id));
    codeTasks.value = (list || []).filter(t => codeIds.has(Number(t.project_id)) && t.source === 'feishu');
    if (codeTasks.value.length) {
      for (const t of codeTasks.value) {
        expandedProjects.add(Number(t.project_id));
        taskExpandedProjects.add(Number(t.project_id));
      }
    }
  } catch { codeTasks.value = []; }
}

function projectTaskList(projectId: number) {
  return codeTasks.value
    .filter(t => Number(t.project_id) === Number(projectId))
    .sort((a: any, b: any) => {
      const ta = a.created_at || '';
      const tb = b.created_at || '';
      if (ta !== tb) return ta < tb ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
}

function matchedSessionForTask(task: any) {
  if (!task.session_id) return null;
  const sessions = projectSessions[task.project_id] || [];
  return sessions.find((s: any) => s.session_id === task.session_id) || null;
}

function sessionsWithoutTask(projectId: number) {
  const sessions = projectSessions[projectId] || [];
  const taskSessionIds = new Set(projectTaskList(projectId).map(t => t.session_id).filter(Boolean));
  return sessions.filter((s: any) => !taskSessionIds.has(s.session_id));
}

// ========== 右侧任务 Tab ==========
const rightTab = ref<'chat' | 'tasks'>('chat');

const taskSelectedId = ref<number | null>(null);
const taskMessages = ref<any[]>([]);
const taskExecutions = ref<any[]>([]);
const taskExpandedProjects = reactive(new Set<number>());

const taskSelected = computed(() => {
  if (taskSelectedId.value === null) return null;
  return codeTasks.value.find(t => t.id === taskSelectedId.value) || null;
});

function toggleTaskProject(projectId: number) {
  if (taskExpandedProjects.has(projectId)) {
    taskExpandedProjects.delete(projectId);
  } else {
    taskExpandedProjects.add(projectId);
  }
}

function projectHasSelectedTask(projectId: number): boolean {
  if (taskSelectedId.value === null) return false;
  const t = codeTasks.value.find(x => x.id === taskSelectedId.value);
  return !!t && Number(t.project_id) === Number(projectId);
}

function selectWorkbenchTask(t: any) {
  taskSelectedId.value = t.id;
  if (t.followupText === undefined) t.followupText = '';
  if (t.followupReply === undefined) t.followupReply = '';
  if (t.followupRunning === undefined) t.followupRunning = false;
  if (t.followupDone === undefined) t.followupDone = false;
  loadTaskDetail();
}

async function loadTaskDetail() {
  const t = taskSelected.value;
  if (!t) { taskMessages.value = []; taskExecutions.value = []; return; }
  if (t.session_id) {
    try { taskMessages.value = await API.coding.getMessages(t.session_id); } catch { taskMessages.value = []; }
  } else {
    taskMessages.value = [];
  }
  try { taskExecutions.value = await API.task.executions(t.id); } catch { taskExecutions.value = []; }
}

function ensureTaskSelected() {
  const list = codeTasks.value;
  if (list.length === 0) {
    taskSelectedId.value = null;
    taskMessages.value = [];
    taskExecutions.value = [];
    return;
  }
  if (taskSelectedId.value === null || !list.some(t => t.id === taskSelectedId.value)) {
    taskSelectedId.value = list[0].id;
  }
  loadTaskDetail();
}

async function gotoTaskSession(task: any) {
  let session = matchedSessionForTask(task);
  if (!session) {
    await loadSessions(task.project_id);
    session = matchedSessionForTask(task);
  }
  if (!session) {
    alert('该任务尚未执行，先点击「▶ 立即执行」，执行后会生成对应对话');
    return;
  }
  if (props.view === 'tasks') {
    emit('go-chat', task);
    return;
  }
  rightTab.value = 'chat';
  await selectSession(session);
}

function openTaskSession(task: any) {
  gotoTaskSession(task);
}

defineExpose({ openTaskSession });

async function runTaskNow(task: any) {
  try {
    await API.task.execute(task.id);
    await loadTasks();
    await loadTaskDetail();
    await reloadExpandedSessions();
  } catch (e: any) { alert('执行失败: ' + (e.message || e)); }
}

async function deleteTaskFromWorkbench(task: any) {
  if (!confirm(`确定删除任务「${task.title}」吗？此操作不可撤销。`)) return;
  try {
    await API.task.remove(task.id);
    await loadTasks();
    await reloadExpandedSessions();
    ensureTaskSelected();
  } catch (e: any) { alert('删除失败: ' + (e.message || e)); }
}

async function reloadExpandedSessions() {
  for (const pid of Array.from(expandedProjects)) {
    await loadSessions(pid);
  }
}

function taskStatusText(status: string): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'in_progress': return '执行中';
    case 'done': return '已完成';
    default: return status;
  }
}

function taskTriggerText(t: any): string {
  if (t.trigger_type === 'once') return '指定时间 ' + (t.scheduled_start || '未设置');
  if (t.trigger_type === 'cycle') {
    switch (t.cycle_type) {
      case 'weekly': return '每周' + (t.cycle_value || '') + ' ' + (t.cycle_time || '');
      case 'monthly': return '每月' + (t.cycle_value || '') + '号 ' + (t.cycle_time || '');
      case 'cron': return 'Cron ' + (t.cycle_value || '');
      default: return '每天 ' + (t.cycle_time || '');
    }
  }
  return '立即执行';
}

function projectNameById(pid: number | null): string {
  if (pid == null) return '';
  const p = projects.value.find(x => x.id === Number(pid));
  return p ? p.name : '';
}

function triggerLabel(type: string): string {
  switch (type) {
    case 'manual': return '立即';
    case 'scheduled': return '定时';
    default: return type;
  }
}

// ========== 定时任务弹窗 ==========
const showTaskModal = ref(false);
const taskIsEditing = ref(false);
const taskEditingTask = ref<any>(null);
const taskForm = ref<any>({});
const taskWeekDays = ref<number[]>([]);
const taskMonthDays = ref<number | string>(1);

const weekDays = [
  { label: '周一', value: 1 }, { label: '周二', value: 2 }, { label: '周三', value: 3 },
  { label: '周四', value: 4 }, { label: '周五', value: 5 }, { label: '周六', value: 6 },
  { label: '周日', value: 0 },
];

function openTaskModal(projectId: number, task?: any) {
  taskIsEditing.value = !!task;
  taskEditingTask.value = task || null;
  if (task) {
    taskForm.value = {
      project_id: task.project_id, title: task.title, prompt: task.prompt,
      trigger_type: task.trigger_type, scheduled_start: task.scheduled_start || '',
      cycle_type: task.cycle_type || 'daily', cycle_value: task.cycle_value || '',
      cycle_time: task.cycle_time || '09:00', notify_feishu: !!task.notify_feishu,
    };
    taskWeekDays.value = String(task.cycle_value || '').split(',').filter(Boolean).map(Number);
    taskMonthDays.value = task.cycle_value || 1;
  } else {
    taskForm.value = {
      project_id: projectId, title: '', prompt: '', trigger_type: 'now',
      scheduled_start: '', cycle_type: 'daily', cycle_value: '', cycle_time: '09:00',
      notify_feishu: false,
    };
    taskWeekDays.value = [];
    taskMonthDays.value = 1;
  }
  showTaskModal.value = true;
}

function closeTaskModal() {
  showTaskModal.value = false;
  taskEditingTask.value = null;
}

async function saveTaskModal() {
  const t = taskForm.value;
  if (!t.project_id) { alert('请选择归属项目'); return; }
  if (!t.title.trim()) { alert('请输入任务标题'); return; }
  if (t.trigger_type === 'once' && !t.scheduled_start) { alert('指定时间任务请选择执行时间'); return; }
  let cycleValue = t.cycle_value || '';
  if (t.cycle_type === 'weekly') cycleValue = taskWeekDays.value.join(',');
  if (t.cycle_type === 'monthly') cycleValue = String(taskMonthDays.value || 1);
  const data = {
    title: t.title,
    prompt: t.prompt,
    task_type: 'coding',
    project_id: t.project_id,
    trigger_type: t.trigger_type,
    scheduled_start: t.trigger_type === 'once' ? t.scheduled_start : '',
    cycle_type: t.trigger_type === 'cycle' ? t.cycle_type : '',
    cycle_value: t.trigger_type === 'cycle' ? cycleValue : '',
    cycle_time: t.trigger_type === 'cycle' ? t.cycle_time : '',
    output_target: '',
    notify_feishu: t.notify_feishu ? 1 : 0,
    status: 'pending',
  };
  try {
    if (taskIsEditing.value) {
      await API.task.update(taskEditingTask.value.id, data);
    } else {
      const r = await API.task.add(data);
      if (data.trigger_type === 'now') await API.task.execute(r.id);
    }
    showTaskModal.value = false;
    taskEditingTask.value = null;
    await loadTasks();
    await reloadExpandedSessions();
  } catch (e: any) { alert('操作失败: ' + (e.message || e)); }
}

// ========== 任务追问 ==========
async function sendTaskFollowup(task: any) {
  const q = (task.followupText || '').trim();
  if (!q || task.followupRunning) return;
  task.followupText = '';
  task.followupRunning = true;
  task.followupDone = false;
  task.followupReply = '> ' + q + '\n\n';
  try {
    const ok = await API.task.followup(task.id, q);
    if (!ok) {
      task.followupRunning = false;
      task.followupReply += '\n❌ 追问失败：任务不存在或正在执行中';
    }
  } catch (e: any) {
    task.followupRunning = false;
    task.followupDone = true;
    task.followupReply += '\n❌ ' + (e.message || e);
  }
}

function handleTaskFollowupDelta(payload: any) {
  const t = codeTasks.value.find((x: any) => x.id === payload.taskId);
  if (t && t.followupRunning) t.followupReply += payload.delta;
}

function handleTaskFollowupDone(payload: any) {
  const t = codeTasks.value.find((x: any) => x.id === payload.taskId);
  if (t) { t.followupRunning = false; t.followupDone = true; t.followupReply = payload.text || t.followupReply; }
  loadTasks();
}

function handleTaskFollowupError(payload: any) {
  const t = codeTasks.value.find((x: any) => x.id === payload.taskId);
  if (t) { t.followupRunning = false; t.followupDone = true; t.followupReply += '\n\n❌ ' + (payload.error || '执行出错'); }
  loadTasks();
}

function onTaskChanged() {
  loadTasks();
  reloadExpandedSessions();
  ensureTaskSelected();
}

async function loadMessages(sessionId: string) {
  try {
    const msgs = await API.coding.getMessages(sessionId);
    messages.value = msgs.map((m: any) => ({
      role: m.role,
      content: m.content,
      mode: m.mode,
      images: m.images || undefined,
    }));
    // 从数据库加载的消息中如果有图片，解析出来
    for (const m of messages.value) {
      if (m.images && typeof m.images === 'string') {
        try { m.images = JSON.parse(m.images); } catch { m.images = undefined; }
      }
    }
  } catch {
    messages.value = [];
  }
  scrollToBottom();
}

// ========== 项目选择 ==========
function selectProject(project: any) {
  selectedProject.value = project;
  detailProject.value = project;
  showDetailModal.value = true;
  if (!projectSessions[project.id]) {
    loadSessions(project.id);
  }
}

function closeDetailModal() {
  showDetailModal.value = false;
  detailProject.value = null;
}

// ========== 项目展开/折叠 ==========
function toggleProject(projectId: number) {
  if (expandedProjects.has(projectId)) {
    expandedProjects.delete(projectId);
  } else {
    expandedProjects.add(projectId);
    if (!projectSessions[projectId]) {
      loadSessions(projectId);
    }
  }
}

// ========== 对话选择 ==========
async function selectSession(session: any) {
  if (isStreaming.value) return;
  rightTab.value = 'chat';
  currentSessionId.value = session.session_id || String(session.id);
  currentSession.value = session;
  await loadMessages(currentSessionId.value);
  saveCodingState();
}

async function newSession(projectId: number) {
  if (isStreaming.value) return;
  const id = 'coding_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    const session = await API.coding.createSession(id, String(projectId), '新对话', 'general');
    currentSessionId.value = id;
    currentSession.value = session;
    messages.value = [];
    inputText.value = '';
    await loadSessions(projectId);
    selectedProject.value = projects.value.find(p => p.id === projectId) || null;
    nextTick(() => inputRef.value?.focus());
  } catch (e: any) {
    console.error('创建对话失败:', e);
  }
}

async function deleteSession(sessionId: string) {
  if (!confirm('确定删除此对话？')) return;
  try {
    await API.coding.deleteSession(sessionId);
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = '';
      currentSession.value = null;
      messages.value = [];
    }
    // 刷新所有项目的对话列表
    for (const pid of Object.keys(projectSessions)) {
      loadSessions(Number(pid));
    }
  } catch (e: any) {
    console.error('删除失败:', e);
  }
}

// ========== 状态持久化 ==========
const CODING_STATE_KEY = "coding_workbench_state";

function saveCodingState() {
  if (!currentSessionId.value) return;
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  try {
    localStorage.setItem(CODING_STATE_KEY, JSON.stringify({
      sessionId: currentSessionId.value,
      projectId: projectId,
    }));
  } catch (e) {
    console.error("保存工作台状态失败:", e);
  }
}

async function restoreCodingState() {
  try {
    const saved = localStorage.getItem(CODING_STATE_KEY);
    if (!saved) return false;
    const { sessionId, projectId } = JSON.parse(saved);
    if (!sessionId || !projectId) return false;
    
    // 找到对应的项目
    const project = projects.value.find((p) => p.id === projectId);
    if (!project) return false;
    
    // 展开项目并加载对话列表
    selectedProject.value = project;
    await loadSessions(projectId);
    
    // 找到对应的对话（兼容 session_id 和 id 两种存储格式）
    const sessions = projectSessions[projectId] || [];
    const session = sessions.find((s) => s.session_id === sessionId || String(s.id) === String(sessionId));
    if (!session) return false;
    
    // 恢复选中状态
    currentSessionId.value = session.session_id || String(session.id);
    currentSession.value = session;
    await loadMessages(currentSessionId.value);
    
    return true;
  } catch (e) {
    console.error("恢复工作台状态失败:", e);
    return false;
  }
}

// ========== 图片处理 ==========
function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const base64 = dataUrl.split(',')[1];
        pendingImages.value.push({ data: base64, mimeType: file.type });
      };
      reader.readAsDataURL(file);
    }
  }
}

function handleImageClick() {
  fileInputRef.value?.click();
}

function handleImageUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files) return;
  for (const file of Array.from(input.files)) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const base64 = dataUrl.split(',')[1];
      pendingImages.value.push({ data: base64, mimeType: file.type });
    };
    reader.readAsDataURL(file);
  }
  input.value = '';
}

function removeImage(index: number) {
  pendingImages.value.splice(index, 1);
}


// ========== 发送消息 ==========
function pushSystemMessage(content: string) {
  messages.value.push({ role: 'system', content, status: '' });
  scrollToBottom();
}

async function sendMessage() {
  const text = inputText.value.trim();
  if ((!text && !pendingImages.value.length) || isStreaming.value) return;

  if (!currentSessionId.value) {
    // 如果还没有对话，找第一个项目自动创建
    if (projects.value.length === 0) {
      openAddProject();
      return;
    }
    const firstProject = projects.value[0];
    if (!firstProject) return;
    selectedProject.value = firstProject;
    await loadSessions(firstProject.id);
    await newSession(firstProject.id);
    // 等 session 创建完成后再发送
    nextTick(() => {
      inputText.value = text;
      doSend(text);
    });
    return;
  }

  doSend(text);
}

async function doSend(text: string) {
  // 获取待发送的图片并清空预览
  const images = pendingImages.value.map(img => ({ data: img.data, mimeType: img.mimeType }));
  pendingImages.value = [];

  const userMsg: any = { role: 'user', content: text };
  if (images.length) {
    userMsg.images = images;
  }
  messages.value.push(userMsg);

  inputText.value = '';
  autoResizeTextarea();

  const msgIdx = messages.value.length;
  messages.value.push({
    role: 'assistant',
    content: '',
    status: '准备中...',
  });

  isStreaming.value = true;
  scrollToBottom();

  const sid = currentSessionId.value;
  const projectDir = currentProject.value?.dir || '';

  // 清理旧的事件监听器（避免泄漏）
  API.removeAllListeners('coding:delta');
  API.removeAllListeners('coding:status');
  API.removeAllListeners('coding:tool');
  API.removeAllListeners('coding:done');
  API.removeAllListeners('coding:error');

  // 注册事件监听
  const onDelta = (data: { sessionId: string; text: string }) => {
    if (data.sessionId !== sid) return;
    const msg = messages.value[msgIdx];
    if (msg) {
      msg.content += data.text;
      msg.status = '';
    }
    scrollToBottom();
  };

  const onStatus = (data: { sessionId: string; text: string }) => {
    if (data.sessionId !== sid) return;
    const msg = messages.value[msgIdx];
    if (msg) msg.status = data.text;
  };

  const onTool = (data: { sessionId: string; type: string; name: string; text?: string; error?: boolean }) => {
    if (data.sessionId !== sid) return;
    if (data.type === 'thinking') {
      thinkingText.value = `💭 ${data.text || ''}`;
    } else if (data.type === 'start') {
      thinkingText.value = `🔧 正在执行: ${data.name}`;
    } else if (data.type === 'end') {
      thinkingText.value = `${data.error ? '❌' : '✅'} ${data.name} ${data.error ? '失败' : '完成'}`;
    }
    scrollToBottom();
  };

  const onDone = (data: { sessionId: string }) => {
    if (data.sessionId !== sid) return;
    isStreaming.value = false;
    const msg = messages.value[msgIdx];
    if (msg) msg.status = '✓ 完成';
    thinkingText.value = '';
    scrollToBottom();
    // 刷新对话列表（更新标题等）
    if (currentProject.value) {
      loadSessions(currentProject.value.id);
    }
    // 清理监听器
    API.removeAllListeners('coding:delta');
    API.removeAllListeners('coding:status');
    API.removeAllListeners('coding:tool');
    API.removeAllListeners('coding:done');
    API.removeAllListeners('coding:error');
  };

  const onError = (data: { sessionId: string; text: string }) => {
    if (data.sessionId !== sid) return;
    isStreaming.value = false;
    const msg = messages.value[msgIdx];
    if (msg) {
      msg.content = '❌ ' + data.text;
      msg.status = '错误';
    }
    scrollToBottom();
    // 清理监听器
    API.removeAllListeners('coding:delta');
    API.removeAllListeners('coding:status');
    API.removeAllListeners('coding:tool');
    API.removeAllListeners('coding:done');
    API.removeAllListeners('coding:error');
  };

  API.on('coding:delta', onDelta);
  API.on('coding:status', onStatus);
  API.on('coding:tool', onTool);
  API.on('coding:done', onDone);
  API.on('coding:error', onError);

  try {
    await API.coding.send(text, sid, projectDir, undefined, images.length ? images : undefined, selectedModel.value || undefined);
    if (selectedModel.value) localStorage.setItem(WORKBENCH_MODEL_KEY, selectedModel.value);
    else localStorage.removeItem(WORKBENCH_MODEL_KEY);
  } catch (err: any) {
    isStreaming.value = false;
    const msg = messages.value[msgIdx];
    if (msg) msg.content = '❌ ' + (err.message || '发送失败');
    // 清理监听器
    API.removeAllListeners('coding:delta');
    API.removeAllListeners('coding:status');
    API.removeAllListeners('coding:tool');
    API.removeAllListeners('coding:done');
    API.removeAllListeners('coding:error');
  }
}

// ========== 工具函数 ==========
const renderMarkdown = (content: string) => {
  if (!content) return '';
  try {
    return marked(content);
  } catch {
    return escHtml(content).replace(/\n/g, '<br>');
  }
};

const escHtml = (text: string) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
};

const autoResizeTextarea = () => {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto';
    inputRef.value.style.height = Math.min(inputRef.value.scrollHeight, 120) + 'px';
  }
};

// ========== 变更审查 ==========
const showChangesModal = ref(false);
const changesLoading = ref(false);
const changesBusy = ref(false);
const changesError = ref('');
const changes = ref<any>(null);

async function openChangesModal() {
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  showChangesModal.value = true;
  changesError.value = '';
  changes.value = null;
  await refreshChanges(projectId);
}

async function refreshChanges(projectId: number) {
  changesLoading.value = true;
  changesError.value = '';
  try {
    const res = await API.coding.changes(currentSessionId.value, projectId);
    if (res?.ok) changes.value = res.changes;
    else changesError.value = res?.error || '收集失败';
  } catch (e: any) {
    changesError.value = e.message || '收集失败';
  } finally {
    changesLoading.value = false;
  }
}

function typeLabel(t: string) {
  return ({ added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' } as any)[t] || t;
}

async function runChangesAction(action: () => Promise<any>, okText: string) {
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  changesBusy.value = true;
  try {
    const res = await action();
    if (res?.ok) {
      alert(okText);
      await refreshChanges(projectId);
    } else {
      alert(res?.error || '操作失败');
    }
  } catch (e: any) {
    alert(e.message || '操作失败');
  } finally {
    changesBusy.value = false;
  }
}

function doApply() {
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  if (!confirm('将 worktree 改动合并进主项目（staged，不提交）。确定？')) return;
  runChangesAction(() => API.coding.applyChanges(currentSessionId.value, projectId), '已合并到主项目（待提交）');
}

function doCommit() {
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  if (!confirm('提交变更到主项目本地分支？')) return;
  runChangesAction(() => API.coding.commitChanges(currentSessionId.value, projectId), '已提交');
}

function doAbort() {
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  if (!confirm('撤销主项目中待提交的合并？')) return;
  runChangesAction(() => API.coding.abortChanges(currentSessionId.value, projectId), '已撤销合并');
}

function doDiscard() {
  const projectId = currentSession.value?.project_id;
  if (!projectId) return;
  if (!confirm('将丢弃 worktree 中的全部改动（不可恢复）。确定？')) return;
  runChangesAction(() => API.coding.discardChanges(currentSessionId.value, projectId), '已丢弃改动');
}

function closeChangesModal() {
  showChangesModal.value = false;
  changes.value = null;
}

// ========== 项目弹窗 ==========
function openAddProject() {
  editingProject.value = null;
  projectForm.value = { name: '', description: '', dir: '', type: 'code' };
  showProjectModal.value = true;
}

function openEditProject(project: any) {
  editingProject.value = project;
  projectForm.value = {
    name: project.name || '',
    description: project.description || '',
    dir: project.dir || '',
    type: project.type || 'code',
  };
  showProjectModal.value = true;
}

function closeProjectModal() {
  showProjectModal.value = false;
  editingProject.value = null;
}

async function pickFolder() {
  try {
    const dir = await API.dialog.openDirectory();
    if (dir) projectForm.value.dir = dir;
  } catch {}
}

async function saveProject() {
  if (!projectForm.value.name.trim()) return;
  try {
    if (editingProject.value) {
      await API.project.update(editingProject.value.id, projectForm.value);
    } else {
      await API.project.add(projectForm.value.name, projectForm.value.type || 'code', projectForm.value.dir, projectForm.value.description);
    }
    closeProjectModal();
    await loadProjects();
    await loadTasks();
    // 选中新项目
    if (projects.value.length > 0 && !editingProject.value) {
      const firstProject = projects.value[0];
      if (firstProject) {
        selectedProject.value = firstProject;
        loadSessions(firstProject.id);
      }
    }
  } catch (e: any) {
    alert('保存失败: ' + (e.message || ''));
  }
}

async function deleteProject(project: any) {
  if (!confirm(`确定删除项目「${project.name}」？
此操作不会删除对话记录，但项目下的对话将无法通过项目树访问。`)) return;
  try {
    await API.project.delete(project.id);
    // 如果当前选中的对话属于这个项目，清空
    if (currentProject.value?.id === project.id) {
      currentSessionId.value = '';
      currentSession.value = null;
      messages.value = [];
    }
    if (selectedProject.value?.id === project.id) {
      selectedProject.value = null;
    }
    delete projectSessions[project.id];
    await loadProjects();
    await loadTasks();
  } catch (e: any) {
    alert('删除失败: ' + (e.message || ''));
  }
}

// ========== 生命周期 ==========
onMounted(async () => {
  await loadProjects();
  await loadPiModels();
  await loadTasks();
  ensureTaskSelected();
  if (projects.value.length > 0) {
    const firstProject = projects.value[0];
    if (!firstProject) return;
    expandedProjects.add(firstProject.id);
    await loadSessions(firstProject.id);
    const sessions = projectSessions[firstProject.id];
    if (sessions && sessions.length > 0) {
      await selectSession(sessions[0]);
    }
  }
  API.on('task:changed', onTaskChanged);
  API.on('task:followup:delta', handleTaskFollowupDelta);
  API.on('task:followup:done', handleTaskFollowupDone);
  API.on('task:followup:error', handleTaskFollowupError);
});

onBeforeUnmount(() => {
  API.removeAllListeners('coding:delta');
  API.removeAllListeners('coding:status');
  API.removeAllListeners('coding:tool');
  API.removeAllListeners('coding:done');
  API.removeAllListeners('coding:error');
  API.removeAllListeners('task:changed');
  API.removeAllListeners('task:followup:delta');
  API.removeAllListeners('task:followup:done');
  API.removeAllListeners('task:followup:error');
});
</script>

<style scoped>
.coding-workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 每个视图自带左栏 + 主体 */
.wb-view {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ========== 左栏 ========== */
.workbench-sidebar {
  width: 280px;
  min-width: 280px;
  background: #f8fafc;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* 任务/代码库视图左栏：对齐笔记任务 */
.wb-sidebar-tasks,
.wb-sidebar-chat {
  width: 320px;
  min-width: 320px;
  background: white;
}

.wb-sidebar-tasks .sidebar-header,
.wb-sidebar-chat .sidebar-header {
  padding: 12px 16px;
}

.sidebar-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.project-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.project-node {
  margin-bottom: 6px;
}

.project-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;
  user-select: none;
  font-size: 13px;
  color: var(--text-secondary);
}

.project-header:hover,
.project-header.expanded {
  background: var(--hover);
}

.project-header.active {
  background: rgba(99,102,241,0.1);
  color: var(--primary);
  font-weight: 500;
}

.project-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: color 0.15s;
}

.project-arrow svg {
  transition: transform 0.2s ease;
}

.project-header.expanded .project-arrow svg {
  transform: rotate(90deg);
}

.project-header:hover .project-arrow {
  color: var(--text-secondary);
}

.project-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.project-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: inherit;
}

.project-actions {
  display: none;
  gap: 2px;
  flex-shrink: 0;
  margin-left: auto;
}

.project-header:hover .project-actions {
  display: flex;
}

.project-edit-btn,
.project-delete-btn {
  font-size: 12px;
  cursor: pointer;
  padding: 1px 3px;
  border-radius: 4px;
  line-height: 1;
  opacity: 0.6;
  transition: opacity 0.15s;
}

.project-edit-btn:hover {
  opacity: 1;
  background: rgba(99, 102, 241, 0.1);
}

.project-delete-btn:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.1);
}

.conversation-list {
  background: #f8f8fa;
}

.conversation-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 8px 24px;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 13px;
  border-radius: var(--radius-sm);
  margin-bottom: 2px;
}

.conversation-item:hover {
  background: rgba(99,102,241,0.06);
}

.conversation-item.active {
  background: rgba(99,102,241,0.12);
  color: var(--primary);
  font-weight: 500;
}

.conv-icon {
  font-size: 12px;
  flex-shrink: 0;
  width: 16px;
  text-align: center;
}

.conv-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.conv-title.new {
  color: var(--primary);
}

.conv-delete {
  font-size: 14px;
  color: #94a3b8;
  cursor: pointer;
  visibility: hidden;
  width: 16px;
  text-align: center;
  border-radius: 4px;
  flex-shrink: 0;
  line-height: 1;
}

.conversation-item:hover .conv-delete {
  visibility: visible;
}

.conv-delete:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.new-conversation {
  color: var(--primary);
  font-weight: 500;
}

.new-conversation:hover {
  background: rgba(99, 102, 241, 0.06);
}

/* 任务状态徽标 */
.task-status-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
}

.task-status-badge.status-pending { background: rgba(251, 146, 60, 0.12); color: #fb923c; }
.task-status-badge.status-in_progress { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
.task-status-badge.status-done { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
.task-status-badge.status-RUNNING { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
.task-status-badge.status-SUCCESS { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
.task-status-badge.status-FAILED { background: rgba(239, 68, 68, 0.12); color: #ef4444; }

.sidebar-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
  gap: 8px;
}

.sidebar-empty .empty-icon {
  font-size: 32px;
  opacity: 0.3;
}

.sidebar-empty .empty-text {
  font-size: 13px;
  color: #94a3b8;
}

/* ========== 顶部视图切换 ========== */
.workbench-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: white;
  flex-shrink: 0;
  padding: 0 12px;
  gap: 4px;
}

.workbench-tab {
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  border: none;
  background: none;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  border-radius: 0;
}

.workbench-tab:hover {
  color: var(--text-primary);
  background: var(--hover);
}

.workbench-tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

/* 对话 Tab */
.workbench-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 任务 Tab */
.workbench-tasks {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tasks-tree-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.task-project-body {
  margin: 2px 0 4px 14px;
  padding: 2px 0 2px 12px;
  border-left: 1px solid var(--border);
}

.tasks-proj-empty {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.project-count {
  flex-shrink: 0;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--hover);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.project-header:hover .project-count,
.project-header.active .project-count {
  background: rgba(99, 102, 241, 0.12);
  color: var(--primary);
}

.tasks-list-empty {
  padding: 32px 16px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.tasks-list-empty .empty-icon {
  font-size: 28px;
  opacity: 0.3;
  margin-bottom: 8px;
}

.tasks-list-item {
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 6px;
  transition: all 0.15s;
  border: 1px solid var(--border);
  background: white;
  box-shadow: var(--shadow-sm);
}

.tasks-list-item:last-child { margin-bottom: 0; }
.tasks-list-item:hover { border-color: rgba(99, 102, 241, 0.35); box-shadow: var(--shadow-md); }
.tasks-list-item.active { background: rgba(99, 102, 241, 0.06); border-color: var(--primary); }
.tasks-list-item.running { border-color: var(--primary); }

.list-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.list-item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-item-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-item-last { color: var(--text-muted); }

/* 任务详情 */
.tasks-detail-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #f8fafc;
}

.tasks-detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
}

.tasks-detail-header {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: white;
  gap: 12px;
  flex-wrap: wrap;
}

.detail-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.tasks-detail-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.tasks-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.tasks-detail-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.tasks-detail-info {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  font-size: 13px;
  color: var(--text-secondary);
}

.tasks-detail-section {
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  padding: 14px 18px;
  margin-bottom: 14px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-primary);
}

.prompt-text {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  background: #f8fafc;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  line-height: 1.6;
}

.empty-sub { font-size: 13px; color: var(--text-muted); }

/* 执行记录 */
.execution-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin-bottom: 10px;
}

.exec-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.exec-trigger, .exec-time { font-size: 12px; color: var(--text-muted); }

.exec-error {
  font-size: 13px;
  color: #ef4444;
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.exec-result {
  font-size: 13px;
  color: var(--text-secondary);
  background: #f8fafc;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.6;
}

/* 追问 */
.followup-reply {
  font-size: 13px;
  color: var(--text-secondary);
  background: #f8fafc;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
  max-height: 240px;
  overflow-y: auto;
}

.followup-streaming::after {
  content: '▋';
  color: var(--primary);
  animation: blink 1s infinite;
}

@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

.followup-input-row { display: flex; gap: 8px; align-items: flex-end; }
.followup-input { flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; outline: none; resize: vertical; font-family: inherit; }
.followup-input:focus { border-color: var(--primary); }

.running-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #3b82f6; animation: pulse 1s infinite;
  flex-shrink: 0;
}

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.btn-xs { padding: 4px 10px; font-size: 12px; }

.workbench-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 60px 20px;
  color: #94a3b8;
}

.workbench-empty .empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
  opacity: 0.3;
}

.workbench-empty .empty-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.workbench-empty .empty-desc {
  font-size: 14px;
  line-height: 1.6;
  color: #64748b;
}

/* ========== 对话头部 ========== */
.chat-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  background: white;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.chat-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.model-selector {
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: white;
  color: #1e293b;
  max-width: 180px;
  outline: none;
}

.chat-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.chat-project-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(99,102,241,0.1);
  color: var(--primary);
}

.chat-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ========== 消息列表 ========== */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: white;
}

.message {
  display: flex;
  gap: 12px;
  max-width: 100%;
  animation: fadeIn 0.2s ease-out;
  margin-bottom: 8px;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.message.user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: #5c5c5c;
  color: white;
}

.message.assistant .message-avatar {
  background: linear-gradient(135deg, #8b5cf6, #6366f1);
  color: white;
}

.message.tool .message-avatar {
  background: #f59e0b;
  color: white;
}

.message-content-wrapper {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 75%;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-author {
  font-size: 13px;
  font-weight: 500;
}

.message.user .message-author { color: #64748b; }
.message.assistant .message-author { color: #6366f1; }
.message.tool .message-author { color: #f59e0b; }

.message-status {
  font-size: 11px;
  color: #94a3b8;
}

.message-content {
  padding: 14px 18px;
  border-radius: 16px;
  line-height: 1.7;
  font-size: 14px;
  word-wrap: break-word;
}

.message.user .message-content {
  background: #f1f5f9;
  color: #1e293b;
}

.message.assistant .message-content {
  background: #ffffff;
  color: #1e293b;
  border: 1px solid #e2e8f0;
}

.message.tool .message-content {
  background: #fffbeb;
  color: #92400e;
  border: 1px solid #fde68a;
  font-size: 13px;
  padding: 8px 14px;
}

.thinking-status {
  font-size: 13px;
  color: #6366f1;
  padding: 6px 10px;
  margin-bottom: 8px;
  background: #eef2ff;
  border-radius: 8px;
  border: 1px solid #a5b4fc;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ========== 输入区 ========== */
.chat-input-area {
  padding: 12px 20px;
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
  flex-shrink: 0;
}

.input-wrapper {
  background: white;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  overflow: hidden;
  transition: border-color 0.2s;
}

.input-wrapper:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.chat-input {
  width: 100%;
  padding: 12px 16px;
  border: none;
  background: transparent;
  font-size: 14px;
  outline: none;
  resize: none;
  min-height: 40px;
  max-height: 120px;
  line-height: 1.5;
  font-family: inherit;
  box-sizing: border-box;
}

.chat-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.chat-input::placeholder {
  color: #94a3b8;
}

.input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px 8px 12px;
}

.input-left {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.input-hint {
  font-size: 11px;
  color: #94a3b8;
}

/* ========== 图片预览（输入区） ========== */
.image-preview-bar { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px; border-top: 1px solid #f1f5f9; }
.image-preview-item { position: relative; width: 64px; height: 64px; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; flex-shrink: 0; }
.image-preview-thumb { width: 100%; height: 100%; object-fit: cover; }
.image-preview-remove { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%; border: none; background: rgba(0,0,0,0.5); color: white; font-size: 12px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
.image-preview-remove:hover { background: rgba(239,68,68,0.8); }
/* ========== 消息中的图片 ========== */
.message-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.chat-image { max-width: 300px; max-height: 300px; border-radius: 8px; border: 1px solid #e2e8f0; object-fit: contain; }

.input-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.send-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  cursor: pointer;
  background: #6366f1;
  color: white;
  transition: all 0.2s;
  border: none;
  flex-shrink: 0;
}

.send-btn:hover {
  background: #4f46e5;
}

.send-btn:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
}

/* ========== Markdown 样式 ========== */
.markdown-body {
  white-space: pre-wrap;
  word-break: break-word;
}

.markdown-body p {
  margin-bottom: 8px;
}

.markdown-body ul, .markdown-body ol {
  padding-left: 20px;
  margin-bottom: 8px;
}

.markdown-body li {
  margin-bottom: 4px;
}

.markdown-body code {
  background: rgba(0, 0, 0, 0.04);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
}

.markdown-body pre {
  background: #1e293b;
  color: #e2e8f0;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin-bottom: 8px;
  font-family: monospace;
  font-size: 13px;
}

.markdown-body blockquote {
  border-left: 3px solid #6366f1;
  padding-left: 10px;
  color: #64748b;
  margin-bottom: 8px;
}

.markdown-body strong {
  font-weight: 600;
}

.markdown-body a {
  color: #6366f1;
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
}

/* ========== 弹窗 ========== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: white;
  border-radius: var(--radius-md);
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  padding: 20px 24px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  max-height: 70vh;
}

.type-radio-group {
  display: flex;
  gap: 8px;
}

.type-radio {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  background: #fafafa;
  transition: all 0.15s;
  user-select: none;
}

.type-radio:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.type-radio.active {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(99, 102, 241, 0.06);
}

.type-radio input { display: none; }

.modal-footer {
  padding: 0 24px 20px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-control {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}

.form-control:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.input-with-btn {
  display: flex;
  gap: 8px;
}

.input-with-btn .form-control {
  flex: 1;
}

/* 定时任务弹窗 */
.task-modal { width: 560px; }

.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
select.form-control { cursor: pointer; }
textarea.form-control { resize: vertical; min-height: 80px; font-family: inherit; }
.check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); padding: 8px 0; cursor: pointer; }
.week-select { display: flex; gap: 8px; flex-wrap: wrap; }
.week-chip { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; cursor: pointer; user-select: none; }
.week-chip:hover { border-color: var(--primary); }

/* 项目详情卡片 */
/* 项目详情弹窗 */
.project-detail-modal { background: white; border-radius: var(--radius-lg); padding: 24px; width: 420px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.15); }
.project-detail-modal .project-detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.project-detail-modal .project-detail-icon { font-size: 24px; }
.project-detail-modal .project-detail-name { flex: 1; font-size: 18px; font-weight: 600; color: var(--text-primary); }
.project-detail-modal .project-detail-body { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--hover); border-radius: var(--radius-sm); }
.project-detail-modal .detail-row { display: flex; gap: 8px; font-size: 13px; }
.project-detail-modal .detail-label { color: var(--text-muted); flex-shrink: 0; min-width: 56px; }
.project-detail-modal .detail-value { color: var(--text-primary); word-break: break-all; }

/* 变更审查弹窗 */
.changes-modal { width: 720px; max-width: 90vw; }
.changes-modal .modal-body { max-height: 60vh; }
.changes-loading, .changes-error { color: var(--text-secondary); font-size: 13px; padding: 12px 0; }
.changes-error { color: #dc2626; }
.changes-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.meta-badge { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: #f1f5f9; color: #475569; }
.meta-badge.isolated { background: #ecfdf5; color: #047857; }
.changes-summary { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
.changes-files { max-height: 160px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; }
.change-file { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
.change-file:last-child { border-bottom: none; }
.change-type { flex-shrink: 0; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #f1f5f9; color: #475569; }
.change-type.added { background: #ecfdf5; color: #047857; }
.change-type.deleted { background: #fef2f2; color: #dc2626; }
.change-type.modified { background: #eff6ff; color: #2563eb; }
.change-path { flex: 1; color: var(--text-primary); word-break: break-all; }
.change-stat { flex-shrink: 0; color: var(--text-muted); font-family: monospace; }
.changes-diff { border: 1px solid var(--border); border-radius: 8px; background: #0f172a; max-height: 320px; overflow: auto; }
.changes-diff pre { margin: 0; padding: 12px; color: #e2e8f0; font-size: 12px; font-family: ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; }
.changes-actions .changes-hint { font-size: 12px; color: var(--text-muted); margin-right: auto; align-self: center; }
.btn-danger { background: #fef2f2; border-color: #fecaca; color: #dc2626; }
.btn-danger:hover { background: #fee2e2; border-color: #fca5a5; }
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
</style>