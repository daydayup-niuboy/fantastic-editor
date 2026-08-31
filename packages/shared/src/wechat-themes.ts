export const WECHAT_THEME_OPTIONS = Object.freeze([
  { id: "wechat-native-enhanced", name: "微信原生增强", description: "克制的微信绿与高兼容正文样式", accent: "#2f8f63" },
  { id: "minimal-ink", name: "极简墨白", description: "黑白灰层级与留白优先", accent: "#202124" },
  { id: "deep-blue-tech", name: "深蓝科技", description: "深蓝标题与冷色信息层级", accent: "#2854a1" },
] as const);

export type WechatThemeId = (typeof WECHAT_THEME_OPTIONS)[number]["id"];

export interface WechatThemeDefinition {
  id: WechatThemeId;
  wrapperStyle: string;
  styles: Readonly<Record<"h1" | "h2" | "h3" | "p" | "blockquote" | "ul" | "ol" | "pre" | "code" | "table" | "th" | "td" | "hr" | "a", string>>;
}

const mobileSafe = {
  wrapper: "word-break:break-word;overflow-wrap:anywhere;",
  text: "overflow-wrap:anywhere;",
  list: "overflow-wrap:anywhere;",
  pre: "box-sizing:border-box;max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;",
  table: "display:table;width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;",
  cell: "overflow-wrap:anywhere;word-break:break-word;",
} as const;

const THEMES: Readonly<Record<WechatThemeId, WechatThemeDefinition>> = Object.freeze({
  "wechat-native-enhanced": {
    id: "wechat-native-enhanced",
    wrapperStyle: `box-sizing:border-box;max-width:677px;margin:0 auto;padding:8px 4px;${mobileSafe.wrapper}`,
    styles: {
      h1: "margin:1.6em 0 .8em;padding-bottom:.35em;border-bottom:2px solid #2f8f63;color:#163c2b;font-size:1.7em;line-height:1.35;font-weight:700;",
      h2: "margin:1.5em 0 .7em;padding-left:.55em;border-left:4px solid #2f8f63;color:#1e563d;font-size:1.4em;line-height:1.4;font-weight:700;",
      h3: "margin:1.35em 0 .65em;color:#245b43;font-size:1.15em;line-height:1.45;font-weight:700;",
      p: `margin:.85em 0;color:#2b2f2c;font-size:16px;line-height:1.8;letter-spacing:.02em;${mobileSafe.text}`,
      blockquote: `margin:1em 0;padding:.8em 1em;border-left:4px solid #79ad91;background:#f3f8f5;color:#526158;${mobileSafe.text}`,
      ul: `margin:.8em 0;padding-left:1.5em;color:#2b2f2c;line-height:1.8;${mobileSafe.list}`,
      ol: `margin:.8em 0;padding-left:1.6em;color:#2b2f2c;line-height:1.8;${mobileSafe.list}`,
      pre: `margin:1em 0;padding:14px 16px;border-radius:6px;background:#f1f4f2;color:#27352e;font-size:14px;line-height:1.65;${mobileSafe.pre}`,
      code: `padding:.1em .3em;border-radius:3px;background:#eef2ef;color:#b54a3a;font-family:Consolas,monospace;${mobileSafe.text}`,
      table: `margin:1em 0;font-size:14px;${mobileSafe.table}`,
      th: `padding:7px 9px;border:1px solid #b9c9c0;background:#eaf3ee;color:#214b37;font-weight:700;${mobileSafe.cell}`,
      td: `padding:7px 9px;border:1px solid #cbd6d0;color:#2b2f2c;${mobileSafe.cell}`,
      hr: "margin:1.5em auto;border:0;border-top:1px solid #cfd9d3;",
      a: `color:#237a52;text-decoration:none;${mobileSafe.text}`,
    },
  },
  "minimal-ink": {
    id: "minimal-ink",
    wrapperStyle: `box-sizing:border-box;max-width:677px;margin:0 auto;padding:10px 6px;${mobileSafe.wrapper}`,
    styles: {
      h1: "margin:1.75em 0 .9em;padding-bottom:.42em;border-bottom:1px solid #202124;color:#111;font-size:1.68em;line-height:1.35;font-weight:700;letter-spacing:.02em;",
      h2: "margin:1.6em 0 .72em;color:#171717;font-size:1.38em;line-height:1.45;font-weight:700;letter-spacing:.04em;",
      h3: "margin:1.4em 0 .65em;color:#242424;font-size:1.14em;line-height:1.5;font-weight:700;",
      p: `margin:.92em 0;color:#292929;font-size:16px;line-height:1.9;letter-spacing:.035em;${mobileSafe.text}`,
      blockquote: `margin:1.1em 0;padding:.85em 1em;border-left:3px solid #3c4043;background:#f7f7f6;color:#555;${mobileSafe.text}`,
      ul: `margin:.9em 0;padding-left:1.55em;color:#292929;line-height:1.9;${mobileSafe.list}`,
      ol: `margin:.9em 0;padding-left:1.65em;color:#292929;line-height:1.9;${mobileSafe.list}`,
      pre: `margin:1.1em 0;padding:15px 17px;border:1px solid #e0e0de;border-radius:2px;background:#f7f7f6;color:#292929;font-size:14px;line-height:1.7;${mobileSafe.pre}`,
      code: `padding:.1em .3em;border-radius:2px;background:#f1f1ef;color:#9b3d34;font-family:Consolas,monospace;${mobileSafe.text}`,
      table: `margin:1.1em 0;font-size:14px;${mobileSafe.table}`,
      th: `padding:8px 9px;border:1px solid #bfc0bd;background:#f0f0ee;color:#202124;font-weight:700;${mobileSafe.cell}`,
      td: `padding:8px 9px;border:1px solid #d1d2cf;color:#292929;${mobileSafe.cell}`,
      hr: "margin:1.7em auto;border:0;border-top:1px solid #c9cac7;",
      a: `color:#30343b;text-decoration:underline;text-decoration-color:#a3a5a8;${mobileSafe.text}`,
    },
  },
  "deep-blue-tech": {
    id: "deep-blue-tech",
    wrapperStyle: `box-sizing:border-box;max-width:677px;margin:0 auto;padding:8px 5px;${mobileSafe.wrapper}`,
    styles: {
      h1: "margin:1.6em 0 .82em;padding:.15em 0 .42em;border-bottom:2px solid #2854a1;color:#173665;font-size:1.7em;line-height:1.35;font-weight:750;",
      h2: "margin:1.5em 0 .72em;padding:.3em .65em;border-left:4px solid #3478c7;background:#f1f6fc;color:#214c85;font-size:1.4em;line-height:1.4;font-weight:700;",
      h3: "margin:1.35em 0 .65em;color:#285b96;font-size:1.15em;line-height:1.45;font-weight:700;",
      p: `margin:.86em 0;color:#263445;font-size:16px;line-height:1.82;letter-spacing:.02em;${mobileSafe.text}`,
      blockquote: `margin:1em 0;padding:.85em 1em;border-left:4px solid #70a7df;background:#f2f7fc;color:#516477;${mobileSafe.text}`,
      ul: `margin:.82em 0;padding-left:1.55em;color:#263445;line-height:1.82;${mobileSafe.list}`,
      ol: `margin:.82em 0;padding-left:1.65em;color:#263445;line-height:1.82;${mobileSafe.list}`,
      pre: `margin:1em 0;padding:14px 16px;border:1px solid #d6e2ef;border-radius:6px;background:#f3f7fb;color:#22364d;font-size:14px;line-height:1.68;${mobileSafe.pre}`,
      code: `padding:.1em .3em;border-radius:3px;background:#edf3fa;color:#b04455;font-family:Consolas,monospace;${mobileSafe.text}`,
      table: `margin:1em 0;font-size:14px;${mobileSafe.table}`,
      th: `padding:7px 9px;border:1px solid #adc5dd;background:#eaf2fa;color:#214c78;font-weight:700;${mobileSafe.cell}`,
      td: `padding:7px 9px;border:1px solid #cad8e5;color:#263445;${mobileSafe.cell}`,
      hr: "margin:1.5em auto;border:0;border-top:1px solid #c7d7e7;",
      a: `color:#2867b2;text-decoration:none;${mobileSafe.text}`,
    },
  },
});

