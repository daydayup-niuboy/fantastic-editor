import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { escapeMarkdownTableCell, markdownTableDetails, markdownTableInsertedCellOffset, transformMarkdownTable, type MarkdownTableOperation } from "./wysiwyg-transactions";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

interface TableCell { from: number; to: number; text: string; html: string; protected?: boolean }
interface TableProjection { from: number; to: number; rows: TableCell[][] }
export interface TableSnapshot { source: string; tables: TableProjection[] }
export type TableCellFormat = "bold" | "italic" | "strike" | "code" | "link";
export function tableCellTextSelection(state: EditorState, input: HTMLTextAreaElement, allowDraft = false): { from: number; to: number; text: string; cellFrom: number; encodedCell: string } | null {
  const cellFrom = Number(input.dataset.sourceFrom);
  const cellTo = Number(input.dataset.sourceTo);
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (!Number.isInteger(cellFrom) || !Number.isInteger(cellTo) || cellFrom < 0 || cellTo < cellFrom || cellTo > state.doc.length
    || start === null || end === null || start >= end) return null;
  if (!allowDraft && state.sliceDoc(cellFrom, cellTo) !== input.value) return null;
  const encodedCell = escapeMarkdownTableCell(input.value);
  const from = cellFrom + escapeMarkdownTableCell(input.value.slice(0, start)).length;
  const to = cellFrom + escapeMarkdownTableCell(input.value.slice(0, end)).length;
  const text = encodedCell.slice(from - cellFrom, to - cellFrom);
  if (!allowDraft && state.sliceDoc(from, to) !== text) return null;
  return { from, to, text, cellFrom, encodedCell };
}

const hiddenInlineNodes = new Set(["LinkMark", "URL", "LinkTitle", "EmphasisMark", "CodeMark", "StrikethroughMark", "HighlightMark", "HTMLTag", "Entity", "Escape"]);

export function mapTableVisibleText(state: EditorState, cellFrom: number, cellTo: number, values: readonly string[]): { from: number; to: number }[] | null {
  const raw = state.sliceDoc(cellFrom, cellTo);
  const tree = ensureSyntaxTree(state, cellTo, 40);
  if (!tree) return null;
  const hidden: { from: number; to: number }[] = [];
  tree.iterate({ from: cellFrom, to: cellTo, enter(node) {
    if (hiddenInlineNodes.has(node.type.name)) hidden.push({ from: node.from, to: node.to });
  } });
  const mapped: { from: number; to: number }[] = [];
  let offset = 0;
  for (const value of values) {
    let found = raw.indexOf(value, offset);
    while (found >= 0 && hidden.some(range => cellFrom + found < range.to && cellFrom + found + value.length > range.from)) {
      found = raw.indexOf(value, found + 1);
    }
    if (found < 0) return null;
    mapped.push({ from: cellFrom + found, to: cellFrom + found + value.length });
    offset = found + value.length;
  }
  return mapped;
}

export function tableCellRenderedSelection(state: EditorState, button: HTMLButtonElement, selection: Selection | null): { from: number; to: number; text: string } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!button.contains(range.startContainer) || !button.contains(range.endContainer)) return null;
  const cellFrom = Number(button.dataset.sourceFrom);
  const cellTo = Number(button.dataset.sourceTo);
  if (!Number.isInteger(cellFrom) || !Number.isInteger(cellTo) || cellFrom < 0 || cellTo < cellFrom || cellTo > state.doc.length) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(button);
  prefix.setEnd(range.startContainer, range.startOffset);
  const visibleFrom = prefix.toString().length;
  const visibleTo = visibleFrom + range.toString().length;
  let visibleOffset = 0;
  let from = -1;
  let to = -1;
  const nodes = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
  const values: string[] = [];
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    const value = node.textContent ?? "";
    if (value) values.push(value);
  }
  const mapped = mapTableVisibleText(state, cellFrom, cellTo, values);
  if (!mapped) return null;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    const source = mapped[index]!;
    if (from < 0 && visibleFrom >= visibleOffset && visibleFrom < visibleOffset + value.length) from = source.from + visibleFrom - visibleOffset;
    if (visibleTo > visibleOffset && visibleTo <= visibleOffset + value.length) to = source.from + visibleTo - visibleOffset;
    visibleOffset += value.length;
  }
  const text = range.toString();
  return from >= cellFrom && to > from && text.trim() && state.sliceDoc(from, to) === text ? { from, to, text } : null;
}

