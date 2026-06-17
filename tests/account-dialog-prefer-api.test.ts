import { describe, expect, it } from "vitest";
import { applyAccountDialogToSettings, AccountDialogState } from "../src/renderer/App";
import { defaultSettings } from "../src/main/constants";

function megaDialog(kind: "megadebrid-api" | "megadebrid-web"): AccountDialogState {
  return {
    mode: "edit",
    kind,
    token: "",
    login: "",
    password: "",
    dailyLimitGb: "",
    keyDailyLimitGbById: {},
    megaAccounts: [{ login: "user@x", password: "pw" }],
    megaNewLogin: "",
    megaNewPassword: "",
    megaDisabledIds: []
  };
}

describe("applyAccountDialogToSettings — keeps the user's Mega preferApi choice", () => {
  it("does not flip megaDebridPreferApi to true when editing the API account", () => {
    const settings = { ...defaultSettings(), megaDebridApiEnabled: true, megaDebridWebEnabled: true, megaDebridPreferApi: false };
    const next = applyAccountDialogToSettings(settings, megaDialog("megadebrid-api"));
    expect(next.megaDebridApiEnabled).toBe(true);
    expect(next.megaDebridPreferApi).toBe(false);
  });

  it("does not flip megaDebridPreferApi to false when editing the Web account", () => {
    const settings = { ...defaultSettings(), megaDebridApiEnabled: true, megaDebridWebEnabled: true, megaDebridPreferApi: true };
    const next = applyAccountDialogToSettings(settings, megaDialog("megadebrid-web"));
    expect(next.megaDebridWebEnabled).toBe(true);
    expect(next.megaDebridPreferApi).toBe(true);
  });
});
