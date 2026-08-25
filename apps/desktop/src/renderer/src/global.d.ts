import type { FantasticEditorApi } from "@fantastic-editor/shared";

declare global {
  interface Window { fantasticEditor: FantasticEditorApi; }
}
export {};