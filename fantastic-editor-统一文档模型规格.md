# fantastic-editor 统一文档模型规格

> 软件作者：Tbin · 联系邮箱：niuboy5188@gmail.com
> 规格标识：fantastic-editor UDM  
> 版本：1.3-draft
> 状态：核心模型已随 `0.2.0-rc.3` 冻结；`0.3.0-rc.1` 仅收口公众号草稿连接器与凭据/白名单边界，不改变 canonical 文档模型
> 关联文档：[fantastic-editor 开发项目书](fantastic-editor-开发项目书.md)

## 当前规格结论（2026-08-31）

- canonical `editorText` 仍是唯一保存来源；ParsedDocument、ResolutionSnapshot、PreviewSession、预览派生缓存和导出 DerivedAssetManifest 的分层保持不变。
- 源代码与所见即所得共用同一 Markdown、SourceRange 事务和撤销历史；可编辑 DOM、预览 SVG、选择框、同步滚动状态和临时资源句柄均不得成为文档数据。
- PDF 继续由隐藏 Chromium 窗口生成；DOCX、离线 HTML 和公众号 HTML 走隔离 Node/Utility 输出；公式和 Mermaid 导出为受控 PNG 派生资源。
- `0.3.0-rc.1` 的公众号自动草稿仍是输出侧连接器：Renderer 发送 `jobId`，主进程从已完成任务、加密凭据和受控资源中组装上传，不把 AppSecret、token、路径、HTML 或图片字节扩大到普通 IPC。
- 真实账号已经验证自动上传、草稿创建和回读链路，未发现需要修改 UDM schema 的问题。后续多账号如实施，应扩展凭据选择层，不得复制 ParsedDocument 或建立第二套附件模型。


## Mermaid 与排版偏好补充规格

### 模型表示

- Mermaid 不新增 `NodeType`。唯一语法来源是 `codeBlock`，且 `attributes.language.toLowerCase() === "mermaid"`；`attributes.value`、`SourceRange`、原始 fence 信息继续由 ParsedDocument 保存。
- `mermaidReferenceKey = SHA-256(SourceRange.from + SourceRange.to + "mermaid" + source)`，不得依赖易变 `nodeId` 或整篇 `sourceHash`。整篇 `sourceHash` 仅用于输出快照身份校验。
- 预览期 Mermaid SVG 属于 Renderer 临时 DOM，不进入 UDM。导出期 PNG 属于 `DerivedAssetManifest`，转换配置为 `mermaid-chromium-png-0.1`，`sourceReferenceKey` 与 `sourceContentHash` 为 null，派生键包含 Mermaid 引用键、转换配置与 PNG 内容哈希。

### 预览与导出约束

- 预览渲染使用严格安全模式、禁止外部网络，最多 100 个图、单图源码最多 100,000 字符。渲染失败必须显示稳定错误占位，不得把错误 SVG 或异常 DOM 当作成功结果。
- 导出隔离窗口必须启用 contextIsolation、sandbox、关闭 Node integration、阻止 HTTP/HTTPS 和导航；单图最大 4096 × 4096，超时 12 秒。缺图、超时、尺寸超限或派生资源哈希不匹配均产生 blocking 诊断，不能显示“完整成功”。
- `HtmlRenderOptions.renderCodeBlock` 是适配器替换 Mermaid 代码块的唯一扩展点；返回 undefined 时必须保持普通代码块默认渲染。

### 字体偏好

- 字体是用户界面和输出主题偏好，不是 ParsedDocument 字段。Renderer 以本机设置保存字体名称，发起输出时传入 `BeginOutputRequest.fontFamily`；主进程重新规范化后写入 `OutputTheme.tokens["typography.body.fontFamily"]`。 Renderer 的内置预设为微软雅黑、Segoe UI、Arial、等线、宋体和楷体，并保留自定义本机字体入口。
- 字体名称最大 64 字符，禁止控制字符和 `{ } ; < >`。适配器必须提供后备字体；字体不存在只允许降级，不得改变 Markdown 或使任务失败。
- `BeginOutputRequest.darkMode` 只用于主题身份和未来输出主题选择，不写入 ParsedDocument。当前白底导出固定使用 Mermaid 浅色主题，避免深色节点在 PDF、Word、离线 HTML 或公众号白底中失去可读性。

### 同步滚动开关视图

- ON/OFF 是 `syncScrollEnabled` 的可视化文本，`aria-pressed` 仍是可访问性真值。按钮文案、样式或图标不得成为同步逻辑的数据源。

## 源代码 / 所见即所得双编辑模式补充规格（首轮已实现）

> 首轮实现已使用 `WysiwygTextChange { from, to, insert, expectedText }` 做快照校验和最小文本补丁，并把事务提交到常驻 CodeMirror 历史。复杂块暂用 SourceRange 源码卡片，后续结构化命令仍必须遵守本节模型。
>
> 当前直接编辑以单个标题/段落块为提交边界：失焦、保存或切换模式时序列化该块并提交最小 TextChange；IME composition 未结束时不得提交。新段落和相邻块合并使用独立的插入/合并事务，粘贴文本在进入事务前规范化为 LF。浏览器 DOM 只负责当前块的短生命周期交互，仍不得作为历史或保存来源。
>
> 第二轮把非嵌套 `listItem`、`blockquote` 内 `paragraph` 和 `tableCell` 纳入相同事务模型。`tableCell` 的预览 SourceRange 精确覆盖单元格原始内容，不含管道分隔符和外围对齐空格；转义管道与代码跨度必须正确分词。列表/引用事务保存 marker、序号、checkbox 与引用前缀，只替换内容。事务成功后，尚未被新 ParsedDocument 替换的可视 DOM 必须用同一 TextChange 映射全部 SourceRange，并拒绝与当前 `editorText` 不一致的旧 HTML 重绘。
>
> 第三轮为标准 Markdown `ImageNode` 增加结构化图片属性事务：`editImageAlt` 只替换图片语法中的 alt 范围并保留 destination/title，`replaceImage` 复用受控资源导入回执并原子替换完整图片 SourceRange，`deleteBlock` 只删除 Markdown 引用。替换沿用原 alt；删除不隐式删除资源文件。Wiki 图片嵌入不按标准图片反向解释。图片 SourceRange 与当前 editorText 不匹配时必须拒绝并等待重解析。
>
> 第四轮增加列表层级事务和预览身份门控。Tab / Shift+Tab 只对当前安全可编辑列表项生成一个原子 TextChange：缩进增加一个冻结层级，退格移除一个冻结层级；首个同级项不得无父项缩进，顶层退格为无修改结果。Ctrl/Cmd+B、Ctrl/Cmd+I、Ctrl/Cmd+K 仍通过既有行内格式事务提交。`editorText` 变化时当前 HTML 投影立即标记为 not-ready；只有当前 documentId 的最新解析响应可将其标记为 ready。旧 HTML 即使仍在 React state 中也不得重绘、绑定新 SourceRange 或接受编辑命令。
>
> 第五轮把 `editFormulaSource`、`editMermaidSource` 和 fenced `codeBlock` 编辑落到结构化面板。公式事务只接收 LaTeX 内容，基于原始完整公式切片保留 `$`、`$$`、`\(`、`\[` 分隔符和内部边界空白；行内公式预览必须获得精确 UTF-16 SourceRange。围栏事务分别接收语言和内容，保留 fence 字符、meta 与尾随换行；若内容形成同字符闭合 fence，事务必须增长开闭 fence，不能产生截断代码块。Mermaid 语言在专用面板中固定，实时 SVG 与 KaTeX 即时 DOM 仍是临时投影。面板不得提交 DOM 或渲染结果，只提交一个校验 documentId、baseSourceHash、expectedText 和完整节点 SourceRange 的 TextChange。
>
> 第六轮把混合行内内容纳入直接编辑。预览解析器为行内公式、标准 Markdown 图片、链接和行内代码输出精确 UTF-16 SourceRange 与稳定 `data-source-kind`；链接和代码扫描结果只有在数量与解析 token 完全一致时才绑定，否则安全降级。Renderer 把这些范围包装为 `contenteditable=false` 的原子节点，并用仅存在于当前投影生命周期的 WeakMap 保存对应原始 Markdown 切片。序列化直接编辑块时，原子节点逐字符回填原切片，普通文本才按用户修改生成 TextChange。WeakMap、DOM 元素及原子选中态不进入 UDM、IPC、恢复稿或输出。跨原子选择的删除、粘贴和格式命令必须拒绝；图片和公式仍走专用事务，链接或行内代码内部修改暂切换源代码模式。
>
> 第七轮新增 `editInlineLink` 与 `editInlineCode` 结构化意图。标准内联链接事务分别接收纯文本 label、destination 和 nullable title；只重写明确修改的字段，其他字段保留原始 token、尖括号、引号类型、空白与转义。参考式链接、自动链接或解析数量不一致的范围不得按标准内联链接解释。行内代码事务接收不含 CR/LF 的内容，保留现有反引号 fence；若内容包含冲突反引号串，fence 长度至少为最长串加一，并按 CommonMark 需要保留或增加边界空格。两类事务继续校验 documentId、baseSourceHash、expectedText 和完整节点 SourceRange，结果写回 WeakMap 后仍以 canonical Markdown 为唯一来源。
>
> 第八轮新增 `editTableStructure` 结构化意图。载荷固定为 `insertRowBefore | insertRowAfter | deleteRow | insertColumnBefore | insertColumnAfter | deleteColumn | setColumnAlignment`，并携带当前 rowIndex、columnIndex；对齐操作另携带 `left | center | right | null`。事务目标是完整表格 SourceRange，而不是当前 DOM 行或单元格；解析原始表格时必须忽略转义管道和代码跨度内的管道。表头行与唯一列不得删除，末格 Tab 等价于 `insertRowAfter`。结构修改以一次 TextChange 重写该表格，保留单元格文本、首尾管道风格、首行缩进、分隔行最小宽度、对齐和尾随换行；允许仅在被结构修改的表格内规范化分隔空格，不得波及表外文本。提交后旧表格 DOM 立即失效并清空，当前解析投影 ready 前不得再次接受命令。新插入空单元格的内容范围允许 `from === to`，其他块级可编辑范围仍要求非空。
>
> 第九轮新增 `editCrossBlockSelection` 意图。Renderer 先把单个非折叠 DOM Range 映射为按文档顺序排列的 `MarkdownBlockSelectionFragment { range, source, selectionFrom, selectionTo }`；fragment 只允许标题、普通段落、引用段落和安全叶级列表项，range 使用当前 canonical editorText 的 UTF-16 SourceRange，selectionFrom/To 是该受控 Markdown 片段内偏移。删除、替换、Enter、剪切和 `setMark(bold | italic | strike)` 最终都折叠为一个外层 TextChange；复制没有编辑事务，只写规范化 text/plain。多段纯文本粘贴统一 LF、单行换行为段落边界，并转义反斜杠、行内标记及行首标题/引用/列表触发符。选区端点位于已有 strong/em/del/link/code/受保护原子内部，或 Range 与图片、公式、链接、行内代码、代码块、Mermaid、表格、源码卡片相交时，映射失败。失败检查必须发生在 commitDirectEdit 之前，因此拒绝不得顺带规范化首块或产生历史项。DOM、Range、Selection 和 ClipboardEvent 均不得进入 UDM、IPC、恢复稿或输出。

### 唯一数据源与视图

- `editorText` 是文件会话内唯一可变正文；CodeMirror 和 WysiwygEditorView 都是它的编辑视图。WysiwygEditorView、DOM、React state 和 ParsedDocument 不得成为第二保存源。
- WysiwygEditorView 由当前 ParsedDocument、ResolutionSnapshot 和预览派生清单投影生成。图片、KaTeX DOM、Mermaid SVG 和选区边框均为短生命周期表现层，不能反向序列化。
- `editorMode` 固定为 `source | wysiwyg`，属于 Renderer 本机 UI 状态，不进入 ParsedDocument、PreviewSession、输出 IPC、恢复稿或 Markdown。

### WysiwygEditTransaction

一次所见即所得操作必须形成一个结构化事务，至少包含：

- `transactionId`
- `documentId`
- `baseSourceHash`
- `intent`
- 目标 `SourceRange` 或可映射文本选择
- 有界操作载荷
- `createdAt`

