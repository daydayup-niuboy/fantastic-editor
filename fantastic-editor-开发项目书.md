# fantastic-editor 开发项目书

> 文档状态：`0.2.0-rc.3` 基线已冻结；`0.3.0-rc.2` 公众号自定义主题源码、重新打包与本机发布门禁已完成；跨应用人工复验未完成
> 软件作者：Tbin · 联系邮箱：niuboy5188@gmail.com
> 当前版本：1.5-draft
> 下一里程碑：完成 RC.2 的跨应用人工复验与发布记录；本公益免费项目暂不采购商业代码签名证书，RC 可按未签名方案发布，签名流水线保留为未来可选能力。多账号、群发和定时群发暂不开发。

## 当前项目结论（2026-09-01）

- 产品已经具备可实际使用的 Windows 本地 Markdown 编辑器主链路：打开、新建、拖入、源代码/所见即所得双模式、实时预览、本地图片、KaTeX、Mermaid、同步滚动、PDF、DOCX 与离线 HTML。
- 微信公众号主流程已由“复制正文后逐张替换图片”升级为官方 API 自动创建草稿，并新增显式确认后的一键发布：普通图片、公式 PNG、Mermaid PNG、封面和正文样式一次上传，创建后回读校验；发布动作提交后轮询官方状态。方案 B 保留为没有 API 权限时的兼容兜底，产品仍不支持群发。
- 公众号 AppID、Windows 加密保存的 AppSecret、默认封面和 IP 白名单检测集中在主界面顶部唯一“公众号设置”入口。`40164 invalid ip` 会显示微信识别到的公网 IPv4并给出设置步骤。
- “公众号排版”是主界面独立能力，不挂在“公众号设置”或导出菜单下。主入口负责主题选择、定制和手机宽度审计；所见即所得工具栏提供主题显示开关，启用后实时显示当前公众号主题，便于写作时直接判断排版效果。
- 预览与所见即所得的字体控件使用同一可编辑字体名输入框：提供常用系统字体建议，也允许输入任意本机已安装字体；不得依赖 Electron 的 `window.prompt`。字体草稿和选择均属于本机视图偏好。
- 自定义主题删除采用两次点击确认。若删除当前主题，界面先切回该主题对应的官方基底，再删除同一内容身份在工作区/全局的全部存储副本；不得出现删除后被隐藏副本重新“复活”或按钮永久灰置。移动宽度审计对嵌套溢出只报告最内层可处理节点，局部滚动容器优先作为复核项。
- 发布隐私边界固定为“构建包无私有配置、运行时按用户单独配置”：AppID、AppSecret、封面路径和 IP 信息不得进入安装版/便携版；构建时清理 `FANTASTIC_EDITOR_WECHAT_*` 环境变量，打包清单排除本地配置、环境变量和证书私钥，并由 `npm run verify:privacy` 扫描产物。
- 2026-08-31 用户确认真实账号草稿验收清单 1–5 全部通过：自动上传文章已进入草稿箱，图片、公式、Mermaid、封面和最终格式正常；一键发布真实验收仍未执行。
- 当前源码版本为 `0.3.0-rc.2`。公众号自定义主题已按《公众号自定义主题最终开发规范_完整版》实现完整 P0/P1/P2：严格 10 令牌、内容身份、Main 文件仓库、工作区/全局作用域、受控定制面板、实时预览、导入/导出/删除、唯一输出编译器和最终安全审计。主题严格属于 Output 配置；所见即所得中的主题显示只是 Renderer 视图投影，不改变 canonical Markdown、UDM、资源解析或公众号图片替换清单。最新安装版/便携版已按本轮源码重新生成并通过隐私、生产态和安装/卸载门禁。公益发布允许保持 `NotSigned`，不把商业证书作为 RC 阻断条件。多账号、群发和定时群发不进入当前计划。
- 最新 RC 产物：安装版 136,690,113 字节（SHA-256 `DD45E7A9012329340C4C10BE8C43F0488C112B0309CB744A0800F7A08998E2EE`），便携版 136,432,037 字节（SHA-256 `A2643D21805C9DB6BF239A1D36B7A67948EAA692D85374A9298D99D513035F16`）；均为 `NotSigned`，发布清单已同步。

## Moji 五项优先能力开发计划（已纳入基线）

根据 `fantastic-editor-Moji五项优先能力开发方案.md`，M1→M5 已完成首轮实现：可调阅读宽度与预览字号、代码块一键复制、文档大纲与标题导航、统一查找与替换、Windows Markdown 文件关联与单实例打开。实现复用现有 ParsedDocument/SourceRange、CodeMirror、React 和 Electron 原生能力，不改变 UDM 版本、Markdown 语法、导出格式或公众号权限边界。

本轮交付顺序是先完成五项能力的最小可用实现、单元/Renderer/生产 UI 回归和发布门禁，再进行 P1 阶段 B 的真实系统剪贴板人工验收（Word、Typora、浏览器、公众号双向互拷）。未通过人工验收前，不把双格式剪贴板标记为最终完成。


## 本轮新增规格：Mermaid、字体与开关状态

### Mermaid 流程图

- fenced code block 的语言标识为 `mermaid` 时，实时预览必须渲染为流程图；语言匹配不区分大小写，其他代码块保持原样。
- 预览使用 Mermaid `securityLevel: strict`，不允许外部网络、窗口跳转或脚本注入。单篇最多预览 100 个 Mermaid 块，单块源码最多 100,000 字符；语法错误显示就地错误提示，不执行源码。
- Mermaid 预览 SVG 是 Renderer 短生命周期 DOM，不写入 Markdown、ParsedDocument、ResolutionSnapshot 或恢复稿。SourceRange 属性必须从原 `<pre>` 复制到流程图容器，确保同步滚动和选区提示仍然有效。
- PDF、Word、离线 HTML 和公众号输出不得依赖 Mermaid 运行时脚本。导出任务在无网络的隐藏 Chromium 窗口中渲染 Mermaid，并生成 PNG 派生资源；单图最大 4096 × 4096，单次渲染超时 12 秒，派生资源纳入 200 MiB 输出预算和 `DerivedAssetManifest`。
- 离线 HTML 与 PDF 内嵌 Mermaid PNG；Word 使用图片段落；公众号方案 B 将其作为 `diagram` 替换项生成连续编号占位，并允许用户逐项复制 PNG。

### 预览与导出字体

- 预览区提供字体选择器，内置微软雅黑、Segoe UI、Arial、等线、宋体、楷体，并允许输入本机已安装字体名称。
- 字体名称需去除首尾空白、合并连续空格，长度不得超过 64，禁止控制字符和 `{ } ; < >`；非法值回退到 `Microsoft YaHei UI`。
- 用户选择只保存在本机 `localStorage`，不写入 Markdown、文件会话、恢复稿或 ParsedDocument。发起导出时通过 `OutputTheme.tokens["typography.body.fontFamily"]` 传递，使 PDF、Word、离线 HTML 和公众号正文使用同一字体偏好；目标平台缺少该字体时按各适配器后备字体降级。

### 同步滚动开关显示

- 同步滚动按钮必须直接显示 `同步滚动 ON` 或 `同步滚动 OFF`，并继续提供 `aria-pressed`、悬停说明和本机持久化。
- ON 表示编辑区驱动预览区及选区提示；OFF 表示两个区域独立滚动并清除临时提示。显示文字不得取代布尔状态作为业务数据源。

## 源代码 / 所见即所得双编辑模式（首轮已实现）

