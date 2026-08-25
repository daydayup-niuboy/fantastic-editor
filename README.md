# fantastic-editor

fantastic-editor 是面向 Windows 的本地优先 Markdown 编辑器，可打开单文件或文件夹工作区，编辑并预览包含本地图片与 KaTeX 公式的 Markdown，导出 PDF、Word、单文件离线 HTML，并按微信公众号方案 B 复制排版正文和逐项替换图片。

主界面提供“新建”、多文档选项卡和窗口级拖拽打开；可一次拖入多个 `.md` / `.markdown` 文件，并在选项卡间保留各自未保存草稿。图片可拖到 CodeMirror 编辑区的具体位置，或通过“插入图片”按钮放到当前光标/选择区；应用将其安全复制到 Markdown 同级 `assets/`、插入相对引用并同步预览。界面包含资源管理器、欢迎页、可拖动编辑/预览分栏、编辑/分栏/预览三种视图、统一导出菜单，以及可记忆的浅色/深色主题和“同步滚动”开关。开启后编辑区按 SourceRange 语义锚点驱动预览区；框选源码时，预览显示对应的块级范围提示框。

应用会在本地自动保存打开标签和未保存草稿的恢复快照。再次启动时自动恢复；若原文件已被外部修改，保存仍会触发冲突保护，若原文件已丢失则草稿以未命名文档恢复。

## 运行

需要 Node.js 24 或更高版本。

```powershell
npm install
npm start
```

`npm start` 会先执行生产构建，再启动 Electron 应用。日常开发使用：

```powershell
npm run dev
```

## 验证

```powershell
npm test
npm run typecheck
npm run build
npm run dist:win
npm audit --audit-level=high
```

当前基线：25 个测试文件、140 项测试通过；真实 Electron UI 冒烟已验证主界面、文档选项卡、新建文档、资源管理器、可调分栏、无横向溢出、拖拽覆盖层、主题切换、同步滚动按钮和 CodeMirror 选区范围提示，公式 PNG、DOCX Utility Process、Chromium PDF 和系统 HTML 剪贴板生产冒烟均通过。

## 使用边界

- 公众号首版采用方案 B：正文和样式一次复制，图片及公式生成编号占位，再由替换助手逐张复制。应用不会把该流程称为“带图一键发布”。
- 公众号直接账号授权、素材上传、草稿创建和发布不在 P0。
- 源 Markdown data URI 固定阻止；导出 Data URI 只能从主进程已授权并重新校验的本地资源字节生成。
- 单篇文档编辑上限为 1,000 万字符，打开/保存的 Markdown 文件上限为 40 MiB；单篇最多解析 10,000 个资源引用，单资源上限 50 MiB，单次解析/导出的去重图片与公式资源总预算为 200 MiB，单次需图片化的公式最多 500 项。超过边界会明确失败或产生阻断诊断，不会静默截断。
- 大文档输入会自适应延长解析与恢复快照防抖；新解析会终止旧 Worker，恢复写入只保留最新待写快照，重复图片按内容哈希复用导出字节。
- 图片导入支持 PNG、JPEG、GIF、WEBP、SVG。未命名文档先另存为；主进程校验文件签名、容量和工作区身份，文件使用“安全化名称 + 内容哈希”写入 `assets/`。撤销 Markdown 引用不会自动删除图片文件。
- 同步滚动 P0 为“编辑区 → 预览区”单向模式；预览主动滚动不会反向移动编辑器。选区提示为块级语义范围，不承诺将 Markdown 标记符逐字符映射到预览文字。
- 混合换行不会静默统一；打开时必须选择 LF 或 CRLF。非 UTF-8 文件会显示 GBK/GB18030 候选预览，只有明确确认后才转换为 UTF-8，并立即标记为未保存。
- 真正的公众号草稿持久化、跨端预览，以及跨机器 PDF 字体显示仍需按项目验证方案在目标环境人工验收。

## 工作区

- `packages/document-core`：唯一 Markdown 解析与 UDM 语义来源。
- `packages/shared`：可结构化克隆的共享类型和最小 IPC 契约。
- `apps/desktop`：Electron 主进程、sandboxed Renderer、隔离公式/PDF 窗口和 Utility Process 输出适配器。

详细规格见项目根目录的三份开发文档；当前实现状态见 `fantastic-editor-开发进度.md`。Windows x64 安装包生成于 `release/fantastic-editor-0.1.0-setup.exe`；当前未配置代码签名证书，安装器使用 Electron 默认图标。