允许的 intent 包括 `replaceText`、`setInlineMark`、`setHeadingLevel`、`setLink`、`toggleTask`、`insertBlock`、`deleteBlock`、`replaceImage`、`editImageAlt`、`editFormulaSource`、`editMermaidSource`、`editTableCellText`、`editTableStructure` 和 `editCrossBlockSelection`。结构化事务不是 IPC 文件写入请求，也不得携带 DOM、HTML、绝对路径或资源二进制。

主编辑事务管理器必须校验 documentId 与 baseSourceHash，基于 SourceRange 生成最小 `TextChangeSet`，原子更新 canonical editorText，再触发正常解析和资源解析。旧快照事务只能重新定位后重试或明确拒绝；禁止对旧偏移盲写。

### 历史、选择和失败语义

- CodeMirror transaction 与 WysiwygEditTransaction 进入同一文档级撤销/重做历史；一次用户意图只产生一个历史项。模式切换、重新解析和派生资源刷新不进入历史。
- 选择映射使用 UTF-16 文本偏移和 SourceRange，不使用跨解析不稳定的 nodeId。切换前必须结束 IME composition；无法精确映射时折叠到最近安全块边界并给出非阻塞提示。
- 解析失败时保留 canonical editorText 和上一份可识别视图，阻止会覆盖不确定范围的所见即所得命令，并允许立即切回源代码模式修复。
- 不支持安全可视编辑的语法必须保留原文字节范围并显示只读占位；不得通过 HTML→Markdown 转换静默改写。

## 一、目的

统一文档模型（Unified Document Model，UDM）是 Markdown 解析、资源解析以及预览/导出组合视图的一组分层、与输出格式无关的结构化表示；ParsedDocument 是其中唯一的纯语法快照。

它用于：

- 桌面预览
- 错误和兼容性诊断
- PDF 导出
- Word 导出
- 离线 HTML 导出
- 微信公众号富文本转换

它不用于：

- 保存或格式化 Markdown
- 自动重写用户原文
- 充当文件数据库
- 保存图片二进制
- 直接保存 DOM、React 节点或 Electron 对象

## 二、不可违反的保存约束

### 1. 两条独立数据路径

    编辑与保存路径
    canonical editorText 缓冲区
      ↑ CodeMirror transaction / WysiwygEditTransaction
            ↓
    编码和换行策略
            ↓
    经平台验证的替换保存
            ↓
    Markdown 文件

    预览与导出路径
    canonical editorText 不可变快照
            ↓
    document-core
            ↓
    ParsedDocument
            ↓
    ResolutionSnapshot
       ├── PreviewSession → 预览 / 诊断
       └── ResolvedDocumentView → PDF / DOCX / HTML / 公众号

### 2. 禁止事项

- 禁止从 ParsedDocument、ResolutionSnapshot 或任何派生清单重新生成 Markdown 后覆盖用户文件。
- 禁止使用美化、格式化或 AST 序列化结果替代原始缓冲区。
- 禁止把 WysiwygEditorView 的 DOM、innerHTML 或浏览器编辑结果整体转换为 Markdown 后保存。
- 禁止因为预览解析失败而修改原文。
- 禁止导出适配器反向修改编辑缓冲区。

### 3. 原文快照

每次解析和导出都绑定：

- documentId：当前编辑会话标识
- editorText：移除 BOM、以 LF 表示换行的不可变编辑快照
- sourceHash：editorText 的稳定哈希
- parserProfile：解析器配置标识
- udmVersion：模型版本
- createdAt：快照创建时间

sourceHash 固定使用 SHA-256，输入是 editorText 的 UTF-8 字节。BOM、磁盘编码和磁盘换行样式属于文件会话元数据，不进入哈希。

documentId 生命周期：

- 由主进程在创建编辑会话时分配。
- 同一编辑会话内的预览 Worker、资源解析和所有导出任务复用同一个 documentId。
- 防抖重解析、主题切换和普通保存不得更换 documentId。
- 另存为后若继续使用当前编辑会话，documentId 保持不变，但路径和授权变化必须提升 workspaceRevision 并重新解析资源。
- 关闭后重新打开文件会创建新的 documentId 和 recoveryKey。
- 文件夹列表中切换到另一篇 Markdown，或打开另一文件，等于结束旧文件会话：必须新建 documentId 和 recoveryKey，不得复用上一篇的 referenceKey 和恢复稿。
- 从 single-file 转为 folder-workspace 后若仍编辑同一缓冲区，可保持 documentId，但必须提升 workspaceRevision 并重新解析资源。

导出完成时若当前编辑缓冲区的 sourceHash 已变化，导出结果仍代表用户点击导出时的快照，并在界面中标记“文档已在导出期间发生修改”。

### 4. ParseRequest 与 ParseResult

Renderer Web Worker 接收：

    ParseRequest
    ├── documentId
    ├── editorText
    ├── sourceHash
    ├── parserProfile
    └── taskSequence

返回：

    ParseResult
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    ├── parsedDocument
    └── diagnostics

Worker 不得自行生成 documentId。
Worker 必须按 editorText 的 UTF-8 字节重算 SHA-256，并与请求中的 sourceHash 比较；不一致则丢弃该任务，不得把未校验哈希写入 ParsedDocument。
Renderer 只接受 documentId、sourceHash 和 taskSequence 全部匹配当前会话、且通过 Worker 哈希校验的结果。

Renderer 接受 ParseResult 后向主进程提交：

    ParseCommitRequest
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    └── taskSequence

主进程登记当前会话接受的解析版本并返回：

    ParseCommitResult
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    └── parseCommitId

parseCommitId 是主进程生成的短期不透明标识，只用于异步顺序、会话一致性和防止旧 ResolveRequest 被接受。新的 ParseCommitRequest、workspaceRevision 变化或文件会话关闭会立即使旧标识失效。它不是针对已受控 Renderer 的安全证明；导出 Utility Process 仍必须按 editorText 重算 sourceHash。

## 三、解析器契约

### 1. 唯一语义来源

document-core 是唯一 Markdown 语义实现。它包含：

- 锁定版本的 markdown-it
- 锁定版本的扩展插件
- KaTeX 语法识别
- 简单双链图片扩展
- 原始 HTML 安全策略
- 源码位置映射
- 诊断生成
- UDM 构建

CodeMirror 的语法树仅用于源代码模式高亮和交互；WysiwygEditorView 的 DOM 仅用于可视交互。两者都不能决定预览或导出语义。

### 2. parserProfile

P0 使用固定的 parserProfile，例如：

    fantastic-editor-p0-markdown-0.1

P0 明确设置 breaks 为 false，采用 CommonMark 单换行语义。编辑器高亮可以不同，但不能改变 document-core 的解析结果。

该配置至少记录：

- markdown-it 版本
- preset 和启用规则
- 表格规则
- 任务列表规则
- 删除线规则
- KaTeX 分隔符和转义规则
- ATX 和 Setext 标题规则
- 双链图片规则
- 原始 HTML 策略
- 链接和图片 URL 规范化规则

解析器或插件升级时必须创建新的 parserProfile，并运行固定样例回归测试。

### 3. 确定性

相同的 editorText、parserProfile 和 UDM 版本必须产生语义等价的 ParsedDocument 和诊断。

预览 Web Worker 与导出 Utility Process 使用同一份 document-core 包，不允许复制一套相似但独立的解析逻辑。

## 四、源码位置模型

### 1. SourceRange

所有可见内容节点、资源引用和诊断必须尽可能带有源码范围。

    SourceRange
    ├── from：起始偏移，包含
    ├── to：结束偏移，不包含
    ├── startLine：起始行，1 开始
    ├── startColumn：起始列，1 开始
    ├── endLine：结束行，1 开始
    └── endColumn：结束列，1 开始

from 和 to 使用 canonical editorText 的 UTF-16 code unit 偏移。editorText 已移除 BOM并将换行统一表示为 LF，因此可与 CodeMirror 位置和 WysiwygEditorView 选择统一映射。磁盘 CRLF 和 BOM 通过文件会话元数据恢复，不参与 SourceRange。

### 2. 位置要求

- 块级节点必须有 SourceRange。
- 图片、链接、公式和原始 HTML 必须有精确 SourceRange。
- 自动生成的辅助节点可以继承父节点范围，并标记 generated 为 true。
- 无法精确定位时可以使用父范围，但必须标记 precision 为 block。
- 诊断跳转以 from 为准。

### 3. 源码切片

节点可以保存必要的原始切片，例如代码块内容和公式原文，但不能在每个节点重复保存整篇 editorText。

### 4. 预览交互映射

同步滚动和选区提示使用 Renderer 内部的短生命周期视图，不扩展 ParsedDocument：

    PreviewSyncMap
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    └── entries

每个 entry 至少包含 sourceFrom、sourceTo、previewElementKey 和 kind。sourceFrom/sourceTo 与 SourceRange 一样使用 canonical editorText 的 UTF-16 code unit 偏移。

- PreviewSyncMap 由当前 ParsedDocument 的块级 SourceRange 与实时预览 DOM 共同建立，只存在于 Renderer 内存。
- PreviewSyncMap 不是 UDM、PreviewSession 或 IPC 字段，不得被发送给主进程、Utility Process、恢复稿或导出适配器。
- 内部实时预览 HTML 可以包含 data-source-from、data-source-to、data-source-kind 等定位属性；这些属性不是目标定义输出，必须与 PDF、DOCX、离线 HTML和公众号 HTML 的渲染路径隔离。
- PreviewSyncMap 必须与当前 documentId、sourceHash、parserProfile 和 taskSequence 匹配。任一身份过期时立即停止同步并清除选区提示。
- 滚动定位使用块级锚点和相邻锚点区间插值，不把整页 scrollTop 百分比当作源码语义位置。
- 源代码模式只定义编辑区到预览区的单向同步。预览主动滚动不产生 CodeMirror transaction，也不修改选择区；所见即所得模式默认隐藏重复预览并暂停同步定位，但保留用户的 ON/OFF 偏好。
- P0 选区提示以非空主选区为输入，选择与可见块级 SourceRange 相交的最小非重叠元素；图片等精确可视锚点只在选区完全落入其 SourceRange 时优先。
- SelectionOverlay 是 pointer-events: none 的纯 UI 层，不属于预览正文 DOM 语义，不进入复制、保存、导出或公众号发布内容。
- 只有折叠光标时 SelectionOverlay 为空。切换文档、关闭同步、隐藏预览或身份失效时必须清空。

## 五、顶层模型和资源分层

### 1. ParsedDocument

Renderer Web Worker 只生成纯语法快照：

    ParsedDocument
    ├── schema
    ├── udmVersion
    ├── parserProfile
    ├── documentId
    ├── sourceHash
    ├── sourceLength
    ├── metadata
    ├── children
    ├── resourceReferences
    ├── diagnostics
    └── statistics

字段定义：

- schema：固定为 fantastic-editor-parsed-document。
- udmVersion：例如 0.6。
- parserProfile：解析配置标识。
- documentId：编辑会话标识，不是文件绝对路径。
- sourceHash：canonical editorText 的 SHA-256。
- sourceLength：canonical editorText 的 UTF-16 code unit 长度。
- metadata：解析得到的文档元信息；P0 可以为空。
- children：顶层块节点。
- resourceReferences：语法层图片和其他资源引用，不包含读盘结果。
- diagnostics：只包含语法和静态安全诊断。
- statistics：标题、字数、图片和公式数量等可选统计。

ParsedDocument 不包含 MIME、文件大小、图片宽高、contentHash、文件句柄或资源读取状态。

### 2. ResolutionSnapshot

Electron 主进程根据 ParsedDocument.resourceReferences 和工作区授权生成：

    ResolutionSnapshot
    ├── schema
    ├── documentId
    ├── sourceHash
    ├── workspaceId
    ├── workspaceRevision
    ├── resolverProfile
    ├── records
    ├── diagnostics
    └── createdAt

要求：

- schema 固定为 fantastic-editor-resolution-snapshot。
- 与 sourceHash 和 workspaceRevision 同时绑定。
- records 使用当前快照的 referenceKey 索引。
- 包含 MIME、大小、尺寸、contentHash、状态和受限资源句柄。
- 不修改 ParsedDocument。
- 工作区根或授权变化后整个快照失效。

### 3. ResolvedDocumentView

