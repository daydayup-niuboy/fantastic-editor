import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { markdownTableDetails, markdownTableInsertedCellOffset, transformMarkdownTable, type MarkdownTableOperation } from "./wysiwyg-transactions";

interface TableCell { from: number; to: number; text: string }
interface TableProjection { from: number; to: number; rows: TableCell[][] }
export interface TableSnapshot { source: string; tables: TableProjection[] }

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
    }))),
  })) };
}

export const setTableSnapshot = StateEffect.define<TableSnapshot | null>();

class TableWidget extends WidgetType {
  constructor(readonly projection: TableProjection, readonly source: string) { super(); }
  eq(other: TableWidget): boolean { return this.source === other.source && JSON.stringify(this.projection) === JSON.stringify(other.projection); }
  toDOM(view: EditorView): HTMLElement {
    const { from, to, rows } = this.projection;
    const root = document.createElement("div");
    root.className = "cm-live-table";
    root.contentEditable = "false";
    const details = markdownTableDetails(this.source.slice(from, to))!;
    const table = document.createElement("table");
    root.append(table);
    const selectSource = (start: number, end: number) => {
      if (view.state.doc.toString() !== this.source) return;
      view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true });
      view.focus();
    };
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      table.append(tr);
      row.forEach((cell, columnIndex) => {
        const td = document.createElement(rowIndex === 0 ? "th" : "td");
        td.style.textAlign = details.alignments[columnIndex] ?? "left";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = cell.text || "空单元格";
        button.title = "编辑单元格 Markdown";
        button.onclick = () => selectSource(cell.from, cell.to);
        td.append(button);
        tr.append(td);
      });
    });
    const toolbar = document.createElement("div");
    toolbar.className = "cm-live-table-tools";
    root.append(toolbar);
    const rowSelect = document.createElement("select");
    rowSelect.setAttribute("aria-label", "操作行");
    rows.forEach((_, index) => rowSelect.add(new Option(index === 0 ? "表头" : `第 ${index} 行`, String(index))));
    const columnSelect = document.createElement("select");
    columnSelect.setAttribute("aria-label", "操作列");
    for (let index = 0; index < details.columnCount; index++) columnSelect.add(new Option(`第 ${index + 1} 列`, String(index)));
    toolbar.append(rowSelect, columnSelect);
    const apply = (operation: MarkdownTableOperation) => {
      if (view.state.doc.toString() !== this.source) return;
      const insert = transformMarkdownTable(this.source.slice(from, to), operation);
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
    const addButton = (label: string, action: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onmousedown = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      button.onclick = (event) => {
        event.stopPropagation();
        action();
      };
      toolbar.append(button);
      return button;
    };
    addButton("下方插入行", () => apply({ kind: "insert-row", rowIndex: Number(rowSelect.value), position: "after" }));
    const deleteRow = addButton("删除行", () => apply({ kind: "delete-row", rowIndex: Number(rowSelect.value) }));
    deleteRow.disabled = true;
    rowSelect.onchange = () => { deleteRow.disabled = rowSelect.value === "0"; };
    addButton("右侧插入列", () => apply({ kind: "insert-column", columnIndex: Number(columnSelect.value), position: "after" }));
    addButton("删除列", () => apply({ kind: "delete-column", columnIndex: Number(columnSelect.value) })).disabled = details.columnCount <= 1;
    for (const [label, alignment] of [["左对齐", "left"], ["居中", "center"], ["右对齐", "right"]] as const) {
      addButton(label, () => apply({ kind: "set-alignment", columnIndex: Number(columnSelect.value), alignment }));
    }
    addButton("编辑表格源码", () => selectSource(from, to));
    return root;
  }
  ignoreEvent(): boolean { return true; }
}

export function tableDecorations(state: EditorState, snapshot: TableSnapshot | null): DecorationSet {
  if (!snapshot || snapshot.source !== state.doc.toString()) return Decoration.none;
  let previousEnd = -1;
  const ranges = snapshot.tables.flatMap(table => {
    const { from, to, rows } = table;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > state.doc.length || from < previousEnd) return [];
    const details = markdownTableDetails(snapshot.source.slice(from, to));
    if (!details || rows.length !== details.rows.length || rows.some(row => row.length !== details.columnCount || row.some(cell => !Number.isInteger(cell.from) || !Number.isInteger(cell.to) || cell.from < from || cell.to < cell.from || cell.to > to))) return [];
    previousEnd = to;
    if (state.selection.ranges.some(range => range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from)) return [];
    return [Decoration.replace({ widget: new TableWidget(table, snapshot.source), block: true }).range(from, to)];
  });
  return Decoration.set(ranges, true);
}

export const livePreviewTables = StateField.define<{ snapshot: TableSnapshot | null; decorations: DecorationSet }>({
  create: () => ({ snapshot: null, decorations: Decoration.none }),
  update(value, transaction) {
    let snapshot = transaction.docChanged ? null : value.snapshot;
    for (const effect of transaction.effects) if (effect.is(setTableSnapshot)) snapshot = effect.value;
    return { snapshot, decorations: tableDecorations(transaction.state, snapshot) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
