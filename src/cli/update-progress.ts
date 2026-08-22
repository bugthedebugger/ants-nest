import type { CliUpdateProgress } from "../core/cli-update";

type ProgressStream = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function downloadLine(progress: Extract<CliUpdateProgress, { phase: "download" }>) {
  if (!progress.totalBytes) return `Downloading update · ${formatBytes(progress.downloadedBytes)}`;
  const percent = progress.complete ? 100 : Math.min(99, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100));
  const filled = Math.round(percent / 5);
  return `Downloading update [${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${percent}% · ${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`;
}

export function createUpdateProgressReporter(stream: ProgressStream = process.stderr) {
  let downloadLineActive = false;
  let lastNonTtyMilestone = -1;

  function endDownloadLine() {
    if (!downloadLineActive) return;
    stream.write("\n");
    downloadLineActive = false;
  }

  function report(progress: CliUpdateProgress) {
    if (progress.phase === "download") {
      const line = downloadLine(progress);
      if (stream.isTTY) {
        stream.write(`\r\x1b[2K${line}`);
        downloadLineActive = true;
        return;
      }
      const percent = progress.totalBytes ? Math.floor((progress.downloadedBytes / progress.totalBytes) * 100) : undefined;
      const milestone = progress.complete ? 100 : percent === undefined ? (progress.downloadedBytes === 0 ? 0 : -1) : Math.floor(percent / 10) * 10;
      if (milestone >= 0 && milestone !== lastNonTtyMilestone) {
        stream.write(`${line}\n`);
        lastNonTtyMilestone = milestone;
      }
      return;
    }

    endDownloadLine();
    const labels: Record<Exclude<CliUpdateProgress["phase"], "download">, string> = {
      verify: "Verifying checksum...",
      test: "Testing downloaded update...",
      install: "Installing update...",
    };
    stream.write(`${labels[progress.phase]}\n`);
  }

  return { report, finish: endDownloadLine };
}
