const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

let mainWindow = null;

function createMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "togglefullscreen", label: "切换全屏" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "项目目录",
          click: async () => {
            await shell.openPath(app.getAppPath());
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1040,
    minWidth: 1200,
    minHeight: 820,
    backgroundColor: "#efe8dc",
    title: "PDF Mask Designer",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(app.getAppPath(), "renderer", "index.html"));
}

ipcMain.handle("desktop:save-file", async (event, payload) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const {
    defaultName = "output.bin",
    mimeType = "application/octet-stream",
    filters = [],
    bytes,
  } = payload || {};

  const defaultPath = path.join(app.getPath("downloads"), defaultName);
  const { canceled, filePath } = await dialog.showSaveDialog(senderWindow, {
    defaultPath,
    filters,
  });

  if (canceled || !filePath) {
    return { canceled: true };
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  await fs.writeFile(filePath, buffer);
  return { canceled: false, filePath, mimeType };
});

app.whenReady().then(() => {
  createMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
