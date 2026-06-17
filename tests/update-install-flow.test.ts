import { describe, expect, it } from "vitest";
import { runInstallWithResume, InstallResumeManager } from "../src/main/update-install-flow";

function makeManager(running: boolean): InstallResumeManager & { startCalls: number; stopCalls: number; persistCalls: number; sessionRunning: boolean } {
  return {
    sessionRunning: running,
    startCalls: 0,
    stopCalls: 0,
    persistCalls: 0,
    isSessionRunning() {
      return this.sessionRunning;
    },
    stop() {
      this.stopCalls += 1;
      this.sessionRunning = false;
    },
    persistNowSync() {
      this.persistCalls += 1;
    },
    async start() {
      this.startCalls += 1;
      this.sessionRunning = true;
    }
  };
}

describe("runInstallWithResume", () => {
  it("resumes a running session when the install returns started:false", async () => {
    const m = makeManager(true);
    const result = await runInstallWithResume(m, async () => ({ started: false }));
    expect(result.started).toBe(false);
    expect(m.stopCalls).toBe(1);
    expect(m.startCalls).toBe(1);
    expect(m.isSessionRunning()).toBe(true);
  });

  it("resumes a running session when the install THROWS, then rethrows", async () => {
    const m = makeManager(true);
    await expect(
      runInstallWithResume(m, async () => {
        throw new Error("network down");
      })
    ).rejects.toThrow("network down");
    expect(m.stopCalls).toBe(1);
    expect(m.startCalls).toBe(1);
    expect(m.isSessionRunning()).toBe(true);
  });

  it("does NOT resume when the install succeeds (started:true) — the app is about to quit", async () => {
    const m = makeManager(true);
    const result = await runInstallWithResume(m, async () => ({ started: true }));
    expect(result.started).toBe(true);
    expect(m.startCalls).toBe(0);
    expect(m.isSessionRunning()).toBe(false);
  });

  it("does NOT resume when no session was running before the install", async () => {
    const m = makeManager(false);
    await runInstallWithResume(m, async () => ({ started: false }));
    expect(m.stopCalls).toBe(0);
    expect(m.startCalls).toBe(0);
  });
});
