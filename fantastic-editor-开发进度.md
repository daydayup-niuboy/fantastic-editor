# fantastic-editor 开发进度

> 更新日期：2026-08-25  
> 当前里程碑：阶段 4 代码闭环；进入真实环境验收与 Windows 发布准备

## 当前可用能力

- Windows Electron + React + TypeScript + CodeMirror 桌面应用可实际启动。
- 主界面提供新建（含 Ctrl+N）、可关闭/切换的多文档选项卡，以及窗口级 `.md` / `.markdown` 多文件拖入；各选项卡独立保留未保存草稿。
- 已实现图片拖放与按钮插入：图片落到 CodeMirror 指定坐标，或插入当前光标/选择区；异步导入锚点随编辑事务映射，多图保持顺序并用空行分隔。
- 图片由主进程校验文件签名、MIME、单图/总量预算和会话身份后写入 Markdown 同级 `assets/`；使用内容哈希防覆盖并复用相同目标，Renderer 不接收源/目标绝对路径。未命名文档会先另存为。
- 导入图片重新进入标准 ParseRequest → ResolveRequest → PreviewSession 管线并同步预览；同一 ImageNode 自动进入 PDF、DOCX、离线 HTML和公众号方案 B 图片替换清单。
- 已实现本地会话恢复：打开标签和未保存草稿以防抖方式写入主进程多代快照；损坏的最新快照可回退上一代。原文件缺失时恢复为未命名文档，原文件在退出期间被外部修改时仍保持保存冲突保护。
- 已完成第一轮产品级 UI 重构：精简顶栏、资源管理器、现代选项卡、欢迎页、统一导出菜单、编辑/分栏/预览三种视图、可拖动分隔线，以及可记忆的浅色/深色主题。
- 已实现可记忆的“同步滚动”开关：P0 由编辑区单向驱动预览区，使用 UTF-16 SourceRange 块级锚点和区间插值，不按整页百分比；快速滚动通过 requestAnimationFrame 合并。
- CodeMirror 非空主选区会在预览区显示独立、不可点击的块级范围提示框；跨块显示多个框，图片精确选区优先提示图片。编辑导致预览身份过期时立即隐藏，图片/公式/分栏尺寸变化后由 ResizeObserver 重新测量。
- data-source 内部标记和 SelectionOverlay 只存在于实时预览 Renderer，不进入 ParsedDocument、PreviewSession IPC、恢复稿、PDF、DOCX、离线 HTML或公众号输出。
- 可打开单个本地 Markdown 文件，也可显式打开文件夹并递归列出 Markdown 文件；单文件模式不会递归扫描父目录。
- 支持编辑、保存、另存为、未保存提示、UTF-8 BOM 与 LF/CRLF 往返、外部修改冲突检测；混合换行必须选择统一为 LF 或 CRLF，GBK/GB18030 候选必须预览并明确确认转为 UTF-8，确认后立即标记为未保存。
- 预览使用唯一 `document-core` 语义，支持 P0 Markdown、KaTeX 公式、本地栅格图片和隔离转换后的 SVG。
- 资源访问具有 workspace/document/grant/revision 身份校验、realpath 边界检查、Junction 防逃逸、内容哈希和短期句柄。
- 源 Markdown data URI 固定阻止并脱敏，不进入 ParsedDocument、资源快照、IPC、缓存或日志。
- PDF：独立隐藏 BrowserWindow，等待字体和图片就绪后调用 `printToPDF`；每个任务独立 Session、窗口、临时目录，支持取消和 45 秒超时。
- Word：Node Utility Process 生成 DOCX，支持标题、段落、行内样式、链接、列表、引用、代码、表格、图片与公式 PNG。
- 离线 HTML：单文件、无脚本、自包含 KaTeX CSS/字体，图片只从已授权且重新校验的字节生成 Data URI；20 MiB 软上限、50 MiB 硬上限。
- 微信公众号：实现方案 B（文字与内联主题复制 + 连续编号图片/公式占位 + 图片替换助手）。没有把未经真实验证的多图自动复制宣传为成功。
- 公众号替换图片只保留在主进程；Renderer 只收到 jobId/itemId 和无路径元数据。点击“复制此图片”后由主进程写系统位图剪贴板。
- 所有输出统一使用不可变任务身份、预检、一次任务范围的精确省略批准、取消/超时和五种终态；“部分完成”不会显示为“完整成功”。
- 已完成大文档/大图片第一轮稳定性收尾：打开前按文件大小拒绝、解析前按字符数与资源数拒绝；新解析会真正终止旧 Worker；解析与恢复防抖随文档大小自适应，恢复快照只保留最新待写任务。
- 图片与公式实行共享容量预算：单资源 50 MiB、单篇 10,000 个资源引用、去重后的解析/单次导出资源总量 200 MiB、单次图片化公式 500 项；同内容栅格图在导出收集与进程传输前复用同一字节对象。
- 已配置 electron-builder + NSIS Windows x64 打包流程，命令为 `npm run dist:win`；生成 `release/fantastic-editor-0.1.0-setup.exe`，安装目录可自定义，并创建开始菜单/桌面快捷方式。

