import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { configureCloudflare, createDesktopNamed, createDesktopQuick, doctor, isRemoteTunnel, listTunnels, removeTunnel, startTunnel, stopTunnel, tunnelLogs } from "../core/manager";
import { cloudflareSetupSchema, desktopNamedInputSchema, desktopQuickInputSchema, type RemoteAccessState } from "../shared/types";
import { newRemotePairing, remoteStatus, remoteTunnelId, restoreRemoteAccess, revokeAllRemoteDevices, revokeRemoteDevice, shutdownRemoteAccess, startRemoteAccess, stopRemoteAccess } from "../core/remote";
import { startStateChangeServer } from "../core/change-events";
import { startAppControlServer, type AppControlRequest } from "../core/app-control";

let mainWindow: BrowserWindow | undefined;
let stopStateChangeServer: (() => Promise<void>) | undefined;
let stopAppControlServer: (() => Promise<void>) | undefined;
let appControlQueue = Promise.resolve();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();
app.on("second-instance", () => {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function notifyRendererStateChanged() {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  try {
    window.webContents.send("ants:state-changed");
  } catch (error) {
    // The native window can be destroyed between the checks above and send()
    // while Electron is shutting down. Ignore only that expected close race.
    if (error instanceof Error && error.message.includes("Object has been destroyed")) return;
    throw error;
  }
}

async function performAppControl(request: AppControlRequest): Promise<RemoteAccessState> {
  let result: RemoteAccessState;
  switch (request.operation) {
    case "remote-status": result = remoteStatus(); break;
    case "remote-enable": result = await startRemoteAccess(); break;
    case "remote-pair": result = newRemotePairing(); break;
    case "remote-revoke": result = await revokeRemoteDevice(request.deviceId); break;
    case "remote-revoke-all": result = await revokeAllRemoteDevices(); break;
    case "remote-disable": result = await stopRemoteAccess(); break;
  }
  if (request.operation !== "remote-status") notifyRendererStateChanged();
  return result;
}

function handleAppControl(request: AppControlRequest): Promise<RemoteAccessState> {
  const operation = appControlQueue.then(() => performAppControl(request));
  appControlQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function stopLocalServers() {
  await Promise.all([stopStateChangeServer?.(), stopAppControlServer?.()]);
}

function registerIpc() {
  ipcMain.handle("ants:doctor", () => doctor());
  ipcMain.handle("ants:configure-cloudflare", (_event, input) => configureCloudflare(cloudflareSetupSchema.parse(input)));
  ipcMain.handle("ants:list", async () => {
    const tunnels = await listTunnels();
    return tunnels.filter((tunnel) => tunnel.id !== remoteTunnelId() && !isRemoteTunnel(tunnel));
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
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin" ? { titleBarOverlay: { color: "#101010", symbolColor: "#d8d6d0", height: 40 } } : {}),
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
  window.once("closed", () => { if (mainWindow === window) mainWindow = undefined; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const developmentUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged ? "http://localhost:5173" : undefined);
  if (developmentUrl) {
    void window.loadURL(developmentUrl).catch(() => {
      setTimeout(() => { if (!window.isDestroyed()) void window.loadURL(developmentUrl); }, 500);
    });
  } else void window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  stopStateChangeServer = await startStateChangeServer(notifyRendererStateChanged);
  stopAppControlServer = await startAppControlServer(handleAppControl);
  registerIpc();
  createWindow();
  void restoreRemoteAccess().catch((error) => console.error("Could not restore remote access:", error));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  if (!remoteStatus().enabled) {
    quitting = true;
    if (stopStateChangeServer) {
      event.preventDefault();
      void stopLocalServers().finally(() => app.quit());
    }
    return;
  }
  event.preventDefault();
  void shutdownRemoteAccess().then(stopLocalServers).finally(() => { quitting = true; app.quit(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
