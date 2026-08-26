import mermaid from "mermaid";

const MAX_PREVIEW_DIAGRAMS = 100;
const MAX_DIAGRAM_SOURCE_LENGTH = 100_000;
let renderSequence = 0;

export interface MermaidPreviewOptions {
  darkMode: boolean;
  fontFamily: string;
}

export interface MermaidPreviewResult {
  rendered: number;
  failed: number;
  limited: number;
}

function copySourceIdentity(source: HTMLElement, target: HTMLElement): void {
  for (const name of ["data-source-from", "data-source-to", "data-source-kind", "data-source-block"]) {
    const value = source.getAttribute(name);
    if (value !== null) target.setAttribute(name, value);
  }
}

export async function renderMermaidPreview(
  content: HTMLElement,
  options: MermaidPreviewOptions,
): Promise<MermaidPreviewResult> {
  const blocks = [...content.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: options.darkMode ? "dark" : "default",
    fontFamily: options.fontFamily,
    suppressErrorRendering: true,
  });

  let rendered = 0;
  let failed = 0;
  let limited = 0;
  for (const [index, code] of blocks.entries()) {
    const pre = code.parentElement;
    if (!pre) continue;
    if (index >= MAX_PREVIEW_DIAGRAMS) {
      limited += 1;
      pre.classList.add("mermaid-error");
      pre.textContent = "[Mermaid 图表数量超过单篇预览上限 100]";
      continue;
    }
    const source = code.textContent ?? "";
    if (!source.trim() || source.length > MAX_DIAGRAM_SOURCE_LENGTH) {
      failed += 1;
      pre.classList.add("mermaid-error");
      pre.textContent = "[Mermaid 源码为空或超过 100,000 字符]";
      continue;
    }
    const host = document.createElement("figure");
    host.className = "mermaid-diagram";
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", "Mermaid 流程图");
    copySourceIdentity(pre, host);
    try {
      const id = `fantastic-mermaid-${Date.now()}-${++renderSequence}`;
      const staging = document.createElement("div");
      staging.style.cssText = "position:fixed;left:-100000px;top:-100000px;width:1200px;visibility:hidden;pointer-events:none";
      document.body.append(staging);
      let timeout: number | undefined;
      try {
        const result = await Promise.race([
          mermaid.render(id, source, staging),
          new Promise<never>((_resolve, reject) => {
            timeout = window.setTimeout(() => reject(new Error("Mermaid preview timed out")), 5000);
          }),
        ]);
        host.innerHTML = result.svg;
        result.bindFunctions?.(host);
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        staging.remove();
      }
      pre.replaceWith(host);
      rendered += 1;
    } catch {
      failed += 1;
      pre.classList.add("mermaid-error");
      pre.textContent = "[Mermaid 语法错误，无法渲染流程图]";
    }
  }
  return { rendered, failed, limited };
}

