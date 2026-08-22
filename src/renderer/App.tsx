import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleStop, Clock3, Cloud, Copy, FileText, FolderOpen, LockKeyhole, MonitorSmartphone, MoreHorizontal, Play, Plus, QrCode, Radio, RefreshCw, Settings2, ShieldCheck, Terminal, Trash2, X, Zap } from "lucide-react";
import QRCode from "qrcode";
import appIconUrl from "../../assets/icon.png";
import type { AppUpdateState, CliInstallationStatus, CloudflareSetupInput, DoctorResult, RemoteAccessState, TunnelView } from "../shared/types";
import { formatRemaining } from "../shared/duration";
import { hostnameFromSubdomain } from "../shared/validation";

type Page = "tunnels" | "remote" | "settings";
type Modal = "tunnel" | "logs" | null;

function message(error: unknown) {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': /, "");
  return String(error);
}

function relativeTime(value?: string) {
  if (!value) return "Never";
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function Logo() {
  return <img className="logo" src={appIconUrl} alt="Ants Nest" />;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="icon-button" title="Copy link" onClick={() => {
    void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>;
}

type SelectChoice = { value: string; label: string; description?: string };

function SelectMenu({ value, options, icon, placement = "down", onChange }: { value: string; options: SelectChoice[]; icon: ReactNode; placement?: "up" | "down"; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className={`select-menu ${placement} ${open ? "open" : ""}`} ref={menuRef}>
    <button type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{icon}<span className="select-current"><strong>{selected.label}</strong>{selected.description && <small>{selected.description}</small>}</span><ChevronDown className="select-chevron" size={14}/></button>
    {open && <div className="select-options" role="listbox">{options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={14}/>}</button>)}</div>}
  </div>;
}

const updateButtonTitles: Record<AppUpdateState["status"], string> = {
  idle: "Check for updates",
  checking: "Checking for updates…",
  available: "Download update",
  downloading: "Downloading update…",
  downloaded: "Restart to install the update",
  "not-available": "Up to date — check again",
  error: "Update check failed — retry",
};

function UpdateButton({ update, busy, onClick }: { update: AppUpdateState; busy: boolean; onClick: () => void }) {
  const status = busy ? "checking" : update.status;
  return (
    <button className={`update-button${status === "downloaded" ? " ready" : ""}`} title={`${updateButtonTitles[status]}${update.version ? ` (v${update.version})` : ""}`} onClick={onClick}>
      {status === "downloading"
        ? <span className="update-percent">{Math.min(100, Math.round(update.percent ?? 0))}<small>%</small></span>
        : <RefreshCw size={13} className={status === "checking" ? "spin" : ""} />}
      {(status === "available" || status === "downloaded") && <i className="notif-dot" />}
    </button>
  );
}

export function App() {
  const [tunnels, setTunnels] = useState<TunnelView[]>([]);
  const [doctor, setDoctor] = useState<DoctorResult>();
  const [remote, setRemote] = useState<RemoteAccessState>({ enabled: false, devices: [] });
  const [cliInstallation, setCliInstallation] = useState<CliInstallationStatus>();
  const [appVersion, setAppVersion] = useState("");
  const [qrCode, setQrCode] = useState<string>();
  const [page, setPage] = useState<Page>("tunnels");
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<TunnelView>();
  const [logs, setLogs] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [update, setUpdate] = useState<AppUpdateState>();
  const [updateBusy, setUpdateBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [nextTunnels, nextDoctor, nextRemote, nextCliInstallation] = await Promise.all([window.antsNest.list(), window.antsNest.doctor(), window.antsNest.remoteStatus(), window.antsNest.cliInstallationStatus()]);
    setTunnels(nextTunnels); setDoctor(nextDoctor); setRemote(nextRemote); setCliInstallation(nextCliInstallation);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(message(e)));
    void window.antsNest.appVersion().then(setAppVersion).catch(() => undefined);
    void window.antsNest.updateStatus().then(setUpdate).catch(() => undefined);
    return window.antsNest.onStateChanged(() => void refresh().catch(() => undefined));
  }, [refresh]);
  useEffect(() => window.antsNest.onUpdateState(setUpdate), []);

  const live = tunnels.filter((t) => t.status === "online").length;

  async function action(key: string, task: () => Promise<unknown>) {
    setBusy(key); setError(undefined);
    try { await task(); await refresh(); return true; } catch (e) { setError(message(e)); return false; }
    finally { setBusy(undefined); }
  }

  async function showLogs(tunnel: TunnelView) {
    setSelected(tunnel); setLogs(await window.antsNest.logs(tunnel.id)); setModal("logs");
  }

  async function startRemote() {
    await action("remote", async () => {
      const state = await window.antsNest.startRemote();
      setRemote(state);
      if (state.pairingUrl) setQrCode(await QRCode.toDataURL(state.pairingUrl, { width: 420, margin: 2, color: { dark: "#111111", light: "#f1efe9" } }));
    });
  }

  async function openRemotePage() {
    setPage("remote");
    if (remote.pairingUrl) setQrCode(await QRCode.toDataURL(remote.pairingUrl, { width: 420, margin: 2, color: { dark: "#111111", light: "#f1efe9" } }));
  }

  async function createPairing() {
    await action("pairing", async () => {
      const state = await window.antsNest.newRemotePairing();
      setRemote(state);
      if (state.pairingUrl) setQrCode(await QRCode.toDataURL(state.pairingUrl, { width: 420, margin: 2, color: { dark: "#111111", light: "#f1efe9" } }));
    });
  }

  async function checkForUpdate() {
    setUpdateBusy(true);
    try {
      const state = await window.antsNest.checkForUpdate();
      if (state.status === "error") setError(state.error ?? "Could not check for updates");
    } catch (e) { setError(message(e)); }
    finally { setUpdateBusy(false); }
  }

  function onUpdateButtonClick() {
    const status = updateBusy ? "checking" : update?.status ?? "idle";
    if (status === "available") void window.antsNest.downloadUpdate().catch((e) => setError(message(e)));
    else if (status === "downloaded") void window.antsNest.installUpdate().catch((e) => setError(message(e)));
    else if (status !== "downloading") void checkForUpdate();
  }

  return <div className="app-frame">
    <div className="titlebar"><Logo /><strong>Ants Nest</strong><span>{doctor?.proxyDomain || "Local tunnel manager"}</span></div>
    <div className="shell">
      <aside>
        <nav>
          <button className={page === "tunnels" ? "active" : ""} onClick={() => setPage("tunnels")}><Cloud size={17} /><span className="nav-label">Tunnels</span><span className="nav-meta">{tunnels.length}</span></button>
          <button className={page === "remote" ? "active" : ""} onClick={() => void openRemotePage()}><MonitorSmartphone size={17} /><span className="nav-label">Remote access</span>{remote.enabled && <span className="nav-live">ON</span>}</button>
          <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}><Settings2 size={17} /><span className="nav-label">Settings</span></button>
        </nav>
        <div className="sidebar-bottom">
          <button className="connection" onClick={() => setPage("settings")}><i className={doctor?.installed && doctor?.authenticated ? "ok" : ""} /><span>{doctor?.installed && doctor?.authenticated ? "Cloudflare connected" : "Setup required"}</span></button>
          <div className="version-row">
            <span className="app-version">Ants Nest v{appVersion || "—"}</span>
            <UpdateButton update={update ?? { status: "idle" }} busy={updateBusy} onClick={onUpdateButtonClick} />
          </div>
        </div>
      </aside>

      <main>
        {page === "tunnels" && <>
        <header><div><h1>Tunnels</h1><p>Publish local services and revoke access from one place.</p></div>
          <div className="header-actions"><button className="icon-button refresh" title="Refresh" onClick={() => void refresh()}><RefreshCw size={16} /></button><button className="primary" onClick={() => setModal("tunnel")}><Plus size={16} /> New tunnel</button></div>
        </header>

        {error && <div className="error"><span>{error}</span><button onClick={() => setError(undefined)}><X size={15}/></button></div>}

        {tunnels.length > 0 && <section className="summary-bar"><span><b>{live}</b> live</span><i/><span><b>{tunnels.filter(t => t.kind === "quick").length}</b> quick</span><i/><span><b>{tunnels.filter(t => t.kind === "named").length}</b> named</span></section>}

        <section className="tunnel-section">
          <div className="section-title"><span className="kicker">All tunnels</span><p>Changes from the CLI appear here automatically.</p></div>
          {!tunnels.length ? <Empty /> : <div className="tunnel-list">
          {tunnels.map((tunnel) => <TunnelRow key={tunnel.id} tunnel={tunnel} busy={busy === tunnel.id}
            onToggle={() => void action(tunnel.id, () => tunnel.status === "online" ? window.antsNest.stop(tunnel.id) : window.antsNest.start(tunnel.id))}
            onLogs={() => void showLogs(tunnel).catch((e) => setError(message(e)))}
            onRemove={() => void action(tunnel.id, () => window.antsNest.remove(tunnel.id))} />)}
          </div>}
        </section>
        </>}

        {page === "remote" && <RemotePage state={remote} qrCode={qrCode} busy={busy} installed={doctor?.installed ?? false} proxyDomain={doctor?.proxyDomain} error={error}
          onDismissError={() => setError(undefined)} onEnable={() => void startRemote()} onNewPairing={() => void createPairing()}
          onRevoke={(id) => void action(`revoke-${id}`, async () => setRemote(await window.antsNest.revokeRemoteDevice(id)))}
          onRevokeAll={() => void action("revoke-all", async () => setRemote(await window.antsNest.revokeAllRemoteDevices()))}
          onStop={() => void action("remote-stop", async () => setRemote(await window.antsNest.stopRemote()))} />}

        {page === "settings" && <SettingsPage configured={doctor?.authenticated ?? false} busy={busy === "setup"} cliBusy={busy} cliInstallation={cliInstallation} error={error} configuredDomain={doctor?.proxyDomain}
          onDismissError={() => setError(undefined)} onSave={async (input) => { await action("setup", () => window.antsNest.configureCloudflare(input)); }}
          onInstallCli={async () => { await action("install-cli", async () => setCliInstallation(await window.antsNest.installCli())); }}
          onUninstallCli={async () => { await action("uninstall-cli", async () => setCliInstallation(await window.antsNest.uninstallCli())); }} />}
      </main>

      {modal === "tunnel" && <TunnelModal installed={doctor?.installed ?? false} proxyDomain={doctor?.proxyDomain} onClose={() => setModal(null)} onComplete={async (task) => { if (await action("create", task)) setModal(null); }} busy={busy === "create"} />}
      {modal === "logs" && selected && <LogsModal tunnel={selected} logs={logs} onClose={() => setModal(null)} />}
    </div>
  </div>;
}

