import { z } from "zod";

export const tunnelKindSchema = z.enum(["quick", "named"]);
export const tunnelStatusSchema = z.enum(["starting", "online", "stopped", "failed"]);

export const tunnelProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  kind: tunnelKindSchema,
  origin: z.string(),
  hostname: z.string().optional(),
  tunnelName: z.string().optional(),
  tunnelId: z.string().optional(),
  dnsRecordId: z.string().optional(),
  tokenFile: z.string().optional(),
  sharedPath: z.string().optional(),
  shareConfigFile: z.string().optional(),
  tokenRequired: z.boolean().optional(),
  localServerPort: z.number().int().positive().max(65535).optional(),
  expiresInSeconds: z.number().int().min(60).max(2_592_000).optional(),
  fixedExpiresAt: z.string().datetime().optional(),
  createdAt: z.string(),
});

export const tunnelSessionSchema = z.object({
  profileId: z.string(),
  pid: z.number().int().positive().optional(),
  expiryPid: z.number().int().positive().optional(),
  fileServerPid: z.number().int().positive().optional(),
  status: tunnelStatusSchema,
  publicUrl: z.string().optional(),
  baseUrl: z.string().optional(),
  startedAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  error: z.string().optional(),
  logPath: z.string().optional(),
});

export type TunnelKind = z.infer<typeof tunnelKindSchema>;
export type TunnelStatus = z.infer<typeof tunnelStatusSchema>;
export type TunnelProfile = z.infer<typeof tunnelProfileSchema>;
export type TunnelSession = z.infer<typeof tunnelSessionSchema>;

export type TunnelView = TunnelProfile & TunnelSession;

export type DoctorResult = {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  binary?: string;
  configDirectory: string;
  proxyDomain?: string;
};

export const cloudflareSetupSchema = z.object({
  proxyDomain: z.string().trim().toLowerCase().min(3),
  zoneId: z.string().trim().regex(/^[a-f0-9]{32}$/i, "Zone ID must be 32 hexadecimal characters"),
  accountId: z.string().trim().regex(/^[a-f0-9]{32}$/i, "Account ID must be 32 hexadecimal characters"),
  apiToken: z.string().trim().min(20, "API token looks too short"),
});
export type CloudflareSetupInput = z.infer<typeof cloudflareSetupSchema>;

export type RemoteAccessState = {
  enabled: boolean;
  localUrl?: string;
  publicUrl?: string;
  pairingUrl?: string;
  startedAt?: string;
  devices: RemoteDevice[];
};

export type RemoteDevice = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
};

export type CliInstallationStatus = {
  supported: boolean;
  installed: boolean;
  appInstalled?: boolean;
  binDirectory: string;
  commands: string[];
  onPath: boolean;
  mode?: "appimage" | "desktop" | "repository";
  version?: string;
  reason?: string;
};

export type AppUpdateState = {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  currentVersion?: string | undefined;
  version?: string | undefined;
  percent?: number | undefined;
  error?: string | undefined;
};

const shareNameSchema = z.string().trim().min(1, "Name is required").max(64).refine((value) => /[a-z0-9]/i.test(value), "Name must include an English letter or number");

export const quickInputSchema = z.object({
  name: shareNameSchema,
  description: z.string().trim().min(1, "Description is required").max(240),
  origin: z.string().trim().min(1),
  expiresInSeconds: z.number().int().min(60).max(2_592_000).optional(),
  expiresAt: z.string().datetime().optional(),
}).refine((input) => Boolean(input.expiresInSeconds) !== Boolean(input.expiresAt), { message: "Quick shares require either a duration or an exact expiration time" });

export const namedInputSchema = z.object({
  name: shareNameSchema,
  description: z.string().trim().min(1, "Description is required").max(240),
  origin: z.string().trim().min(1),
  expiresInSeconds: z.number().int().min(60).max(2_592_000).optional(),
  expiresAt: z.string().datetime().optional(),
}).refine((input) => !(input.expiresInSeconds && input.expiresAt), { message: "Choose a duration or an exact expiration time, not both" });

const fileFields = {
  name: shareNameSchema,
  description: z.string().trim().min(1, "Description is required").max(240),
  path: z.string().trim().min(1, "File or folder path is required"),
  tokenRequired: z.boolean().default(true),
  expiresInSeconds: z.number().int().min(60).max(2_592_000).optional(),
  expiresAt: z.string().datetime().optional(),
};

export const fileQuickInputSchema = z.object(fileFields).refine((input) => Boolean(input.expiresInSeconds) !== Boolean(input.expiresAt), { message: "Quick shares require either a duration or an exact expiration time" });
export const fileNamedInputSchema = z.object(fileFields).refine((input) => !(input.expiresInSeconds && input.expiresAt), { message: "Choose a duration or an exact expiration time, not both" });

const desktopHostnameSchema = z.string().trim().min(1, "Public hostname is required").max(253);
export const desktopQuickInputSchema = z.intersection(quickInputSchema, z.object({ hostname: desktopHostnameSchema }));
export const desktopNamedInputSchema = z.intersection(namedInputSchema, z.object({ hostname: desktopHostnameSchema }));
export const desktopFileQuickInputSchema = z.intersection(fileQuickInputSchema, z.object({ hostname: desktopHostnameSchema }));
export const desktopFileNamedInputSchema = z.intersection(fileNamedInputSchema, z.object({ hostname: desktopHostnameSchema }));

export type QuickInput = z.input<typeof quickInputSchema>;
export type NamedInput = z.input<typeof namedInputSchema>;
export type DesktopQuickInput = z.input<typeof desktopQuickInputSchema>;
export type DesktopNamedInput = z.input<typeof desktopNamedInputSchema>;
export type FileQuickInput = z.input<typeof fileQuickInputSchema>;
export type FileNamedInput = z.input<typeof fileNamedInputSchema>;
export type DesktopFileQuickInput = z.input<typeof desktopFileQuickInputSchema>;
export type DesktopFileNamedInput = z.input<typeof desktopFileNamedInputSchema>;

export type AntsNestApi = {
  onStateChanged(callback: () => void): () => void;
  appVersion(): Promise<string>;
  doctor(): Promise<DoctorResult>;
  configureCloudflare(input: CloudflareSetupInput): Promise<DoctorResult>;
  list(): Promise<TunnelView[]>;
  quick(input: DesktopQuickInput): Promise<TunnelView>;
  quickFile(input: DesktopFileQuickInput): Promise<TunnelView>;
  createNamed(input: DesktopNamedInput): Promise<TunnelView>;
  createNamedFile(input: DesktopFileNamedInput): Promise<TunnelView>;
  start(id: string): Promise<TunnelView>;
  stop(id: string): Promise<TunnelView>;
  remove(id: string): Promise<void>;
  logs(id: string): Promise<string>;
  remoteStatus(): Promise<RemoteAccessState>;
  startRemote(): Promise<RemoteAccessState>;
  stopRemote(): Promise<RemoteAccessState>;
  newRemotePairing(): Promise<RemoteAccessState>;
  revokeRemoteDevice(id: string): Promise<RemoteAccessState>;
  revokeAllRemoteDevices(): Promise<RemoteAccessState>;
  cliInstallationStatus(): Promise<CliInstallationStatus>;
  installCli(): Promise<CliInstallationStatus>;
  uninstallCli(): Promise<CliInstallationStatus>;
  chooseSharePath(kind: "file" | "folder"): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  updateStatus(): Promise<AppUpdateState>;
  checkForUpdate(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(callback: (state: AppUpdateState) => void): () => void;
};