export function resolveWechatTheme(id: string): WechatThemeDefinition {
  if (id === "wechat-green") return THEMES["wechat-native-enhanced"];
  return THEMES[id as WechatThemeId] ?? THEMES["wechat-native-enhanced"];
}

function withThemeStyle(tag: keyof WechatThemeDefinition["styles"], attributes: string, style: string): string {
  if (/\sstyle\s*=/i.test(attributes)) {
    return `<${tag}${attributes.replace(/\sstyle\s*=\s*(["'])(.*?)\1/i, (_match, quote: string, current: string) => ` style=${quote}${style}${current}${quote}`)}>`;
  }
  return `<${tag}${attributes} style="${style}">`;
}

export function applyWechatThemeToFragment(fragment: string, themeId: string): string {
  const styles = resolveWechatTheme(themeId).styles;
  return fragment
    .replace(/<h1(\s[^>]*)?>/gi, (_match, attributes = "") => withThemeStyle("h1", attributes, styles.h1))
    .replace(/<h2(\s[^>]*)?>/gi, (_match, attributes = "") => withThemeStyle("h2", attributes, styles.h2))
    .replace(/<h([3-6])(\s[^>]*)?>/gi, (_match, level: string, attributes = "") => withThemeStyle("h3", attributes, styles.h3).replace("<h3", `<h${level}`))
    .replace(/<(p|blockquote|ul|ol|pre|code|table|th|td|hr|a)(\s[^>]*)?>/gi, (_match, rawTag: string, attributes = "") => {
      const tag = rawTag.toLowerCase() as keyof WechatThemeDefinition["styles"];
      return withThemeStyle(tag, attributes, styles[tag]);
    });
}
