import { generateDocx } from "./docx-adapter.js";
import { generateOfflineHtml } from "./offline-html-adapter.js";
import { generateWechatHtml } from "./wechat-adapter.js";
import type { OutputProcessRequest, OutputProcessResponse } from "./output-process-protocol.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Output utility process requires an Electron parentPort.");

parentPort.on("message", (event) => {
  const request = event.data as Partial<OutputProcessRequest> | undefined;
  if (
    (request?.type !== "generate-offline-html" && request?.type !== "generate-docx" && request?.type !== "generate-wechat-html")
    || typeof request.taskId !== "string"
    || !/^[a-f\d-]{36}$/i.test(request.taskId)
    || !request.context
    || !Array.isArray(request.assets)
    || !Array.isArray(request.mermaidAssets)
    || ((request.type === "generate-docx" || request.type === "generate-wechat-html") && !Array.isArray(request.formulaAssets))
  ) return;
  void (async () => {
    let response: OutputProcessResponse;
    try {
      response = request.type === "generate-docx"
        ? {
            type: "docx-generated",
            taskId: request.taskId!,
            generation: await generateDocx(request.context!, request.assets!, request.formulaAssets!, request.mermaidAssets!),
          }
        : request.type === "generate-wechat-html"
          ? {
              type: "wechat-html-generated",
              taskId: request.taskId!,
              generation: generateWechatHtml(request.context!, request.assets!, request.formulaAssets!, request.mermaidAssets!),
            }
          : {
              type: "offline-html-generated",
              taskId: request.taskId!,
              generation: generateOfflineHtml(request.context!, request.assets!, request.mermaidAssets!),
            };
    } catch {
      response = {
        type: "output-process-failed",
        taskId: request.taskId!,
        code: "OUTPUT_PROCESS_GENERATION_FAILED",
        message: "Node 导出进程生成文件失败。",
      };
    }
    parentPort.postMessage(response);
  })();
});
