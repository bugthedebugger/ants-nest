import { describe, expect, it } from "vitest";
import { createUpdateProgressReporter } from "./update-progress";

function output(isTTY: boolean) {
  let text = "";
  const reporter = createUpdateProgressReporter({ isTTY, write: (chunk) => { text += chunk; } });
  return { reporter, value: () => text };
}

describe("CLI update progress", () => {
  it("renders an updating progress bar and phase messages in a terminal", () => {
    const target = output(true);
    target.reporter.report({ phase: "download", downloadedBytes: 50, totalBytes: 100, complete: false });
    target.reporter.report({ phase: "download", downloadedBytes: 100, totalBytes: 100, complete: true });
    target.reporter.report({ phase: "verify" });
    target.reporter.report({ phase: "test" });
    target.reporter.report({ phase: "install" });
    target.reporter.finish();
    expect(target.value()).toContain("50%");
    expect(target.value()).toContain("100%");
    expect(target.value()).toContain("Verifying checksum...");
    expect(target.value()).toContain("Testing downloaded update...");
    expect(target.value()).toContain("Installing update...");
  });

  it("emits bounded milestones when output is redirected", () => {
    const target = output(false);
    for (let downloadedBytes = 0; downloadedBytes <= 100; downloadedBytes += 1) {
      target.reporter.report({ phase: "download", downloadedBytes, totalBytes: 100, complete: downloadedBytes === 100 });
    }
    expect(target.value().trim().split("\n")).toHaveLength(11);
  });

  it("shows byte progress when the server omits content length", () => {
    const target = output(true);
    target.reporter.report({ phase: "download", downloadedBytes: 1536, complete: false });
    target.reporter.finish();
    expect(target.value()).toContain("1.50 KB");
  });
});
