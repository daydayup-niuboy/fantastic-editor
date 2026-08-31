export type TabDirection = -1 | 1;

export function adjacentTabIndex(length: number, currentIndex: number, direction: TabDirection): number | null {
  if (length <= 0) return null;
  const normalizedCurrent = currentIndex >= 0 && currentIndex < length ? currentIndex : 0;
  return (normalizedCurrent + direction + length) % length;
}

export function tabIndexForNavigationKey(length: number, currentIndex: number, key: string): number | null {
  if (key === "Home") return length > 0 ? 0 : null;
  if (key === "End") return length > 0 ? length - 1 : null;
  if (key === "ArrowLeft") return adjacentTabIndex(length, currentIndex, -1);
  if (key === "ArrowRight") return adjacentTabIndex(length, currentIndex, 1);
  return null;
}

export function moveTabIndexForKey(length: number, currentIndex: number, key: string, altKey: boolean, shiftKey: boolean): number | null {
  if (!altKey || !shiftKey || currentIndex < 0 || currentIndex >= length) return null;
  if (key === "ArrowLeft" && currentIndex > 0) return currentIndex - 1;
  if (key === "ArrowRight" && currentIndex < length - 1) return currentIndex + 1;
  return null;
}

export function moveTabItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) return [...items];
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item!);
  return next;
}
