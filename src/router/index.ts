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
    path: '/reminders',
    name: 'Reminders',
    component: () => import('@/views/RemindersView.vue')
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
    path: '/radar',
    name: 'AgentRadar',
    component: () => import('@/views/AgentRadarView.vue')
  },
  {
    path: '/radar/ask',
    name: 'RadarAsk',
    component: () => import('@/views/RadarAskView.vue')
  },
  {
    path: '/radar/session/:tool/:sessionId',
    name: 'RadarSession',
    component: () => import('@/views/RadarSessionView.vue')
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
