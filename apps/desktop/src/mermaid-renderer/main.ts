import mermaid from "mermaid";
import "./styles.css";

interface MermaidRenderRequest {
  source: string;
  darkMode: boolean;
  fontFamily: string;
}

type MermaidPageResult =
  | { status: "completed"; width: number; height: number }
  | { status: "failed"; code: string };

declare global {
  interface Window {
    fantasticMermaidRendererReady: boolean;
    renderFantasticMermaid(request: MermaidRenderRequest): Promise<MermaidPageResult>;
  }
}

const root = document.querySelector<HTMLElement>("#mermaid-root");
if (!root) throw new Error("Mermaid root missing");
let sequence = 0;

window.renderFantasticMermaid = async (request): Promise<MermaidPageResult> => {
  root.replaceChildren();
  if (
    typeof request?.source !== "string"
    || request.source.trim().length === 0
    || request.source.length > 100_000
    || typeof request.darkMode !== "boolean"
    || typeof request.fontFamily !== "string"
    || request.fontFamily.length > 128
  ) return { status: "failed", code: "MERMAID_REQUEST_INVALID" };
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: request.darkMode ? "dark" : "default",
      fontFamily: request.fontFamily,
      suppressErrorRendering: true,
    });
    const result = await mermaid.render(`fantastic-export-mermaid-${++sequence}`, request.source);
    root.innerHTML = result.svg;
    result.bindFunctions?.(root);
    const svg = root.querySelector<SVGSVGElement>("svg");
    if (!svg) return { status: "failed", code: "MERMAID_RENDER_FAILED" };
    const rect = svg.getBoundingClientRect();
    const width = Math.ceil(Math.max(rect.width, svg.scrollWidth) + 32);
    const height = Math.ceil(Math.max(rect.height, svg.scrollHeight) + 32);
    if (width <= 32 || height <= 32 || width > 4096 || height > 4096) {
      root.replaceChildren();
      return { status: "failed", code: "MERMAID_DIMENSION_LIMIT_EXCEEDED" };
    }
    return { status: "completed", width, height };
  } catch {
    root.replaceChildren();
    return { status: "failed", code: "MERMAID_RENDER_FAILED" };
  }
};

window.fantasticMermaidRendererReady = true;