> 2026-08-26 首轮实现：标题与普通段落支持直接编辑及粗体、斜体、删除线、链接和标题级别命令；图片、公式、Mermaid、列表、表格、引用和代码块通过绑定精确 SourceRange 的源码卡片编辑。CodeMirror 继续常驻并持有 canonical `editorText` 与共享撤销历史。
>
> 2026-08-26 稳定性迭代：直接编辑改为块级提交；Enter 新建段落、Shift+Enter 插入软换行，段落边界的 Backspace/Delete 合并相邻直接编辑块。点击文档空白处只允许创建一个临时空段落；再次点击只聚焦该段落，失焦或按 Backspace/Delete 时清除，只有输入实际内容后才提交 canonical `editorText`。纯文本粘贴在写入前统一 CRLF/CR 为 LF；IME composition 期间禁止提交、保存和模式切换，compositionend 后才允许原子写回。跨块选择的破坏性编辑明确拒绝并提示切换源代码模式。
>
> 2026-08-26 第二轮实现：普通、有序和任务列表项、引用段落及表格单元格进入直接编辑路径。列表和引用使用前缀保真事务，任务框只切换原始 `[ ]`/`[x]`，列表 Enter 生成同类新项目；解析器为 `th/td` 生成不包含分隔符与对齐空格的精确 SourceRange，Tab、Shift+Tab 和 Enter 在单元格间提交并移动。每次事务后当前 DOM 的 SourceRange 按 TextChange 同步映射，旧 HTML 快照不得覆盖新偏移。嵌套列表、表格行列增删及合并拆分仍通过源码卡片完成。
>
> 2026-08-26 第三轮实现：标准 Markdown 图片在所见即所得视图中使用结构化图片属性面板，可直接编辑 alt、调用现有安全导入链路替换图片或删除图片引用。替换保持原 alt 并以整段图片 SourceRange 原子写回；删除不自动清理 `assets` 原文件。Wiki 图片嵌入继续使用源码卡片；过期或不匹配的图片 SourceRange 必须拒绝操作并等待重解析，不能回退为对错误范围的源码编辑。
>
> 2026-08-26 第四轮实现：列表项支持 Tab / Shift+Tab 调整一级缩进，且一次层级调整只产生一个可撤销的 SourceRange 文本事务；没有前置同级项时不得缩进，已在顶层时退格不改写原文。所见即所得视图同时支持 Ctrl/Cmd+B、Ctrl/Cmd+I 和 Ctrl/Cmd+K。任何编辑事务使 canonical `editorText` 改变后，旧预览 HTML 必须立即失去可渲染资格；只有携带当前 documentId 且对应当前解析请求的 HTML 标记为 ready 后才能重绘和重新绑定 SourceRange。
>
> 2026-08-26 第五轮实现：行内和块级公式使用专用 LaTeX 面板，保留原分隔符及外围空白，并在面板内用本地 KaTeX 即时显示结果或语法提示；预览解析器为行内公式补充精确 SourceRange。Mermaid fenced code block 使用固定语言的源码面板和隔离实时预览；普通 fenced code block 分别编辑语言与内容，保留 fence 字符、元数据和尾随换行，内容与原 fence 冲突时只增长 fence 长度。三类操作均以完整节点 SourceRange 生成一个原子 TextChange，旧快照仍必须拒绝。
>
> 2026-08-26 第六轮实现：段落、安全叶级列表项和表格单元格即使同时含有行内公式、标准 Markdown 图片、链接或行内代码，也允许直接编辑这些结构前后的普通文字。四类结构以精确 SourceRange 绑定为不可拆分的受保护行内原子；未修改的原始 Markdown 切片只保存在 Renderer 的短生命周期 WeakMap 中，并在块序列化时原样回填。图片和公式点击后继续打开专用面板，链接和行内代码内部修改暂引导到源代码模式；跨原子的删除、粘贴和格式化必须拒绝。无法可靠匹配 SourceRange 时整块降级为源码卡片，不得猜测写回。
>
> 2026-08-27 第七轮实现：标准内联链接点击后打开结构化面板，分别编辑显示文字、destination 和可选 title；未触及字段保留原始尖括号、标题引号、空白与转义写法。行内代码点击后编辑内容，保留原反引号 fence，内容出现同长或更长反引号串时自动增长 fence，并在需要时加入 CommonMark 边界空格。两类面板只提交完整行内节点的最小 TextChange，拒绝换行、控制字符、过期 SourceRange 和无法拆分的参考式链接；点击链接必须阻止浏览器导航。
>
> 2026-08-27 第八轮实现：GFM 表格单元格进入结构化表格工具栏，可在当前单元格上方/下方插行、删除非表头行，在左侧/右侧插列、删除非唯一列，并设置左/中/右对齐。操作绑定完整表格 SourceRange，以一次可撤销 TextChange 重写受影响表格；未触及单元格内容逐字符保留，转义管道和代码跨度内的管道不得误分列。表头行和唯一列禁止删除；最后一个单元格按 Tab 自动追加空白数据行。结构变化后旧表格投影立即清空，必须等待当前 ParsedDocument 返回后才能继续交互。新插入的空单元格允许合法的零长度内容 SourceRange，但该例外不得扩展到普通块。
>
> 2026-08-27 第九轮实现：用户可在标题、普通段落、引用段落和安全叶级列表项之间使用浏览器原生跨块框选；Delete/Backspace、直接输入、Enter、剪切和多段纯文本粘贴生成一个覆盖首尾安全块的快照校验 TextChange，Ctrl/Cmd+B、Ctrl/Cmd+I 及工具栏删除线按选中块分别包装 Markdown 标记但仍只产生一个撤销项。复制只写 text/plain，不复制编辑器 DOM。纯文本粘贴统一为 LF、按段落分隔并转义行首标题/引用/列表语法。选区端点落在已有格式节点内，或范围经过图片、公式、链接、行内代码、代码块、Mermaid、表格、源码卡片及其他复杂结构时，必须在提交任何边界块之前拒绝；拒绝操作不得改变 canonical editorText。映射只使用当前 DOM Range、块级 SourceRange 和受控 Markdown 片段，禁止整篇 HTML 反向序列化。

### 通用剪贴板兼容性（P1 阶段 A + 阶段 B 生产门禁，持续实现）

本项用于补齐与 Typora、Word、浏览器和其他富文本编辑器之间的通用交换能力，不改变 canonical `editorText` 仍是唯一保存来源的约束。阶段 A 已把契约、安全审计、外部 HTML 转换和两种编辑器事件接入；阶段 B 的生产态 Electron UI smoke 已通过双格式复制标记/hash、外部 HTML 图片降级、WYSIWYG 写回和撤销回归断言，真实跨应用验收仍待执行。

