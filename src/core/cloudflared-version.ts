// https://blog.cloudflare.com/emudhra-certificate-compromise/
// Ants Nest installs the direct macOS builds, which require the later fix.
export function minimumCloudflaredVersion(platform: string = process.platform): string {
  return platform === "darwin" ? "2026.10.3" : "2026.10.2";
}

export function isCloudflaredVersionSafe(output: string, platform: string = process.platform): boolean {
  const match = output.trim().match(/^(?:cloudflared version |v?)(\d+)\.(\d+)\.(\d+)(?=\s|$)/);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  const minimum = minimumCloudflaredVersion(platform).split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
  }
  return true;
}
