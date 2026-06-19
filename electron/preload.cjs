const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nubraDesktop", {
  openWidget: () => ipcRenderer.invoke("open-option-widget"),
  openMain: () => ipcRenderer.invoke("open-main-window"),
  minimizeWidget: () => ipcRenderer.invoke("minimize-widget"),
  toggleMaximizeWidget: () => ipcRenderer.invoke("toggle-maximize-widget"),
  closeWidget: () => ipcRenderer.invoke("close-widget"),
  onWidgetMaximizedChanged: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on("widget-maximized-changed", listener);
    return () => ipcRenderer.removeListener("widget-maximized-changed", listener);
  }
});
