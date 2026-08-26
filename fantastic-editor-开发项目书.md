# fantastic-editor 开发项目书

> 文档状态：待冻结  
> 当前版本：1.1-draft
> 冻结条件：完成“公众号图片策略”技术验证，并确认本文第二章列出的全部规格决策。


## 本轮新增规格：Mermaid、字体与开关状态

### Mermaid 流程图

- fenced code block 的语言标识为 `mermaid` 时，实时预览必须渲染为流程图；语言匹配不区分大小写，其他代码块保持原样。
- 预览使用 Mermaid `securityLevel: strict`，不允许外部网络、窗口跳转或脚本注入。单篇最多预览 100 个 Mermaid 块，单块源码最多 100,000 字符；语法错误显示就地错误提示，不执行源码。
- Mermaid 预览 SVG 是 Renderer 短生命周期 DOM，不写入 Markdown、ParsedDocument、ResolutionSnapshot 或恢复稿。SourceRange 属性必须从原 `<pre>` 复制到流程图容器，确保同步滚动和选区提示仍然有效。
- PDF、Word、离线 HTML 和公众号输出不得依赖 Mermaid 运行时脚本。导出任务在无网络的隐藏 Chromium 窗口中渲染 Mermaid，并生成 PNG 派生资源；单图最大 4096 × 4096，单次渲染超时 12 秒，派生资源纳入 200 MiB 输出预算和 `DerivedAssetManifest`。
- 离线 HTML 与 PDF 内嵌 Mermaid PNG；Word 使用图片段落；公众号方案 B 将其作为 `diagram` 替换项生成连续编号占位，并允许用户逐项复制 PNG。

### 预览与导出字体

- 预览区提供字体选择器，内置微软雅黑、Segoe UI、等线、宋体、楷体，并允许输入本机已安装字体名称。
- 字体名称需去除首尾空白、合并连续空格，长度不得超过 64，禁止控制字符和 `{ } ; < >`；非法值回退到 `Microsoft YaHei UI`。
- 用户选择只保存在本机 `localStorage`，不写入 Markdown、文件会话、恢复稿或 ParsedDocument。发起导出时通过 `OutputTheme.tokens["typography.body.fontFamily"]` 传递，使 PDF、Word、离线 HTML 和公众号正文使用同一字体偏好；目标平台缺少该字体时按各适配器后备字体降级。

### 同步滚动开关显示

- 同步滚动按钮必须直接显示 `同步滚动 ON` 或 `同步滚动 OFF`，并继续提供 `aria-pressed`、悬停说明和本机持久化。
- ON 表示编辑区驱动预览区及选区提示；OFF 表示两个区域独立滚动并清除临时提示。显示文字不得取代布尔状态作为业务数据源。

## 源代码 / 所见即所得双编辑模式（首轮已实现）

> 2026-08-26 首轮实现：标题与普通段落支持直接编辑及粗体、斜体、删除线、链接和标题级别命令；图片、公式、Mermaid、列表、表格、引用和代码块通过绑定精确 SourceRange 的源码卡片编辑。CodeMirror 继续常驻并持有 canonical `editorText` 与共享撤销历史。

### 产品形态

- 编辑区提供“源代码”和“所见即所得”两个明确模式；模式选择属于本机 UI 偏好，不写入 Markdown、ParsedDocument、恢复稿或导出文件。
- 源代码模式继续使用 CodeMirror，并保留当前分栏预览、同步滚动 ON/OFF 和选区提示。
- 所见即所得模式以与预览区相同的主题、字体和内容样式显示可编辑文档，默认隐藏重复预览；同步滚动设置保持但不参与该模式，切回源代码模式后恢复原状态。
- 两种模式不是两份文档。canonical `editorText` 与文件会话元数据始终是唯一保存来源，ParsedDocument 只是不可变语义快照。

### 编辑与写回

- 所见即所得视图只能通过结构化编辑命令修改 canonical `editorText`，不得把可编辑 DOM、innerHTML 或整篇 HTML 反向序列化为 Markdown。
- 每个命令必须绑定 `documentId`、提交前 `sourceHash`、目标 `SourceRange` 和用户意图；主编辑事务管理器校验快照后生成最小文本补丁、提交、重新解析并更新视图。快照过期时必须重新定位或拒绝，不能写到旧偏移。
- 源代码输入和所见即所得命令共用同一撤销/重做历史。跨模式切换、解析刷新和纯预览渲染不产生历史项；一次用户操作只产生一个可撤销事务。
- 模式切换前必须提交输入法组合文本和当前编辑事务；切换本身不得改变 `editorText`。光标、主选区和滚动位置以 SourceRange/文本偏移尽可能映射，不能依赖跨解析不稳定的 `nodeId`。
- 保存直接读取当前 canonical `editorText`，不得等待所见即所得 DOM、ParsedDocument 或资源派生结果完成。

### 首轮支持范围

- 直接编辑标题、段落、粗体、斜体、删除线、链接、引用、普通列表、任务列表和代码块；表格首轮保证预览一致，并至少提供单元格文本编辑，结构调整可引导切回源码模式。
- 图片显示为真实预览，支持拖入、按钮插入、替换、删除和 alt 文本编辑；所有操作继续走正式资源导入、授权和 Markdown 图片语法管线。
- 公式显示 KaTeX 结果，选中后通过受控源码编辑器修改 LaTeX；Mermaid 显示流程图，选中后通过受控源码编辑器修改 fenced code block 内容。渲染结果本身不得成为保存来源。
- 原始 HTML、普通 Wiki 链、Callout、脚注及其他未冻结语法显示为保留原文的只读块，并提供“在源代码模式中编辑”；不得静默删除、降级或重排。

### 验收基线

- 在两种模式间反复切换但不编辑时，canonical `editorText` 必须逐字符不变。
- 所见即所得修改一个节点时，未触及范围内的列表标记、围栏长度、空白、换行和其他 Markdown 写法保持不变。
- 中文输入法、emoji、组合字符、撤销/重做、粘贴、多选区降级、解析失败和外部文件修改都有固定测试。
- 同一 sourceHash 从任一模式发起预览、PDF、DOCX、离线 HTML 和公众号输出时，语义内容与诊断必须一致。

## 一、项目概述

### 1. 项目名称

本地 Markdown 编辑与微信公众号排版发布工具  
工具名称：fantastic-editor

### 2. 项目定位

fantastic-editor 是一款面向 Windows 的本地 Markdown 编辑与内容发布工具。

软件以用户的 Markdown 原文为唯一编辑源，提供源代码和所见即所得两种编辑模式，能够打开、编辑和保存包含本地图片、数学公式、Mermaid、代码块、表格等内容的文档，并提供实时预览。用户可以把图片拖到编辑区的指定位置，或通过“插入图片”按钮选择文件；应用把图片导入文档资源目录、插入相对 Markdown 图片引用，并在预览区或所见即所得视图同步显示。

完成后的文章可以导出为 PDF、Word 和离线 HTML，也可以使用微信公众号主题进行排版、兼容性检查和富文本复制。公众号接口授权、素材上传、草稿创建和直接发布属于后续独立扩展，不阻塞首版交付。

### 3. 三个产品闭环