## 当前验证结果

- 自动测试：25 个测试文件，140 项通过。
- TypeScript 严格类型检查：通过。
- Electron 生产构建：通过。
- 生产 Electron UI 冒烟：沙箱 preload、主窗口、品牌区、资源管理器、选项卡、新建文档、图片插入按钮、编辑/预览分栏、无横向溢出、拖拽覆盖层、主题切换和同步滚动开关均通过；可信 Ctrl+A 输入产生 1 个预览范围提示框；浏览器 File 经 contextBridge 到达主进程并执行会话校验。
- 隔离公式窗口冒烟：真实 KaTeX PNG 生成通过。
- DOCX Utility Process 冒烟：真实 DOCX ZIP 数据生成通过。
- PDF 冒烟：真实 Chromium `printToPDF` 生成通过。
- 公众号冒烟：Utility Process 主题 HTML 生成及系统 HTML 剪贴板写入/读回通过。
- npm 安全审计：0 个已知漏洞。
- 本机 Node 开发基准（2026-08-25，非跨机器承诺）：约 72 万字符文档解析 724 ms、预览 HTML 125 ms；10,000 个图片引用约 659 ms；5,000 个公式节点约 148 ms。另有 36 万字符解析/预览自动压力用例，5 秒硬超时内通过。

## 关键安全与一致性约束

- Renderer 不接收绝对文件路径、源图片字节或主进程资源句柄内部信息。
- Worker 只解析；文件系统解析由主进程完成。
- PDF 不进入 Utility Process；DOCX、离线 HTML 和公众号 HTML 不调用 `printToPDF`。
- SVG 预览派生缓存与导出期 DerivedAssetManifest 分离。
- 公式派生键使用 SourceRange + LaTeX 哈希 + displayMode，不依赖不稳定 nodeId。
- 公式隔离窗口在每个导出任务完成后销毁，不跨 jobId 复用 DOM 或 Session。
- 公众号 HTML 写剪贴板前再次拒绝 `file:`、`blob:`、localhost、应用内部协议、脚本和事件属性。

## 尚需真实环境验收/发布工作

以下项目不能仅靠本地自动测试宣称完成：

1. 使用已登录的真实微信公众号后台，按技术验证方案完成粘贴、保存、关闭重开、跨端预览和图片逐项替换记录；据结果决定是否继续保留方案 B，或冻结经过验证的方案 A。
2. 在没有安装开发机字体的另一台参考 Windows 机器检查 PDF 中文与公式显示，并记录 Chromium 分页边界。
3. 用冻结的目标 Microsoft Word 版本打开 DOCX 固定样例，检查复杂表格、超长代码块和图片分页。
4. 在第二台参考 Windows 机器做长时间大文档编辑与接近 200 MiB 图片预算的持续压力验收，记录峰值内存和交互延迟。
5. 已生成未签名 Windows 安装包；仍需配置代码签名证书，补齐升级、卸载和发布说明。当前打包使用 Electron 默认图标。

## 建议下一阶段

- 第一优先：执行真实公众号方案 B 回归并保存验证记录，这是当前唯一无法由本机代码替代的核心产品决策。
- 第二优先：固定 PDF/DOCX 样例，在第二台 Windows 与目标 Word 上验收。
- 第三优先：Windows 安装包、性能和可访问性收尾。