ResolvedDocumentView 是 ParsedDocument 与匹配的 ResolutionSnapshot 的只读组合视图，不需要复制所有节点。

组合前必须确认：

- documentId 相同。
- sourceHash 相同。
- workspaceRevision 仍是当前值。
- 所有资源记录使用当前 resolverProfile。

### 4. PreviewSession

预览使用只读组合对象：

    PreviewSession
    ├── schema
    ├── documentId
    ├── sourceHash
    ├── workspaceRevision
    ├── parsedDocument
    ├── resolutionSnapshot
    ├── previewDerivedManifest
    └── diagnostics

组合前必须确认 documentId、sourceHash 和 workspaceRevision 相互匹配。

PreviewDerivedManifest 顶层结构：

    PreviewDerivedManifest
    ├── schema
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    ├── parseCommitId
    ├── workspaceRevision
    ├── manifestRevision
    └── entries

entries 中每项为：

    PreviewDerivedEntry
    ├── referenceKey
    ├── sourceContentHash
    ├── transformProfile
    ├── previewAssetHandle
    ├── mimeType
    ├── width
    └── height

previewAssetHandle 是短期不透明字符串，可以结构化克隆。它不进入 ResolutionRecord，也不能当作导出期资产使用。manifestRevision 在同一 documentId、sourceHash、parserProfile、taskSequence、parseCommitId 和 workspaceRevision 内单调递增。

PreviewSession 是渲染进程内的逻辑组合视图，不要求把整份 ParsedDocument 发送给主进程再返回。渲染进程收到匹配的 ResolutionSnapshot 和 PreviewDerivedManifest 后，校验 documentId、sourceHash、parserProfile、taskSequence、parseCommitId 和 workspaceRevision，再与本地 ParsedDocument 组合。

### 5. ResolveRequest 与 ResolveResult

渲染进程从 ParsedDocument 提取资源引用，向主进程发送：

    ResolveRequest
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    ├── parseCommitId
    ├── workspaceRevision
    └── resourceReferences

主进程返回：

    ResolveResult
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    ├── parseCommitId
    ├── workspaceRevision
    ├── resolutionSnapshot
    ├── previewDerivedManifest
    └── diagnostics

主进程只接受 documentId、sourceHash、parserProfile、taskSequence、parseCommitId 和 workspaceRevision 均匹配当前登记解析版本的请求。渲染进程丢弃上述任一标识已过期的结果。

初始 previewDerivedManifest 随 ResolveResult 返回。SVG 等转换完成后的增量消息固定为：

    PreviewDerivedUpdate
    ├── documentId
    ├── sourceHash
    ├── parserProfile
    ├── taskSequence
    ├── parseCommitId
    ├── workspaceRevision
    ├── manifestRevision
    ├── entries
    └── diagnostics

每个 Update 只添加或更新本次 revision 的条目，不删除当前身份下的其他条目。Renderer 只接受全部身份匹配且 manifestRevision 严格增大的更新；身份变化时丢弃整份旧清单并从新 ResolveResult 重新开始。
源资源已 resolved、但对应 previewAssetHandle 尚未到达时，预览必须显示占位和进行中状态：不得视为预览完整成功，也不得把 pending 写进 ResolutionSnapshot。导出不得把尚未完成的预览派生句柄当作导出资产。

### 6. DerivedAssetManifest

公式图片、SVG 栅格图、WEBP 转换图等导出期资源放入单独的 DerivedAssetManifest：

- 与 jobId、sourceHash 和 workspaceRevision 绑定。
- 使用 derivedAssetKey。
- 图片派生项记录 sourceReferenceKey、sourceContentHash 和 transformProfile。
- 公式派生项记录 formulaReference，不记录 nodeId。
- formulaReference 包含 SourceRange、latexHash 和 displayMode。
- 公式派生缓存键由 latexHash、displayMode、主题令牌、缩放倍率和渲染器版本共同计算。
- 不写回 ParsedDocument 或 ResolutionSnapshot。
- 由 OutputResult 引用。

绝对文件路径不进入发送给渲染进程的任何模型。

## 六、通用节点结构

所有节点使用可判别的 type 字段。

    BaseNode
    ├── id
    ├── type
    ├── source
    ├── generated
    ├── attributes
    └── children

字段：

- id：本次解析结果内唯一。
- type：节点类型。
- source：SourceRange。
- generated：是否为解析器生成的辅助节点。
- attributes：与节点类型相关的结构化属性。
- children：子节点；叶子节点省略。

id 只保证在同一次解析中唯一。P0 不要求在两次解析之间保持稳定；编辑器定位以 SourceRange 为准。

## 七、P0 节点类型

### 1. 文本和行内节点

- text
  - value
- softBreak
- hardBreak
- emphasis
- strong
- strikethrough
- inlineCode
  - value
- link
  - originalHref
  - normalizedHref
  - title
  - safetyState
- image
- formulaInline
- rawHtmlInline
  - raw
  - safetyState
- unsupportedInline
  - raw
  - feature

### 2. 块级节点

- heading
  - level：1 至 6
- paragraph
- blockquote
- bulletList
  - tight
- orderedList
  - start
  - tight
- listItem
- taskItem
  - checked
- codeBlock
  - language
  - meta
  - value
  - `language` 大小写归一后为 `mermaid` 时，节点仍是 codeBlock；预览适配器生成临时 SVG，输出适配器使用经校验的 PNG 派生资源
- table
  - alignments
- tableHead
- tableBody
- tableRow
- tableCell
  - header
  - colspan，P0 固定为 1
  - rowspan，P0 固定为 1
- thematicBreak
- formulaBlock
- rawHtmlBlock
  - raw
  - safetyState
- unsupportedBlock
  - raw
  - feature

P1 可以新增 footnote、callout 和 wikiLink，但必须提升 UDM 次版本并更新所有相关适配器。Mermaid 已冻结为 `codeBlock(language="mermaid")` 的输出特化，不新增 NodeType。

## 八、图片节点、引用身份和资源缓存

### 1. ImageNode

    ImageNode
    ├── syntax
    ├── originalRef
    ├── resolvedRef
    ├── normalizedResolvedRef
    ├── alt
    ├── title
    ├── referenceKey
    ├── requestedWidth
    └── requestedHeight

字段：

- syntax：markdown-inline、markdown-reference 或 wiki-image。
- originalRef：原文中的引用写法；引用式图片保留标签引用。
- resolvedRef：document-core 展开引用定义后得到的目标。
- normalizedResolvedRef：document-core 生成的、只用于引用身份的规范字符串。
- alt：替代文本。
- title：可选标题。
- referenceKey：当前 ParsedDocument 快照内的引用键。
- requestedWidth、requestedHeight：P0 通常为空；为后续扩展保留。

ImageNode 不保存读盘状态或缓存身份。资源状态只存在于 ResolutionSnapshot。

### 2. normalizedResolvedRef

document-core 必须先根据 resolvedRef 的协议形态确定 ResourceReference.kind，再且只计算一次 normalizedResolvedRef。

分类顺序先于 URI scheme 判断：

- 先识别 Windows 盘符绝对路径、盘符相对路径和 UNC 路径；C:\\... 不能被误判为 scheme。
- 盘符相对路径（例如 C:folder\\image.png）依赖进程当前目录，P0 固定为 blocked。
- UNC 与盘符绝对路径归入 local-path，但必须带安全标记并通过工作区授权；UNC 规范化不得折叠开头两个分隔符。
- 其余输入再按协议形态分类。

local-path 的算法：

1. 从 resolvedRef 校验百分号编码并解码一次。
2. 将路径分隔符统一为正斜杠。
3. 删除不改变语义的当前目录段和重复分隔符。
4. 保留父目录段，不进行文件系统解析。
5. 不修改 Unicode 规范形式和大小写。
6. 不进行第二次百分号解码。

非 local-path 的算法：

- 不执行路径百分号解码、反斜杠替换或目录段折叠。
- remote-http、file-uri、app-internal 和 unsupported-scheme 使用 kind 与 resolvedRef 原始 UTF-8 字节的无歧义长度前缀编码形成规范身份；协议分类大小写不敏感，但不得借规范化改变引用语义。data-uri 使用下述摘要规则。
- P0 默认不请求 remote-http，也不把 file-uri、app-internal 或 unsupported-scheme 转成本地路径。
- data-uri 在 P0 固定为 blocked，生成 DATA_URI_SOURCE_BLOCKED，不解码、不预览、不导出。
- document-core 对 data-uri 原始引用字节计算 SHA-256，normalizedResolvedRef 使用 data-uri:sha256:<digest>；ImageNode 和 ResourceReference 的 originalRef、resolvedRef 只保存有界占位 data:[blocked]，完整 payload 只存在于 editorText，并通过 SourceRange 定位。
- 完整 payload 只允许存在于用户原始 editorText 和 document-core 的受控解析输入。不得复制进 ImageNode、ResourceReference、Diagnostic、ResolutionSnapshot、ResolveRequest、PreviewDerivedUpdate、资源缓存或日志。输出适配器从已授权且已校验的资源字节生成 Data URI 属于输出表示，不改变该输入策略。

主进程对真实路径执行独立安全规范化，但不得使用文件系统结果反向改写 normalizedResolvedRef。

### 3. ResourceReference

ParsedDocument.resourceReferences 中每项包含：

    ResourceReference
    ├── referenceKey
    ├── nodeId
    ├── source
    ├── kind
    ├── syntax
    ├── originalRef
    ├── resolvedRef
    └── normalizedResolvedRef

kind 的固定枚举：

- local-path
- remote-http
- data-uri
- file-uri
- app-internal
- unsupported-scheme

document-core 在任何百分号解码或路径拼接前完成分类。只有 local-path 进入本地工作区解析；其他类型按上列 P0 策略处理，不能作为本地相对路径处理。

referenceKey 固定计算为：

    SHA-256(documentId + source.from + source.to + normalizedResolvedRef)

字段连接使用无歧义的长度前缀编码。referenceKey 只关联当前快照中的节点、诊断和 ResolutionRecord；编辑导致 SourceRange 变化时允许生成新键，不用于文件缓存。

### 4. 三层资源身份

- referenceKey：当前文档快照中的引用身份。
- assetCacheKey：只为 resolved 的本地或应用受控资源生成；本地文件由主进程根据 workspaceId、真实工作区相对路径和文件指纹计算。
- contentHash：读取资源字节后的内容哈希，用于内容去重和转换缓存。

assetCacheKey 不向渲染进程暴露可还原的私人绝对路径。sourceHash 只校验整篇文档快照，不参与 assetCacheKey。

### 5. ResolutionRecord

    ResolutionRecord
    ├── referenceKey
    ├── workspaceRevision
    ├── assetCacheKey
    ├── fileFingerprint
    ├── originalRef
    ├── resolvedRef
    ├── workspaceRelativePath
    ├── mimeType
    ├── byteLength
    ├── contentHash
    ├── width
    ├── height
    ├── state
    ├── candidates
    ├── assetHandle
    └── securityFlags

ResolutionRecord.state 的最终枚举为：

- resolved
- missing
- blocked
- ambiguous
- unsupported
- failed

pending 和 resolving 只属于可变的 ResolutionJob，不进入不可变 ResolutionSnapshot。

要求：

fileFingerprint 包含：

- byteLength
- mtimeNs
- ctimeNs
- 平台可获得时的 fileId

fileFingerprint 用于快速变化检测和缓存命中，不证明内容必然相同；读取字节后以 contentHash 作为最终内容身份。

要求：

- assetCacheKey、fileFingerprint、workspaceRelativePath、contentHash、尺寸和 assetHandle 对未 resolved 的记录均可为空；blocked 的 data-uri 不得为满足字段形状而伪造文件信息。
- 不向渲染进程暴露绝对路径。
- workspaceRelativePath 使用统一的正斜杠表示。
- 二进制数据不放入 ParsedDocument 或 ResolutionSnapshot。
- 多个 referenceKey 可以共享同一 assetCacheKey 和 contentHash。
- 正文编辑改变 referenceKey 时，只要文件指纹未变，主进程应复用 assetCacheKey 对应资源。
- 资源二进制通过受限资源句柄或导出任务资源包传递。
- ambiguous 状态可以附带不含私人绝对路径的候选相对路径。
- ResolutionRecord 只描述源资源，不保存预览或导出的派生 PNG。

