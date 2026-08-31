export interface PdfLayoutAudit {
  scaledElements: number;
  unresolvedOverflowElements: number;
  imageCount: number;
  pageEstimate: number;
}

export const PDF_CONTENT_HEIGHT_PX = 263 * 96 / 25.4;

export function isPdfLayoutAudit(value: unknown): value is PdfLayoutAudit {
  if (!value || typeof value !== "object") return false;
  const audit = value as Partial<PdfLayoutAudit>;
  return Number.isInteger(audit.scaledElements)
    && Number.isInteger(audit.unresolvedOverflowElements)
    && Number.isInteger(audit.imageCount)
    && Number.isInteger(audit.pageEstimate)
    && Number(audit.scaledElements) >= 0
    && Number(audit.unresolvedOverflowElements) >= 0
    && Number(audit.imageCount) >= 0
    && Number(audit.pageEstimate) >= 1;
}

export function estimatePdfPageCount(contentHeightPx: number): number {
  if (!Number.isFinite(contentHeightPx) || contentHeightPx <= 0) return 1;
  return Math.max(1, Math.ceil(contentHeightPx / PDF_CONTENT_HEIGHT_PX));
}

export const PDF_PRINT_STYLE = [
  "@page{size:A4 portrait;margin:16mm 15mm 18mm}",
  "@media print{",
  "html,body{background:#fff!important}",
  "body{-webkit-print-color-adjust:exact;print-color-adjust:exact}",
  ".document{width:auto;max-width:none;margin:0;padding:0;overflow:visible}",
  "h1,h2,h3,h4,h5,h6{break-after:avoid-page;page-break-after:avoid;orphans:3;widows:3}",
  "p,li,blockquote{orphans:3;widows:3}",
  "blockquote,.formula-block,.mermaid-export,img,.resource-placeholder{break-inside:avoid-page;page-break-inside:avoid}",
  "img,.mermaid-export{max-width:100%;max-height:245mm;object-fit:contain}",
  "table{width:100%;max-width:100%;break-inside:auto;page-break-inside:auto}",
  "thead{display:table-header-group}tfoot{display:table-footer-group}",
  "tr{break-inside:avoid-page;page-break-inside:avoid}",
  "th,td{overflow-wrap:anywhere;word-break:break-word}",
  "pre{max-width:100%;overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;break-inside:auto;page-break-inside:auto;box-decoration-break:clone;-webkit-box-decoration-break:clone}",
  "code{overflow-wrap:anywhere;word-break:break-word}",
  ".katex-display{max-width:100%;overflow:visible}",
  "a{color:inherit;text-decoration:underline}",
  "}",
].join("");

export const PDF_PREPARE_SCRIPT = [
  "(async () => {",
  "  await (document.fonts ? document.fonts.ready : Promise.resolve());",
  "  await Promise.all(Array.from(document.images).map((image) => image.complete && image.naturalWidth > 0",
  "    ? Promise.resolve()",
  "    : new Promise((resolve, reject) => {",
  "        image.addEventListener('load', resolve, { once: true });",
  "        image.addEventListener('error', () => reject(new Error('image-load-failed')), { once: true });",
  "      })));",
  "  document.documentElement.classList.add('pdf-export-ready');",
  "  const documentElement = document.querySelector('.document');",
  "  const availableWidth = documentElement instanceof HTMLElement ? documentElement.clientWidth : 0;",
  "  let scaledElements = 0;",
  "  let unresolvedOverflowElements = 0;",
  "  if (availableWidth > 0) {",
  "    for (const element of document.querySelectorAll('table,.katex-display')) {",
  "      if (!(element instanceof HTMLElement) || element.scrollWidth <= availableWidth + 1) continue;",
  "      const requiredScale = availableWidth / element.scrollWidth;",
  "      const scale = Math.max(0.55, Math.min(1, requiredScale));",
  "      element.style.zoom = String(scale);",
  "      element.dataset.pdfScaled = 'true';",
  "      scaledElements += 1;",
  "      if (element.scrollWidth * scale > availableWidth + 2) unresolvedOverflowElements += 1;",
  "    }",
  "  }",
  "  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));",
  "  const contentHeight = documentElement instanceof HTMLElement ? documentElement.scrollHeight : document.body.scrollHeight;",
  "  return {",
  "    scaledElements,",
  "    unresolvedOverflowElements,",
  "    imageCount: document.images.length,",
  "    pageEstimate: Math.max(1, Math.ceil(contentHeight / (263 * 96 / 25.4))),",
  "  };",
  "})()",
].join("\n");