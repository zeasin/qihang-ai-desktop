<!--
  AppIcon —— 项目统一的线性图标层（纸墨设计系统）

  用法：
    <AppIcon name="folder" :size="14" />
    <AppIcon name="search" :size="16" :stroke-width="2" />
    <AppIcon name="bell" label="通知" />

  说明：
    · 图标几何全部取自 docs/ui-redesign-proto.html 内联的 Lucide 图标，
      与「纸墨」原型完全一致；不引入任何第三方图标库依赖。
    · 描边颜色统一继承 currentColor，随文字颜色变化。
    · name 找不到时降级为一个空心圆占位，不会抛异常、不会白屏。
-->
<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <template v-for="(fragment, index) in fragments" :key="index">
      <path v-if="fragment.tag === 'path'" v-bind="fragment.attrs" />
      <circle v-else-if="fragment.tag === 'circle'" v-bind="fragment.attrs" />
      <ellipse v-else-if="fragment.tag === 'ellipse'" v-bind="fragment.attrs" />
      <line v-else-if="fragment.tag === 'line'" v-bind="fragment.attrs" />
      <rect v-else-if="fragment.tag === 'rect'" v-bind="fragment.attrs" />
    </template>
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * 图标片段：一个 SVG 子元素（标签 + 属性）。
 * 用模板片段数组描述图标，避免 v-html 带来的 XSS 语义与维护问题。
 */
type IconFragment =
  | { tag: 'path'; attrs: { d: string } }
  | { tag: 'circle'; attrs: { cx: string; cy: string; r: string; fill?: string } }
  | { tag: 'ellipse'; attrs: { cx: string; cy: string; rx: string; ry: string } }
  | { tag: 'line'; attrs: { x1: string; y1: string; x2: string; y2: string } }
  | {
      tag: 'rect';
      attrs: { x: string; y: string; width: string; height: string; rx?: string; ry?: string };
    };

const props = withDefaults(
  defineProps<{
    /** 图标名，见 ICONS 表 */
    name: string;
    /** 边长（像素） */
    size?: number;
    /** 描边宽度 */
    strokeWidth?: number;
    /** 无障碍标签；传了则渲染 role="img"，不传则 aria-hidden */
    label?: string;
  }>(),
  {
    size: 16,
    strokeWidth: 1.75,
    label: undefined,
  },
);

/**
 * 内部图标表：几何取自 docs/ui-redesign-proto.html 的内联 Lucide 图标。
 * 键为小写短横线命名，与原型的 data-lucide 一致。
 */
