import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

type FinishSmoke = (scenario: string, valid: boolean, diagnostics?: unknown) => Promise<void>;

export function installRendererSmokeTests(window: BrowserWindow, finishSmoke: FinishSmoke): boolean {
  if (process.env.FANTASTIC_EDITOR_AI_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const ready = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector("[data-testid=new-document]")?.click();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const editor = document.querySelector(".cm-content");
            if (editor) { editor.focus(); localStorage.setItem("fantastic-editor-ai-disclosure-accepted:codex-cli", "true"); return true; }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return false;
        })()`, true);
        if (!ready) throw new Error("AI smoke editor did not become ready.");
        await window.webContents.insertText("需要润色的正文");
        const translationSelection = await window.webContents.executeJavaScript(`(() => {
          const line = [...document.querySelectorAll(".cm-line")].find((item) => item.textContent?.includes("需要润色的正文"));
          const text = line?.firstChild;
          if (!(text instanceof Text)) return null;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min("需要润色的正文".length, text.length));
          const rect = range.getBoundingClientRect();
          return { fromX: rect.left + 1, toX: rect.right - 1, y: rect.top + rect.height / 2 };
        })()`, true) as { fromX: number; toX: number; y: number } | null;
        if (!translationSelection) throw new Error("AI smoke could not locate text for selection translation.");
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(translationSelection.fromX), y: Math.round(translationSelection.y) });
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(translationSelection.fromX), y: Math.round(translationSelection.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(translationSelection.fromX), y: Math.round(translationSelection.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(translationSelection.toX), y: Math.round(translationSelection.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(translationSelection.toX), y: Math.round(translationSelection.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        const triggerRect = await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const trigger = document.querySelector('.selection-translate-trigger');
            if (trigger) {
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const { x, y, width, height } = trigger.getBoundingClientRect();
              return { x, y, width, height };
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return null;
        })()`, true) as { x: number; y: number; width: number; height: number } | null;
        if (!triggerRect) throw new Error("Selection translation trigger did not appear.");
        let inkPixels = 0;
        for (let attempt = 0; attempt < 5 && inkPixels < 3; attempt += 1) {
          const triggerImage = await window.webContents.capturePage({ x: Math.floor(triggerRect.x), y: Math.floor(triggerRect.y), width: Math.ceil(triggerRect.width), height: Math.ceil(triggerRect.height) });
          const triggerPixels = triggerImage.toBitmap();
          for (let pixel = 0; pixel < triggerPixels.length; pixel += 4) {
            if (triggerPixels.subarray(pixel, pixel + 3).every((channel) => channel < 100)) inkPixels += 1;
          }
          if (inkPixels < 3) await new Promise((resolve) => setTimeout(resolve, 80));
        }
        const visibleGlyph = inkPixels >= 3;
        const selectionTranslation = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (test) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 40)); } return null; };
          const trigger = await waitFor(() => document.querySelector('.selection-translate-trigger'));
          if (!trigger) return { shown: false, scaledAsRequested: false, doesNotCoverSelection: false, translated: false };
          const rect = trigger.getBoundingClientRect();
          const selectedRect = document.getSelection()?.rangeCount ? document.getSelection().getRangeAt(0).getBoundingClientRect() : null;
          const doesNotCoverSelection = Boolean(selectedRect && (rect.bottom <= selectedRect.top || rect.top >= selectedRect.bottom || rect.right <= selectedRect.left || rect.left >= selectedRect.right));
          const icon = trigger.querySelector('.selection-translate-glyph');
          const iconRect = icon?.getBoundingClientRect();
          const scaledAsRequested = Math.abs(rect.width - 16) < 0.5 && Math.abs(rect.height - 16) < 0.5
            && Boolean(icon instanceof SVGSVGElement && iconRect && icon.querySelectorAll('path').length === 3 && getComputedStyle(icon).fill === 'rgb(32, 33, 36)' && Math.abs(iconRect.width - 13.728) < 0.3 && Math.abs(iconRect.height - 13.728) < 0.3);
          trigger.click();
          trigger.click();
          const result = await waitFor(() => {
            const text = document.querySelector('.selection-translate-result')?.textContent?.trim();
            return text === '处理结果' ? text : null;
          });
          const dialog = document.querySelector('.selection-translate-popover');
          const header = dialog?.querySelector('header');
          const dialogRect = dialog?.getBoundingClientRect();
          const headerRect = header?.getBoundingClientRect();
          const compact = Boolean(dialogRect && headerRect && dialogRect.width <= 432 && headerRect.height <= 58 && parseFloat(getComputedStyle(dialog.querySelector('.selection-translate-result')).fontSize) <= 13.5);
          return { shown: true, scaledAsRequested, doesNotCoverSelection, translated: result === '处理结果', compact,
            dragStart: headerRect ? { x: headerRect.left + 30, y: headerRect.top + headerRect.height / 2 } : null,
            before: dialogRect ? { left: dialogRect.left, top: dialogRect.top } : null };
        })()`, true) as { shown: boolean; scaledAsRequested: boolean; doesNotCoverSelection: boolean; translated: boolean; compact: boolean; dragStart: { x: number; y: number } | null; before: { left: number; top: number } | null };
        if (!selectionTranslation.shown || !selectionTranslation.scaledAsRequested || !selectionTranslation.doesNotCoverSelection || !selectionTranslation.translated || !selectionTranslation.compact || !selectionTranslation.dragStart || !selectionTranslation.before || !visibleGlyph) throw new Error(`Selection translation failed before opening AI settings: ${JSON.stringify({ ...selectionTranslation, visibleGlyph, inkPixels })}`);
        const { dragStart, before } = selectionTranslation;
        const deltaX = before.left > 80 ? -48 : 48;
        const deltaY = before.top > 80 ? -38 : 38;
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(dragStart.x), y: Math.round(dragStart.y) });
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(dragStart.x), y: Math.round(dragStart.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(dragStart.x + deltaX), y: Math.round(dragStart.y + deltaY) });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(dragStart.x + deltaX), y: Math.round(dragStart.y + deltaY), button: "left", clickCount: 1 });
        const popoverInteraction = await window.webContents.executeJavaScript(`(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const rect = document.querySelector('.selection-translate-popover')?.getBoundingClientRect();
          if (!rect) return { dragged: false, survivesScroll: false, closesOutside: false };
          const dragged = Math.abs(rect.left - ${before.left}) > 20 && Math.abs(rect.top - ${before.top}) > 20;
          window.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const survivesScroll = Boolean(document.querySelector('.selection-translate-popover'));
          document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          return { dragged, survivesScroll, closesOutside: !document.querySelector('.selection-translate-popover') };
        })()`, true) as { dragged: boolean; survivesScroll: boolean; closesOutside: boolean };
        if (!popoverInteraction.dragged || !popoverInteraction.survivesScroll || !popoverInteraction.closesOutside) throw new Error(`Selection translation popover interaction failed: ${JSON.stringify(popoverInteraction)}`);
        await window.webContents.executeJavaScript(`(() => {
          const original = window.setTimeout;
          window.__restoreTranslationSmokeTimeout = () => { window.setTimeout = original; delete window.__restoreTranslationSmokeTimeout; };
          window.setTimeout = (callback, delay, ...args) => original(callback, delay === 60000 ? 1500 : delay, ...args);
          document.querySelector('.cm-content')?.focus();
        })()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("翻译超时测试");
        const timeoutSelection = await window.webContents.executeJavaScript(`(() => {
          const line = [...document.querySelectorAll('.cm-line')].find(item => item.textContent?.includes('翻译超时测试'));
          const text = line?.firstChild;
          if (!(text instanceof Text)) return null;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min('翻译超时测试'.length, text.length));
          const rect = range.getBoundingClientRect();
          return { fromX: rect.left + 1, toX: rect.right - 1, y: rect.top + rect.height / 2 };
        })()`, true) as { fromX: number; toX: number; y: number } | null;
        if (!timeoutSelection) throw new Error("Selection translation timeout text was not rendered.");
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(timeoutSelection.fromX), y: Math.round(timeoutSelection.y) });
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(timeoutSelection.fromX), y: Math.round(timeoutSelection.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(timeoutSelection.fromX), y: Math.round(timeoutSelection.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(timeoutSelection.toX), y: Math.round(timeoutSelection.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(timeoutSelection.toX), y: Math.round(timeoutSelection.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        const translationTimeout = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 100 && !document.querySelector('.selection-translate-trigger'); i++) await new Promise(r => setTimeout(r, 40));
          document.querySelector('.selection-translate-trigger')?.click();
          for (let i = 0; i < 100; i++) {
            const error = document.querySelector('.selection-translate-error')?.textContent ?? '';
            const retry = document.querySelector('.selection-translate-submit');
            if (error.includes('翻译等待超过 60 秒') && retry?.textContent === '重试翻译' && !retry.disabled) {
              document.querySelector('.selection-translate-close')?.click();
              for (let j = 0; j < 20 && document.querySelector('.selection-translate-popover'); j++) await new Promise(r => setTimeout(r, 25));
              window.__restoreTranslationSmokeTimeout?.();
              return { timedOut: true, closed: !document.querySelector('.selection-translate-popover') };
            }
            await new Promise(r => setTimeout(r, 50));
          }
          window.__restoreTranslationSmokeTimeout?.();
          return { timedOut: false, error: document.querySelector('.selection-translate-error')?.textContent ?? '' };
        })()`, true) as { timedOut: boolean; closed?: boolean; error?: string };
        if (!translationTimeout.timedOut || !translationTimeout.closed) throw new Error(`Selection translation timeout feedback failed: ${JSON.stringify(translationTimeout)}`);
        await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("需要润色的正文");
        const appliedResult = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (test) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
          document.querySelector('[aria-label="切换 AI 提供商"]')?.click();
          const providerSelect = await waitFor(() => {
            const select = document.querySelector('.ai-provider-panel [aria-label="AI 提供商"]');
            return select instanceof HTMLSelectElement && select.options.length === 7 ? select : null;
          });
          if (!(providerSelect instanceof HTMLSelectElement) || document.querySelector('.ai-inspector')) return { failure: 'provider sidebar did not open alone' };
          const providers = [...document.querySelectorAll('[aria-label="AI 提供商"] option')].map((option) => option.textContent);
          if (providers.length !== 7 || !providers.some((label) => label?.includes("Codex CLI")) || !providers.some((label) => label?.includes("Claude CLI")) || !providers.some((label) => label?.includes("DeepSeek API")) || !providers.some((label) => label?.includes("Gemini API")) || !providers.some((label) => label?.includes("Kimi API")) || !providers.some((label) => label?.includes("MiniMax API")) || !providers.some((label) => label?.includes("OpenAI 兼容 API"))) return { failure: 'provider list', providers };
          if (getComputedStyle(providerSelect).opacity !== '1' || providerSelect.getBoundingClientRect().width < 150) return { failure: 'provider selector is not visible' };
          providerSelect.value = "deepseek-api";
          providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
          if (!await waitFor(() => document.querySelector('.ai-provider-panel [aria-label="DeepSeek API Key"]'))) return { failure: 'fixed provider settings missing' };
          providerSelect.value = "openai-compatible";
          providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
          const customReady = await waitFor(() => document.querySelector(".ai-custom-config") && document.querySelector('button') && [...document.querySelectorAll("button")].some((button) => button.textContent === "一键获取模型能力") && document.querySelectorAll(".ai-custom-model").length === 2);
          providerSelect.value = "codex-cli";
          providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
          if (!customReady) return { failure: 'custom provider settings missing', selected: providerSelect.value };
          document.querySelector('[aria-label="AI 写作助手"]')?.click();
          const generate = await waitFor(() => document.querySelector(".ai-generate:not(:disabled)"));
          if (!generate || !document.querySelector('.ai-provider-panel') || document.querySelector('.ai-inspector [aria-label="AI 提供商"]')) return { failure: 'assistant/sidebar independence', generate: Boolean(generate), sidebar: Boolean(document.querySelector('.ai-provider-panel')), assistant: Boolean(document.querySelector('.ai-inspector')), selected: providerSelect.value, message: document.querySelector('.ai-empty')?.textContent };
          document.querySelector('[aria-label="切换 AI 提供商"]')?.click();
          const sidebarClosed = await waitFor(() => !document.querySelector('.ai-provider-panel') && document.querySelector('.ai-inspector'));
          if (!sidebarClosed) return { failure: 'closing provider sidebar affected assistant', sidebar: Boolean(document.querySelector('.ai-provider-panel')), assistant: Boolean(document.querySelector('.ai-inspector')) };
          if (![...document.querySelectorAll(".ai-actions button")].some((button) => button.textContent === "润色" && button.title.includes("改善表达和语气"))) return { failure: 'writing actions missing' };
          generate?.click();
          const preview = await waitFor(() => document.querySelector('[aria-label="AI 建议预览"]'));
          const previewText = preview instanceof HTMLTextAreaElement ? preview.value : preview?.textContent;
          if (previewText !== "处理结果" || document.querySelector('[aria-label="AI 原文预览"]')?.value !== "需要润色的正文") return { preview: false, synced: false, applied: false, handleShown: false };
          const handleShown = Boolean(document.querySelector('.ai-comparison-handle[role="separator"][aria-orientation="horizontal"]'));
          const original = document.querySelector('[aria-label="AI 原文预览"]');
          const suggestion = document.querySelector('[aria-label="AI 建议预览"]');
          if (!(original instanceof HTMLTextAreaElement) || !(suggestion instanceof HTMLElement)) return { preview: true, synced: false, applied: false, handleShown };
          Object.defineProperty(original, "scrollHeight", { configurable: true, value: 1000 });
          Object.defineProperty(original, "clientHeight", { configurable: true, value: 500 });
          Object.defineProperty(suggestion, "scrollHeight", { configurable: true, value: 2000 });
          Object.defineProperty(suggestion, "clientHeight", { configurable: true, value: 500 });
          original.scrollTop = 500;
          original.dispatchEvent(new Event("scroll"));
          const syncHandlerRan = suggestion.dataset.aiScrollSyncing === "1";
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const synced = syncHandlerRan;
          if (!synced) return { preview: true, synced: false, applied: false, handleShown, suggestionScrollTop: suggestion.scrollTop, syncHandlerRan };
          [...document.querySelectorAll("button")].find((button) => button.textContent === "应用到正文")?.click();
          const applied = Boolean(await waitFor(() => document.querySelector(".cm-content")?.textContent?.includes("处理结果")));
          return { preview: true, synced, applied, handleShown };
        })()`, true);
        if (!appliedResult.preview || !appliedResult.synced || !appliedResult.applied || !appliedResult.handleShown) throw new Error(`AI suggestion preview, handle, scroll sync, or apply failed: ${JSON.stringify(appliedResult)}`);
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const undone = await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.textContent?.includes("需要润色的正文")`, true);
        if (!undone) throw new Error("AI suggestion was not undone in one step.");

        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("陈旧测试");
        await window.webContents.executeJavaScript(`document.querySelector(".ai-generate:not(:disabled)")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        await window.webContents.insertText("已变化");
        const stale = await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && !document.querySelector('[aria-label="AI 建议预览"]')) await new Promise((resolve) => setTimeout(resolve, 50));
          [...document.querySelectorAll("button")].find((button) => button.textContent === "应用到正文")?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return document.querySelector(".ai-result .error")?.textContent?.includes("旧建议不能应用") === true;
        })()`, true);
        if (!stale) throw new Error("Stale AI suggestion was not rejected.");

        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("取消测试");
        const cancelled = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".ai-generate:not(:disabled)")?.click();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && ![...document.querySelectorAll("button")].some((button) => button.textContent === "停止")) await new Promise((resolve) => setTimeout(resolve, 50));
          [...document.querySelectorAll("button")].find((button) => button.textContent === "停止")?.click();
          while (Date.now() < deadline) { if (document.querySelector(".ai-result")?.textContent?.includes("选择文字或把光标")) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
          return false;
        })()`, true);
        await finishSmoke("ai", Boolean(cancelled), { selectionTranslation, visibleGlyph, inkPixels, popoverInteraction, translationTimeout, applied: appliedResult, undone, stale, cancelled });
      })().catch((error) => void finishSmoke("ai", false, { error: error instanceof Error ? error.message : String(error) }));
    });
  } else if (process.env.FANTASTIC_EDITOR_PASTE_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const ready = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('[data-testid="new-document"]')?.click();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const editor = document.querySelector('.cm-content');
            if (editor) { editor.focus(); return true; }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return false;
        })()`, true);
        if (!ready) throw new Error("Paste smoke editor did not become ready.");
        const enter = () => {
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        };
        const paste = (kind: "file" | "large-html", expectedCount: number, expectEmpty = false) => window.webContents.executeJavaScript(`(async () => {
          const editor = document.querySelector('.cm-content');
          if (!(editor instanceof HTMLElement)) return { inserted: false, caretLine: -1, lines: -1 };
          const focusedBefore = document.activeElement === editor;
          const transfer = new DataTransfer();
          if (${JSON.stringify(kind)} === 'file') transfer.items.add(new File(['fixture'], 'message.eml', { type: 'message/rfc822' }));
          else transfer.setData('text/html', '<p>' + 'x'.repeat(512 * 1024) + '</p>');
          const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
          editor.dispatchEvent(pasteEvent);
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && ${expectEmpty
            ? "!(document.querySelector('.status-message')?.textContent ?? '').includes('剪贴板中没有可粘贴的文字')"
            : `(editor.textContent?.match(/Outlook 剪贴板回退测试/g)?.length ?? 0) < ${expectedCount}`}) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          const lines = [...editor.querySelectorAll('.cm-line')];
          const node = document.getSelection()?.anchorNode;
          const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line');
          return { count: editor.textContent?.match(/Outlook 剪贴板回退测试/g)?.length ?? 0, caretLine: lines.indexOf(line), lines: lines.length, focusedBefore, focusedAfter: document.activeElement === editor, prevented: pasteEvent.defaultPrevented, status: document.querySelector('.status-message')?.textContent?.slice(0, 120) ?? '' };
        })()`, true) as Promise<{ count: number; caretLine: number; lines: number; prevented: boolean; status: string }>;
        enter();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const filePaste = await paste("file", 1);
        enter();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const largeHtmlPaste = await paste("large-html", 2);
        enter();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const emptyPaste = await paste("file", 2, true);
        await finishSmoke("paste", filePaste.count === 1 && filePaste.caretLine === 1 && filePaste.prevented
          && largeHtmlPaste.count === 2 && largeHtmlPaste.caretLine === 2 && largeHtmlPaste.prevented
          && emptyPaste.count === 2 && emptyPaste.caretLine === 3 && emptyPaste.prevented && emptyPaste.status.includes("剪贴板中没有可粘贴的文字"),
        { filePaste, largeHtmlPaste, emptyPaste });
      })().catch((error) => void finishSmoke("paste", false, { error: error instanceof Error ? error.message : String(error) }));
    });
  } else if (process.env.FANTASTIC_EDITOR_LIVE_PREVIEW_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const ready = await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 10000;
          let clicked = false;
          while (Date.now() < deadline) {
            const newButton = document.querySelector("[data-testid=new-document]");
            if (newButton instanceof HTMLButtonElement) {
              newButton.click();
              clicked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          while (Date.now() < deadline) {
            if (document.querySelector(".cm-content") && document.querySelector('button[aria-label="写作模式"]') && document.querySelector('button[aria-label="源码模式"]')) return "ready";
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return clicked ? "editor-missing" : "new-button-missing";
        })()`, true) as string;
        if (ready !== "ready") {
          const rendererState = await window.webContents.executeJavaScript(`({ title: document.title, body: document.body?.innerText?.slice(0, 500) ?? "", html: document.body?.innerHTML?.slice(0, 500) ?? "" })`, true);
          throw new Error(`Live Preview smoke could not create an editable document: ${ready}. ${JSON.stringify(rendererState)}`);
        }
        window.show();
        window.focus();
        window.webContents.focus();
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        const tabCases: Array<{ mode: string; pair: string; text: string; valid: boolean; before: unknown; after: unknown }> = [];
        for (const mode of ["源码模式", "写作模式"]) {
          await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="${mode}"]')?.click()`, true);
          await new Promise((resolve) => setTimeout(resolve, 200));
          for (const pair of ["()", "（）"]) {
            await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await window.webContents.insertText(pair);
            await new Promise((resolve) => setTimeout(resolve, 150));
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await window.webContents.insertText("I");
            await new Promise((resolve) => setTimeout(resolve, 100));
            const entered = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent ?? ''`, true) as string;
            if (entered !== pair[0] + "I" + pair[1]) throw new Error(`Tab entry regression: ${mode} ${entered}`);
            const before = await window.webContents.executeJavaScript(`({focus: document.activeElement?.outerHTML?.slice(0,200), offset: document.getSelection()?.anchorOffset})`, true);
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const after = await window.webContents.executeJavaScript(`({focus: document.activeElement?.outerHTML?.slice(0,200), offset: document.getSelection()?.anchorOffset})`, true);
            await window.webContents.insertText("X");
            await new Promise((resolve) => setTimeout(resolve, 100));
            const text = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent ?? ''`, true) as string;
            tabCases.push({ mode, pair, text, valid: text === pair[0] + "I" + pair[1] + "X", before, after });
          }
        }
        const tabSkippedClosing = tabCases.every((item) => item.valid);
        if (!tabSkippedClosing) throw new Error(`Tab cursor regression: ${JSON.stringify(tabCases)}`);

        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.insertText("Turns\n\nTurns\n\nTurns");
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "f", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "f", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.insertText("Turns");
        for (let index = 1; index <= 3; index++) {
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const result = await window.webContents.executeJavaScript(`({ count: document.querySelector('.search-count')?.textContent, focused: document.activeElement?.getAttribute('aria-label') === '查找文本', marks: document.querySelectorAll('.cm-searchMatch').length, current: document.querySelectorAll('.cm-searchMatch-selected').length })`, true) as { count: string; focused: boolean; marks: number; current: number };
          if (result.count !== `${index}/3` || !result.focused || result.marks !== 3 || result.current !== 1) throw new Error(`Search regression: ${JSON.stringify(result)}`);
        }
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭查找"]')?.click(); document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("测试粗体\n\n# 标题\n\n- 第一项\n- \n- ");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.webContents.sendInputEvent({ type: "char", keyCode: "y" });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const liveTyped = await window.webContents.executeJavaScript(`[...document.querySelectorAll(".cm-line")].some((line) => line.textContent?.includes("y"))`, true) as boolean;
        await new Promise((resolve) => setTimeout(resolve, 700));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const liveUndo = await window.webContents.executeJavaScript(`({ articlePresent: document.querySelector(".cm-content")?.textContent?.includes("测试粗体") === true, typedRemoved: ![...document.querySelectorAll(".cm-line")].some((line) => line.textContent?.includes("y")), focused: document.activeElement?.classList.contains("cm-content") === true })`, true) as { articlePresent: boolean; typedRemoved: boolean; focused: boolean };
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="源码模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        window.webContents.sendInputEvent({ type: "char", keyCode: "x" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const sourceTyped = await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.textContent?.includes("x") === true`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 200));

        const initial = await window.webContents.executeJavaScript(`(() => {
          const lines = [...document.querySelectorAll(".cm-line")];
          const emptyLine = [...lines].reverse().find((line) => (line.textContent ?? "").trim() === "-" || (line.textContent ?? "").trim() === "•");
          const rect = emptyLine?.getBoundingClientRect();
          return {
            singleEditor: document.querySelectorAll(".cm-editor").length === 1,
            liveClass: document.querySelector(".cm-editor")?.classList.contains("cm-live-preview") === true,
            headingStyled: Boolean(document.querySelector(".cm-live-heading-1")),
            fontOptions: document.querySelector("[data-testid=wysiwyg-font-preset]")?.querySelectorAll("option").length ?? 0,
            toolbarButtons: [...document.querySelectorAll(".live-preview-format-toolbar button")].map((button) => button.textContent?.trim() ?? ""),
            emptyLine: rect ? { x: rect.left + 18, y: rect.top + rect.height / 2 } : null,
            lineText: lines.map((line) => line.textContent ?? "")
          };
        })()`, true) as { singleEditor: boolean; liveClass: boolean; headingStyled: boolean; fontOptions: number; toolbarButtons: string[]; emptyLine: { x: number; y: number } | null; lineText: string[] };
        if (!initial.emptyLine) throw new Error("Live Preview smoke could not locate the empty list item.");

        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(initial.emptyLine.x), y: Math.round(initial.emptyLine.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(initial.emptyLine.x), y: Math.round(initial.emptyLine.y), button: "left", clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const afterFirstDelete = await window.webContents.executeJavaScript(`({ text: [...document.querySelectorAll(".cm-line")].map((line) => line.textContent ?? ""), focused: document.activeElement?.classList.contains("cm-content") === true })`, true) as { text: string[]; focused: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const afterSecondDelete = await window.webContents.executeJavaScript(`({ text: [...document.querySelectorAll(".cm-line")].map((line) => line.textContent ?? ""), focused: document.activeElement?.classList.contains("cm-content") === true })`, true) as { text: string[]; focused: boolean };

        const selectionRect = await window.webContents.executeJavaScript(`(() => {
          const line = [...document.querySelectorAll(".cm-line")].find((item) => item.textContent?.includes("测试粗体"));
          const text = line?.firstChild;
          if (!(text instanceof Text)) return null;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min(4, text.length));
          const rect = range.getBoundingClientRect();
          return { fromX: rect.left + 1, toX: rect.right - 1, y: rect.top + rect.height / 2 };
        })()`, true) as { fromX: number; toX: number; y: number } | null;
        if (!selectionRect) throw new Error("Live Preview smoke could not locate text for a native mouse selection.");
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(selectionRect.fromX), y: Math.round(selectionRect.y) });
        await new Promise((resolve) => setTimeout(resolve, 40));
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(selectionRect.fromX), y: Math.round(selectionRect.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(selectionRect.fromX), y: Math.round(selectionRect.y), button: "left", clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 60));
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(selectionRect.toX), y: Math.round(selectionRect.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(selectionRect.toX), y: Math.round(selectionRect.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const selectionRendering = await window.webContents.executeJavaScript(`({ native: (document.getSelection()?.toString().length ?? 0) > 0, customLayers: document.querySelectorAll(".cm-selectionBackground").length })`, true) as { native: boolean; customLayers: number };
        const selectionMade = selectionRendering.native && selectionRendering.customLayers === 0;
        const editorFormatMenu = await window.webContents.executeJavaScript(`(async () => {
          const content = document.querySelector(".cm-content");
          if (!content) return { shown: false, hasNestedGroups: false, aligned: false, shortcutsHidden: false, compact: false, closed: false, buttons: [] };
          const rect = content.getBoundingClientRect();
          content.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + 24 }));
          const menu = document.querySelector("body > .editor-context-menu");
          const buttons = menu ? [...menu.querySelectorAll("button")].map((button) => button.textContent ?? "") : [];
          const hasNestedGroups = Boolean(menu?.querySelector(".editor-context-submenu .editor-context-menu-item") && buttons.some((label) => label.includes("插入")) && buttons.some((label) => label.includes("文本格式")));
          const first = menu?.querySelector(".editor-context-menu-item");
          const label = first?.querySelector(".editor-context-menu-label");
          const aligned = first instanceof HTMLElement && label instanceof HTMLElement
            && getComputedStyle(first).display === "grid"
            && getComputedStyle(label).textAlign === "left"
            && label.getBoundingClientRect().left > first.getBoundingClientRect().left;
          const shortcutButtons = menu ? [...menu.querySelectorAll("button[title]")] : [];
          const shortcutsHidden = !menu?.querySelector(".editor-context-menu-shortcut")
            && shortcutButtons.some((button) => button.querySelector(".editor-context-menu-label")?.textContent === "加粗" && button.title === "Ctrl+B")
            && shortcutButtons.some((button) => button.querySelector(".editor-context-menu-label")?.textContent === "剪切" && button.title === "Ctrl+X");
          const compact = menu instanceof HTMLElement && menu.getBoundingClientRect().width <= 240
            && first instanceof HTMLElement && getComputedStyle(first).gridTemplateColumns.split(" ").length === 2;
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return { shown: Boolean(menu), hasNestedGroups, aligned, shortcutsHidden, compact, closed: !document.querySelector("body > .editor-context-menu"), buttons };
        })()`, true) as { shown: boolean; hasNestedGroups: boolean; aligned: boolean; shortcutsHidden: boolean; compact: boolean; closed: boolean; buttons: string[] };
        const toolbarPersistent = await window.webContents.executeJavaScript(`(() => {
          const toolbar = document.querySelector(".live-preview-format-toolbar");
          if (!(toolbar instanceof HTMLElement)) return false;
          const style = getComputedStyle(toolbar);
          const rect = toolbar.getBoundingClientRect();
          return style.position !== "fixed" && style.display !== "none" && rect.width > 100 && rect.top >= 0;
        })()`, true) as boolean;
        const italicButton = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.live-preview-format-toolbar button[title^="切换斜体"]')?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`, true) as { x: number; y: number } | null;
        if (!italicButton) throw new Error("Live Preview smoke could not locate the italic toolbar command.");
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(italicButton.x), y: Math.round(italicButton.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(italicButton.x), y: Math.round(italicButton.y), button: "left", clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const italicVisible = await window.webContents.executeJavaScript(`Boolean(document.querySelector(".cm-live-emphasis"))`, true) as boolean;
        const italicStyle = await window.webContents.executeJavaScript(`(() => { const style = getComputedStyle(document.querySelector(".cm-live-emphasis")); return { fontStyle: style.fontStyle, fontSynthesis: style.fontSynthesis }; })()`, true) as { fontStyle: string; fontSynthesis: string };
        const italicToggle = await window.webContents.executeJavaScript(`(async () => {
          const button = document.querySelector('.live-preview-format-toolbar button[title^="切换斜体"]');
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const removed = !document.querySelector('.cm-live-emphasis');
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { removed, reapplied: Boolean(document.querySelector('.cm-live-emphasis')) };
        })()`, true) as { removed: boolean; reapplied: boolean };
        const kaitiBold = await window.webContents.executeJavaScript(`(async () => {
          const font = document.querySelector('[data-testid="wysiwyg-font-preset"]');
          if (!(font instanceof HTMLSelectElement)) return { applied: false, removed: false, fontFamily: '', fontWeight: '', fontSynthesis: '' };
          font.value = 'KaiTi';
          font.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 100));
          const button = document.querySelector('.live-preview-format-toolbar button[title^="切换粗体"]');
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const strong = document.querySelector('.cm-live-strong');
          const style = strong ? getComputedStyle(strong) : null;
          const result = { applied: Boolean(strong), removed: false, fontFamily: style?.fontFamily ?? '', fontWeight: style?.fontWeight ?? '', fontSynthesis: style?.fontSynthesis ?? '' };
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          result.removed = !document.querySelector('.cm-live-strong');
          return result;
        })()`, true) as { applied: boolean; removed: boolean; fontFamily: string; fontWeight: string; fontSynthesis: string };
        const blockTypes = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('.live-preview-format-toolbar button[title="一级标题"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const headingApplied = [...document.querySelectorAll(".cm-live-heading-1")].some((line) => line.textContent?.includes("测试粗体"));
          document.querySelector('.live-preview-format-toolbar button[title="正文"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const normalApplied = ![...document.querySelectorAll(".cm-live-heading-1")].some((line) => line.textContent?.includes("测试粗体"));
          return { headingApplied, normalApplied };
        })()`, true) as { headingApplied: boolean; normalApplied: boolean };
        const themeApplied = await window.webContents.executeJavaScript(`(async () => {
          const toggle = document.querySelector(".wysiwyg-theme-toggle");
          if (toggle?.getAttribute("aria-pressed") !== "true") toggle?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return document.querySelector(".editor-host")?.classList.contains("wechat-theme-active") === true
            && [...document.querySelectorAll("style")].some((style) => style.textContent?.includes(".cm-live-heading-1"));
        })()`, true) as boolean;
        const themeEditPoint = await window.webContents.executeJavaScript(`(() => { const line = [...document.querySelectorAll('.cm-line')].at(-1); const rect = line?.getBoundingClientRect(); return rect ? { x: Math.max(rect.left + 8, rect.right - 4), y: rect.top + rect.height / 2 } : null; })()`, true) as { x: number; y: number } | null;
        if (!themeEditPoint) throw new Error("Live Preview smoke could not locate a themed edit point.");
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(themeEditPoint.x), y: Math.round(themeEditPoint.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(themeEditPoint.x), y: Math.round(themeEditPoint.y), button: "left", clickCount: 1 });
        window.webContents.insertText("主题输入");
        await new Promise((resolve) => setTimeout(resolve, 150));
        const themedEditInserted = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent?.includes('主题输入') === true && document.activeElement?.classList.contains('cm-content') === true`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const themedEditUndone = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent?.includes('主题输入') === false && document.querySelector('.cm-content')?.textContent?.includes('测试粗体') === true`, true) as boolean;
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="源码模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const final = await window.webContents.executeJavaScript(`({ source: document.querySelector(".cm-content")?.textContent ?? "", singleEditor: document.querySelectorAll(".cm-editor").length === 1 })`, true) as { source: string; singleEditor: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers: ["control"] });
        const commandPaletteOpened = await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 1000;
          const check = () => {
            if (document.querySelector('.command-palette input[aria-label="搜索命令"]') === document.activeElement) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 25);
          };
          check();
        })`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });

        const firstChanged = JSON.stringify(initial.lineText) !== JSON.stringify(afterFirstDelete.text);
        await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 80; i++) { const content = document.querySelector('.editor-pane.editor-mode-wysiwyg .cm-content') ?? document.querySelector('.cm-content'); if (content) { content.focus(); return; } await new Promise(r => setTimeout(r, 25)); } })()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("![图片测试](missing-image.png)\n\n末尾");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        const imageWorkflow = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 80; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const shown = await wait(() => Boolean(document.querySelector('.cm-live-image')));
          const message = document.querySelector('.cm-live-image-caption')?.textContent ?? '';
          const edit = document.querySelector('.cm-live-image button[aria-label="编辑图片"]');
          edit?.click();
          const sourceSelected = await wait(() => document.getSelection()?.toString().includes('![图片测试]'));
          return { shown, message, sourceSelected };
        })()`, true) as { shown: boolean; message: string; sourceSelected: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const imageDeleted = await window.webContents.executeJavaScript(`!document.querySelector('.cm-content')?.textContent?.includes('missing-image.png')`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const imageRestored = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent?.includes('missing-image.png') === true`, true) as boolean;
        const secondChanged = JSON.stringify(afterFirstDelete.text) !== JSON.stringify(afterSecondDelete.text);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("# Markdown 编辑器 SVG 支持测试\n\n> 用途：检测内联 SVG。\n>\n> 使用方法：在编辑器中打开预览。\n\n---\n\n| **A** | B |\n| --- | --- |\n| <span>HTML</span> | D |\n\n末尾");
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "End", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "End", modifiers: ["control"] });
        const tableInsertPoint = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (fn) => { for (let i = 0; i < 80; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const shown = await wait(() => document.querySelectorAll('.cm-live-table tr').length === 2);
          if (!shown) return null;
          const target = document.querySelector('.cm-live-table td');
          const targetRect = target?.getBoundingClientRect();
          target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: targetRect?.left ?? 0, clientY: targetRect?.top ?? 0 }));
          const rect = [...document.querySelectorAll('.cm-live-table-context-menu button')].find(b => b.textContent === '下方插入行')?.getBoundingClientRect();
          const tableRect = document.querySelector('.cm-live-table')?.getBoundingClientRect();
          const ruleRect = document.querySelector('.cm-live-thematic-break')?.getBoundingClientRect();
          const lineRect = document.querySelector('.cm-line')?.getBoundingClientRect();
          const contentRect = document.querySelector('.cm-content')?.getBoundingClientRect();
          const lineTexts = [...document.querySelectorAll('.cm-line')].map(line => line.textContent ?? '');
          const baseProjection = Boolean(document.querySelector('.cm-live-heading-1')
            && document.querySelectorAll('.cm-live-quote-line').length === 3
            && document.querySelector('.cm-live-thematic-break')
            && !lineTexts.some(text => text.startsWith('# ') || text.startsWith('>')));
          const constrained = Boolean(tableRect && ruleRect && lineRect && contentRect
            && tableRect.width <= lineRect.width + 2
            && ruleRect.width > 300 && ruleRect.width <= lineRect.width + 2);
          return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, baseProjection, constrained, richRendered: document.querySelector('.cm-live-table th strong')?.textContent === 'A', widths: { table: tableRect?.width ?? 0, rule: ruleRect?.width ?? 0, line: lineRect?.width ?? 0, content: contentRect?.width ?? 0 } } : null;
        })()`, true) as { x: number; y: number; baseProjection: boolean; constrained: boolean; richRendered: boolean; widths: { table: number; rule: number; line: number; content: number } } | null;
        if (!tableInsertPoint?.baseProjection) throw new Error(`Live Preview base projection failed for multiline blockquote: ${JSON.stringify(tableInsertPoint)}`);
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(tableInsertPoint.x), y: Math.round(tableInsertPoint.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(tableInsertPoint.x), y: Math.round(tableInsertPoint.y), button: "left", clickCount: 1 });
        const tableWorkflow = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (fn) => { for (let i = 0; i < 80; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const inserted = await wait(() => {
            const selection = window.getSelection();
            const node = selection?.anchorNode;
            const line = node?.parentElement?.closest('.cm-line');
            if (!selection?.isCollapsed || !node || !line?.contains(node) || line.textContent !== '|  |  |') return false;
            const range = document.createRange();
            range.selectNodeContents(line);
            range.setEnd(node, selection.anchorOffset);
            return range.toString().length === 2;
          });
          return { shown: true, inserted };
        })()`, true) as { shown: boolean; inserted: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        const tableLastTab = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 120; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
          await wait(() => document.querySelectorAll('.cm-live-table tr').length === 2);
          const headers = document.querySelectorAll('.cm-live-table th button');
          headers[1]?.click();
          document.querySelector('.cm-live-table th input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          const skippedProtected = await wait(() => document.querySelector('.cm-live-table td input')?.value === 'D');
          document.querySelector('.cm-live-table td input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          const appended = await wait(() => document.querySelectorAll('.cm-live-table tr').length === 3);
          const focused = document.activeElement?.matches('.cm-live-table td input') === true;
          const activeCell = document.activeElement?.closest('td');
          const rect = activeCell?.getBoundingClientRect();
          activeCell?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect?.left ?? 0, clientY: rect?.top ?? 0 }));
          const deleteRow = [...document.querySelectorAll('.cm-live-table-context-menu button')].find(button => button.textContent === '删除当前行');
          const rowSynced = deleteRow?.disabled === false;
          deleteRow?.click();
          const deleted = await wait(() => document.querySelectorAll('.cm-live-table tr').length === 2);
          return { skippedProtected, appended, focused, rowSynced, deleted, sourceVisible: !document.querySelector('.cm-live-table') };
        })()`, true) as { skippedProtected: boolean; appended: boolean; focused: boolean; rowSynced: boolean; deleted: boolean; sourceVisible: boolean };
        const tableRichEdit = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && !document.querySelector('.cm-live-table th strong'); i++) await new Promise(r => setTimeout(r, 50));
          document.querySelector('.cm-live-table th button')?.click();
          const input = document.querySelector('.cm-live-table th input');
          const raw = input?.value ?? '';
          if (input) input.value = '**更新**';
          input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 80 && document.querySelector('.cm-live-table th strong')?.textContent !== '更新'; i++) await new Promise(r => setTimeout(r, 50));
          return { raw, rendered: document.querySelector('.cm-live-table th strong')?.textContent === '更新' };
        })()`, true) as { raw: string; rendered: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        const tableCellFormatting = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-table tr').length !== 2; i++) await new Promise(r => setTimeout(r, 50));
          [...document.querySelectorAll('.cm-live-table td button')].at(-1)?.click();
          const input = document.querySelector('.cm-live-table td input');
          if (!input) return { toolbar: false, rendered: false };
          input.setSelectionRange(0, input.value.length);
          input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          const menu = document.querySelector('.cm-live-table-context-menu');
          const menuRect = menu?.getBoundingClientRect();
          const toolbar = [...document.querySelectorAll('.cm-live-table-context-menu button')].some(button => button.textContent === 'B') && [...document.querySelectorAll('.cm-live-table-context-menu button')].some(button => button.textContent === '链接');
          const horizontal = Boolean(menu?.classList.contains('cm-live-table-format-menu') && menuRect && menuRect.height < 24 && menuRect.width >= 80 && menuRect.width < 150 && getComputedStyle(menu).display === 'flex');
          document.querySelector('.cm-live-table-context-menu')?.remove();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
          const toggledOff = input.value === 'D';
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 80 && document.querySelector('.cm-live-table td strong')?.textContent !== 'D'; i++) await new Promise(r => setTimeout(r, 50));
          return { toolbar, horizontal, toggledOff, rendered: document.querySelector('.cm-live-table td strong')?.textContent === 'D' };
        })()`, true) as { toolbar: boolean; horizontal: boolean; toggledOff: boolean; rendered: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        const tableNestedLink = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 100; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
          await wait(() => document.querySelectorAll('.cm-live-table tr').length === 2);
          [...document.querySelectorAll('.cm-live-table td button')].at(-1)?.click();
          const input = document.querySelector('.cm-live-table td input');
          if (!(input instanceof HTMLInputElement)) return { unlinked: false, submitted: false, rendered: false };
          input.value = '[~~*乙*~~](https://www.baidu.com)';
          input.setSelectionRange(0, input.value.length);
          input.setSelectionRange(0, input.value.length);
          input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          [...document.querySelectorAll('.cm-live-table-context-menu button')].find(button => button.textContent === '链接')?.click();
          const unlinked = input.value === '~~*乙*~~' && document.activeElement === input;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const submitted = await wait(() => !document.querySelector('.cm-live-table td input'));
          const rendered = await wait(() => {
            const cell = [...document.querySelectorAll('.cm-live-table td button')].find(button => button.textContent?.includes('乙'));
            return Boolean(cell && cell.textContent?.includes('乙') && cell.querySelector('del, s') && cell.querySelector('em, i')) && !document.querySelector('.cm-live-table td a');
          });
          return { unlinked, submitted, rendered };
        })()`, true) as { unlinked: boolean; submitted: boolean; rendered: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        const tableUndoEdit = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-table tr').length !== 2; i++) await new Promise(r => setTimeout(r, 50));
          const undone = document.querySelectorAll('.cm-live-table tr').length === 2;
          [...document.querySelectorAll('.cm-live-table td button')].at(-1)?.click();
          const input = document.querySelector('.cm-live-table td input');
          if (input) input.value = '已修改';
          input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 80 && ![...document.querySelectorAll('.cm-live-table td button')].some(button => button.textContent === '已修改'); i++) await new Promise(r => setTimeout(r, 50));
          return { undone, opened: Boolean(input), edited: [...document.querySelectorAll('.cm-live-table td button')].some(button => button.textContent === '已修改') };
        })()`, true) as { undone: boolean; opened: boolean; edited: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="源码模式"]')?.click()`, true);
        await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 80 && !document.querySelector('.editor-pane.editor-mode-source .cm-content'); i++) await new Promise(r => setTimeout(r, 25)); })()`, true);
        const multiEditorPoint = await window.webContents.executeJavaScript(`(() => { const rect = (document.querySelector('.editor-pane.editor-mode-source .cm-content') ?? document.querySelector('.cm-content'))?.getBoundingClientRect(); return rect ? { x: rect.left + 12, y: rect.top + 12 } : null; })()`, true) as { x: number; y: number } | null;
        if (multiEditorPoint) {
          window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(multiEditorPoint.x), y: Math.round(multiEditorPoint.y), button: "left", clickCount: 1 });
          window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(multiEditorPoint.x), y: Math.round(multiEditorPoint.y), button: "left", clickCount: 1 });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`document.execCommand('selectAll')`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("| X | Y |\n| --- | --- |\n| 1 | 2 |\n\n| A | B |\n| --- | --- |\n| C | D |\n");
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        const multiTableTab = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 100; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
          await wait(() => document.querySelectorAll('.cm-live-table').length === 2);
          document.querySelectorAll('.cm-live-table')[1]?.querySelector('th button')?.click();
          let stayedInSecond = true;
          const steps = [];
          for (const expected of ['B', 'C', 'D', '']) {
            const currentTables = document.querySelectorAll('.cm-live-table');
            const before = currentTables[1]?.querySelector('input')?.value ?? null;
            currentTables[1]?.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            const moved = await wait(() => document.querySelectorAll('.cm-live-table')[1]?.querySelector('input')?.value === expected);
            steps.push({ before, expected, moved, after: document.querySelectorAll('.cm-live-table')[1]?.querySelector('input')?.value ?? null, rows: document.querySelectorAll('.cm-live-table')[1]?.querySelectorAll('tr').length ?? 0 });
            stayedInSecond = stayedInSecond && moved;
            if (!moved) break;
            await new Promise(r => setTimeout(r, 100));
          }
          const tables = document.querySelectorAll('.cm-live-table');
          return { stayedInSecond, focusedSecond: Boolean(tables[1]?.contains(document.activeElement)), firstActive: Boolean(tables[0]?.querySelector('input')), rowCounts: [...tables].map(table => table.querySelectorAll('tr').length), steps };
        })()`, true) as { stayedInSecond: boolean; focusedSecond: boolean; firstActive: boolean; rowCounts: number[]; steps: Array<{ before: string | null; expected: string; moved: boolean; after: string | null; rows: number }> };
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="源码模式"]')?.click()`, true);
        await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 80 && !document.querySelector('.editor-pane.editor-mode-source .cm-content'); i++) await new Promise(r => setTimeout(r, 25)); })()`, true);
        const formulaEditorPoint = await window.webContents.executeJavaScript(`(() => { const rect = (document.querySelector('.editor-pane.editor-mode-source .cm-content') ?? document.querySelector('.cm-content'))?.getBoundingClientRect(); return rect ? { x: rect.left + 12, y: rect.top + 12 } : null; })()`, true) as { x: number; y: number } | null;
        if (formulaEditorPoint) {
          window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(formulaEditorPoint.x), y: Math.round(formulaEditorPoint.y), button: "left", clickCount: 1 });
          window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(formulaEditorPoint.x), y: Math.round(formulaEditorPoint.y), button: "left", clickCount: 1 });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`document.execCommand('selectAll')`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("$N = 2F + 1$\n\n$$\n\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}\n$$\n\n```typescript\nconst value = 1;\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n末尾");
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        const formulaWorkflow = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-formula .katex').length !== 2; i++) await new Promise(r => setTimeout(r, 50));
          const rendered = document.querySelectorAll('.cm-live-formula .katex').length === 2;
          for (let i = 0; i < 120 && !document.querySelector('.cm-live-mermaid .mermaid-diagram svg'); i++) await new Promise(r => setTimeout(r, 50));
          const mermaidRendered = Boolean(document.querySelector('.cm-live-mermaid .mermaid-diagram svg'));
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-mermaid .cm-live-image-controls button').length !== 9; i++) await new Promise(r => setTimeout(r, 50));
          const mermaidRoot = document.querySelector('.cm-live-mermaid');
          const mermaidControls = Boolean(mermaidRoot && document.querySelectorAll('.cm-live-mermaid .cm-live-image-controls button').length === 9 && mermaidRoot.querySelector('button[aria-label="编辑源码"]') && mermaidRoot.querySelector('button[aria-label="下载/保存为图片"]') && !mermaidRoot.textContent?.includes('编辑 Mermaid 源码'));
          const mermaidRight = mermaidRoot?.querySelector('button[aria-label="向右移动"]');
          mermaidRight?.click();
          const mermaidMoved = mermaidRoot?.style.getPropertyValue('--live-image-offset-x') === '24px';
          mermaidRoot?.querySelector('button[aria-label="恢复默认位置和大小"]')?.click();
          const mermaidReset = mermaidRoot?.style.getPropertyValue('--live-image-offset-x') === '0px' && mermaidRoot.style.getPropertyValue('--live-image-zoom') === '1';
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-code-line span[class]').length < 2; i++) await new Promise(r => setTimeout(r, 50));
          const code = document.querySelector('.cm-live-code-line');
          const codeStyled = Boolean(code && getComputedStyle(code).fontFamily.includes('Consolas') && getComputedStyle(code).fontSize === '14px');
          const codeColors = [...document.querySelectorAll('.cm-live-code-line span[class]')].map(token => getComputedStyle(token).color);
          const codeColored = new Set(codeColors).size >= 2;
          document.querySelector('.cm-live-formula')?.click();
          return { rendered, mermaidRendered, mermaidControls, mermaidMoved, mermaidReset, codeStyled, codeColored, codeColors, selected: window.getSelection()?.toString() === '$N = 2F + 1$' };
        })()`, true) as { rendered: boolean; mermaidRendered: boolean; mermaidControls: boolean; mermaidMoved: boolean; mermaidReset: boolean; codeStyled: boolean; codeColored: boolean; codeColors: string[]; selected: boolean };
        await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\"><rect width=\"40\" height=\"20\" fill=\"#28745b\"/></svg>\n```\n");
        const svgContentWorkflow = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check, timeoutMs = 6_000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return check(); };
          const rendered = await wait(() => document.querySelector('.cm-live-image img[alt="SVG 内容"]')?.getAttribute('src')?.startsWith('fantastic-asset://asset/') === true, 60_000);
          document.querySelector('.cm-live-image button[aria-label="编辑源码"]')?.click();
          const sourceSelected = await wait(() => window.getSelection()?.toString().includes(String.fromCharCode(96, 96, 96) + 'svg') === true);
          return { rendered, sourceSelected, liveImages: document.querySelectorAll('.cm-live-image').length, previewSvg: Boolean(document.querySelector('.resolved-inline-svg')), placeholder: Boolean(document.querySelector('.inline-svg-placeholder')), status: document.querySelector('.status')?.textContent ?? '', diagnostics: [...document.querySelectorAll('.diagnostic-item')].map(item => item.textContent) };
        })()`, true) as { rendered: boolean; sourceSelected: boolean; liveImages: number; previewSvg: boolean; placeholder: boolean; status: string; diagnostics: string[] };
        await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("```json\n{\"app\":{\"port\":3000}}\n```\n\n```yaml\nserver:\n  port: 3000\n```\n\n```toml\n[server]\nport = 3000\n```\n\n```html\n<main><script>alert(1)</script><p>正文</p></main>\n```\n\n```env\nAPP_MODE=local\n```\n");
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "End", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "End", modifiers: ["control"] });
        const structuredCodeWorkflow = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 100; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const liveShown = await wait(() => document.querySelectorAll('.cm-live-structured-code').length === 5);
          const kinds = [...document.querySelectorAll('.cm-live-structured-code .structured-code-visualization')].map(item => item.getAttribute('data-structured-language'));
          const copy = [...document.querySelectorAll('.cm-live-structured-code-tools button')].find(button => button.getAttribute('aria-label') === '复制');
          copy?.click();
          const copyWorked = await wait(() => copy?.title === '已复制');
          const branch = document.querySelector('.cm-live-structured-code .structured-code-toggle');
          branch?.click();
          const branchCollapsed = branch?.getAttribute('aria-expanded') === 'false' && Boolean(document.querySelector('.cm-live-structured-code .structured-code-row[hidden]'));
          branch?.click();
          [...document.querySelectorAll('.cm-live-structured-code button')].find(button => button.getAttribute('aria-label') === '编辑源码')?.click();
          const sourceSelected = await wait(() => window.getSelection()?.toString().includes(String.fromCharCode(96, 96, 96) + 'json') === true);
          document.querySelector('button[aria-label="分栏"]')?.click();
          const previewShown = await wait(() => document.querySelectorAll('.preview-structured-code').length === 5);
          const structuredSource = document.querySelector('pre[data-structured-source]');
          const sourceHidden = structuredSource instanceof HTMLElement && structuredSource.hidden;
          document.querySelector('.preview-structured-source-toggle')?.click();
          const sourceExpanded = structuredSource instanceof HTMLElement && !structuredSource.hidden;
          const scriptExecuted = Boolean(document.querySelector('.preview-content script')) || Reflect.has(window, '__fantasticStructuredSmoke');
          document.querySelector('button[aria-label="写作模式"]')?.click();
          await wait(() => Boolean(document.querySelector('.editor-pane.editor-mode-wysiwyg .cm-editor.cm-live-preview')));
          return { liveShown, previewShown, sourceSelected, copyWorked, branchCollapsed, sourceHidden, sourceExpanded, kinds, scriptExecuted, stageClass: document.querySelector('.document-stage')?.className ?? '', previewLanguages: [...document.querySelectorAll('.preview-content pre > code')].map(code => code.className) };
        })()`, true) as { liveShown: boolean; previewShown: boolean; sourceSelected: boolean; copyWorked: boolean; branchCollapsed: boolean; sourceHidden: boolean; sourceExpanded: boolean; kinds: string[]; scriptExecuted: boolean; stageClass: string; previewLanguages: string[] };
        await new Promise((resolve) => setTimeout(resolve, 300));
        await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 80; i++) { const content = document.querySelector('.editor-pane.editor-mode-wysiwyg .cm-content') ?? document.querySelector('.cm-content'); if (content) { content.focus(); return; } await new Promise(r => setTimeout(r, 25)); } })()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("# 投影稳定性\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n- [ ] 切换任务\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"40\"><rect width=\"160\" height=\"40\" fill=\"#28745b\"/></svg>\n```\n");
        const taskStabilityPoint = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 240; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const ready = await wait(() => Boolean(document.querySelector('.cm-live-mermaid .mermaid-diagram svg') && document.querySelector('.cm-live-task-marker') && document.querySelector('.cm-live-image')));
          if (!ready) return {
            error: {
              mermaid: Boolean(document.querySelector('.cm-live-mermaid .mermaid-diagram svg')),
              task: Boolean(document.querySelector('.cm-live-task-marker')),
              image: Boolean(document.querySelector('.cm-live-image')),
            },
          };
          const task = document.querySelector('.cm-live-task-marker');
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const rect = task?.getBoundingClientRect();
          const scroller = document.querySelector('.cm-scroller');
          const scrollTop = scroller?.scrollTop ?? -1;
          const saved = {
            scrollTop,
            maxScrollDelta: 0,
            scroller,
            mermaid: document.querySelector('.cm-live-mermaid .mermaid-diagram svg'),
            onScroll: null,
          };
          saved.onScroll = () => { saved.maxScrollDelta = Math.max(saved.maxScrollDelta, Math.abs((scroller?.scrollTop ?? -1) - scrollTop)); };
          scroller?.addEventListener('scroll', saved.onScroll, { passive: true });
          window.__fantasticTaskStability = saved;
          return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
        })()`, true) as { x?: number; y?: number; error?: { mermaid: boolean; task: boolean; image: boolean } } | null;
        if (!taskStabilityPoint?.x || !taskStabilityPoint?.y) throw new Error(`Live Preview smoke could not prepare the task projection stability scenario: ${JSON.stringify(taskStabilityPoint?.error ?? null)}`);
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(taskStabilityPoint.x), y: Math.round(taskStabilityPoint.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(taskStabilityPoint.x), y: Math.round(taskStabilityPoint.y), button: "left", clickCount: 1 });
        const taskProjectionStability = await window.webContents.executeJavaScript(`(async () => {
          await new Promise(r => setTimeout(r, 1200));
          const saved = window.__fantasticTaskStability;
          saved?.scroller?.removeEventListener('scroll', saved.onScroll);
          return {
            toggled: document.querySelector('.cm-live-task-marker')?.getAttribute('aria-pressed') === 'true',
            scrollDelta: saved?.maxScrollDelta ?? -1,
            mermaidPreserved: Boolean(saved?.mermaid && saved.mermaid === document.querySelector('.cm-live-mermaid .mermaid-diagram svg')),
            svgPresent: Boolean(document.querySelector('.cm-live-image')),
          };
        })()`, true) as { toggled: boolean; scrollDelta: number; mermaidPreserved: boolean; svgPresent: boolean };
        await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("# 一级\n\n### 跳级标题");
        const markdownDiagnostics = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 80; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const shown = await wait(() => [...document.querySelectorAll('.diagnostic-item')].some(item => item.textContent?.includes('HEADING_LEVEL_SKIPPED')));
          [...document.querySelectorAll('.diagnostic-item')].find(item => item.textContent?.includes('HEADING_LEVEL_SKIPPED'))?.click();
          const jumped = await wait(() => window.getSelection()?.toString().includes('跳级标题') === true);
          document.querySelector('.cm-content')?.focus();
          return { shown, jumped };
        })()`, true) as { shown: boolean; jumped: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("# 一级\n\n## 二级");
        const markdownDiagnosticCleared = await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 80; i++) { if (![...document.querySelectorAll('.diagnostic-item')].some(item => item.textContent?.includes('HEADING_LEVEL_SKIPPED'))) return true; await new Promise(r => setTimeout(r, 50)); } return false; })()`, true) as boolean;
        const valid = tabSkippedClosing && markdownDiagnostics.shown && markdownDiagnostics.jumped && markdownDiagnosticCleared && taskProjectionStability.toggled && taskProjectionStability.scrollDelta <= 2 && taskProjectionStability.mermaidPreserved && taskProjectionStability.svgPresent && svgContentWorkflow.rendered && svgContentWorkflow.sourceSelected && structuredCodeWorkflow.liveShown && structuredCodeWorkflow.previewShown && structuredCodeWorkflow.sourceSelected && structuredCodeWorkflow.copyWorked && structuredCodeWorkflow.branchCollapsed && structuredCodeWorkflow.sourceHidden && structuredCodeWorkflow.sourceExpanded && structuredCodeWorkflow.kinds.join(",") === "json,yaml,toml,html,config" && !structuredCodeWorkflow.scriptExecuted && formulaWorkflow.rendered && formulaWorkflow.mermaidRendered && formulaWorkflow.mermaidControls && formulaWorkflow.mermaidMoved && formulaWorkflow.mermaidReset && formulaWorkflow.codeStyled && formulaWorkflow.codeColored && formulaWorkflow.selected && tableWorkflow.shown && tableWorkflow.inserted && tableInsertPoint.constrained && tableInsertPoint.richRendered && tableRichEdit.raw === '**A**' && tableRichEdit.rendered && tableCellFormatting.toolbar && tableCellFormatting.horizontal && tableCellFormatting.toggledOff && tableCellFormatting.rendered && tableNestedLink.unlinked && tableNestedLink.submitted && tableNestedLink.rendered && tableUndoEdit.undone && tableUndoEdit.opened && tableUndoEdit.edited && tableLastTab.skippedProtected && tableLastTab.appended && tableLastTab.focused && tableLastTab.rowSynced && tableLastTab.deleted && !tableLastTab.sourceVisible && multiTableTab.stayedInSecond && multiTableTab.focusedSecond && !multiTableTab.firstActive && multiTableTab.rowCounts.join(",") === "2,3" && imageWorkflow.shown && imageWorkflow.sourceSelected && imageDeleted && imageRestored && liveTyped && liveUndo.articlePresent && liveUndo.typedRemoved && liveUndo.focused && sourceTyped
          && initial.singleEditor && initial.liveClass && initial.headingStyled && initial.fontOptions >= 7
          && ["正文", "H1", "H2", "H3", "链接"].every((label) => initial.toolbarButtons.includes(label))
          && firstChanged && secondChanged && afterFirstDelete.focused && afterSecondDelete.focused
          && selectionMade && editorFormatMenu.shown && editorFormatMenu.hasNestedGroups && editorFormatMenu.aligned && editorFormatMenu.shortcutsHidden && editorFormatMenu.compact && editorFormatMenu.closed && editorFormatMenu.buttons.some((button) => button.endsWith("插入图片")) && editorFormatMenu.buttons.some((button) => button.endsWith("翻译")) && editorFormatMenu.buttons.some((button) => button.endsWith("检测语言")) && toolbarPersistent && italicVisible && italicStyle.fontStyle === "italic" && italicStyle.fontSynthesis.includes("style") && italicToggle.removed && italicToggle.reapplied
          && kaitiBold.applied && kaitiBold.removed && kaitiBold.fontFamily.includes("KaiTi") && Number(kaitiBold.fontWeight) >= 700 && kaitiBold.fontSynthesis.includes("weight")
          && blockTypes.headingApplied && blockTypes.normalApplied && themeApplied && themedEditInserted && themedEditUndone && commandPaletteOpened
          && final.singleEditor && final.source.includes("*测试粗体*");
        await finishSmoke("live-preview", valid, { tabSkippedClosing, markdownDiagnostics, markdownDiagnosticCleared, taskProjectionStability, svgContentWorkflow, structuredCodeWorkflow, formulaWorkflow, tableLayout: { constrained: tableInsertPoint.constrained, widths: tableInsertPoint.widths }, tableWorkflow, tableRichEdit, tableCellFormatting, tableNestedLink, tableUndoEdit, tableLastTab, multiTableTab, imageWorkflow, imageDeleted, imageRestored, liveTyped, liveUndo, sourceTyped, initial, afterFirstDelete, afterSecondDelete, selectionMade, selectionRendering, editorFormatMenu, toolbarPersistent, italicVisible, italicStyle, italicToggle, kaitiBold, blockTypes, themeApplied, themedEditInserted, themedEditUndone, commandPaletteOpened, final, firstChanged, secondChanged });
      })().catch((error: unknown) => {
        const diagnostic = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? "" } : { message: String(error) };
        void finishSmoke("live-preview", false, { error: diagnostic });
      });
    });
    window.webContents.once("did-fail-load", (_event, code, description) => { console.error(`Renderer load failed (${code}): ${description}`); void finishSmoke("live-preview", false); });
  } else if (process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const uiReady = await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (document.querySelector("[data-testid=new-document]")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true) as boolean;
        const before = await window.webContents.executeJavaScript(`({
          hasTabs: Boolean(document.querySelector(\"[data-testid=document-tabs]\")),
          dropHintRemoved: !document.querySelector(\"[data-testid=drop-hint]\"),
          tabStripFillsAvailableWidth: getComputedStyle(document.querySelector(\".tab-strip\")).flexGrow === \"1\",
          hasNewButton: Boolean(document.querySelector(\"[data-testid=new-document]\")),
          uniqueFileActions: [\"新建文档\", \"打开文件\", \"保存\", \"打开文件夹\"].every((label) => document.querySelectorAll('.activity-bar button[aria-label=\"' + label + '\"]').length === 1)
            && document.querySelectorAll('.explorer-title button, .new-tab').length === 0
        })`, true) as { hasTabs: boolean; dropHintRemoved: boolean; tabStripFillsAvailableWidth: boolean; hasNewButton: boolean; uniqueFileActions: boolean };
        if (!before.uniqueFileActions) throw new Error("File actions must exist exactly once in the activity bar.");
        await window.webContents.executeJavaScript(`(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(["# smoke"], "smoke.md", { type: "text/markdown" }));
          document.querySelector(".app-shell")?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        })()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const drag = await window.webContents.executeJavaScript(`({ hasDropOverlay: Boolean(document.querySelector(".drop-overlay")) })`, true) as { hasDropOverlay: boolean };
        await window.webContents.executeJavaScript(`document.querySelector(".app-shell")?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }))`, true);
        await window.webContents.executeJavaScript(`(() => { const strip = document.querySelector('.tab-strip'); if (!(strip instanceof HTMLElement)) return; const rect = strip.getBoundingClientRect(); strip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: rect.right - 4, clientY: rect.top + rect.height / 2 })); })()`, true);
        await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (document.querySelector(".document-tab.active") && document.querySelector(".cm-content")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true);
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="分栏"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const after = await window.webContents.executeJavaScript(`({
          tabText: document.querySelector(\".document-tab.active .tab-select span\")?.textContent ?? \"\",
          tabCount: document.querySelectorAll(\".document-tab\").length,
          editorText: document.querySelector(\".cm-content\")?.textContent ?? \"\",
          brandText: document.querySelector(\".brand-lockup\")?.textContent ?? \"\",
          hasSidebar: Boolean(document.querySelector(\".explorer-panel\")),
          hasSidebarResizeHandle: Boolean(document.querySelector(".sidebar-resize-handle")),
          hasSplitHandle: Boolean(document.querySelector(".split-handle")),
          hasInsertImageButton: Boolean(document.querySelector('[aria-label="插入图片"]')),
          hasSmartPunctuationButton: Boolean(document.querySelector(".smart-punctuation-button")),
          hasSyncScrollButton: Boolean(document.querySelector("[data-testid=sync-scroll-toggle]")),
          saveEnabled: !(document.querySelector('button[aria-label="保存"]')?.hasAttribute("disabled") ?? true),
          hasUnsavedIndicator: Boolean(document.querySelector(".document-tab.active .dirty-dot, .document-tab.active i[aria-label=未保存]")),
          statusText: document.querySelector(".status-message")?.textContent ?? "",
          viewportFits: document.documentElement.scrollWidth === document.documentElement.clientWidth
        })`, true) as { tabText: string; tabCount: number; editorText: string; brandText: string; hasSidebar: boolean; hasSidebarResizeHandle: boolean; hasSplitHandle: boolean; hasInsertImageButton: boolean; hasSmartPunctuationButton: boolean; hasSyncScrollButton: boolean; saveEnabled: boolean; hasUnsavedIndicator: boolean; statusText: string; viewportFits: boolean };
        const splitHeaderLayout = await window.webContents.executeJavaScript(`(() => {
          const stage = document.querySelector('.document-stage.view-split');
          if (!(stage instanceof HTMLElement)) return { contained: false, previewScrollable: false };
          const headers = [...document.querySelectorAll('.document-stage.view-split .pane-header')];
          const actions = headers.map((header) => header.querySelector('.pane-actions')).filter((item) => item instanceof HTMLElement);
          const contained = actions.length === 2 && actions.every((item) => {
            const headerRect = item.parentElement.getBoundingClientRect();
            const actionsRect = item.getBoundingClientRect();
            return actionsRect.left >= headerRect.left && actionsRect.right <= headerRect.right + 1;
          });
          const previewActions = document.querySelector('.document-stage.view-split .preview-pane .pane-actions');
          const previewScrollable = previewActions instanceof HTMLElement
            && getComputedStyle(previewActions).overflowX === 'auto'
            && [...previewActions.children].every((item) => getComputedStyle(item).flexShrink === '0');
          return { contained, previewScrollable };
        })()`, true) as { contained: boolean; previewScrollable: boolean };
        const accessibility = await window.webContents.executeJavaScript(`(async () => {
          const separator = document.querySelector('.split-handle');
          const sidebarSeparator = document.querySelector('.sidebar-resize-handle');
          const selectedTab = document.querySelector('.document-tab.active .tab-select');
          const status = document.querySelector('.status-message');
          if (!(separator instanceof HTMLElement) || !(sidebarSeparator instanceof HTMLElement)) return { keyboardSeparator: false, keyboardSidebarSeparator: false, sidebarToggle: false, selectedTab: false, liveStatus: false };
          const before = Number(separator.getAttribute('aria-valuenow'));
          separator.focus();
          separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const after = Number(separator.getAttribute('aria-valuenow'));
          const sidebarBefore = Number(sidebarSeparator.getAttribute('aria-valuenow'));
          sidebarSeparator.focus();
          sidebarSeparator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sidebarAfter = Number(document.querySelector('.sidebar-resize-handle')?.getAttribute('aria-valuenow'));
          const sidebarToggleButton = document.querySelector('[aria-label="切换资源管理器"]');
          if (sidebarToggleButton?.getAttribute('aria-pressed') !== 'true') {
            sidebarToggleButton?.click();
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          document.querySelector('[aria-label="切换资源管理器"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sidebarHidden = !document.querySelector('.explorer-panel');
          document.querySelector('[aria-label="切换资源管理器"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            keyboardSeparator: separator.tabIndex === 0 && after > before,
            keyboardSidebarSeparator: sidebarSeparator.tabIndex === 0 && sidebarAfter > sidebarBefore,
            sidebarToggle: sidebarHidden && Boolean(document.querySelector('.explorer-panel')),
            selectedTab: selectedTab?.getAttribute('role') === 'tab' && selectedTab.getAttribute('aria-selected') === 'true',
            liveStatus: status?.getAttribute('role') === 'status' && status.getAttribute('aria-live') === 'polite',
          };
        })()`, true) as { keyboardSeparator: boolean; keyboardSidebarSeparator: boolean; sidebarToggle: boolean; selectedTab: boolean; liveStatus: boolean };
        const recentBoundary = await window.webContents.executeJavaScript(`(async () => {
          const result = await window.fantasticEditor.listRecentFiles();
          return {
            listed: result.status === 'listed',
            opaque: result.status === 'listed' && result.items.every((item) => typeof item.recentId === 'string' && !('path' in item)),
          };
        })()`, true) as { listed: boolean; opaque: boolean };
        const tabShortcuts = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, timeout = 5000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          document.querySelector('[data-testid=new-document]')?.click();
          const created = await waitFor(() => document.querySelectorAll('.document-tab').length === 2 && document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '1');
          document.querySelector('.document-tab.active .tab-select')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          const reorderedLeft = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '0');
          document.querySelector('.document-tab.active .tab-select')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          const reorderedRight = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '1');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          const previous = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '0');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
          const next = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '1');
          const originalConfirm = window.confirm;
          window.confirm = () => true;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
          const closed = await waitFor(() => document.querySelectorAll('.document-tab').length === 1 && document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '0');
          window.confirm = originalConfirm;
          return { created, reorderedLeft, reorderedRight, previous, next, closed };
        })()`, true) as { created: boolean; reorderedLeft: boolean; reorderedRight: boolean; previous: boolean; next: boolean; closed: boolean };
        const fontControl = await window.webContents.executeJavaScript(`(() => {
          const presets = document.querySelector("[data-testid=preview-font-preset]");
          if (!(presets instanceof HTMLSelectElement)) return { exists: false, applied: false, hasArial: false, accurateLabel: false };
          const hasArial = Array.from(presets.options).some((option) => option.value === "Arial") && presets.options.length >= 7;
          const label = presets.closest("label");
          const accurateLabel = presets.getAttribute("aria-label") === "正文字体" && label?.querySelector("span")?.textContent?.trim() === "正文字体" && label.title.includes("导出");
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          setter?.call(presets, "KaiTi");
          presets.dispatchEvent(new Event("change", { bubbles: true }));
          return { exists: true, applied: true, hasArial, accurateLabel };
        })()`, true) as { exists: boolean; applied: boolean; hasArial: boolean; accurateLabel: boolean };
        await new Promise((resolve) => setTimeout(resolve, 100));
        const fontApplied = await window.webContents.executeJavaScript(`document.querySelector(".markdown-preview")?.getAttribute("style")?.includes("KaiTi") ?? false`, true) as boolean;
        window.show();
        window.focus();
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 120));
        await window.webContents.insertText("# Mermaid smoke\n\n剪贴板 HTML 测试\n\n跨块格式甲\n\n跨块格式乙\n\n跨块粘贴甲\n\n跨块粘贴乙\n\n***\n\n***\n\n***\n\n混合前 [链接](https://example.com) 与 `代码`、$a+b$、![inline image](missing.png) 混合后\n\n下表为**中性情景**下的工作假设：\n\n| 期间 | 情景 |\n| --- | --- |\n| 2026Q3 | 预测 |\n\n> 引用原文\n\n- 列表原项\n- [ ] 待完成\n- 嵌套父项\n  - 嵌套子项\n  - [ ] 嵌套任务\n- 嵌套后项\n\n![smoke image](missing.png)\n\n$$\nx + y\n$$\n\n```ts\nconst value = 1;\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n* \n* \n  * \n* \n");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const mermaidRendered = await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 8000;
          const check = () => {
            if (document.querySelector(".mermaid-diagram svg")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true) as boolean;
        const performanceMetric = await window.webContents.executeJavaScript(`(() => {
          const metric = document.querySelector('.performance-metric');
          return {
            exists: metric instanceof HTMLElement,
            text: metric?.textContent ?? '',
            accessible: (metric?.getAttribute('aria-label') ?? '').includes('字符') && (metric?.getAttribute('aria-label') ?? '').includes('资源解析'),
          };
        })()`, true) as { exists: boolean; text: string; accessible: boolean };
        const mermaidEditorText = await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.textContent ?? ""`, true) as string;
        const mermaidDebug = await window.webContents.executeJavaScript(`({ errorText: document.querySelector(".mermaid-error")?.textContent ?? "", renderError: document.querySelector(".preview-content")?.getAttribute("data-mermaid-error") ?? "", started: document.querySelector(".preview-content")?.getAttribute("data-mermaid-started") ?? "" })`, true) as { errorText: string; renderError: string; started: string };
        const wechatThemePreview = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, timeout = 15000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          const button = document.querySelector(".wechat-layout-entry");
          if (!(button instanceof HTMLButtonElement)) return { opened: false, completed: false, widthCount: 0, hasHeadingAuditCopy: false, hasActions: false, keyboardDialog: false, focusRestored: false };
          const ready = await waitFor(() => !button.disabled);
          if (!ready) return { opened: false, completed: false, widthCount: 0, hasHeadingAuditCopy: false, hasActions: false, keyboardDialog: false, focusRestored: false };
          button.click();
          const opened = await waitFor(() => Boolean(document.querySelector(".wechat-preview-dialog")));
          // 三档宽度预览要同时渲染三个公众号 iframe，是 ui 场景里最重的一步；
          // 刚打完包时杀毒软件扫描新写入的二进制会明显拖慢它，默认 15 秒会偶发不够，
          // 导致门禁误报（同样的产物在机器空闲时重跑即通过）。这里单独放宽。
          const completed = opened && await waitFor(() => document.querySelectorAll(".viewport-buttons button:not(.running)").length >= 1, 60000);
          const widthCount = document.querySelectorAll(".viewport-buttons button").length;
          const hasHeadingAuditCopy = document.querySelector(".wechat-audit-panel")?.textContent?.includes("只检查当前") ?? false;
          const hasActions = ["接口与封面设置", "准备公众号内容", "同步到草稿箱", "发布"].every((label) => [...document.querySelectorAll(".wechat-inspector-actions button")].some((item) => item.textContent?.trim() === label));
          const dialog = document.querySelector('.wechat-preview-panel');
          const closeButton = document.querySelector('button[aria-label="关闭公众号主题预览"]');
          const keyboardDialog = dialog?.getAttribute('role') === 'region'
            && dialog?.getAttribute('aria-modal') === null
            && Boolean(dialog.getAttribute('aria-labelledby'))
            && closeButton instanceof HTMLButtonElement;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          const closed = await waitFor(() => !document.querySelector('.wechat-preview-dialog'), 60000);
          await new Promise((resolve) => setTimeout(resolve, 50));
          const focusRestored = closed && document.activeElement === button;
          return { opened, completed, widthCount, hasHeadingAuditCopy, hasActions, keyboardDialog, focusRestored };
        })()`, true) as { opened: boolean; completed: boolean; widthCount: number; hasHeadingAuditCopy: boolean; hasActions: boolean; keyboardDialog: boolean; focusRestored: boolean };
        const syncTextBefore = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.textContent ?? ""`, true) as string;        const syncBefore = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
        await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const syncAfter = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
        if (syncAfter !== "true") {
          await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const syncEnabled = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
        await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (document.querySelector(".preview-content [data-source-block=true]")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true);
        window.show();
        window.focus();
        window.webContents.focus();
        const wysiwyg = false ? await window.webContents.executeJavaScript(`(async () => {
          try {
          const sourceButton = document.querySelector('button[aria-label="分栏"]');
          const visualButton = document.querySelector('button[aria-label="写作模式"]');
          if (!(sourceButton instanceof HTMLButtonElement) || !(visualButton instanceof HTMLButtonElement)) return { exists: false };
          visualButton.click();
          const waitFor = async (predicate, timeout = 8000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          const projectionReady = () => document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content")?.getAttribute("data-projection-ready") === "true";
          const ready = await waitFor(() => Boolean(document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content p[data-source-from]")) && Boolean(document.querySelector(".wysiwyg-editor-layer.active .mermaid-diagram svg")));
          let tableCellEdited = false;
          let tableColumnInserted = false;
          let tableAlignmentApplied = false;
          let tableRowAppended = false;
          let listItemEdited = false;
          let listDirectReady = false;
          let listBrowserInserted = false;
          let listIndented = false;
          let listOutdented = false;
          let nestedParentEdited = false;
          let nestedSubtreeIndented = false;
          let nestedSubtreeOutdented = false;
          let quoteEdited = false;
          let taskToggled = false;
          let imageAltEdited = false;
          let formulaStructuredApplied = false;
          let codeStructuredApplied = false;
          let linkStructuredApplied = false;
          let inlineCodeStructuredApplied = false;
          let mixedInlineEdited = false;
          let mixedAtomsProtected = false;
          let protectedSelectionRejected = false;
          let crossBlockFormatted = false;
          let crossBlockPasted = false;
          let crossBlockProtectedRejected = false;
          let dualFormatCopy = false;
          let selectAllCopy = false;
          let externalHtmlPaste = false;
          let imaRichPaste = false;
          let imaPasteSnapshot = "";
          let blockInserted = false;
          let blockDragged = false;
          let blockDuplicated = false;
          let blockDeleted = false;
          let blockKeyboardMoved = false;
          let headingLevelsApplied = false;
          let italicChineseApplied = false;
          let italicChineseVisible = false;
          let italicToggleOff = false;
          let boldToggleOff = false;
          let formatSelectionRetained = false;
          let toolbarLinkApplied = false;
          let blockToolbarPersistent = false;
          let blockToolbarRepeatedMove = false;
          let emptyListItemDeleted = false;
          const repeatedBreaksCompacted = document.querySelector(".wysiwyg-thematic-break-group")?.textContent?.includes("×3") === true
            && document.querySelectorAll(".wysiwyg-editor-layer.active hr").length === 0;
          const headingLevelTrace = [];
          const selectAcrossParagraphs = (firstText, lastText) => {
            const paragraphs = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")];
            const first = paragraphs.find((element) => element.textContent?.includes(firstText));
            const last = paragraphs.find((element) => element.textContent?.includes(lastText));
            if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return null;
            const rect = first.getBoundingClientRect();
            first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 }));
            const findTextNode = (root, text) => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
              let node = walker.nextNode();
              while (node && !node.textContent?.includes(text)) node = walker.nextNode();
              return node;
            };
            const firstNode = findTextNode(first, firstText);
            const lastNode = findTextNode(last, lastText);
            if (!(firstNode instanceof Text) || !(lastNode instanceof Text)) return null;
            const range = document.createRange();
            range.setStart(firstNode, firstNode.textContent?.indexOf(firstText) ?? 0);
            range.setEnd(lastNode, (lastNode.textContent?.indexOf(lastText) ?? 0) + lastText.length);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return first;
          };
          const applyHeadingLevel = async (level, title) => {
            const heading = [...document.querySelectorAll(".wysiwyg-editor-layer.active h1, .wysiwyg-editor-layer.active h2, .wysiwyg-editor-layer.active h3")]
              .find((element) => element.textContent?.includes("Mermaid smoke"));
            if (!(heading instanceof HTMLElement)) return false;
            const rect = heading.getBoundingClientRect();
            heading.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const buttonReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-toolbar button")].some((button) => button.getAttribute("title") === title));
            const button = [...document.querySelectorAll(".wysiwyg-toolbar button")].find((candidate) => candidate.getAttribute("title") === title);
            if (!buttonReady || !(button instanceof HTMLButtonElement)) return false;
            button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const applied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("#".repeat(level) + " Mermaid smoke")
              && [...document.querySelectorAll(".wysiwyg-editor-layer.active h" + level)].some((element) => element.textContent?.includes("Mermaid smoke")));
            headingLevelTrace.push({
              level,
              applied,
              source: document.querySelector(".cm-content")?.textContent ?? "",
              renderedTag: [...document.querySelectorAll(".wysiwyg-editor-layer.active h1, .wysiwyg-editor-layer.active h2, .wysiwyg-editor-layer.active h3")]
                .find((element) => element.textContent?.includes("Mermaid smoke"))?.tagName ?? "missing",
              status: document.querySelector(".status-message")?.textContent ?? "",
            });
            return applied;
          };
          headingLevelsApplied = await applyHeadingLevel(2, "二级标题")
            && await applyHeadingLevel(3, "三级标题")
            && await applyHeadingLevel(1, "一级标题");
          const copyParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
            .find((element) => (element.textContent ?? "").trim().length > 0);
          if (copyParagraph instanceof HTMLElement) {
            const copyRange = document.createRange();
            copyRange.selectNodeContents(copyParagraph);
            const copySelection = window.getSelection();
            copySelection?.removeAllRanges();
            copySelection?.addRange(copyRange);
            const copyData = new DataTransfer();
            const copyEvent = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: copyData });
            copyParagraph.dispatchEvent(copyEvent);
            const copiedPlain = copyData.getData("text/plain");
            const copiedHtml = copyData.getData("text/html");
            dualFormatCopy = copiedPlain.length > 0
              && copiedHtml.includes('data-fantastic-clipboard="v1"')
              && copiedHtml.includes('data-fantastic-plain-length="' + copiedPlain.length + '"')
              && copiedHtml.includes('data-fantastic-plain-hash="fnv1a32:');
            const selectAllEvent = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
            copyParagraph.dispatchEvent(selectAllEvent);
            const allSelection = window.getSelection();
            const allCopyData = new DataTransfer();
            copyParagraph.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: allCopyData }));
            const allCopiedPlain = allCopyData.getData("text/plain");
            selectAllCopy = selectAllEvent.defaultPrevented
              && Boolean(allSelection && !allSelection.isCollapsed)
              && allCopiedPlain.length > copiedPlain.length
              && allCopiedPlain.includes("跨块格式甲")
              && allCopiedPlain.includes("const value = 1;");
          }
          const formatStart = selectAcrossParagraphs("跨块格式甲", "跨块格式乙");
          const boldToolbarButton = document.querySelector('.wysiwyg-toolbar button[title^="粗体"]');
          if (formatStart && boldToolbarButton instanceof HTMLButtonElement) {
            boldToolbarButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            boldToolbarButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
            crossBlockFormatted = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              return text.includes("**跨块格式甲**") && text.includes("**跨块格式乙**");
            });
          }
          const pasteReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].some((element) => element.textContent?.includes("跨块粘贴甲")));
          const pasteStart = pasteReady ? selectAcrossParagraphs("跨块粘贴甲", "跨块粘贴乙") : null;
          if (pasteStart) {
            const clipboard = new DataTransfer();
            clipboard.setData("text/plain", "批量甲\\r\\n# 批量乙");
            pasteStart.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
            crossBlockPasted = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              const visualParagraphs = [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].map((element) => element.textContent ?? "");
              return visualParagraphs.some((value) => value.includes("批量甲")) && visualParagraphs.some((value) => value.includes("# 批量乙"))
                && !text.includes("跨块粘贴甲") && !text.includes("跨块粘贴乙");
            });
          }
          const protectedReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].some((element) => element.textContent?.includes("批量乙")));
          const unsafeStart = protectedReady ? selectAcrossParagraphs("批量乙", "混合后") : null;
          if (unsafeStart) {
            const beforeUnsafe = document.querySelector(".cm-content")?.textContent ?? "";
            const deleteEvent = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
            const prevented = !unsafeStart.dispatchEvent(deleteEvent);
            const afterUnsafe = document.querySelector(".cm-content")?.textContent ?? "";
            crossBlockProtectedRejected = prevented && beforeUnsafe === afterUnsafe && afterUnsafe.includes("$a+b$");
          }
          const imageReady = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=image]") instanceof HTMLElement);
          const imageElement = document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=image]");
          if (imageReady && imageElement instanceof HTMLElement) {
            imageElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const altReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-image-alt]") instanceof HTMLInputElement);
            const altInput = document.querySelector("[data-testid=wysiwyg-image-alt]");
            if (altReady && altInput instanceof HTMLInputElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              setter?.call(altInput, "更新后的图片说明");
              altInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-image-card > div button:first-child")?.click();
              imageAltEdited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("![更新后的图片说明](missing.png)"));
            }
          }
          const linkAtomReady = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=inline-link]") instanceof HTMLElement);
          const linkAtom = document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=inline-link]");
          if (linkAtomReady && linkAtom instanceof HTMLElement) {
            linkAtom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const linkPanelReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-link-label]") instanceof HTMLInputElement);
            if (linkPanelReady) {
              const setInput = (selector, value) => {
                const input = document.querySelector(selector);
                if (!(input instanceof HTMLInputElement)) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, value);
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
                return true;
              };
              setInput("[data-testid=wysiwyg-link-label]", "新链接");
              setInput("[data-testid=wysiwyg-link-destination]", "https://openai.com/docs");
              setInput("[data-testid=wysiwyg-link-title]", "文档入口");
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              linkStructuredApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes('[新链接](https://openai.com/docs "文档入口")'));
            }
          }
          const inlineCodeAtom = document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=inline-code]");
          if (inlineCodeAtom instanceof HTMLElement) {
            inlineCodeAtom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const inlineCodeReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-inline-code-source]") instanceof HTMLInputElement);
            const inlineCodeInput = document.querySelector("[data-testid=wysiwyg-inline-code-source]");
            if (inlineCodeReady && inlineCodeInput instanceof HTMLInputElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              setter?.call(inlineCodeInput, "代码\x60片段");
              inlineCodeInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              inlineCodeStructuredApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("\\x60\\x60代码\\x60片段\\x60\\x60"));
            }
          }
          const mixedParagraphReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].some((element) => element.textContent?.includes("混合前") && element.textContent?.includes("混合后")));
          const mixedParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].find((element) => element.textContent?.includes("混合前") && element.textContent?.includes("混合后"));
          if (mixedParagraphReady && mixedParagraph instanceof HTMLElement) {
            const mixedRect = mixedParagraph.getBoundingClientRect();
            mixedParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: mixedRect.right - 12, clientY: mixedRect.top + mixedRect.height / 2 }));
            const atoms = [...mixedParagraph.querySelectorAll(".wysiwyg-inline-atom")];
            mixedAtomsProtected = mixedParagraph.isContentEditable && atoms.length >= 4 && atoms.every((atom) => atom.getAttribute("contenteditable") === "false");
            const selection = window.getSelection();
            const protectedRange = document.createRange();
            protectedRange.selectNodeContents(mixedParagraph);
            selection?.removeAllRanges();
            selection?.addRange(protectedRange);
            const protectedDelete = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
            protectedSelectionRejected = !mixedParagraph.dispatchEvent(protectedDelete);
            const walker = document.createTreeWalker(mixedParagraph, NodeFilter.SHOW_TEXT);
            let endingNode = walker.nextNode();
            while (endingNode && !endingNode.textContent?.includes("混合后")) endingNode = walker.nextNode();
            if (endingNode?.textContent) {
              const from = endingNode.textContent.indexOf("混合后");
              const endingRange = document.createRange();
              endingRange.setStart(endingNode, from);
              endingRange.setEnd(endingNode, from + "混合后".length);
              selection?.removeAllRanges();
              selection?.addRange(endingRange);
              document.execCommand("insertText", false, "结尾已编辑");
              mixedParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              mixedInlineEdited = await waitFor(() => {
                const text = document.querySelector(".cm-content")?.textContent ?? "";
                return text.includes("结尾已编辑")
                  && text.includes("[新链接](https://openai.com/docs \\"文档入口\\")")
                  && text.includes("\\x60\\x60代码\\x60片段\\x60\\x60")
                  && text.includes("$a+b$")
                  && text.includes("![更新后的图片说明](missing.png)");
              });
            }
          }
          const firstTableCellReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].some((element) => element.textContent?.includes("2026Q3")));
          const firstTableCell = [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].find((element) => element.textContent?.includes("2026Q3"));
          if (firstTableCellReady && firstTableCell instanceof HTMLElement) {
            const cellRect = firstTableCell.getBoundingClientRect();
            firstTableCell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cellRect.left + 4, clientY: cellRect.top + cellRect.height / 2 }));
            const cellSelection = window.getSelection();
            const cellRange = document.createRange();
            cellRange.selectNodeContents(firstTableCell);
            cellSelection?.removeAllRanges();
            cellSelection?.addRange(cellRange);
            document.execCommand("insertText", false, "2026Q4");
            firstTableCell.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            const nextTableCell = document.activeElement;
            if (nextTableCell instanceof HTMLTableCellElement) {
              const nextRange = document.createRange();
              nextRange.selectNodeContents(nextTableCell);
              cellSelection?.removeAllRanges();
              cellSelection?.addRange(nextRange);
              document.execCommand("insertText", false, "上调");
              const secondColumnToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-table-toolbar > span")?.textContent?.includes("第 2 列"));
              const insertColumn = [...document.querySelectorAll(".wysiwyg-table-toolbar button")].find((button) => button.textContent === "右侧插列");
              if (secondColumnToolbarReady && insertColumn instanceof HTMLButtonElement) insertColumn.click();
            }
            tableCellEdited = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              return text.includes("2026Q4") && text.includes("上调");
            });
            tableColumnInserted = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("| 期间 | 情景 |  |"));
            const alignedCellReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active table tr")].every((row) => row.querySelectorAll("th, td").length === 3) && [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].some((element) => element.textContent?.includes("2026Q4")));
            const alignedCell = [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].find((element) => element.textContent?.includes("2026Q4"));
            if (alignedCellReady && alignedCell instanceof HTMLElement) {
              const alignedRect = alignedCell.getBoundingClientRect();
              alignedCell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: alignedRect.left + 4, clientY: alignedRect.top + alignedRect.height / 2 }));
              const firstColumnToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-table-toolbar > span")?.textContent?.includes("第 1 列"));
              const centerButton = [...document.querySelectorAll(".wysiwyg-table-toolbar button")].find((button) => button.textContent === "居中");
              if (firstColumnToolbarReady && centerButton instanceof HTMLButtonElement) centerButton.click();
              tableAlignmentApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("| :---: | --- | --- |"));
            }
            const lastCellReady = await waitFor(() => {
              const rows = document.querySelectorAll(".wysiwyg-editor-layer.active table tbody tr");
              return rows.length > 0 && rows[rows.length - 1]?.querySelectorAll("td").length === 3;
            });
            const bodyRows = document.querySelectorAll(".wysiwyg-editor-layer.active table tbody tr");
            const lastCell = bodyRows[bodyRows.length - 1]?.querySelector("td:last-child");
            if (lastCellReady && lastCell instanceof HTMLElement) {
              const lastRect = lastCell.getBoundingClientRect();
              lastCell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: lastRect.left + 4, clientY: lastRect.top + lastRect.height / 2 }));
              const lastColumnToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-table-toolbar > span")?.textContent?.includes("第 3 列"));
              if (lastColumnToolbarReady) {
                lastCell.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
                tableRowAppended = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("|  |  |  |"));
              }
            }
          }
          const listReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].some((element) => element.textContent?.includes("列表原项")));
          const listItem = [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].find((element) => element.textContent?.includes("列表原项"));
          if (listReady && listItem instanceof HTMLElement) {
            const itemRect = listItem.getBoundingClientRect();
            listItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: itemRect.left + 8, clientY: itemRect.top + itemRect.height / 2 }));
            const itemSelection = window.getSelection();
            const itemRange = document.createRange();
            itemRange.selectNodeContents(listItem);
            itemSelection?.removeAllRanges();
            itemSelection?.addRange(itemRange);
            listDirectReady = listItem.isContentEditable && document.activeElement === listItem;
            listBrowserInserted = document.execCommand("insertText", false, "列表已编辑");
            listItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            listBrowserInserted = document.execCommand("insertText", false, "列表第二项") && listBrowserInserted;
            listItem.blur();
            listItemEdited = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              return text.includes("列表已编辑") && text.includes("列表第二项");
            });
          }
          const secondListReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].some((element) => element.textContent?.trim() === "列表第二项"));
          const secondListItem = [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].find((element) => element.textContent?.trim() === "列表第二项");
          if (secondListReady && secondListItem instanceof HTMLElement) {
            const secondRect = secondListItem.getBoundingClientRect();
            secondListItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: secondRect.left + 8, clientY: secondRect.top + secondRect.height / 2 }));
            secondListItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            listIndented = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active li li")].some((element) => element.textContent?.trim() === "列表第二项"));
            const nestedItem = [...document.querySelectorAll(".wysiwyg-editor-layer.active li li")].find((element) => element.textContent?.trim() === "列表第二项");
            if (nestedItem instanceof HTMLElement) {
              const nestedRect = nestedItem.getBoundingClientRect();
              nestedItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: nestedRect.left + 8, clientY: nestedRect.top + nestedRect.height / 2 }));
              nestedItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
              listOutdented = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > ul > li")].some((element) => element.textContent?.trim() === "列表第二项"));
            }
          }
          const nestedParentReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].some((element) => element.textContent?.trim() === "嵌套父项"));
          const nestedParent = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项");
          if (nestedParentReady && nestedParent instanceof HTMLElement) {
            const parentRect = nestedParent.getBoundingClientRect();
            nestedParent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: parentRect.left + 8, clientY: parentRect.top + parentRect.height / 2 }));
            const parentSelection = window.getSelection();
            const parentRange = document.createRange();
            parentRange.selectNodeContents(nestedParent);
            parentSelection?.removeAllRanges();
            parentSelection?.addRange(parentRange);
            document.execCommand("insertText", false, "嵌套父项已编辑");
            nestedParent.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            nestedParentEdited = await waitFor(() => {
              const own = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
              const item = own?.closest("li");
              return Boolean(item && [...item.querySelectorAll(":scope > ul > li")].some((child) => child.textContent?.includes("嵌套子项"))
                && [...item.querySelectorAll(":scope > ul > li")].some((child) => child.textContent?.includes("嵌套任务")));
            });
          }
          const parentForIndent = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
          if (parentForIndent instanceof HTMLElement) {
            const parentRect = parentForIndent.getBoundingClientRect();
            parentForIndent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: parentRect.left + 8, clientY: parentRect.top + parentRect.height / 2 }));
            parentForIndent.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            nestedSubtreeIndented = await waitFor(() => {
              const own = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
              const item = own?.closest("li");
              return Boolean(item?.parentElement?.closest("li")
                && [...(item?.querySelectorAll(":scope > ul > li") ?? [])].some((child) => child.textContent?.includes("嵌套子项")));
            });
            const parentForOutdent = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
            if (parentForOutdent instanceof HTMLElement) {
              const outdentRect = parentForOutdent.getBoundingClientRect();
              parentForOutdent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: outdentRect.left + 8, clientY: outdentRect.top + outdentRect.height / 2 }));
              parentForOutdent.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
              nestedSubtreeOutdented = await waitFor(() => {
                const own = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
                const item = own?.closest("li");
                return Boolean(item && !item.parentElement?.closest("li")
                  && [...item.querySelectorAll(":scope > ul > li")].some((child) => child.textContent?.includes("嵌套任务")));
              });
            }
          }
          const quoteReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote p")].some((element) => element.textContent?.includes("引用原文")));
          const quote = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote p")].find((element) => element.textContent?.includes("引用原文"));
          if (quoteReady && quote instanceof HTMLElement) {
            const quoteRect = quote.getBoundingClientRect();
            quote.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: quoteRect.left + 8, clientY: quoteRect.top + quoteRect.height / 2 }));
            const quoteSelection = window.getSelection();
            const quoteRange = document.createRange();
            quoteRange.selectNodeContents(quote);
            quoteSelection?.removeAllRanges();
            quoteSelection?.addRange(quoteRange);
            document.execCommand("insertText", false, "引用已编辑");
            quote.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            quoteEdited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("引用已编辑"));
          }
          const taskReady = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active li input[type=checkbox]") instanceof HTMLInputElement);
          const task = document.querySelector(".wysiwyg-editor-layer.active li input[type=checkbox]");
          if (taskReady && task instanceof HTMLInputElement) {
            task.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            taskToggled = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("[x] 待完成"));
          }
          const paragraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content p[data-source-from]")].find((element) => element.textContent?.includes("下表为"));
          if (!(paragraph instanceof HTMLElement)) return { exists: true, ready, edited: false };
          const paragraphRect = paragraph.getBoundingClientRect();
          paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: paragraphRect.left + paragraphRect.width / 2, clientY: paragraphRect.top + paragraphRect.height / 2 }));
          const initialSelection = window.getSelection();
          const caretInside = Boolean(initialSelection?.anchorNode && paragraph.contains(initialSelection.anchorNode));
          const directInputReady = paragraph.isContentEditable && document.activeElement === paragraph && caretInside;
          const replacementRange = document.createRange();
          replacementRange.selectNodeContents(paragraph);
          initialSelection?.removeAllRanges();
          initialSelection?.addRange(replacementRange);
          const browserInserted = document.execCommand("insertText", false, "可视编辑已写回");
          const formatRange = document.createRange();
          formatRange.selectNodeContents(paragraph);
          initialSelection?.removeAllRanges();
          initialSelection?.addRange(formatRange);
          const directItalicButton = document.querySelector('.wysiwyg-toolbar button[title^="斜体"]');
          if (directItalicButton instanceof HTMLButtonElement) {
            directItalicButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            italicChineseApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("*可视编辑已写回*"));
            const italicElement = paragraph.querySelector("em, i");
            italicChineseVisible = italicElement instanceof HTMLElement && getComputedStyle(italicElement).transform !== "none";
            formatSelectionRetained = Boolean(window.getSelection() && !window.getSelection().isCollapsed && paragraph.contains(window.getSelection().anchorNode));
            if (italicElement instanceof HTMLElement) {
              const legacyDuplicate = document.createElement("em");
              legacyDuplicate.className = "wysiwyg-italic-visual";
              italicElement.replaceWith(legacyDuplicate);
              legacyDuplicate.append(italicElement);
              const legacyRange = document.createRange();
              legacyRange.selectNodeContents(italicElement);
              const legacySelection = window.getSelection();
              legacySelection?.removeAllRanges();
              legacySelection?.addRange(legacyRange);
            }
            directItalicButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            italicToggleOff = await waitFor(() => !paragraph.querySelector("em, i") && (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
          }
          const directBoldButton = document.querySelector('.wysiwyg-toolbar button[title^="粗体"]');
          if (directBoldButton instanceof HTMLButtonElement) {
            directBoldButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
            directBoldButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            boldToggleOff = await waitFor(() => !paragraph.querySelector("strong, b") && (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
            directBoldButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          }
          const edited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
          const formatted = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
          const afterEdit = document.querySelector(".cm-content")?.textContent ?? "";
          const formattedParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("可视编辑已写回"));
          if (formattedParagraph instanceof HTMLElement) {
            formattedParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            formattedParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            await waitFor(() => !(document.activeElement instanceof HTMLElement) || !formattedParagraph.contains(document.activeElement));
          }
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
          const undone = await waitFor(() => !(document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
          const afterUndo = document.querySelector(".cm-content")?.textContent ?? "";
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
          const redone = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
          const afterRedo = document.querySelector(".cm-content")?.textContent ?? "";
          const paragraphAfterRedoReady = await waitFor(() => Boolean([...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("可视编辑已写回"))));
          const paragraphAfterRedo = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("可视编辑已写回"));
          let paragraphBreaks = false;
          let mergedParagraphs = false;
          if (paragraphAfterRedoReady && paragraphAfterRedo instanceof HTMLElement) {
            const redoRect = paragraphAfterRedo.getBoundingClientRect();
            paragraphAfterRedo.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: redoRect.right - 4, clientY: redoRect.top + redoRect.height / 2 }));
            const endRange = document.createRange();
            endRange.selectNodeContents(paragraphAfterRedo);
            endRange.collapse(false);
            const endSelection = window.getSelection();
            endSelection?.removeAllRanges();
            endSelection?.addRange(endRange);
            paragraphAfterRedo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            document.execCommand("insertText", false, "第二段");
            paragraphAfterRedo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
            document.execCommand("insertText", false, "软换行");
            paragraphAfterRedo.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            paragraphBreaks = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("第二段") && (document.querySelector(".cm-content")?.textContent ?? "").includes("软换行"));
            const secondParagraphReady = await waitFor(() => Boolean([...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("第二段"))));
            const secondParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("第二段"));
            if (secondParagraphReady && secondParagraph instanceof HTMLElement) {
              const secondRect = secondParagraph.getBoundingClientRect();
              secondParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: secondRect.left + 3, clientY: secondRect.top + secondRect.height / 2 }));
              const startRange = document.createRange();
              startRange.selectNodeContents(secondParagraph);
              startRange.collapse(true);
              const startSelection = window.getSelection();
              startSelection?.removeAllRanges();
              startSelection?.addRange(startRange);
              secondParagraph.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
              mergedParagraphs = await waitFor(() => ![...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].some((element) => element.textContent === "第二段软换行"));
            }
          }
          const visualContent = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content");
          let compositionDeferred = false;
          let blankParagraphAdded = false;
          let blankParagraphDeduplicated = false;
          let blankParagraphDeleted = false;
          if (visualContent instanceof HTMLElement) {
            const contentRect = visualContent.getBoundingClientRect();
            visualContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: contentRect.left + contentRect.width / 2, clientY: contentRect.bottom - 8 }));
            const firstBlankParagraph = visualContent.querySelector("[data-wysiwyg-new-block=true]");
            visualContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: contentRect.left + contentRect.width / 2, clientY: contentRect.bottom - 18 }));
            blankParagraphDeduplicated = visualContent.querySelectorAll("[data-wysiwyg-new-block=true]").length === 1;
            if (firstBlankParagraph instanceof HTMLElement) {
              firstBlankParagraph.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
              blankParagraphDeleted = await waitFor(() => visualContent.querySelectorAll("[data-wysiwyg-new-block=true]").length === 0);
            }
            visualContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: contentRect.left + contentRect.width / 2, clientY: contentRect.bottom - 8 }));
            const blankParagraph = visualContent.querySelector("[data-wysiwyg-new-block=true]");
            if (blankParagraph instanceof HTMLElement) {
              blankParagraph.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "shuru" }));
              document.execCommand("insertText", false, "输入法新增");
              await new Promise((resolve) => setTimeout(resolve, 850));
              compositionDeferred = !(document.querySelector(".cm-content")?.textContent ?? "").includes("输入法新增");
              blankParagraph.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "输入法新增" }));
              blankParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              blankParagraphAdded = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("输入法新增"));
            }
          }
          let multilinePasteHandled = false;
          let multilinePasteError = "";
          try {
          const pasteContent = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content");
          if (pasteContent instanceof HTMLElement) {
            const pasteRect = pasteContent.getBoundingClientRect();
            pasteContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: pasteRect.left + pasteRect.width / 2, clientY: pasteRect.bottom - 8 }));
            const pasteParagraph = pasteContent.querySelector("[data-wysiwyg-new-block=true]");
            if (pasteParagraph instanceof HTMLElement) {
              const clipboardData = new DataTransfer();
              clipboardData.setData("text/plain", "粘贴第一行\\r\\n粘贴第二行");
              pasteParagraph.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
              pasteParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              multilinePasteHandled = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("粘贴第一行") && (document.querySelector(".cm-content")?.textContent ?? "").includes("粘贴第二行"));
            }
          }
          } catch (error) {
            multilinePasteError = error instanceof Error ? error.message : String(error);
          }
          try {
            const htmlParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
              .find((element) => element.textContent?.includes("剪贴板 HTML 测试"));
            if (htmlParagraph instanceof HTMLElement) {
              const htmlRect = htmlParagraph.getBoundingClientRect();
              htmlParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: htmlRect.left + 8, clientY: htmlRect.top + htmlRect.height / 2 }));
              const htmlRange = document.createRange();
              htmlRange.selectNodeContents(htmlParagraph);
              const htmlSelection = window.getSelection();
              htmlSelection?.removeAllRanges();
              htmlSelection?.addRange(htmlRange);
              const clipboardData = new DataTransfer();
              clipboardData.setData("text/plain", "外部加粗\\n外部图");
              clipboardData.setData("text/html", '<p><strong>外部加粗</strong></p><p><img src="file:///secret.png" alt="外部图"></p>');
              htmlParagraph.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
              htmlParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              externalHtmlPaste = await waitFor(() => {
                const text = document.querySelector(".cm-content")?.textContent ?? "";
                return text.includes("**外部加粗**") && text.includes("![外部图]（图片未包含）");
              });
              await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
                .some((element) => element.textContent?.includes("外部加粗")));
              const richTarget = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
                .find((element) => element.textContent?.includes("外部加粗"));
              if (richTarget instanceof HTMLElement) {
                const richRange = document.createRange();
                richRange.selectNodeContents(richTarget);
                htmlSelection?.removeAllRanges();
                htmlSelection?.addRange(richRange);
                const richData = new DataTransfer();
                richData.setData("text/plain", "\\\\# IMA 标题\\n\\\\- 一级\\n  \\\\- 二级\\n3\\\\. 第三项");
                richData.setData("text/html", "<h1>IMA 标题</h1><ul><li><strong>一级</strong><ul><li>二级</li></ul></li></ul><ol start=3><li>第三项</li></ol>");
                richTarget.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: richData }));
                richTarget.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
                imaRichPaste = await waitFor(() => {
                  const text = document.querySelector(".cm-content")?.textContent ?? "";
                  imaPasteSnapshot = text;
                  return text.includes("# IMA 标题") && text.includes("- **一级**") && text.includes("  - 二级") && text.includes("3. 第三项") && !text.includes("\\\\# IMA 标题");
                });
              }
            }
          } catch (error) {
            multilinePasteError = [multilinePasteError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" | ");
          }
          const toolbarLinkTargetReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active h1")].some((element) => element.textContent?.includes("IMA 标题")));
          const toolbarLinkTarget = [...document.querySelectorAll(".wysiwyg-editor-layer.active h1")].find((element) => element.textContent?.includes("IMA 标题"));
          if (toolbarLinkTargetReady && toolbarLinkTarget instanceof HTMLElement) {
            const rect = toolbarLinkTarget.getBoundingClientRect();
            toolbarLinkTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const node = toolbarLinkTarget.firstChild;
            if (node instanceof Text) {
              const from = node.textContent?.indexOf("IMA 标题") ?? -1;
              const range = document.createRange();
              range.setStart(node, from);
              range.setEnd(node, from + "IMA 标题".length);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
              document.querySelector('.wysiwyg-toolbar button[title^="添加链接"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              const inputReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-link-create-destination]") instanceof HTMLInputElement);
              const input = document.querySelector("[data-testid=wysiwyg-link-create-destination]");
              if (inputReady && input instanceof HTMLInputElement) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, "https://example.com/toolbar");
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
                toolbarLinkApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("[IMA 标题](https://example.com/toolbar)"))
                  && Boolean(window.getSelection() && !window.getSelection().isCollapsed && toolbarLinkTarget.contains(window.getSelection().anchorNode));
              }
            }
          }
          const diagramReady = await waitFor(() => {
            const content = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content");
            const candidate = content?.querySelector(".mermaid-diagram");
            return projectionReady() && Boolean(candidate && content) && Number(candidate?.getAttribute("data-source-to")) <= Number(content?.getAttribute("data-document-length"));
          });
          const diagram = diagramReady ? document.querySelector(".wysiwyg-editor-layer.active .mermaid-diagram") : null;
          diagram?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          const sourceAreaReady = await waitFor(() => document.querySelector(".wysiwyg-source-card textarea") instanceof HTMLTextAreaElement);
          const sourceArea = document.querySelector(".wysiwyg-source-card textarea");
          if (sourceArea instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(sourceArea, sourceArea.value.replace("A --> B", "A --> C"));
            sourceArea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
            document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
          }
          const sourceCardApplied = sourceAreaReady && await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("A --> C"));
          document.querySelector(".wysiwyg-source-card > div button:last-child")?.click();

          const formulaReady = await waitFor(() => projectionReady() && document.querySelector(".wysiwyg-editor-layer.active .preview-formula-block") instanceof HTMLElement);
          const formulaBlock = document.querySelector(".wysiwyg-editor-layer.active .preview-formula-block");
          if (formulaReady && formulaBlock instanceof HTMLElement) {
            formulaBlock.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const formulaInputReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-formula-source]") instanceof HTMLTextAreaElement);
            const formulaInput = document.querySelector("[data-testid=wysiwyg-formula-source]");
            if (formulaInputReady && formulaInput instanceof HTMLTextAreaElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
              setter?.call(formulaInput, "x^2 + y^2");
              formulaInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              formulaStructuredApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("x^2 + y^2"));
              document.querySelector(".wysiwyg-source-card > div button:last-child")?.click();
            }
          }

          const codeReady = await waitFor(() => projectionReady() && document.querySelector(".wysiwyg-editor-layer.active pre > code.language-ts") instanceof HTMLElement);
          const codeBlock = document.querySelector(".wysiwyg-editor-layer.active pre > code.language-ts")?.closest("pre");
          if (codeReady && codeBlock instanceof HTMLElement) {
            codeBlock.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const codeInputReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-code-source]") instanceof HTMLTextAreaElement);
            const codeInput = document.querySelector("[data-testid=wysiwyg-code-source]");
            const languageInput = document.querySelector("[data-testid=wysiwyg-code-language]");
            if (codeInputReady && codeInput instanceof HTMLTextAreaElement && languageInput instanceof HTMLInputElement) {
              const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
              textSetter?.call(codeInput, "const value = 2;");
              codeInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              inputSetter?.call(languageInput, "javascript");
              languageInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              codeStructuredApplied = await waitFor(() => {
                const text = document.querySelector(".cm-content")?.textContent ?? "";
                return text.includes("const value = 2;") && text.includes("javascript");
              });
              document.querySelector(".wysiwyg-source-card > div button:last-child")?.click();
            }
          }
          const headingForBlocks = [...document.querySelectorAll(".wysiwyg-editor-layer.active h1")].find((element) => element.textContent?.includes("Mermaid smoke"));
          if (headingForBlocks instanceof HTMLElement) {
            const rect = headingForBlocks.getBoundingClientRect();
            headingForBlocks.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const blockToolbarReady = await waitFor(() => {
              const select = document.querySelector(".wysiwyg-block-toolbar select");
              return select instanceof HTMLSelectElement && !select.disabled;
            });
            const insertSelect = document.querySelector(".wysiwyg-block-toolbar select");
            if (blockToolbarReady && insertSelect instanceof HTMLSelectElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
              setter?.call(insertSelect, "quote");
              insertSelect.dispatchEvent(new Event("change", { bubbles: true }));
              [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.includes("下方插入"))?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              blockInserted = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].some((element) => element.textContent?.includes("新引用")));
            }
          }
          const insertedQuote = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (insertedQuote instanceof HTMLElement) {
            const rect = insertedQuote.getBoundingClientRect();
            insertedQuote.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const gripReady = await waitFor(() => {
              const button = document.querySelector(".wysiwyg-block-grip");
              return button instanceof HTMLButtonElement && !button.disabled;
            });
            const grip = document.querySelector(".wysiwyg-block-grip");
            const targetHeading = document.querySelector(".wysiwyg-editor-layer.active h1");
            if (gripReady && grip instanceof HTMLButtonElement && targetHeading instanceof HTMLElement) {
              const transfer = new DataTransfer();
              grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
              const targetRect = targetHeading.getBoundingClientRect();
              targetHeading.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: targetRect.top + 1, dataTransfer: transfer }));
              targetHeading.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: targetRect.top + 1, dataTransfer: transfer }));
              blockDragged = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content > blockquote")?.textContent?.includes("新引用") ?? false);
            }
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          const quoteForKeyboard = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForKeyboard instanceof HTMLElement) {
            const rect = quoteForKeyboard.getBoundingClientRect();
            const paragraph = quoteForKeyboard.querySelector("p") ?? quoteForKeyboard;
            paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            paragraph.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
            blockKeyboardMoved = await waitFor(() => {
              const first = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content > :first-child");
              return !(first instanceof HTMLQuoteElement) && [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1;
            });
            blockToolbarPersistent = await waitFor(() => {
              const activeBlock = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-block-active");
              const enabledMove = [...document.querySelectorAll(".wysiwyg-block-toolbar button")]
                .some((button) => (button.textContent?.trim() === "上移" || button.textContent?.trim() === "下移") && button instanceof HTMLButtonElement && !button.disabled);
              return activeBlock?.textContent?.includes("新引用") === true && enabledMove;
            });
            const activeBeforeRepeat = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-block-active");
            const beforeRepeatFrom = activeBeforeRepeat instanceof HTMLElement ? activeBeforeRepeat.dataset.sourceFrom : undefined;
            const repeatMoveButton = [...document.querySelectorAll(".wysiwyg-block-toolbar button")]
              .find((button) => (button.textContent?.trim() === "下移" || button.textContent?.trim() === "上移") && button instanceof HTMLButtonElement && !button.disabled);
            if (repeatMoveButton instanceof HTMLButtonElement) {
              repeatMoveButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              blockToolbarRepeatedMove = await waitFor(() => {
                const activeAfterRepeat = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-block-active");
                return activeAfterRepeat instanceof HTMLElement
                  && activeAfterRepeat.textContent?.includes("新引用") === true
                  && activeAfterRepeat.dataset.sourceFrom !== beforeRepeatFrom
                  && [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button instanceof HTMLButtonElement && !button.disabled);
              });
            }
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          const quoteForDuplicate = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForDuplicate instanceof HTMLElement) {
            const rect = quoteForDuplicate.getBoundingClientRect();
            quoteForDuplicate.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            await waitFor(() => [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button.textContent?.trim() === "复制" && button instanceof HTMLButtonElement && !button.disabled));
            [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.trim() === "复制")?.click();
            blockDuplicated = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 2);
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 2);
          const quoteForDelete = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForDelete instanceof HTMLElement) {
            const rect = quoteForDelete.getBoundingClientRect();
            quoteForDelete.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            await waitFor(() => [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button.textContent?.trim() === "删除" && button instanceof HTMLButtonElement && !button.disabled));
            const originalConfirm = window.confirm;
            window.confirm = () => true;
            [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.trim() === "删除")?.click();
            window.confirm = originalConfirm;
            blockDeleted = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          }
          const emptyItems = [...document.querySelectorAll('.wysiwyg-editor-layer.active [data-wysiwyg-editability=direct]')]
            .filter((item) => item.closest("li") && !(item.textContent ?? "").trim());
          const emptyItem = emptyItems[0];
          if (emptyItem instanceof HTMLElement) {
            const rect = emptyItem.getBoundingClientRect();
            emptyItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            if (await waitFor(() => emptyItem.isContentEditable)) {
              emptyItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
              const firstDeleted = await waitFor(() => [...document.querySelectorAll('.wysiwyg-editor-layer.active [data-wysiwyg-editability=direct]')]
                .filter((item) => item.closest("li") && !(item.textContent ?? "").trim()).length === emptyItems.length - 1);
              const nextItem = document.activeElement;
              if (firstDeleted && nextItem instanceof HTMLElement && nextItem.closest("li")) {
                nextItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true, repeat: true }));
                emptyListItemDeleted = await waitFor(() => [...document.querySelectorAll('.wysiwyg-editor-layer.active [data-wysiwyg-editability=direct]')]
                  .filter((item) => item.closest("li") && !(item.textContent ?? "").trim()).length === emptyItems.length - 2);
              }
            }
          }
          sourceButton.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            exists: true,
            ready,
            edited,
            directInputReady,
            caretInside,
            browserInserted,
            formatted,
            paragraphBreaks,
            mergedParagraphs,
            compositionDeferred,
            blankParagraphAdded,
            blankParagraphDeduplicated,
            blankParagraphDeleted,
            multilinePasteHandled,
            imageAltEdited,
            formulaStructuredApplied,
            codeStructuredApplied,
            linkStructuredApplied,
            inlineCodeStructuredApplied,
            mixedInlineEdited,
            mixedAtomsProtected,
            protectedSelectionRejected,
            crossBlockFormatted,
            crossBlockPasted,
            crossBlockProtectedRejected,
            dualFormatCopy,
            selectAllCopy,
            externalHtmlPaste,
            imaRichPaste,
            imaPasteSnapshot,
            blockInserted,
            blockDragged,
            blockDuplicated,
            blockDeleted,
            blockKeyboardMoved,
            headingLevelsApplied,
            headingLevelTrace,
            italicChineseApplied,
            italicChineseVisible,
            italicToggleOff,
            boldToggleOff,
            formatSelectionRetained,
            toolbarLinkApplied,
            blockToolbarPersistent,
            blockToolbarRepeatedMove,
            repeatedBreaksCompacted,
            emptyListItemDeleted,
            tableCellEdited,
            tableColumnInserted,
            tableAlignmentApplied,
            tableRowAppended,
            listItemEdited,
            listDirectReady,
            listBrowserInserted,
            listIndented,
            listOutdented,
            nestedParentEdited,
            nestedSubtreeIndented,
            nestedSubtreeOutdented,
            quoteEdited,
            taskToggled,
            multilinePasteError,
            undone,
            redone,
            sourceCardApplied,
            sourceAreaReady,
            sourceAreaValue: sourceArea instanceof HTMLTextAreaElement ? sourceArea.value : "",
            sourceCardLabel: document.querySelector(".wysiwyg-source-card")?.getAttribute("aria-label") ?? "",
            visualWasActive: visualButton.getAttribute("aria-pressed") === "false",
            sourceRestored: sourceButton.getAttribute("aria-pressed") === "true" && Boolean(document.querySelector(".source-editor-layer.active")) && Boolean(document.querySelector(".split-handle")),
            afterEdit,
            afterUndo,
            afterRedo
          };
          } catch (error) {
            return { exists: true, testError: error instanceof Error ? error.name + ": " + error.message + "\\n" + (error.stack ?? "") : String(error) };
          }
        })()`, true) as { exists: boolean } : { exists: false };
        const viewWorkflow = await window.webContents.executeJavaScript(`(async () => {
          try {
          const waitFor = async (predicate, timeout = 8000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          const visualButton = document.querySelector('button[aria-label="写作模式"]');
          const sourceButton = document.querySelector('button[aria-label="源码模式"]');
          if (!(visualButton instanceof HTMLButtonElement) || !(sourceButton instanceof HTMLButtonElement)) return { fontControl: false, scrollPreserved: false, directPreview: false, previewMermaid: false, inlineOutline: false, outlineButtonRemoved: false, repairButtonRemoved: false, searchButton: false };
          visualButton.click();
          await waitFor(() => Boolean(document.querySelector(".editor-pane.editor-mode-wysiwyg .cm-editor.cm-live-preview")));
          const container = document.querySelector(".editor-pane.editor-mode-wysiwyg .cm-scroller");
          const fontPreset = document.querySelector("[data-testid=wysiwyg-font-preset]");
          const defaultFont = document.querySelector(".wysiwyg-font-default");
          let scrollPreserved = false;
          if (container instanceof HTMLElement && fontPreset instanceof HTMLSelectElement) {
            const hasScrollableContent = container.scrollHeight > container.clientHeight + 1;
            container.scrollTop = hasScrollableContent ? Math.min(700, container.scrollHeight - container.clientHeight) : 0;
            const before = container.scrollTop;
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
            setter?.call(fontPreset, fontPreset.value === "KaiTi" ? "Arial" : "KaiTi");
            fontPreset.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 500));
            scrollPreserved = !hasScrollableContent || (before > 0 && container.scrollTop > 0);
          }
          if (defaultFont instanceof HTMLButtonElement) defaultFont.click();
          const resetApplied = await waitFor(() => fontPreset instanceof HTMLSelectElement && fontPreset.value === "Microsoft YaHei UI" && container instanceof HTMLElement && getComputedStyle(container).fontFamily.includes("Microsoft YaHei UI") && window.localStorage.getItem("fantastic-editor-preview-font") === "Microsoft YaHei UI");
          document.querySelector('button[aria-label="分栏"]')?.click();
          const directPreview = await waitFor(() => Boolean(document.querySelector(".document-stage.view-split .preview-pane")));
          const previewResetApplied = directPreview && await waitFor(() => { const preview = document.querySelector(".markdown-preview"); return preview instanceof HTMLElement && getComputedStyle(preview).fontFamily.includes("Microsoft YaHei UI"); });
          const previewMermaid = directPreview && await waitFor(() => Boolean(document.querySelector(".document-stage.view-split .mermaid-diagram svg")));
          const outlineButtonRemoved = ![...document.querySelectorAll(".header-nav-button")].some((button) => button.textContent?.includes("目录"));
          const openEditorButton = document.querySelector(".open-editor-select");
          openEditorButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          const inlineOutline = await waitFor(() => Boolean(document.querySelector(".open-editor-entry .inline-outline .document-outline")));
          const repairControl = document.querySelector('[data-testid="repair-web-markdown"]');
          const repairButtonRemoved = repairControl === null;
          const searchButton = Boolean(document.querySelector('button[aria-label="搜索"]'));
          document.querySelector('button[aria-label="写作模式"]')?.click();
          sourceButton.click();
          await waitFor(() => Boolean(document.querySelector(".source-editor-layer.active")));
          return { fontControl: defaultFont instanceof HTMLButtonElement && fontPreset instanceof HTMLSelectElement && fontPreset.options.length >= 7 && fontPreset.getAttribute("aria-label") === "正文字体" && fontPreset.closest("label")?.title.includes("导出") === true && resetApplied && previewResetApplied, scrollPreserved, directPreview, previewMermaid, inlineOutline, outlineButtonRemoved, repairButtonRemoved, searchButton };
          } catch (error) {
            return { fontControl: false, scrollPreserved: false, directPreview: false, previewMermaid: false, inlineOutline: false, outlineButtonRemoved: false, repairButtonRemoved: false, searchButton: false, testError: error instanceof Error ? error.name + ": " + error.message + "\\n" + (error.stack ?? "") : String(error) };
          }
        })()`, true) as { fontControl: boolean; scrollPreserved: boolean; directPreview: boolean; previewMermaid: boolean; inlineOutline: boolean; outlineButtonRemoved: boolean; repairButtonRemoved: boolean; searchButton: boolean };
        const imageBridge = await window.webContents.executeJavaScript(`(async () => {
          const binary = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="), character => character.charCodeAt(0));
          const file = new File([binary], "smoke.png", { type: "image/png" });
          const result = await window.fantasticEditor.importDroppedImages({ importRequestId: "image-import-smoke", sessionId: "smoke-session", documentId: "smoke-document", workspaceRevision: 1 }, [file]);
          return { status: result.status, error: result.error ?? "" };
        })()`, true) as { status: string; error: string };
        const themeBefore = await window.webContents.executeJavaScript(`document.querySelector(\".app-shell\")?.classList.contains(\"theme-dark\") ?? false`, true) as boolean;
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label*="切换浅色模式"],button[aria-label*="切换深色模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const themeAfter = await window.webContents.executeJavaScript(`document.querySelector(\".app-shell\")?.classList.contains(\"theme-dark\") ?? false`, true) as boolean;
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        window.show();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await window.webContents.capturePage();
        await writeFile(join(process.cwd(), "fantastic-editor-ui-smoke.png"), image.toPNG());
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label*="切换浅色模式"],button[aria-label*="切换深色模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (syncEnabled !== syncBefore) await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
        if (!after.hasSidebarResizeHandle || !accessibility.keyboardSidebarSeparator || !accessibility.sidebarToggle) throw new Error(`Resource explorer resize or visibility smoke failed: ${JSON.stringify({ hasSidebarResizeHandle: after.hasSidebarResizeHandle, keyboardSidebarSeparator: accessibility.keyboardSidebarSeparator, sidebarToggle: accessibility.sidebarToggle })}`);
        const valid = uiReady && before.hasTabs && before.dropHintRemoved && before.tabStripFillsAvailableWidth && before.hasNewButton && drag.hasDropOverlay && after.tabCount === 1 && after.tabText === "未命名" && after.editorText === "" && after.saveEnabled && after.hasUnsavedIndicator && after.brandText.includes("fantasticeditor") && after.hasSidebar && after.hasSplitHandle && !after.hasInsertImageButton && after.hasSmartPunctuationButton && after.hasSyncScrollButton && after.viewportFits && splitHeaderLayout.contained && splitHeaderLayout.previewScrollable && accessibility.keyboardSeparator && accessibility.selectedTab && accessibility.liveStatus && recentBoundary.listed && recentBoundary.opaque && tabShortcuts.created && tabShortcuts.reorderedLeft && tabShortcuts.reorderedRight && tabShortcuts.previous && tabShortcuts.next && tabShortcuts.closed && fontControl.exists && fontControl.applied && fontControl.hasArial && fontControl.accurateLabel && fontApplied && performanceMetric.exists && performanceMetric.text.includes("解析") && performanceMetric.accessible && wechatThemePreview.opened && wechatThemePreview.completed && wechatThemePreview.widthCount === 3 && wechatThemePreview.hasHeadingAuditCopy && wechatThemePreview.hasActions && wechatThemePreview.keyboardDialog && wechatThemePreview.focusRestored && /ON|OFF/.test(syncTextBefore) && syncBefore !== "missing" && syncAfter !== syncBefore && syncEnabled === "true" && viewWorkflow.fontControl && viewWorkflow.scrollPreserved && viewWorkflow.directPreview && viewWorkflow.inlineOutline && viewWorkflow.outlineButtonRemoved && viewWorkflow.repairButtonRemoved && viewWorkflow.searchButton && imageBridge.status === "failed" && imageBridge.error.includes("会话") && themeAfter !== themeBefore;
        console.log(JSON.stringify({ uiReady, before, drag, after, splitHeaderLayout, accessibility, recentBoundary, tabShortcuts, fontControl, fontApplied, mermaidEditorText, mermaidDebug, mermaidRendered, performanceMetric, wechatThemePreview, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled }, wysiwyg, viewWorkflow, imageBridge, theme: { before: themeBefore, after: themeAfter }, screenshot: "fantastic-editor-ui-smoke.png", valid }));
      await finishSmoke("ui", valid === true, { uiReady, before, drag, after, splitHeaderLayout, accessibility, recentBoundary, tabShortcuts, fontControl, fontApplied, mermaidEditorText, mermaidDebug, mermaidRendered, performanceMetric, wechatThemePreview, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled }, wysiwyg, viewWorkflow, imageBridge, theme: { before: themeBefore, after: themeAfter } });
      })().catch((error: unknown) => {
        const diagnostic = error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack ?? "" }
          : { message: String(error) };
        console.error(error);
        void finishSmoke("ui", false, { error: diagnostic });
      });
    });
    window.webContents.once("did-fail-load", (_event, code, description) => { console.error(`Renderer load failed (${code}): ${description}`); void finishSmoke("ui", false); });
  } else if (process.env.FANTASTIC_EDITOR_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => { void finishSmoke("basic", true); });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`Renderer load failed (${code}): ${description}`);
      void finishSmoke("basic", false);
    });
  } else {
    return false;
  }
  return true;
}
