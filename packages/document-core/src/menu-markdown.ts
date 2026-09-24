import type { MarkdownIt } from "markdown-it";

function isEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export function installMenuMarkdownExtensions(markdown: MarkdownIt): void {
  markdown.inline.ruler.before("emphasis", "highlight", (state, silent) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== "==" || state.src[start - 1] === "=" || state.src[start + 2] === "=" || isEscaped(state.src, start)) return false;
    const end = state.src.indexOf("==", start + 2);
    if (end <= start + 2 || state.src.slice(start, end).includes("\n") || state.src[end + 2] === "=") return false;
    if (!silent) {
      const open = state.push("mark_open", "mark", 1);
      open.markup = "==";
      const text = state.push("text", "", 0);
      text.content = state.src.slice(start + 2, end);
      const close = state.push("mark_close", "mark", -1);
      close.markup = "==";
    }
    state.pos = end + 2;
    return true;
  });

  markdown.inline.ruler.before("html_inline", "markdown_comment", (state, silent) => {
    const start = state.pos;
    if (!state.src.startsWith("<!--", start)) return false;
    const close = state.src.indexOf("-->", start + 4);
    if (close < 0) return false;
    if (!silent) {
      const token = state.push("markdown_comment", "", 0);
      token.content = state.src.slice(start, close + 3);
    }
    state.pos = close + 3;
    return true;
  });

  markdown.inline.ruler.before("link", "footnote_reference", (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== "[" || isEscaped(state.src, start)) return false;
    const match = /^\[\^([\w-]{1,64})\]/.exec(state.src.slice(start));
    if (!match) return false;
    if (!silent) {
      const token = state.push("footnote_reference", "sup", 0);
      token.content = match[1]!;
      token.meta = { label: match[1]! };
    }
    state.pos += match[0].length;
    return true;
  });

  markdown.block.ruler.before("reference", "footnote_definition", (state, startLine, _endLine, silent) => {
    const line = state.getLines(startLine, startLine + 1, state.blkIndent, false);
    const match = /^\[\^([\w-]{1,64})\]:[ \t]*(.*)$/.exec(line);
    if (!match) return false;
    if (silent) return true;
    // ponytail: keep footnotes single-line/plain-text; support nested footnote blocks if real documents require them.
    const token = state.push("footnote_definition", "p", 0);
    token.block = true;
    token.map = [startLine, startLine + 1];
    token.meta = { label: match[1]!, value: match[2]! };
    state.line = startLine + 1;
    return true;
  });

  markdown.renderer.rules.markdown_comment = () => "";
  markdown.renderer.rules.footnote_reference = (tokens, index) => `<sup>[${markdown.utils.escapeHtml(tokens[index]?.content ?? "")}]</sup>`;
  markdown.renderer.rules.footnote_definition = (tokens, index) => {
    const meta = tokens[index]?.meta as { label?: string; value?: string } | undefined;
    return `<p><small>[${markdown.utils.escapeHtml(meta?.label ?? "")}] ${markdown.utils.escapeHtml(meta?.value ?? "")}</small></p>\n`;
  };
}
