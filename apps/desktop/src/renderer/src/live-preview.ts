import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export type LivePreviewTokenKind =
  | "hide"
  | "code-line"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "strong"
  | "emphasis"
  | "strike"
  | "link"
  | "list-marker"
  | "quote-line"
  | "paragraph-line"
  | "unordered-list-line"
  | "ordered-list-line";

export interface LivePreviewToken {
  from: number;
  to: number;
  kind: LivePreviewTokenKind;
  text?: string;
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.empty
    ? range.head >= from && range.head <= to
    : range.from < to && range.to > from);
}

function pushInlineToken(
  tokens: LivePreviewToken[],
  state: EditorState,
  node: { from: number; to: number; node: { getChildren(name: string): readonly { from: number; to: number }[] } },
  kind: "strong" | "emphasis" | "strike",
  markName = "EmphasisMark",
): void {
  const marks = node.node.getChildren(markName);
  if (marks.length < 2) return;
  const first = marks[0]!;
  const last = marks[marks.length - 1]!;
  tokens.push({ from: first.to, to: last.from, kind });
  if (!selectionTouches(state, node.from, node.to)) {
    tokens.push({ from: first.from, to: first.to, kind: "hide" });
    tokens.push({ from: last.from, to: last.to, kind: "hide" });
  }
}

export function collectLivePreviewTokens(state: EditorState, from = 0, to = state.doc.length): LivePreviewToken[] {
  const tokens: LivePreviewToken[] = [];
  const tree = syntaxTree(state);

  tree.iterate({
    from,
    to,
    enter(node) {
      const name = node.type.name;
      if (name === "FencedCode" || name === "CodeBlock") {
        for (let line = state.doc.lineAt(node.from); line.from <= node.to;) {
          if (line.from >= from && line.from <= to) tokens.push({ from: line.from, to: line.from, kind: "code-line" });
          if (line.to >= node.to || line.number === state.doc.lines) break;
          line = state.doc.line(line.number + 1);
        }
        return false;
      }
      const headingMatch = /^ATXHeading([1-6])$/.exec(name);
      if (headingMatch) {
        const line = state.doc.lineAt(node.from);
        tokens.push({ from: line.from, to: line.from, kind: `heading-${headingMatch[1]}` as LivePreviewTokenKind });
        const mark = node.node.getChildren("HeaderMark")[0];
        if (mark) {
          const end = Math.min(line.to, mark.to + (state.sliceDoc(mark.to, mark.to + 1) === " " ? 1 : 0));
          tokens.push({ from: mark.from, to: end, kind: "hide" });
        }
        return;
      }

      if (name === "StrongEmphasis") {
        pushInlineToken(tokens, state, node, "strong");
        return;
      }
      if (name === "Emphasis") {
        pushInlineToken(tokens, state, node, "emphasis");
        return;
      }
      if (name === "Strikethrough") {
        pushInlineToken(tokens, state, node, "strike", "StrikethroughMark");
        return;
      }
      if (name === "Link") {
        const marks = node.node.getChildren("LinkMark");
        if (marks.length >= 2) {
          const first = marks[0]!;
          const labelEnd = marks[1]!.from;
          tokens.push({ from: first.to, to: labelEnd, kind: "link" });
          if (!selectionTouches(state, node.from, node.to)) {
            tokens.push({ from: first.from, to: first.to, kind: "hide" });
            tokens.push({ from: labelEnd, to: node.to, kind: "hide" });
          }
        }
        return;
      }
      if (name === "Paragraph") {
        tokens.push({ from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.from).from, kind: "paragraph-line" });
      }
      if (name === "ListItem") {
        const mark = node.node.getChildren("ListMark")[0];
        if (mark) {
          const source = state.sliceDoc(mark.from, mark.to).trim();
          const ordered = /^\d/.test(source);
          tokens.push({ from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.from).from, kind: ordered ? "ordered-list-line" : "unordered-list-line" });
          if (!selectionTouches(state, node.from, node.to)) {
            const line = state.doc.lineAt(mark.from);
            const end = Math.min(line.to, mark.to + (/\s/.test(state.sliceDoc(mark.to, mark.to + 1)) ? 1 : 0));
            tokens.push({
              from: mark.from,
              to: end,
              kind: "list-marker",
              text: ordered ? `${source.replace(/[.)]$/, ".")} ` : "• ",
            });
          }
        }
        return;
      }
      if (name === "Blockquote") {
        const line = state.doc.lineAt(node.from);
        tokens.push({ from: line.from, to: line.from, kind: "quote-line" });
        if (!selectionTouches(state, node.from, node.to)) {
          for (const mark of node.node.getChildren("QuoteMark")) {
            const end = Math.min(line.to, mark.to + (state.sliceDoc(mark.to, mark.to + 1) === " " ? 1 : 0));
            tokens.push({ from: mark.from, to: end, kind: "hide" });
          }
        }
      }
    },
  });

  return tokens;
}

class ListMarkerWidget extends WidgetType {
  constructor(private readonly text: string) { super(); }
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-live-list-marker";
    marker.textContent = this.text;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
  eq(other: ListMarkerWidget): boolean { return other.text === this.text; }
  ignoreEvent(): boolean { return false; }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges = collectLivePreviewTokens(view.state, view.visibleRanges[0]?.from ?? 0, view.visibleRanges.at(-1)?.to ?? view.state.doc.length)
    .map((token) => {
      if (token.kind === "hide") return Decoration.replace({}).range(token.from, token.to);
      if (token.kind === "list-marker") {
        return Decoration.replace({ widget: new ListMarkerWidget(token.text ?? "• ") }).range(token.from, token.to);
      }
      if (token.kind.startsWith("heading-") || token.kind.endsWith("-line")) {
        return Decoration.line({ class: `cm-live-${token.kind}` }).range(token.from);
      }
      return Decoration.mark({ class: `cm-live-${token.kind}` }).range(token.from, token.to);
    });
  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildDecorations(view); }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

export const livePreviewExtension = [
  EditorView.editorAttributes.of({ class: "cm-live-preview" }),
  livePreviewPlugin,
];