1. 本地文档闭环：打开、编辑、保存，并正确预览本地图片和数学公式。
2. 文件交付闭环：可靠导出 PDF、Word 和离线 HTML。
3. 公众号闭环：完成主题排版、兼容性检查和富文本复制。

第三个闭环是否包含“本地图片自动进入公众号”，必须由第一阶段技术验证决定。验证结果和产品承诺以 [公众号图片策略与技术验证方案](fantastic-editor-公众号图片策略与技术验证方案.md) 为准，不能在没有验证的情况下默认承诺。

### 4. 首版不包含

- 账号系统和云同步
- 在线文章数据库
- 公众号接口授权和直接发布
- 完整 Obsidian 语法兼容
- 多标签页
- 插件系统
- macOS 和 Linux 版本

## 二、冻结前必须确认的规格决策

以下决策全部完成后，项目书才能从“待冻结”改为“已冻结”。

### 决策 1：公众号图片

第一阶段必须在真实微信公众号编辑器中验证富文本和图片粘贴。

最终只能选择以下一种 P0 定义：

- 方案 A：验证通过，P0 承诺带图富文本复制。
- 方案 B：验证未通过，P0 明确为“文字与样式复制 + 图片替换助手”。
- 方案 C：将图片上传能力提前到 P0；这属于范围变更，需重新评估账号、服务端、安全和工期。

“粘贴失败后只提示一下”不算完成带图公众号闭环。

### 决策 2：单文件模式、文件夹模式和资源根

单独打开文件时：

- 创建 single-file 会话，父目录只作为最小授权边界。
- 不递归列出父目录中的 Markdown，也不建立全目录文件名索引。
- 标准相对图片严格相对当前 Markdown 文件直接解析。
- 简单双链图片只在当前文件目录精确查找。
- 引用越出父目录或需要跨目录双链搜索时，提示用户明确“打开文件夹作为工作区”，不在后台自动扩大扫描范围。

明确打开文件夹时：

- 创建 folder-workspace 会话，用户选择的文件夹作为工作区根。
- 只有该模式才递归列出 Markdown 并建立受限资源索引。
- 标准相对图片仍相对当前 Markdown 文件解析。
- 双链图片按确定性规则解析；同名冲突不自动猜测。
- 更换工作区根时提升 workspaceRevision，并使旧资源结果失效。

两种模式都不使用零散的任意文件授权。详细解析规则见第五章。

### 决策 3：打开文件夹的最小界面

“打开文件夹”保留在 P0，因此 P0 必须带一个最小 Markdown 文件列表：

- 显示工作区内的 Markdown 文件。
- 单击文件时切换当前文档。
- 切换前处理未保存内容。
- 切换当前文件等于结束旧文件会话：必须新建 documentId 和 recoveryKey，不得复用上一篇的引用键和恢复稿。
- P0 同时只编辑一个当前文档。

完整文件树、多标签页和拖拽排序留在 P1。

### 决策 4：保存保真

保存只写入 canonical `editorText` 缓冲区。源代码模式的 CodeMirror 事务和所见即所得模式的结构化命令只能通过同一主编辑事务管理器更新该缓冲区。

统一文档模型只用于预览、诊断和导出，任何情况下都不得通过文档模型重新序列化 Markdown 并覆盖用户文件。

### 决策 5：编码、BOM 和换行

P0 文件会话必须独立保存以下元数据：

- encoding：utf8 或 utf8-bom
- hasBom
- eolStyle：lf、crlf 或 mixed
- diskFingerprint
- workspaceRevision
- recoveryKey

处理规则：

- 支持 UTF-8 和 UTF-8 BOM，并保留 BOM 状态。
- 进入 CodeMirror 前移除 BOM，并把单一 LF 或 CRLF 文件转换为内部统一的 LF editorText。
- CodeMirror、SourceRange 和 sourceHash 始终使用 LF editorText；不依赖编辑器保留磁盘换行符。
- 保存时根据文件会话元数据把内部 LF 转回 LF 或 CRLF，再按 BOM 状态写盘。
- 混合换行在进入可编辑状态前提示用户选择统一为 LF 或 CRLF；确认后转换为 LF editorText，并立即标记为已修改。
- P0 不承诺无损编辑混合换行文件。
- 检测到 GBK、GB18030 等其他编码时，显示检测结果和转换预览；用户明确确认后转换为 UTF-8 并进入编辑，不静默转换，也不按原编码写回。
- “逐字符一致”指编辑缓冲区语义和所选 lineSeparator 下的保存结果，不包含用户明确接受的编码或换行转换。

### 决策 6：解析器和语法来源

- markdown-it 及锁定的插件集合是 Markdown 语义的唯一来源。
- CodeMirror 只负责编辑、选择、高亮和交互，不使用其语法树进行导出。
- 预览和所有导出使用同一个 document-core 包、同一个插件集合和同一份配置。
- 依赖版本记录在锁文件中；升级解析器必须运行固定语法回归测试。
- P0 parserProfile 明确设置 breaks 为 false，采用 CommonMark 单换行语义；Typora 风格的单回车强制换行留在 P1 作为可配置选项。

### 决策 7：文档模型和资源解析边界

统一文档模型拆分为：

- ParsedDocument：纯 Markdown 语法、源码映射和语法诊断。
- ResolutionSnapshot：绑定 workspaceRevision 的资源解析结果。
- PreviewSession：ParsedDocument、ResolutionSnapshot 与 PreviewDerivedManifest 的预览期组合视图。
- ResolvedDocumentView：ParsedDocument 与 ResolutionSnapshot 的导出期只读组合视图。

节点、稳定资源键、资源、警告和进程边界以 [统一文档模型规格](fantastic-editor-统一文档模型规格.md) 为准。

### 决策 8：文档快照、引用身份和资源缓存

- sourceHash 使用 SHA-256，输入为已移除 BOM、换行统一为 LF 的 canonical editorText UTF-8 字节。
- sourceHash 只标识整篇文档快照，不参与单个文件资源的缓存键。
- referenceKey 标识当前 ParsedDocument 快照中的一次资源引用；它由 documentId、SourceRange 和 normalizedResolvedRef 确定，只用于节点、诊断和 ResolutionRecord 对齐。
- assetCacheKey 只为已解析的本地或应用受控资源生成；本地文件由主进程根据 workspaceId、真实工作区相对路径和文件指纹计算，用于跨文本编辑复用同一文件资源。
- contentHash 在读取资源字节后计算，用于内容去重、转换缓存和派生资源缓存。
- 编辑正文导致 SourceRange 变化时可以产生新的 referenceKey，但只要文件指纹未变，仍应命中 assetCacheKey，不重新读取或栅格化图片。
- 派生图片只存在于 PreviewDerivedAssetCache、输出结果或 DerivedAssetManifest，不回写 ParsedDocument 或 ResolutionSnapshot。

### 决策 9：文件夹索引

- 索引只在用户明确打开文件夹后启动；单文件会话不递归索引父目录。
- folder-workspace 模式递归列出 Markdown 并建立资源文件名索引，但不读取或转码全部图片。
- 默认忽略 .git、.obsidian、node_modules、应用缓存和隐藏目录。
- 默认不跟随目录符号链接、Junction 或其他重解析点。
- 索引设置软上限和硬上限；具体数值由阶段 0 大目录基准测试冻结。
- 达到软上限时警告，达到硬上限时停止递归并允许用户缩小工作区。
- 默认拒绝把盘符根、用户主目录、Desktop、Documents、Downloads 或系统目录作为递归工作区；确需使用时必须经过单独的高风险确认。

