export const OFFICIAL_WECHAT_THEME_IDS = [
  "wechat-native-enhanced",
  "minimal-ink",
  "deep-blue-tech",
] as const;

export type OfficialWechatThemeId = (typeof OFFICIAL_WECHAT_THEME_IDS)[number];
export type LegacyWechatThemeAlias = "wechat-green";
export type WechatThemeId = OfficialWechatThemeId | `${OfficialWechatThemeId}+${string}`;

export const WECHAT_CUSTOM_THEME_ID_RE =
  /^(wechat-native-enhanced|minimal-ink|deep-blue-tech)\+[0-9a-f]{12}$/;

export type WechatThemeErrorCode =
  | "WECHAT_THEME_UNKNOWN"
  | "WECHAT_THEME_OVERLAY_MISSING"
  | "WECHAT_THEME_OVERLAY_SCHEMA_INVALID"
  | "WECHAT_THEME_HASH_COLLISION"
  | "WECHAT_THEME_INVALID_TOKEN"
  | "WECHAT_THEME_UNSUPPORTED_VERSION"
  | "WECHAT_THEME_IN_USE";

export class WechatThemeError extends Error {
  readonly code: WechatThemeErrorCode;

  constructor(code: WechatThemeErrorCode, message: string) {
    super(message);
    this.name = "WechatThemeError";
    this.code = code;
  }
}

export interface WechatThemeTokens {
  accent: string;
  page: string;
  text: string;
  heading: string;
  muted: string;
  border: string;
  codeBg: string;
  codeText: string;
  sizeBodyPx: number;
  align: "left" | "justify";
}

export type WechatThemeOverlayPatch = Partial<WechatThemeTokens>;
export type WechatThemeStyleTag = "h1" | "h2" | "h3" | "p" | "blockquote" | "ul" | "ol" | "pre" | "code" | "table" | "th" | "td" | "hr" | "a";

export interface WechatThemeOverlayInput {
  schemaVersion: "0.1";
  name: string;
  baseThemeId: OfficialWechatThemeId;
  tokens: WechatThemeOverlayPatch;
}

export interface WechatThemeOverlayFile {
  schemaVersion: "0.1";
  name: string;
  baseThemeId: OfficialWechatThemeId;
  tokens: WechatThemeTokens;
}

export interface WechatThemeListItem {
  id: string;
  name: string;
  baseThemeId: OfficialWechatThemeId;
  source: "official" | "workspace" | "global";
  slug?: string;
  shortHash?: string;
}

export interface ResolvedWechatTheme {
  id: string;
  baseThemeId: OfficialWechatThemeId;
  tokens: WechatThemeTokens;
  definition: WechatThemeDefinition;
  source: "official" | "workspace" | "global";
  name: string;
}

export interface WechatThemeDefinition {
  id: string;
  baseThemeId: OfficialWechatThemeId;
  tokens: Readonly<WechatThemeTokens>;
  wrapperStyle: string;
  styles: Readonly<Record<WechatThemeStyleTag, string>>;
}

export interface WechatThemeRecipe {
  wrapperStyle: string;
  styles: Readonly<Record<WechatThemeStyleTag, string>>;
}

export const WECHAT_THEME_OPTIONS = Object.freeze([
  { id: "wechat-native-enhanced", name: "微信原生增强", description: "克制的微信绿与高兼容正文样式", accent: "#2f8f63" },
  { id: "minimal-ink", name: "极简墨白", description: "黑白灰层级与留白优先", accent: "#202124" },
  { id: "deep-blue-tech", name: "深蓝科技", description: "深蓝标题与冷色信息层级", accent: "#2854a1" },
] as const);

const mobileSafe = {
  wrapper: "word-break:break-word;overflow-wrap:anywhere;",
  text: "overflow-wrap:anywhere;",
  list: "overflow-wrap:anywhere;",
  pre: "box-sizing:border-box;max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;",
  table: "display:table;width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;",
  cell: "overflow-wrap:anywhere;word-break:break-word;",
} as const;

const TOKEN_KEYS = ["accent", "page", "text", "heading", "muted", "border", "codeBg", "codeText", "sizeBodyPx", "align"] as const;