export function formatTableCellMarkdown(value: string, from: number, to: number, kind: TableCellFormat, linkUrl = "https://"): { value: string; from: number; to: number } {
  const start = Math.max(0, Math.min(from, to, value.length));
  const end = Math.max(start, Math.min(Math.max(from, to), value.length));
  const selected = value.slice(start, end);
  if (kind === "link") {
    const selectedLink = selected.match(/^\[([^\]\r\n]+)]\([^()\r\n]*\)$/);
    if (selectedLink) {
      const label = selectedLink[1]!;
      return { value: value.slice(0, start) + label + value.slice(end), from: start, to: start + label.length };
    }
    const suffix = value.slice(end).match(/^\]\([^()\r\n]*\)/)?.[0];
    if (selected && value[start - 1] === "[" && suffix) {
      return {
        value: value.slice(0, start - 1) + selected + value.slice(end + suffix.length),
        from: start - 1,
        to: start - 1 + selected.length,
      };
    }
    const label = selected || "链接文字";
    const replacement = `[${label.replace(/]/g, "\\]")}](${linkUrl})`;
    const urlStart = start + replacement.lastIndexOf(linkUrl);
    return { value: value.slice(0, start) + replacement + value.slice(end), from: urlStart, to: urlStart + linkUrl.length };
  }
  const [left, right, placeholder] = kind === "bold" ? ["**", "**", "粗体文字"]
    : kind === "italic" ? ["*", "*", "斜体文字"]
      : kind === "strike" ? ["~~", "~~", "删除文字"]
        : ["`", "`", "代码"];
  const text = selected || placeholder;
  if (selected.startsWith(left) && selected.endsWith(right) && selected.length > left.length + right.length) {
    const inner = selected.slice(left.length, -right.length);
    const activeItalic = kind === "italic" && (selected.match(/^\*+/)?.[0].length ?? 0) % 2 === 1
      && (selected.match(/\*+$/)?.[0].length ?? 0) % 2 === 1;
    if (kind !== "italic" || activeItalic) return { value: value.slice(0, start) + inner + value.slice(end), from: start, to: start + inner.length };
  }
  const leftStart = start - left.length;
  const exactMarkers = selected && leftStart >= 0 && value.slice(leftStart, start) === left && value.slice(end, end + right.length) === right;
  const activeAdjacentItalic = kind === "italic" && (value.slice(0, start).match(/\*+$/)?.[0].length ?? 0) % 2 === 1
    && (value.slice(end).match(/^\*+/)?.[0].length ?? 0) % 2 === 1;
  if (exactMarkers && (kind !== "italic" || activeAdjacentItalic)) {
    return {
      value: value.slice(0, leftStart) + selected + value.slice(end + right.length),
      from: leftStart,
      to: leftStart + selected.length,
    };
  }
  const replacement = left + text + right;
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    from: start + left.length,
    to: start + left.length + text.length,
  };
}