### 决策 10：图片导入、插入位置和可移植性

- P0 同时提供两种入口：把图片文件拖到源代码或所见即所得编辑区的指定位置，以及点击“插入图片”后选择文件。
- 拖放路由同时按落点和文件类型判断：支持图片落在编辑区时执行插入；`.md`/`.markdown` 落在窗口时执行打开。图片落在编辑区之外不隐式修改文档；Markdown 与图片混合拖入时整批拒绝并提示分开操作，避免同时打开文档和写资源。
- 源代码模式拖入时使用 CodeMirror `posAtCoords` 计算插入位置；所见即所得模式把命中块和浏览器选择映射为 canonical editorText 偏移。按钮插入使用当前选择区或光标位置。异步导入期间，插入锚点必须随共享编辑事务映射，不能因为用户继续输入或切换模式而落到旧偏移。
- 已保存文档的默认资源目录固定为 Markdown 同级的 `assets/`。目标文件名使用清洗后的原文件名与内容哈希短后缀，禁止静默覆盖；相同内容可以复用已有资源。
- 未命名文档第一次导入图片前必须先完成“另存为”，不使用退出后会失效的临时地址，也不把图片二进制塞入 Markdown data URI。
- 点击选择由主进程文件对话框完成；拖入图片通过专用、一次性的导入 IPC 传递用户明确拖入的文件内容。该 IPC 不是任意路径读取接口。
- 主进程校验扩展名、文件签名、MIME、单图大小、文档身份和工作区授权后，在 `assets/` 内使用临时文件加安全替换完成写入，并只向 Renderer 返回正斜杠相对引用、contentHash 和非敏感元数据。
- 导入成功后，Renderer 通过主编辑事务管理器以一个事务插入 `![alt](./assets/name.ext)`；源代码和所见即所得模式共用该路径。多图按拖入顺序插入，默认以空行分隔。撤销只撤销 Markdown 编辑，不自动删除可能已被其他位置引用的资源文件。
- 资源落盘后更新工作区资源索引和 workspaceRevision，旧 ResolutionSnapshot 失效；新解析继续走标准 ResourceReference、ResolutionSnapshot 和 PreviewSession 管线，不建立图片导入专用预览旁路。
- 导入图片与手写相对图片在解析、预览、PDF、DOCX、HTML 和公众号输出中语义完全相同。详细模型契约见 [统一文档模型规格](fantastic-editor-统一文档模型规格.md)。
## 三、核心工作流程

    新建或打开本地 Markdown 文件 / 文件夹
            ↓
    确认工作区根和文件编码
            ↓
    按需解析引用资源和数学公式
            ↓
    编辑文本，拖入或选择图片并写入 assets/
            ↓
    插入相对 Markdown 图片引用并同步预览
            ↓
    保存或另存为
            ↓
    选择 PDF / Word / 离线 HTML 导出
            或
    切换微信公众号主题并执行兼容性检查
            ↓
    根据已冻结的图片策略分流
       ├── 方案 A：解析并转换图片 → 生成完整 HTML → 写入剪贴板
       └── 方案 B：生成带编号占位的 HTML → 写入剪贴板 → 用户逐图替换
            ↓
    用户在公众号后台复核并发布

## 四、目标用户与明确支持范围

### 1. 目标用户

- 使用标准 Markdown 写作的内容创作者
- 使用 Typora、Obsidian 或 MinerU 生成 Markdown，但愿意按照本项目支持矩阵处理不兼容语法的用户
- 需要本地编辑、数学公式、图片和多格式导出的研究人员、学生和技术作者
- 需要将文章排版后发布到微信公众号的作者

本项目不承诺首版完整兼容 Obsidian、Typora 或 MinerU 的全部扩展语法。

### 2. P0 Markdown 语法矩阵

P0 支持：

- ATX 标题、Setext 标题、段落、粗体、斜体、删除线
- 有序和无序列表
- 任务列表
- 引用
- 行内代码和围栏代码块
- 链接
- 标准行内图片和引用式图片
- GFM 风格表格
- 分隔线和换行
- KaTeX 行内公式和块级公式
- Mermaid fenced code block；语法层保持 codeBlock，预览和输出按已冻结派生资源规则特化
- 简单双链图片：![[path/image.png]]

P0 不支持或不保证：

- 普通 Wiki 链接
- 无扩展名双链图片
- ![[image.png|300]] 等尺寸别名
- Obsidian Callout
- 脚注
- 任意 Obsidian 插件语法
- 未经安全清洗的原始 HTML
- 默认加载远程图片

P1 再根据用户样例增加扩展语法。每增加一种语法，必须同时覆盖预览、诊断和所有相关导出。

### 3. 典型场景

单文件场景：

1. 用户直接打开 article.md，软件创建 single-file 会话；父目录仅为最小授权边界，不递归扫描。
2. 标准相对图片直接相对 article.md 解析；简单双链只在当前目录精确查找。
3. 若文章引用 ../assets/image.png 或需要跨目录双链搜索，软件提示用户明确打开包含文章和 assets 的共同文件夹。
4. 用户编辑、预览并保存；保存内容来自编辑缓冲区和文件会话元数据。

文件夹场景：

1. 用户主动选择项目文件夹，软件创建 folder-workspace 会话并建立受限索引。
2. 用户从最小文件列表选择当前 Markdown。
3. 标准相对图片相对当前文档解析；双链按 folder-workspace 规则解析。
4. 用户可导出 PDF、Word、离线 HTML，或执行公众号排版、复制和发布前复核。

## 五、P0 功能范围

### 1. 文件和最小工作区

- 打开 .md 和 .markdown 文件
- 打开文件夹
- 最小 Markdown 文件列表
- 当前文件切换
- 工作区根显示与重新授权
- 最近打开文件；渲染进程只使用 recentId，请求主进程打开已登记记录
- 保存、另存为
- 未保存状态
- 关闭、切换或退出前提示
- UTF-8 和 UTF-8 BOM
- 单一 CRLF 和 LF 保留
- 混合换行确认并统一
- GBK、GB18030 等编码的显式 UTF-8 转换流程
- 每个文件独立的编码、BOM、换行、磁盘指纹和恢复元数据
- 基本撤销、重做、查找和替换
- 异常退出恢复

### 2. 资源解析

标准图片解析：

1. document-core 先按协议类型生成 ResourceReference.kind，再输出 originalRef、展开后的 resolvedRef、唯一的 normalizedResolvedRef 和 referenceKey。
2. referenceKey 由 document-core 使用主进程分配的 documentId 计算；主进程只校验和使用，不重新计算或改写。
3. 只有 local-path 进入本地路径解析。remote-http、data-uri、file-uri、app-internal 和 unsupported-scheme 不得拼接为本地相对路径。
4. P0 对各 kind 的默认策略：
   - remote-http：阻止请求，生成 REMOTE_IMAGE_BLOCKED。
   - file-uri、app-internal、unsupported-scheme：阻止，生成对应诊断，不转成本地路径。
   - data-uri：P0 一律阻止，生成 DATA_URI_SOURCE_BLOCKED，不解码、不预览、不导出。完整 payload 只允许存在于用户原始 editorText 及 document-core 的受控解析输入，不得复制进 ImageNode、ResourceReference、Diagnostic、ResolutionSnapshot、ResolveRequest、资源缓存或日志。
   - 离线 HTML 或公众号候选路线由输出适配器从已授权、已校验的资源字节生成 Data URI，属于输出表示，不代表支持源 Markdown 的 data URI。
