import { useRef, type PointerEvent } from "react";
import { MAX_READING_WIDTH_PX, MIN_READING_WIDTH_PX, normalizeReadingWidthPx } from "./preview-font";

export function EditorRuler({ widthPx, onChange, onReset }: { widthPx: number; onChange: (width: number) => void; onReset: () => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; width: number; side: 1 | -1 } | null>(null);

  const applyDrag = (clientX: number) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || !track) return;
    const max = Math.min(MAX_READING_WIDTH_PX, Math.max(MIN_READING_WIDTH_PX, track.clientWidth - 24));
    onChange(normalizeReadingWidthPx(Math.min(max, drag.width + (clientX - drag.x) * 2 * drag.side)));
  };

  const startDrag = (side: 1 | -1) => (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, width: widthPx, side };
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) applyDrag(event.clientX);
  };

  return (
    <div className="editor-ruler" ref={trackRef} aria-label="编辑区宽度标尺" title="拖动左右滑块调整内容宽度，不改变导出结果">
      <div className="editor-ruler-ticks" />
      <div className="editor-ruler-band" style={{ width: `${widthPx}px` }}>
        <button type="button" className="editor-ruler-handle" aria-label="调整左边距" onPointerDown={startDrag(-1)} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null; }} />
        <button type="button" className="editor-ruler-reset" title="宽度复位为 720px" aria-label="宽度复位" onClick={onReset}>{widthPx}px</button>
        <button type="button" className="editor-ruler-handle" aria-label="调整右边距" onPointerDown={startDrag(1)} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null; }} />
      </div>
    </div>
  );
}
