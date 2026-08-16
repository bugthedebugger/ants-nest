import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let directory = "";

function digest(value: Buffer | string) { return createHash("sha256").update(value).digest("hex"); }

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-curl-install-test-"));
  const fixture = path.join(directory, "fixture");
  const mockBin = path.join(directory, "mock-bin");
  await Promise.all([fs.mkdir(fixture), fs.mkdir(mockBin)]);
  const cli = "console.log('test cli 1.2.3')\n";
  const appImage = "#!/bin/sh\nprintf 'test app cli 1.2.3\\n'\n";
  const icon = "fake png";
  await Promise.all([
    fs.writeFile(path.join(fixture, "cli"), cli),
    fs.writeFile(path.join(fixture, "appimage"), appImage),
    fs.writeFile(path.join(fixture, "icon"), icon),
  ]);
  const release = {
    tag_name: "v1.2.3",
    assets: [
      { name: "ants-nest-cli.cjs", digest: `sha256:${digest(cli)}`, browser_download_url: "mock://cli" },
      { name: "Ants.Nest-1.2.3.AppImage", digest: `sha256:${digest(appImage)}`, browser_download_url: "mock://appimage" },
      { name: "ants-nest-icon.png", digest: `sha256:${digest(icon)}`, browser_download_url: "mock://icon" },
    ],
  };
  await fs.writeFile(path.join(fixture, "release.json"), JSON.stringify(release, null, 2));
  await fs.writeFile(path.join(mockBin, "curl"), `#!/bin/sh
destination=""; url=""; previous=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then destination="$argument"; previous=""; continue; fi
  if [ "$argument" = "-o" ]; then previous="-o"; continue; fi
  case "$argument" in https://*|mock://*) url="$argument";; esac
done
case "$url" in
  https://api.github.com/*) cp "$FIXTURE_DIRECTORY/release.json" "$destination";;
  mock://cli) cp "$FIXTURE_DIRECTORY/cli" "$destination";;
  mock://appimage) cp "$FIXTURE_DIRECTORY/appimage" "$destination";;
  mock://icon) cp "$FIXTURE_DIRECTORY/icon" "$destination";;
  *) echo "Unexpected URL: $url" >&2; exit 1;;
esac
`, { mode: 0o755 });
});

afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function install(mode: "--cli-only" | "--all") {
  const home = path.join(directory, mode.slice(2));
  const result = spawnSync("sh", [path.resolve("install.sh"), mode], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, ".local", "share"), FIXTURE_DIRECTORY: path.join(directory, "fixture"), PATH: `${path.join(directory, "mock-bin")}:${process.env.PATH}` },
  });
  expect(result.stderr).toBe("");
  expect(result.status, result.stdout).toBe(0);
  return home;
}

describe("curl installer", () => {
  it("installs only the standalone Node CLI", async () => {
    const home = install("--cli-only");
    const launcher = path.join(home, ".local", "bin", "ants");
    expect(await fs.readFile(launcher, "utf8")).toContain("mode=repository version=1.2.3");
    expect(spawnSync(launcher, [], { encoding: "utf8" }).stdout.trim()).toBe("test cli 1.2.3");
    await expect(fs.access(path.join(home, ".local", "share", "applications", "ants-nest.desktop"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs the AppImage, CLI launchers, icon, and desktop entry", async () => {
    const home = install("--all");
    const launcher = path.join(home, ".local", "bin", "ants-nest");
    expect(await fs.readFile(launcher, "utf8")).toContain("mode=appimage version=1.2.3");
    expect(spawnSync(launcher, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("test app cli 1.2.3");
    const desktop = await fs.readFile(path.join(home, ".local", "share", "applications", "ants-nest.desktop"), "utf8");
    expect(desktop).toContain("Name=Ants Nest");
  });
});
