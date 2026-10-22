/**
 * 桌面系统通知。
 * 必须攥住 Notification 引用：Electron 的 Notification 一旦被 GC，click 监听就失效了
 * （通知还能弹，但点它没反应），所以活着的实例先进 Set，close 时再放掉。
 */
import { Notification } from 'electron';

const alive = new Set<Notification>();

export function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  if (onClick) notification.on('click', onClick);
  notification.on('close', () => { alive.delete(notification); });
  alive.add(notification);
  notification.show();
}
