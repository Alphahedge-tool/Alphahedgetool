const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { appendFileSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const nubraData = path.join(os.homedir(), ".nubra-options-intelligence");
try { mkdirSync(nubraData, { recursive: true }); } catch {}
app.setPath("userData", nubraData);
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disk-cache-size", "1");

const rootDir = path.join(__dirname, "..");
const debugLogPath = path.join(rootDir, "electron-debug.log");
const port = Number(process.env.PORT || 5174);
const appUrl = `http://localhost:${port}/`;
let serverProcess = null;
let mainWindow = null;
let widgetWindow = null;

function writeDebugLog(message) {
  if (!process.env.NUBRA_ELECTRON_DEBUG) return;
  try {
    appendFileSync(debugLogPath, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function attachWindowDiagnostics(win, label) {
  win.webContents.on("console-message", (event) => {
    writeDebugLog(`[${label}:console:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  win.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    writeDebugLog(`[${label}:did-fail-load] ${code} ${description} ${validatedURL}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    writeDebugLog(`[${label}:render-process-gone] ${details.reason} ${details.exitCode}`);
  });
}

async function isServerReady() {
  try {
    const response = await fetch(appUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isServerReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local app server did not start at ${appUrl}`);
}

async function ensureServer() {
  if (await isServerReady()) return;
  serverProcess = spawn("node", ["server.js"], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    windowsHide: true
  });
  serverProcess.unref();
  await waitForServer();
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: "Nubra Options Intelligence",
    backgroundColor: "#080808",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  attachWindowDiagnostics(mainWindow, "main");
  mainWindow.loadURL(appUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.show();
    widgetWindow.focus();
    return widgetWindow;
  }

  widgetWindow = new BrowserWindow({
    width: 1180,
    height: 560,
    minWidth: 860,
    minHeight: 420,
    title: "Option Chain Widget",
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    skipTaskbar: false,
    backgroundColor: "#080808",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  attachWindowDiagnostics(widgetWindow, "widget");
  widgetWindow.setAlwaysOnTop(true, "screen-saver");
  widgetWindow.loadURL(`${appUrl}?view=widget`);
  const sendMaximizedState = () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send("widget-maximized-changed", widgetWindow.isMaximized());
    }
  };
  widgetWindow.on("maximize", sendMaximizedState);
  widgetWindow.on("unmaximize", sendMaximizedState);
  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });
  return widgetWindow;
}

ipcMain.handle("open-option-widget", () => {
  createWidgetWindow();
});

ipcMain.handle("open-main-window", () => {
  createMainWindow();
});

function widgetFromEvent(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) return null;
  return senderWindow === widgetWindow ? senderWindow : null;
}

ipcMain.handle("minimize-widget", (event) => {
  const win = widgetFromEvent(event);
  if (!win || !win.isMinimizable()) return false;
  win.minimize();
  return true;
});

ipcMain.handle("toggle-maximize-widget", (event) => {
  const win = widgetFromEvent(event);
  if (!win || !win.isMaximizable()) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

ipcMain.handle("close-widget", (event) => {
  widgetFromEvent(event)?.close();
});

app.whenReady().then(async () => {
  await ensureServer();
  if (process.argv.includes("--widget")) {
    createWidgetWindow();
  } else {
    createMainWindow();
  }
  app.on("activate", () => {
    createMainWindow();
  });
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
