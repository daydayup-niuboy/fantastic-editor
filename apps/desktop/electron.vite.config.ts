import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "image-process": resolve("src/main/image-process.ts"),
          "output-process": resolve("src/main/output-process.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          formula: resolve("src/renderer/formula.html"),
          mermaid: resolve("src/renderer/mermaid.html"),
        },
      },
    },
    resolve: { alias: { "@renderer": resolve("src/renderer/src") } },
    plugins: [react()],
  },
});
