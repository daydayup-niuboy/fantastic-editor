import { useEffect, useRef, useState } from "react";
import type { AiProviderId, DeepSeekConfigResult } from "@fantastic-editor/shared";

type FixedProviderId = Extract<AiProviderId, "deepseek-api" | "gemini-api" | "kimi-api" | "minimax-api">;
type ConnectionResult = { status: "connected" } | { status: "failed"; error: string };
type FixedProviderConfig = {
  displayName: string;
  description: string;
  placeholder: string;
  save: (request: { apiKey: string }) => Promise<DeepSeekConfigResult>;
  clear: () => Promise<DeepSeekConfigResult>;
  test: () => Promise<ConnectionResult>;
};

const SUCCESS_MESSAGE_MS = 5_000;
const PROVIDERS: Record<FixedProviderId, FixedProviderConfig> = {
  "deepseek-api": {
    displayName: "DeepSeek",
    description: "密钥使用 Windows 加密保存，只由主进程发送到 DeepSeek 官方接口；测试连接会产生一次联网请求。",
    placeholder: "sk-…",
    save: (request) => window.fantasticEditor.saveDeepSeekConfig(request),
    clear: () => window.fantasticEditor.clearDeepSeekConfig(),
    test: () => window.fantasticEditor.testDeepSeekConnection(),
  },
  "gemini-api": {
    displayName: "Gemini",
    description: "密钥使用 Windows 加密保存，只由主进程发送到 Google 官方 Gemini 接口；测试连接会产生一次联网请求。",
    placeholder: "AIza…",
    save: (request) => window.fantasticEditor.saveGeminiConfig(request),
    clear: () => window.fantasticEditor.clearGeminiConfig(),
    test: () => window.fantasticEditor.testGeminiConnection(),
  },
  "kimi-api": {
    displayName: "Kimi",
    description: "密钥使用 Windows 加密保存，只由主进程发送到 Moonshot 官方接口（api.moonshot.cn），固定使用 kimi-k3；测试连接会产生一次联网请求。",
    placeholder: "sk-…",
    save: (request) => window.fantasticEditor.saveKimiConfig(request),
    clear: () => window.fantasticEditor.clearKimiConfig(),
    test: () => window.fantasticEditor.testKimiConnection(),
  },
  "minimax-api": {
    displayName: "MiniMax",
    description: "密钥使用 Windows 加密保存，只由主进程发送到 MiniMax 官方接口（api.minimax.cn），固定使用 MiniMax-M3；测试连接会产生一次联网请求。",
    placeholder: "粘贴接口密钥",
    save: (request) => window.fantasticEditor.saveMiniMaxConfig(request),
    clear: () => window.fantasticEditor.clearMiniMaxConfig(),
    test: () => window.fantasticEditor.testMiniMaxConnection(),
  },
};

export function FixedAiProviderConfig({ providerId, configured, disabled, onProvidersChanged }: {
  providerId: FixedProviderId;
  configured: boolean;
  disabled: boolean;
  onProvidersChanged: () => void;
}) {
  const provider = PROVIDERS[providerId];
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const flashTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);

  const showMessage = (text: string, temporary = false) => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setMessage(text);
    if (temporary) flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setMessage("");
    }, SUCCESS_MESSAGE_MS);
  };

  const saveAndTest = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    showMessage("");
    let saved = false;
    try {
      const result = await provider.save({ apiKey });
      if (result.status === "failed") { showMessage(result.error); return; }
      saved = true;
      setApiKey("");
      showMessage("已加密保存。正在测试连接…");
      const tested = await provider.test();
      if (tested.status === "connected") showMessage(`连接成功，可以使用 ${provider.displayName}。`, true);
      else showMessage(tested.error);
    } catch {
      showMessage("配置操作失败，请检查应用状态后重试。");
    } finally {
      setBusy(false);
      if (saved) onProvidersChanged();
    }
  };

  const testConnection = async () => {
    setBusy(true);
    showMessage("");
    try {
      const result = await provider.test();
      if (result.status === "connected") showMessage("连接正常，可以调用模型。", true);
      else showMessage(result.error);
    } catch {
      showMessage("连接测试失败，请检查网络和 API Key 后重试。");
    } finally { setBusy(false); }
  };

  const clearKey = async () => {
    setBusy(true);
    showMessage("");
    try {
      const result = await provider.clear();
      if (result.status === "failed") { showMessage(result.error); return; }
      setApiKey("");
      showMessage("API Key 已删除。");
      onProvidersChanged();
    } catch {
      showMessage("删除 API Key 失败，请重试。");
    } finally { setBusy(false); }
  };

  const isDisabled = busy || disabled;
  return configured ? <>
    <div className="ai-api-toolbar"><span>{provider.displayName} API Key 已加密保存</span><button type="button" disabled={isDisabled} onClick={() => void testConnection()}>{busy ? "测试中…" : "测试连接"}</button><button type="button" disabled={isDisabled} onClick={() => void clearKey()}>删除密钥</button></div>
    {message && <small role="status">{message}</small>}
  </> : <div className="ai-empty ai-api-config">
    <strong>配置 {provider.displayName} API</strong><span>{provider.description}</span>
    <input type="password" aria-label={`${provider.displayName} API Key`} autoComplete="off" placeholder={provider.placeholder} value={apiKey} disabled={isDisabled} onChange={(event) => setApiKey(event.target.value)} />
    <div><button type="button" disabled={isDisabled || !apiKey.trim()} onClick={() => void saveAndTest()}>{busy ? "处理中…" : "保存并测试"}</button><button type="button" disabled={isDisabled} onClick={() => void clearKey()}>删除密钥</button></div>
    {message && <small role="status">{message}</small>}
  </div>;
}
