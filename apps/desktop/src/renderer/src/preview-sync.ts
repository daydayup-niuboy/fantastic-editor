export interface EditorViewportAnchor {
  sourceOffset: number;
  viewportRatio: number;
}

export interface EditorSourceSelection {
  from: number;
  to: number;
}

export interface PreviewSourceAnchor {
  sourceFrom: number;
  sourceTo: number;
  top: number;
  height: number;
  kind: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function usableAnchor(anchor: PreviewSourceAnchor): boolean {
  return Number.isFinite(anchor.sourceFrom)
    && Number.isFinite(anchor.sourceTo)
    && Number.isFinite(anchor.top)
    && Number.isFinite(anchor.height)
    && anchor.sourceFrom >= 0
    && anchor.sourceTo > anchor.sourceFrom
    && anchor.height >= 0;
}

function positionInside(anchor: PreviewSourceAnchor, sourceOffset: number): number {
  const ratio = clamp(
    (sourceOffset - anchor.sourceFrom) / (anchor.sourceTo - anchor.sourceFrom),
    0,
    1,
  );
  return anchor.top + anchor.height * ratio;
}

export function mapSourceOffsetToPreviewY(
  anchors: readonly PreviewSourceAnchor[],
  sourceOffset: number,
): number | null {
  if (!Number.isFinite(sourceOffset)) return null;
  const usable = anchors.filter(usableAnchor);
  if (usable.length === 0) return null;

  const containing = usable
    .filter((anchor) => anchor.sourceFrom <= sourceOffset && anchor.sourceTo > sourceOffset)
    .sort((left, right) => {
      const spanDifference = (left.sourceTo - left.sourceFrom) - (right.sourceTo - right.sourceFrom);
      if (spanDifference !== 0) return spanDifference;
      if (left.kind === "image" && right.kind !== "image") return -1;
      if (right.kind === "image" && left.kind !== "image") return 1;
      return left.top - right.top;
    })[0];
  if (containing) return positionInside(containing, sourceOffset);

  const before = usable
    .filter((anchor) => anchor.sourceTo <= sourceOffset)
    .sort((left, right) => right.sourceTo - left.sourceTo || right.top - left.top)[0];
  const after = usable
    .filter((anchor) => anchor.sourceFrom > sourceOffset)
    .sort((left, right) => left.sourceFrom - right.sourceFrom || left.top - right.top)[0];

  if (before && after) {
    const sourceGap = after.sourceFrom - before.sourceTo;
    if (sourceGap <= 0) return before.top + before.height;
    const ratio = clamp((sourceOffset - before.sourceTo) / sourceGap, 0, 1);
    return before.top + before.height + (after.top - before.top - before.height) * ratio;
  }
  if (before) return before.top + before.height;
  if (after) return after.top;
  return null;
}

export function sourceRangesIntersect(
  anchor: Pick<PreviewSourceAnchor, "sourceFrom" | "sourceTo">,
  selection: EditorSourceSelection,
): boolean {
  return selection.to > anchor.sourceFrom && selection.from < anchor.sourceTo;
}

export function selectionIsInsideAnchor(
  anchor: Pick<PreviewSourceAnchor, "sourceFrom" | "sourceTo">,
  selection: EditorSourceSelection,
): boolean {
  return selection.from >= anchor.sourceFrom && selection.to <= anchor.sourceTo;
}