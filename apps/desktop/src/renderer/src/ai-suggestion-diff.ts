export type SuggestionDiffSegment = { text: string; changed: boolean };

const TOKEN_RE = /(\s+)|([\u4e00-\u9fff])|([^\s\u4e00-\u9fff]+)/g;

export function tokenizeForDiff(value: string): string[] {
  return value.match(TOKEN_RE) ?? (value ? [value] : []);
}

function lcsBacktrack(left: string[], right: string[]): Array<{ text: string; changed: boolean }> {
  const rows = left.length;
  const cols = right.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      table[i]![j] = left[i - 1] === right[j - 1] ? (table[i - 1]![j - 1]! + 1) as number : Math.max(table[i - 1]![j]!, table[i]![j - 1]!) as number;
    }
  }
  const segments: SuggestionDiffSegment[] = [];
  let i = rows;
  let j = cols;
  const unshift = (text: string, changed: boolean) => {
    const first = segments[0];
    if (first && first.changed === changed) first.text = text + first.text;
    else segments.unshift({ text, changed });
  };
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      unshift(right[j - 1]!, false);
      i -= 1;
      j -= 1;
    } else if (table[i]![j - 1]! >= table[i - 1]![j]!) {
      unshift(right[j - 1]!, true);
      j -= 1;
    } else i -= 1;
  }
  while (j > 0) {
    unshift(right[j - 1]!, true);
    j -= 1;
  }
  return segments;
}

export function suggestionDiffSegments(original: string, suggestion: string): SuggestionDiffSegment[] {
  if (suggestion === original) return suggestion ? [{ text: suggestion, changed: false }] : [];
  if (!original) return suggestion ? [{ text: suggestion, changed: true }] : [];
  const left = tokenizeForDiff(original);
  const right = tokenizeForDiff(suggestion);
  if (left.length * right.length > 250_000) {
    return suggestion.split("\n").map((line, index, lines) => ({
      text: index < lines.length - 1 ? `${line}\n` : line,
      changed: original.split("\n")[index] !== line,
    }));
  }
  return lcsBacktrack(left, right);
}