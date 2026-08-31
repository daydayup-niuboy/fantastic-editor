import { describe, expect, it } from "vitest";
import {
  computeWechatAcceptanceGates,
  createEmptyWechatAcceptance,
  updateWechatAcceptance,
} from "./wechat-acceptance";

describe("WeChat acceptance workflow", () => {
  it("requires body paste and every replacement before draft confirmation", () => {
    let progress = createEmptyWechatAcceptance();
    expect(computeWechatAcceptanceGates(progress, 2, 2).canConfirmDraftSaved).toBe(false);
    progress = updateWechatAcceptance(progress, "bodyPasted", true);
    expect(computeWechatAcceptanceGates(progress, 2, 1).canConfirmDraftSaved).toBe(false);
    expect(computeWechatAcceptanceGates(progress, 2, 2).canConfirmDraftSaved).toBe(true);
  });

  it("supports text-only articles and enforces save, reopen and mobile order", () => {
    let progress = updateWechatAcceptance(createEmptyWechatAcceptance(), "bodyPasted", true);
    let gates = computeWechatAcceptanceGates(progress, 0, 0);
    expect(gates.replacementsConfirmed).toBe(true);
    expect(gates.canConfirmDraftSaved).toBe(true);
    progress = updateWechatAcceptance(progress, "draftSaved", true);
    gates = computeWechatAcceptanceGates(progress, 0, 0);
    expect(gates.canConfirmDraftReopened).toBe(true);
    progress = updateWechatAcceptance(progress, "draftReopened", true);
    progress = updateWechatAcceptance(progress, "mobilePreviewed", true);
    expect(computeWechatAcceptanceGates(progress, 0, 0).completed).toBe(true);
  });

  it("clears downstream confirmations when an earlier gate is revoked", () => {
    let progress = { bodyPasted: true, draftSaved: true, draftReopened: true, mobilePreviewed: true };
    progress = updateWechatAcceptance(progress, "draftSaved", false);
    expect(progress).toEqual({ bodyPasted: true, draftSaved: false, draftReopened: false, mobilePreviewed: false });
    progress = updateWechatAcceptance({ bodyPasted: true, draftSaved: true, draftReopened: true, mobilePreviewed: true }, "bodyPasted", false);
    expect(progress).toEqual({ bodyPasted: false, draftSaved: false, draftReopened: false, mobilePreviewed: false });
  });
});
