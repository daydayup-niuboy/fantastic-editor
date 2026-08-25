import type { SvgProcessRequest, SvgProcessResponse } from "./image-process-protocol.js";
import { transformSvgToPng } from "./svg-transform.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Image utility process requires an Electron parentPort.");

parentPort.on("message", (event) => {
  const request = event.data as Partial<SvgProcessRequest> | undefined;
  if (
    request?.type !== "transform-svg"
    || typeof request.taskId !== "string"
    || !/^[a-f\d-]{36}$/i.test(request.taskId)
    || !(request.svgBytes instanceof Uint8Array)
  ) return;
  const result = transformSvgToPng(request.svgBytes);
  const response: SvgProcessResponse = result.status === "completed"
    ? {
      type: "svg-transformed",
      taskId: request.taskId,
      png: result.png,
      width: result.width,
      height: result.height,
    }
    : {
      type: "svg-transform-failed",
      taskId: request.taskId,
      code: result.code,
      message: result.message,
    };
  parentPort.postMessage(response);
});