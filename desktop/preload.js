const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  isDesktopApp: true,
  saveFile: async ({ defaultName, mimeType, filters, bytes }) => {
    return ipcRenderer.invoke("desktop:save-file", {
      defaultName,
      mimeType,
      filters,
      bytes,
    });
  },
});