5. 对 local-path 校验百分号编码并严格解码一次；解码结果不再进行第二次解码。若解码后引入路径分隔符、父目录段、盘符或 UNC 前缀，仍按后续真实路径和工作区边界规则检查。
6. 分类时先识别 Windows 盘符绝对路径、盘符相对路径和 UNC 路径，不能把 C:\... 误判为 URI scheme；盘符相对路径在 P0 直接阻止，UNC 和绝对路径仍须通过授权边界检查。
7. 以当前 Markdown 文件目录为基准生成普通相对路径候选；规范化 UNC 时保留开头两个分隔符。
8. 解析绝对规范路径和真实路径，包括符号链接、Junction、长路径和盘符大小写差异。
9. 对真实工作区根执行带目录边界的包含检查，不能只做字符串前缀比较。
10. 只有通过检查后才读取；未通过时返回带源码位置的诊断，不自动扩大权限。

双链图片按会话模式解析。

single-file：

1. ![[folder/image.png]] 只尝试相对当前 Markdown 文件目录的精确路径。
2. ![[image.png]] 只在当前 Markdown 文件目录按完整文件名精确查找，不递归。
3. 找不到或需要越出父目录时，提示用户明确打开文件夹作为工作区，不自动启动索引或扩大权限。

folder-workspace：

1. ![[folder/image.png]] 先尝试相对当前文档目录的候选。
2. 该候选不存在或越出工作区时，再尝试相对工作区根的精确路径；越权候选不得读取。
3. ![[image.png]] 在工作区文件名索引中按完整文件名查找。
4. 只有一个安全候选时使用；多个候选返回“资源歧义”并列出工作区相对路径。
5. 没有安全候选时，根据实际情况返回“资源缺失”或“资源越权”。

两种模式都不支持无扩展名和尺寸别名。

工作区根发生变化时：

- workspaceRevision 加一。
- 立即撤销旧资源句柄。
- 丢弃旧 ResolutionSnapshot。
- 重新建立必要索引并重新解析所有资源引用。
- 纯语法 ParsedDocument 可以在 sourceHash 未变化时复用。

支持的本地预览格式：

- PNG
- JPEG
- GIF
- WEBP
- SVG

SVG 在进入预览或导出前必须执行安全处理。P0 默认在隔离图片处理进程中清洗并栅格化 SVG，禁止脚本、事件、外部资源和外部字体。

预览 SVG 使用独立的 PreviewDerivedAssetCache：

- 主进程完成授权读取和源文件 contentHash 计算。
- 隔离图片处理进程按 contentHash、转换配置和转换器版本生成安全 PNG。
- 缓存返回短生命周期 previewAssetHandle。
- PreviewDerivedAssetCache 不修改 ResolutionRecord，也不与导出期 DerivedAssetManifest 混用。
- 工作区授权撤销、源 contentHash 变化或转换器版本变化时，旧预览派生结果失效。

P0 对清洗后的原始 HTML 中的 img 标签采取阻止策略，并生成诊断，要求用户改用 Markdown 图片语法。后续若需要支持，必须把其 src 转换成正式 ResourceReference，不能绕过资源管线。

### 3. 编辑、图片导入和保存

图片导入流程：

1. Renderer 根据拖放坐标或当前光标建立可映射的插入锚点和 importRequestId。
2. 未命名文档先完成另存为；用户取消时不读取、不复制图片，也不修改 Markdown。
3. 点击入口由主进程显示图片选择对话框；拖放入口只接收用户本次明确拖入的图片内容和清洗后的显示名。
4. 主进程完成格式、文件签名、容量、目标目录和会话身份校验，在 Markdown 同级 `assets/` 中安全写入或按 contentHash 复用已有文件。
5. 主进程返回 `ImportedAssetReceipt`，其中只包含 importRequestId、documentId、sessionId、workspaceRevision、relativeRef、displayName、contentHash、mimeType、byteLength 和 reusedExisting，不返回绝对路径。
6. Renderer 校验回执仍属于当前文档，通过主编辑事务管理器把 `![alt](relativeRef)` 作为一次共享事务插到已映射锚点；随后触发正常解析和资源解析，预览及所见即所得视图不使用临时 blob、file URL 或 data URI。
7. 任一步失败均保留原 Markdown；已落盘但未插入的文件登记为未引用资源，只有经过用户确认的资源清理功能才能删除。

- canonical `editorText` 保存当前编辑缓冲区；CodeMirror 和所见即所得视图只提交事务，BOM、编码和 lineSeparator 由文件会话元数据管理。
- 键盘输入、粘贴、拖入文本和程序化插入在进入编辑事务前统一把 CRLF 和单独 CR 转成 LF。
- 文档模型不参与 Markdown 回写。
- 文件指纹结构包含 byteLength、mtimeNs、ctimeNs，以及平台可获得时的 fileId；读取内容后以 contentHash 作为最终内容身份。
- 文件指纹只用于快速变化检测和缓存命中，不作为内容完全相同的密码学证明。
- 保存前比较磁盘文件指纹；文件已被其他程序修改时，提示用户重新加载、另存为或确认覆盖。
- 使用经过平台验证的替换保存流程：在目标文件同目录写临时文件，刷新、关闭临时句柄后再替换目标。
- 替换保存的正确性以 Windows 实测为准，不把 fs.rename 写成覆盖已存在文件的首选手段。
- 阶段 0 必须验证：目标已存在、文件占用、杀毒软件锁定、替换中途崩溃时，原文件不被截断或删除。
- 若 rename 无法覆盖，必须使用通过上述失败语义验证的替换策略；禁止“先删除原文件再改名”这种中间态会丢原件的流程。
- 若产品要求保留 ACL、加密属性、命名流或备份语义，再评估 ReplaceFileW 或等价原生实现；项目书不提前锁死某个 Win32 API。
- 任一替换步骤失败时保留原文件、临时文件和恢复稿，不清除未保存状态。
- 保存成功后才更新磁盘指纹并清除未保存状态。
- 每个文件会话拥有独立 recoveryKey，不能共用一份全局恢复稿。
- 文档变脏后空闲约 2 秒写恢复稿；持续编辑时最多每 10 秒写一次。具体间隔可以在阶段 0 性能测试后调整。
- 恢复稿保存 Markdown 文本、编码、BOM、换行、原文件指纹和工作区标识，不复制图片二进制。
- 保存成功后清理对应恢复稿；正常关闭未保存文档时仍按用户选择处理。
- 恢复稿设置版本数、总容量和过期时间；具体上限在阶段 0 冻结。

### 4. 实时预览