export const OFFICIAL_THEME_TOKENS: Readonly<Record<OfficialWechatThemeId, Readonly<WechatThemeTokens>>> = Object.freeze({
  "wechat-native-enhanced": Object.freeze({ accent: "#2f8f63", page: "#fefefe", text: "#2b2f2c", heading: "#163c2b", muted: "#526158", border: "#cfd9d3", codeBg: "#f1f4f2", codeText: "#27352e", sizeBodyPx: 16, align: "left" }),
  "minimal-ink": Object.freeze({ accent: "#202124", page: "#fefefe", text: "#292929", heading: "#111111", muted: "#555555", border: "#c9cac7", codeBg: "#f7f7f6", codeText: "#292929", sizeBodyPx: 16, align: "left" }),
  "deep-blue-tech": Object.freeze({ accent: "#2854a1", page: "#fefefe", text: "#263445", heading: "#173665", muted: "#516477", border: "#c7d7e7", codeBg: "#f3f7fb", codeText: "#22364d", sizeBodyPx: 16, align: "left" }),
});

export function normalizeOfficialWechatThemeId(id: string): OfficialWechatThemeId | null {
  if (id === "wechat-green") return "wechat-native-enhanced";
  return OFFICIAL_WECHAT_THEME_IDS.includes(id as OfficialWechatThemeId) ? id as OfficialWechatThemeId : null;
}

function normalizeColor(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new WechatThemeError("WECHAT_THEME_INVALID_TOKEN", `主题颜色 ${key} 必须是 #rrggbb。`);
  }
  const normalized = value.toLowerCase();
  return normalized === "#ffffff" ? "#fefefe" : normalized;
}

export function normalizeWechatThemeTokens(baseThemeId: OfficialWechatThemeId, patch: WechatThemeOverlayPatch = {}): WechatThemeTokens {
  const defaults = OFFICIAL_THEME_TOKENS[baseThemeId];
  if (!defaults) throw new WechatThemeError("WECHAT_THEME_UNKNOWN", `未知公众号主题：${baseThemeId}`);
  for (const key of Object.keys(patch)) {
    if (!(TOKEN_KEYS as readonly string[]).includes(key)) throw new WechatThemeError("WECHAT_THEME_INVALID_TOKEN", `不支持的主题字段：${key}`);
  }
  const merged = { ...defaults, ...patch } as WechatThemeTokens;
  const tokens = {
    accent: normalizeColor(merged.accent, "accent"),
    page: normalizeColor(merged.page, "page"),
    text: normalizeColor(merged.text, "text"),
    heading: normalizeColor(merged.heading, "heading"),
    muted: normalizeColor(merged.muted, "muted"),
    border: normalizeColor(merged.border, "border"),
    codeBg: normalizeColor(merged.codeBg, "codeBg"),
    codeText: normalizeColor(merged.codeText, "codeText"),
    sizeBodyPx: merged.sizeBodyPx,
    align: merged.align,
  } satisfies WechatThemeTokens;
  if (!Number.isInteger(tokens.sizeBodyPx) || tokens.sizeBodyPx < 12 || tokens.sizeBodyPx > 22) {
    throw new WechatThemeError("WECHAT_THEME_INVALID_TOKEN", "主题正文大小必须是 12–22 的整数。");
  }
  if (tokens.align !== "left" && tokens.align !== "justify") {
    throw new WechatThemeError("WECHAT_THEME_INVALID_TOKEN", "主题对齐方式只能是 left 或 justify。");
  }
  return Object.freeze(tokens);
}

function colorVariant(color: string, redOffset: number, greenOffset: number, blueOffset: number): string {
  const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((value) => Number.parseInt(value, 16));
  return `#${channels.map((value, index) => Math.max(0, Math.min(255, value + [redOffset, greenOffset, blueOffset][index]!)).toString(16).padStart(2, "0")).join("")}`;
}

function optionalPageStyle(baseThemeId: OfficialWechatThemeId, tokens: WechatThemeTokens): string {
  return tokens.page === OFFICIAL_THEME_TOKENS[baseThemeId].page ? "" : `background:${tokens.page};`;
}

function optionalAlignStyle(tokens: WechatThemeTokens): string {
  return tokens.align === "left" ? "" : "text-align:justify;";
}

function officialShorthand(color: string, officialColor: string, shorthand: string): string {
  return color === officialColor ? shorthand : color;
}

function recipe(values: { wrapperPadding: string; wrapperExtra: string; h1: string; h2: string; h3: string; p: string; quote: string; ul: string; ol: string; pre: string; code: string; table: string; th: string; td: string; hr: string; link: string }): WechatThemeRecipe {
  const styles: Record<WechatThemeStyleTag, string> = {
    h1: values.h1,
    h2: values.h2,
    h3: values.h3,
    p: values.p,
    blockquote: values.quote,
    ul: values.ul,
    ol: values.ol,
    pre: values.pre,
    code: values.code,
    table: values.table,
    th: values.th,
    td: values.td,
    hr: values.hr,
    a: values.link,
  };
  return {
    wrapperStyle: `box-sizing:border-box;max-width:677px;margin:0 auto;padding:${values.wrapperPadding};${values.wrapperExtra}${mobileSafe.wrapper}`,
    styles: Object.freeze(styles),
  };
}

