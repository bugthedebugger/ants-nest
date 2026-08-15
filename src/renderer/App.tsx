import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Activity, ArrowUpRight, Check, CircleStop, Clock3, Cloud, Command, Copy, FileText, Globe2, MoreHorizontal, Phone, Play, Plus, QrCode, Radio, RefreshCw, Settings2, ShieldCheck, Terminal, Trash2, X, Zap } from "lucide-react";
import QRCode from "qrcode";
import type { CloudflareSetupInput, DoctorResult, RemoteAccessState, TunnelView } from "../shared/types";
import { formatRemaining } from "../shared/duration";

type Modal = "quick" | "named" | "logs" | "remote" | "setup" | null;

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
  return <div className="logo" aria-label="Ants Nest"><span /><span /><span /><span /><span /></div>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="icon-button" title="Copy link" onClick={() => {
    void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>;
}

export function App() {
  const [tunnels, setTunnels] = useState<TunnelView[]>([]);
  const [doctor, setDoctor] = useState<DoctorResult>();
  const [remote, setRemote] = useState<RemoteAccessState>({ enabled: false, devices: [] });
  const [qrCode, setQrCode] = useState<string>();
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<TunnelView>();
  const [logs, setLogs] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const [nextTunnels, nextDoctor, nextRemote] = await Promise.all([window.antsNest.list(), window.antsNest.doctor(), window.antsNest.remoteStatus()]);
    setTunnels(nextTunnels); setDoctor(nextDoctor); setRemote(nextRemote);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(message(e)));
    return window.antsNest.onStateChanged(() => void refresh().catch(() => undefined));
  }, [refresh]);

  const live = useMemo(() => tunnels.filter((t) => t.status === "online").length, [tunnels]);

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
      if (state.pairingUrl) setQrCode(await QRCode.toDataURL(state.pairingUrl, { width: 420, margin: 2, color: { dark: "#111315", light: "#edffab" } }));
      setModal("remote");
    });
  }

  async function showRemote() {
    if (!remote.enabled) return startRemote();
    if (remote.pairingUrl) setQrCode(await QRCode.toDataURL(remote.pairingUrl, { width: 420, margin: 2, color: { dark: "#111315", light: "#edffab" } }));
    setModal("remote");
  }

  async function createPairing() {
    await action("pairing", async () => {
      const state = await window.antsNest.newRemotePairing();
      setRemote(state);
      if (state.pairingUrl) setQrCode(await QRCode.toDataURL(state.pairingUrl, { width: 420, margin: 2, color: { dark: "#111315", light: "#edffab" } }));
    });
  }

  return <div className="shell">
    <aside>
      <div className="brand"><Logo /><span>Ants Nest</span><span className="version">v0.1</span></div>
      <nav>
        <button className="active"><Activity size={17} /> Tunnels <span>{tunnels.length}</span></button>
        <button onClick={() => void showRemote()}><Phone size={17} /> Phone access {remote.enabled && <span className="nav-live">LIVE</span>}</button>
        <button onClick={() => setModal("quick")}><Zap size={17} /> Quick share</button>
        <button onClick={() => setModal("setup")}><Settings2 size={17} /> Setup</button>
      </nav>
        <div className="sidebar-bottom">
        <div className="cli-card"><Terminal size={16} /><div><strong>Agent CLI</strong><code>ants share 3000 -n app -d preview -e 1h</code></div></div>
        <div className="connection"><i className={doctor?.installed ? "ok" : ""} />{doctor?.installed ? "cloudflared ready" : "cloudflared missing"}</div>
      </div>
    </aside>

    <main>
      <header><div><p className="eyebrow">LOCAL NETWORK</p><h1>Your tunnels</h1><p>Ship local work to a public URL in seconds.</p></div>
        <div className="header-actions"><button className="secondary" onClick={() => void refresh()}><RefreshCw size={16} /> Refresh</button><button className="primary" onClick={() => setModal("quick")}><Plus size={16} /> New tunnel</button></div>
      </header>

      {error && <div className="error"><span>{error}</span><button onClick={() => setError(undefined)}><X size={15}/></button></div>}

      <section className="metrics">
        <div><span className="metric-icon green"><Radio size={17}/></span><p>LIVE TUNNELS</p><strong>{live}</strong><small>{live ? "Publicly reachable" : "Nothing exposed"}</small></div>
        <div><span className="metric-icon amber"><Zap size={17}/></span><p>QUICK SHARES</p><strong>{tunnels.filter(t => t.kind === "quick").length}</strong><small>Ephemeral links</small></div>
        <div><span className="metric-icon blue"><Globe2 size={17}/></span><p>NAMED ROUTES</p><strong>{tunnels.filter(t => t.kind === "named").length}</strong><small>Custom hostnames</small></div>
      </section>

      <section className={`remote-card ${remote.enabled ? "enabled" : ""}`}>
        <div className="remote-icon"><Phone size={21}/><i/></div>
        <div><p className="eyebrow">PHONE ACCESS</p><h3>{remote.enabled ? "Your remote dashboard is live" : "Control Ants Nest from your phone"}</h3><p>{remote.enabled ? `${remote.devices.length} authorized ${remote.devices.length === 1 ? "device" : "devices"} · Each device has its own revocable token.` : `Open antsnest.${doctor?.proxyDomain || "your-domain.com"} with a private pairing token and QR code.`}</p></div>
        {remote.enabled ? <><button className="secondary" onClick={() => void showRemote()}><QrCode size={15}/> Show QR</button><button className="remote-stop" disabled={busy === "remote-stop"} onClick={() => void action("remote-stop", () => window.antsNest.stopRemote())}>End access</button></> : <button className="primary" disabled={busy === "remote" || !doctor?.installed} onClick={() => void startRemote()}>{busy === "remote" ? <><RefreshCw className="spin" size={15}/> Opening…</> : <><Phone size={15}/> Enable phone access</>}</button>}
      </section>

      <section className="tunnel-section">
        <div className="section-title"><div><h2>All tunnels</h2><p>Managed here and from the CLI.</p></div><button className="text-button" onClick={() => setModal("named")}><Plus size={15}/> Add named tunnel</button></div>
        {!tunnels.length ? <Empty onQuick={() => setModal("quick")} onNamed={() => setModal("named")} /> : <div className="tunnel-list">
          {tunnels.map((tunnel) => <TunnelRow key={tunnel.id} tunnel={tunnel} busy={busy === tunnel.id}
            onToggle={() => void action(tunnel.id, () => tunnel.status === "online" ? window.antsNest.stop(tunnel.id) : window.antsNest.start(tunnel.id))}
            onLogs={() => void showLogs(tunnel).catch((e) => setError(message(e)))}
            onRemove={() => void action(tunnel.id, () => window.antsNest.remove(tunnel.id))} />)}
        </div>}
      </section>

      <section className="setup-card" id="setup"><div className="setup-art"><Cloud size={28}/></div><div><p className="eyebrow">ONE-TIME SETUP</p><h3>{doctor?.authenticated ? "Cloudflare API is configured" : "Configure your Cloudflare API"}</h3><p>{doctor?.authenticated ? `Named tunnels and DNS records will be managed under ${doctor.proxyDomain}.` : "Add your proxy domain, zone ID, account ID, and scoped API token. No browser login required."}</p></div>
        {doctor?.authenticated ? <button className="ready" onClick={() => setModal("setup")}><Check size={15}/> Configured</button> : <button className="secondary" onClick={() => setModal("setup")}>Configure Cloudflare<ArrowUpRight size={15}/></button>}
      </section>
    </main>

    {(modal === "quick" || modal === "named") && <TunnelModal kind={modal} installed={doctor?.installed ?? false} proxyDomain={doctor?.proxyDomain} onClose={() => setModal(null)} onComplete={async (task) => { await action("create", task); setModal(null); }} busy={busy === "create"} />}
    {modal === "logs" && selected && <LogsModal tunnel={selected} logs={logs} onClose={() => setModal(null)} />}
    {modal === "remote" && remote.enabled && <RemoteModal state={remote} qrCode={qrCode} busy={busy} onClose={() => setModal(null)} onNewPairing={() => void createPairing()} onRevoke={(id) => void action(`revoke-${id}`, async () => setRemote(await window.antsNest.revokeRemoteDevice(id)))} onRevokeAll={() => void action("revoke-all", async () => setRemote(await window.antsNest.revokeAllRemoteDevices()))} onStop={() => void action("remote-stop", async () => { await window.antsNest.stopRemote(); setModal(null); })} />}
    {modal === "setup" && <SetupModal configured={doctor?.authenticated ?? false} busy={busy === "setup"} error={error} onClose={() => setModal(null)} onSave={async (input) => { if (await action("setup", () => window.antsNest.configureCloudflare(input))) setModal(null); }} />}
  </div>;
}