- 主进程创建文件会话时分配 documentId；同一文件会话内的所有解析任务复用该值。
- 文件夹列表中切换到另一篇 Markdown、关闭后重新打开，或打开另一文件，都必须新建 documentId 和 recoveryKey。
- Web Worker 接收 documentId、editorText、sourceHash、parserProfile 和 taskSequence，不自行创建 documentId。
- Web Worker 必须按 editorText 重算 sourceHash；与请求不一致则丢弃该任务，不得把未校验哈希写入 ParsedDocument。
- Renderer 接受 ParseResult 后向主进程提交 documentId、sourceHash、parserProfile 和 taskSequence，主进程返回短期 parseCommitId；ResolveRequest 必须携带该标识。
- parseCommitId 只用于异步顺序和会话一致性，不是针对已受控 Renderer 的安全证明；导出进程仍须按 editorText 重算 sourceHash。
- 解析工作在 Web Worker 中执行，不阻塞界面。
- 预览输入为 PreviewSession，包含 ParsedDocument、ResolutionSnapshot 和 PreviewDerivedManifest。
- PreviewDerivedManifest 保存 referenceKey 到 previewAssetHandle 的映射，不写回 ResolutionRecord。
- 初始派生清单随 ResolveResult 返回；后续转换结果使用 PreviewDerivedUpdate 增量发送，并携带 parserProfile、taskSequence、parseCommitId 和 manifestRevision。Renderer 只接受身份全部匹配且 revision 更大的更新。
- 源资源已 resolved、但对应 previewAssetHandle 尚未到达时，预览显示占位和进行中状态；不得视为预览完整成功，也不得把 pending 写进 ResolutionSnapshot。
- 预览只接收经过安全处理的输出。
- 图片按引用加载，不扫描和编码整个工作区。
- 普通数学公式预览由渲染进程使用本地 KaTeX 生成安全 DOM，不进入 PreviewDerivedManifest；需要 PNG 或 SVG 的导出公式才进入 AssetRenderWindow。
- 公式、图片和警告均可定位回原文。
- 大文档使用防抖；过期 taskSequence 的结果被丢弃。
- 预览中的外部链接不直接导航当前窗口。

#### 同步滚动与选区范围提示

- 编辑区和预览区提供“同步滚动”开关。P0 默认关闭，并在本机保存用户最近一次选择；该设置不写入 Markdown、文件会话、恢复稿或 UDM。
- P0 固定为编辑区驱动预览区的单向同步。预览区主动滚动不反向移动编辑区；双向同步属于后续独立能力，不能在 P0 中隐式启用。
- 同步定位必须使用 canonical editorText 的 UTF-16 SourceRange 与内部预览 DOM 锚点，不得直接套用两个滚动容器的百分比。图片、公式、表格和代码块造成的高度差必须通过锚点区间插值处理。
- 编辑区采用可视区域上方约 30% 的位置作为跟踪点；预览区即时定位，不叠加连续 smooth-scroll 动画。滚动事件通过 requestAnimationFrame 合并，避免高频 React 状态更新阻塞输入。
- 内部 PreviewAdapter 为可见块级元素生成 data-source-from、data-source-to 和类型标记；图片占位或已解析图片可以使用自身精确 SourceRange。标记只存在于实时预览 HTML，所有导出和公众号适配器都不得复用或输出这些属性。
- Renderer 维护短生命周期 PreviewSyncMap。它与当前 documentId、sourceHash 和解析任务身份绑定，不进入 ParsedDocument、ResolutionSnapshot、PreviewSession IPC、恢复稿或任何导出任务。
- 只有当前预览与当前编辑快照身份一致时才允许同步；文本变化到新预览到达之间暂停定位并隐藏旧选区提示，禁止拿旧 SourceRange 映射新文本。
- 用户产生非空主选区时，预览区显示块级范围提示框；跨多个块显示多个框。P0 不承诺把 Markdown 标记符、链接语法和行内格式精确映射到每个预览字符。
- 图片或其他具有精确锚点的独立可视内容在选区完全落入其 SourceRange 时优先提示该元素；只有光标而没有选择范围时不显示提示框。
- 提示框使用独立、pointer-events: none 的覆盖层，不修改正文 DOM 语义、不改变布局、不可被复制，也不得进入 PDF、DOCX、离线 HTML或公众号内容。
- 图片加载、SVG 派生结果到达、KaTeX 渲染、预览宽度或分栏比例变化后，Renderer 使用 ResizeObserver 重新测量锚点与提示框；不得重新解析 Markdown 仅为了获得像素位置。
- 关闭开关、切换文档、仅编辑视图、预览身份失效或组件卸载时，立即清除范围提示和待执行的滚动帧。

### 5. PDF 导出

- 使用独立打印模板和隐藏的、沙箱化 PDF BrowserWindow。
- PDF BrowserWindow 禁用 Node、导航和网络，使用临时 Session；加载本地静态打印页面，达到 ready 后由主进程调用 webContents.printToPDF，完成后销毁。
- PDF 不在 Utility Process 中生成。
- Electron printToPDF 作为首选候选，但必须通过阶段 0 分页和字体技术验证后才能锁定。
- P0 目标是内容完整、中文可读和常见结构不严重断裂，不承诺专业排版软件级分页。
- 使用打印 CSS 尽量避免标题孤行、图片截断、代码块和短表格不必要拆分。
- 阶段 0 确定参考 Windows、Chromium、PDF 查看器、中文字体来源、许可证和字体嵌入验证方法。
- 导出文件移动到没有安装原字体的参考机器后仍应正确显示中文。
- 若 printToPDF 仅存在可接受的分页限制，则降低并记录分页承诺。
- 若字体不能可靠携带，则更换可嵌入字体或输出实现。
- 若固定核心样例仍丢字、缺图或不可读，则评估替代引擎；不能一边验收失败一边保持 PDF 为“已完成”。

### 6. Word 导出

- 使用独立 DOCX 输出适配器。
- 正文、标题、列表和表格保持可编辑结构。
- 图片嵌入文件，不引用本地绝对路径。
- 数学公式首版允许以清晰图片或兼容对象嵌入，不承诺 Word 原生可编辑公式。
- Mermaid 代码块必须由隔离 Chromium 渲染器转换为 PNG 后嵌入 DOCX；Word 不执行 Mermaid 脚本，也不依赖网络或应用临时地址。
- Word 库在第一阶段通过中文、表格、代码、图片和公式样例后确定。

### 7. 离线 HTML 导出

P0 只提供“单文件离线 HTML”模式：

- CSS 内联或嵌入文档。
- 本地图片嵌入为 Data URI。
- KaTeX 在导出前预渲染为静态 HTML 和 CSS；所需字体嵌入文件。
- 不包含 katex.min.js、动态公式运行时或其他可执行脚本。
- 不依赖 CDN、原始 Markdown 目录或应用内部协议。
- 断网后可在常见浏览器中打开。
- 文档中明确标注导出失败或被跳过的资源。

多文件资源目录模式留在 P1。

导出前估算 Data URI 膨胀后的文件大小。阶段 0 必须冻结单文件 HTML 的软上限和硬上限；达到软上限时警告，达到硬上限时阻止导出并建议压缩图片或使用后续多文件模式，不能生成可能使浏览器失去响应的超大文件。

### 8. 图片格式与输出矩阵

P0 初始策略如下，最终以阶段 0 样例为准：

