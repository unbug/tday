/**
 * Electron window creation and application menu setup.
 */

import { app, BrowserWindow, Menu, shell } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { join } from 'node:path';

export let mainWindow: BrowserWindow | null = null;

export function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  mainWindow = win;

  win.on('ready-to-show', () => win.show());
  win.on('close', () => app.quit());
  win.on('closed', () => { mainWindow = null; });
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

export function watchWindowShortcuts(): void {
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w));
}

export function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const sendShortcut = (channel: 'tab:new' | 'tab:close' | 'tab:restore') => () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.webContents.send(channel);
  };
  const tabMenu: Electron.MenuItemConstructorOptions = {
    label: 'Tab',
    submenu: [
      { label: 'New Tab',           accelerator: 'CommandOrControl+T',       click: sendShortcut('tab:new') },
      { label: 'Close Tab',         accelerator: 'CommandOrControl+W',       click: sendShortcut('tab:close') },
      { label: 'Restore Closed Tab',accelerator: 'CommandOrControl+Shift+T', click: sendShortcut('tab:restore') },
    ],
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    tabMenu,
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[]) : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