const ICONS: Record<string, IconFragment[]> = {
  /* ---- 原型 docs/ui-redesign-proto.html 实际使用的图标 ---- */
  'search': [
    { tag: 'path', attrs: { d: 'm21 21-4.34-4.34' } },
    { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
  ],
  'moon': [
    { tag: 'path', attrs: { d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' } },
  ],
  'sailboat': [
    { tag: 'path', attrs: { d: 'M10 2v15' } },
    { tag: 'path', attrs: { d: 'M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z' } },
    { tag: 'path', attrs: { d: 'M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z' } },
  ],
  'chevrons-up-down': [
    { tag: 'path', attrs: { d: 'm7 15 5 5 5-5' } },
    { tag: 'path', attrs: { d: 'm7 9 5-5 5 5' } },
  ],
  'plus': [
    { tag: 'path', attrs: { d: 'M5 12h14' } },
    { tag: 'path', attrs: { d: 'M12 5v14' } },
  ],
  'chevron-right': [
    { tag: 'path', attrs: { d: 'm9 18 6-6-6-6' } },
  ],
  'sun': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '4' } },
    { tag: 'path', attrs: { d: 'M12 2v2' } },
    { tag: 'path', attrs: { d: 'M12 20v2' } },
    { tag: 'path', attrs: { d: 'm4.93 4.93 1.41 1.41' } },
    { tag: 'path', attrs: { d: 'm17.66 17.66 1.41 1.41' } },
    { tag: 'path', attrs: { d: 'M2 12h2' } },
    { tag: 'path', attrs: { d: 'M20 12h2' } },
    { tag: 'path', attrs: { d: 'm6.34 17.66-1.41 1.41' } },
    { tag: 'path', attrs: { d: 'm19.07 4.93-1.41 1.41' } },
  ],
  'message-square': [
    { tag: 'path', attrs: { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' } },
  ],
  'workflow': [
    { tag: 'rect', attrs: { width: '8', height: '8', x: '3', y: '3', rx: '2' } },
    { tag: 'path', attrs: { d: 'M7 11v4a2 2 0 0 0 2 2h4' } },
    { tag: 'rect', attrs: { width: '8', height: '8', x: '13', y: '13', rx: '2' } },
  ],
  'list-checks': [
    { tag: 'path', attrs: { d: 'M13 5h8' } },
    { tag: 'path', attrs: { d: 'M13 12h8' } },
    { tag: 'path', attrs: { d: 'M13 19h8' } },
    { tag: 'path', attrs: { d: 'm3 17 2 2 4-4' } },
    { tag: 'path', attrs: { d: 'm3 7 2 2 4-4' } },
  ],
  'library': [
    { tag: 'path', attrs: { d: 'm16 6 4 14' } },
    { tag: 'path', attrs: { d: 'M12 6v14' } },
    { tag: 'path', attrs: { d: 'M8 8v12' } },
    { tag: 'path', attrs: { d: 'M4 4v16' } },
  ],
  'database': [
    { tag: 'ellipse', attrs: { cx: '12', cy: '5', rx: '9', ry: '3' } },
    { tag: 'path', attrs: { d: 'M3 5V19A9 3 0 0 0 21 19V5' } },
    { tag: 'path', attrs: { d: 'M3 12A9 3 0 0 0 21 12' } },
  ],
  'sparkles': [
    { tag: 'path', attrs: { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' } },
    { tag: 'path', attrs: { d: 'M20 2v4' } },
    { tag: 'path', attrs: { d: 'M22 4h-4' } },
    { tag: 'circle', attrs: { cx: '4', cy: '20', r: '2' } },
  ],
  'settings': [
    { tag: 'path', attrs: { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
  ],
  'refresh-cw': [
    { tag: 'path', attrs: { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' } },
    { tag: 'path', attrs: { d: 'M21 3v5h-5' } },
    { tag: 'path', attrs: { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' } },
    { tag: 'path', attrs: { d: 'M8 16H3v5' } },
  ],
  'clock': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'M12 6v6l4 2' } },
  ],
  'bell-ring': [
    { tag: 'path', attrs: { d: 'M10.268 21a2 2 0 0 0 3.464 0' } },
    { tag: 'path', attrs: { d: 'M22 8c0-2.3-.8-4.3-2-6' } },
    { tag: 'path', attrs: { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' } },
    { tag: 'path', attrs: { d: 'M4 2C2.8 3.7 2 5.7 2 8' } },
  ],
  'file-text': [
    { tag: 'path', attrs: { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' } },
    { tag: 'path', attrs: { d: 'M14 2v5a1 1 0 0 0 1 1h5' } },
    { tag: 'path', attrs: { d: 'M10 9H8' } },
    { tag: 'path', attrs: { d: 'M16 13H8' } },
    { tag: 'path', attrs: { d: 'M16 17H8' } },
  ],
  'cpu': [
    { tag: 'path', attrs: { d: 'M12 20v2' } },
    { tag: 'path', attrs: { d: 'M12 2v2' } },
    { tag: 'path', attrs: { d: 'M17 20v2' } },
    { tag: 'path', attrs: { d: 'M17 2v2' } },
    { tag: 'path', attrs: { d: 'M2 12h2' } },
    { tag: 'path', attrs: { d: 'M2 17h2' } },
    { tag: 'path', attrs: { d: 'M2 7h2' } },
    { tag: 'path', attrs: { d: 'M20 12h2' } },
    { tag: 'path', attrs: { d: 'M20 17h2' } },
    { tag: 'path', attrs: { d: 'M20 7h2' } },
    { tag: 'path', attrs: { d: 'M7 20v2' } },
    { tag: 'path', attrs: { d: 'M7 2v2' } },
    { tag: 'rect', attrs: { x: '4', y: '4', width: '16', height: '16', rx: '2' } },
    { tag: 'rect', attrs: { x: '8', y: '8', width: '8', height: '8', rx: '1' } },
  ],
  'chevron-down': [
    { tag: 'path', attrs: { d: 'm6 9 6 6 6-6' } },
  ],
  'paperclip': [
    { tag: 'path', attrs: { d: 'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551' } },
  ],
  'send': [
    { tag: 'path', attrs: { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' } },
    { tag: 'path', attrs: { d: 'm21.854 2.147-10.94 10.939' } },
  ],
  'book-open': [
    { tag: 'path', attrs: { d: 'M12 7v14' } },
    { tag: 'path', attrs: { d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z' } },
  ],
  'bell': [
    { tag: 'path', attrs: { d: 'M10.268 21a2 2 0 0 0 3.464 0' } },
    { tag: 'path', attrs: { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' } },
  ],
  'archive': [
    { tag: 'rect', attrs: { width: '20', height: '5', x: '2', y: '3', rx: '1' } },
    { tag: 'path', attrs: { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' } },
    { tag: 'path', attrs: { d: 'M10 12h4' } },
  ],
  'check': [
    { tag: 'path', attrs: { d: 'M20 6 9 17l-5-5' } },
  ],
  'presentation': [
    { tag: 'path', attrs: { d: 'M2 3h20' } },
    { tag: 'path', attrs: { d: 'M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3' } },
    { tag: 'path', attrs: { d: 'm7 21 5-5 5 5' } },
  ],
  'clipboard-list': [
    { tag: 'rect', attrs: { width: '8', height: '4', x: '8', y: '2', rx: '1', ry: '1' } },
    { tag: 'path', attrs: { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' } },
    { tag: 'path', attrs: { d: 'M12 11h4' } },
    { tag: 'path', attrs: { d: 'M12 16h4' } },
    { tag: 'path', attrs: { d: 'M8 11h.01' } },
    { tag: 'path', attrs: { d: 'M8 16h.01' } },
  ],
  'network': [
    { tag: 'rect', attrs: { x: '16', y: '16', width: '6', height: '6', rx: '1' } },
    { tag: 'rect', attrs: { x: '2', y: '16', width: '6', height: '6', rx: '1' } },
    { tag: 'rect', attrs: { x: '9', y: '2', width: '6', height: '6', rx: '1' } },
    { tag: 'path', attrs: { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' } },
    { tag: 'path', attrs: { d: 'M12 12V8' } },
  ],
  'pen-line': [
    { tag: 'path', attrs: { d: 'M13 21h8' } },
    { tag: 'path', attrs: { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' } },
  ],
  'globe': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' } },
    { tag: 'path', attrs: { d: 'M2 12h20' } },
  ],
  'image': [
    { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' } },
    { tag: 'circle', attrs: { cx: '9', cy: '9', r: '2' } },
    { tag: 'path', attrs: { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' } },
  ],
  'history': [
    { tag: 'path', attrs: { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' } },
    { tag: 'path', attrs: { d: 'M3 3v5h5' } },
    { tag: 'path', attrs: { d: 'M12 7v5l4 2' } },
  ],
  /* ---- 补充的常用图标 ---- */
  'alert-triangle': [
    { tag: 'path', attrs: { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' } },
    { tag: 'path', attrs: { d: 'M12 9v4' } },
    { tag: 'path', attrs: { d: 'M12 17h.01' } },
  ],
  'arrow-right': [
    { tag: 'path', attrs: { d: 'M5 12h14' } },
    { tag: 'path', attrs: { d: 'm12 5 7 7-7 7' } },
  ],
  'bookmark': [
    { tag: 'path', attrs: { d: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z' } },
  ],
  'brain': [
    { tag: 'path', attrs: { d: 'M12 18V5' } },
    { tag: 'path', attrs: { d: 'M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4' } },
    { tag: 'path', attrs: { d: 'M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5' } },
    { tag: 'path', attrs: { d: 'M17.997 5.125a4 4 0 0 1 2.526 5.77' } },
    { tag: 'path', attrs: { d: 'M18 18a4 4 0 0 0 2-7.464' } },
    { tag: 'path', attrs: { d: 'M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517' } },
    { tag: 'path', attrs: { d: 'M6 18a4 4 0 0 1-2-7.464' } },
    { tag: 'path', attrs: { d: 'M6.003 5.125a4 4 0 0 0-2.526 5.77' } },
  ],
  'calendar': [
    { tag: 'path', attrs: { d: 'M8 2v4' } },
    { tag: 'path', attrs: { d: 'M16 2v4' } },
    { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '4', rx: '2' } },
    { tag: 'path', attrs: { d: 'M3 10h18' } },
  ],
  'check-square': [
    { tag: 'path', attrs: { d: 'M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344' } },
    { tag: 'path', attrs: { d: 'm9 11 3 3L22 4' } },
  ],
  'chevron-left': [
    { tag: 'path', attrs: { d: 'm15 18-6-6 6-6' } },
  ],
  'chevron-up': [
    { tag: 'path', attrs: { d: 'm18 15-6-6-6 6' } },
  ],
  'circle': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
  ],
  'circle-alert': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'line', attrs: { x1: '12', x2: '12', y1: '8', y2: '12' } },
    { tag: 'line', attrs: { x1: '12', x2: '12.01', y1: '16', y2: '16' } },
  ],
  'circle-check': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'm9 12 2 2 4-4' } },
  ],
  'circle-help': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' } },
    { tag: 'path', attrs: { d: 'M12 17h.01' } },
  ],
  'copy': [
    { tag: 'rect', attrs: { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' } },
    { tag: 'path', attrs: { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' } },
  ],
  'download': [
    { tag: 'path', attrs: { d: 'M12 15V3' } },
    { tag: 'path', attrs: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' } },
    { tag: 'path', attrs: { d: 'm7 10 5 5 5-5' } },
  ],
  'edit': [
    { tag: 'path', attrs: { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' } },
    { tag: 'path', attrs: { d: 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z' } },
  ],
  'external-link': [
    { tag: 'path', attrs: { d: 'M15 3h6v6' } },
    { tag: 'path', attrs: { d: 'M10 14 21 3' } },
    { tag: 'path', attrs: { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' } },
  ],
  'eye': [
    { tag: 'path', attrs: { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
  ],
  'file': [
    { tag: 'path', attrs: { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' } },
    { tag: 'path', attrs: { d: 'M14 2v5a1 1 0 0 0 1 1h5' } },
  ],
  'filter': [
    { tag: 'path', attrs: { d: 'M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z' } },
  ],
  'folder': [
    { tag: 'path', attrs: { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' } },
  ],
  'folder-open': [
    { tag: 'path', attrs: { d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' } },
  ],
  'folder-plus': [
    { tag: 'path', attrs: { d: 'M12 10v6' } },
    { tag: 'path', attrs: { d: 'M9 13h6' } },
    { tag: 'path', attrs: { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' } },
  ],
  'home': [
    { tag: 'path', attrs: { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' } },
    { tag: 'path', attrs: { d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' } },
  ],
  'info': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'M12 16v-4' } },
    { tag: 'path', attrs: { d: 'M12 8h.01' } },
  ],
  'key': [
    { tag: 'path', attrs: { d: 'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4' } },
    { tag: 'path', attrs: { d: 'm21 2-9.6 9.6' } },
    { tag: 'circle', attrs: { cx: '7.5', cy: '15.5', r: '5.5' } },
  ],
  'link': [
    { tag: 'path', attrs: { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' } },
    { tag: 'path', attrs: { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' } },
  ],
  'loader': [
    { tag: 'path', attrs: { d: 'M12 2v4' } },
    { tag: 'path', attrs: { d: 'm16.2 7.8 2.9-2.9' } },
    { tag: 'path', attrs: { d: 'M18 12h4' } },
    { tag: 'path', attrs: { d: 'm16.2 16.2 2.9 2.9' } },
    { tag: 'path', attrs: { d: 'M12 18v4' } },
    { tag: 'path', attrs: { d: 'm4.9 19.1 2.9-2.9' } },
    { tag: 'path', attrs: { d: 'M2 12h4' } },
    { tag: 'path', attrs: { d: 'm4.9 4.9 2.9 2.9' } },
  ],
  'log-out': [
    { tag: 'path', attrs: { d: 'm16 17 5-5-5-5' } },
    { tag: 'path', attrs: { d: 'M21 12H9' } },
    { tag: 'path', attrs: { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' } },
  ],
  'menu': [
    { tag: 'path', attrs: { d: 'M4 5h16' } },
    { tag: 'path', attrs: { d: 'M4 12h16' } },
    { tag: 'path', attrs: { d: 'M4 19h16' } },
  ],
  'more-horizontal': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '1' } },
    { tag: 'circle', attrs: { cx: '19', cy: '12', r: '1' } },
    { tag: 'circle', attrs: { cx: '5', cy: '12', r: '1' } },
  ],
  'panel-left': [
    { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
    { tag: 'path', attrs: { d: 'M9 3v18' } },
  ],
  'pencil': [
    { tag: 'path', attrs: { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' } },
    { tag: 'path', attrs: { d: 'm15 5 4 4' } },
  ],
  'play': [
    { tag: 'path', attrs: { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' } },
  ],
  'rocket': [
    { tag: 'path', attrs: { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' } },
    { tag: 'path', attrs: { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09' } },
    { tag: 'path', attrs: { d: 'M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z' } },
    { tag: 'path', attrs: { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05' } },
  ],
  'square': [
    { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
  ],
  'square-pen': [
    { tag: 'path', attrs: { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' } },
    { tag: 'path', attrs: { d: 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z' } },
  ],
  'star': [
    { tag: 'path', attrs: { d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' } },
  ],
  'tag': [
    { tag: 'path', attrs: { d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z' } },
    { tag: 'circle', attrs: { cx: '7.5', cy: '7.5', r: '.5', fill: 'currentColor' } },
  ],
  'terminal': [
    { tag: 'path', attrs: { d: 'M12 19h8' } },
    { tag: 'path', attrs: { d: 'm4 17 6-6-6-6' } },
  ],
  'trash': [
    { tag: 'path', attrs: { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' } },
    { tag: 'path', attrs: { d: 'M3 6h18' } },
    { tag: 'path', attrs: { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
  ],
  'trash-2': [
    { tag: 'path', attrs: { d: 'M10 11v6' } },
    { tag: 'path', attrs: { d: 'M14 11v6' } },
    { tag: 'path', attrs: { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' } },
    { tag: 'path', attrs: { d: 'M3 6h18' } },
    { tag: 'path', attrs: { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
  ],
  'upload': [
    { tag: 'path', attrs: { d: 'M12 3v12' } },
    { tag: 'path', attrs: { d: 'm17 8-5-5-5 5' } },
    { tag: 'path', attrs: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' } },
  ],
  'user': [
    { tag: 'path', attrs: { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' } },
    { tag: 'circle', attrs: { cx: '12', cy: '7', r: '4' } },
  ],
  'x': [
    { tag: 'path', attrs: { d: 'M18 6 6 18' } },
    { tag: 'path', attrs: { d: 'm6 6 12 12' } },
  ],
  'zap': [
    { tag: 'path', attrs: { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' } },
  ],
};

/** 未知图标的占位：一个空心圆，不抛异常 */
const FALLBACK: IconFragment[] = [
  { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
];

const fragments = computed<IconFragment[]>(() => ICONS[props.name] ?? FALLBACK);
</script>
