import type { OutputContext } from "@fantastic-editor/shared";
import type { DocxGeneration, OutputFormulaAsset } from "./docx-adapter.js";
import type { OfflineHtmlGeneration, OutputResourceAsset } from "./offline-html-adapter.js";
import type { WechatGeneration } from "./wechat-adapter.js";

export type OutputProcessRequest =
  | {
      type: "generate-offline-html";
      taskId: string;
      context: OutputContext;
      assets: OutputResourceAsset[];
    }
  | {
      type: "generate-docx";
      taskId: string;
      context: OutputContext;
      assets: OutputResourceAsset[];
      formulaAssets: OutputFormulaAsset[];
    }
  | {
      type: "generate-wechat-html";
      taskId: string;
      context: OutputContext;
      assets: OutputResourceAsset[];
      formulaAssets: OutputFormulaAsset[];
    };

export type OutputProcessResponse =
  | { type: "offline-html-generated"; taskId: string; generation: OfflineHtmlGeneration }
  | { type: "docx-generated"; taskId: string; generation: DocxGeneration }
  | { type: "wechat-html-generated"; taskId: string; generation: WechatGeneration }
  | { type: "output-process-failed"; taskId: string; code: string; message: string };