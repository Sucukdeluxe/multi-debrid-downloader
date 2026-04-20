import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths } from "../src/main/storage";
import { runStartupHealthCheck } from "../src/main/startup-health-check";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function makeTempBase(): { baseDir: string; outputDir: string; paths: ReturnType<typeof createStoragePaths> } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-health-"));
  tempDirs.push(baseDir);
  const outputDir = path.join(baseDir, "downloads");
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    baseDir: path.join(baseDir, "runtime"),
    outputDir,
    paths: createStoragePaths(path.join(baseDir, "runtime"))
  };
}

describe("runStartupHealthCheck", () => {
  it("flags missing download directory", () => {
    const { outputDir, paths } = makeTempBase();
    fs.mkdirSync(paths.baseDir, { recursive: true });

    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      outputDir: path.join(outputDir, "does-not-exist-subdir")
    };
    const report = runStartupHealthCheck(settings, paths);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("outputDir_not_found");
  });

  it("flags no-provider-configured when all credentials are empty", () => {
    const { outputDir, paths } = makeTempBase();
    fs.mkdirSync(paths.baseDir, { recursive: true });

    const settings = {
      ...defaultSettings(),
      token: "",
      megaLogin: "",
      megaPassword: "",
      megaCredentials: "",
      allDebridToken: "",
      bestToken: "",
      oneFichierApiKey: "",
      debridLinkApiKeys: "",
      outputDir
    };
    const report = runStartupHealthCheck(settings, paths);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("no_provider_configured");
    expect(report.warnCount).toBeGreaterThanOrEqual(1);
  });

  it("reports configured providers when at least one credential is set", () => {
    const { outputDir, paths } = makeTempBase();
    fs.mkdirSync(paths.baseDir, { recursive: true });

    const settings = {
      ...defaultSettings(),
      token: "rd-token-here",
      debridLinkApiKeys: "dl-key-a\ndl-key-b",
      outputDir
    };
    const report = runStartupHealthCheck(settings, paths);
    const providersFinding = report.findings.find((f) => f.code === "providers_configured");
    expect(providersFinding).toBeDefined();
    expect(providersFinding?.message).toContain("Real-Debrid");
    expect(providersFinding?.message).toContain("Debrid-Link");
    expect(providersFinding?.message).toContain("2 Keys");
  });

  it("flags large state files", () => {
    const { outputDir, paths } = makeTempBase();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    // 60 MB dummy state file, threshold is 50 MB
    fs.writeFileSync(paths.sessionFile, Buffer.alloc(60 * 1024 * 1024, 0));

    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      outputDir
    };
    const report = runStartupHealthCheck(settings, paths);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("large_state_file");
  });

  it("flags missing base dir as ERROR", () => {
    const { outputDir, paths } = makeTempBase();
    // Intentionally DON'T create baseDir.

    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      outputDir
    };
    const report = runStartupHealthCheck(settings, paths);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("baseDir_missing");
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
  });

  it("passes cleanly when everything is healthy", () => {
    const { outputDir, paths } = makeTempBase();
    fs.mkdirSync(paths.baseDir, { recursive: true });

    const settings = {
      ...defaultSettings(),
      token: "rd-token-here",
      outputDir
    };
    const report = runStartupHealthCheck(settings, paths);
    expect(report.errorCount).toBe(0);
    const codes = report.findings.map((f) => f.code);
    expect(codes).not.toContain("outputDir_not_found");
    expect(codes).not.toContain("outputDir_not_writable");
    expect(codes).not.toContain("no_provider_configured");
    expect(codes).not.toContain("baseDir_missing");
    expect(codes).not.toContain("baseDir_not_writable");
  });
});
