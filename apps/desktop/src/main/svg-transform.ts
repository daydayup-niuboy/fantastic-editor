import { Resvg } from "@resvg/resvg-js";

export const SVG_TRANSFORM_PROFILE = "svg-safe-png-0.1";
export const SVG_TRANSFORMER_VERSION = "resvg-js-2";
const MAX_SVG_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_DIMENSION = 4096;
const DISALLOWED_ELEMENTS = /<\s*\/?\s*(?:script|foreignObject|style|iframe|object|embed|audio|video|image|feImage|animate|animateMotion|animateTransform|set)\b/i;
const HREF_ATTRIBUTE = /(?:^|\s)(?:[a-z][\w.-]*:)?href\s*=\s*(["'])([\s\S]*?)\1/gi;
const HREF_MARKER = /(?:^|\s)(?:[a-z][\w.-]*:)?href\s*=/gi;
const URL_FUNCTION = /url\s*\(\s*(["']?)(.*?)\1\s*\)/gi;

export type SvgTransformResult =
  | { status: "completed"; png: Uint8Array; width: number; height: number }
  | { status: "failed"; code: string; message: string };

function failure(code: string, message: string): SvgTransformResult {
  return { status: "failed", code, message };
}

function decodeSvg(bytes: Uint8Array): string | undefined {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  } catch {
    return undefined;
  }
}

export function validateSvgSource(bytes: Uint8Array): { status: "accepted"; source: string } | SvgTransformResult {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SVG_BYTES) {
    return failure("SVG_SIZE_LIMIT_EXCEEDED", "SVG 为空或超过 10 MiB 安全上限。");
  }
  const source = decodeSvg(bytes);
  if (!source) return failure("SVG_INVALID_UTF8", "SVG 必须是有效 UTF-8 文本。");
  if (source.includes("\u0000")) return failure("SVG_NUL_BLOCKED", "SVG 包含非法 NUL 字符。");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) {
    return failure("SVG_DTD_ENTITY_BLOCKED", "SVG 中的 DTD 和实体声明已被阻止。");
  }
  if (/<\?(?!xml(?:\s|\?>))/i.test(source)) {
    return failure("SVG_PROCESSING_INSTRUCTION_BLOCKED", "SVG 处理指令已被阻止。");
  }
  if (!/<svg(?:\s|>)/i.test(source)) return failure("SVG_ROOT_REQUIRED", "SVG 缺少有效根元素。");
  if (DISALLOWED_ELEMENTS.test(source)) {
    return failure("SVG_ACTIVE_CONTENT_BLOCKED", "SVG 包含脚本、嵌入资源或动态内容。");
  }
  if (/\son[a-z\d_.:-]*\s*=/i.test(source)) {
    return failure("SVG_EVENT_HANDLER_BLOCKED", "SVG 事件处理属性已被阻止。");
  }
  if (/\b(?:xml:base|src|data)\s*=/i.test(source)) {
    return failure("SVG_EXTERNAL_RESOURCE_BLOCKED", "SVG 外部资源定位属性已被阻止。");
  }
  if (/@(?:import|font-face)\b|javascript\s*:|data\s*:|file\s*:/i.test(source)) {
    return failure("SVG_EXTERNAL_RESOURCE_BLOCKED", "SVG 外部协议、嵌入数据或字体规则已被阻止。");
  }

  const hrefMarkers = source.match(HREF_MARKER)?.length ?? 0;
  const hrefs = [...source.matchAll(HREF_ATTRIBUTE)];
  if (hrefMarkers !== hrefs.length || hrefs.some((match) => !/^#[A-Za-z_][\w:.-]*$/.test(match[2] ?? ""))) {
    return failure("SVG_EXTERNAL_RESOURCE_BLOCKED", "SVG href 只允许引用文档内的片段 ID。");
  }
  for (const match of source.matchAll(URL_FUNCTION)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2]?.trim() ?? "")) {
      return failure("SVG_EXTERNAL_RESOURCE_BLOCKED", "SVG CSS url() 只允许引用文档内的片段 ID。");
    }
  }
  return { status: "accepted", source };
}

export function transformSvgToPng(bytes: Uint8Array): SvgTransformResult {
  const validated = validateSvgSource(bytes);
  if (validated.status !== "accepted") return validated;
  try {
    const inspect = new Resvg(validated.source, {
      fitTo: { mode: "original" },
      font: { loadSystemFonts: false },
      logLevel: "off",
    });
    if (inspect.imagesToResolve().length > 0) {
      return failure("SVG_EXTERNAL_RESOURCE_BLOCKED", "SVG 请求了外部或嵌入图片资源。");
    }
    if (!Number.isFinite(inspect.width) || !Number.isFinite(inspect.height) || inspect.width <= 0 || inspect.height <= 0) {
      return failure("SVG_INVALID_DIMENSIONS", "SVG 缺少有效尺寸或 viewBox。");
    }
    const largest = Math.max(inspect.width, inspect.height);
    const renderer = largest <= MAX_OUTPUT_DIMENSION
      ? inspect
      : new Resvg(validated.source, {
        fitTo: inspect.width >= inspect.height
          ? { mode: "width", value: MAX_OUTPUT_DIMENSION }
          : { mode: "height", value: MAX_OUTPUT_DIMENSION },
        font: { loadSystemFonts: false },
        logLevel: "off",
      });
    if (renderer.imagesToResolve().length > 0) {
      return failure("SVG_EXTERNAL_RESOURCE_BLOCKED", "SVG 请求了外部或嵌入图片资源。");
    }
    const rendered = renderer.render();
    if (rendered.width <= 0 || rendered.height <= 0 || rendered.width > MAX_OUTPUT_DIMENSION || rendered.height > MAX_OUTPUT_DIMENSION) {
      return failure("SVG_OUTPUT_DIMENSIONS_INVALID", "SVG 栅格化结果尺寸无效。");
    }
    return {
      status: "completed",
      png: new Uint8Array(rendered.asPng()),
      width: rendered.width,
      height: rendered.height,
    };
  } catch {
    return failure("SVG_RENDER_FAILED", "SVG 无法安全解析或栅格化。");
  }
}