# fantastic-editor 统一文档模型规格

> 规格标识：fantastic-editor UDM  
> 版本：0.9-draft
> 状态：待阶段 0 技术验证后冻结  
> 关联文档：[fantastic-editor 开发项目书](fantastic-editor-开发项目书.md)


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

- 字体是用户界面和输出主题偏好，不是 ParsedDocument 字段。Renderer 以本机设置保存字体名称，发起输出时传入 `BeginOutputRequest.fontFamily`；主进程重新规范化后写入 `OutputTheme.tokens["typography.body.fontFamily"]`。
- 字体名称最大 64 字符，禁止控制字符和 `{ } ; < >`。适配器必须提供后备字体；字体不存在只允许降级，不得改变 Markdown 或使任务失败。
- `BeginOutputRequest.darkMode` 只用于主题身份和未来输出主题选择，不写入 ParsedDocument。当前白底导出固定使用 Mermaid 浅色主题，避免深色节点在 PDF、Word、离线 HTML 或公众号白底中失去可读性。

### 同步滚动开关视图

- ON/OFF 是 `syncScrollEnabled` 的可视化文本，`aria-pressed` 仍是可访问性真值。按钮文案、样式或图标不得成为同步逻辑的数据源。

## 源代码 / 所见即所得双编辑模式补充规格（首轮已实现）

> 首轮实现已使用 `WysiwygTextChange { from, to, insert, expectedText }` 做快照校验和最小文本补丁，并把事务提交到常驻 CodeMirror 历史。复杂块暂用 SourceRange 源码卡片，后续结构化命令仍必须遵守本节模型。

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

允许的首轮 intent 包括 `replaceText`、`setInlineMark`、`setHeadingLevel`、`setLink`、`toggleTask`、`insertBlock`、`deleteBlock`、`replaceImage`、`editImageAlt`、`editFormulaSource`、`editMermaidSource` 和 `editTableCellText`。结构化事务不是 IPC 文件写入请求，也不得携带 DOM、HTML、绝对路径或资源二进制。

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