### 6. 资源句柄

预览使用短生命周期的 assetHandle。句柄包含：

- handleId
- grantId
- workspaceRevision
- contentHash
- expiresAt

句柄是不可逆的随机标识，不包含路径。渲染进程只能通过受限协议或 IPC 使用句柄读取对应资源。workspaceRevision 变化时，旧句柄立即失效。

### 7. PreviewDerivedAssetCache

SVG 和其他需要安全转换后才能预览的资源使用独立缓存：

    PreviewDerivedAssetRecord
    ├── sourceContentHash
    ├── transformProfile
    ├── transformerVersion
    ├── derivedContentHash
    ├── previewAssetHandle
    └── expiresAt

- 主进程先完成授权读取并提供受限源句柄。
- 隔离图片处理进程执行清洗、栅格化和格式转换。
- 缓存键由 sourceContentHash、transformProfile 和 transformerVersion 计算。
- previewAssetHandle 只用于预览，不进入 ResolutionRecord。
- PreviewDerivedAssetCache 与导出期 DerivedAssetManifest 分开管理。

### 8. 图片导入命令、回执与编辑事务

图片导入属于文件会话命令，不属于 ParsedDocument。它不能向 ImageNode、ResourceReference 或 ResolutionSnapshot 增加“已导入”“拖放来源”或绝对路径字段；导入完成并写入 Markdown 后，document-core 只看到普通相对图片语法。

Renderer 维护：

    PendingImageInsertion
    ├── importRequestId
    ├── documentId
    ├── sessionId
    ├── anchorFrom
    ├── anchorTo
    ├── placementMode
    └── createdAt

- placementMode 为 `drop-coordinates` 或 `current-selection`。
- anchorFrom/anchorTo 是主编辑事务中的临时文本锚点；源代码模式通过 CodeMirror ChangeDesc 映射，所见即所得模式通过共享 TextChangeSet 映射。它不是 SourceRange，不进入 IPC、恢复稿或 ParsedDocument。
- 拖放使用 `EditorView.posAtCoords` 得到初始位置；按钮入口使用当前选择区。多图共享一个起始锚点并按 DataTransfer/对话框顺序展开。
- 根窗口拖放处理器必须先分类：支持图片且落点位于 EditorView 时进入图片导入；Markdown 文件进入打开文档流程；图片落在编辑区外时不修改 editorText；Markdown 与图片混合批次固定拒绝并提示分开操作。

专用导入请求只允许以下两种来源：

    ImportImageRequest
    ├── importRequestId
    ├── documentId
    ├── sessionId
    ├── workspaceRevision
    └── source
         ├── dialog-selection
         └── dropped-file { displayName, declaredMimeType, bytes }

- `dialog-selection` 使主进程直接打开系统文件对话框，路径不返回 Renderer。
- `dropped-file` 只携带用户本次明确拖入的一个或多个文件字节、清洗后的显示名和声明 MIME；不得接受路径字符串、目录、URL、data URI 或应用内部协议。
- dropped-file 是专用的一次性大对象 IPC，受单资源与任务总容量约束；它不得被复制到 ParsedDocument、诊断、缓存、恢复稿或日志，处理完成后释放引用。
- 主进程必须使用文件签名和安全解码结果校验真实格式，不能只信扩展名或 declaredMimeType。

成功结果：

    ImportedAssetReceipt
    ├── importRequestId
    ├── documentId
    ├── sessionId
    ├── workspaceRevision
    ├── relativeRef
    ├── displayName
    ├── mimeType
    ├── byteLength
    ├── contentHash
    └── reusedExisting

- relativeRef 固定为从当前 Markdown 到同级 `assets/` 中文件的正斜杠相对引用，不含绝对路径、file URL 或应用协议。
- 默认文件名由安全化原文件名、contentHash 短后缀和经文件签名确认的扩展名组成；禁止覆盖不同内容的已有文件。
- 主进程先在目标目录写临时文件并完成刷新/关闭，再以经过 Windows 验证的安全方式落位。相同 contentHash 可以返回已有 relativeRef。
- 写入成功后更新资源索引并递增 workspaceRevision；回执带新 revision。Renderer 只有在 documentId/sessionId 仍匹配时才接受回执，然后通过主编辑事务管理器以一次共享事务插入 Markdown 图片语法。
- alt 默认取清洗后的文件名，不含扩展名；用户选中的文字可以作为 alt。生成语法必须正确转义 Markdown 方括号、圆括号、反斜杠和空白路径。
- 导入失败不修改 editorText。导入已落盘但锚点失效或插入失败时，资源登记为未引用候选；不得自动删除，因为相同文件可能已被其他引用复用。
- 用户撤销插入只撤销 editorText transaction，不删除资源。资源清理由独立命令扫描当前文档/工作区引用并再次确认。
- 导入成功后的解析、预览和所有输出必须重新进入普通 ParseRequest → ResolveRequest → PreviewSession 路径，不允许使用 blob URL 或临时预览旁路伪装成功。
## 九、公式节点

公式节点字段：

- latex：原始公式内容，不含外层分隔符。
- displayMode：行内为 false，块级为 true。
- delimiter：原始分隔符类型。
- accessibleText：可选的无障碍文本。

公式语法错误通过 Diagnostic 表达。预览中的 pending、ready、error 属于预览任务状态，不进入 ParsedDocument。

KaTeX 生成的 DOM 不进入 ParsedDocument。适配器根据 latex 和主题参数生成目标格式；Word 或公众号生成的公式图片进入 DerivedAssetManifest，并由 OutputResult 引用。

## 十、代码块和表格

### 1. CodeBlock

代码内容必须保持原样，不进行自动缩进、换行或实体替换。

字段：

- value：去除围栏后的代码内容。
- language：规范化后的语言标识。
- originalLanguage：原文语言标识。
- meta：围栏后的附加文本。
- fence：原始围栏字符和长度，可用于诊断，不用于保存。

### 2. 列表和任务项

- bulletList.children 可以同时包含 listItem 和 taskItem。
- orderedList.children 只包含 listItem；P0 不把有序列表解析为任务列表。
- taskItem 与 listItem 具有相同的 children 结构，并额外包含 checked。
- 不单独创建 taskList 节点。
- 适配器必须保留同一 bulletList 中普通项和任务项的原始顺序。

### 3. Table

表格保留结构和对齐信息。P0 不支持合并单元格。

table.alignments 是列对齐的唯一真相，按列保存 left、center、right 或 null。tableCell 不重复保存 align。

如果 Word 或公众号目标不支持某个表格能力，适配器生成输出级诊断，不能修改 ParsedDocument。

## 十一、原始 HTML 和安全状态

原始 HTML 节点必须标记：

- safetyState：allowed、sanitized、blocked
- removedFeatures：被删除的标签、属性或协议类别
- safeRepresentation：清洗后的目标无关表示，或为空

P0 不提供放行任意 HTML 的“信任全部”开关。

P0 清洗器阻止原始 HTML 中的 img 标签并生成 RAW_HTML_IMAGE_BLOCKED 诊断，提示用户改用 Markdown 图片语法。后续若支持该标签，document-core 必须把 src 转成正式 ResourceReference。

适配器只能使用 safeRepresentation，禁止重新使用 raw 字段直接生成 HTML。

## 十二、诊断模型

    Diagnostic
    ├── id
    ├── code
    ├── severity
    ├── category
    ├── message
    ├── source
    ├── nodeId
    ├── referenceKey
    ├── outputTarget
    ├── details
    └── suggestedActions

severity：

- info
- warning
- error
- blocking

category：

- parse
- syntax
- resource
- security
- compatibility
- export
- performance

outputTarget：

- all
- preview
- pdf
- docx
- offline-html
- wechat

建议使用稳定错误代码，例如：

- ASSET_NOT_FOUND
- ASSET_OUTSIDE_WORKSPACE
- ASSET_AMBIGUOUS
- SVG_EXTERNAL_RESOURCE_BLOCKED
- RAW_HTML_IMAGE_BLOCKED
- FORMULA_PARSE_ERROR
- UNSUPPORTED_MARKDOWN_EXTENSION
- REMOTE_IMAGE_BLOCKED
- DATA_URI_SOURCE_BLOCKED
- WINDOWS_DRIVE_RELATIVE_PATH_BLOCKED
- WECHAT_IMAGE_STRATEGY_UNAVAILABLE
- EXPORT_RESOURCE_TIMEOUT

错误代码用于测试和界面逻辑，message 可以本地化。

## 十三、主题模型

主题不直接写入节点 style 字符串，而使用语义令牌。

    ThemeTokens
    ├── typography
    ├── colors
    ├── spacing
    ├── borders
    ├── code
    ├── table
    ├── quote
    ├── image
    └── formula

示例令牌：

- typography.body.fontFamily
- typography.body.fontSize
- typography.heading1.fontSize
- spacing.paragraphAfter
- colors.text
- colors.muted
- code.background
- table.borderColor
- image.maxWidth

各输出适配器把同一组令牌映射到自己的能力范围。Word、PDF 和公众号不要求像素级一致，但语义和主题意图应一致。

## 十四、输出上下文

主进程为本次预检创建 preflightId。每个导出适配器先接收只读预检输入：

    OutputPreflightContext
    ├── jobId
    ├── documentId
    ├── target
    ├── sourceHash
    ├── workspaceRevision
    ├── preflightId
    ├── parsedDocument
    ├── resolutionSnapshot
    ├── derivedAssetManifest
    ├── theme
    ├── locale
    └── options

预检输出：

    OutputPreflightResult
    ├── preflightId
    ├── jobId
    ├── documentId
    ├── sourceHash
    ├── workspaceRevision
    ├── status
    ├── diagnostics
    ├── candidateOmittedReferenceKeys
    └── nonOverridableDiagnosticIds

OutputPreflightResult.status 固定为 ready、approval-required 或 failed。预检必须完成目标适配器的兼容性检查，并列出生成前已知的全部候选省略；不得创建最终产物或修改基础模型。

需要批准时，Renderer 向主进程发送：

    ApproveOmissions
    ├── preflightId
    ├── jobId
    ├── documentId
    ├── sourceHash
    ├── workspaceRevision
    └── approvedOmittedReferenceKeys

主进程只有在 approvedOmittedReferenceKeys 与 candidateOmittedReferenceKeys 完全一致时才进入 ready；用户只批准部分候选时，必须取消任务或修改选项并使用新的 preflightId 重新预检。主进程拒绝包含 nonOverridableDiagnosticIds 所关联引用的请求。批准后才创建最终生成输入：

    OutputContext
    ├── jobId
    ├── documentId
    ├── target
    ├── sourceHash
    ├── workspaceRevision
    ├── preflightId
    ├── parsedDocument
    ├── resolutionSnapshot
    ├── derivedAssetManifest
    ├── theme
    ├── locale
    ├── approvedOmittedReferenceKeys
    └── options

适配器输出：

    OutputResult
    ├── jobId
    ├── documentId
    ├── target
    ├── sourceHash
    ├── workspaceRevision
    ├── preflightId
    ├── status
    ├── artifact
    ├── diagnostics
    ├── usedReferenceKeys
    ├── usedFormulaReferences
    ├── omittedReferenceKeys
    ├── approvedOmittedReferenceKeys
    ├── derivedAssetManifest
    └── timing

OutputResult.status 固定枚举：

- completed
- completed-with-omissions
- failed
- cancelled
- timed-out

导出任务状态固定为：

    created → parsing → resolving-assets → rendering-assets → preflighting
      → awaiting-user-approval（可选） → ready → generating
      → completed / completed-with-omissions

任一未完成状态都可进入 failed、cancelled 或 timed-out。

省略批准协议：