function RemotePage({ state, qrCode, busy, installed, proxyDomain, error, onDismissError, onEnable, onStop, onNewPairing, onRevoke, onRevokeAll }: { state: RemoteAccessState; qrCode?: string | undefined; busy?: string | undefined; installed: boolean; proxyDomain?: string | undefined; error?: string | undefined; onDismissError(): void; onEnable(): void; onStop(): void; onNewPairing(): void; onRevoke(id: string): void; onRevokeAll(): void }) {
  return <div className="page remote-page">
    <header><div><h1>Remote access</h1><p>Securely control Ants Nest from your other devices.</p></div>{state.enabled && <button className="remote-stop" disabled={busy === "remote-stop"} onClick={onStop}>End remote access</button>}</header>
    {error && <div className="error"><span>{error}</span><button onClick={onDismissError}><X size={15}/></button></div>}
    {!state.enabled ? <section className="remote-enable-panel"><h2>Access Ants Nest from anywhere</h2><p>Creates a secure dashboard at antsnest.{proxyDomain || "your-domain.com"}. Every browser must pair with a one-time code and can be revoked individually.</p><button className="primary" disabled={!installed || busy === "remote"} onClick={onEnable}>{busy === "remote" ? <><RefreshCw className="spin" size={15}/> Enabling…</> : <><MonitorSmartphone size={15}/> Enable remote access</>}</button></section> : <div className="remote-page-grid"><section className="remote-pairing-panel">
    <div className="panel-heading"><div><span className="kicker">Pairing</span><h2>Pair a device</h2><p>Scan this one-time code from the device you want to authorize.</p></div></div>
    {state.pairingUrl ? <><div className="qr-wrap">{qrCode ? <img src={qrCode} alt="Remote access pairing QR code"/> : <RefreshCw className="spin"/>}</div><div className="pairing-url"><span>{state.publicUrl}</span><CopyButton value={state.pairingUrl}/></div><p className="single-use"><ShieldCheck size={13}/> Single-use code — it expires as soon as one browser pairs.</p></> : <div className="new-pairing"><QrCode size={18}/><h3>Pair another device</h3><p>Generate a fresh one-time QR code. Existing authorized devices remain connected.</p><button className="primary" disabled={busy === "pairing"} onClick={onNewPairing}>{busy === "pairing" ? "Generating…" : "Generate pairing code"}</button></div>}
    {state.pairingUrl && <button className="secondary open-pairing" onClick={() => void window.antsNest.openExternal(state.pairingUrl!)}>Open pairing page <ArrowUpRight size={14}/></button>}
    </section><section className="devices-panel">
    <div className="device-heading"><div><strong>Authorized devices</strong><span>{state.devices.length}</span></div>{state.devices.length > 0 && <button disabled={busy === "revoke-all"} onClick={onRevokeAll}>Revoke all</button>}</div>
    <div className="device-list">{state.devices.length ? state.devices.map((device) => <div className="device" key={device.id}><div><strong>{device.name}</strong><span>Last active {relativeTime(device.lastSeenAt)}</span></div><button disabled={busy === `revoke-${device.id}`} onClick={() => onRevoke(device.id)}>Revoke</button></div>) : <div className="no-devices">No devices paired yet.</div>}</div>
    <div className="security-note"><ShieldCheck size={16}/><div><strong>Per-device access</strong><p>Each browser receives a unique token after pairing. Revocation is immediate, and that browser must scan a newly generated code to return.</p></div></div>
    </section></div>}
  </div>;
}

