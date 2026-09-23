export function untitledHeadingPrefixOffset(text: string): number | null {
  let index = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() !== "") {
      if (/^#{1,6}\s/.test(line) || line.startsWith("```") || /^[-*+] /.test(line) || /^\d+\. /.test(line) || /^>/.test(line) || /^---\s*$/.test(line)) return null;
      return index;
    }
    index += line.length + 1;
  }
  return null;
}

export function shouldPrefixUntitledHeading(previous: string, next: string, pasted: boolean): number | null {
  const offset = untitledHeadingPrefixOffset(next);
  if (offset === null) return null;
  if (pasted) return offset;
  if (untitledHeadingPrefixOffset(previous) === null) return null;
  const previousLineEnd = previous.indexOf("\n", untitledHeadingPrefixOffset(previous) ?? 0);
  const nextLineEnd = next.indexOf("\n", offset);
  return nextLineEnd >= 0 && previousLineEnd < 0 ? offset : null;
}
