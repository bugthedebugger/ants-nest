import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { configureCloudflare, createDesktopNamed, createDesktopQuick, doctor, listTunnels, removeTunnel, startTunnel, stopTunnel, tunnelLogs } from "../core/manager";
import { cloudflareSetupSchema, desktopNamedInputSchema, desktopQuickInputSchema } from "../shared/types";
import { newRemotePairing, remoteStatus, remoteTunnelId, revokeAllRemoteDevices, revokeRemoteDevice, startRemoteAccess, stopRemoteAccess } from "../core/remote";
import { startStateChangeServer } from "../core/change-events";

let mainWindow: BrowserWindow | undefined;
let stopStateChangeServer: (() => Promise<void>) | undefined;

function registerIpc() {
  ipcMain.handle("ants:doctor", () => doctor());
  ipcMain.handle("ants:configure-cloudflare", (_event, input) => configureCloudflare(cloudflareSetupSchema.parse(input)));
  ipcMain.handle("ants:list", async () => {
    const tunnels = await listTunnels();
    return tunnels.filter((tunnel) => tunnel.id !== remoteTunnelId());
  });
  ipcMain.handle("ants:quick", (_event, input) => createDesktopQuick(desktopQuickInputSchema.parse(input)));
  ipcMain.handle("ants:create-named", (_event, input) => createDesktopNamed(desktopNamedInputSchema.parse(input)));
  ipcMain.handle("ants:start", (_event, id: unknown) => startTunnel(String(id)));
  ipcMain.handle("ants:stop", (_event, id: unknown) => stopTunnel(String(id)));
  ipcMain.handle("ants:remove", (_event, id: unknown) => removeTunnel(String(id)));
  ipcMain.handle("ants:logs", (_event, id: unknown) => tunnelLogs(String(id)));
  ipcMain.handle("ants:remote-status", () => remoteStatus());
  ipcMain.handle("ants:start-remote", () => startRemoteAccess());
  ipcMain.handle("ants:stop-remote", () => stopRemoteAccess());
  ipcMain.handle("ants:new-remote-pairing", () => newRemotePairing());
  ipcMain.handle("ants:revoke-remote-device", (_event, id: unknown) => revokeRemoteDevice(String(id)));
  ipcMain.handle("ants:revoke-all-remote-devices", () => revokeAllRemoteDevices());
  ipcMain.handle("ants:open-external", async (_event, rawUrl: unknown) => {
    const url = new URL(String(rawUrl));
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported link protocol");
    await shell.openExternal(url.toString());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#090a0c",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const developmentUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged ? "http://localhost:5173" : undefined);
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl).catch(() => {
      setTimeout(() => void mainWindow?.loadURL(developmentUrl), 500);
    });
  } else void mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  stopStateChangeServer = await startStateChangeServer(() => mainWindow?.webContents.send("ants:state-changed"));
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  if (!remoteStatus().enabled) {
    quitting = true;
    if (stopStateChangeServer) {
      event.preventDefault();
      void stopStateChangeServer().finally(() => app.quit());
    }
    return;
  }
  event.preventDefault();
  void stopRemoteAccess().then(() => stopStateChangeServer?.()).finally(() => { quitting = true; app.quit(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
