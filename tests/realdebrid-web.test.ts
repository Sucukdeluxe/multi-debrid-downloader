import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSessionFetch,
  mockClearStorageData,
  mockClearCache,
  mockFromPartition,
  mockBrowserWindow,
  mockBrowserWindowCtor,
  mockExecuteJavaScript,
  mockLoadURL,
  mockShow,
  mockFocus
} = vi.hoisted(() => {
  const sessionFetch = vi.fn();
  const clearStorageData = vi.fn();
  const clearCache = vi.fn();
  const fromPartition = vi.fn();
  const executeJavaScript = vi.fn();
  const loadURL = vi.fn(async () => {});
  const show = vi.fn();
  const focus = vi.fn();
  const webContentsEvents: Record<string, (...args: unknown[]) => void> = {};
  const windowEvents: Record<string, (...args: unknown[]) => void> = {};
  let destroyed = false;

  const browserWindow = {
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show,
    focus,
    close: vi.fn(() => {
      destroyed = true;
      windowEvents.closed?.();
    }),
    setMenuBarVisibility: vi.fn(),
    loadURL,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      windowEvents[event] = handler;
      return browserWindow;
    }),
    webContents: {
      setUserAgent: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        webContentsEvents[event] = handler;
      }),
      executeJavaScript
    }
  };

  const BrowserWindowCtor = vi.fn(() => {
    destroyed = false;
    return browserWindow;
  });

  return {
    mockSessionFetch: sessionFetch,
    mockClearStorageData: clearStorageData,
    mockClearCache: clearCache,
    mockFromPartition: fromPartition,
    mockBrowserWindow: browserWindow,
    mockBrowserWindowCtor: BrowserWindowCtor,
    mockExecuteJavaScript: executeJavaScript,
    mockLoadURL: loadURL,
    mockShow: show,
    mockFocus: focus
  };
});

vi.mock("electron", () => ({
  session: {
    fromPartition: mockFromPartition
  },
  BrowserWindow: mockBrowserWindowCtor
}));

import { RealDebridWebFallback, extractPrivateTokenFromHtml } from "../src/main/realdebrid-web";

describe("realdebrid-web", () => {
  const mockSession = {
    fetch: mockSessionFetch,
    clearStorageData: mockClearStorageData,
    clearCache: mockClearCache
  };

  beforeEach(() => {
    mockFromPartition.mockReturnValue(mockSession);
    mockExecuteJavaScript.mockReset();
    mockLoadURL.mockClear();
    mockShow.mockClear();
    mockFocus.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockFromPartition.mockReturnValue(mockSession);
  });

  it("extracts private tokens from current Real-Debrid HTML patterns", () => {
    expect(extractPrivateTokenFromHtml("document.querySelectorAll('input[name=private_token]')[0].value = 'abc123';"))
      .toBe("abc123");
    expect(extractPrivateTokenFromHtml("<input type=\"text\" name=\"private_token\" value=\"def456\">"))
      .toBe("def456");
    expect(extractPrivateTokenFromHtml("<input value=\"ghi789\" name=\"private_token\">"))
      .toBe("ghi789");
  });

  it("uses the already logged-in browser window to warm the token cache before unrestricting", async () => {
    const apiFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      download: "https://cdn.real-debrid.example/file.bin",
      filename: "file.bin",
      filesize: 12345
    }), { status: 200 }));
    vi.stubGlobal("fetch", apiFetch);

    mockExecuteJavaScript.mockResolvedValue("token-from-window");

    const fallback = new RealDebridWebFallback(() => true);
    await fallback.openLoginWindow();

    const result = await fallback.unrestrict("https://rapidgator.net/file/abc");

    expect(result).toEqual({
      directUrl: "https://cdn.real-debrid.example/file.bin",
      fileName: "file.bin",
      fileSize: 12345,
      retriesUsed: 0
    });
    expect(mockBrowserWindowCtor).toHaveBeenCalledTimes(1);
    expect(mockLoadURL).toHaveBeenCalledWith("https://real-debrid.com");
    expect(mockShow).toHaveBeenCalled();
    expect(mockFocus).toHaveBeenCalled();
    expect(mockSessionFetch).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0]?.[0]).toBe("https://api.real-debrid.com/rest/1.0/unrestrict/link");
    expect(mockBrowserWindow.webContents.executeJavaScript).toHaveBeenCalled();
  });
});
