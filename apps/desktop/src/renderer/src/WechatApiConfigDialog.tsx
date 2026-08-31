import { useEffect, useRef, useState } from "react";
import type { WechatApiConfigSummary } from "@fantastic-editor/shared";

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; ip: string | null; message: string }
  | { status: "whitelist-required"; ip: string; message: string }
  | { status: "failed"; error: string };

interface WechatApiConfigDialogProps {
  open: boolean;
  config: WechatApiConfigSummary;
  onClose(): void;
  onSaved(config: WechatApiConfigSummary): void;
}

export function WechatApiConfigDialog({ open, config, onClose, onSaved }: WechatApiConfigDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const appIdInputRef = useRef<HTMLInputElement>(null);
  const [appId, setAppId] = useState(config.appId);
  const [appSecret, setAppSecret] = useState("");
  const [coverPath, setCoverPath] = useState(config.coverPath);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });
  const formComplete = Boolean(appId.trim() && coverPath.trim() && (appSecret.trim() || config.hasAppSecret));
  const hasUnsavedChanges = appId.trim() !== config.appId || coverPath.trim() !== config.coverPath || Boolean(appSecret.trim());

  useEffect(() => {
    if (!open) return;
    setAppId(config.appId);
    setAppSecret("");
    setCoverPath(config.coverPath);
    setMessage("");
    setConnection({ status: "idle" });
    const timer = window.setTimeout(() => appIdInputRef.current?.focus(), 0);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [config, onClose, open]);

  useEffect(() => {
    if (!open || !config.configured) return;
    let cancelled = false;
    setConnection({ status: "checking" });
    void window.fantasticEditor.testWechatApiConnection().then((result) => {
      if (cancelled) return;
      setConnection(result);
      if (result.status === "ready") setMessage("公众号配置与 IP 白名单均已就绪。");
      else if (result.status === "whitelist-required") setMessage(`请将 ${result.ip} 加入公众号 IP 白名单后重新检测。`);
      else setMessage(result.error);
    }).catch((error: unknown) => {
      if (cancelled) return;
      const errorMessage = error instanceof Error ? error.message : "公众号接口连接检测失败。";
      setConnection({ status: "failed", error: errorMessage });
      setMessage(errorMessage);
    });
    return () => { cancelled = true; };
  }, [config.configured, config.appId, open]);

  if (!open) return null;

  const selectCover = async () => {
    const result = await window.fantasticEditor.selectWechatCover();
    if (result.status === "selected") {
      setCoverPath(result.path);
      setMessage(`已选择封面：${result.displayName}`);
    } else if (result.status === "failed") setMessage(result.error);
  };

  const save = async () => {
    setBusy(true);
    setMessage("正在安全保存配置……");
    try {
      const result = await window.fantasticEditor.saveWechatApiConfig(appSecret
        ? { appId, appSecret, coverPath }
        : { appId, coverPath });
      if (result.status === "failed") {
        setMessage(result.error);
        return;
      }
      onSaved(result.config);
      setMessage("配置已安全保存，正在检测微信接口与 IP 白名单……");
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setConnection({ status: "checking" });
    try {
      const result = await window.fantasticEditor.testWechatApiConnection();
      setConnection(result);
      if (result.status === "ready") setMessage("公众号配置与 IP 白名单均已就绪。");
      else if (result.status === "whitelist-required") setMessage(`请将 ${result.ip} 加入公众号 IP 白名单后重新检测。`);
      else setMessage(result.error);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "公众号接口连接检测失败。";
      setConnection({ status: "failed", error: errorMessage });
      setMessage(errorMessage);
    }
  };

  const copyIp = async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      setMessage(`已复制当前公网 IP：${ip}`);
    } catch {
      setMessage(`当前公网 IP：${ip}。请手动复制。`);
    }
  };

  const saveOrTestConnection = async () => {
    if (!formComplete) {
      setMessage("请先完整填写 AppID、AppSecret，并选择封面图片。");
      return;
    }
    if (!config.configured || hasUnsavedChanges) {
      await save();
      return;
    }
    await testConnection();
  };

  const clear = async () => {
    if (!window.confirm("确定清除本机保存的公众号 AppID、加密 AppSecret 和封面路径吗？")) return;
    setBusy(true);
    try {
      const result = await window.fantasticEditor.clearWechatApiConfig();
      if (result.status === "failed") {
        setMessage(result.error);
        return;
      }
      setAppId(result.config.appId);
      setAppSecret("");
      setCoverPath(result.config.coverPath);
      setMessage(result.config.source === "environment" ? "本机保存项已清除，当前仍检测到环境变量配置。" : "本机公众号配置已清除。");
      onSaved(result.config);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wechat-config-overlay" role="dialog" aria-modal="true" aria-labelledby="wechat-config-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="wechat-config-dialog" ref={dialogRef}>
        <header>
          <div>
            <strong id="wechat-config-title">公众号 API 配置</strong>
            <small>用于批量上传正文图片并创建草稿，不会直接发布或群发。</small>
          </div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="关闭公众号 API 配置">关闭</button>
        </header>
        <div className="wechat-config-form">
          <label>
            <span>公众号 AppID</span>
            <input ref={appIdInputRef} value={appId} onChange={(event) => setAppId(event.target.value)} spellCheck={false} autoComplete="off" placeholder="例如 wx1234567890abcdef" />
          </label>
          <label>
            <span>公众号 AppSecret</span>
            <input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} spellCheck={false} autoComplete="new-password" placeholder={config.hasAppSecret ? "已安全保存；留空则保持不变" : "输入公众号 AppSecret"} />
            <small>AppSecret 使用 Windows 系统加密保存，重新打开配置时不会回显明文。</small>
          </label>
          <label>
            <span>默认封面图片</span>
            <div className="wechat-cover-picker">
              <input value={coverPath} readOnly placeholder="请选择 PNG 或 JPEG 封面图片" />
              <button type="button" disabled={busy} onClick={() => void selectCover()}>选择图片</button>
            </div>
            <small>封面必须是本地 PNG/JPEG，大小不超过 10 MiB。</small>
          </label>
          <section className={`wechat-whitelist-card ${connection.status}`} aria-labelledby="wechat-whitelist-title">
            <div className="wechat-whitelist-heading">
              <span><strong id="wechat-whitelist-title">IP 白名单与连接检测</strong><small>普通用户必须完成这一步，才能自动上传图片和创建草稿。</small></span>
              <a className="wechat-admin-link" href="https://mp.weixin.qq.com/" target="_blank" rel="noreferrer">打开公众号后台</a>
              <button type="button" disabled={busy || connection.status === "checking" || !formComplete} onClick={() => void saveOrTestConnection()}>
                {connection.status === "checking" ? "检测中…" : (!config.configured || hasUnsavedChanges) ? "保存并检测" : "重新检测"}
              </button>
            </div>
            {connection.status === "idle" && <p>{config.configured ? "点击“检测连接”，软件会通过微信接口检查白名单；若未放行，将显示微信识别到的当前公网 IP。" : "请先填写并保存 AppID、AppSecret 和封面图片，然后检测 IP 白名单。"}</p>}
            {connection.status === "ready" && (
              <div className="wechat-ready-result">
                <p className="wechat-connection-success">✓ {connection.message}</p>
                {connection.ip && <div><code>{connection.ip}</code><button type="button" onClick={() => void copyIp(connection.ip!)}>复制 IP</button></div>}
              </div>
            )}
            {connection.status === "whitelist-required" && (
              <div className="wechat-ip-warning">
                <strong>需要设置 IP 白名单</strong>
                <p>{connection.message}</p>
                <div><code>{connection.ip}</code><button type="button" onClick={() => void copyIp(connection.ip)}>复制 IP</button></div>
              </div>
            )}
            {connection.status === "failed" && <p className="wechat-connection-error">{connection.error}</p>}
            <ol>
              <li>登录迁移后的微信开发者平台，进入对应公众号。</li>
              <li>打开开发设置或接口设置中的“IP 白名单”。</li>
              <li>加入上方检测到的 IPv4 地址并保存，然后返回重新检测。</li>
            </ol>
            <small>未放行时 IP 取自微信 40164 响应；连接成功后通过 api.ipify.org 的只读 HTTPS 查询显示。家庭或办公网络的公网 IP 可能变化，请在再次出现 40164 时重新检测并更新白名单。</small>
          </section>
          {message && <p className="wechat-config-message" role="status" aria-live="polite">{message}</p>}
        </div>
        <footer>
          <button type="button" className="wechat-config-clear" disabled={busy} onClick={() => void clear()}>清除配置</button>
          <span />
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="wechat-config-save" disabled={busy} onClick={() => void save()}>{busy ? "处理中…" : "保存配置"}</button>
        </footer>
      </section>
    </div>
  );
}