export function buildWechatNativeEnhancedRecipe(tokens: WechatThemeTokens): WechatThemeRecipe {
  return recipe({
    wrapperPadding: "8px 4px",
    wrapperExtra: optionalPageStyle("wechat-native-enhanced", tokens),
    h1: `margin:1.6em 0 .8em;padding-bottom:.35em;border-bottom:2px solid ${tokens.accent};color:${tokens.heading};font-size:1.7em;line-height:1.35;font-weight:700;`,
    h2: `margin:1.5em 0 .7em;padding-left:.55em;border-left:4px solid ${tokens.accent};color:${colorVariant(tokens.heading, 8, 26, 18)};font-size:1.4em;line-height:1.4;font-weight:700;`,
    h3: `margin:1.35em 0 .65em;color:${colorVariant(tokens.heading, 14, 31, 24)};font-size:1.15em;line-height:1.45;font-weight:700;`,
    p: `margin:.85em 0;color:${tokens.text};font-size:${tokens.sizeBodyPx}px;line-height:1.8;letter-spacing:.02em;${optionalAlignStyle(tokens)}${mobileSafe.text}`,
    quote: `margin:1em 0;padding:.8em 1em;border-left:4px solid ${colorVariant(tokens.accent, 74, 30, 46)};background:${colorVariant(tokens.codeBg, 2, 4, 3)};color:${tokens.muted};${mobileSafe.text}`,
    ul: `margin:.8em 0;padding-left:1.5em;color:${tokens.text};line-height:1.8;${mobileSafe.list}`,
    ol: `margin:.8em 0;padding-left:1.6em;color:${tokens.text};line-height:1.8;${mobileSafe.list}`,
    pre: `margin:1em 0;padding:14px 16px;border-radius:6px;background:${tokens.codeBg};color:${tokens.codeText};font-size:14px;line-height:1.65;${mobileSafe.pre}`,
    code: `padding:.1em .3em;border-radius:3px;background:${colorVariant(tokens.codeBg, -3, -2, -3)};color:${colorVariant(tokens.codeText, 142, 21, 12)};font-family:Consolas,monospace;${mobileSafe.text}`,
    table: `margin:1em 0;font-size:14px;${mobileSafe.table}`,
    th: `padding:7px 9px;border:1px solid ${colorVariant(tokens.border, -22, -16, -19)};background:${colorVariant(tokens.codeBg, -7, -1, -4)};color:${colorVariant(tokens.heading, 11, 15, 12)};font-weight:700;${mobileSafe.cell}`,
    td: `padding:7px 9px;border:1px solid ${colorVariant(tokens.border, -4, -3, -3)};color:${tokens.text};${mobileSafe.cell}`,
    hr: `margin:1.5em auto;border:0;border-top:1px solid ${tokens.border};`,
    link: `color:${colorVariant(tokens.accent, -12, -21, -17)};text-decoration:none;${mobileSafe.text}`,
  });
}