- approvedOmittedReferenceKeys 只绑定当前 preflightId、jobId、documentId、sourceHash 和 workspaceRevision，并保存用户明确确认的精确 referenceKey 集合。
- 只有与 ResourceReference 关联、且允许安全省略的 blocking 诊断可在本次任务内转为已批准省略；批准只允许省略，不允许读取被 blocked 的资源。解析错误、公式渲染失败、输出结构错误及安全边界本身不可覆盖。
- 适配器必须保留原诊断；不得读取被 blocked 的资源，只能省略其输出。
- completed-with-omissions 只允许在 omittedReferenceKeys 非空、且与本次实际消耗的 approvedOmittedReferenceKeys 完全一致时返回；OutputResult 中该字段只回传实际消耗的批准。任何未批准省略、生成阶段新出现的省略或新 blocking 诊断都必须使任务 failed。
- completed 只允许在 omittedReferenceKeys 为空且没有未解决 blocking 诊断时返回。界面不得把 completed-with-omissions 显示为“完整成功”。
- usedReferenceKeys 包含以正常内容或目标定义的显式 placeholder 表示的资源引用；方案 B 的普通图片占位属于 used，不属于 omitted。成功生成或以目标定义 placeholder 表示的公式记录在 usedFormulaReferences。
- 公式节点没有 referenceKey。P0 任一公式渲染失败必须使任务 failed，不进入批准省略协议。
- 批准不得跨 preflightId、任务、documentId、sourceHash 或 workspaceRevision 复用。

取消协议：

- 主进程创建 jobId。
- 渲染进程只发送 CancelJob(jobId)。
- 主进程向参与任务的 Utility Process、AssetRenderWindow 或 PDF BrowserWindow 发送取消消息。
- 每个进程内部使用自己的 AbortController；AbortController 和 cancellationToken 不跨进程传输。
- 取消后的迟到 OutputResult 必须按 jobId 丢弃。

适配器不得：

- 修改 ParsedDocument 或 ResolutionSnapshot。
- 修改编辑缓冲区。
- 自行重新解释 Markdown 原文。
- 绕过资源授权读取路径。
- 把导出期派生资源写回基础模型。
- 忽略未获本次任务批准的 blocking 诊断并静默完成。

## 十五、进程和传输边界

### 1. Renderer

拥有：

- canonical editorText、共享编辑事务历史和当前 editorMode
- 当前 sourceHash
- UI 状态
- 预览结果
- PendingImageInsertion 锚点，以及用户明确拖入时短暂存在的 File/ArrayBuffer；导入 IPC 完成后立即释放
- 去除绝对路径后的诊断

不拥有：

- Node 文件接口
- 任意路径
- 原始敏感凭据
- 导出进程句柄

### 2. Renderer Web Worker

- 加载 document-core。
- 接收包含 documentId、editorText、sourceHash、parserProfile 和 taskSequence 的 ParseRequest。
- 按 editorText 重算 sourceHash；与请求不一致则丢弃任务。
- 返回携带相同 documentId、校验后 sourceHash 和 taskSequence 的 ParseResult。
- 返回 ParsedDocument 和语法诊断。
- 任务带序列号；旧任务结果在新任务到达后丢弃。
- 渲染进程接受当前 ParseResult 后先向主进程提交 ParseCommitRequest，取得 parseCommitId，再创建 ResolveRequest；收到身份与 revision 匹配的 ResolveResult 后构造本地 PreviewSession。
- 不访问文件系统和网络。
- 不填充 MIME、contentHash、尺寸或资源状态。

### 3. Main Process

- 管理文件会话、workspaceGrant、workspaceRevision 和路径。
- 执行编码检测、换行转换、替换保存和恢复。
- 处理图片选择与一次性拖放导入：验证 documentId/sessionId/workspaceRevision、文件签名、MIME、容量和目标目录，在 Markdown 同级 `assets/` 安全落盘，仅返回 ImportedAssetReceipt。
- 更新受影响的工作区资源索引和 workspaceRevision；不得向 Renderer 返回源路径或目标绝对路径。
- 管理 recentId 到已授权文件记录的映射；渲染进程不能提交任意路径打开文件。
- 只在 folder-workspace 模式建立受限目录索引。
- 登记 ParseCommitRequest，并校验 ResolveRequest 的 documentId、sourceHash、parserProfile、taskSequence、parseCommitId 和 workspaceRevision。
- 生成初始 ResolveResult，并以 PreviewDerivedUpdate 推送后续派生资源增量。
- 编排 OutputPreflightResult、awaiting-user-approval 和 ApproveOmissions；批准后才创建 OutputContext。
- 对 ResourceReference 解析并验证真实路径。
- 生成 ResolutionSnapshot、assetCacheKey 和受限句柄。
- 工作区变化时撤销旧句柄并使旧快照失效。
- 编排 Node 导出、图片处理和 PDF 渲染任务。
- 不把任意文件读取能力暴露给渲染进程。

### 4. Node Export Utility Process

- 使用与 Web Worker 相同版本的 document-core。
- 接收 jobId、documentId、sourceHash、parserProfile、workspaceRevision、导出选项、受限 ResolutionSnapshot，以及不可变 ParsedDocument 或 editorText 二选一。
- 接收 editorText 时可以重新解析同一快照，但必须复用 documentId、重算 sourceHash 并校验 parserProfile；不得把 parseCommitId 当作内容真实性证明。
- 当前快照含 DATA_URI_SOURCE_BLOCKED 且用户批准省略时，必须接收 ParsedDocument，不得把包含 payload 的 editorText 发送到 Utility Process。
- 只按 referenceKey 请求当前快照资源。
- 生成 DOCX、离线 HTML、公众号 HTML 和导出期 DerivedAssetManifest。
- 不执行 webContents.printToPDF。
- 不接受用户界面传入的任意绝对路径。
- 发生崩溃时不影响原始 Markdown 和恢复稿。

### 5. Isolated Image Process

- 接收受限源资源句柄，不接收任意路径。
- 执行 SVG 清洗和栅格化以及普通图片格式转换。
- 维护 PreviewDerivedAssetCache，并为导出任务生成普通图片派生资源。
- 不假设该进程拥有 DOM 或 Chromium 页面。
- 进程崩溃不修改 ParsedDocument 或 ResolutionSnapshot。

### 6. Hidden AssetRenderWindow

- 由主进程按 jobId 编排。
- 使用本地 KaTeX 和静态主题资源渲染公式。
- 生成导出所需的公式 PNG 或 SVG，并写入 DerivedAssetManifest；普通实时公式预览由渲染进程使用本地 KaTeX 生成安全 DOM，不进入 PreviewDerivedManifest。
- contextIsolation、sandbox 和 webSecurity 保持启用，nodeIntegration 关闭。
- 禁止导航、新窗口和网络连接，使用临时 Session。
- 公式任务使用 SourceRange、latexHash 和 displayMode 对齐，不使用 nodeId。
- P0 每个导出 jobId 创建一个窗口，同一任务内批量渲染公式并在每项之间清理 DOM；不得为每个公式重复创建 Chromium 窗口。
- 完成、失败或取消后销毁窗口。P0 禁止跨 jobId 或跨文档复用；后续若阶段 0 验证隔离和清理可靠，才可重新评估进程池。
- 不得读取任意工作区路径。

### 7. Hidden PDF BrowserWindow

- 由主进程创建并编排。
- contextIsolation、sandbox 和 webSecurity 保持启用，nodeIntegration 关闭。
- 禁止导航、新窗口和网络连接，使用临时 Session。
- 加载静态打印页面和受限资源。
- 达到字体、图片和公式 ready 后，由主进程调用 webContents.printToPDF。
- 完成、失败或取消后销毁窗口。
- 不作为通用网页浏览窗口复用。

### 8. 为什么允许重新解析

预览和导出可以各自解析同一份快照，因为：

- 使用同一 document-core 包和 parserProfile。
- 使用 sourceHash 保证输入一致。
- 固定回归测试保证结果语义等价。
- 避免在多个进程之间频繁传输超大 UDM。
- 避免 UDM 中混入不可序列化对象。

这不等于使用两套解析器。

两次解析之间不依赖 node id 或单次解析 id 相等。当前快照引用按 referenceKey 对齐，源文件缓存按 assetCacheKey 和 contentHash 复用，整篇快照按 sourceHash 校验。公式派生项使用 SourceRange、latexHash 和 displayMode，不使用 nodeId。确定性比较忽略 createdAt、节点 id、任务号和句柄过期时间。

## 十六、序列化要求

ParseRequest、ParseResult、ParseCommitRequest、ParseCommitResult、ResolveRequest、ResolveResult、PreviewDerivedUpdate、ImportImageRequest、ImportedAssetReceipt、OutputPreflightContext、OutputPreflightResult、ApproveOmissions、OutputContext、OutputResult、ParsedDocument、ResolutionSnapshot、PreviewDerivedManifest 和 DerivedAssetManifest 必须可以通过结构化克隆或 JSON 表示。

ImportImageRequest.dropped-file.bytes 是唯一允许携带用户本次明确拖入图片字节的专用消息字段，优先使用可转移 ArrayBuffer；它不属于 UDM JSON 持久化集合。dialog-selection 不携带路径或字节。

禁止放入：

- DOM 节点
- React 元素
- 函数
- Electron 对象
- Node Stream
- 文件句柄
- 未受限绝对路径
- 独立于 editorText 解析输入的大型图片 Base64；原文中的 data URI payload 不得复制到其他模型或消息字段
- 可变的解析或渲染状态对象
- AbortController 或 cancellationToken
- 循环引用

资源二进制单独传输，使用 ArrayBuffer、受限句柄或导出任务临时资源包。

## 十七、性能和取消

- 预览解析使用 taskSequence 丢弃过期结果；导出任务使用 jobId 和取消消息。
- 预览输入使用防抖。
- sourceHash 对 canonical editorText 的 UTF-8 字节计算。
- 文件会话中的 BOM 和磁盘换行不进入 sourceHash。
- 资源解析按引用进行。
- 超大文档达到软限制时发出性能警告。
- 达到硬限制时阻止实时预览，但仍允许用户保存原文。
- 具体软硬限制在阶段 0 基准测试后冻结。
- 源代码模式的 CodeMirror 滚动监听使用 passive listener，并通过 requestAnimationFrame 合并到每帧至多一次预览定位；不得为每个 scroll 事件提交 React state。所见即所得模式默认隐藏重复预览，不运行同步滚动定位。
- PreviewSyncMap 的 DOM 测量在预览 HTML、视图宽度或内容尺寸变化后更新；图片、公式和派生资源的布局变化由 ResizeObserver 触发，不为像素重测重新解析文档。
- 同步滚动使用即时 scrollTop 定位，不在连续滚动期间堆叠 smooth-scroll 动画。

保存操作不得等待 ParsedDocument 或 ResolutionSnapshot 完成。

## 十八、版本和兼容性

UDM 使用语义化版本思想。1.0 正式冻结前的 0.x-draft 允许破坏性调整，不承诺跨草稿版本兼容；从首个已冻结版本开始严格执行以下规则：

- 补丁版本：不改变字段语义的错误修复。
- 次版本：增加可选节点或字段。
- 主版本：改变既有字段语义或删除字段。

适配器声明支持的 UDM 版本范围。遇到未知节点时：

- 预览尽可能显示安全的纯文本占位。
- 导出生成 UNSUPPORTED_UDM_NODE 诊断。
- 不允许静默丢失用户内容。

## 十九、验证方法

### 1. Golden Fixtures

为每个 P0 语法用例目录维护：

- input.md
- expected.parsed-document.json
- expected-diagnostics.json

固定用例必须分别覆盖 ATX 标题与 Setext 标题，以及 Mermaid 有效语法、无效语法、大小写语言标识和 SourceRange 保持。

### 2. 确定性测试

相同输入重复解析，忽略 createdAt 和任务 id 后，结果必须一致。

### 3. 源码映射测试

每个节点和诊断的 SourceRange 必须能在原文中定位到对应语法。

重点覆盖：

- 中文和 emoji
- CRLF
- 组合字符
- 多行公式
- 围栏代码
- URL 编码路径

### 4. 适配器契约测试

每个适配器至少验证：

