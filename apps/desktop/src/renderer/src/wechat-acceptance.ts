import type { WechatAcceptanceConfirmation } from "@fantastic-editor/shared";

export type WechatAcceptanceProgress = WechatAcceptanceConfirmation;

export interface WechatAcceptanceGates {
  replacementsConfirmed: boolean;
  canConfirmDraftSaved: boolean;
  canConfirmDraftReopened: boolean;
  canConfirmMobilePreview: boolean;
  completed: boolean;
}

export const EMPTY_WECHAT_ACCEPTANCE: WechatAcceptanceProgress = Object.freeze({
  bodyPasted: false,
  draftSaved: false,
  draftReopened: false,
  mobilePreviewed: false,
});

export function createEmptyWechatAcceptance(): WechatAcceptanceProgress {
  return { ...EMPTY_WECHAT_ACCEPTANCE };
}

export function computeWechatAcceptanceGates(
  progress: WechatAcceptanceProgress,
  replacementCount: number,
  confirmedReplacementCount: number,
): WechatAcceptanceGates {
  const safeReplacementCount = Math.max(0, Math.trunc(replacementCount));
  const safeConfirmedCount = Math.max(0, Math.trunc(confirmedReplacementCount));
  const replacementsConfirmed = safeConfirmedCount === safeReplacementCount;
  const canConfirmDraftSaved = progress.bodyPasted && replacementsConfirmed;
  const canConfirmDraftReopened = canConfirmDraftSaved && progress.draftSaved;
  const canConfirmMobilePreview = canConfirmDraftReopened && progress.draftReopened;
  return {
    replacementsConfirmed,
    canConfirmDraftSaved,
    canConfirmDraftReopened,
    canConfirmMobilePreview,
    completed: canConfirmMobilePreview && progress.mobilePreviewed,
  };
}

export function updateWechatAcceptance(
  current: WechatAcceptanceProgress,
  field: keyof WechatAcceptanceProgress,
  checked: boolean,
): WechatAcceptanceProgress {
  const next = { ...current, [field]: checked };
  if (!next.bodyPasted) {
    next.draftSaved = false;
    next.draftReopened = false;
    next.mobilePreviewed = false;
  } else if (!next.draftSaved) {
    next.draftReopened = false;
    next.mobilePreviewed = false;
  } else if (!next.draftReopened) {
    next.mobilePreviewed = false;
  }
  return next;
}