- 复制时同时写入 `text/plain` 和 `text/html`：前者为当前安全选区对应的规范 Markdown，后者为经过白名单审计的渲染片段；不得复制可编辑 DOM、内部 `data-source`、绝对路径或运行时资源句柄。
- 粘贴时按 HTML → Markdown/纯文本降级：优先识别外部富文本 HTML 并转换为受控 Markdown 事务；HTML 缺失、无法安全解析或包含不支持结构时，回退到 `text/plain`，继续执行现有 LF 规范化和语法转义。
- 只允许标题、段落、粗体、斜体、删除线、链接、列表、引用、表格、代码、图片占位等明确白名单结构；脚本、事件属性、`file:`、`blob:`、`data:`、`app:`、`fantastic-asset:`、localhost/loopback 和未知标签一律剥离或拒绝。
- 图片、公式和 Mermaid 不直接信任外部 HTML 的地址；按现有资源导入/派生链路处理，无法取得受控资源时保留可解释的 Markdown/纯文本降级，不静默丢失正文。
- 阶段 A 已实现：内部 `data-fantastic-clipboard=v1` 完整性标记、FNV-1a UTF-8 校验、外部 HTML 节点/深度/输入/输出上限、危险地址降级、Ctrl+Shift+V 字面粘贴和 CodeMirror/WYSIWYG 的双格式复制/剪切事件；每次源码粘贴使用一个 `input.paste` 事务。
- 阶段 B 剩余门禁：Windows 系统剪贴板跨应用读回、Word/Typora/浏览器/公众号互拷、复杂 WYSIWYG 结构保真、历史隔离和大内容性能。生产包 UI smoke 已通过，但人工跨应用验收完成前不得将本项写成最终完成。

验收覆盖：从编辑器复制到 Word、公众号编辑器和普通 HTML 编辑器；从浏览器、Word、Typora 粘贴回源代码及所见即所得模式；确认两种剪贴板格式均存在、规范 Markdown 稳定、列表/表格/链接结构不被破坏、危险 HTML 不执行、图片/公式/Mermaid 有明确降级、一次操作可完整撤销。该能力列入 P1，不计入当前 `0.3.0-rc.1` 已实现基线。

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

- 直接编辑标题、段落、粗体、斜体、删除线、链接、引用、普通列表、任务列表和代码块；表格支持单元格文本编辑、行列插入/删除、列对齐和末格 Tab 追加数据行。P0 不支持合并或拆分单元格。
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

完成后的文章可以导出为 PDF、Word 和离线 HTML，也可以使用微信公众号主题进行排版、兼容性检查、富文本复制和官方 API 发布。公众号发布只针对当前单篇文章，必须由用户明确二次确认；多账号、群发和定时群发不在当前范围。

### 3. 三个产品闭环

1. 本地文档闭环：打开、编辑、保存，并正确预览本地图片和数学公式。
2. 文件交付闭环：可靠导出 PDF、Word 和离线 HTML。
3. 公众号闭环：完成主题排版、兼容性检查和富文本复制。

第三个闭环是否包含“本地图片自动进入公众号”，必须由第一阶段技术验证决定。验证结果和产品承诺以 [公众号图片策略与技术验证方案](fantastic-editor-公众号图片策略与技术验证方案.md) 为准，不能在没有验证的情况下默认承诺。

### 4. 首版不包含

- 账号系统和云同步
- 在线文章数据库
- 公众号群发、定时群发和多账号管理
- 完整 Obsidian 语法兼容
- 多标签页
- 插件系统
- macOS 和 Linux 版本

## 二、已冻结基线与后续范围决策

`0.2.0-rc.3` 的本机发布基线已经冻结；下列内容中涉及 `0.3.0` 的部分属于新增范围，不回溯修改 rc3 产物。

### 决策 1：公众号图片

第一阶段必须在真实微信公众号编辑器中验证富文本和图片粘贴。

最终只能选择以下一种 P0 定义：

- 方案 A：验证通过，P0 承诺带图富文本复制。
- 方案 B：验证未通过，P0 明确为“文字与样式复制 + 图片替换助手”。
- 方案 C：通过公众号图片上传和草稿接口批量同步；已批准作为 `0.3.0` 开发线，账号、受控服务、凭据和工期按阶段 6 单独验收。

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

`0.2.0-rc.3` 的 P0/P1 发布基线不包含标题、作者、摘要、封面和 Front Matter 发布映射；这些属于后续公众号草稿同步能力。当前 `0.3.0` 开发线会单独实现标题和封面输入，不改变已冻结的公众号剪贴板输出。

通过拖放或“插入图片”导入的资源必须自动进入公众号预检和输出资源清单，顺序、alt 和原文位置来自正式 ImageNode/ResourceReference，不建立另一套附件列表。`0.2.0-rc.3` 的“复制到公众号”仍表示正文排版复制加人工替换兜底，不能称为多图一键复制。

`0.3.0` 的主流程改为独立的“创建公众号草稿”模式：用户一次确认后，主进程或受控服务批量生成并上传普通图片、公式 PNG 和 Mermaid PNG，将返回的持久地址只替换到公众号输出 HTML，再调用草稿接口并回读校验。该模式不是剪贴板增强，也不是逐张复制；剪贴板方案 B 仅作为无 API 权限时的兼容兜底。应用内提供专用公众号 API 配置对话框：AppID 与封面路径可回显，AppSecret 只在用户输入时短暂存在于隔离 Renderer，并通过窄 IPC 立即交给主进程使用 Electron `safeStorage` 加密保存；明文不得进入 localStorage、Markdown、恢复稿、日志或普通配置文件，也不得再次回显。环境变量仅作为开发兼容入口。上传失败、部分成功、取消和超时必须有精确且就地可见的诊断，且不得显示为完整成功；面向多账号或分发场景再迁移到自托管连接器或微信公众号第三方平台授权。

公众号设置必须作为主界面顶部的常驻入口，不能只在生成公众号任务后出现。配置窗口在打开及保存配置后，通过微信 `access_token` 接口检测凭据和 IP 白名单：若返回 `40164 invalid ip`，从微信响应中提取并显示当前公网 IPv4，提供复制按钮及迁移后的微信开发者平台白名单设置步骤；不得把 `::ffff:` 映射地址误当成另一条 IP。连接正常时明确显示“白名单已就绪”，并通过 `api.ipify.org` 的只读 HTTPS 查询显示当前公网 IPv4；查询失败不得覆盖微信连接已经成功的结论，界面必须披露查询来源。公网 IP 可能变化，后续再次出现 `40164` 时必须引导用户重新检测和更新，而不是只显示原始错误码。

公众号配置采用单一入口：只保留主界面顶部常驻“公众号设置”。公众号发布验收助手不得重复提供配置按钮；配置缺失时点击自动同步，应给出提示并直接打开同一个主界面配置窗口。

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
- Windows NSIS 安装包和单文件便携版可执行文件；两种产物使用不同 artifactName，不能互相覆盖或误标

### 阶段 6：公众号草稿接口与后续 P1

`0.3.0` 当前首先实现：

- WechatDraftConnector 与模拟接口测试
- 批量上传正文图片、公式图片和 Mermaid 图片
- URL 替换、封面上传、草稿创建与草稿回读校验
- 任务取消、超时、失败重试边界和远程资源清单

完成接口路线后再评估：

- 多标签页和完整文件树
- 更多 Markdown 扩展
- 文章元数据和 Front Matter
- 自定义主题
- 长图和多文件 HTML
- 公众号第三方平台账号授权
- 自托管连接器与凭据安全存储
- 浏览器辅助批量替换（仅作 API 不可用时的实验性兜底）
- 直接发布（仅在用户明确二次确认后执行；不得隐式发布）
- 通用 HTML/Markdown 双格式复制和智能粘贴（P1；与公众号方案 B 的专用 HTML 输出分开验收）

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

自动草稿同步额外要求：

