import katex from "katex";
import "katex/dist/katex.min.css";
import "./styles.css";

interface FormulaRenderRequest {
  latex: string;
  displayMode: boolean;
}

type FormulaPageResult =
  | { status: "completed"; width: number; height: number }
  | { status: "failed"; code: string };

declare global {
  interface Window {
    fantasticFormulaRendererReady: boolean;
    renderFantasticFormula(request: FormulaRenderRequest): FormulaPageResult;
  }
}

const root = document.querySelector<HTMLElement>("#formula-root");
if (!root) throw new Error("formula root missing");

window.renderFantasticFormula = (request): FormulaPageResult => {
  root.replaceChildren();
  if (
    typeof request?.latex !== "string"
    || request.latex.length === 0
    || request.latex.length > 100_000
    || typeof request.displayMode !== "boolean"
  ) return { status: "failed", code: "FORMULA_REQUEST_INVALID" };
  try {
    katex.render(request.latex, root, {
      displayMode: request.displayMode,
      throwOnError: true,
      strict: "error",
      output: "html",
      trust: false,
    });
    const width = Math.ceil(Math.max(root.scrollWidth, root.getBoundingClientRect().width) + 32);
    const height = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height) + 32);
    if (width <= 32 || height <= 32 || width > 4096 || height > 2048) {
      root.replaceChildren();
      return { status: "failed", code: "FORMULA_DIMENSION_LIMIT_EXCEEDED" };
    }
    return { status: "completed", width, height };
  } catch {
    root.replaceChildren();
    return { status: "failed", code: "FORMULA_RENDER_FAILED" };
  }
};

window.fantasticFormulaRendererReady = true;