import { contextBridge, ipcRenderer } from "electron";
import type { AntsNestApi } from "../shared/types";

const api: AntsNestApi = {
  onStateChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("ants:state-changed", listener);
    return () => ipcRenderer.removeListener("ants:state-changed", listener);
  },
  doctor: () => ipcRenderer.invoke("ants:doctor"),
  configureCloudflare: (input) => ipcRenderer.invoke("ants:configure-cloudflare", input),
  list: () => ipcRenderer.invoke("ants:list"),
  quick: (input) => ipcRenderer.invoke("ants:quick", input),
  createNamed: (input) => ipcRenderer.invoke("ants:create-named", input),
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
  openExternal: (url) => ipcRenderer.invoke("ants:open-external", url),
};

contextBridge.exposeInMainWorld("antsNest", api);
