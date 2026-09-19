export interface WritingStatistics {
  characters: number;
  words: number;
  readingMinutes: number;
}

export function writingStatistics(markdown: string): WritingStatistics {
  const text = markdown
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, " ")
    .replace(/`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>]+>|https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, " ");
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const latinWords = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.filter(word => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)).length ?? 0;
  return {
    characters: [...text].filter(character => !/\s/u.test(character)).length,
    words: cjk + latinWords,
    readingMinutes: Math.max(1, Math.ceil(cjk / 300 + latinWords / 200)),
  };
}

function smartenPlainText(value: string): string {
  return value
    .replace(/\.{3,}/g, "……")
    .replace(/"([^"\n]+)"/g, "“$1”")
    .replace(/'([^'\n]+)'/g, "‘$1’");
}

export function applySmartPunctuation(markdown: string): string {
  let fenced = false;
  return markdown.split("\n").map(line => {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.split(/(`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<[^>\n]+>|https?:\/\/\S+)/g).map((part, index) => index % 2 ? part : smartenPlainText(part)).join("");
  }).join("\n");
}
