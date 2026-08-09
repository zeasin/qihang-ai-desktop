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
    path: '/notes',
    redirect: '/chat'
  },
  {
    path: '/data',
    name: 'Data',
    component: () => import('@/views/DataView.vue')
  },
  {
    path: '/data-module',
    redirect: '/data'
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
    path: '/projects',
    name: 'Projects',
    component: () => import('@/views/ProjectsView.vue')
  },
  {
    path: '/coding',
    redirect: '/planner'
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
