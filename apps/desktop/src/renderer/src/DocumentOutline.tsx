import type { OutlineEntry } from "./document-outline";

interface DocumentOutlineProps {
  entries: readonly OutlineEntry[];
  stale?: boolean;
  onReveal(entry: OutlineEntry): void;
}

export function DocumentOutline({ entries, stale = false, onReveal }: DocumentOutlineProps) {
  return (
    <nav className="document-outline" aria-label="文档大纲">
      {stale && <p className="outline-hint">正在更新大纲…</p>}
      {!stale && entries.length === 0 && <p className="outline-hint">当前文档没有标题</p>}
      {entries.length > 0 && (
        <ol>
          {entries.map((entry) => (
            <li key={entry.nodeId} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 12}px` }}>
              <button type="button" title={`跳转到 ${entry.label}`} onClick={() => onReveal(entry)}>
                <span className="outline-level">H{entry.level}</span><span>{entry.label}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
