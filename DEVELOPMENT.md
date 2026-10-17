# 开发笔记

面向**贡献者与本插件维护者**：开发过程中踩到并已修复的问题。用户文档见 [README](./README.md)，
验证记录见 [VERIFICATION](./VERIFICATION.md)。

这些坑大多来自 DSH 的隐式约定或浏览器/CSS 的细节，**症状往往看起来像别的问题**，
所以逐条记下症状、根因与修法，便于日后排查同类现象。

## 踩到并修复的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| 打包脚本删掉了具名 import 却没生成绑定 | `useState` 等为 undefined，**面板完全渲染不出来** | 生成解构绑定；各模块包 IIFE 隔离作用域，避免同名符号冲突 |
| 状态写盘走 400ms 防抖 | 400ms 内刷新会丢 tab / 置顶 | 结构性变更立即落盘 + `pagehide`/`visibilitychange` 补写 |
| 未声明 `dsh-client-ui-workspace` 依赖 | `ctx.get('uiWorkspace')` 拿不到，**选文件夹点了没反应** | 在 `dsh.client.inject` 中声明模块依赖；服务本身仍要在运行期**可选**获取（见下方条目） |
| 退路用裸 `fetch` 打 Remote 路由 | 被 Remote 判为 `gateway/bad-request` | 改走官方入口 `uiWorkspace.pickDirectory()` |
| 把 `ctx.remote.directoryPicker` 属性访问当能力探测 | 崩在兜底路径：`cannot get property "remote.directoryPicker" without inject`，用户点「选择文件夹」直接弹这句内核错误 | **属性访问受 inject 门控，探测本身就会抛**。改用 `ctx.get('remote.directoryPicker')` —— gateway 用 `remoteServiceKey(ns) = \`remote.${ns}\`` 把这些命名空间注册成**普通服务**，自己也是用 `ownerCtx.get(serviceKey)` 访问的。拿不到只是该能力不可用，不崩 |
| 服务快照只在 apply 期取一次 | `uiWorkspace` 由官方包注册，本插件 apply 可能早于它 → 快照为 `null`，兜底路径又被上一条炸掉 | 每个能力都用「快照 → 调用时刻再 `get` 一次」两级取法，并用 `try/catch` 兜住查找本身 |
| `uiWorkspace.pickDirectory()` 失败时把原始错误抛给用户 | 用户看到的是内核异常文案 | 包住并降级到 Remote 直连，原错误只进 `console.warn` |
| 同步滚动用「记住上次谁在驱动」的持久标记 | 会把下一次真实滚动一起吞掉，**只有一个方向能同步** | 改为给被程序写入的一方打一次性回声标记，写入后立刻消费 |
| `setScroll` 每次滚动都 commit | 每滚一像素触发一次面板重渲染 | 滚动位置改为静默更新内存 + 防抖落盘，不通知订阅者 |
| 文件夹栏固定 232px，不随面板变化 | 会话栏折叠/窗口变窄时，左栏吃掉一半宽度，**路径按钮被压住、正文被逐字折断** | 用 `ResizeObserver` 观察面板宽度，窄容器下收起左栏并改为上下堆叠 |
| 置顶区与文件树之间没有分隔 | 两块内容视觉上连成一片，看起来像同一棵树 | 置顶区加下边界线、拉开内边距；文件树加自己的小标题 |
| 置顶胶囊在 232px 左栏里两列只剩 ~100px | 中文名被截成 `demo....` | 左栏加宽到 268px（两列每列 ~123px），并按左栏**实测宽度**决定是否并排 |
| 树节点用模块级 `nodeApi` 单例 | 两个面板实例会互相串用 API | 改为从面板显式透传 `api` 属性，去掉单例 |
| 只过滤了 `node_modules` 和 `.git` | 文件树里冒出 `.obsidian` / `.opencode` 等大量隐藏项 | 改为隐藏所有 `.` 开头的条目与 `node_modules`（只影响展示，不禁止访问） |
| 目录与文件混排、只有一个笼统「文件」标题 | 根目录文件多时要逐个扫过目录才找到文件 | 根目录按「文件夹 / 根目录文件」分两组（对齐概念 Demo 的做法） |
| 树内容存在各节点 state 里，只在展开状态变化时拉取 | **新建文件后左侧不显示，必须切走再切回** | 引入运行期 `treeRevision` 令牌，新建后递增并让树重新列目录（保留展开状态与滚动位置） |
| 移动文件后引用旧路径的地方会失效 | tab 再保存会写回不存在的路径，置顶项变死链 | 新增 `store.remapPath()`，同步改 tab / 置顶 / 滚动记忆 / 草稿四处 |
| 文件夹栏紧贴窗口左边、通高铺满 | 会话栏折叠后，248px 的文件栏和 56px 折叠轨道**糊成一片**，视觉上像在挤缩放按钮 | 改为内缩的圆角区块（左 10 / 上 14 / 下 10），宽度 268→248 |
| 面板内容顶到左上角，忽略 DSH 的窗口控件带 | macOS 折叠会话栏后，交通灯与展开按钮**压在 tab 栏和文件夹栏上** | 按原生做法消费 `--dsh-frame-leading-clearance`（折叠 160 / 全屏 84） |
| 第二次修错：把文件夹栏整列往右推 | 交通灯只占顶部约 44px，整列右推导致**它下方一直空着一条 148px 宽的留白**；同时 tab 栏也被加了 clearance 内边距，多缩进 136px | 改为**整块面板顶部下移**：左栏回到贴左边，顶边与 tab 栏对齐；tab 栏去掉多余内边距（它本就在交通灯右侧） |
| 第三次修错：整块面板下移 | 折叠会话栏时**右侧阅读区（tab 栏 + 正文）跟着下移 44px，顶部留出一条空白带**，像面板缩了一下 | 避让改由**左栏单独承担**：面板只留恒定 14px 基线，左栏额外加 `--dsh-notes-sidebar-extra`（折叠时 30px，合计 44px 避开交通灯）。实测折叠/未折叠两张截图**阅读区逐像素差异 0.0000%**，只有左栏移动 |
| tab 栏与左栏顶部不在一条中线 | 文件夹按钮中心 66px、标签中心 72px，**差 6px** | `.dsh-notes__tabs` 补 `box-sizing: border-box`：默认 content-box 让 `height:38px` 只约束内容盒，加 `padding-top:6px` 后实际高 44px，标签贴底居中就偏下 6px |
| 窄容器下左栏不渲染 | 没人挡在交通灯前面，tab 栏直接落到控件底下 | `.dsh-notes--narrow .dsh-notes__right` 补 `padding-top: var(--dsh-notes-sidebar-extra)`，改由阅读区避让 |
| 标签多了被裁掉、够不到 | 原来只有 `overflow-x: auto`，被裁掉的标签既看不见也没有入口 | 拆成「外层 `.dsh-notes__tabsbar`（高度/底边/定位）+ 内层 `.dsh-notes__tabs`（滚动）+ `.dsh-notes__tabsend`（固定区）」。溢出判定不能只看 `scrollWidth > clientWidth`，还要加 `scrollLeft > 0`：用户把栏滚到中间时左边也有看不见的标签。右侧固定区因此不会被标签一起滚走 |
| 编辑栏「压」在预览栏上、下拉滑动错位 | DSH 的 base.css **没有全局 box-sizing reset**，`.dsh-notes__editor` 是 `width:100% + padding:0 30px`，默认 content-box 让它**比所在栏宽出 60px**，textarea 的原生滚动条被挤出栏外压在预览正文上；在编辑栏右缘下拉时实际拖到的是预览栏 | 加**作用域限定**的 `box-sizing: border-box` reset。选择器只匹配 `dsh-notes__` 前缀的类名，刻意不用 `.dsh-notes *` —— 官方 ui-primitives 有 36 条规则依赖 content-box（如 MarkdownText 表格单元格 `max-width:320px + padding:10px 16px`），用后代通配会把它们一并改掉，等于对 DSH 自身产生副作用。实测溢出 60px → 0，两栏交界严丝合缝，官方组件仍是 content-box |
| 切换显示方式时选择器左右跳动 | 工具栏原顺序是「选择器 → 同步滚动 → 保存」。后两个按钮**条件出现且宽度不同**（分栏才有同步滚动、预览才有保存），把同一组选项推来推去，很影响体验 | 把变化宽度的按钮排到左边、**显示方式选择器固定在最右端**。`.dsh-notes__docpath` 是 `flex:1`，会把后面这一串一起顶到最右，所以选择器贴右端不会因左侧按钮增删而移动。实测三种模式 + 未保存态下 `left/right/gap` 完全一致（1071/1188/12），900px 窄窗同样稳定 |
| 不可阅读文件（`.doc`/`.pdf`）灰着不能点 | 它们被渲染成 `muted`，点了没反应，用户以为坏了 | 加「可编辑 / 全部」可见范围开关（默认「可编辑」，隐藏它们）。切到「全部」后点它们走**系统默认程序**打开 |
| 「用系统程序打开」怎么实现，会不会和 DSH 耦合太深 | 自建 host 路由 + 自己拼各平台 `open` 命令，代码多、易错；但担心官方接口以后改版 | **用官方 `ctx.remote.session.openWorkspacePath`** —— 这正是 DSH 自带 `ui-open-in-app` 内部用的同一个入口，属于一等公开 API，比自建路由的耦合更浅。关键疑问「笔记根目录在会话工作区之外，官方接口会不会拒」已查证：host 侧只要求 `fs.processPathFromHostPath` 能映射，而 `fs-local` 对任意绝对路径都返回 `resolve(hostPath)`，`fs-sandbox` 只围栏写入、继承同一映射，所以不限制在工作区内。调用前用 `canOpenWorkspacePath()` 探测，拿不到能力就返回可读提示而不是抛异常 |
| 测试页里「可见范围偏好不持久化」 | 切到「全部」后刷新变回「可编辑」 | **不是产品 bug，是脚手架失真**：测试页自建了一个 store，与 `apply()` 内部那个是两个实例，两者都会在 `pagehide` 时 flush，后写的把另一个的旧状态覆盖回去。真实插件只有一个实例。改成用 `apply()` 注入的 store 后，刷新保持「全部」 |
| 点不可编辑文件报 `打开失败：cannot get property "remote.session" without inject` | **完全打不开** `.doc`/`.pdf` | 见下面三行。这是踩得最深的一个坑，先后误判两次 |
| 误判一：以为是 inject 没声明 `remote` | 补了声明、重新构建，**报错一字不变** | 声明是**必要**条件（`inject` 补 `'remote'`，`package.json` 的 `dsh.client.inject` 补 `@deepseek-ai/dsh-api-remotes`），但**不是充分**条件。当时「声明了就能取到」的推理是错的 |
| 误判二：以为是 DSH 缓存了旧产物 | 让用户完整退出应用重启，**报错仍一字不变** | 产物确实重建过（时间戳与内容都核对过），重启无效说明客户端跑的**就是**新代码 —— 新代码本身仍会抛错 |
| **真正根因：`remote.session` 是独立的服务名，必须写进 inject** | 报错前缀「打开失败：」暴露它来自 `openExternal` 的 catch 分支，而当时的新代码在那个分支只返回字符串、不抛异常 | gateway 把每个 Remote 命名空间注册成**独立的 cordis 服务**，服务名是 `remote.` + 命名空间名（见其内部 `remoteServiceKey()`：`return \`remote.${namespace}\``）。而 cordis 的服务**可见性按 fiber 隔离** —— 只有同样声明了该依赖的 fiber 才读得到。所以即使 `remote` 已声明，`ctx.remote.session` 仍会抛 `cannot get property "remote.session" without inject`。**修法：inject 里必须显式写 `'remote.session'`**（官方 ui-open-in-app 一直这么写，不是多余）。已用**真实 cordis + 真实产物**交叉验证：不声明 → 必抛；声明 → 正常取到且能调通全部方法 |
| 误判三：以为是「回调期 fiber 上下文变化，要提前取快照」 | 按这个思路把服务改成 apply 期快照，**报错依旧** | 用真实 cordis 实测：把 `ctx` 存下来稍后再读完全正常。快照本身没错（保留着，写法更清晰），但**它不是本故障的原因**。三连误判的共同教训：用自写的 Proxy 桩去「复现」cordis 行为，得出的结论都不可靠；换成加载**真实 cordis 与真实产物**后，一次就定位到了 |
| 自测脚手架的两个坑（各花掉一轮排查） | 界面文字显示成 `app:com.apple.Preview`、点菜单项没反应 | ① 桩里的 `jsx` 直接用了 `React.createElement` —— 但自动运行时的签名是 `jsx(type, props, key)`，`key` 被当成 children 传下去、**覆盖了显示文本**，看起来酷似插件 bug；② 自绘下拉的 `z-index: 40` 低于通用遮罩 `.dsh-notes__menu-mask`（69），菜单每一项的点击都被遮罩吃掉，表现为「点了完全没反应」。后者是**产品真 bug**，已把新菜单提到 70 |
| `ctx.remote` 报 TS2339 | 类型不过 | `ClientContext` 是本插件**自己维护的镜像接口**（刻意不 import DSH 类型以降低耦合），官方对 cordis Context 的模块增强对它无效，在本地接口里补声明即可 |
| 该功能剩余的耦合点（**已知**） | 若未来 DSH 不再把 `api-remotes` 放进 GUI bundle，或改掉 `remote.session` 这个名字，本插件会**不加载** | 这是 `dsh.client.inject` 的固有语义（包级硬依赖）。但实测表明**声明 `remote.session` 是让功能工作的唯一方式**，没有更松的替代（不声明则永远读不到）。`api-remotes` 是 Remote 体系的基础装配包、`immediately: true`，GUI 几乎不会移除 |
| 预览里代码块工具条滚动时**悬空**、不贴阅读区顶边 | 官方 `CodeBlock` 的 `.bannerWrap` 是 `position: sticky; top: 0`，吸顶时该紧贴滚动容器上沿；实测却停在距顶 23px 处，上方露出一条空白 | 滚动容器 `.dsh-notes__preview` 同时带着 `padding-top: 22px`。**sticky 的 `top: 0` 参照的是容器的 padding box 上沿**，而 padding 区不会被内容覆盖，于是工具条只能停在 padding 下沿 —— 那 22px 就成了「悬空」。修法：容器顶部**不留 padding**（改 `padding: 0 30px 60px`），静止时的留白改由**首个子元素的 `margin-top: 22px`** 承担（用 `> *:first-child` 通配，因为首个节点可能是段落/标题/列表）。官方 `ui-sidebar-documentpreview` 的滚动容器同样是 `padding: 0` |
| 该 bug 的定位方法（值得复用） | 一开始照着「容器 padding 导致 sticky 偏移」的猜想自建最小复现，**测出来间隙只有 -1px，没复现** | 原因是最小复现里选的 `scrollTop` 还没进入吸顶区间，量到的是「尚未吸顶」的普通位置。改为**逐段扫描 `scrollTop` 并标记哪些位置已吸顶**后，立刻看到 A 组稳定停在 23px、B 组停在 1px。**教训：验证 sticky 这类随滚动变化的行为，不能只测一个滚动位置，要扫出「已吸顶」的区间再比** |
| 样式表注释里出现反引号会让构建挂掉 | `tsc` 报 `TS1005: ',' expected` | `styles.ts` 把整份 CSS 放在**模板字符串**里，注释中的反引号会提前终止模板字符串。写 CSS 注释时避免用反引号，改用普通引号或直接不加引号 |
| 客户端路径处理只认正斜杠，Windows 下失效 | 拖拽移动后标签名变成完整路径；删除提示显示 `C:\Users\...` 全路径而不是目录名 | 客户端没有 `node:path`，原来的 `path.lastIndexOf('/')` 在 Windows 的反斜杠路径上返回 -1。修法：`Math.max(lastIndexOf('/'), lastIndexOf('\\'))`，同时识别两种分隔符。改了两处（`NotesPanel.tsx` 的 `basenameOf`/`dirnameOf`、`store.ts` 的 `remapPath`），并用 Windows 风格路径做了 13 项实测 |
| 同一类问题后来**又漏了三处**（用户报「Windows 上文件和文件夹都显示全路径，macOS 正常」） | 文件树里的**文件夹名**、**置顶胶囊名**、**从置顶打开时的标签名**都是 `C:\Users\...\sub` 这种全路径；文件行与普通标签正常（它们用宿主返回的 `entry.name`） | 上一条只修了「移动/删除」相关的取名点，**渲染取名点漏了**：这三处仍在写 `path.split('/').pop()`。教训有两条：① 只要出现一次「按 `/` 切分路径」，就要把**所有**取自路径的显示名一起排查，别只修报障的那条链路；② 新写任何「从路径取名字」的显示点时，一律走 `basenameOf()`（已支持 `/` 与 `\`，含 UNC 路径 `\\server\share\x`）。现已全部改走 `basenameOf`，并用从源码里提取的真实实现跑了 10 项跨平台用例 |
| 回退回收站曾叫 `.dsh-notes-trash`（点开头） | 系统回收站不可用时删除文件，文件在界面上**彻底消失**——虽然还在磁盘上，但文件树隐藏所有点开头的条目，用户找不到也取不回 | 改名为 `dsh-notes-trash`（不带点），于是它在树里可见、可点开、可取回。**带点的目录被隐藏是特性，但对回收站是灾难**：它需要被看见。（后来 Windows 改为不提供删除，该回退目录现在只用于 macOS/Linux 上系统回收站写不进去的意外情形。） |
| 删除文案写死「Finder 的『废纸篓』」 | Linux 用户看到 macOS 专有名词，且不知道去哪找 | 改为中性表述「系统回收站，可再取回」；回退时直接报出实际目录名。不写死平台名，因为各平台的叫法与位置本就不同。 |
| Windows 上做不到「可还原的删除」 | 自建回收站只是把文件挪个地方：既没清掉垃圾（与删除的本意相悖），又让用户以为能像系统回收站那样还原，反而更容易误判 | Windows 没有可移植的用户态回收站路径；真正的回收站只能调 `SHFileOperation` 或 PowerShell 的 `Microsoft.VisualBasic.FileIO.FileSystem`，而[官方文档](https://learn.microsoft.com/dotnet/api/microsoft.visualbasic.fileio.filesystem.deletefile)注明「非用户交互的应用程序不支持 recycle 参数」，我们跑在后台进程里无法保证可靠。**决定：Windows 上不提供删除** —— 右键菜单不显示该项，服务端另有 403 兜底，避免直接调接口删出无法恢复的文件 |
| 主按钮前景写死 `#fff`，暗色主题下几乎看不见 | 新建弹窗的「创建」按钮在暗色主题下变成**浅白色块、字看不清**。实测对比度 **1.05:1**（WCAG 最低要 4.5:1） | 根因：`--dsw-alias-brand-primary` 是**反色语义** —— 亮色主题下近黑 `rgb(15,17,21)`、暗色主题下近白 `rgb(249,250,251)`。写死白字后，暗色下就是白压白。修法：改用官方 `ui-primitives` 的 `Button.primary` 那套配对 token —— 背景 `--dsw-alias-button-primary-fill` + 前景 `--dsw-alias-label-primary-foreground`（会随主题反转），hover 也走 `--dsw-alias-button-primary-hover` 而非 `filter`。修复后暗色对比度 **18.08:1** |
| 危险按钮用「红底白字」 | 暗色主题下对比度 **3.29:1**，低于 4.5 | 同一类问题的另一处：`--dsw-alias-state-error-primary` 也随主题变（亮色 `red-600` 深红、暗色 `red-400` 浅红）。改为与官方 `Menu.danger` 一致的做法：**红字 + 透明底**，hover 才加 `--dsw-alias-interactive-bg-hover-danger` 的淡红底。修复后暗色 **4.96:1**。顺带说明：亮色下红字压白底是 4.4976:1，差 0.0024 到阈值 —— 该色由 DSH 主题给定，官方 Menu.danger 用的也是它，故与设计系统保持一致，不为这 0.0024 偏离 token |
| 这类 bug 只在暗色主题暴露 | 亮色主题下修复前后**看起来完全正常**，所以自测时没发现，直到用户切到暗色主题才报出来 | 教训：凡是「背景用主题 token + 前景写死颜色」的组合，都要在**明暗两套主题**下各验一次对比度，别只用眼睛看亮色主题。用 WCAG 公式算（正文 ≥ 4.5:1）比目测可靠 |
| 置顶排序：前面的项拖不动，只有最后一项能拖 | 4 个置顶里只有第 4 个能被拖起来；换成 CSS `order` 做预览、改用 ref 做事件门禁后**症状一字不变** | 元凶是**原生 HTML5 拖拽（`draggable` + `dragstart`/`dragover`/`drop`）在 DSH 桌面端（Electron）里不可靠** —— 同一份逻辑放进真实浏览器跑相同事件序列，原生方案复现不出可用结果，指针方案一次通过。**修法：置顶排序改为指针事件自己实现**（`mousedown` + document 上的 `mousemove`/`mouseup`）：不涉及 `dataTransfer`、不需要 drop 目标、不受「拖拽源元素被移动」影响。带 4px 阈值（小位移仍算点击）、拖完紧接的一次 `click` 丢弃（否则排序后顺手把文件打开了）。文件树的拖拽继续用原生拖拽 —— 那条路径实测正常 |
| 定位方法（值得复用）：真实浏览器复现台 | 连续三轮「照推理改代码」都没修好，每轮结论都被下一次实测推翻 | 搭一个 `/tmp` 复现页：**真实 Chrome + 真实 React 18 + 与源码逐行一致的 CSS 与事件处理**，用真实事件序列跑「4 项 × 往前/往后/精确落点 × 单栏/双栏」。它一次就分清了「算法错」还是「环境错」—— 算法全部通过，问题随即锁定在原生拖拽与宿主的交互上。**教训：宿主环境相关的交互 bug，要先能在浏览器里复现再动手改；只读代码推理会连续误判** |
| 预览重排移动了被拖元素自己的 DOM | 拖动时列表不停闪烁；前几项刚拖动就中断（`dragend` 立刻触发） | 两个独立原因：① 用预览数组直接重排 DOM 会移动拖拽源元素，Chromium 会因此中断拖拽 → 改为 **DOM 顺序始终不变、用 CSS `order` 做视觉重排**；② `dragstart` 时把落点清成 `null`，预览会把被拖项**瞬移到列表末尾**（等于在拖拽起点移动元素）→ 落点初值改为**当前所在格**，预览从原地开始 |
| 给宿主加了新路由，插件页却报 404 | 客户端半边的改动热更后立刻生效，但**宿主半边还跑着旧代码**，新路由不存在；DSH 的 webserver 在无匹配且无 fallback 时直接 `writeHead(404)` | 两半边的更新方式不同：**客户端插件有 HMR（刷新页面级即可），宿主半边必须重启进程**。排查顺序：先确认产物里真的有这条路由（`grep` 构建后的 `lib/index.js`）、再确认客户端请求路径一致、最后确认 DSH 的匹配规则 —— 它是 `new URL(req.url).pathname`（查询串会被剥掉，`?fresh=1` 不影响匹配）。另外把 404 翻译成可执行提示（「客户端已更新、宿主未重启，请完全退出并重开 DSH」）比丢个状态码有用 |
| 拿插件管理服务的 `inspect` 当「检查更新」用 | 修好参数个数后，真实环境里控件改为提示「插件已经安装了」（原文 `... is already installed`） | `inspect` 是**安装前校验**：registry 分支第一步就是 `if (known.has(parsed.name)) return refused("already-installed", ...)`，包一旦装进 profile 就必然被拒。而 `installBundle(spec, options)` 没有这道按包名判重的门槛（它就是「改 profile → 跑包管理器 → 应用重载」），**对已安装的包即升级**。所以「检查更新」不能借它，得自己查 npm 的 `latest` dist-tag（本插件是在宿主半边加了一条路由，读自身 package.json 取包名）；更新再交给 `installBundle`，并用**精确版本**规格，避免确认与执行之间又发新版时装到用户没见过的版本 |
| Remote 调用**参数个数**不对，界面只显示一句「失败」 | 插件页的更新控件在真实环境里直接失败；原因是调用只传了 `spec`，而契约要求 `(spec, options)` 两个业务参数 | gateway 的 `prepareInvocation` 会严格校验个数：`expected = descriptor.parameters.length`，`values.length` 必须等于它，或等于它 + 1（多出来的那个才是可选的 `AbortSignal`）；否则抛 `client api: <ns>/<method> expected N business argument(s) plus an optional AbortSignal, got M`。**教训两条**：① 调 Remote 方法前先按 descriptor 数清参数个数，可选参数也要把位置占上（如 `inspect(spec, {})`）；② **失败分支必须把原始报错显示出来** —— 这次因为只显示通用文案，用户看到的就是一句「失败」，排查只能靠翻源码。已改成原文照显，并用复刻严格校验的假服务回归（28/28） |
| 想用某个 Remote 命名空间，又怕声明进 inject 会拖垮加载 | 需要 `remote.pluginManager`（官方插件页同款能力），但写进 `inject` 后在缺该服务的环境（精简 profile / 无插件管理器的版本）**整个插件都不会加载** | 两条规则要分清：① **属性访问** `ctx.remote.<ns>` 受 fiber 的 inject 门禁，不声明必抛 `cannot get property ... without inject`；② **按名查找** `ctx.get('remote.<ns>')` 不受该门禁限制。而 gateway 是用 `ownerCtx.plugin({ name: remoteServiceKey(ns) })` 把命名空间注册成**网关根下的普通服务**（全局可见），所以 `ctx.get` 能取到。同时本版本 cordis 的 `_refresh()` 要求 inject 里每个服务都在位，**没有「可选 inject」** —— 因此需要「有就用、没有就降级」的能力时，一律走 `ctx.get` + try/catch，不要写进 inject。（`remote.session` 属于「没有它功能就不成立」，才适合写进 inject。） |
| 新增客户端模块后运行时报 `__modX is not defined` | 构建成功、`node --check` 也通过，但一加载就抛 `ReferenceError: __modUpdateAction is not defined` | `scripts/build-client.mjs` 里的 `MODULES` 是**显式清单**：新加的 `src/client/*.ts` 不进这份清单，打包产物就缺少对应的模块表项。**新增客户端模块必须同时把它登记进 `MODULES`**（顺序按依赖，被依赖者在前）。这次加 `UpdateAction.tsx` 与 `treeOps.ts` 都踩了一遍，靠「构建后跑一次真实加载（`/tmp/loadtest.mjs`）」立刻暴露 —— 只做类型检查与语法检查是发现不了的 |
| 面板顶部区域的鼠标事件被系统吞掉 | 侧栏下半部的文件树拖拽一直正常，只有最上方的置顶区拖不动 —— **越靠上越坏** | DSH 在 macOS 上把带 `data-window-drag` 的元素设为**窗口拖拽区**（`html[data-platform=darwin] [data-window-drag]{-webkit-app-region:drag}`），该区域内的鼠标事件由系统接管、页面收不到；DSH 主面板里的入口型页面（如插件管理器）靠**约 48px 顶部内边距**避开这条带子，而本插件顶部只留了 14px。**修法：面板根节点加 `data-window-drag-recall`**（DSH 自己提供的退出标记，对应 `-webkit-app-region: no-drag`），只作用于本面板，不影响 DSH 其他区域 |

## 不可预览文件（打开方式）

点文件树里 `.doc`/`.pdf`/`.sql` 这类阅读器打不开的文件，**不再直接弹系统程序**，而是在阅读区开一个 tab：文件类型图标 + 文件名 + 「此格式无法在阅读器中打开」+ 与官方同款的**分裂按钮**（左＝用默认应用打开，右＝下拉列出系统里所有能打开它的应用，底部另有「显示文件位置」）。

- 接口与官方 `ui-open-in-app` 完全一致：`workspacePathApplications({path})` 取应用列表、`openWorkspacePath({path, application})` 指定应用、`openWorkspacePath({path, action:'reveal'})` 显示位置。
- 文案沿用官方那套（`用 {app} 打开` / `{app}（默认）` / `显示文件位置` / `无法获取应用列表` / `打开失败，请重试`），不另编措辞。
- 三级降级都不崩：平台不支持 → 只显示说明不给按钮；应用列表读失败 → 显示禁用的「无法获取应用列表」但仍可显示文件位置；调用失败 → 提示一句，界面照常。
