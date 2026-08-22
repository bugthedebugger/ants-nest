import type { AntsNestApi, DoctorResult, RemoteAccessState, TunnelView } from "../shared/types";

type Listener = () => void;

const tunnels: TunnelView[] = [
  {
    id: "stories", profileId: "stories", name: "Stories", description: "Live Stories",
    kind: "named", origin: "http://localhost:8788", hostname: "stories.bugthedebugger.com",
    tunnelName: "stories", status: "stopped",
    createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    stoppedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  },
  {
    id: "docs-preview", profileId: "docs-preview", name: "Docs preview", description: "Draft of the new docs site for review",
    kind: "quick", origin: "http://localhost:3000", sharedPath: "/home/me/project/docs", tokenRequired: false,
    status: "online", publicUrl: "https://preview.bugthedebugger.com",
    createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  },
];

const doctor: DoctorResult = {
  installed: true, authenticated: true, version: "2025.5.0", configDirectory: "~/.ants-nest",
  proxyDomain: "bugthedebugger.com",
};

let remote: RemoteAccessState = {
  enabled: true,
  localUrl: "http://127.0.0.1:8791",
  publicUrl: "https://antsnest.bugthedebugger.com",
  pairingUrl: "https://antsnest.bugthedebugger.com/pair?code=ABCD-1234-EFGH",
  startedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
  devices: [{ id: "d1", name: "Android · Firefox", createdAt: new Date().toISOString(), lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() }],
};

const cliStatus = {
  supported: true, installed: true, onPath: true, version: "0.3.4",
  commands: ["ants", "ants-nest"], binDirectory: "/home/bugthedebugger/.local/bin",
};

const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 120));
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

window.antsNest = {
  appVersion: () => delay("0.3.4"),
  doctor: () => delay(doctor),
  configureCloudflare: (input) => { Object.assign(doctor, { authenticated: true, proxyDomain: input.proxyDomain }); return delay(doctor); },
  list: () => delay([...tunnels]),
  quick: (input) => { const t: TunnelView = { id: crypto.randomUUID(), profileId: crypto.randomUUID(), name: input.name, description: input.description ?? "", kind: "quick", origin: input.origin, hostname: input.hostname, status: "online", publicUrl: `https://${input.hostname}`, createdAt: new Date().toISOString(), startedAt: new Date().toISOString() }; tunnels.unshift(t); emit(); return delay(t); },
  quickFile: () => Promise.reject(new Error("Preview mock")),
  createNamed: () => Promise.reject(new Error("Preview mock")),
  createNamedFile: () => Promise.reject(new Error("Preview mock")),
  start: async (id) => { const t = tunnels.find((x) => x.id === id); if (t) { t.status = "online"; t.publicUrl = t.publicUrl || `https://${t.hostname}`; t.startedAt = new Date().toISOString(); } emit(); return tunnels[0]!; },
  stop: async (id) => { const t = tunnels.find((x) => x.id === id); if (t) { t.status = "stopped"; t.stoppedAt = new Date().toISOString(); } emit(); return tunnels[0]!; },
  remove: async (id) => { const i = tunnels.findIndex((x) => x.id === id); if (i >= 0) tunnels.splice(i, 1); emit(); },
  logs: () => delay("2026-08-22T09:12:01Z INF +1 configuration loaded from file\n2026-08-22T09:12:02Z INF Connection registered\n"),
  remoteStatus: () => delay(remote),
  startRemote: async () => { remote = { ...remote, enabled: true }; emit(); return remote; },
  stopRemote: async () => { remote = { ...remote, enabled: false, devices: [] }; emit(); return remote; },
  newRemotePairing: () => delay({ ...remote, pairingUrl: `${remote.publicUrl}/pair?code=WXYZ-5678-QRST` }),
  revokeRemoteDevice: async (id) => { remote = { ...remote, devices: remote.devices.filter((d) => d.id !== id) }; emit(); return remote; },
  revokeAllRemoteDevices: async () => { remote = { ...remote, devices: [] }; emit(); return remote; },
  cliInstallationStatus: () => delay(cliStatus),
  installCli: () => delay(cliStatus),
  uninstallCli: async () => ({ ...cliStatus, installed: false }),
  chooseSharePath: () => Promise.resolve(undefined),
  openExternal: (url) => { console.info("openExternal", url); return Promise.resolve(); },
  updateStatus: () => delay({ status: "not-available" }),
  checkForUpdate: () => delay({ status: "not-available" }),
  downloadUpdate: () => delay({ status: "downloading" }),
  installUpdate: () => Promise.resolve(),
  onUpdateState: () => () => undefined,
  onStateChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
} as AntsNestApi;

export {};
