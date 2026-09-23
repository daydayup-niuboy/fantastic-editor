import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { escapeMarkdownTableCell, markdownTableDetails, markdownTableInsertedCellOffset, transformMarkdownTable, type MarkdownTableOperation } from "./wysiwyg-transactions";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

export function showSelectionFormatMenu(event: MouseEvent, apply: (kind: TableCellFormat) => void, anchorRect?: { left: number; right: number; top: number; bottom: number } | null): void {
  event.preventDefault();
  event.stopPropagation();
  document.querySelectorAll(".cm-live-table-context-menu").forEach((item) => item.remove());
  const menu = document.createElement("div");
  menu.className = "cm-live-table-context-menu cm-live-table-format-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", closeOnPointer);
    document.removeEventListener("keydown", closeOnEscape);
  };
  const closeOnPointer = (pointerEvent: PointerEvent) => { if (!menu.contains(pointerEvent.target as Node)) close(); };
  const closeOnEscape = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") close(); };
  for (const [label, kind] of [["B", "bold"], ["I", "italic"], ["S", "strike"], ["`", "code"], ["链接", "link"]] as const) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.setAttribute("role", "menuitem");
    item.onmousedown = (pointerEvent) => { pointerEvent.preventDefault(); pointerEvent.stopPropagation(); };
    item.onclick = () => { close(); apply(kind); };
    menu.append(item);
  }
  document.body.append(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  if (anchorRect) {
    const centeredLeft = (anchorRect.left + anchorRect.right) / 2 - width / 2;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, centeredLeft))}px`;
    const aboveTop = anchorRect.top - height - 6;
    menu.style.top = `${aboveTop < 8 ? Math.min(window.innerHeight - height - 8, anchorRect.bottom + 6) : aboveTop}px`;
  } else {
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  }
  menu.style.visibility = "";
  setTimeout(() => {
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
  });
}


interface TableCell { from: number; to: number; text: string; html: string; protected: boolean }
interface TableProjection { from: number; to: number; rows: TableCell[][] }
export interface TableSnapshot { source: string; tables: TableProjection[] }
export type TableCellFormat = "bold" | "italic" | "strike" | "code" | "link";
export function tableCellContextMenuKind(editing: boolean, selectionStart: number, selectionEnd: number): "format" | "structure" {
  return editing && selectionStart !== selectionEnd ? "format" : "structure";
}

export function formatTableCellMarkdown(value: string, from: number, to: number, kind: TableCellFormat): { value: string; from: number; to: number } {
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
    const replacement = `[${label.replace(/]/g, "\\]")}](https://)`;
    const urlStart = start + replacement.lastIndexOf("https://");
    return { value: value.slice(0, start) + replacement + value.slice(end), from: urlStart, to: urlStart + 8 };
  }
  const [left, right, placeholder] = kind === "bold" ? ["**", "**", "粗体文字"]
    : kind === "italic" ? ["*", "*", "斜体文字"]
      : kind === "strike" ? ["~~", "~~", "删除文字"]
        : ["`", "`", "代码"];
  const text = selected || placeholder;
  if (selected.startsWith(left) && selected.endsWith(right) && selected.length > left.length + right.length) {
    const inner = selected.slice(left.length, -right.length);
    const ambiguousFullSingleMarker = left.length === 1 && (inner.startsWith(left) || inner.endsWith(right));
    if (!ambiguousFullSingleMarker) return { value: value.slice(0, start) + inner + value.slice(end), from: start, to: start + inner.length };
  }
  const leftStart = start - left.length;
  const exactMarkers = selected && leftStart >= 0 && value.slice(leftStart, start) === left && value.slice(end, end + right.length) === right;
  const ambiguousSingleMarker = left.length === 1 && (value[leftStart - 1] === left || value[end + right.length] === right);
  if (exactMarkers && !ambiguousSingleMarker) {
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
  const expectedText = table && cell ? snapshot.source.slice(cell.from, cell.to) : "";
  if (!table || !cell || cell.protected || !isEditableTableCell(expectedText)) return null;
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
        const raw = this.snapshot.source.slice(cell.from, cell.to);
        const editable = !cell.protected && isEditableTableCell(raw);
        button.title = editable ? (isPlainTableCell(raw) ? "编辑单元格" : "编辑单元格 Markdown") : "在源码中编辑此单元格";
        button.onmousedown = (event) => { event.preventDefault(); event.stopPropagation(); };
        button.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!editable) { selectSource(cell.from, cell.to); return; }
          const editor = document.createElement("div");
          editor.className = "cm-live-table-cell-editor";
          const input = document.createElement("input");
          input.type = "text";
          input.value = raw;
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
            if (!commit) { editor.replaceWith(button); button.focus(); return; }
            const insert = escapeMarkdownTableCell(input.value);
            const flat = rows.flatMap((row, r) => row.flatMap((candidate, c) => {
              const source = this.snapshot.source.slice(candidate.from, candidate.to);
              return !candidate.protected && isEditableTableCell(source) ? [[r, c] as const] : [];
            }));
            const current = flat.findIndex(([r, c]) => r === rowIndex && c === columnIndex);
            if (move > 0 && current === flat.length - 1) {
              const relativeFrom = cell.from - from;
              const relativeTo = cell.to - from;
              const edited = this.expectedSource.slice(0, relativeFrom) + insert + this.expectedSource.slice(relativeTo);
              const appended = transformMarkdownTable(edited, { kind: "insert-row", rowIndex: rows.length - 1, position: "after" });
              if (!appended || view.state.sliceDoc(from, to) !== this.expectedSource) { editor.replaceWith(button); return; }
              view.dispatch({ changes: { from, to, insert: appended }, userEvent: "input.table-cell" });
              focusCell(rows.length, 0);
              return;
            }
            const next = replaceTableSnapshotCell(this.snapshot, this.tableIndex, rowIndex, columnIndex, input.value);
            if (!next || view.state.sliceDoc(from, to) !== this.expectedSource) { editor.replaceWith(button); return; }
            view.dispatch({
              changes: { from: cell.from, to: cell.to, insert },
              effects: setTableSnapshot.of(next),
              userEvent: "input.table-cell",
            });
            const target = flat[current + move];
            if (target) focusCell(target[0], target[1]);
          };
          const format = (kind: TableCellFormat) => {
            const result = formatTableCellMarkdown(input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0, kind);
            input.value = result.value;
            input.focus();
            input.setSelectionRange(result.from, result.to);
          };
          input.onkeydown = (event) => {
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
          button.replaceWith(editor);
          input.focus();
          input.select();
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
    const openFormatMenu = (event: MouseEvent, input: HTMLInputElement) => {
      showSelectionFormatMenu(event, (kind) => {
        const result = formatTableCellMarkdown(input.value, input.selectionStart ?? 0, input.selectionEnd ?? 0, kind);
        input.value = result.value;
        input.focus();
        input.setSelectionRange(result.from, result.to);
      }, input.getBoundingClientRect());
    };
    table.oncontextmenu = (event) => {
      const cell = (event.target as Element | null)?.closest<HTMLElement>("th[data-table-row], td[data-table-row]");
      if (!cell || !table.contains(cell)) return;
      const input = cell.querySelector("input");
      if (input instanceof HTMLInputElement && tableCellContextMenuKind(true, input.selectionStart ?? 0, input.selectionEnd ?? 0) === "format") {
        openFormatMenu(event, input);
        return;
      }
      openContextMenu(event, Number(cell.dataset.tableRow), Number(cell.dataset.tableColumn));
    };
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
