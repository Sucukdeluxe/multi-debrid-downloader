import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/notify", async (importActual) => {
  const actual = await importActual<typeof import("../src/main/notify")>();
  return { ...actual, sendNotification: vi.fn().mockResolvedValue(true) };
});

import { DownloadManager } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession } from "../src/main/storage";
import { shutdownItemLogs } from "../src/main/item-log";
import { shutdownPackageLogs } from "../src/main/package-log";
import { shutdownRenameLog } from "../src/main/rename-log";
import { sendNotification } from "../src/main/notify";

const mockedSend = sendNotification as unknown as ReturnType<typeof vi.fn>;
const tempDirs: string[] = [];

afterEach(() => {
  mockedSend.mockClear();
  shutdownItemLogs();
  shutdownPackageLogs();
  shutdownRenameLog();
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function setup(): { manager: DownloadManager; session: ReturnType<typeof emptySession> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-nh-"));
  tempDirs.push(root);
  const session = emptySession();
  const manager = new DownloadManager(
    {
      ...defaultSettings(),
      token: "rd-token",
      outputDir: path.join(root, "out"),
      extractDir: path.join(root, "extract"),
      notifyUrl: "https://discord.com/api/webhooks/123/abc",
      notifyOnPackageCompleted: true,
      notifyOnPackageFailed: true
    },
    session,
    createStoragePaths(path.join(root, "state"))
  );
  return { manager, session };
}

function addPackage(session: ReturnType<typeof emptySession>, itemStatuses: string[]): any {
  const pkgId = "pkg-1";
  const pkg: any = {
    id: pkgId,
    name: "Test.Show.S01",
    outputDir: "C:/out",
    extractDir: "C:/extract",
    status: "queued",
    itemIds: itemStatuses.map((_s, i) => `it-${i}`),
    cancelled: false,
    enabled: true,
    priority: "normal",
    createdAt: 1,
    updatedAt: 1
  };
  session.packages[pkgId] = pkg;
  session.packageOrder.push(pkgId);
  itemStatuses.forEach((status, i) => {
    session.items[`it-${i}`] = {
      id: `it-${i}`,
      packageId: pkgId,
      url: `https://dummy/${i}`,
      provider: null,
      status,
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: `f${i}.rar`,
      targetPath: "",
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "",
      createdAt: 1,
      updatedAt: 1
    } as any;
  });
  return pkg;
}

describe("refreshPackageStatus failed-transition notify", () => {
  it("notifies a MIXED package (some success, last finisher failed) — the lost-webhook case", () => {
    const { manager, session } = setup();
    const pkg = addPackage(session, ["completed", "failed"]);
    session.running = true;

    (manager as any).refreshPackageStatus(pkg);

    expect(pkg.status).toBe("failed");
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][1].title).toBe("❌ Paket fehlgeschlagen");
    expect(mockedSend.mock.calls[0][1].message).toContain("1 von 2");
  });

  it("notifies an all-failed package and dedups repeat refreshes", () => {
    const { manager, session } = setup();
    const pkg = addPackage(session, ["failed", "failed"]);
    session.running = true;

    (manager as any).refreshPackageStatus(pkg);
    (manager as any).refreshPackageStatus(pkg);

    expect(pkg.status).toBe("failed");
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it("stays silent outside a run (startup recovery must not spam)", () => {
    const { manager, session } = setup();
    const pkg = addPackage(session, ["failed"]);
    session.running = false;

    (manager as any).refreshPackageStatus(pkg);

    expect(pkg.status).toBe("failed");
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("does not notify while items are still pending", () => {
    const { manager, session } = setup();
    const pkg = addPackage(session, ["failed", "queued"]);
    session.running = true;

    (manager as any).refreshPackageStatus(pkg);

    expect(pkg.status).toBe("queued");
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("releases the dedup marker when the send ultimately fails (retro-notify possible)", async () => {
    const { manager, session } = setup();
    const pkg = addPackage(session, ["failed", "failed"]);
    session.running = true;
    mockedSend.mockResolvedValueOnce(false);

    (manager as any).refreshPackageStatus(pkg);
    await new Promise((r) => setTimeout(r, 0));

    expect((manager as any).notifiedPackages.has(pkg.id)).toBe(false);
  });
});
