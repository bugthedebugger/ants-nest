import { contextBridge, ipcRenderer } from "electron";
import type { AntsNestApi } from "../shared/types";

const api: AntsNestApi = {
  onStateChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("ants:state-changed", listener);
    return () => ipcRenderer.removeListener("ants:state-changed", listener);
  },
  appVersion: () => ipcRenderer.invoke("ants:app-version"),
  doctor: () => ipcRenderer.invoke("ants:doctor"),
  configureCloudflare: (input) => ipcRenderer.invoke("ants:configure-cloudflare", input),
  list: () => ipcRenderer.invoke("ants:list"),
  quick: (input) => ipcRenderer.invoke("ants:quick", input),
  quickFile: (input) => ipcRenderer.invoke("ants:quick-file", input),
  createNamed: (input) => ipcRenderer.invoke("ants:create-named", input),
  createNamedFile: (input) => ipcRenderer.invoke("ants:create-named-file", input),
  start: (id) => ipcRenderer.invoke("ants:start", id),
  stop: (id) => ipcRenderer.invoke("ants:stop", id),
  remove: (id) => ipcRenderer.invoke("ants:remove", id),
  logs: (id) => ipcRenderer.invoke("ants:logs", id),
  remoteStatus: () => ipcRenderer.invoke("ants:remote-status"),
  startRemote: () => ipcRenderer.invoke("ants:start-remote"),
  stopRemote: () => ipcRenderer.invoke("ants:stop-remote"),
  newRemotePairing: () => ipcRenderer.invoke("ants:new-remote-pairing"),
  revokeRemoteDevice: (id) => ipcRenderer.invoke("ants:revoke-remote-device", id),
  revokeAllRemoteDevices: () => ipcRenderer.invoke("ants:revoke-all-remote-devices"),
  cliInstallationStatus: () => ipcRenderer.invoke("ants:cli-installation-status"),
  installCli: () => ipcRenderer.invoke("ants:install-cli"),
  uninstallCli: () => ipcRenderer.invoke("ants:uninstall-cli"),
  chooseSharePath: (kind) => ipcRenderer.invoke("ants:choose-share-path", kind),
  openExternal: (url) => ipcRenderer.invoke("ants:open-external", url),
  setTitleBarTheme: (theme) => ipcRenderer.send("ants:set-title-bar-theme", theme),
  updateStatus: () => ipcRenderer.invoke("ants:update-status"),
  checkForUpdate: () => ipcRenderer.invoke("ants:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("ants:update-download"),
  installUpdate: () => ipcRenderer.invoke("ants:update-install"),
  onUpdateState: (callback) => {
    const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on("ants:update-state", listener);
    return () => ipcRenderer.removeListener("ants:update-state", listener);
  },
};

contextBridge.exposeInMainWorld("antsNest", api);