function RemoteModal({ state, qrCode, busy, onClose, onStop, onNewPairing, onRevoke, onRevokeAll }: { state: RemoteAccessState; qrCode?: string | undefined; busy?: string | undefined; onClose(): void; onStop(): void; onNewPairing(): void; onRevoke(id: string): void; onRevokeAll(): void }) {
  return <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="modal remote-modal">
    <div className="modal-head"><div className="kind-icon remote-kind"><Phone size={19}/></div><div><h2>Phone access</h2><p>Pair devices, review access, and revoke them anytime.</p></div><button className="icon-button close" onClick={onClose}><X size={18}/></button></div>
    {state.pairingUrl ? <><div className="qr-wrap">{qrCode ? <img src={qrCode} alt="Remote access pairing QR code"/> : <RefreshCw className="spin"/>}</div><div className="pairing-url"><span>{state.publicUrl}</span><CopyButton value={state.pairingUrl}/></div><p className="single-use"><ShieldCheck size={13}/> Single-use code — it expires as soon as one browser pairs.</p></> : <div className="new-pairing"><QrCode size={28}/><h3>Pair another device</h3><p>Generate a fresh one-time QR code. Existing authorized devices remain connected.</p><button className="primary" disabled={busy === "pairing"} onClick={onNewPairing}>{busy === "pairing" ? "Generating…" : "Generate pairing code"}</button></div>}
    <div className="device-heading"><div><strong>Authorized devices</strong><span>{state.devices.length}</span></div>{state.devices.length > 0 && <button disabled={busy === "revoke-all"} onClick={onRevokeAll}>Revoke all</button>}</div>
    <div className="device-list">{state.devices.length ? state.devices.map((device) => <div className="device" key={device.id}><div className="device-icon"><Phone size={15}/></div><div><strong>{device.name}</strong><span>Last active {relativeTime(device.lastSeenAt)}</span></div><button disabled={busy === `revoke-${device.id}`} onClick={() => onRevoke(device.id)}>Revoke</button></div>) : <div className="no-devices">No devices paired yet.</div>}</div>
    <div className="security-note"><ShieldCheck size={18}/><div><strong>Per-device access</strong><p>Each browser receives a unique token after pairing. Revocation is immediate, and that browser must scan a newly generated code to return.</p></div></div>
    <div className="modal-actions"><button className="remote-stop" onClick={onStop}>End all phone access</button>{state.pairingUrl && <button className="primary" onClick={() => void window.antsNest.openExternal(state.pairingUrl!)}>Open pairing page <ArrowUpRight size={14}/></button>}</div>
  </div></div>;
}

