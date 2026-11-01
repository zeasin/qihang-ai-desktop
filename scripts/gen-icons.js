/**
 * 统一应用图标生成脚本（把品牌 logo 光栅化为各处图标）
 *
 * 品牌来源：src/components/AppIcon.vue 的 sailboat 图标 + tokens.css 强调色 #2f8c74
 * 产出：
 *   build/icon.ico        16-256 多尺寸（exe/安装包/文件关联）
 *   build/icon.png        512（electron-builder mac/linux 目标）
 *   resources/icon.png    256（主窗口/任务栏，见 electron/icon.ts）
 *   resources/tray-16.png 16（托盘，macOS）
 *   resources/tray-32.png 32（托盘，Windows/Linux）
 *
 * 运行：node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');

const BRAND_GREEN = '#2f8c74';

/** sailboat 三笔路径（与 AppIcon.vue 保持一致，viewBox 0 0 24 24） */
const BOAT_PATHS = [
  'M10 2v15',
  'M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z',
  'M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z',
];

/**
 * 生成 logo SVG：青绿圆角方块 + 白色帆船
 * @param stroke 帆船描边宽度（24 单位坐标系，1.75 与页内一致；小尺寸托盘适当加粗）
 */
function svgFor(stroke) {
  const boat = BOAT_PATHS.map(d => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="76" fill="${BRAND_GREEN}"/>
  <g transform="translate(48 48) scale(6.6667)" fill="none" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${boat}</g>
</svg>`;
}

/** 按目标尺寸直接矢量渲染 PNG（各尺寸独立渲染，比整图缩放更清晰） */
function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
}

/** 组装 ICO（PNG 压缩条目，Vista+ 全支持） */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, buffer } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.buffer)]);
}

const std = svgFor(1.75);  // 标准描边（与页内 brand 一致）
const s16 = svgFor(2.6);   // 16px 托盘加粗
const s32 = svgFor(2.2);   // 32px 托盘加粗

const icoImages = [
  { size: 16, buffer: renderPng(s16, 16) },
  { size: 24, buffer: renderPng(std, 24) },
  { size: 32, buffer: renderPng(s32, 32) },
  { size: 48, buffer: renderPng(std, 48) },
  { size: 64, buffer: renderPng(std, 64) },
  { size: 128, buffer: renderPng(std, 128) },
  { size: 256, buffer: renderPng(std, 256) },
];

fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(icoImages));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), renderPng(std, 512));
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), renderPng(std, 256));
fs.writeFileSync(path.join(root, 'resources', 'tray-16.png'), renderPng(s16, 16));
fs.writeFileSync(path.join(root, 'resources', 'tray-32.png'), renderPng(s32, 32));

console.log('[gen-icons] done: build/icon.ico, build/icon.png, resources/icon.png, tray-16.png, tray-32.png');