- 一次任务批量处理全部普通图片、公式和 Mermaid 图片，不要求用户逐张复制或粘贴。
- 正文图片必须替换为微信返回的持久 URL；正文不能残留 FE 占位符、本地地址、临时地址或 Data URI。
- 草稿创建成功后必须使用草稿标识回读校验；只能显示“已创建草稿”，不得显示“已发布”。
- 任一图片上传失败时不得创建伪完整草稿；部分上传只能显示失败或明确的部分完成状态。
- 一键发布必须先完成同一套图片上传和草稿创建，再由用户明确确认后调用 `freepublish/submit`；提交后使用 `freepublish/get` 轮询，只有 `publish_status = 0` 才显示“已发布”。审核中、超时或失败不得显示为成功；轮询有 90 秒任务范围上限，失败时必须保留草稿 ID 和发布任务 ID。

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
- 真正空白的未命名文档、空内容另存为 0 字节 Markdown、启动恢复就绪前的新建/打开串行化
- 所见即所得空白画布连续点击只保留一个临时段落、失焦清理、Backspace/Delete 清理以及输入后单次提交
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

- Windows NSIS 安装包与 `npm run dist:portable` 生成的单文件便携版；两者均执行启动冒烟，便携版不得创建安装目录、快捷方式或卸载项
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
## 十四、所见即所得嵌套列表结构化编辑

- 含直接子列表的父列表项，将“当前项自身的行内正文”和“后代列表子树”分离投影；Renderer 只允许直接编辑父项自身正文，子树 DOM 不参与正文序列化。
- 父项的结构操作始终使用 `list_item` 的完整 SourceRange。Tab、Shift+Tab、上移和下移必须移动当前项及全部后代，并以一个快照校验 TextChange 提交，因此一次撤销可恢复整棵子树。
- Enter 在非空父项后创建同类型同级项；任务项的新同级项默认未完成。有序列表沿用当前分隔符并以当前显式序号加一；移动既有项时保留其显式序号，不隐式格式化未触及兄弟项。
- 空父项按 Enter 退出当前列表层级：嵌套项整体提升一级，顶层空项退出列表且直接子列表提升为顶层；行首 Backspace 对嵌套项执行同一整棵子树提升语义。
- 任务框切换只修改当前项首行的 checkbox，后代原文保持逐字符不变。普通、数字和任务 marker 可以混合存在，结构事务不统一 marker 风格。
- 子树含代码块、表格、块级公式、Mermaid 或其他不能安全拆分的块时，结构移动在提交前拒绝并提示使用源码模式；不得通过序列化整份列表 HTML 绕过限制。
- 固定测试增加父项正文写回、三层纯列表、混合 marker、任务子项、整树缩进/提升/移动、空项退出、复杂后代拒绝和单次撤销恢复。
## 十五、所见即所得块级组织操作

- 用户选中标题、段落、引用、列表、表格、图片、公式、代码块、Mermaid 或源码卡片后，可通过块工具栏上移、下移、复制和删除，并可在当前块下方插入段落、标题、列表、引用、代码、公式、Mermaid、表格或图片模板。
- 块移动与复制必须使用 canonical Markdown 的完整 SourceRange 和 expectedText 快照，不得序列化预览 DOM。跨越的空行、注释和其他未选择源码必须逐字符保留；目标位于自身范围内时拒绝提交。
- 内部拖放仅接受应用自定义块类型，与操作系统图片拖放严格分流。拖动期间若文档发生变化，旧快照失效并取消操作，不能按旧偏移写入。
- Alt+ArrowUp / Alt+ArrowDown 与工具栏移动使用同一事务。一次移动、复制、删除或插入只产生一个共享撤销历史项。
- 删除必须二次确认。复制和预设插入保证必要的块边界，避免引用、列表或围栏与相邻源码意外合并。
- 工具栏、拖拽手柄、落点线和选中轮廓仅属于 Renderer 短寿命状态，不得进入保存、预览语义模型或任何导出结果。

## 十六、所见即所得阶段冻结与稳定性门槛

- 所见即所得第一至第十二轮在本节完成后冻结为 P0 基线；后续新语法或高级排版能力进入 P1，不继续扩张 P0 编辑面。
- Escape 取消尚未提交的直接编辑并恢复 canonical Markdown 投影；保存、切换模式和全局撤销前必须提交当前有效编辑，失败时保持原文并给出明确提示。
- 每个结构操作都必须校验 documentId、当前文本范围和 expectedText；解析迟到、拖拽期间文本变化、旧 DOM 或已失效选择不得产生写入。
- 固定回归覆盖大文档块移动、复杂间隔保真、引用复制边界、键盘可达性、焦点恢复、删除确认、图片拖放分流及一次操作一次撤销。
- 冻结门槛为严格类型检查、全部单元/集成测试、生产构建和真实 Electron UI 冒烟均通过；主线随后转向 PDF、Word、离线 HTML 与公众号真实环境验收。
## 十七、PDF 导出质量与分页

- P0 PDF 固定采用 A4 纵向页面，页边距为上 16 mm、左右 15 mm、下 18 mm；Chromium printToPDF 必须启用背景、CSS 页面尺寸、标签结构和文档大纲。
- 标题不得孤立在页尾；正文、列表与引用使用至少三行的 widows/orphans 约束。表格允许跨页，表头在新页重复，单行尽量不拆分。
- 普通图片、Mermaid、块级公式、引用和资源占位默认避免跨页；图片与流程图最大高度限制在单页可打印区域内。
- 长代码块必须自动换行并允许跨页，不能依赖横向滚动条。表格单元格、行内代码和链接允许在超长连续文本处安全断行。
- 隐藏 PDF BrowserWindow 在打印前等待 document.fonts.ready 和全部图片，随后检查表格与 KaTeX 块的实际宽度。过宽内容允许缩放到不低于 55%；发生缩放时返回兼容性警告，达到下限后仍溢出则以 PDF_CONTENT_TOO_WIDE 阻断，不能把裁切结果标记为成功。
- 布局审计结果必须结构校验；无效结果以 PDF_LAYOUT_AUDIT_INVALID 失败。取消、45 秒超时、窗口崩溃和无效 PDF 字节继续沿用既有明确状态。
- 固定生产冒烟使用至少两页的中文长文、公式、跨页表格和超长代码行，并在真实隔离 Chromium 中验证 PDF 文件头、有效字节和多页布局估算。

## 十八、Word 与离线 HTML 输出质量第十四轮

### 1. Word / DOCX

- DOCX 固定使用 A4 纵向页面、明确页边距和正文内容宽度；标题应用可编辑的 Word Heading 1–6 样式，并启用与后文同页、段落行保持和孤行控制。
- 无序、有序和任务列表必须输出为 Word 原生 numbering 定义，不用正文字符伪造项目符号。嵌套层级支持 0–8 级；有序列表尊重当前层级的 Markdown 起始序号，任务项使用可见的未完成/已完成符号。
- 表格使用固定布局、确定性内容权重列宽和精确单元格宽度；首行设为重复表头，数据行尽量不跨页，单元格对齐继承 ParsedDocument 的唯一表格对齐来源。
- 代码块保留显式换行并允许 Word 自动换行；引用只输出一次子节点内容，图片、公式和 Mermaid 居中嵌入并保持在可读边界内。
- 文档核心属性标题优先取第一条 Markdown 标题；正文、标题、列表和表格保持可编辑，图片、公式和 Mermaid 继续作为内嵌资源随文档移动。

### 2. 单文件离线 HTML