function SetupModal({ configured, busy, error, onClose, onSave }: { configured: boolean; busy: boolean; error?: string | undefined; onClose(): void; onSave(input: CloudflareSetupInput): Promise<void> }) {
  const [proxyDomain, setProxyDomain] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave({ proxyDomain, zoneId, accountId, apiToken });
  }
  return <div className="backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal setup-modal" onSubmit={submit}>
    <div className="modal-head"><div className="kind-icon named"><Cloud size={19}/></div><div><h2>{configured ? "Update Cloudflare configuration" : "Configure Cloudflare"}</h2><p>Validates your API access and installs the latest official cloudflared release.</p></div><button type="button" className="icon-button close" onClick={onClose}><X size={18}/></button></div>
    {error && <div className="error setup-error">{error}</div>}
    {configured && <div className="warning configured-warning"><Check size={15}/> Saving replaces the current configuration after the new values are validated.</div>}
    <label><code>CLOUDFLARE_PROXY_DOMAIN</code><input autoFocus value={proxyDomain} onChange={(event) => setProxyDomain(event.target.value)} placeholder="tunnels.example.com" required /></label>
    <label><code>CLOUDFLARE_ZONE_ID</code><input value={zoneId} onChange={(event) => setZoneId(event.target.value)} placeholder="32-character zone ID" minLength={32} maxLength={32} required /></label>
    <label><code>CLOUDFLARE_ACCOUNT_ID</code><input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="32-character account ID" minLength={32} maxLength={32} required /></label>
    <label><code>CLOUDFLARE_API_TOKEN</code><input type="password" autoComplete="off" value={apiToken} onChange={(event) => setApiToken(event.target.value)} placeholder="Token with Tunnel Edit + DNS Edit" required /><small>Stored locally in ~/.ants-nest/cloudflare.json with user-only permissions.</small></label>
    <div className="token-permissions"><ShieldCheck size={16}/><div><strong>Required token permissions</strong><p>Account · Cloudflare Tunnel · Edit<br/>Zone · DNS · Edit</p></div></div>
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? <><RefreshCw className="spin" size={15}/> Setting up…</> : <><Check size={15}/> Install, validate & save</>}</button></div>
  </form></div>;
}

