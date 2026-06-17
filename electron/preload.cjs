const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nubraDesktop", {
  openWidget: () => ipcRenderer.invoke("open-option-widget"),
  openMain: () => ipcRenderer.invoke("open-main-window"),
  closeWidget: () => ipcRenderer.invoke("close-widget")
});