- 文档 title 优先取第一条 Markdown 标题并进行 HTML 转义；正文放入语义 main 容器，保留用户选择的浅色或深色主题及字体栈。
- 表格、代码和长连续文本采用响应式宽度与安全断行；窄屏下调整表格字号与内边距，打印时保留主题颜色。
- KaTeX 字体、样式和全部已授权图片继续内嵌，不依赖 CDN、原始目录或运行时脚本。
- 最终输出执行安全审计：禁止 script、iframe、object、embed、内联事件处理器，以及 file、blob、app、fantastic-asset、localhost 等本地或临时地址；CSP 同时禁止 base、表单提交和对象载入。
- 离线 HTML 的浏览布局不继承 PDF 的 A4 分页与 PdfLayoutAudit；两种输出只共享 ParsedDocument、ResolutionSnapshot、主题与经过校验的资源字节。

### 3. 验证门槛

- DOCX 必须通过 OOXML 结构测试，覆盖原生编号、任务状态、A4 页面、固定表格网格、重复表头、禁止拆行、代码换行、标题样式和文档核心标题。
- 离线 HTML 必须通过标题转义、深色主题、语义容器、字体、响应式表格、自包含资源和禁止脚本/本地地址测试。
- Word 与离线 HTML 均在真实 Electron Utility Process 中运行生产冒烟；任务失败、取消、超时或资源省略继续使用既有 OutputResult 状态机，部分完成不得显示为完整成功。

## 十九、微信公众号方案 B 可靠性与验收第十五轮

- “复制替换图片”与“已在公众号完成替换”必须是两个独立状态。系统剪贴板写入成功只记录为已复制，不得自动勾选已粘贴或已替换；用户实际粘贴到对应占位后才能手动确认。
- 每个 WechatReplacementItem 除序号、类型、标签、位置和尺寸外，必须携带与正文完全一致的 placeholderText。替换助手显示该文本，便于用户在公众号长文中精确定位图片、公式或 Mermaid 占位。
- 公众号正文任务无论是否含替换项都显示发布验收助手。流程顺序固定为：确认正文已粘贴、逐项完成替换、保存草稿、重新打开草稿复核、移动端预览。
- 后续步骤按前置条件解锁；撤销正文粘贴确认、撤销任一替换确认或撤销保存/重开确认时，所有依赖的后续确认同步失效。
- completed-with-omissions 的公众号任务仍显示剩余可用替换项和验收流程，但必须持续显示已批准省略数量及“部分完成”警告，最终清单完成也不得显示为完整成功或已发布。
- 正文 HTML 与替换位图写入系统剪贴板后必须立即读回验证。HTML 至少确认非空；位图确认非空且宽高与写入对象一致，验证失败返回 failed，不能推进复制状态。
- 公众号 HTML 在写入剪贴板前执行最终安全审计，阻止脚本、iframe、object、embed、base、form、事件处理器、data URI、本地/应用临时协议及 localhost/loopback 地址。
- 验收助手状态仅存在于当前 Renderer 会话。文档内容变化、标签页切换、关闭助手或新公众号任务开始时全部清空，不写入 Markdown、恢复稿、UDM、导出结果或公众号正文。
- 自动测试覆盖前置门控、零替换项、撤销级联、部分完成替换清单、占位文字一致性和安全审计；生产冒烟在真实 Electron 中验证公众号 HTML 写入并读回系统剪贴板。

## 二十、公众号真实验收资产与记录第十六轮

- 项目必须提供版本化的标准验收文章和本地静态资源，覆盖标题、正文、粗体、斜体、删除线、链接、行内代码、行内/块级公式、本地 SVG 图片、Mermaid、表格、任务列表、引用和代码块。
- 标准文章固定放在 fixtures/wechat-acceptance，资源只使用本地相对引用，不包含脚本、远程 href/src、data URI 或应用内部地址；该样例既供自动解析回归，也供真实公众号草稿验证。
- 发布验收助手在全部人工步骤完成后允许保存 Markdown 格式的验收记录。保存前主进程必须用 jobId 读取已完成的 wechat-clipboard OutputResult，并严格比对当前任务的全部 replacement itemId。
- 记录请求必须明确确认正文已粘贴、草稿已保存、草稿已重开和移动端已预览；任何字段非 true、任务过期、目标不符或替换集合不完全一致时拒绝保存。
- 验收记录只包含任务/文档身份、sourceHash、应用和平台版本、完成/部分完成状态、替换项元数据、占位文字及省略键，不包含公众号账号、文章正文、本地路径、图片字节或凭据。
- 含省略项的报告必须显示“部分完成”，所有报告必须声明“用户人工确认”“不代表已发布或群发”。
- 保存使用 Windows 安全替换写入和 Markdown 文件过滤器；取消保存不产生文件，失败不覆盖已有记录。
- Chrome 自动化只能在用户明确授权的已登录 Chrome 中执行，不得读取 cookies、密码或会话存储，不得发布、群发或删除内容。连接不可用时必须记录为外部验收未完成，不能用本地冒烟替代。

## 二十一、公众号排版与替换体验第十七轮

- 真实公众号截图确认普通图片、行内/块级公式和 Mermaid PNG 均可进入草稿；当前问题集中在占位清理、行内布局、标题重复和二次套版，而不是图片生成或位图剪贴板链路。
- WechatClipboardAdapter 默认把首个一级标题投影为 `wechatSuggestedTitle`，并从正文 CF_HTML 中移除该节点；替换助手显示建议标题，避免公众号标题栏与正文重复。该处理只属于公众号输出投影，不修改 Markdown 或 ParsedDocument。
- WechatReplacementItem 新增 `placement: inline | block`。行内公式使用短标记 `【FE公式NN｜行内替换】`；普通图片、块级公式和 Mermaid 使用 `【FE类型NN｜整段替换】`。标记不得再依赖有边框的空容器，用户完整替换文字后不应留下虚线框。
- 替换助手必须分别提示行内和块级操作：行内公式在原句中完整选中标记后直接粘贴且不换行；块级资源完整选中整段标记后粘贴。确认文案固定为“图片已出现且占位文字已消失”。
- 公众号自身的“一键排版”属于不可控二次模板。真实截图已观察到它会移除编号、任务符号和代码块容器，因此应用明确提示不得在粘贴后再次套用；该模板造成的样式破坏不计为 fantastic-editor 原始 CF_HTML 生成结果。
- Mermaid 导出 PNG 使用紧凑流程图间距、18px 基准文字和最高 2 倍像素渲染；仍受 4096×4096、超时、离线与总资源预算约束。
- 重新打开草稿的人工确认必须检查图片仍存在、格式正确并且所有 FE 标记均已消失；不得再要求或暗示占位文字仍然存在。

## 二十二、空白文档、临时段落与便携版发布

### 1. 空白未命名文档

- “新建”必须创建真正的空白 Markdown 会话：canonical `editorText` 为 `""`，不得写入示例标题、零宽字符、空格或占位文案。
- 新建会话即使内容为空也必须标记 `requiresSave = true`。首次保存打开“另存为”，用户可以保存合法的 0 字节 `.md` 文件；取消保存保持未命名和未保存状态。
- 未命名会话目录由主进程在 `app.getPath("userData")/untitled-sessions` 下创建并管理。运行时不得直接信任可能未展开的 `%LOCALAPPDATA%`、`%TEMP%` 或 `os.tmpdir()` 字符串，也不得把未命名正文存入工作区外的任意用户路径。
- 应用启动时的新建、打开文件和打开文件夹命令必须等待恢复存储初始化完成，避免恢复扫描与会话创建竞态。documentId 在一次未命名会话及其首次另存为过程中保持不变。

### 2. 所见即所得临时空段落