| 源格式 | 预览 | PDF | DOCX | 离线 HTML | 公众号 |
|---|---|---|---|---|---|
| PNG | 原格式 | 原格式 | 嵌入 | Data URI | 冻结图片策略 |
| JPEG | 原格式 | 原格式 | 嵌入 | Data URI | 冻结图片策略 |
| GIF | 动画预览 | 阶段 0 冻结静态帧规则 | 阶段 0 冻结静态或动画支持 | 保留 GIF | 真实环境验证 |
| WEBP | 原格式 | 技术验证 | 不兼容时转 PNG | Data URI | 技术验证或转 PNG |
| SVG | 安全栅格化 | PNG | PNG | 安全栅格化 PNG | PNG |

预览期转换进入 PreviewDerivedAssetCache，并通过 PreviewDerivedManifest 提供句柄；PDF、DOCX、离线 HTML 和公众号等导出期转换进入 DerivedAssetManifest。两者都不修改 ParsedDocument 或 ResolutionSnapshot。

### 9. 微信公众号排版和复制

- 至少一套稳定默认主题
- 公众号预览
- HTML 和纯文本双格式剪贴板
- 删除脚本、事件、内部属性和不兼容结构
- 代码块、表格、引用和列表兼容转换
- 公式转换为经过验证的图片或兼容结构
- 发布前兼容性检查
- 公众号图片能力严格按照技术验证后的冻结策略实现

P0 不包含标题、作者、摘要、封面和 Front Matter 发布映射，这些属于 P1。P0 的公众号能力只处理正文排版和图片。

通过拖放或“插入图片”导入的资源必须自动进入公众号预检和方案 B 图片替换清单，顺序、alt 和原文位置来自正式 ImageNode/ResourceReference，不建立另一套附件列表。P0 的“复制到公众号”仍表示正文排版复制加图片替换助手，不能称为多图一键复制。

若后续要求所有图片无需逐张替换，则新增独立的“创建公众号草稿”模式：经用户授权后，在主进程或受控服务中取得 access token，逐图调用公众号正文图片上传能力，将返回的持久地址只替换到公众号输出 HTML，再调用草稿接口。凭据不得进入 Renderer、Markdown、日志或普通配置文件；上传失败、部分成功和用户取消必须使用输出任务五种终态及精确诊断。该模式不是剪贴板增强，属于阶段 6 的账号/API 能力。

## 六、统一文档模型与输出架构

### 1. 数据原则

- 编辑源：canonical `editorText` 缓冲区加文件会话元数据；CodeMirror 和所见即所得视图只是两个编辑入口。
- 纯语法解析结果：ParsedDocument。
- 资源解析结果：绑定 workspaceRevision 的 ResolutionSnapshot。
- 预览输入：不可变的 PreviewSession，由 ParsedDocument、ResolutionSnapshot 和 PreviewDerivedManifest 组成。
- 导出输入：不可变的 ResolvedDocumentView；导出过程中另行生成 DerivedAssetManifest。
- 保存：文本缓冲区按文件会话的 BOM、编码和 lineSeparator 执行经平台验证的替换保存。
- 诊断：分别由语法解析、资源解析和输出适配器生成。
- 禁止从 ParsedDocument、ResolutionSnapshot 或输出结果反向生成 Markdown 用于保存。

### 2. 进程边界

    渲染进程
    ├── canonical editorText 与共享编辑事务/撤销历史
    ├── CodeMirror 源代码视图、所见即所得视图和预览容器
    ├── 提交 ParseCommitRequest 并取得 parseCommitId
    ├── 发送 ResolveRequest、接收 PreviewDerivedUpdate 并组合 PreviewSession
    └── 不拥有任意文件读写能力

    Renderer Web Worker
    ├── 接收主进程分配的 documentId
    ├── 使用 document-core 解析
    ├── 生成 ParsedDocument 和语法诊断
    └── 不访问文件系统

    Electron 主进程
    ├── 文件选择、文件会话和工作区授权
    ├── recentId 与最近文件记录
    ├── 目录索引和受限资源读取
    ├── 登记 ParseCommitRequest
    ├── 校验 ResolveRequest 并生成 ResolveResult / PreviewDerivedUpdate
    ├── 生成 ResolutionSnapshot
    ├── 替换保存和恢复稿
    ├── 剪贴板
    └── 编排导出任务

    Node 导出 Utility Process
    ├── 使用同版本 document-core
    ├── 按 sourceHash 验证输入快照
    ├── 接收不可变 ParsedDocument 或重新解析同一快照
    ├── 含 DATA_URI_SOURCE_BLOCKED 的任务若经批准省略，只接收 ParsedDocument，不传输含 payload 的 editorText
    ├── 使用绑定 workspaceRevision 的受限资源包
    ├── 生成 DerivedAssetManifest
    ├── DOCX / 离线 HTML / 公众号 HTML
    └── 不接受未经授权的任意路径

    隔离图片处理进程
    ├── SVG 清洗与栅格化
    ├── 普通图片格式转换
    ├── PreviewDerivedAssetCache
    └── 不拥有工作区任意路径权限

    隐藏 AssetRenderWindow
    ├── 使用 KaTeX 渲染公式
    ├── 生成公式 PNG / SVG 派生资源
    ├── 禁用 Node、导航和网络
    └── 同一 jobId 内批量渲染并清理 DOM，任务结束后销毁窗口

    隐藏 PDF BrowserWindow
    ├── 加载安全静态打印页面
    ├── 禁用 Node、导航和网络
    ├── 等待资源与字体 ready
    └── 主进程调用 webContents.printToPDF

预览和导出可以分别解析同一份不可变文本快照，但必须使用同一版本的 document-core 和配置，并通过 sourceHash 确保输入一致。跨进程引用按 referenceKey 对齐；资源复用由主进程 assetCacheKey 和 contentHash 完成。禁止各输出自行实现不同的 Markdown 解析逻辑。

### 3. 输出适配器

- PreviewAdapter
- PdfAdapter
- DocxAdapter
- OfflineHtmlAdapter
- WechatClipboardAdapter

各适配器共享文档结构、主题令牌、资源清单和诊断，但可以针对目标环境生成不同结构。

每个导出适配器必须先执行只读预检，再执行生成：

- OutputPreflightContext 不包含省略批准；适配器返回 OutputPreflightResult、全部目标兼容性诊断、candidateOmittedReferenceKeys 和不可覆盖的 blocking 诊断。
- 只有预检结果为 approval-required 时进入 awaiting-user-approval；用户确认后，主进程发送绑定任务身份的 ApproveOmissions 消息并创建最终 OutputContext。
- 生成阶段若出现预检未报告的新省略或新的 blocking 诊断，任务直接 failed，不允许二次静默降级。

## 七、导出就绪协议

每次导出由主进程创建不可变任务并返回 jobId，状态依次为：

    created
      → parsing
      → resolving-assets
      → rendering-assets
      → preflighting
      → awaiting-user-approval（仅存在可批准省略时）
      → ready
      → generating
      → completed / completed-with-omissions

也可能进入 failed、cancelled 或 timed-out。

OutputResult.status 固定为 completed、completed-with-omissions、failed、cancelled 或 timed-out；任务生命周期状态与最终结果状态使用同一组终态名称。

取消不传输 AbortController 或 cancellationToken。渲染进程发送 CancelJob(jobId)，主进程转发取消消息；各进程在本地使用自己的 AbortController，并保证同一 jobId 的迟到结果不会提交。

