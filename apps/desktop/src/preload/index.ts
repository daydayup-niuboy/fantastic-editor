import { contextBridge, ipcRenderer, webUtils } from "electron";
import { FANTASTIC_EDITOR_LIMITS, IPC_CHANNELS } from "../../../../packages/shared/src/index";
import type {
  ApproveOmissions,
  BeginOutputRequest,
  CancelOutputRequest,
  CopyWechatReplacementRequest,
  OpenWorkspaceFileRequest,
  FantasticEditorApi,
  FileSessionRequest,
  ImageImportSessionRequest,
  ImportDroppedImagesRequest,
  ParseCommitRequest,
  PersistRecoveryRequest,
  PreviewDerivedUpdate,
  ResolveRequest,
  SaveFileRequest,
} from "@fantastic-editor/shared";

const api: FantasticEditorApi = {
  openMarkdownFile: () => ipcRenderer.invoke(IPC_CHANNELS.openMarkdownFile),
  createUntitledFile: () => ipcRenderer.invoke(IPC_CHANNELS.createUntitledFile),
  openDroppedMarkdownFile: (file: unknown) => {
    try {
      const path = webUtils.getPathForFile(file as File);
      if (!path) return Promise.resolve({ status: "failed" as const, error: "无法读取拖入文件的系统路径。" });
      return ipcRenderer.invoke(IPC_CHANNELS.openDroppedMarkdownFile, path);
    } catch {
      return Promise.resolve({ status: "failed" as const, error: "拖入对象不是有效的本地文件。" });
    }
  },
  activateFileSession: (request: FileSessionRequest) => ipcRenderer.invoke(IPC_CHANNELS.activateFileSession, request),
  closeFileSession: (request: FileSessionRequest) => ipcRenderer.invoke(IPC_CHANNELS.closeFileSession, request),
  persistRecoverySession: (request: PersistRecoveryRequest) => ipcRenderer.invoke(IPC_CHANNELS.persistRecoverySession, request),
  restoreRecoverySession: () => ipcRenderer.invoke(IPC_CHANNELS.restoreRecoverySession),
  openWorkspaceFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openWorkspaceFolder),
  openWorkspaceFile: (request: OpenWorkspaceFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.openWorkspaceFile, request),
  saveCurrentFile: (request: SaveFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.saveCurrentFile, request),
  saveCurrentFileAs: (request: SaveFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.saveCurrentFileAs, request),
  selectAndImportImages: (request: ImageImportSessionRequest) => ipcRenderer.invoke(IPC_CHANNELS.selectAndImportImages, request),
  importDroppedImages: async (request: ImageImportSessionRequest, values: unknown[]) => {
    try {
      if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
        return { status: "failed" as const, error: "一次只能拖入 1 至 100 张图片。" };
      }
      const files: ImportDroppedImagesRequest["files"] = [];
      let totalBytes = 0;
      for (const value of values) {
        const file = value as File;
        if (!file || typeof file.name !== "string" || typeof file.size !== "number" || typeof file.arrayBuffer !== "function") {
          return { status: "failed" as const, error: "拖入对象不是有效的本地图片文件。" };
        }
        if (file.size <= 0 || file.size > FANTASTIC_EDITOR_LIMITS.maxSingleResourceBytes) {
          return { status: "failed" as const, error: `${file.name || "图片"} 为空或超过 50 MiB 安全上限。` };
        }
        totalBytes += file.size;
        if (totalBytes > FANTASTIC_EDITOR_LIMITS.maxUniqueResolutionBytes) {
          return { status: "failed" as const, error: "本次拖入图片总量超过 200 MiB 安全上限。" };
        }
        const buffer = await file.arrayBuffer();
        files.push({ displayName: file.name, declaredMimeType: file.type, bytes: new Uint8Array(buffer) });
      }
      return ipcRenderer.invoke(IPC_CHANNELS.importDroppedImages, { ...request, files } satisfies ImportDroppedImagesRequest);
    } catch (error) {
      return { status: "failed" as const, error: error instanceof Error ? error.message : "读取拖入图片失败。" };
    }
  },
  commitParse: (request: ParseCommitRequest) => ipcRenderer.invoke(IPC_CHANNELS.commitParse, request),
  resolveResources: (request: ResolveRequest) => ipcRenderer.invoke(IPC_CHANNELS.resolveResources, request),
  onPreviewDerivedUpdate: (listener: (update: PreviewDerivedUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: PreviewDerivedUpdate) => listener(update);
    ipcRenderer.on(IPC_CHANNELS.previewDerivedUpdate, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.previewDerivedUpdate, handler);
  },
  beginOutput: (request: BeginOutputRequest) => ipcRenderer.invoke(IPC_CHANNELS.beginOutput, request),
  approveOutputOmissions: (request: ApproveOmissions) => ipcRenderer.invoke(IPC_CHANNELS.approveOutputOmissions, request),
  cancelOutput: (request: CancelOutputRequest) => ipcRenderer.invoke(IPC_CHANNELS.cancelOutput, request),
  copyWechatReplacement: (request: CopyWechatReplacementRequest) => ipcRenderer.invoke(IPC_CHANNELS.copyWechatReplacement, request),
};

contextBridge.exposeInMainWorld("fantasticEditor", Object.freeze(api));




