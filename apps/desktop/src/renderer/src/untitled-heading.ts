import { type Transaction } from "@codemirror/state";

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

/**
 * 未命名文档首行升 H1 的事务过滤器。输入法组合期间不干预：组合文字尚在 DOM 中、
 * 未进入正文，此时拆分会打断 IME 协调，组合文字将永久丢失。
 */
export function createUntitledHeadingFilter(flags: { isEnabled: () => boolean; isComposing: () => boolean }) {
  return (tr: Transaction) => {
    if (!flags.isEnabled() || !tr.docChanged || flags.isComposing()) return tr;
    const offset = shouldPrefixUntitledHeading(tr.startState.doc.toString(), tr.newDoc.toString(), tr.isUserEvent("input.paste"));
    return offset === null ? tr : [tr, { changes: { from: offset, insert: "# " }, sequential: true }];
  };
}
