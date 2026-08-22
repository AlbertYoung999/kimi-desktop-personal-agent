import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { getBallWindow, createBallWindow, getHomeWindow, createHomeWindow, toggleHome, toggleWorkbench } from './windows.js';

/** macOS menu-bar tray: 打开主页 / 打开工作台 / 悬浮球显隐 / 退出 */

let tray: Tray | null = null;
let ballHidden = false;

export function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'tray', 'tray-icon-18.png'));
  const retina = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'tray', 'tray-icon-36.png'));
  icon.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG() });

  tray = new Tray(icon);
  tray.setToolTip('Kimi Desktop Personal Agent');
  tray.on('click', () => tray?.popUpContextMenu());
  refreshTrayMenu();
}

export function refreshTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '打开主页',
      click: () => {
        if (!getHomeWindow()) createHomeWindow();
        toggleHome();
      },
    },
    { label: '打开工作台', click: () => toggleWorkbench() },
    { type: 'separator' },
    {
      label: ballHidden ? '显示悬浮球' : '隐藏悬浮球',
      click: () => {
        ballHidden = !ballHidden;
        const ball = getBallWindow() ?? createBallWindow();
        if (ballHidden) ball.hide();
        else ball.show();
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '退出 Kimi Desktop',
      click: () => {
        // bypass the close=hide handlers and quit for real
        app.exit(0);
      },
    },
  ]);
  tray.setContextMenu(menu);
}
