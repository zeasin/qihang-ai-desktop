import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    redirect: '/overview'
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('@/views/ChatView.vue')
  },
  {
    path: '/new',
    name: 'NewChat',
    component: () => import('@/views/NewChatView.vue')
  },
  {
    path: '/notes',
    name: 'Notes',
    component: () => import('@/views/NotesView.vue')
  },
  {
    // MCP 数据源（新模块）：配置 / 域浏览 / AI 分类
    path: '/sources',
    name: 'Sources',
    component: () => import('@/views/SourcesView.vue')
  },
  {
    // 旧数据页已退役（本地数据集隐藏不删），旧入口一律重定向
    path: '/data',
    redirect: '/sources'
  },
  {
    path: '/data-module',
    redirect: '/sources'
  },

  {
    path: '/planner',
    name: 'Planner',
    component: () => import('@/views/PlannerView.vue')
  },
  {
    // 事项页：待办与提醒 + 工单合并为一个入口（旧路由重定向过来）
    path: '/items',
    name: 'Items',
    component: () => import('@/views/ItemsView.vue')
  },
  {
    path: '/reminders',
    redirect: '/items'
  },
  {
    path: '/tickets',
    redirect: '/items'
  },
  {
    path: '/task/:id',
    name: 'TaskDetail',
    component: () => import('@/views/TaskDetailView.vue')
  },
  {
    path: '/tools',
    name: 'Tools',
    component: () => import('@/views/ToolsView.vue')
  },
  {
    path: '/overview',
    name: 'Overview',
    component: () => import('@/views/OverviewView.vue')
  },
  {
    // 雷达页已整体并入「今天」页（AgentRadarView embedded），旧入口重定向
    path: '/radar',
    redirect: '/overview'
  },
  {
    path: '/radar/ask',
    name: 'RadarAsk',
    component: () => import('@/views/RadarAskView.vue')
  },
  {
    // 会话档案：雷达沉淀的全部对话记录（筛选/搜索/分页浏览）
    path: '/radar/all',
    name: 'RadarAll',
    component: () => import('@/views/RadarAllView.vue')
  },
  {
    path: '/radar/session/:tool/:sessionId',
    name: 'RadarSession',
    component: () => import('@/views/RadarSessionView.vue')
  },
  {
    // 摘要详情页：从会话档案「摘要」视图卡片进入，整页专注阅读单条摘要
    path: '/radar/summary/:tool/:sessionId',
    name: 'RadarSummary',
    component: () => import('@/views/RadarSummaryView.vue')
  },
  {
    path: '/config',
    name: 'Config',
    component: () => import('@/views/ConfigView.vue')
  },
  {
    path: '/log',
    name: 'Log',
    component: () => import('@/views/LogView.vue')
  },
  {
    path: '/help',
    name: 'Help',
    component: () => import('@/views/HelpView.vue')
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;