export function isPlainTableCell(source: string): boolean {
  return !/[\r\n*_~`[\]<>$]/.test(source) && !/\\(?!\|)/.test(source);
}

export function isEditableTableCell(source: string): boolean {
  let outsideCode = "";
  for (let index = 0; index < source.length;) {
    if (source[index] !== "`") { outsideCode += source[index++]; continue; }
    let fenceEnd = index + 1;
    while (source[fenceEnd] === "`") fenceEnd++;
    const fence = source.slice(index, fenceEnd);
    let closing = fenceEnd;
    while ((closing = source.indexOf(fence, closing)) >= 0) {
      if (source[closing - 1] !== "`" && source[closing + fence.length] !== "`") break;
      closing += fence.length;
    }
    if (closing < 0) { outsideCode += source.slice(index); break; }
    index = closing + fence.length;
  }
  return !/[\r\n<>$]/.test(outsideCode) && !/!\[/.test(outsideCode);
}

export function replaceTableSnapshotCell(snapshot: TableSnapshot, tableIndex: number, rowIndex: number, columnIndex: number, value: string): TableSnapshot | null {
  const table = snapshot.tables[tableIndex];
  const cell = table?.rows[rowIndex]?.[columnIndex];
  if (!table || !cell || cell.protected || !isEditableTableCell(snapshot.source.slice(cell.from, cell.to))) return null;
  const insert = escapeMarkdownTableCell(value);
  const delta = insert.length - (cell.to - cell.from);
  const shift = (position: number) => position <= cell.from ? position : position >= cell.to ? position + delta : cell.from + insert.length;
  return {
    source: snapshot.source.slice(0, cell.from) + insert + snapshot.source.slice(cell.to),
    tables: snapshot.tables.map((candidate, index) => index !== tableIndex ? {
      ...candidate,
      from: shift(candidate.from),
      to: shift(candidate.to),
      rows: candidate.rows.map(row => row.map(item => ({ ...item, from: shift(item.from), to: shift(item.to) }))),
    } : {
      ...candidate,
      to: candidate.to + delta,
      rows: candidate.rows.map((row, currentRow) => row.map((item, currentColumn) => currentRow === rowIndex && currentColumn === columnIndex
        ? { from: item.from, to: item.from + insert.length, text: value, html: "", protected: false }
        : { ...item, from: shift(item.from), to: shift(item.to) })),
    }),
  };
}

export function tableSnapshotFromHtml(source: string, html: string): TableSnapshot {
  const template = document.createElement("template");
  template.innerHTML = html;
  // ponytail: image-bearing tables stay in source view until nested image widgets share table layout.
  return { source, tables: [...template.content.querySelectorAll('table[data-source-kind="table"]')]
    .filter(table => !table.querySelector('[data-source-kind="image"]'))
    .map(table => ({
    from: Number(table.getAttribute("data-source-from")),
    to: Number(table.getAttribute("data-source-to")),
    rows: [...table.querySelectorAll("tr")].map(row => [...row.querySelectorAll("th,td")].map(cell => ({
      from: Number(cell.getAttribute("data-source-from") ?? NaN),
      to: Number(cell.getAttribute("data-source-to") ?? NaN),
      text: cell.textContent ?? "",
      html: cell.innerHTML,
      protected: Boolean(cell.querySelector('[data-source-kind="image"], [data-source-kind^="formula"], svg, img')),
    }))),
  })) };
}

export const setTableSnapshot = StateEffect.define<TableSnapshot | null>();
export const revealTableSource = StateEffect.define<{ from: number; to: number }>();

class TableWidget extends WidgetType {
  constructor(readonly snapshot: TableSnapshot, readonly tableIndex: number) { super(); }
  get projection(): TableProjection { return this.snapshot.tables[this.tableIndex]!; }
  get expectedSource(): string { return this.snapshot.source.slice(this.projection.from, this.projection.to); }
  eq(other: TableWidget): boolean { return this.expectedSource === other.expectedSource && JSON.stringify(this.projection) === JSON.stringify(other.projection); }
  toDOM(view: EditorView): HTMLElement {
    const { from, to, rows } = this.projection;
    const root = document.createElement("div");
    root.className = "cm-live-table";
    root.dataset.tableFrom = String(from);
    root.contentEditable = "false";
    const details = markdownTableDetails(this.expectedSource)!;
    const table = document.createElement("table");
    root.append(table);
    const selectSource = (start: number, end: number) => {
      if (view.state.sliceDoc(from, to) !== this.expectedSource) return;
      view.dispatch({ selection: { anchor: start, head: end }, effects: revealTableSource.of({ from, to }), scrollIntoView: true });
      view.focus();
    };
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      table.append(tr);
      row.forEach((cell, columnIndex) => {
        const td = document.createElement(rowIndex === 0 ? "th" : "td");
        td.dataset.tableRow = String(rowIndex);
        td.dataset.tableColumn = String(columnIndex);
        td.style.textAlign = details.alignments[columnIndex] ?? "left";
        const button = document.createElement("button");
        button.type = "button";
        if (cell.html) {
          const content = document.createElement("template");
          content.innerHTML = cell.html;
          for (const link of content.content.querySelectorAll("a")) link.removeAttribute("href");
          button.append(content.content.cloneNode(true));
        } else button.textContent = cell.text || "空单元格";
        button.dataset.tableCell = `${rowIndex}:${columnIndex}`;
        button.dataset.sourceFrom = String(cell.from);
        button.dataset.sourceTo = String(cell.to);
        const raw = this.snapshot.source.slice(cell.from, cell.to);
        const editable = !cell.protected && isEditableTableCell(raw);
        button.title = !editable ? "右键选择“编辑表格源码”" : isPlainTableCell(raw) ? "编辑单元格" : "编辑单元格 Markdown";
        button.onmousedown = (event) => event.stopPropagation();
        button.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          // 拖选文字后的 click 不得弹原始 Markdown 输入框（粗体等跨渲染边界的选区无法映射回源码，
          // 旧守卫会漏放）；只看本单元格内是否存在原生选区，保持渲染态与 Obsidian 一致。
          const nativeSelection = window.getSelection();
          if (event.detail > 0 && nativeSelection && nativeSelection.rangeCount > 0 && !nativeSelection.isCollapsed) {
            const range = nativeSelection.getRangeAt(0);
            if (button.contains(range.startContainer) && button.contains(range.endContainer)) return;
          }
          if (!editable) return;
          let caret = 0;
          if (event.detail > 0 && raw === button.textContent) {
            const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
            if (point && button.contains(point.startContainer)) {
              const prefix = document.createRange();
              prefix.selectNodeContents(button);
              prefix.setEnd(point.startContainer, point.startOffset);
              caret = Math.min(raw.length, prefix.toString().length);
            }
          }
          const editor = document.createElement("div");
        editor.className = "cm-live-table-cell-editor";
        const input = document.createElement("textarea");
        input.className = "cm-live-table-cell-input";
        input.wrap = "soft";
        input.rows = 1;
          input.value = raw;
          input.dataset.sourceFrom = String(cell.from);
          input.dataset.sourceTo = String(cell.to);
          input.onmousedown = (event) => event.stopPropagation();
          input.onclick = (event) => event.stopPropagation();
          input.setAttribute("aria-label", `编辑第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`);
          let finished = false;
          const focusCell = (targetRow: number, targetColumn: number, attempts = 80) => {
            const currentRoot = view.dom.querySelector<HTMLElement>(`.cm-live-table[data-table-from="${from}"]`) ?? (root.isConnected ? root : null);
            const target = currentRoot?.querySelector<HTMLButtonElement>(`[data-table-cell="${targetRow}:${targetColumn}"]`);
            if (target) { target.click(); return; }
            if (attempts > 0) setTimeout(() => focusCell(targetRow, targetColumn, attempts - 1), 25);
            else view.focus();
          };
          const finish = (commit: boolean, move = 0) => {
            if (finished) return;
            finished = true;
            const run = () => {
            if (!commit) { editor.remove(); button.style.visibility = ""; button.focus(); return; }
            const insert = escapeMarkdownTableCell(input.value);
            const flat = rows.flatMap((row, r) => row.flatMap((candidate, c) => candidate.protected || !isEditableTableCell(this.snapshot.source.slice(candidate.from, candidate.to)) ? [] : [[r, c] as const]));
            const current = flat.findIndex(([r, c]) => r === rowIndex && c === columnIndex);
            if (move > 0 && current === flat.length - 1) {
              const relativeFrom = cell.from - from;
              const relativeTo = cell.to - from;
              const edited = this.expectedSource.slice(0, relativeFrom) + insert + this.expectedSource.slice(relativeTo);
              const appended = transformMarkdownTable(edited, { kind: "insert-row", rowIndex: rows.length - 1, position: "after" });
              if (!appended || view.state.sliceDoc(from, to) !== this.expectedSource) { editor.remove(); button.style.visibility = ""; return; }
              view.dispatch({ changes: { from, to, insert: appended }, userEvent: "input.table-cell" });
              focusCell(rows.length, 0);
              return;
            }
            const next = replaceTableSnapshotCell(this.snapshot, this.tableIndex, rowIndex, columnIndex, input.value);
            if (!next || view.state.sliceDoc(from, to) !== this.expectedSource) { editor.remove(); button.style.visibility = ""; return; }
            if (input.value === raw) {
              // 值未变：只关输入框、不发事务。否则 html:"" 的快照会让该单元格持久显示原始 Markdown。
              editor.remove();
              button.style.visibility = "";
            } else {
              view.dispatch({
                changes: { from: cell.from, to: cell.to, insert },
                effects: setTableSnapshot.of(next),
                userEvent: "input.table-cell",
              });
            }
            if (move !== 0) {
              const target = flat[current + move];
              if (target) focusCell(target[0], target[1]);
            }
            };
            try {
              run();
            } catch (error) {
              // 失焦可能发生在 CodeMirror 更新中（编辑器点击 → 选区 setState → 同步重渲染 → blur），dispatch 会被
              // CM 拒绝（"EditorView.update in progress"）；推迟到当前更新结束后重跑，run 内的源码一致性校验兜底。
              if (error instanceof Error && error.message.includes("update is in progress")) { queueMicrotask(run); return; }
              throw error;
            }
          };
          const format = (kind: TableCellFormat) => {
            const result = formatTableCellMarkdown(input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0, kind);
            input.value = result.value;
            input.focus();
            input.setSelectionRange(result.from, result.to);
          };
          let composing = false;
          input.addEventListener("compositionstart", () => { composing = true; });
          input.addEventListener("compositionend", () => { composing = false; });
          input.onkeydown = (event) => {
            if (composing || event.isComposing) return;
            if (event.key === "Escape") { event.preventDefault(); finish(false); }
            else if (event.key === "Enter") { event.preventDefault(); finish(true); }
            else if (event.key === "Tab") { event.preventDefault(); finish(true, event.shiftKey ? -1 : 1); }
            else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && ["b", "i", "k"].includes(event.key.toLowerCase())) {
              event.preventDefault();
              format(event.key.toLowerCase() === "b" ? "bold" : event.key.toLowerCase() === "i" ? "italic" : "link");
            }
          };
          input.onblur = () => finish(true);
          editor.append(input);
          button.style.visibility = "hidden";
          td.append(editor);
          input.focus();
          input.setSelectionRange(caret, caret);
          input.scrollTop = 0;
          input.scrollLeft = 0;
        };
        td.append(button);
        tr.append(td);
      });
    });
    const apply = (operation: MarkdownTableOperation) => {
      if (view.state.sliceDoc(from, to) !== this.expectedSource) return;
      const insert = transformMarkdownTable(this.expectedSource, operation);
      if (insert === null) return;
      const cursor = markdownTableInsertedCellOffset(insert, operation);
      view.dispatch({
        changes: { from, to, insert },
        ...(cursor === null ? {} : { selection: { anchor: from + cursor } }),
        userEvent: "input.table",
        scrollIntoView: cursor !== null,
      });
      view.focus();
    };
    const openContextMenu = (event: MouseEvent, rowIndex: number, columnIndex: number) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelectorAll(".cm-live-table-context-menu").forEach((item) => item.remove());
      const menu = document.createElement("div");
      menu.className = "cm-live-table-context-menu";
      menu.setAttribute("role", "menu");
      menu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
      menu.style.top = `${Math.min(event.clientY, window.innerHeight - 330)}px`;
      const close = () => {
        menu.remove();
        document.removeEventListener("pointerdown", closeOnPointer);
        document.removeEventListener("keydown", closeOnEscape);
      };
      const closeOnPointer = (pointerEvent: PointerEvent) => { if (!menu.contains(pointerEvent.target as Node)) close(); };
      const closeOnEscape = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") close(); };
      const addItem = (label: string, action: () => void, disabled = false) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = label;
        item.disabled = disabled;
        item.setAttribute("role", "menuitem");
        item.onmousedown = (pointerEvent) => { pointerEvent.preventDefault(); pointerEvent.stopPropagation(); };
        item.onclick = () => { close(); action(); };
        menu.append(item);
      };
      addItem("上方插入行", () => apply({ kind: "insert-row", rowIndex, position: "before" }));
      addItem("下方插入行", () => apply({ kind: "insert-row", rowIndex, position: "after" }));
      addItem("删除当前行", () => apply({ kind: "delete-row", rowIndex }), rowIndex === 0);
      menu.append(document.createElement("hr"));
      addItem("左侧插入列", () => apply({ kind: "insert-column", columnIndex, position: "before" }));
      addItem("右侧插入列", () => apply({ kind: "insert-column", columnIndex, position: "after" }));
      addItem("删除当前列", () => apply({ kind: "delete-column", columnIndex }), details.columnCount <= 1);
      menu.append(document.createElement("hr"));
      addItem("左对齐", () => apply({ kind: "set-alignment", columnIndex, alignment: "left" }));
      addItem("居中", () => apply({ kind: "set-alignment", columnIndex, alignment: "center" }));
      addItem("右对齐", () => apply({ kind: "set-alignment", columnIndex, alignment: "right" }));
      menu.append(document.createElement("hr"));
      addItem("编辑表格源码", () => selectSource(from, to));
      root.append(menu);
      setTimeout(() => {
        document.addEventListener("pointerdown", closeOnPointer);
        document.addEventListener("keydown", closeOnEscape);
      });
    };
    table.oncontextmenu = (event) => {
      const cell = (event.target as Element | null)?.closest<HTMLElement>("th[data-table-row], td[data-table-row]");
      if (!cell || !table.contains(cell)) return;
      const input = cell.querySelector<HTMLTextAreaElement>(".cm-live-table-cell-input");
      if (input && input.selectionStart !== input.selectionEnd) return;
      openContextMenu(event, Number(cell.dataset.tableRow), Number(cell.dataset.tableColumn));
    };
    for (const image of root.querySelectorAll("img")) {
      image.onload = () => view.requestMeasure();
    }
    return root;
  }
  ignoreEvent(): boolean { return true; }
}