export function buildMinimalInkRecipe(tokens: WechatThemeTokens): WechatThemeRecipe {
  return recipe({
    wrapperPadding: "10px 6px",
    wrapperExtra: optionalPageStyle("minimal-ink", tokens),
    h1: `margin:1.75em 0 .9em;padding-bottom:.42em;border-bottom:1px solid ${tokens.accent};color:${officialShorthand(tokens.heading, OFFICIAL_THEME_TOKENS["minimal-ink"].heading, "#111")};font-size:1.68em;line-height:1.35;font-weight:700;letter-spacing:.02em;`,
    h2: `margin:1.6em 0 .72em;color:${colorVariant(tokens.heading, 6, 6, 6)};font-size:1.38em;line-height:1.45;font-weight:700;letter-spacing:.04em;`,
    h3: `margin:1.4em 0 .65em;color:${colorVariant(tokens.heading, 19, 19, 19)};font-size:1.14em;line-height:1.5;font-weight:700;`,
    p: `margin:.92em 0;color:${tokens.text};font-size:${tokens.sizeBodyPx}px;line-height:1.9;letter-spacing:.035em;${optionalAlignStyle(tokens)}${mobileSafe.text}`,
    quote: `margin:1.1em 0;padding:.85em 1em;border-left:3px solid ${colorVariant(tokens.accent, 28, 31, 31)};background:${tokens.codeBg};color:${officialShorthand(tokens.muted, OFFICIAL_THEME_TOKENS["minimal-ink"].muted, "#555")};${mobileSafe.text}`,
    ul: `margin:.9em 0;padding-left:1.55em;color:${tokens.text};line-height:1.9;${mobileSafe.list}`,
    ol: `margin:.9em 0;padding-left:1.65em;color:${tokens.text};line-height:1.9;${mobileSafe.list}`,
    pre: `margin:1.1em 0;padding:15px 17px;border:1px solid ${colorVariant(tokens.border, 23, 22, 23)};border-radius:2px;background:${tokens.codeBg};color:${tokens.codeText};font-size:14px;line-height:1.7;${mobileSafe.pre}`,
    code: `padding:.1em .3em;border-radius:2px;background:${colorVariant(tokens.codeBg, -6, -6, -7)};color:${colorVariant(tokens.codeText, 114, 20, 11)};font-family:Consolas,monospace;${mobileSafe.text}`,
    table: `margin:1.1em 0;font-size:14px;${mobileSafe.table}`,
    th: `padding:8px 9px;border:1px solid ${colorVariant(tokens.border, -10, -10, -10)};background:${colorVariant(tokens.codeBg, -7, -7, -8)};color:${colorVariant(tokens.heading, 15, 16, 19)};font-weight:700;${mobileSafe.cell}`,
    td: `padding:8px 9px;border:1px solid ${colorVariant(tokens.border, 8, 8, 8)};color:${tokens.text};${mobileSafe.cell}`,
    hr: `margin:1.7em auto;border:0;border-top:1px solid ${tokens.border};`,
    link: `color:${colorVariant(tokens.accent, 16, 19, 23)};text-decoration:underline;text-decoration-color:${colorVariant(tokens.muted, 78, 80, 83)};${mobileSafe.text}`,
  });
}

export function buildDeepBlueTechRecipe(tokens: WechatThemeTokens): WechatThemeRecipe {
  return recipe({
    wrapperPadding: "8px 5px",
    wrapperExtra: optionalPageStyle("deep-blue-tech", tokens),
    h1: `margin:1.6em 0 .82em;padding:.15em 0 .42em;border-bottom:2px solid ${tokens.accent};color:${tokens.heading};font-size:1.7em;line-height:1.35;font-weight:750;`,
    h2: `margin:1.5em 0 .72em;padding:.3em .65em;border-left:4px solid ${colorVariant(tokens.accent, 12, 36, 38)};background:${colorVariant(tokens.codeBg, -2, -1, 1)};color:${colorVariant(tokens.heading, 10, 22, 32)};font-size:1.4em;line-height:1.4;font-weight:700;`,
    h3: `margin:1.35em 0 .65em;color:${colorVariant(tokens.heading, 17, 37, 49)};font-size:1.15em;line-height:1.45;font-weight:700;`,
    p: `margin:.86em 0;color:${tokens.text};font-size:${tokens.sizeBodyPx}px;line-height:1.82;letter-spacing:.02em;${optionalAlignStyle(tokens)}${mobileSafe.text}`,
    quote: `margin:1em 0;padding:.85em 1em;border-left:4px solid ${colorVariant(tokens.accent, 72, 83, 62)};background:${colorVariant(tokens.codeBg, -1, 0, 1)};color:${tokens.muted};${mobileSafe.text}`,
    ul: `margin:.82em 0;padding-left:1.55em;color:${tokens.text};line-height:1.82;${mobileSafe.list}`,
    ol: `margin:.82em 0;padding-left:1.65em;color:${tokens.text};line-height:1.82;${mobileSafe.list}`,
    pre: `margin:1em 0;padding:14px 16px;border:1px solid ${colorVariant(tokens.border, 15, 11, 8)};border-radius:6px;background:${tokens.codeBg};color:${tokens.codeText};font-size:14px;line-height:1.68;${mobileSafe.pre}`,
    code: `padding:.1em .3em;border-radius:3px;background:${colorVariant(tokens.codeBg, -6, -4, -1)};color:${colorVariant(tokens.codeText, 142, 14, 8)};font-family:Consolas,monospace;${mobileSafe.text}`,
    table: `margin:1em 0;font-size:14px;${mobileSafe.table}`,
    th: `padding:7px 9px;border:1px solid ${colorVariant(tokens.border, -26, -18, -10)};background:${colorVariant(tokens.codeBg, -9, -5, -1)};color:${colorVariant(tokens.heading, 10, 22, 19)};font-weight:700;${mobileSafe.cell}`,
    td: `padding:7px 9px;border:1px solid ${colorVariant(tokens.border, 3, 1, -2)};color:${tokens.text};${mobileSafe.cell}`,
    hr: `margin:1.5em auto;border:0;border-top:1px solid ${tokens.border};`,
    link: `color:${colorVariant(tokens.accent, 0, 19, 17)};text-decoration:none;${mobileSafe.text}`,
  });
}