进入 ready 必须满足：

- sourceHash 与用户点击导出时一致
- workspaceRevision 与导出任务创建时一致
- ParsedDocument 和 ResolutionSnapshot 已冻结为本次任务快照
- 文档解析完成
- 所有已支持公式完成渲染；任一公式渲染失败则任务 failed，P0 不允许通过 approvedOmittedReferenceKeys 省略公式
- 所有已引用资源得到 resolved、missing、blocked、ambiguous、unsupported 或 failed 的最终状态
- 所需字体已加载或已确定回退
- 没有仍在 pending 的异步任务

默认等待时间在技术验证后确定。超时或资源失败时，必须让用户选择取消，或在看到完整省略清单后明确批准本次任务继续；不得静默生成缺图文件。

用户批准省略时：

- 批准只绑定当前 preflightId、jobId、documentId、sourceHash、workspaceRevision 和精确的 approvedOmittedReferenceKeys，不得复用于后续任务。approvedOmittedReferenceKeys 必须与当前预检的 candidateOmittedReferenceKeys 完全一致；只批准部分候选时必须取消或修改选项后重新预检。
- 只有与 ResourceReference 关联、且允许安全省略的 blocking 诊断可以在该任务中转为“已批准省略”；批准只授权省略，不授权读取被阻止资源。解析错误、公式渲染失败、输出结构错误和安全边界本身不得被覆盖。
- 适配器必须保留原诊断，并在 OutputResult 中回传 approvedOmittedReferenceKeys 和 omittedReferenceKeys。
- 只有 omittedReferenceKeys 非空且与本次实际采用的 approvedOmittedReferenceKeys 完全一致时，OutputResult.status 才能为 completed-with-omissions；任何未批准的省略都必须使任务 failed，界面不得显示“完整成功”。
- completed 只表示没有省略、没有未解决的 blocking 诊断且产物完整。

## 八、安全基线

安全不是第五阶段才开始的工作。第一阶段工程骨架必须满足：

- contextIsolation 为 true
- nodeIntegration 为 false
- sandbox 为 true；若特定功能不兼容，必须记录原因并采用等效隔离方案
- webSecurity 为 true
- preload 只暴露最小、带参数校验的接口
- CSP 默认拒绝未知脚本、对象、框架、网络连接和远程资源
- 拦截 will-navigate
- setWindowOpenHandler 默认 deny
- 外部链接只能经主进程校验后使用系统浏览器打开
- 禁止渲染进程直接读取文件
- 禁止任意路径 IPC；最近文件只能传 recentId，主进程从受保护记录解析真实路径
- 路径规范化和真实路径解析后重新检查工作区边界
- 远程图片默认阻止
- SVG 清洗并栅格化
- 原始 HTML 默认清洗
- P0 不提供“一键信任全部内容”开关
- 日志不记录文章正文、绝对私人路径和敏感凭据

建议 CSP 基线由安全设计和实际资源加载方式共同确定，不能为了修复预览问题直接关闭 CSP。

## 九、开发阶段

### 阶段 0：规格冻结和技术验证

目标：

- 先冻结与公众号 A/B 无关的 ParsedDocument Core：节点、SourceRange、保存隔离和 parserProfile
- 完成 CodeMirror LF、CRLF、UTF-8 BOM、混合换行和保存往返实验
- 完成公众号图片粘贴验证并选择唯一 P0 策略
- 验证 PDF 分页、中文字体嵌入和跨机器显示，并记录失败降级选择
- 验证 DOCX 中文、表格、代码、图片和公式
- 确定 Markdown 解析器插件集合和 breaks 配置
- 冻结资源解析、referenceKey、assetCacheKey、workspaceRevision 和 ResolutionSnapshot
- 确定资源根、目录索引和双链解析规则
- 验证安全自定义资源协议或受限资源读取方式
- 冻结参考 Windows、目标 Word 版本、目标浏览器和公众号测试环境
- 再冻结各输出适配器契约；公众号适配器不得阻塞 ParsedDocument Core 冻结

产物：

- 技术验证报告
- 公众号图片策略决策记录
- PDF 和 DOCX 样例
- 固定 Markdown 语法测试集
- 统一文档模型 0.6
- 已冻结的 P0 验收标准

阶段 0 原型代码默认作废，只用于验证。除非通过代码评审、测试和安全检查，不得直接升格为正式适配器。

### 阶段 1：安全工程骨架

- Electron、React、TypeScript 和 Vite
- 安全 BrowserWindow 和 preload
- CSP、导航和新窗口拦截
- document-core 包
- Renderer Web Worker
- 主进程工作区授权和受限读取
- Node 导出 Utility Process 骨架
- 隐藏 PDF BrowserWindow 与 printToPDF 调度骨架
- 隐藏 AssetRenderWindow 与公式派生资源骨架
- 隔离图片处理进程、PreviewDerivedAssetCache 和 PreviewSession 骨架
- jobId 创建、取消消息和迟到结果丢弃机制
- OutputPreflightContext / OutputPreflightResult、awaiting-user-approval 和 ApproveOmissions 状态骨架

### 阶段 2：本地编辑闭环

- 文件和文件夹打开
- 最小 Markdown 文件列表
- CodeMirror 源代码编辑
- 所见即所得编辑视图、共享事务历史和源码/可视模式切换
- 图片拖放、按钮选择、`assets/` 安全导入和光标/坐标插入
- 导入后标准资源解析与同步预览
- 资源解析
- KaTeX 预览
- 经 Windows 验证的替换保存
- 编码和换行处理
- 外部修改检测
- 异常恢复

### 阶段 3：三种文件导出

- PDF
- Word
- 单文件离线 HTML
- 导出就绪协议
- 导出失败和警告界面
- 固定输出回归样例

### 阶段 4：公众号排版闭环

- 公众号主题
- 公众号输出适配器
- 公众号图片冻结策略
- 富文本复制
- 发布前检查
- 真实公众号回归测试

### 阶段 5：稳定性和发布

- 大文档和大图片测试
- 性能和内存检查
- 安全边界测试
- 安装、升级和卸载
- 用户文档
- Windows 安装包

### 阶段 6：P1 和接口发布评估

首版完成后再评估：

- 多标签页和完整文件树
- 更多 Markdown 扩展
- 文章元数据和 Front Matter
- 自定义主题
- 长图和多文件 HTML
- 公众号账号授权
- 公众号凭据安全存储、正文图片上传、持久 URL 替换、草稿创建和直接发布；与本地方案 B 明确分流

## 十、P0 验收标准

### 1. 保存和文件安全

- 保存内容与编辑器缓冲区在所选 lineSeparator 规则下逐字符一致，不重排 Markdown。
- 保存后重新打开，Markdown 原文不发生非预期变化。
- 保留 UTF-8 BOM 状态和单一 CRLF/LF。
- 混合换行只有在用户确认统一后才能进入可编辑状态。
- 非 UTF-8 文件不被静默改写；用户确认转换后文档标记为已修改。
- 模拟保存失败时，原文件不被截断，未保存状态仍在。
- 文件被其他程序修改时，不静默覆盖。
- 异常退出后可恢复未保存内容。

### 2. 资源解析

