const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const port = Number(process.env.PORT || 5174);
const appUrl = `http://localhost:${port}/`;
let serverProcess = null;
let mainWindow = null;
let widgetWindow = null;

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
    skipTaskbar: false,
    backgroundColor: "#080808",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  widgetWindow.setAlwaysOnTop(true, "screen-saver");
  widgetWindow.loadURL(`${appUrl}?view=widget`);
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

ipcMain.handle("close-widget", () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
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