- 空白画布点击产生的“开始输入…”只是一项 Renderer 临时交互，不是 Markdown 内容、ParsedDocument 节点、撤销历史或恢复稿。
- 同一文档同时最多存在一个临时空段落。已有临时段落时再次点击空白区域只聚焦它，不得累积多个不可删除的占位框。
- 临时段落在未输入内容时失焦即删除；Backspace 或 Delete 也应删除并把焦点返回可继续编辑的位置。提示文字通过 placeholder/伪元素显示，不得作为可编辑文本写入。
- 用户输入首个实际字符后，才把该段落作为一次最小插入事务提交到 canonical `editorText`。保存、切换模式、导出或复制公众号前的 `commitPending` 必须丢弃仍为空的临时段落，并提交非空段落。
- 视觉样式采用轻量输入位置提示，不使用连续虚线框、固定高度卡片或每次点击新增的标签。

### 3. Windows 便携版

- `npm run dist:portable` 生成 `release/fantastic-editor-${version}-portable.exe`；NSIS 安装包继续使用独立脚本和文件名。发布任务必须验证两个目标不会覆盖对方。
- 便携版是单文件可执行程序，不创建安装目录、开始菜单快捷方式或卸载项；用户文档、配置和恢复数据的格式及安全边界与安装版一致。
- 每次产出记录文件大小、SHA-256、签名状态和真实 Windows 启动冒烟结果。未签名构建必须明确标注可能触发 SmartScreen，不得描述为已签名发行版。
- 2026-08-28 本地基线：33 个测试文件、187 项测试、严格类型检查、生产构建、真实 Electron 所见即所得空段落冒烟及便携 EXE 启动冒烟通过。该记录是本地构建证据，不替代代码签名和目标用户环境验收。
- 2026-08-28 P1 便携候选版：版本提升为 `0.2.0-rc.1`，与旧 `0.1.0` 产物并存；打包前通过 35 个测试文件、195 项测试、严格类型检查、生产构建和包含三档主题审计的完整 Electron UI 冒烟。新单文件便携 EXE 已通过 PE/版本/哈希检查及隔离 userData 启动，仍因未签名和未完成第二台 Windows、真实公众号三主题验收而保持 RC 状态。

## 二十三、公众号正文主题与封面视觉系统规划

### 1. 外部视觉 skill 的定位

- 2026-08-28 已把 `guizang-social-card-skill` 安装到本机 `$CODEX_HOME/skills/guizang-social-card-skill`，用于研究 Editorial / Swiss 视觉系统、主题令牌、固定画板校验和公众号封面对生成方法。该安装是开发环境工具，不是 fantastic-editor 的运行时依赖、npm 依赖或已交付产品功能。
- 该 skill 的主要输出是小红书卡片和公众号 21:9 头图、1:1 分享卡 PNG，不是可编辑的公众号正文 HTML。正文主题与封面对必须拆成两个独立能力，不能把固定画板模板直接套到长篇文章。
- 安装完成后从下一轮 Codex 任务起才可作为 skill 调用；安装本身不代表已经生成、复制或内置任何主题、模板、脚本、字体或图片资产。

### 2. 许可证与复用边界

- 上游仓库采用 AGPL-3.0，并另有商业内置授权说明。未经许可证评估或作者书面授权，不得把其 HTML 模板、CSS、校验器、WebP 素材、提示词工作流或其他受保护资产复制进 fantastic-editor 安装包或仓库。
- P1 默认采用 clean-room 路径：只研究单一强调色、字号/字重映射、网格、留白、图片比例和真实渲染校验等一般设计方法，由本项目独立命名、独立配色、独立实现并建立自己的测试样例。
- 如果未来决定直接调用、修改或深度内置上游 skill，必须先确定 fantastic-editor 的项目许可证、源码提供义务、署名方式、商业分发范围和第三方素材许可；无法确认时保持外部可选工具，不进入正式构建。

### 3. 公众号正文主题 P1

- 首批只设计三套原创正文主题：极简墨白、深蓝科技、微信原生增强。每套必须覆盖标题、正文、引用、列表、表格、代码、链接、图片说明和后续 Callout，不以主题数量替代真实兼容性。
- 主题通过受控 `WechatThemeDefinition` 和 `OutputTheme` 令牌表达。公众号输出链路固定为 ParsedDocument → WechatProjection → WechatCompatTransformer → 主题令牌解析 → 绝对行内样式 → 最终安全审计 → CF_HTML。
- 主题不得修改 Markdown、ParsedDocument、资源顺序、替换项、批准省略集合或 OutputResult 状态。CSS 变量、class、伪元素和运行时脚本必须在写入公众号前消解或移除。
- 主题预览使用与最终公众号投影相同的主题定义和 HTML 行内样式编译器，并提供 320px / 375px / 414px 常见手机视口。自动审计覆盖横向溢出、局部可滚动内容、最小字号、WCAG 文字对比度、表格和代码宽度；微信客户端差异仍只能由真实后台和手机验收确认。

#### 2026-08-28 第一、二阶段实现状态

- 已注册 `wechat-native-enhanced`、`minimal-ink`、`deep-blue-tech` 三个受控主题 ID，对应“微信原生增强、极简墨白、深蓝科技”。Renderer 只能从共享枚举选择并本机记忆，主进程对 IPC 输入再次执行白名单校验。
- 三套主题由共享包内项目独立编写的 `WechatThemeDefinition` 和 `applyWechatThemeToFragment` 编译为绝对行内样式；主进程最终输出和 Renderer 手机预览复用同一份受控定义与编译函数，没有复制或运行外部 skill 的模板、CSS、脚本、字体、图片或校验器，也没有新增网络访问。
- `BeginOutputRequest.wechatThemeId` 只影响公众号输出；有效主题 ID 写入 `OutputContext.theme.id`、`OutputResult.wechatThemeId` 和人工验收记录。非法 ID 在生成前失败，不接受任意 CSS/HTML。
- 已有自动回归证明切换主题只改变输出 HTML 的受控样式，不改变 suggestedTitle、usedReferenceKeys、omittedReferenceKeys、replacementItems 顺序和任务终态。
- 主界面“公众号排版”已提供主题与手机预览，可即时切换三套主题和 320px / 375px / 414px 视口；首个 H1 按真实公众号投影从正文预览移除。三个宽度在后台并行审计，用户不必逐档手动触发；每档按钮独立显示通过、复核或警告状态。
- 审计在 Mermaid 完成后重新测量，区分阻断性溢出与允许局部滚动但需人工复核的内容，并按字号比例检查标题前后实际像素间距。表格统一采用固定布局和单元格强制断词，代码块、长链接及主题容器增加移动宽度保护。尚未完成的是三套主题在真实公众号中分别执行粘贴、替换、保存、重开和手机预览。

### 4. 公众号封面对 P2

- 后续可增加独立 `WechatCoverAdapter`，从文章标题、副标题、摘要和用户明确选择的图片生成 21:9 头图与 1:1 分享卡。输出为新的图片 artifact，不进入正文 `WechatClipboardAdapter`，也不改变 canonical Markdown。
- P2 可以把已安装 skill 作为人工设计研究或显式外部生成工具；任何应用内自动调用都必须有清晰的用户动作、离线/网络边界、图源许可记录、失败状态和可复现输出，不得静默搜索图片或执行外部脚本。
- 正文主题与封面对分别验收：正文关注微信粘贴、保存重开和移动端可读性；封面对关注尺寸、裁切、标题安全区、最小字号、图片来源和 PNG 输出完整性。

## 二十四、公众号双层安全审计一致性修复

