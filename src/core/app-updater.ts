import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateState } from "../shared/types";

let state: AppUpdateState = { status: "idle" };
let started = false;

function updateErrorMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error: /, "");
}

function setState(patch: Partial<AppUpdateState>) {
  state = { ...state, ...patch };
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send("ants:update-state", state);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Object has been destroyed")) continue;
      throw error;
    }
  }
}

export function currentUpdateState(): AppUpdateState {
  return state;
}

export function startAppUpdater() {
  if (started || !app.isPackaged) return;
  started = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => setState({ status: "checking", error: undefined }));
  autoUpdater.on("update-available", (info) => setState({ status: "available", version: info.version, percent: undefined, error: undefined }));
  autoUpdater.on("update-not-available", (info) => setState({ status: "not-available", version: info.version, error: undefined }));
  autoUpdater.on("download-progress", (progress) => setState({ status: "downloading", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => setState({ status: "downloaded", version: info.version, percent: 100 }));
  autoUpdater.on("error", (error) => setState({ status: "error", error: updateErrorMessage(error) }));
}

const checkIntervalMs = 4 * 60 * 60 * 1000;

export function scheduleUpdateChecks() {
  if (!app.isPackaged) return;
  const timer = setInterval(() => {
    void checkForAppUpdates().catch(() => undefined);
  }, checkIntervalMs);
  timer.unref?.();
}

export async function checkForAppUpdates(): Promise<AppUpdateState> {
  if (!app.isPackaged) return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setState({ status: "error", error: updateErrorMessage(error) });
  }
  return state;
}

export async function downloadAppUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged) throw new Error("Updates are available in the packaged app");
  if (state.status === "downloaded") return state;
  await autoUpdater.downloadUpdate();
  return state;
}

export function installAppUpdate() {
  if (!app.isPackaged) throw new Error("Updates are available in the packaged app");
  setImmediate(() => {
    app.removeAllListeners("window-all-closed");
    BrowserWindow.getAllWindows().forEach((window) => window.removeAllListeners("closed"));
    autoUpdater.quitAndInstall(false, true);
  });
}

export function registerUpdateIpc() {
  ipcMain.handle("ants:update-status", () => currentUpdateState());
  ipcMain.handle("ants:update-check", () => checkForAppUpdates());
  ipcMain.handle("ants:update-download", () => downloadAppUpdate());
  ipcMain.handle("ants:update-install", () => installAppUpdate());
}
