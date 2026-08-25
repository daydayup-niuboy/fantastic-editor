export interface SvgProcessRequest {
  type: "transform-svg";
  taskId: string;
  svgBytes: Uint8Array;
}

export type SvgProcessResponse =
  | {
    type: "svg-transformed";
    taskId: string;
    png: Uint8Array;
    width: number;
    height: number;
  }
  | {
    type: "svg-transform-failed";
    taskId: string;
    code: string;
    message: string;
  };