- 不修改 ParsedDocument 或 ResolutionSnapshot。
- 不访问未授权资源。
- 输出 sourceHash 和 workspaceRevision 与任务一致。
- 跨进程引用按 referenceKey 对齐，资源缓存按 assetCacheKey 和 contentHash 复用。
- 资源失败产生诊断。
- 预览期 SVG 等派生资源只进入 PreviewDerivedAssetCache，并通过 PreviewDerivedManifest 暴露短期句柄。
- 导出期派生资源只进入 DerivedAssetManifest。
- 未知节点不静默丢失。
- CancelJob(jobId) 不传输 cancellationToken，且不会留下损坏的最终文件。
- completed-with-omissions 只接受当前任务批准的 referenceKey，且不能显示为完整成功。
- 预检完整列出候选省略，ApproveOmissions 必须与候选集合完全一致；只批准部分时重新预检，生成期新省略必须 failed。
- 方案 B 普通图片 placeholder 计入 usedReferenceKeys，公式 placeholder 计入 usedFormulaReferences，两者均不计入 omittedReferenceKeys；公式失败固定 failed。
- PreviewDerivedUpdate 必须拒绝旧 parserProfile、taskSequence、parseCommitId、workspaceRevision 和回退 revision。
- 源 data-uri payload 仅存在于 editorText 解析边界，不进入 ParsedDocument、ResolutionSnapshot、诊断、ResolveRequest、PreviewDerivedUpdate、缓存或日志；批准省略的导出不把该 editorText 发送到 Utility Process。
- Windows 盘符、盘符相对路径和 UNC 按冻结顺序分类。

### 5. 保存隔离测试

构造包含不同列表标记、尾随空格、围栏长度、UTF-8 BOM、LF 和 CRLF 的 Markdown，完成预览后直接保存，重新读取并转换为 canonical editorText 后必须与编辑缓冲区逐字符一致。

### 6. 双编辑模式测试

- 无编辑往返切换 source / wysiwyg 后 editorText、sourceHash、BOM、编码和 lineSeparator 不变。
- 每个 WysiwygEditTransaction 只修改预期 SourceRange，重解析后意图仍成立，未触及语法保持逐字符一致。
- 跨模式撤销和重做使用同一历史，IME composition、emoji、组合字符和迟到解析结果不能造成重复提交或偏移写入。
- 图片、公式和 Mermaid 的可视节点只提交相应 Markdown 源码事务；预览 DOM、SVG、PNG 和临时句柄不得进入 editorText。
- 不支持语法保持只读并可切回源代码模式；解析失败不得损坏或替换原文。

混合换行文件必须先经过用户确认的统一流程；不能以普通往返样例宣称字节级无损。

### 6. 图片导入契约测试

- 拖放坐标、当前选择区、文档末尾和多图顺序生成确定的 Markdown 编辑事务。
- 导入未完成时继续输入，PendingImageInsertion 经 ChangeDesc 映射后仍落在用户选择的语义位置。
- 未命名文档先另存为；取消、扩展名伪造、MIME/文件签名不符、超限、目标写入失败和过期 workspaceRevision 均不修改 editorText。
- 同名不同内容不会覆盖；相同内容复用同一 relativeRef；Renderer 和日志不出现绝对路径。
- 导入后的图片只通过正常 ResourceReference、ResolutionSnapshot 和 PreviewSession 显示，并自动进入各输出适配器。
- 撤销插入不自动删除资源；经确认的未引用资源清理不会删除仍被任一 Markdown 引用的文件。

### 7. 同步滚动和选区提示测试

- 固定样例覆盖标题、长短段落、引用、紧凑与非紧凑列表、围栏代码、表格、图片、行内公式和块级公式的内部预览 SourceRange 锚点。
- 验证编辑区跟踪点在相邻锚点之间使用区间插值；不得以整页滚动百分比作为测试期望。
- 验证快速连续滚动经 requestAnimationFrame 合并，关闭开关后预览不再被编辑区驱动。
- 验证折叠光标无提示、单块选区一个提示、跨块选区多个提示、精确图片选区优先提示图片，以及提示框不接收指针事件。
- 文本变化后旧 sourceHash 映射立即失效；只有匹配的新解析结果到达后才恢复同步和提示。
- 图片加载、SVG PreviewDerivedUpdate、KaTeX 布局和分栏宽度变化后重新测量，预览仍定位到对应语义块。
- 验证实时预览 data-source 属性和 SelectionOverlay 不出现在 PDF、DOCX、离线 HTML、WechatClipboardAdapter 输出或系统剪贴板目标 HTML 中。

## 二十、0.7 冻结清单

ParsedDocument Core 0.6 先独立冻结：

- 确认 P0 节点类型。
- 确认 parserProfile、插件集合和 breaks 为 false。
- 确认 canonical editorText、SHA-256 sourceHash、Worker 哈希重算校验和 UTF-16 SourceRange。
- 确认源 data-uri 固定阻止、payload 仅存在于 editorText 解析边界，并冻结含该诊断时的 ParsedDocument 导出路径。
- 确认 originalRef、resolvedRef、normalizedResolvedRef、ResourceReference 和 referenceKey。
- 确认公式节点不含渲染状态和派生资产。
- 确认任务项层级和表格对齐唯一来源。
- 确认诊断错误码。
- 确认主题令牌最小集合。
- 确认 Web Worker 和 Node Export Utility Process 使用同一 document-core。
- 完成固定语法样例和保存隔离测试。
- 冻结 PreviewSyncMap 的 Renderer-only 边界、单向同步规则、版本身份校验和块级选区提示精度。

随后冻结资源层：

- 确认 workspaceRevision、ResolutionSnapshot、assetCacheKey 和资源最终状态枚举。
- 确认目录索引、路径安全和句柄失效规则。
- 确认 PreviewDerivedManifest 与 DerivedAssetManifest 的生命周期和边界。
- 确认 ImportImageRequest、PendingImageInsertion、ImportedAssetReceipt、assets/ 命名、拖放字节边界、插入锚点映射和未引用资源清理规则。
- 完成 ParseRequest、ParseCommitRequest、ResolveRequest、PreviewDerivedUpdate、PreviewSession、manifestRevision、输出预检、批准省略、跨进程 referenceKey 对齐和 assetCacheKey 复用测试。

Preview、PDF BrowserWindow、DOCX 和 HTML 适配器负责人评审 ParsedDocument Core。WechatClipboardAdapter 契约在公众号图片策略验证后单独冻结，不阻塞核心模型。
## 二十一、嵌套列表编辑投影与事务契约

`ParsedDocument` 的 `listItem` / `taskItem` 节点及完整 SourceRange 仍是列表结构的唯一语义来源。本轮不新增第二份列表模型，也不把 Renderer 创建的正文包装元素写入 ParsedDocument。

Renderer 可从一个安全列表项派生短寿命的 `ListOwnContentProjection`，它仅用于编辑该项首行正文，并携带所属完整列表项范围。正文提交只替换 marker/checkbox 后的自身内容；后代源码切片原样拼回。结构命令则必须忽略该投影的局部 DOM，直接对完整列表项源码范围生成一个 `WysiwygEditTransaction`。

契约要求：

- indent/outdent 对范围内每个非空源码行施加相同层级差，保持后代相对缩进。
- move-up/move-down 只交换相邻同级完整子树源码切片，不重建 AST、不重排 marker、不全表重编号。
- task toggle 只改变所属项首行 checkbox；后代 SourceRange 内容不变。
- 新有序同级项使用当前显式序号加一；移动既有项保留原显式序号。这是 P0 的确定性编号策略。
- 空项退出、父项正文编辑和所有结构命令均带 expectedText 快照；旧范围必须拒绝，成功时各自产生一个共享撤销历史项。
- 深层纯列表可递归执行结构命令；包含代码、表格、块级公式、Mermaid 或不可安全拆分节点的子树必须在事务生成前拒绝。
- `ListOwnContentProjection`、可视工具栏状态和 DOM 包装不得进入 sourceHash、保存、PDF、DOCX、离线 HTML或公众号输出。
## 二十二、块级操作事务契约

块工具栏和内部拖放不扩展 ParsedDocument。Renderer 只从当前投影派生短寿命 BlockEditContext，其中保存节点类型、完整 SourceRange 和 expectedText；它不是 UDM 字段，也不得跨解析提交复用。

- move 使用移动块与目标块的精确源码范围重排两个范围之间的原始切片，不重新生成中间节点，也不改变未触及空白。
- duplicate 在原始块源码后生成独立块边界；delete 只删除确认过的完整范围；preset insert 只插入冻结的确定性 Markdown 模板。
- 拖动载荷只携带应用内部类型；Renderer 同时保存 expectedText 快照。投放时文本或范围不匹配即拒绝，不能信任 DataTransfer 中的源码或绝对路径。
- 自身范围内投放、目标失效、解析身份变化和不可安全定位的块均返回无事务结果。成功结果仍是一个最小 WysiwygEditTransaction，由 CodeMirror 共享历史提交。
- BlockEditContext、落点、焦点和选中状态不进入 sourceHash、ParsedDocument、ResolutionSnapshot、PreviewSession、保存或导出。

## 二十三、P0 所见即所得冻结约束

- canonical editorText 继续是唯一真实数据；第十二轮不引入可持久化 DOM、第二份文档树或独立撤销栈。
- 直接编辑取消、模式切换、保存和全局撤销的提交顺序必须确定；旧快照只能被拒绝，不能自动覆盖新文本。
- 大文档与连续操作测试必须证明块事务仅处理相关源码区间，且一次用户动作只产生一个撤销项。
- Renderer 的全部编辑投影和辅助 UI 继续执行输出隔离回归。完成类型检查、测试、生产构建及真实 Electron 冒烟后，ParsedDocument Core 的 P0 所见即所得扩展面冻结。
## 二十四、PDF 打印投影与布局审计契约

PDF 分页属于 PdfAdapter 的短寿命输出投影，不扩展 ParsedDocument、ResolutionSnapshot 或 canonical editorText。

- PDF HTML 继续由最新 ParsedDocument、ResolutionSnapshot、输出主题和派生资源清单生成；分页 CSS、缩放标记和布局审计数据不得回写 UDM。
- PdfLayoutAudit 只包含 scaledElements、unresolvedOverflowElements、imageCount 和 pageEstimate 四个非负整数；pageEstimate 至少为 1。隔离窗口返回值必须通过结构校验。
- 表格与公式缩放只修改本次隐藏窗口 DOM。scaledElements 大于 0 生成 PDF_WIDE_CONTENT_SCALED 警告；unresolvedOverflowElements 大于 0 生成阻断诊断且不调用 printToPDF。
- pageCount 和 scaledElements 仅是主进程内部生成元数据，不参与 sourceHash、任务批准、省略集合或资源身份。
- OfflineHtmlAdapter 不注入 A4 分页规则；只有 target 为 pdf 的输出 HTML 包含 PDF_PRINT_STYLE，防止离线 HTML 浏览体验被打印契约改变。

## 二十五、DOCX 与离线 HTML 输出投影契约

Word 排版结构和离线 HTML 文档外壳都属于适配器短寿命输出投影，不扩展 ParsedDocument、ResolutionSnapshot、DerivedAssetManifest 或 canonical editorText。

- DocxAdapter 从相同的 ParsedDocument 节点生成 Word 原生段落、编号、表格和内嵌资源。numbering reference、表格列宽、A4 页面尺寸、Word 样式 ID 和核心属性仅存在于本次 DOCX 包，不参与 sourceHash、referenceKey 或缓存身份。
- 列表编号由 listItem / taskItem 的 type、depth、start 与 checked 字段确定；表格对齐只读取 table.alignments。适配器不得从 Renderer DOM 或 Markdown 字符串二次猜测这些语义。
- DocxAdapter 对标题、列表、引用、代码和表格的布局增强不得重复、删除或改写 ParsedDocument 节点；未知或不可表示节点继续产生诊断并服从既有省略批准契约。
- OfflineHtmlAdapter 生成独立的 HTML 外壳、title、主题和响应式样式；title 来源于首个 heading 的纯文本投影并转义。深浅主题只影响输出 CSS，不回写 ThemeTokens 或文档模型。
- 离线 HTML 仅允许已重新校验并内嵌的数据资源。安全审计必须拒绝脚本、事件处理器、嵌套浏览上下文、对象载入和任何应用内部、本地或临时地址。
- DOCX/HTML Utility Process 重解析时继续复用任务 documentId、sourceHash、parserProfile 与 workspaceRevision；输出投影不得接收 PreviewSession 句柄或 Renderer-only 的 SourceRange 属性。
- 固定契约测试校验 OOXML 页面/编号/表格/样式结构和 HTML 自包含/主题/CSP/地址隔离，同时验证两个适配器不修改输入模型。

## 二十六、公众号替换清单与人工验收状态契约

第十五轮不改变 ParsedDocument、ResolutionSnapshot、DerivedAssetManifest 或 canonical editorText。WechatReplacementItem 是输出结果元数据，公众号验收进度是 Renderer-only 的短寿命状态。