- 标准相对路径严格相对当前 Markdown 文件。
- 越出工作区根时提示重新授权，不越权读取。
- 双链图片按 single-file 或 folder-workspace 的冻结规则和固定优先级解析。
- 同名冲突返回诊断，不自动猜测。
- 中文、空格、括号和 URL 编码路径可用。
- SVG 不执行脚本或加载外部资源。
- 将支持格式图片拖到编辑区后，Markdown 图片语法出现在实际放置位置；点击“插入图片”时出现在当前选择区或光标位置。
- 导入文件位于 Markdown 同级 `assets/`，引用使用正斜杠相对路径；移动 Markdown 与其 `assets/` 目录后仍可解析。
- 未命名文档导入前先另存为；取消、格式失败、容量超限或写入失败均不修改编辑缓冲区。
- 导入完成后预览通过正常解析链路同步显示；Renderer 不获得导入源绝对路径，源 Markdown 不生成 data URI。

### 3. Markdown 和公式

- P0 语法矩阵中的所有语法在预览和相关导出中有固定测试。
- CodeMirror 高亮差异不改变解析和导出结果。
- 行内和块级 KaTeX 正确显示。
- 错误公式能定位到原文。
- 不支持语法显示明确警告或按普通文本处理。
- 开启同步滚动后，长短不一的段落、标题、列表、代码块、表格、图片和公式按 SourceRange 锚点跟随，不使用整页滚动百分比。
- 非空主选区在预览中显示对应的块级范围提示；跨块选区显示多个提示框，折叠光标不显示提示框。
- 编辑后等待新预览期间不使用旧映射；图片加载、公式渲染和分栏缩放后定位仍保持稳定。
- 关闭同步滚动后两个区域恢复独立滚动，提示框清除；实时预览的映射属性与提示层不进入任何导出或公众号内容。

### 4. PDF

- 在规定的参考 Windows 环境和测试文档中可正常打开。
- 中文、图片、公式、表格和代码可读。
- 字体嵌入或等效携带方式通过验证。
- 导出文件移动到另一台机器后显示正常。
- 分页能力按照阶段 0 冻结的边界验收，不使用“所有复杂内容绝不跨页”等不可验证承诺。

### 5. Word

- 目标版本 Microsoft Word 打开时不提示修复。
- 正文、标题、列表和表格保持可编辑。
- 图片和公式随 DOCX 文件移动后仍显示。
- Mermaid 流程图以清晰 PNG 嵌入，随 DOCX 文件移动后仍可显示；语法错误、超时或派生资源校验失败不得显示为“完整成功”。
- 已知版本差异有记录。

### 6. 离线 HTML

- 单个 HTML 文件断网可打开。
- 图片、样式、KaTeX 和字体不依赖原始目录或 CDN。
- 不包含应用内部地址。
- 不执行脚本。
- 资源失败有可见说明。

### 7. 微信公众号

最终验收由公众号图片策略冻结结果决定。

所有方案共同要求：

- 文字与样式可以粘贴到真实公众号编辑器。
- 最终内容不包含 file、app、blob、localhost 等本地或临时地址。
- 重新打开公众号草稿后内容仍在。
- 代码块、列表、引用和表格达到冻结样例标准。
- 公式按冻结策略保持可读。
- 图片能力不使用未经验证的模糊表述。

### 8. 安全

- 渲染进程不能任意读取或写入系统文件。
- 路径跳转和符号链接不能越出工作区根。
- 远程图片默认不请求。
- 原始 HTML 和 SVG 不能执行脚本。
- 应用窗口不能被 Markdown 导航到外部网页。
- CSP、导航拦截和新窗口策略有自动或人工测试。

## 十一、固定测试集

至少包含：

- UTF-8、UTF-8 BOM、CRLF、LF、混合换行和非 UTF-8 显式转换样例
- CodeMirror 打开、编辑、撤销、保存和重新打开的换行往返样例
- 源代码/所见即所得无编辑切换保真、跨模式撤销重做、中文输入法和最小文本补丁样例
- 中文、空格、括号和 URL 编码路径
- 当前目录、子目录、父目录和越权路径
- 同名图片冲突
- PNG、JPEG、GIF、WEBP 和恶意 SVG
- 引用式图片和简单双链图片
- 单图和多图拖放到行首、行中、行尾及文档末尾；异步导入期间继续输入后锚点仍正确
- “插入图片”按钮、未命名文档先另存为、取消选择、同名不同内容、相同内容复用和写入失败
- 导入图片即时预览、撤销只撤销 Markdown 引用，以及方案 B 清单顺序与正文 ImageNode 顺序一致
- ATX 标题、Setext 标题、任务列表、表格、删除线、围栏代码和复杂公式
- 不支持的 Wiki 链、Callout 和脚注；另包含 Mermaid 有效流程图、语法错误、数量上限、源码长度上限和导出 PNG 样例
- 超长文章和大量大图
- 保存失败、文件占用和外部修改
- PreviewSession、PDF、DOCX、离线 HTML 和公众号固定输出样例
- jobId 取消、迟到结果丢弃和进程崩溃样例
- 源 Markdown data URI 阻止、payload 仅存在于 editorText 解析边界且不进入资源模型、Resolve IPC、缓存或日志的样例
- Windows 盘符绝对路径、盘符相对路径和 UNC 分类样例
- parseCommitId 过期结果、completed-with-omissions 和批准范围不可复用样例
- PreviewDerivedUpdate 乱序、旧 parseCommitId、旧 parserProfile 和 manifestRevision 回退样例
- 适配器预检、awaiting-user-approval、生成期新省略失败和方案 B 占位不计省略样例
- 同步滚动开关持久化、关闭后独立滚动、快速连续滚动和文档/标签页切换样例
- 长短段落、列表、代码块、表格、图片、SVG 派生更新和块级公式的 SourceRange 锚点及区间插值样例
- 单块、跨块、图片精确范围、折叠光标、预览过期和重新解析后的选区提示样例
- 预览宽度、分栏比例和图片加载改变高度后重新测量，以及内部 data-source 属性和提示层不进入 PDF、DOCX、离线 HTML与公众号输出的样例

## 十二、交付物

- Windows 安装包
- 项目源代码
- document-core
- 工作区授权与资源解析模块
- 经 Windows 验证的替换保存和恢复模块
- PreviewAdapter
- PdfAdapter
- DocxAdapter
- OfflineHtmlAdapter
- WechatClipboardAdapter
- 固定测试集和验证报告
- 用户说明、构建说明、安全说明和兼容性清单

## 十三、最终实施原则

1. 先冻结 ParsedDocument Core，再通过阶段 0 实验冻结资源和各输出适配器。
2. canonical `editorText` 缓冲区与文件会话元数据共同构成保存来源；CodeMirror 和所见即所得视图不得形成第二数据源。
3. ParsedDocument 和 ResolutionSnapshot 是预览、检查和导出的共同语义，不是 Markdown 格式化器。
4. 跨进程引用使用 referenceKey，资源缓存使用 assetCacheKey 和 contentHash；工作区变化使旧解析结果和句柄失效。
5. 预览、PDF、Word、HTML 和公众号各有独立适配器。
6. 公众号图片能力只承诺经过真实环境验证的结果。
7. 安全基线从工程第一天启用。
8. 账号、云同步和接口直发不阻塞首版。