function SettingsPage({ configured, busy, cliBusy, cliInstallation, error, configuredDomain, onDismissError, onSave, onInstallCli, onUninstallCli }: { configured: boolean; busy: boolean; cliBusy?: string | undefined; cliInstallation?: CliInstallationStatus | undefined; error?: string | undefined; configuredDomain?: string | undefined; onDismissError(): void; onSave(input: CloudflareSetupInput): Promise<void>; onInstallCli(): Promise<void>; onUninstallCli(): Promise<void> }) {
  const [proxyDomain, setProxyDomain] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave({ proxyDomain, zoneId, accountId, apiToken });
  }
  return <div className="page settings-page"><div className="settings-inner"><header><div><h1>Settings</h1><p>Manage the Cloudflare connection shared by the app and CLI.</p></div></header><div className="settings-stack"><form className="settings-form" onSubmit={submit}>
    <div className="panel-heading"><div><span className="kicker">Cloudflare</span><h2>{configured ? "Configuration" : "Configure Cloudflare"}</h2><p>{configured ? `Connected to ${configuredDomain || "your Cloudflare domain"}. Enter all four values to replace the configuration.` : "Validates API access and installs the latest official cloudflared release."}</p></div></div>
    {error && <div className="error setup-error"><span>{error}</span><button type="button" onClick={onDismissError}><X size={15}/></button></div>}
    {configured && <div className="warning configured-warning"><Check size={15}/> Saving replaces the current configuration after the new values are validated.</div>}
    <label><code>CLOUDFLARE_PROXY_DOMAIN</code><input autoFocus value={proxyDomain} onChange={(event) => setProxyDomain(event.target.value)} placeholder="tunnels.example.com" required /></label>
    <label><code>CLOUDFLARE_ZONE_ID</code><input value={zoneId} onChange={(event) => setZoneId(event.target.value)} placeholder="32-character zone ID" minLength={32} maxLength={32} required /></label>
    <label><code>CLOUDFLARE_ACCOUNT_ID</code><input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="32-character account ID" minLength={32} maxLength={32} required /></label>
    <label><code>CLOUDFLARE_API_TOKEN</code><input type="password" autoComplete="off" value={apiToken} onChange={(event) => setApiToken(event.target.value)} placeholder="Token with Tunnel Edit + DNS Edit" required /><small>Stored locally in ~/.ants-nest/cloudflare.json with user-only permissions.</small></label>
    <div className="token-permissions"><ShieldCheck size={16}/><div><strong>Required token permissions</strong><p>Account · Cloudflare Tunnel · Edit<br/>Zone · DNS · Edit</p></div></div>
    <div className="form-actions"><button className="primary" disabled={busy}>{busy ? <><RefreshCw className="spin" size={15}/> Setting up…</> : <><Check size={15}/> Install, validate & save</>}</button></div>
  </form><section className="cli-install-panel"><div className="panel-heading"><div><span className="kicker">Agent CLI</span><h2>Command line</h2><p>Install the <code>ants</code> and <code>ants-nest</code> commands for every local terminal and coding agent.</p></div></div>
    {!cliInstallation?.supported ? <div className="cli-install-note">{cliInstallation?.reason || "CLI installation is available from the packaged Linux AppImage."}</div> : <>
      <div className="cli-install-status"><i className={cliInstallation.installed ? "ok" : ""}/><div><strong>{cliInstallation.installed ? `CLI ${cliInstallation.version || ""} installed` : "CLI not installed"}</strong><span>{cliInstallation.installed ? `${cliInstallation.commands.join(" and ")} are in ${cliInstallation.binDirectory}` : `Installs commands into ${cliInstallation.binDirectory}`}</span>{cliInstallation.installed && !cliInstallation.onPath && <small>Add this directory to PATH, then open a new terminal.</small>}</div></div>
      <div className="form-actions">{cliInstallation.installed && <button type="button" className="secondary" disabled={cliBusy === "uninstall-cli"} onClick={() => void onUninstallCli()}>{cliBusy === "uninstall-cli" ? "Removing…" : "Uninstall CLI"}</button>}<button type="button" className="primary" disabled={cliBusy === "install-cli"} onClick={() => void onInstallCli()}>{cliBusy === "install-cli" ? <><RefreshCw className="spin" size={15}/> Installing…</> : <><Terminal size={15}/> {cliInstallation.installed ? "Update CLI" : "Install CLI"}</>}</button></div>
    </>}
  </section></div></div></div>;
}