- placeholderText 必须与 WechatClipboardAdapter 写入正文的可见占位文字逐字符一致；它由适配器根据最终 sequence、kind 和 placement 生成，详细说明单独保存在 label 中，不由 Renderer 再拼接。
- itemId、sequence、placement、sourceOffset、mimeType、width、height 和 placeholderText 只描述当前 jobId 的替换项。复制 IPC 仍只接受 jobId 与 itemId，不接收路径、图片字节、sourceKey 或任意剪贴板载荷。
- copiedReplacementIds 表示系统剪贴板位图已写入并读回；confirmedReplacementIds 表示用户声明已经在公众号正文完成替换。两个集合语义不可合并，也不得由同一事件同时更新。
- WechatAcceptanceProgress 只含 bodyPasted、draftSaved、draftReopened、mobilePreviewed 四个布尔值。draftSaved 仅在正文已粘贴且全部替换项已确认时可用，后续按保存、重开、移动端预览顺序解锁。
- 任一前置状态回退必须清除其全部下游状态；替换项确认数量必须与当前任务清单长度严格相等，不能以大于、旧任务残留或部分确认视为完成。
- completed-with-omissions 不改变门控算法，但输出界面必须携带 omittedReferenceKeys 数量并持续呈现部分完成语义。
- 验收状态不进入 OutputResult、IPC、sourceHash、恢复存储或任何适配器输入；文档/任务身份变化后旧状态不可复用。

## 二十七、公众号人工验收记录边界

WechatAcceptanceReport 是任务完成后的审计投影，不属于 ParsedDocument、ResolutionSnapshot、OutputResult 或恢复模型。

- SaveWechatAcceptanceReportRequest 只携带 jobId、confirmedReplacementItemIds 和四项人工确认布尔值，不携带正文、路径、资源字节、账号或浏览器状态。
- 主进程从 OutputJobRegistry 的终态结果恢复 documentId、sourceHash、status、replacementItems 和 omittedReferenceKeys；Renderer 提供的身份信息不可作为记录来源。
- 只有 target 为 wechat-clipboard 且 status 为 completed 或 completed-with-omissions 的任务可生成记录。
- confirmedReplacementItemIds 必须去重前后数量一致，并与 OutputResult.wechatReplacementItems 的 itemId 集合完全相等；顺序差异允许规范化，缺失、多余、重复或旧任务项目均拒绝。
- 报告时间、应用版本、平台和架构由主进程生成。报告生成器是确定性纯函数，除 generatedAt 外相同输入产生相同文本。
- 报告不进入 sourceHash、批准省略状态机或任务终态，也不能把人工声明升级为平台验证、发布或群发状态。

## 二十八、公众号标题投影与替换布局契约

- `wechatSuggestedTitle` 是 WechatClipboardAdapter 从第一个顶层 `heading(level=1)` 派生的纯文本输出元数据，最长 120 字符。对应标题节点只从本次公众号正文投影中省略，不从 ParsedDocument、canonical editorText 或其他输出目标中删除。
- WechatReplacementItem 的 `placement` 只有 `inline` 和 `block`。仅 `formulaInline` 为 inline；普通图片、formulaBlock 和 Mermaid codeBlock 均为 block。Renderer 不得根据图片尺寸或当前 DOM 猜测该字段。
- `placeholderText` 继续由适配器生成并与 CF_HTML 逐字符一致，但冻结为无资源描述的短唯一标记：`【FE类型NN｜行内替换】` 或 `【FE类型NN｜整段替换】`。资源描述继续保存在 label 中，避免长占位影响正文和选择操作。
- 占位标记可以带文字颜色和字重，但不得依赖 border、固定高度、空背景框或应用内部属性表达身份。用户替换全部文字后，即使公众号保留外层 span，也不得留下可见空框。
- copiedReplacementIds 与 confirmedReplacementIds 的语义不变；confirmed 现在同时声明对应图片已出现且 placeholderText 已消失。draftReopened 进一步声明重开后资源仍在、全部 FE 标记仍不存在。
- Mermaid 高清像素比例属于派生资源转换配置，不进入 ParsedDocument。隔离渲染器可以在 4096 像素上限内把 SVG 按最高 2 倍比例栅格化；OutputMermaidAsset.width/height 记录实际 PNG 像素。

## 二十九、空白会话与临时编辑投影契约

### 1. 空白文档是合法模型输入

- 空字符串是合法的 canonical `editorText`。解析结果必须为有效 `ParsedDocument`，其块节点、资源引用和诊断集合均可为空；`sourceHash` 仍按空 UTF-8 字节确定性计算。
- 未命名空白会话的 `requiresSave` 为 true，该状态属于文件会话元数据，不从 `editorText.length` 或 ParsedDocument 节点数推导。空白内容首次另存为允许写出 0 字节 Markdown。
- 首次另存为只改变文件路径、编码/换行元数据和保存基线，不更换当前 documentId。用户取消时不得改变 editorText、documentId、恢复键或脏状态。
- 未命名会话的临时目录由主进程提供的已创建、已授权绝对路径派生；解析 Worker、Renderer 和 Utility Process 不得自行调用环境变量或 `os.tmpdir()` 推导会话根。

### 2. 临时空段落不属于 UDM

- 所见即所得空白画布产生的临时空段落是 Renderer-only 的编辑投影；在用户输入实际内容前，不生成 Node、SourceRange、TextChange、revision、sourceHash 变化或恢复记录。
- 每个文档的编辑投影同时最多保留一个临时空段落。重复点击只改变焦点；失焦、Backspace、Delete、模式切换或输出前 `commitPending` 均可无事务地丢弃空投影。
- 提示文字“开始输入…”只能通过 placeholder 或伪元素呈现，不得进入 DOM 可编辑文本、剪贴板正文、序列化输入或可访问名称之外的数据通道。
- 临时段落出现非空输入后，编辑器必须生成一个经过 `expectedText` 校验的最小插入 TextChange，并通过共享事务管理器更新 canonical editorText；成功前不得提前生成正式 ParsedDocument 节点。
- 安装版、便携版和开发运行使用完全相同的本节契约。分发形态不得改变 documentId、sourceHash、恢复格式或输出任务语义。

## 三十、公众号主题与封面对输出契约

### 1. WechatThemeDefinition

- 正文主题属于输出配置，不属于 ParsedDocument、ResolutionSnapshot、DerivedAssetManifest 或 canonical editorText。最小身份由 `themeId`、`schemaVersion`、`compatibilityProfile` 和规范化后的令牌集合组成。
- 受控令牌至少覆盖背景、次级背景、正文、弱化文字、强调色、弱强调色、边线、强调色上的文字、标题/正文/代码字体、正文字号、行高、段落间距，以及 heading、blockquote、codeBlock、table、link 和 callout 的结构样式。
- Renderer 只能选择已注册 themeId 或提交经过主进程结构校验的主题设置；适配器不得接受任意 CSS、HTML、脚本、URL、字体文件或模板路径作为主题令牌。
- 输出 sourceHash 不包含主题偏好；同一正文使用不同主题仍是相同文档快照，但 OutputContext.theme.id 和规范化令牌必须参与输出缓存键、产物元数据和验收记录。

### 2. 主题编译边界

- WechatCompatTransformer 从 ParsedDocument 生成结构化公众号投影，再把主题令牌编译为绝对行内样式。最终 CF_HTML 不保留 CSS 变量、class、id、伪元素、外部样式表、运行时脚本或预览 SourceRange 属性。
- 主题编译不能新增、删除或重排语义节点；仅允许公众号标题投影、资源占位和已冻结兼容变换。主题切换不得改变 replacementItems、approvedOmittedReferenceKeys、诊断集合的资源身份或任务五种终态。
- 主题定义和编译结果必须经过颜色格式、字号、行高、长度、危险字符、地址协议、HTML 安全和体积上限校验。外部 IPC 的非法主题必须失败；只有受信任内部解析器可回退到内置安全主题，不得部分应用后显示完整成功。

### 2.1 当前 P1 第一、二阶段契约

- `WechatThemeId = "wechat-native-enhanced" | "minimal-ink" | "deep-blue-tech"`；共享包提供只读展示元数据、受控 `WechatThemeDefinition`、`resolveWechatTheme` 和 `applyWechatThemeToFragment`。Renderer 只能用这些内置定义生成本地预览，不能提交或持久化任意 CSS。
- `BeginOutputRequest.wechatThemeId` 可省略，省略时使用 `wechat-native-enhanced`。主进程收到未知值必须在创建输出任务前拒绝；不得把未知字符串回退后继续显示完整成功。
- 主进程把已验证 ID 写入 `OutputContext.theme.id`；用户字体继续单独进入 `OutputTheme.tokens["typography.body.fontFamily"]`。最终输出和 Renderer 手机预览加载共享包内同一份受信任主题定义，只有主进程可创建输出任务。
- 成功的公众号任务必须在 `OutputResult.wechatThemeId` 中返回有效 ID，人工验收摘要和报告必须沿用该终态结果，不接受 Renderer 再次声明主题。
- 主题 ID、名称和强调色不进入 sourceHash、ParsedDocument、ResolutionSnapshot、DerivedAssetManifest、资源键或 replacement itemId。三套主题对同一快照的资源与省略集合必须相同。
- `WechatThemePreview` 读取当前已解析且完成本地资源映射的预览 HTML，只用于可视化；它不产生 OutputResult、不写剪贴板、不改变 replacementItems，也不构成公众号平台验收。手机宽度审计结果是短寿命 Renderer 状态，不进入 UDM、sourceHash、恢复快照或输出任务。
- 手机审计基线为 320px / 375px / 414px，三档探针必须在一次预览会话中并行完成并分别保留短寿命结果。检测项至少包含元素 scrollWidth/clientWidth、允许局部滚动的代码块、12px 最小提示阈值、WCAG 普通/大字号对比度阈值，以及标题前后基于实际几何位置和字号比例的最小间距；任何本地通过结果都不得自动设置 `WechatAcceptanceProgress.mobilePreviewed`。
- `0.2.0-rc.1` 只提升应用与内部包的发行版本，不改变 UDM schema、ParsedDocument schema、ResolutionSnapshot schema、资源键或输出五种终态；旧文档和恢复快照继续按现有版本化解析规则读取。便携包版本、哈希和签名状态属于发行元数据，不得写入 canonical Markdown 或 UDM。

### 3. 封面对输出

- `WechatCoverArtifact` 是独立输出 artifact，可包含 wide 21:9 和 square 1:1 两个 PNG 项及其 width、height、contentHash、mimeType、themeId 和可选来源清单。它不作为 ImageNode 回写正文，也不进入公众号方案 B replacementItems。
- 封面对生成只读取不可变标题/摘要投影和用户明确授权的图片资源；自动裁切位置、版式骨架、渲染临时 HTML 和视觉校验结果都是输出期短寿命数据，不进入 UDM。
- 使用外部 skill 或第三方模板时，产物元数据必须记录 generatorId、generatorVersion、licenseProfile 和 sourceAttribution 状态。未确认许可证或图源授权时不得进入正式发布产物。

## 三十一、公众号 HTML 安全审计投影契约

- `auditWechatHtmlMarkup` 是公众号 HTML 生成层、主进程剪贴板持久化层和生产冒烟的统一最终审计函数。它只读取短寿命输出 HTML，不进入 ParsedDocument、ResolutionSnapshot、DerivedAssetManifest、OutputContext、OutputResult 或 sourceHash。
- 审计对象是生成 HTML 的标签和属性；正文 text node、转义后的行内代码和代码块可以包含协议名称或 localhost 说明文字。安全审计不得把普通文章内容解释为资源引用，也不得据此改变 resourceReferences 或批准省略集合。
- 禁止标签、class/id、事件处理器和危险资源地址仍是阻断项。受控主题、字体令牌、链接投影或兼容变换只要把危险值写入真实标签属性或内联样式，任务必须 failed 且不得写剪贴板。
- 两层审计必须使用同一实现和问题枚举，不允许适配器先放行而主进程用另一套正则再次误判。该一致性属于输出边界契约，不改变 UDM schema。
- `OUTPUT_CLIPBOARD_WRITE_FAILED` 表示系统 HTML 剪贴板写入或读回失败；`OUTPUT_FILE_WRITE_FAILED` 只用于文件 artifact。两者均属于输出诊断，不改变五种终态枚举。
- 用户本机复测只证明相应不可变输出快照能够写入剪贴板，不构成公众号平台保存、重开、移动端或发布状态，不得写入 WechatAcceptanceProgress 的后续布尔值。
- `0.2.0-rc.2` 仅是包含本审计修复的应用发行版本；它不改变 UDM、ParsedDocument、ResolutionSnapshot、DerivedAssetManifest、OutputResult 或资源键 schema。便携包哈希、签名与启动结果继续只作为发行元数据保存。
- 自动生成的 portable/release manifest 属于发行元数据，不能进入 canonical Markdown、恢复快照、UDM 或 OutputResult。manifest 只保存可公开复核的相对产物名与校验结果，不保存工作区、临时目录或 userData 的绝对路径。