function Empty({ onQuick, onNamed }: { onQuick(): void; onNamed(): void }) {
  return <div className="empty"><div className="empty-art"><Logo /></div><h3>Open your first tunnel</h3><p>Share localhost with a temporary link, or connect a hostname you control.</p><div><button className="primary" onClick={onQuick}><Zap size={16}/> Quick share</button><button className="secondary" onClick={onNamed}><Globe2 size={16}/> Named tunnel</button></div></div>;
}

function TunnelRow({ tunnel, busy, onToggle, onLogs, onRemove }: { tunnel: TunnelView; busy: boolean; onToggle(): void; onLogs(): void; onRemove(): void }) {
  const online = tunnel.status === "online";
  return <article className="tunnel-row">
    <div className={`kind-icon ${tunnel.kind}`} >{tunnel.kind === "quick" ? <Zap size={18}/> : <Globe2 size={18}/>}</div>
    <div className="identity"><div><h3>{tunnel.name}</h3><span className={`pill ${tunnel.status}`}><i />{tunnel.status}</span><span className="kind-label">{tunnel.kind}</span></div><p title={tunnel.description}>{tunnel.description || "Legacy tunnel"}</p><small>{tunnel.origin}</small></div>
    <div className="url">{tunnel.publicUrl ? <><button onClick={() => void window.antsNest.openExternal(tunnel.publicUrl!)}>{tunnel.publicUrl.replace("https://", "")}<ArrowUpRight size={13}/></button><CopyButton value={tunnel.publicUrl}/></> : <span>Link appears when started</span>}</div>
    <div className={`last-seen ${tunnel.expiresAt ? "expiring" : ""}`}><span>{tunnel.expiresAt ? "EXPIRES IN" : "LAST STARTED"}</span>{tunnel.expiresAt ? <><Clock3 size={10}/>{formatRemaining(tunnel.expiresAt)}</> : relativeTime(tunnel.startedAt)}</div>
    <button className={`toggle ${online ? "stop" : "start"}`} disabled={busy} onClick={onToggle}>{busy ? <RefreshCw className="spin" size={15}/> : online ? <CircleStop size={15}/> : <Play size={15}/>} {online ? tunnel.kind === "named" ? "Release" : "Stop" : "Start"}</button>
    <div className="menu"><button className="icon-button"><MoreHorizontal size={17}/></button><div className="menu-pop"><button onClick={onLogs}><FileText size={14}/> Logs</button><button className="danger" onClick={onRemove}><Trash2 size={14}/> Remove</button></div></div>
  </article>;
}

