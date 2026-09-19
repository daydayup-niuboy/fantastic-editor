import { wechatHeadingDecorationGlyph, type WechatThemeDefinition } from "@fantastic-editor/shared";

const LIVE_BLOCK_PROPERTIES = new Set([
  "background", "background-color", "border-bottom", "border-left", "color", "font-size", "font-weight",
  "letter-spacing", "line-height", "text-align", "text-decoration", "text-decoration-color",
]);
const LIVE_WRAPPER_PROPERTIES = new Set(["background", "background-color", "color"]);

function projectDeclarations(style: string, allowed: ReadonlySet<string>): string {
  return style.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 1) return [];
    const property = declaration.slice(0, separator).trim().toLowerCase();
    return allowed.has(property) ? [`${declaration.trim()};`] : [];
  }).join("");
}

export function buildCodeMirrorWechatThemeProjectionCss(definition: WechatThemeDefinition): string {
  const scope = ".editor-host.wechat-theme-active .cm-editor.cm-live-preview";
  const glyph = wechatHeadingDecorationGlyph(definition.tokens.headingDecoration);
  const decoration = glyph
    ? `${scope} .cm-live-heading-2::before,${scope} .cm-live-heading-3::before{content:"${glyph}";display:inline-block;margin-right:.45em;color:${definition.tokens.accent};font-weight:700;}`
    : "";
  return [
    `${scope} .cm-content{${projectDeclarations(definition.wrapperStyle, LIVE_WRAPPER_PROPERTIES)}}`,
    `${scope} .cm-live-heading-1{${projectDeclarations(definition.styles.h1, LIVE_BLOCK_PROPERTIES)}}`,
    `${scope} .cm-live-heading-2{${projectDeclarations(definition.styles.h2, LIVE_BLOCK_PROPERTIES)}}`,
    `${scope} .cm-live-heading-3{${projectDeclarations(definition.styles.h3, LIVE_BLOCK_PROPERTIES)}}`,
    `${scope} .cm-live-paragraph-line{${projectDeclarations(definition.styles.p, LIVE_BLOCK_PROPERTIES)}}`,
    `${scope} .cm-live-quote-line{${projectDeclarations(definition.styles.blockquote, LIVE_BLOCK_PROPERTIES)}}`,
    `${scope} .cm-live-link{${projectDeclarations(definition.styles.a, LIVE_BLOCK_PROPERTIES)}}`,
    decoration,
  ].join("\n");
}