## 三十二、生产态发布验证投影契约

- `FANTASTIC_EDITOR_SMOKE_RESULT` 只存在于发行验证进程环境。应用完成一个生产态场景后写出 `fantastic-editor-smoke-result-v1`，字段限于 scenario、valid、pid 和 completedAt；该标记不是 OutputResult，不进入 IPC、UDM、恢复存储、文档缓存或用户数据。
- Windows GUI 外层启动器可能先于真实 Electron 子进程返回，因此 release gate 必须等待应用内部完成标记。基础启动、PDF、DOCX、离线 HTML、公式、Mermaid 与 UI 场景均不得只依据 launcher exit code 判定通过。
- 隐藏导出或渲染窗口的销毁不能在完成标记落盘前触发应用自动退出。正式用户会话仍保持“全部窗口关闭则退出”的 Windows 行为；仅带发行验证完成标记路径的进程由 `finishSmoke` 统一收尾。
- 生产态固定 PDF/DOCX/HTML 和 UI 截图属于短寿命验证 artifact，不进入 canonical Markdown、sourceHash、ParsedDocument、ResolutionSnapshot、DerivedAssetManifest 或任何正式导出历史。
- installer smoke 报告与 production smoke 报告属于本机发行证据，只允许记录相对路径、版本、场景终态、字节数和结构断言。它们不能被解释为第二台机器兼容性、公众号平台状态、代码签名或发布成功证明。
- 2026-08-29 `0.2.0-rc.2` 的本机发布加固已通过。第二台 Windows 不再是本候选的阻断条件；这一项目决策不改变 UDM 或输出 schema，也不把跨机器兼容性从未知推断为通过。

## 三十三、可访问性状态与解析重试边界

- live status、tablist/tab、aria-selected、aria-pressed、separator value 和焦点样式都是 Renderer 可访问性投影，不得进入 ParsedDocument、ResolutionSnapshot、PreviewSession、OutputContext、OutputResult、sourceHash 或恢复快照。
- “重新解析”只使当前 Renderer 的 previewRefreshVersion 单调增加，并由既有 ParseWorkerClient 使用同一 documentId、workspaceRevision、parserProfile 与 canonical editorText 创建新任务。它不是文档编辑，不创建撤销项，不改变 dirty 状态。
- 清除诊断只清空当前 Renderer 展示数组；下一次解析或资源更新必须从真实 Diagnostic 集合重新投影。不得通过清除按钮删除主进程诊断、改变阻断状态或绕过输出预检。
- 分栏比例是本机 UI 状态，冻结范围为 28–72。键盘和指针操作必须共用同一 clamp 规则，不能产生超范围布局；该比例不进入文档模型或导出主题。
- 解析失败后的可恢复入口不得复用旧 PreviewSession 冒充成功。只有身份一致的新解析、提交、资源解析和组合全部完成后，outputReady 才能恢复为 true。

## 三十四、键盘导航与模态焦点边界

- active tab index、roving tabindex、当前焦点元素和快捷键方向都是 Renderer 瞬时 UI 状态，不进入 canonical Markdown、ParsedDocument、ResolutionSnapshot、恢复快照或 OutputContext。
- `Ctrl+Tab`、`Ctrl+Shift+Tab` 和标签上的 Left/Right 必须按当前标签数组循环计算，Home/End 返回首尾。标签数组为空时返回无操作；切换标签只改变当前会话投影，不修改任一文档正文或 dirty 状态。
- `Ctrl+W` 必须调用统一关闭事务，沿用未保存确认、恢复快照和最后标签边界；不得另行直接删除标签状态。主题预览等模态层存在时，全局标签切换与关闭不得响应。
- 模态窗口的 priorFocus、dialogRef 和焦点圈都不参与结构化克隆。打开后初始焦点必须位于弹窗内，Tab/Shift+Tab 不能落到背景页面；Escape 或显式关闭后，焦点返回仍存在的触发控件或安全后备控件。
- 公众号主题预览中的手机宽度选择只改变预览 UI 的当前档位与审计明细；其 `aria-pressed` 是可访问性投影，不改变 themeId、DerivedAssetManifest、replacementItems 或 WechatAcceptanceProgress。

## 三十五、性能观测与最近文件身份边界

- `parseDurationMs` 是 Worker 对本次解析和预览 HTML 生成的短寿命测量；资源耗时由 Renderer 围绕当前 resolveResources 调用测量。二者不是 ParsedDocument 字段，不进入 sourceHash、ResolutionSnapshot、PreviewSession、OutputContext 或恢复快照。
- Renderer 性能快照只能绑定当前已接受的完整身份。正文变化或解析失效后先清除旧值，不能把上一版本耗时显示为当前版本结果。normal/notice/slow 是 UI 分级，不改变诊断严重级别或 outputReady。
- 标签排序只改变 Renderer tabs 数组的顺序；sessionId、documentId、workspaceRevision、savedText 和 draft 不变。恢复快照沿用数组顺序，不引入 tabOrder 字段或修改 UDM schema。
- `RecentFileEntry` 只含 recentId、displayName、lastOpenedAt。路径只保存在主进程 RecentFileStore；Renderer 的 `openRecentFile` 请求只含 recentId，主进程解析后仍必须执行普通文件打开、编码确认、大小限制和授权初始化流程。
- 最近文件持久化是非关键辅助状态，失败不得回滚已成功的打开或保存事务。失效 recentId 不提供路径回显，不尝试相似路径猜测，也不把父目录升级为 folder-workspace。

## 三十六、所见即所得旧投影结构校验

- DOM 元素的 SourceRange 即使仍位于当前文本长度内，也不能单独证明范围有效。打开结构化面板前必须把当前 canonical editorText 对应切片重新解析为预期的局部结构类型。
- Mermaid 元素只接受 language 为 mermaid 的完整 fence；普通代码块只接受完整合法 fence；公式元素同时校验公式语法和 displayMode。类型不匹配时不得创建 SourceEditState、不得提交事务，只提示投影正在更新。
- `data-projection-ready` 是 Renderer 冒烟和交互门控投影，不进入 UDM、IPC、恢复快照或输出。它只在父级确认当前 Markdown 已完成匹配解析时为 true。
- 本规则不改变 SourceRange、ParsedDocument 或 UDM schema，只补强“旧投影不得猜测性写回”的既有不变量。

## 三十七、公众号自动草稿同步边界（0.3.0 开发线）

- `0.2.0-rc.3` 的 `wechat-clipboard` 仍是方案 B：生成带短标记的正文并提供人工替换兜底；它不代表多图自动复制成功。`0.3.0` 新增的是按既有 `jobId` 发起的主进程草稿同步操作，不新增第二份 ParsedDocument、ResolutionSnapshot 或编辑器附件模型。
- 草稿执行 IPC 只能发送 `CreateWechatDraftRequest { jobId }`，不得夹带 HTML、图片字节、路径、AppID、AppSecret、access_token 或任意远程 URL。应用内凭据录入使用单独的窄配置 IPC：AppSecret 只在密码输入控件中短暂存在，提交后立即交给主进程加密，配置查询只返回 `hasAppSecret`，不得返回明文。主进程从已完成的公众号任务和加密凭据存储中组装输入，再交给 `WechatDraftConnector`。
- 自动同步必须一次处理全部普通图片、公式 PNG 和 Mermaid PNG。每个 replacement item 先上传到微信正文图片接口，得到通过协议和 loopback 校验的远程 URL；仅在全部上传成功后替换 HTML 中精确匹配的占位标记。任何未替换标记、本地地址、临时地址、Data URI 或安全审计失败都阻止草稿创建。
- 封面属于草稿元数据，不回写 `ParsedDocument`、`ResolutionSnapshot` 或正文 HTML。封面必须由用户明确配置/选择并经主进程读取和格式校验；没有有效封面时不得伪装草稿创建成功。
- 草稿创建成功后必须用返回的草稿 ID 回读校验，并只报告“已创建草稿”；本操作永不隐式发布、群发或删除草稿。上传失败、取消、超时和回读失败必须保留可追溯诊断，并区分已上传数量与草稿创建状态。
- AppSecret 明文仅允许在用户输入期间短暂存在于隔离 Renderer 和主进程调用栈，保存时必须使用 Electron `safeStorage` 的系统加密；查询和重新打开配置时只暴露“已保存”状态，不回显明文。AppSecret/access_token 不能进入 localStorage、Markdown、恢复快照、导出 HTML、普通日志或 `OutputResult`。环境变量只作为开发兼容入口；正式多账号产品需迁移到自托管连接器或微信公众号第三方平台授权。
- 公众号凭据配置入口必须在主界面常驻可见。白名单检测使用独立无参数 IPC，由主进程读取加密凭据并请求微信 token 接口；Renderer 不得传入或取回 AppSecret。检测结果仅允许返回 `ready { ip | null, message }`、`whitelist-required { ip, message }` 或清洗后的 `failed`。`40164` 中的 `invalid ip` IPv4 可以显示和复制，`::ffff:` 映射值不得重复呈现；连接成功后允许主进程通过 `api.ipify.org` 的只读 HTTPS 查询补充 IP，查询失败只返回 `ip: null`，不能改变微信连接成功状态。该 IP 仅用于本次界面提示，不进入文档模型、恢复稿或导出结果。
- Renderer 只能呈现一个公众号配置入口，即主界面顶部常驻入口。发布验收助手不重复呈现配置按钮；当自动草稿动作发现配置缺失时，可以打开同一个配置对话框，但不得创建第二套配置状态或 IPC。
- 一键发布 IPC 只接收当前任务的 `jobId`；主进程按该任务重新组装并上传资源、创建草稿，再在用户明确二次确认后调用 `freepublish/submit`，不得由 Renderer 传入 HTML、图片字节、草稿 ID 或 access_token。`freepublish/get` 返回成功前，任务只能显示为处理中；轮询最多持续 90 秒，超时返回 `processing`，不得伪装为已发布。发布失败必须保留草稿 ID/发布任务 ID（如已获得）供用户到公众号后台处理。
- 方案 B 的剪贴板队列和浏览器辅助批量替换只能作为无 API 权限或 API 失败时的降级评估，不得在产品文案中称为全自动同步，也不得改变 `OutputResult.status` 五种终态。

## 三十八、代码签名与文档模型隔离

- Authenticode 证书身份、时间戳、签名状态和发布哈希只属于发行元数据，不进入 canonical Markdown、ParsedDocument、ResolutionSnapshot、DerivedAssetManifest、OutputContext、OutputResult 或恢复快照。
- 签名失败只能使发行门禁失败，不能把任何文档导出任务改写为 `failed`，也不能改变公众号草稿、批准省略或人工验收状态。
- PFX、私钥、证书密码和证书存储指纹不得经 Renderer IPC、日志、Markdown 或导出内容传播。构建脚本只接收进程环境或本机证书存储中的签名身份。
- 当前公益免费项目允许发行元数据保持 `NotSigned`；未签名状态只影响 Windows 发布提示与发行说明，不阻断 canonical Markdown、解析、导出或公众号草稿任务。商业代码签名证书不属于 `0.3.0-rc.1` 的完成条件。
- 未签名发行必须在 release manifest、Release 页面和 README 中记录 `NotSigned`，并提供官方来源及 SHA-256 校验值；不得使用自签名证书冒充受信任发布者。现有签名流水线仅作为未来可选能力保留。
- 当前公众号范围固定为单账号；支持显式确认后发布单篇文章，但不支持多账号、群发或定时群发。