- 公众号最终安全审计必须检查生成 HTML 的标签与属性，不得直接对包含正文文本的完整字符串执行协议关键字正则。文章可以合法讨论 `file:`、`blob:`、`data:`、`app:`、`fantastic-asset:` 或 localhost；这些文字不构成活跃资源地址。
- WechatClipboardAdapter 与主进程系统剪贴板写入前校验必须共用同一个 `auditWechatHtmlMarkup`，禁止各自维护不同正则。生产冒烟也调用同一实现，防止测试规则和运行规则分叉。
- 仍须阻止真实标签/属性中的 script、style、iframe、object、embed、base、form、class、id、事件处理器，以及本地、临时、内嵌或 loopback 资源地址。主题字体或其他令牌若把危险协议写入内联样式，同样必须失败。
- 剪贴板写入或读回失败使用 `OUTPUT_CLIPBOARD_WRITE_FAILED`；只有文件 artifact 写入失败使用 `OUTPUT_FILE_WRITE_FAILED`。诊断不得把公众号剪贴板描述为文件保存。
- 2026-08-28 用户已在本机重新构建生产版确认此前触发误判的正文能够成功写入剪贴板。该验证只关闭双层审计回归，不替代三套主题在真实公众号中的逐套粘贴、替换、保存、重开和手机预览。
- 回归基线提升为 36 个测试文件、204 项测试，严格类型检查和生产构建通过。包含本修复的便携候选包必须使用高于 `0.2.0-rc.1` 的新版本并重新生成哈希与发布清单。
- 2026-08-28 已按上述要求生成 `0.2.0-rc.2` Windows x64 便携候选版，并完成 PE、产品版本、SHA-256、SHA-512 与隔离 userData 启动检查；该包仍未签名，且不替代三套主题真实公众号逐套验收。
- 发行验收状态按主题与应用版本分开记录：微信原生增强已有 `0.2.0-rc.2` 完整记录，深蓝科技已有 `0.2.0-rc.1` 完整历史基线，极简墨白没有逐主题基线。不得把旧版本单主题记录或当前单主题通过概括为“当前三主题已验收”。
- 2026-08-28 微信原生增强已在 `0.2.0-rc.2` 下完成标准样例人工验收并归档记录；极简墨白、深蓝科技的 `rc.2` 验收仍未完成。当时的剪贴板流程不读取平台草稿；`0.3.0-dev.1` 已改为创建后通过官方接口回读校验，但仍不自动发布或群发。

## 二十五、Windows 便携版发布验证门禁

- `dist:portable` 必须在打包成功后自动验证候选文件，而不是仅以 electron-builder 退出码判断成功。验证项至少包括：文件存在与最小体积、PE `MZ` 头、产品版本与根版本一致、SHA-256、SHA-512、签名状态以及隔离 userData 启动/退出。
- 便携版单独构建使用 `verify:portable` 并生成单产物 manifest；安装版与便携版共同构建继续生成完整 release manifest。旧版本产物和清单不得被新版本覆盖。
- Authenticode 系统模块不可用时允许降级为 PE 证书表存在性检查，但降级结果只能是 `NotSigned` 或 `PresentUnchecked`；启用 `--require-signed` 时只有系统明确返回 `Valid` 才能通过。
- 发布清单可以记录版本、平台、架构、文件名、大小、PE 头、哈希、签名状态、产品描述和隔离启动退出码，不得写入开发机绝对路径、账号、桌面位置或用户数据内容。

## 二十六、Windows 本机发布加固门禁

- `release:gate` 固定执行全部自动测试、严格类型检查和 `dist:rc`。`dist:rc` 必须生成安装版与便携版，并依次执行发行元数据检查、打包程序生产态冒烟和安装链路冒烟；任一环节失败则整个候选失败。
- 打包程序生产态冒烟至少覆盖基础启动、PDF、DOCX、离线 HTML、公式 PNG、Mermaid PNG 和完整 UI。Windows GUI 启动器退出码不能单独作为完成证据；每个场景必须由真实 Electron 主进程写出带场景名和有效性的完成标记。
- PDF、DOCX 和离线 HTML 必须生成固定实物：PDF 检查文件头和最小体积；DOCX 检查 ZIP 必需条目和关键正文；离线 HTML 检查 doctype、标题、自包含字体、无活动脚本和无本地/临时协议。
- 安装链路在项目内经过路径边界检查的隔离目录执行静默安装，随后启动已安装程序，再静默卸载并确认主程序已移除。测试不得使用用户主目录、系统目录或现有正式安装目录作为清理目标。
- 带空格的工作区验收必须使用临时未占用盘符指向同一隔离目录，并显式设置仅供子进程使用的 TEMP/TMP；NSIS 外层卸载进程返回后需等待临时卸载进程完成，再判定主程序是否移除。盘符占用、安装退出码、卸载退出码或移除检查任一失败均使门禁失败。
- 安装版与便携版必须记录最终大小、SHA-256、SHA-512、产品版本和 Authenticode 状态。没有证书时允许候选保持 `NotSigned`，但文档和清单必须明确 Windows 可能显示未知发布者或 SmartScreen 提示。
- 2026-08-29 的 `0.2.0-rc.2` 已通过 36 个测试文件/204 项测试、严格类型检查、生产构建、7 组打包程序生产态冒烟及安装/启动/卸载冒烟。本候选按产品决策不再以第二台 Windows 为发布阻断条件；跨机器字体、Word、性能和升级覆盖作为后续兼容性抽检。
- 公众号主题的进一步真实平台验证暂缓，不影响“本机发布加固完成”的结论，也不得因此把未验收主题标记为已通过。

## 二十七、P1 可访问性与错误恢复第一轮

- 所有短状态反馈必须通过 polite live region 对辅助技术可见，且不得用高频 assertive alert 打断输入。状态播报是 Renderer UI，不进入 Markdown、恢复快照、UDM 或输出结果。
- 文档标签必须使用 tablist/tab/aria-selected 表达当前文档；视图和编辑模式按钮组使用 aria-pressed 表达当前选择，视觉 active class 不能成为唯一状态来源。
- 编辑/预览分隔器必须支持鼠标和键盘：左右方向键精调、Shift+方向键加速、Home/End 到达冻结边界，并同步 aria-valuemin、aria-valuemax 和 aria-valuenow。
- 解析失败、Worker 错误、主进程拒绝解析提交或 PreviewSession 组合失败后必须提供一次明确的“重新解析”操作。该操作复用当前 documentId、workspaceRevision 和 canonical editorText，只触发新的解析任务，不改写正文。
- 文档诊断区提供重新解析与清除显示入口；清除只隐藏当前 Renderer 提示，下一次解析仍按真实诊断重新生成，不能修改资源状态或批准省略集合。
- 本轮代码进入 `0.2.0-rc.3` 源码开发线，禁止覆盖已有 `0.2.0-rc.2` 产物。冻结门槛为单元测试、严格类型检查、生产构建和真实 Electron 键盘/ARIA 冒烟通过。

## 二十八、P1 全键盘工作流与模态焦点第二轮

