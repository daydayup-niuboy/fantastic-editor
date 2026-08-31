import { Icon } from "./Icon";
import type { RecentFileEntry } from "@fantastic-editor/shared";

interface WelcomeScreenProps {
  onNew(): void;
  onOpen(): void;
  onOpenFolder(): void;
  recentFiles: RecentFileEntry[];
  onOpenRecent(recentId: string): void;
}

export function WelcomeScreen({ onNew, onOpen, onOpenFolder, recentFiles, onOpenRecent }: WelcomeScreenProps) {
  return (
    <section className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-mark"><Icon name="markdown" size={34} /></div>
        <p className="welcome-eyebrow">LOCAL-FIRST MARKDOWN WORKSPACE</p>
        <h1>让写作回到内容本身</h1>
        <p className="welcome-lead">在本地编辑 Markdown，实时预览公式与图片，并导出到你真正需要的格式。</p>
        <div className="welcome-actions">
          <button type="button" className="welcome-action primary" onClick={onNew}><Icon name="filePlus" /><span><strong>新建文档</strong><small>从空白 Markdown 开始</small></span><kbd>Ctrl N</kbd></button>
          <button type="button" className="welcome-action" onClick={onOpen}><Icon name="file" /><span><strong>打开文件</strong><small>选择本地 .md 或 .markdown</small></span><kbd>Ctrl O</kbd></button>
          <button type="button" className="welcome-action" onClick={onOpenFolder}><Icon name="folderOpen" /><span><strong>打开文件夹</strong><small>浏览一个 Markdown 工作区</small></span></button>
        </div>
        <div className="welcome-drop"><span>或将 Markdown 文件拖到窗口任意位置</span></div>
        {recentFiles.length > 0 && <section className="welcome-recent" aria-label="最近文件"><h2>最近文件</h2>{recentFiles.map((file) => <button type="button" key={file.recentId} onClick={() => onOpenRecent(file.recentId)}><Icon name="markdown" size={15} /><span><strong>{file.displayName}</strong><small>{new Date(file.lastOpenedAt).toLocaleString()}</small></span></button>)}</section>}
      </div>
    </section>
  );
}