function Empty() {
  return <div className="empty"><h3>No tunnels yet</h3><p>Create one with the button above or ask an agent to run the Ants Nest CLI.</p></div>;
}

function TunnelRow({ tunnel, busy, onToggle, onLogs, onRemove }: { tunnel: TunnelView; busy: boolean; onToggle(): void; onLogs(): void; onRemove(): void }) {
  const online = tunnel.status === "online";
  return <article className="tunnel-row">
    <div className="tunnel-content">
      <div className="tunnel-heading"><h3>{tunnel.name}</h3><span className={`pill ${tunnel.status}`}><i />{tunnel.status}</span><span className="kind-label">{tunnel.kind}</span></div>
      <div className="url">{tunnel.publicUrl ? <><button onClick={() => void window.antsNest.openExternal(tunnel.publicUrl!)}>{tunnel.publicUrl.replace("https://", "")}<ArrowUpRight size={13}/></button><CopyButton value={tunnel.publicUrl}/></> : <span>Link appears when started</span>}</div>
      <p title={tunnel.description}>{tunnel.description || "No description"}</p>
      <div className="tunnel-meta"><span>{tunnel.sharedPath || tunnel.origin}</span>{tunnel.sharedPath && <><i/><span className="access-meta"><LockKeyhole size={10}/>{tunnel.tokenRequired === false ? "Public" : "Token protected"}</span></>}<i/><span>{tunnel.expiresAt ? `Expires ${formatRemaining(tunnel.expiresAt)}` : `Started ${relativeTime(tunnel.startedAt)}`}</span></div>
    </div>
    <div className="row-actions"><button className={`toggle ${online ? "stop" : "start"}`} disabled={busy} onClick={onToggle}>{busy ? <RefreshCw className="spin" size={15}/> : online ? <CircleStop size={15}/> : <Play size={15}/>} {online ? "Release" : "Start"}</button>
      <div className="menu"><button className="icon-button"><MoreHorizontal size={17}/></button><div className="menu-pop"><button onClick={onLogs}><FileText size={14}/> Logs</button><button className="danger" onClick={onRemove}><Trash2 size={14}/> Remove</button></div></div>
    </div>
  </article>;
}