function TunnelModal({ kind, installed, proxyDomain, busy, onClose, onComplete }: { kind: "quick" | "named"; installed: boolean; proxyDomain?: string | undefined; busy: boolean; onClose(): void; onComplete(task: () => Promise<unknown>): Promise<void> }) {
  const [name, setName] = useState(kind === "quick" ? "Quick share" : "");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState("3000");
  const [hostname, setHostname] = useState(proxyDomain ? `${kind === "quick" ? "quick-preview" : "preview"}.${proxyDomain}` : "");
  const [expirationMode, setExpirationMode] = useState(kind === "quick" ? "3600" : "");
  const [expiresAt, setExpiresAt] = useState(() => new Date(Date.now() + 3_600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  function submit(event: FormEvent) {
    event.preventDefault();
    const expiration = expirationMode === "exact" ? { expiresAt: new Date(expiresAt).toISOString() } : expirationMode ? { expiresInSeconds: Number(expirationMode) } : {};
    void onComplete(() => kind === "quick" ? window.antsNest.quick({ name, description, origin, hostname, ...expiration }) : window.antsNest.createNamed({ name, description, origin, hostname, ...expiration }));
  }
  return <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><form className="modal" onSubmit={submit}>
    <div className="modal-head"><div className={`kind-icon ${kind}`} >{kind === "quick" ? <Zap size={19}/> : <Globe2 size={19}/>}</div><div><h2>{kind === "quick" ? "Create a quick share" : "Create a named tunnel"}</h2><p>Choose any available first-level hostname on your configured domain.</p></div><button type="button" className="icon-button close" onClick={onClose}><X size={18}/></button></div>
    {!installed && <div className="warning">cloudflared is not installed. Complete Cloudflare Setup to install it.</div>}
    <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Docs preview" required /></label>
    <label>Public hostname<div className="input-prefix"><span>https://</span><input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder={proxyDomain ? `anything.${proxyDomain}` : "anything.example.com"} required /></div><small>Any unused direct subdomain of {proxyDomain || "your configured domain"}. Existing DNS records are never replaced.</small></label>
    <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this link exposes and who it is for" maxLength={240} required /><small>Shown in the desktop app, CLI, and phone dashboard.</small></label>
    <label>Local service<div className="input-prefix"><span>URL</span><input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="3000 or http://localhost:3000" required /></div><small>A port is automatically expanded to localhost.</small></label>
    {kind === "quick" && <label>Required expiration<div className="select-wrap"><Clock3 size={14}/><select value={expirationMode} onChange={(event) => setExpirationMode(event.target.value)}><optgroup label="Duration"><option value="900">15 minutes</option><option value="3600">1 hour</option><option value="14400">4 hours</option><option value="86400">24 hours</option></optgroup><option value="exact">At a specific date & time…</option></select></div>{expirationMode === "exact" && <div className="datetime-wrap"><Clock3 size={14}/><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></div>}<small>{expirationMode === "exact" ? "Uses this computer’s local timezone." : "Every Quick Share is stopped by a background watchdog even when Ants Nest is closed."}</small></label>}
    {kind === "named" && <label>Release hostname<div className="select-wrap"><Clock3 size={14}/><select value={expirationMode} onChange={(event) => setExpirationMode(event.target.value)}><option value="">When manually stopped or removed</option><optgroup label="Automatic expiration"><option value="900">After 15 minutes</option><option value="3600">After 1 hour</option><option value="14400">After 4 hours</option><option value="86400">After 24 hours</option></optgroup><option value="exact">At a specific date & time…</option></select></div>{expirationMode === "exact" && <div className="datetime-wrap"><Clock3 size={14}/><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></div>}<small>Stopping, removing, or expiration deletes the owned DNS record and Cloudflare Tunnel.</small></label>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !installed}>{busy ? <><RefreshCw className="spin" size={15}/> Connecting…</> : <><Radio size={15}/> Create & start</>}</button></div>
  </form></div>;
}

function LogsModal({ tunnel, logs, onClose }: { tunnel: TunnelView; logs: string; onClose(): void }) {
  return <div className="backdrop"><div className="modal logs-modal"><div className="modal-head"><div className="kind-icon quick"><Command size={19}/></div><div><h2>{tunnel.name} logs</h2><p>Latest cloudflared output</p></div><button className="icon-button close" onClick={onClose}><X size={18}/></button></div><pre>{logs}</pre><div className="modal-actions"><button className="secondary" onClick={onClose}>Close</button></div></div></div>;
}
