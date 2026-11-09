// Platform window chrome and shell integration. macOS keeps the original inset
// traffic lights; Windows uses the original frameless window with native caption
// buttons drawn by the title-bar overlay, a notification-area icon and a Start menu
// shortcut that carries the toast identity.
import path from 'node:path';

export const isWindows = process.platform === 'win32';
export const APP_USER_MODEL_ID = 'dev.grokbot.local';
export const SHORTCUT_NAME = 'Grok Bot Local.lnk';

// Values of the original Windows client: 52 px chrome minus its divider, and the
// modal dimming layers used while a sheet covers the window.
const OVERLAY_HEIGHT = 51, OVERLAY_TONE_HEIGHT = 43;
const COVER = { rgb: [20, 20, 20], alpha: 0.95 }, TOP_BAR = { rgb: [0, 0, 0], alpha: 0.55 }, FALLBACK = [24, 24, 24];
const rgb = hex => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) : undefined;
const blend = (layer, hex) => {
  const base = rgb(hex) ?? FALLBACK;
  return `#${layer.rgb.map((value, index) => Math.round(value * layer.alpha + base[index] * (1 - layer.alpha))
    .toString(16).padStart(2, '0')).join('')}`;
};
const symbolColor = hex => {
  const [red, green, blue] = rgb(hex) ?? FALLBACK;
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128 ? '#FFFFFF' : '#000000';
};

export function titleBarOverlay(background, tone = false) {
  const color = tone ? blend(TOP_BAR, blend(COVER, background)) : background;
  return { color, symbolColor: symbolColor(color), height: tone ? OVERLAY_TONE_HEIGHT : OVERLAY_HEIGHT };
}

export function windowChrome(background, platform = process.platform) {
  return platform === 'win32'
    ? { frame: false, titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(background) }
    : { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } };
}

/** The pairing window keeps its 42 px drag strip on both platforms. */
export function connectWindowChrome(platform = process.platform) {
  return platform === 'win32'
    ? { frame: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#111111', symbolColor: '#FFFFFF', height: 42 } }
    : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } };
}

/** Original window RPCs used by the Windows renderer's title bar. */
export function windowHandlers(win, background, { platform = process.platform, workArea } = {}) {
  let color = background, tone = false;
  const windows = platform === 'win32';
  const apply = () => { if (windows && !win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay(color, tone)); };
  const state = () => ({ isFullscreen: win.isFullScreen(), isMaximized: win.isMaximized() });
  if (windows) for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'])
    win.on(event, () => { if (!win.isDestroyed()) win.webContents.send('dune-rpc:main:e:window-state', state()); });
  return {
    setBackground(value) { color = value; apply(); },
    handlers: windows ? {
      getWindowState: state,
      minimizeWindow: () => { win.minimize(); return null; },
      focusWindow: () => { win.show(); win.focus(); return null; },
      toggleMaximizeWindow: () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); return null; },
      closeWindow: () => { win.close(); return null; },
      resizeWindowWidth: ({ deltaWidth }) => {
        if (!Number.isFinite(deltaWidth) || win.isMaximized() || win.isFullScreen()) return null;
        const bounds = win.getBounds(), area = workArea?.(win) ?? bounds;
        const width = Math.max(720, Math.min(area.width, Math.round(bounds.width + deltaWidth)));
        win.setBounds({ ...bounds, width, x: Math.min(bounds.x, area.x + area.width - width) });
        return null;
      },
      setTitleBarOverlayTone: ({ isOverlayTone }) => { tone = isOverlayTone === true; apply(); return null; },
    } : {},
  };
}

/** Windows delivers toasts only for an app with a Start menu shortcut carrying its AppUserModelID. */
export function ensureStartMenuShortcut({ app, shell, execPath = process.execPath }) {
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', SHORTCUT_NAME);
  const options = { target: execPath, cwd: path.dirname(execPath), description: 'Grok Bot Local',
    icon: execPath, iconIndex: 0, appUserModelId: APP_USER_MODEL_ID };
  let current = null;
  try { current = shell.readShortcutLink(link); } catch {}
  if (current && path.resolve(current.target).toLowerCase() === execPath.toLowerCase() && current.appUserModelId === APP_USER_MODEL_ID) return false;
  if (!shell.writeShortcutLink(link, current ? 'replace' : 'create', options)) throw new Error('Could not write the Start menu shortcut');
  return true;
}

export function createTray({ Tray, Menu, nativeImage, clientRoot, show, quit, text }) {
  const tray = new Tray(nativeImage.createFromPath(path.join(clientRoot, 'icon.ico')));
  tray.setToolTip('Grok Bot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text('打开 Grok Bot', 'Open Grok Bot'), click: show },
    { type: 'separator' },
    { label: text('退出', 'Quit'), click: quit },
  ]));
  tray.on('click', show);
  return tray;
}

export function initialLink(argv) {
  return argv.find(value => typeof value === 'string' && value.startsWith('grokbot-local:')) ?? null;
}