function TunnelModal({ installed, proxyDomain, busy, onClose, onComplete }: { installed: boolean; proxyDomain?: string | undefined; busy: boolean; onClose(): void; onComplete(task: () => Promise<unknown>): Promise<void> }) {
  const [kind, setKind] = useState<"quick" | "named">("quick");
  const [sourceKind, setSourceKind] = useState<"service" | "files">("service");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState("3000");
  const [sharedPath, setSharedPath] = useState("");
  const [tokenRequired, setTokenRequired] = useState(true);
  const [subdomain, setSubdomain] = useState("preview");
  const [expirationMode, setExpirationMode] = useState("3600");
  const [expiresAt, setExpiresAt] = useState(() => new Date(Date.now() + 3_600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!proxyDomain) return;
    const hostname = hostnameFromSubdomain(subdomain, proxyDomain);
    const expiration = expirationMode === "exact" ? { expiresAt: new Date(expiresAt).toISOString() } : expirationMode ? { expiresInSeconds: Number(expirationMode) } : {};
    void onComplete(() => sourceKind === "files"
      ? kind === "quick" ? window.antsNest.quickFile({ name, description, path: sharedPath, hostname, tokenRequired, ...expiration }) : window.antsNest.createNamedFile({ name, description, path: sharedPath, hostname, tokenRequired, ...expiration })
      : kind === "quick" ? window.antsNest.quick({ name, description, origin, hostname, ...expiration }) : window.antsNest.createNamed({ name, description, origin, hostname, ...expiration }));
  }
  return <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><form className="modal" onSubmit={submit}>
    <div className="modal-head"><div><h2>New share</h2><p>Publish a local service, file, or folder on an available hostname.</p></div><button type="button" className="icon-button close" onClick={onClose}><X size={18}/></button></div>
    <div className="source-tabs" aria-label="What to share"><button type="button" className={sourceKind === "service" ? "active" : ""} onClick={() => setSourceKind("service")}><Radio size={13}/> Local service</button><button type="button" className={sourceKind === "files" ? "active" : ""} onClick={() => setSourceKind("files")}><FolderOpen size={13}/> File or folder</button></div>
    {!installed && <div className="warning">cloudflared is not installed. Complete Cloudflare Setup to install it.</div>}
    <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Docs preview" required /></label>
    <label>Public hostname<div className="input-prefix hostname-input"><span>https://</span><input value={subdomain} onChange={(event) => setSubdomain(event.target.value.toLowerCase())} placeholder="preview" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} autoCapitalize="none" spellCheck={false} required /><span className="domain-suffix">.{proxyDomain || "configure-domain-first"}</span></div><small>Choose an unused direct subdomain. Existing DNS records are never replaced.</small></label>
    <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this link exposes and who it is for" maxLength={240} required /><small>Shown in the desktop app, CLI, and phone dashboard.</small></label>
    {sourceKind === "service" ? <label>Local service<div className="input-prefix"><span>URL</span><input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="3000 or http://localhost:3000" required /></div><small>A port is automatically expanded to localhost.</small></label> : <><label>File or folder path<div className="input-prefix path-input"><span>PATH</span><input value={sharedPath} onChange={(e) => setSharedPath(e.target.value)} placeholder="/home/me/project/file.html" required /><div className="path-actions"><button type="button" onClick={() => void window.antsNest.chooseSharePath("file").then((value) => value && setSharedPath(value))}><FileText size={13}/> Choose file</button><button type="button" onClick={() => void window.antsNest.chooseSharePath("folder").then((value) => value && setSharedPath(value))}><FolderOpen size={13}/> Choose folder</button></div></div><small>Paste a path or choose what to share. Folders serve index.html when present, or show a directory browser.</small></label><button type="button" className={`token-toggle ${tokenRequired ? "active" : ""}`} role="switch" aria-checked={tokenRequired} onClick={() => setTokenRequired((required) => !required)}><span className="token-copy"><strong>Require an access token</strong><small>Recommended and enabled by default. The share URL includes the token; the bare hostname asks visitors to enter it.</small></span><span className="token-switch" aria-hidden="true"><i/></span></button></>}
    <label>Lifetime<SelectMenu value={kind} icon={<Zap size={14}/>} options={[{ value: "quick", label: "Quick share", description: "Expires automatically" }, { value: "named", label: "Named tunnel", description: "Until released" }]} onChange={(value) => { const nextKind = value as "quick" | "named"; setKind(nextKind); setExpirationMode(nextKind === "quick" ? "3600" : ""); }}/><small>Quick shares clean themselves up. Named tunnels remain available until released.</small></label>
    {kind === "quick" && <label>Required expiration<SelectMenu placement="up" value={expirationMode} icon={<Clock3 size={14}/>} options={[{ value: "900", label: "15 minutes" }, { value: "3600", label: "1 hour" }, { value: "14400", label: "4 hours" }, { value: "86400", label: "24 hours" }, { value: "exact", label: "Specific date & time", description: "Choose an exact cutoff" }]} onChange={setExpirationMode}/>{expirationMode === "exact" && <div className="datetime-wrap"><Clock3 size={14}/><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></div>}<small>{expirationMode === "exact" ? "Uses this computer’s local timezone." : "Every Quick Share is stopped by a background watchdog even when Ants Nest is closed."}</small></label>}
    {kind === "named" && <label>Release hostname<SelectMenu placement="up" value={expirationMode} icon={<Clock3 size={14}/>} options={[{ value: "", label: "Manual release", description: "Until stopped or removed" }, { value: "900", label: "After 15 minutes" }, { value: "3600", label: "After 1 hour" }, { value: "14400", label: "After 4 hours" }, { value: "86400", label: "After 24 hours" }, { value: "exact", label: "Specific date & time", description: "Choose an exact cutoff" }]} onChange={setExpirationMode}/>{expirationMode === "exact" && <div className="datetime-wrap"><Clock3 size={14}/><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></div>}<small>Stopping, removing, or expiration deletes the owned DNS record and Cloudflare Tunnel.</small></label>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !installed || !proxyDomain}>{busy ? <><RefreshCw className="spin" size={15}/> Connecting…</> : <><Radio size={15}/> Create & start</>}</button></div>
  </form></div>;
}

function LogsModal({ tunnel, logs, onClose }: { tunnel: TunnelView; logs: string; onClose(): void }) {
  return <div className="backdrop"><div className="modal logs-modal"><div className="modal-head"><div><h2>{tunnel.name} logs</h2><p>Latest cloudflared output</p></div><button className="icon-button close" onClick={onClose}><X size={18}/></button></div><pre>{logs}</pre><div className="modal-actions"><button className="secondary" onClick={onClose}>Close</button></div></div></div>;
}