export function tableDecorations(state: EditorState, snapshot: TableSnapshot | null, revealed: { from: number; to: number } | null = null): DecorationSet {
  if (!snapshot || snapshot.source !== state.doc.toString()) return Decoration.none;
  let previousEnd = -1;
  const ranges = snapshot.tables.flatMap((table, tableIndex) => {
    const { from, to, rows } = table;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > state.doc.length || from < previousEnd) return [];
    const details = markdownTableDetails(snapshot.source.slice(from, to));
    if (!details || rows.length !== details.rows.length || rows.some(row => row.length !== details.columnCount || row.some(cell => !Number.isInteger(cell.from) || !Number.isInteger(cell.to) || cell.from < from || cell.to < cell.from || cell.to > to))) return [];
    previousEnd = to;
    if (revealed && revealed.from < to && revealed.to > from) return [];
    return [Decoration.replace({ widget: new TableWidget(snapshot, tableIndex), block: true }).range(from, to)];
  });
  return Decoration.set(ranges, true);
}

export const livePreviewTables = StateField.define<{ snapshot: TableSnapshot | null; revealed: { from: number; to: number } | null; decorations: DecorationSet }>({
  create: () => ({ snapshot: null, revealed: null, decorations: Decoration.none }),
  update(value, transaction) {
    let revealed = value.revealed && transaction.docChanged
      ? { from: transaction.changes.mapPos(value.revealed.from, -1), to: transaction.changes.mapPos(value.revealed.to, 1) }
      : value.revealed;
    let snapshot = transaction.docChanged
      ? value.snapshot ? {
          source: transaction.state.doc.toString(),
          tables: value.snapshot.tables.flatMap((table) => {
            const mapped = remapUnchangedSnapshotRange(transaction, table);
            if (!mapped) return [];
            const offset = mapped.from - table.from;
            return [{
              ...table,
              ...mapped,
              rows: table.rows.map((row) => row.map((cell) => ({ ...cell, from: cell.from + offset, to: cell.to + offset }))),
            }];
          }),
        } : null
      : value.snapshot;
    let explicitlyRevealed = false;
    for (const effect of transaction.effects) {
      if (effect.is(setTableSnapshot)) snapshot = effect.value;
      else if (effect.is(revealTableSource)) { revealed = effect.value; explicitlyRevealed = true; }
    }
    const activeReveal = revealed;
    if (!explicitlyRevealed && activeReveal && !transaction.state.selection.ranges.some(range => range.empty ? range.head >= activeReveal.from && range.head <= activeReveal.to : range.from < activeReveal.to && range.to > activeReveal.from)) revealed = null;
    return { snapshot, revealed, decorations: tableDecorations(transaction.state, snapshot, revealed) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