export function buildWechatThemeDefinition(baseThemeId: OfficialWechatThemeId, tokens: WechatThemeTokens): WechatThemeDefinition {
  const themeRecipe = baseThemeId === "wechat-native-enhanced"
    ? buildWechatNativeEnhancedRecipe(tokens)
    : baseThemeId === "minimal-ink"
      ? buildMinimalInkRecipe(tokens)
      : buildDeepBlueTechRecipe(tokens);
  return Object.freeze({ id: baseThemeId, baseThemeId, tokens: Object.freeze({ ...tokens }), ...themeRecipe });
}

export function resolveOfficialWechatTheme(id: string): WechatThemeDefinition {
  const normalized = normalizeOfficialWechatThemeId(id);
  if (!normalized) throw new WechatThemeError("WECHAT_THEME_UNKNOWN", `未知公众号主题：${id}`);
  return buildWechatThemeDefinition(normalized, normalizeWechatThemeTokens(normalized, {}));
}

/** Compatibility name for existing official preview/output callers. Unknown IDs never fall back. */
export function resolveWechatTheme(id: string): WechatThemeDefinition {
  return resolveOfficialWechatTheme(id);
}

function withThemeStyle(tag: WechatThemeStyleTag, attributes: string, style: string): string {
  if (/\sstyle\s*=/i.test(attributes)) {
    return `<${tag}${attributes.replace(/\sstyle\s*=\s*(["'])(.*?)\1/i, (_match, quote: string, current: string) => ` style=${quote}${style}${current}${quote}`)}>`;
  }
  return `<${tag}${attributes} style="${style}">`;
}

export function applyWechatThemeToFragment(fragment: string, definition: WechatThemeDefinition): string;
export function applyWechatThemeToFragment(fragment: string, definition: WechatThemeDefinition): string {
  const styles = definition.styles;
  return fragment
    .replace(/<h1(\s[^>]*)?>/gi, (_match, attributes = "") => withThemeStyle("h1", attributes, styles.h1))
    .replace(/<h2(\s[^>]*)?>/gi, (_match, attributes = "") => withThemeStyle("h2", attributes, styles.h2))
    .replace(/<h([3-6])(\s[^>]*)?>/gi, (_match, level: string, attributes = "") => withThemeStyle("h3", attributes, styles.h3).replace("<h3", `<h${level}`))
    .replace(/<(p|blockquote|ul|ol|pre|code|table|th|td|hr|a)(\s[^>]*)?>/gi, (_match, rawTag: string, attributes = "") => {
      const tag = rawTag.toLowerCase() as WechatThemeStyleTag;
      return withThemeStyle(tag, attributes, styles[tag]);
    });
}

export function applyOfficialWechatThemeToFragment(fragment: string, themeId: OfficialWechatThemeId | LegacyWechatThemeAlias): string {
  return applyWechatThemeToFragment(fragment, resolveOfficialWechatTheme(themeId));
}

export function canonicalWechatThemeIdentity(baseThemeId: OfficialWechatThemeId, tokens: WechatThemeTokens): {
  schemaVersion: "0.1";
  baseThemeId: OfficialWechatThemeId;
  tokens: WechatThemeTokens;
} {
  return {
    schemaVersion: "0.1",
    baseThemeId,
    tokens: {
      accent: tokens.accent,
      page: tokens.page,
      text: tokens.text,
      heading: tokens.heading,
      muted: tokens.muted,
      border: tokens.border,
      codeBg: tokens.codeBg,
      codeText: tokens.codeText,
      sizeBodyPx: tokens.sizeBodyPx,
      align: tokens.align,
    },
  };
}

export function canonicalWechatThemeJson(baseThemeId: OfficialWechatThemeId, tokens: WechatThemeTokens): string {
  return JSON.stringify(canonicalWechatThemeIdentity(baseThemeId, tokens));
}

export function validateWechatThemeName(name: unknown): string {
  if (typeof name !== "string") throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "主题名称必须是文本。");
  const trimmed = name.trim();
  if ([...trimmed].length < 1 || [...trimmed].length > 64) throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "主题名称长度必须为 1–64 个 Unicode 字符。");
  return trimmed;
}

export const WECHAT_THEME_TOKEN_KEYS = TOKEN_KEYS;