- 文档标签使用 roving tabindex，当前标签为唯一常规 Tab 停靠点；标签获得焦点后，Left/Right 循环移动，Home/End 跳到首尾，并同时激活目标文档。
- 全局提供 `Ctrl+Tab` / `Ctrl+Shift+Tab` 循环切换文档和 `Ctrl+W` 关闭当前文档。关闭必须复用既有未保存确认、最后标签保留和恢复快照规则，不得因快捷键绕过数据保护。
- 模态窗口显示期间必须暂停背景文档快捷键。公众号主题预览打开时保存先前焦点，把焦点放入弹窗；Tab/Shift+Tab 形成焦点圈，Escape 关闭，关闭后将焦点返回主界面“公众号排版”入口。
- 模态标题、说明、宽度选择和关闭按钮必须具有明确可访问名称；宽度选择使用 `aria-pressed` 暴露当前档位。焦点逻辑只属于 Renderer UI，不改变主题 ID、输出 HTML、移动宽度审计或公众号验收状态。
- 自动测试覆盖标签索引的循环与首尾边界；真实 Electron UI 冒烟必须实际验证新建双标签、正反向切换、关闭、模态初始焦点、Escape 关闭和焦点回归，不能只检查元素存在。
- 当前源码版本为 `0.3.0-rc.2`。真实账号草稿验收与 48/246 自动测试已通过；本轮补充已保存独立单文件和工作区 Markdown 文件右键重命名、文件名下目录展开/收起、顶部重复目录入口移除、IMA 粘贴完整性回退、WYSIWYG 整篇删除修复，以及显式“修复网页 Markdown”的结构性转义清理，RC.2 便携版隔离启动、七组生产冒烟及安装—启动—卸载门禁已随源码变更重新生成并通过，且不覆盖历史 RC 产物。

## 三十八、Windows Authenticode 签名门禁

- 对外签名发行必须使用 `npm run dist:signed`；该入口依次执行证书预检、安装版/便携版构建、Authenticode 强校验、七组生产态冒烟和安装/卸载冒烟。普通 `dist:rc` 允许生成内部未签名候选，但不得冒充签名发行版。
- 签名身份只允许来自受密码保护的 PFX 环境变量，或 Windows 证书存储中的明确 SHA-1 指纹。两种来源互斥；代码、配置、日志、清单和文档不得包含私钥、PFX 内容或密码。
- Windows 证书存储预检必须确认私钥存在、证书未过期并包含 Code Signing EKU。签名构建必须启用 HTTPS RFC 3161 时间戳；最终安装版与便携版的 Windows Authenticode 状态必须均为 `Valid`。
- `--require-signed` 不接受“PE 中存在证书表”作为有效签名证明，只接受 Windows 签名 API 的 `Valid`。签名后的字节和哈希与未签名产物不同，必须重新生成 release manifest。
- 当前开发机没有可用代码签名证书，因此只冻结签名流程和失败门禁，不生成自签名公开包，也不把现有 `NotSigned` 产物改写为已签名。
- 代码签名不扩大公众号权限：产品继续固定为单账号；一键发布仅针对当前单篇文章且必须二次确认，不支持多账号、群发或定时群发。

### 公益免费项目发布策略

- fantastic-editor 当前定位为公益免费项目，暂不采购商业代码签名证书；商业证书费用不纳入 `0.3.0-rc.2` 的完成条件。
- 没有证书时，`npm run dist:rc` 生成的安装版和便携版可以作为正式公益候选发布，但发行清单、Release 页面和 README 必须明确记录 `NotSigned`，并提示 Windows 可能显示“未知发布者”或 SmartScreen 警告。
- 公布未签名包时必须同时提供官方来源和 SHA-256 校验值；不得使用自签名证书制造“已签名”假象。
- `npm run dist:signed`、证书预检和签名验证脚本继续保留。未来获得受信任证书或符合条件的免费开源签名服务后，可在不改变文档模型和公众号权限边界的前提下单独生成签名发行版。

## 二十九、P1 大文档观测与工作区体验收口

- Parse Worker 输出短寿命 `parseDurationMs`，Renderer 测量资源解析耗时；只有当前 taskSequence、documentId、sourceHash、parserProfile、parseCommitId 和 workspaceRevision 全部一致并形成 PreviewSession 后，才显示性能快照。
- 性能快照包含字符数、资源数、解析耗时、资源耗时及 normal/notice/slow 分级。编辑、切换、重试或错误时必须清除旧值；该数据只用于状态栏观测，不进入 UDM、输出上下文或恢复快照。
- 标签支持拖动重排与 Alt+Shift+左右键移动。标签顺序以 Renderer 的唯一 tabs 数组为准并随恢复快照保存；普通键盘导航、关闭保护和会话身份不得因重排改变。
- 最近文件由主进程维护最多 10 项，Renderer 仅获得 recentId、displayName、lastOpenedAt。打开最近文件只接受 recentId，主进程再解析内部路径；不得向 Renderer 增加 `open(path)` 或返回绝对路径。
- 最近记录属于辅助元数据，写入失败不得使已经成功的文件打开或另存为变成失败。路径失效时删除对应 recentId 并显示明确错误，不扫描父目录或扩大授权边界。
- 冻结门槛为性能分级单测、RecentFileStore 隐私/排序/去重单测、严格类型检查、生产构建和真实 Electron UI 冒烟通过。

## 三十、0.2.0-rc.3 发布候选收口

- 所见即所得结构化面板在读取 DOM SourceRange 后必须验证原文切片的结构类型：Mermaid 必须仍是 mermaid fence、普通代码必须仍是合法 fence、块级/行内公式必须与 displayMode 一致。校验失败只提示等待新投影，不允许编辑邻接源码。
- 完整 UI 冒烟在连续写回后必须等待当前可视投影重新 ready，不能用“元素仍存在”代表 SourceRange 已更新。该门禁在打包程序而非开发服务器上执行。
- `0.2.0-rc.3` 发行门禁已通过全部 40/215 自动测试、严格类型检查、生产构建、两个 Windows 产物元数据检查、7 组生产态冒烟及安装/启动/卸载冒烟。
- 最终安装版 SHA-256 为 `4079551C840B03E70795133D2FF95F4F9E669983953CC05407DB46854054EA65`，便携版为 `3E16B23453AC6DBF6382A077F84BB8A6F265828B38BDFB3B9DD829409950C698`。两者均未签名，不能宣称 SmartScreen 信誉已建立。
- 当前代码开发和本机发布加固至此收口。公众号账号接口、直接发布、代码签名证书和被用户暂缓的逐主题真实平台验收，均需要外部授权或人工环境，不属于可由本地代码继续自动完成的范围。

### Moji 五项优先能力实施状态（2026-08-31）

M1–M5 已完成首轮代码实现：阅读宽度/字号/字体、预览代码块复制、ParsedDocument 大纲跳转、统一查找/源代码替换、Windows Markdown 文件关联与单实例文件打开均已接入现有安全边界。所见即所得可直接切换字体并保持滚动位置，也可直接进入保留的只读预览；目录在资源管理器文件名下展开/收起，顶部重复入口已移除；已保存独立单文件和工作区 Markdown 文件均支持右键安全重命名，Ctrl+A 后整篇删除支持撤销。IMA 粘贴现在会核对语义 HTML 与纯文本完整度、修复重复转义并保存嵌套及起始编号列表；文档级“修复网页 Markdown”只在用户确认后修复结构性转义，保护已有代码围栏和普通反斜杠，并可一步撤销。Mermaid 渲染已串行化。当前源码自动回归为 52 个测试文件、264 项测试；类型检查、单元测试、RC.2 七组生产冒烟及安装—启动—卸载门禁均已随本轮源码变更重跑并通过；剩余工作是 P1 阶段 B 的真实外部应用人工复验与记录。

所见即所得 `Ctrl+A` 全选复制已修复：快捷键现在选择整个正文容器，复制直接使用 canonical Markdown 并继续输出双格式剪贴板数据；生产 UI smoke 已纳入整篇选择回归。
