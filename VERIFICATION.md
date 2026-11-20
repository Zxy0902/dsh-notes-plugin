# 验证记录

各项功能在**真实环境**中的实测结果（非静态推演）。用户文档见 [README](./README.md)，
开发踩坑记录见 [DEVELOPMENT](./DEVELOPMENT.md)。

验证手段分三类：Host 路由集成测试、真实 DSH 运行时、真实浏览器（CDP 驱动真实 GUI）。
凡标注「真实」的，都不是用桩替换后的结果。

**构建与类型**
- TypeScript 全量类型检查通过（`strict` + `noUnusedLocals`）
- 两个产物 `node --check` 语法合法

**Host 路由集成测试：20/20 通过**
覆盖 list / read / write / create 的正常路径，以及：
越权读取（root 之外）、`../` 路径穿越、相对路径拒绝、同名冲突 409、
扩展名白名单、写入越权、临时文件残留、HTTP 方法校验；
health 返回 `ok`、`canDelete` 为布尔、`platform` 等于宿主 `process.platform`。

**真实 DSH 运行时（非模拟）**
- 插件的 client bundle 出现在 `__DSH_BOOT__` 引导图中，`inject` 依赖正确
- bundle 经 DSH 的 `/plugins` 路由取回 **HTTP 200**（约 57 KB）
- `/api/dsh-notes/health` 返回 `{"ok":true,"plugin":"notes"}`

**真实浏览器中的真实 GUI（CDP 驱动）**
- 左侧栏出现「笔记」按钮，位置在全局面板按钮区、`插件` 之下
- 点击后主面板挂载 `.dsh-notes`，渲染 1160×757
- 首屏空状态文案「还没有选择文件夹」正确显示
- 插件样式表已注入
- 面板内直调 Host 路由，能列出真实目录（`日报` / `config.txt` / `周会纪要.md` / `待办清单.md`）
  并读回真实文件内容

**重命名（宿主路由直调 + 纯逻辑断言）**

宿主路由 `/api/dsh-notes/rename`（15 条断言全过）：
- 正常重命名 → 200，返回新路径；磁盘上旧名消失、新名存在，**文件内容保留**
- 目标已存在同名项 → 409，**不覆盖**已有文件，源文件保留
- 名字含路径分隔符（`../evil.md`）→ 400
- 名字为 `..` → 400；名字为空（全是空白）→ 400
- 源在根目录之外（`/etc/hosts`）→ 403（信任围栏生效）
- **目录也能改名**：目录改名后，里面的文件跟着走（`dir/inner.md` → `dir2/inner.md`）
- 名字没变 → 200 且文件不动（幂等）

客户端纯逻辑（13 条断言全过）：
- `splitName`：`周会纪要.md` → `{stem:'周会纪要', ext:'.md'}`；无扩展名 / 隐藏文件
  （`.gitignore`）/ 多点名（`a.b.md`）都对
- `remapPath`：单文件改名 → tab 的 id / path / name / activeTabId 全部跟着改
- `remapPath`：**目录改名要连带子树** —— 目录里已打开的文件、置顶项、展开状态
  全部按前缀改到新路径
- `remapPath`：路径前缀不误伤（改 `/root/d` 不影响 `/root/dd/x.md`）

**染色排版一致性（真实渲染对比）**

用同一段含制表符的 SQL，分别按「未设 tab-size」（默认 8）与「tab-size: 2」渲染对比：
- 默认 8 时 `SET is_init\t\t= 1,` 的空隙明显过宽，与用户截图的现象一致
- 设为 2 后空隙正常，与编辑框观感相符
- 排版属性逐项比对（`.dsh-notes__editor` vs `.dsh-notes__codecolor`）：
  `font-family` / `font-size` / `line-height` / `tab-size` **四项全部一致**；
  仅 `white-space: pre` 为染色视图特有（编辑框天然不折行）

**代码染色（真实渲染 + 产物断言）**

用 headless Chrome 加载**从产物提取的真实 CSS**（含盒模型 reset，提取时注意
别漏掉样式字符串开头的反引号，否则整条 reset 规则会被当成非法选择器丢掉），
用应用包里真实的 `sql` 语法 + shiki 产出 token，按真实面板尺寸渲染，确认：
- 关键字/字符串/函数/注释四类分色正确，缩进与列对齐保持
- 长行不折行，横超宽由外层滚动
- **行号对齐**：渲染 100 行实测，`codetext` 左边界只有 **1 种**坐标、
  行号列宽只有 **1 种** —— 行数从 1 位变到 3 位都不会错位

**染色颜色兜底（残缺主题下必须仍然全彩）**

复刻出问题的环境：主题表里**只留一个** `--shiki-token-string`，其余颜色变量
全部缺失。渲染后逐像素统计颜色，确认：
- 修复前：只有 `#2f9e44` 一种彩色出现，关键字/数字/注释全是正文黑
  （`var()` 解析失败会静默回落到继承色，不报错、不崩溃）
- 修复后：关键字、字符串、数字、注释**四种颜色都真实出现**
- 主题变量齐全时行为不变（优先用主题色）
- 插件只在 `.dsh-notes__codecolor` 上定义自己的 `--dsh-notes-color-*`，
  **不定义也不覆盖任何全局 `--shiki-*`**

**染色叠加编辑（光标与彩色文字必须逐像素重合）**

染色不是只读预览，而是「下面着色层 + 上面透明文字 textarea」。实测：
- 正文起点偏差：`deltaLeft = 0`、`deltaTop = 0`（着色层文字与编辑框文字同起点）
- 行高一致：着色行高 21.88px = 编辑框 line-height 21.875px
- 行号列宽 30px 且 `gutterLeft = 0` —— 行号住在左边距里，正文不被挤动
- 编辑框文字 `color` 为透明、`caret-color` 仍为正文色（光标可见）
- **行号列的 `line-height` 必须是 1**：若继承正文的 1.75，行号自己的行盒与
  正文不同，实测每行会被撑成 43.75px（正好两倍）
- 输入法组字期间着色层隐藏、文字恢复可见（否则中文候选字看不见）
- 滚动同步用 `translate3d` 位移而非 `scrollTop`：两层内容高度不可能相等，
  用 scrollTop 时滚到底着色层会提前停住、颜色落后于光标

产物与边界断言：
- 染色模块已打进 bundle（`CodeColorView`），只 require 三个平台基线模块
- 3000 行封顶存在，且**纯文本兜底分支同样封顶**（语法加载期间也可能是巨长文件）
- 主题变量 17/17 真实存在

**真实渲染验证（headless Chrome + 从产物提取的真实 CSS）**

上一版出过两个「只在真实渲染里才看得出」的问题，因此这两项改成**看像素**而非读代码：
- 「刚添加」标签：用真实 CSS + 浅色主题变量渲染，确认**文字可读**、不是黑底黑字
- 路径方向：`~/.agents/AGENTS.md` 与 `/Users/x/.agents/AGENTS.md` 均**正序**显示
- 交叉验证 `direction: rtl` 的实际效果：`/Users/x/notes/p` 会显示成
  `Users/x/notes/p/`（开头的 `/` 被挪到末尾）——这是去掉它的依据
- 产物里 `direction: rtl` 出现次数为 0

**图标外观一致（构建产物 + 源码断言）**

侧栏「笔记」图标：
- 产物引用的是官方 `IconListPenOutlineRegular`，不再是手写 SVG
- 手写路径 `M4 2.2h6.2L13 5v8.8` 已从产物移除
- 不再按 `active` 加粗（官方图标也不这么做）

内部图标基准：
- `icons.tsx` 的基准 `strokeWidth` 为 1（对齐官方 `*Regular`），不再是 1.5
- 小尺寸按比例补偿：`IconClose` 1.6（10px）、`IconCaret` 1.78（9px）、
  `IconCheck` 1.45（11px），换算后实际渲染均约 1px

依赖边界：
- 仍然只 require 平台基线模块（`react` / `react-dom` / `@deepseek-ai/*`），
  没有引入任何新的第三方依赖

**agent 指令文件（宿主路由直调 + 纯逻辑断言）**

宿主路由（18 条断言全过）：
- `global-instructions` 返回的默认路径以 `/.dsh/AGENTS.md` 结尾（跟随 `$DSH_HOME`）
- 读一个不存在的文件 → 200、`exists: false`、内容为空（**不报 404**，
  客户端据此显示「尚未创建」）
- 写一个不存在的文件 → 连父目录一起建好，内容逐字节一致
- 围栏（都必须被拒，且**不落盘**）：
  - 非文本扩展名（`evil.exe`）→ 400
  - 相对路径 → 400
  - 指向目录 → 400
  - 路径含 NUL → 400
  - 超过写入上限 → 400/413（在哪一关拦下都对，关键是拒绝）
- 无扩展名的常见文本名（`AGENTS`）→ 允许
- `isDefault` 只对预置那条为 true，自定义路径为 false

客户端纯逻辑（补充断言全过）：
- `agentFiles` 增删：重复添加去重、移除只删记录、添加顺序保持、空白路径被忽略、
  前后空格被裁掉、移除不存在的路径无副作用
- `global` 类型的 tab 能正常建立并持久化

刚添加的高亮（构建产物核对）：
- `agentrow--new`（整行淡品牌色底 + 左侧竖条）、`agenttag-new`（「刚添加」实心标签）
- `data-agent-path` 用于按路径精确找行，`scrollIntoView` 滚进视野
- 用到的 18 个 `--dsw-*` 主题变量全部在 app.asar 里真实存在（写错会被浏览器静默忽略）

**删除与拖拽（真实 React + 真实事件实测）**

删除：
- 右键文件 → 菜单显示「打开 / 置顶 / 重命名 / 删除」等项
- 点删除 → 二次确认框，文案明确说明会移到系统废纸篓
- 确认后文件从树里消失，且 `~/.Trash/<时间戳>-<原名>` **真实存在**（`fallback: false`）
- 拒绝删除目录、拒绝删除根目录之外的文件

拖拽移动：
- 拖 `x.md` 到 `目标夹` → 文件系统确认已移动（`目标夹/x.md` 存在，根目录不再有）
- 拖拽悬停时目标文件夹高亮
- 悬停 600ms 自动展开目标文件夹（子目录 `深层` 露出），所以能拖进多层
- 同名冲突返回 409 且**不覆盖**已有文件，源文件保留
- 拒绝把目录移进自身、拒绝移动到根目录之外

**新建后树实时刷新（真实 React + 走完整 UI 流程实测）**
- 通过界面点 `+` → 填名 → 创建，新文件**立刻**出现在树里，无需切换
- txt 与 md 都验证过；连续新建也正常
- 已展开的子目录状态在刷新后保留（不会因为刷新把树收起来）
- 截图确认：新建的 3 个文件同屏可见

**树分组（真实 React + CDP 点击实测）**
- 根目录分两组：`文件夹`（Work / 日报 / 项目）在前，`根目录文件`（config.txt / image.png / *.md）在后
- 子目录内部不重复加标题，展开「日报」后其子项直接列在下面
- 分组标题只有 2 个，展开任意目录后数量不变

**隐藏项过滤（Host 路由实测）**
- 根目录：`.env` / `.gitignore` / `.hidden.md` / `.obsidian` / `.opencode` / `.git` / `node_modules` 全部不返回
- 正常项（目录、`.md`、`.txt`、`.png`）完整保留，目录仍排在前
- 子目录内同样过滤
- 隐藏文件仍**可读**（直接给路径时）：置顶项不会因为所在目录隐藏而打不开
- 真实 DSH 上列 `~/Documents`：32 个条目，0 个隐藏项

**显示方式切换（真实 React + CDP 点击实测）**

| 模式 | 编辑框 | 预览 |
|---|---|---|
| 编辑 | 渲染 | 不渲染 |
| 分栏 | 渲染 | 渲染 |
| 预览 | **不渲染** | 渲染 |

- 切换器只在 Markdown 上出现；txt 没有渲染概念，恒为单栏编辑
- 仅预览时隐藏「同步滚动」开关（单栏没有同步对象）
- 仅预览时若仍有未保存改动，保留一个保存入口，避免改动无处可存
- 用的是官方基线的 `SegmentedControl`，仍是零三方依赖

**自适应宽度（真实 React 渲染 + 实测宽度）**

| 面板宽 | 文件夹栏 | 编辑/预览 |
|---|---|---|
| 1163px | 233px 显示 | 左右分栏 |
| 643px | 233px 显示 | 左右分栏 |
| 503px | 已收起 | 上下堆叠 |
| 443px | 已收起 | 上下堆叠 |

断点：< 560px 收起文件夹栏（切换入口挪到 tab 栏最左），< 720px 起用窄布局样式。

**同步滚动（真实浏览器 + 真实滚轮）**
- 在编辑栏滚动 → 编辑 17.8% / 预览 17.8%（比例一致）
- 在预览栏滚动 → 编辑 1.8% / 预览 1.8%（反向同样一致）
- 关闭开关后在编辑栏滚动 → 预览纹丝不动（独立滚动）

> 注意：验证同步滚动**必须用真实滚轮**（CDP `Input.dispatchMouseEvent`）。
> `dispatchEvent` 造的合成事件不经过 React 18 的根事件委托，`onScroll` 收不到，
> 会得到「同步没生效」的**假象**。这一点我踩过，测试脚本留在
> `scripts/test-scroll-sync.py`。

**UI 布局（真实 React 渲染 + 截图核对）**
- 置顶 1 个：单列占满整行
- 置顶 2 个：两列并排，文字溢出省略
- 置顶 6 个：2×3 网格，数量增加时自行往下延伸，chip 样式统一
- Markdown：左编辑 / 右预览双栏
- txt：单栏编辑，无预览栏

**状态逻辑（真实浏览器 DOM + localStorage）**
- tab 去重、关闭后落到左边 tab
- 未保存草稿标记（圆点）与清除
- 置顶上限恰好 6，超限返回 `limit`；取消后可再置顶
- 结构性变更立即落盘，重载后 root / tabs / 置顶 / 展开目录全部还原

**文件右键菜单：在系统文件管理器中定位（真实 React + 真实事件实测）**
- 右键文件 → 菜单为「打开 / 置顶 / 重命名 / 在访达中打开 / 删除」（分隔线只把「对文件本身的操作」隔开）
- 文案跟随宿主平台：`darwin` → 在访达中打开、`win32` → 打开文件所在位置、其他 → 在文件管理器中显示（4/4 用例，取自源码真实实现）
- 走官方 `openWorkspacePath({ action: 'reveal' })`，与「不可预览文件」页的「显示文件位置」同一入口
- 能力探测失败（如 Web GUI）时该入口**不出现**，不会留下点了只会报错的菜单项

**置顶排序（真实浏览器 + 真实 React 复现台实测）**
- 4 个置顶 × 往前拖 / 往后拖 / 拖到指定格 × 单栏与双栏，全部按落点生效
- 拖动中其他项用 CSS `order` 实时让位（DOM 顺序不变），落点显示指示线
- 单击不触发排序（4px 阈值），拖完紧随的那次 click 被丢弃，不会误开文件
- 机制说明：原生 HTML5 拖拽在 DSH 桌面端只有最后一项能拖起来，已改为指针事件实现

**跨平台取名（从源码提取真实实现实测）**
- `basenameOf` / `dirnameOf` 跑 Windows、UNC（`\\server\share\x.txt`）、macOS、无分隔符、盘根共 10/10 通过
- 源码与构建产物中 `split("/")` 均为 0 处；文件树文件夹名、置顶名、置顶打开时的标签名均走 `basenameOf`

**文件树三个操作按钮（真实浏览器 + 真实 bundle + 真实 React 实测，21/21）**
- 按钮存在且顺序为「文件 → 定位 → 打开所有文件夹 → 收起所有文件夹 → 可见范围胶囊」（截图核对）
- 样式表确实由真实 `apply()` 注入；树容器 `overflow-y: auto` 可滚动；面板未误入窄布局
- 初始只展开根（无展开箭头），深层文件因懒加载不在树里
- 点「定位到当前文件」：两个祖先目录被自动加入展开集合、目标文件出现并被高亮
- 点「打开所有文件夹」：三个目录全部展开，连深层目录也被列过，展开集合正好是全部目录
- 点「收起所有文件夹」：展开箭头归零、深层文件重新隐藏，按钮自身转为禁用
- 把树容器压到 60px 高后点定位：目标被滚进视野（`scrollTop > 0`）且仍高亮
- 没有打开文件时定位按钮为禁用态
- 纯逻辑（真实产物）：`ancestorsOf` 跨平台 7 例（含 Windows 盘根 `C:\`、UNC 风格、越界不展开）、`listAllDirectories` 5 例（含上限截断、坏目录跳过）、`collapseAll`/`setExpanded` 4 例，全部通过

**插件页「检查更新 / 更新」控件（真实浏览器 + 真实组件，26/26）**
用真实 Chrome 加载编译产物、真实 React 挂载控件，以假 `pluginManager` 回放官方信封 `{ok, value}` / `{ok:false,error}`：
- 门禁：别人的 bundle 页不渲染、也不发起任何调用；`manager` 缺失或缺少 `inspect` 方法时都不渲染（不留点了没反应的按钮）；全程无未捕获异常
- 发现新版本：进页面自动检查、`inspect` 参数为 `dsh-client-ui-notes@latest`、显示「发现新版本 0.1.4（当前 0.1.3）」+「更新」
- 确认步骤：先进入确认态说明「从 npm 更新到 x（当前 y）」，确认后调用 `installBundle`，且 spec 为 `@latest`、`enabled: true`、**不传 approvedBuilds**（不代批准安装脚本）、requestId 存在
- 本地链接安装：确认时明确警示「更新后本插件将改为从 npm 安装，本地改动不再自动生效」，按钮转为警示样式
- 结果分支：已是最新（不再给更新按钮 + 重新检查）、检查被拒（网络不可用 + 重试）、`restart-required` → 重启后生效、`pendingBuilds` → 需在插件页批准、`build-blocked` → 需先批准、`{ok:false}` 信封错误 → 显示原因

控件实现所依赖的两个外部约定已从 DSH 自身源码核对：
1. `inspect`/`installBundle` 的返回值确为 `{ok,value}`/`{ok,error}` 信封 —— 官方插件页客户端写的就是 `if (!inspected.ok) {...} if (inspected.value.status === 'refused')`；
2. Remote 命名空间服务由 gateway 以 `ownerCtx.plugin({ name: remoteServiceKey(ns) })` 注册在**网关根**下（全局可见），gateway 自身也用 `ownerCtx.get(serviceKey)` 查重 —— 因此 `ctx.get('remote.pluginManager')` 能取到；而本版本 cordis 的 `_refresh()` 要求 `inject` 中**每个**服务都存在才加载，所以声明进 inject 反而会在缺该服务时阻塞整个插件，故按可选获取实现。

**插件页更新控件的严格参数契约（真实网关行为复刻后实测）**
- 现象：在真实 DSH 里打开插件详情页，更新控件直接显示失败。
- 根因（已用 DSH 源码定位，不是猜测）：gateway 的 `prepareInvocation` 会**按 descriptor 严格校验业务参数个数** ——
  `expected = descriptor.parameters.length`（`pluginManager/inspect` 为 2：`spec` + `options`；第三个参数才是可选的 `AbortSignal`），
  个数不符即抛 `client api: pluginManager/inspect expected 2 business argument(s) plus an optional AbortSignal, got 1`。
  原实现只传了 `spec` 一个参数，因此每次自动检查都抛错。
- 修复：`inspect(spec, {})` 传满 2 个业务参数；并让所有失败分支**显示 gateway 的原始报错**（此前只显示通用「检查更新失败」，把真实原因吞掉了，导致只能靠猜）。
- 验证：复现台的假服务改为**复刻 gateway 的严格参数校验**（个数不符抛一字不差的错误），28/28 通过 —— 其中包括：
  - `inspect` 实际收到 2 个业务参数（个数被断言）；
  - 服务抛异常时界面原文照显 `expected 2 ... got 1` 并保留重试入口。

**更新入口的第二次修正：`inspect` 不能当「检查更新」用（已在真实环境暴露）**
- 现象：修好参数个数后，真实 DSH 里打开插件详情页，控件显示「插件已经安装了」（原文 `dsh-client-ui-notes is already installed`）。
- 根因（DSH 源码）：`inspect` 是**安装前校验**，其 registry 分支第一步就是 `if (known.has(parsed.name)) return refused("already-installed", ...)`
  —— 只要这个包已装进 profile 就必然拒绝，拿它做「检查更新」永远失败。而 `installBundle(spec, options)` 没有这道按包名判重的门槛，
  它的实现是「改 profile → 跑包管理器 → 应用重载生命周期」，**对已安装的包就是升级**。
- 修法（分工重划）：
  - **检查**改走本插件宿主半边新增的 `GET /api/dsh-notes/latest-version`：读自身 `package.json` 得包名（改名/复刻也查自己），
    再查 npm 的 `latest` dist-tag；带 5 分钟缓存、8 秒超时，`?fresh=1` 供手动重查绕过缓存。
  - **更新**仍走官方 `installBundle`，但规格改为**精确版本** `包名@<界面上确认的那个版本>`（确认什么就装什么），并传满 2 个业务参数。
  - 失败分支显示 gateway / 宿主的**原始报错**（此前只给一句「失败」，真实原因不可见）。
- 验证：新路由真实打 npm 实测 5/5（含缓存命中更快、fresh 绕过、非 GET 405）；控件界面 26/26（含「不再调用 inspect」、
  「安装规格为精确版本」「传满 2 个参数」「门禁要求能查+能装」「检查失败原文照显」）；纯逻辑断言 30/30。

**第三个现象：404（客户/宿主不同步，非代码问题）**
- 现象：宿主加了新路由（`GET /api/dsh-notes/latest-version`）后，插件页仍提示 404。
- 排查结论：
  - 构建产物里**确实有**这条路由（`lib/index.js` 含 `latest-version`），客户端请求路径也一致；
  - DSH 的路由匹配是 `new URL(req.url ?? '/', 'http://x').pathname`（**查询串被剥掉**，所以 `?fresh=1` 不影响匹配），
    无匹配且无 fallback 时由 webserver 自己 `writeHead(404)`；
  - 客户端插件有 HMR 会热更，**宿主半边必须重启进程才会加载新代码** —— 只刷新页面就会出现「客户端新版 + 宿主旧版」，
    于是新路由 404。面板其余功能（list/read/health 等旧路由）照常，所以只有更新控件报 404。
- 改善：把这句 404 翻译成可执行提示 —— 「宿主半边还没提供查版本的接口（客户端已更新、宿主未重启），请完全退出并重开 DSH」，
  并对其它错误保持原文不改写。客户端 API 单测 5/5（成功路径、默认不带 fresh、fresh=true 带查询串、404 翻译、502 保留原文）。

## 0.1.6：选择文件夹崩溃（cordis inject 门控）

**现象**：点「选择文件夹」弹出
`选择文件夹失败：cannot get property "remote.directoryPicker" without inject`。
提示原文来自面板 `chooseFolder` 的 catch（`flash(\`选择文件夹失败：${messageOf(error)}\`)`），
错误本身来自 `pickDirectory` 的兜底分支。

**排查（两层根因）**
- 第一层：兜底分支把 `typeof remote?.directoryPicker?.pick === 'function'` 当作**能力探测**。
  `remote` 是 cordis 的 Service 门面，对未写进 inject 的命名空间做**属性门控**，读取即抛 ——
  探测这个动作本身就是错误来源。证据：`dsh-api-remotes` 的命名空间是
  `ownerCtx.plugin({ name: remoteServiceKey(ns) })` 注册的**服务**，而
  `remoteServiceKey(namespace)` 的实现是 `` `remote.${namespace}` ``（`dsh-api-gateway/lib/client.browser.js`），
  gateway 自身检查冲突用的就是 `this.ownerCtx.get(serviceKey)` —— `ctx.get` 才是访问正路。
- 第二层：`uiWorkspace` 的 `pickDirectory()` 才是首选路径，但它的快照只在 `apply` 期取一次。
  官方 `dsh-client-ui-workspace` 注册该服务的时机可以晚于本插件的 apply，快照为 `null`，
  于是落到那条会炸的兜底上。旁证：官方包的 inject 里含 `remote.directoryPicker`，
  所以它能直接属性访问；本插件没声明，就必须走 `ctx.get`。

**修复**
- 能力探测改用 `ctx.get('remote.directoryPicker')`，不再属性访问。
- 每个能力「apply 期快照 → 调用时再 `get` 一次」两级，两处都 `try/catch`（查找本身抛错也当没有）。
- `uiWorkspace.pickDirectory()` 失败时降级到 Remote 直连，原错误只进 `console.warn`，不外抛。
- 两者都不可用时给可读的「当前环境不支持选择文件夹」。

**验证**
- 桩按真实门控语义构造：先证明桩能复现同一句 cordis 错误，再验证修复。
  9/9 通过：两者皆无→可读提示、无 workspace 有 remote→Remote 兜底（旧代码在此崩溃）、
  workspace 抛错→降级、workspace 正常→用之、`{ok,value}` 信封、取消→null、
  **apply 时无 workspace 调用时才有**、**apply 时无 remote 调用时才有**。
- 回归：Host 21/21、文件树 16/16、更新逻辑 30/30、客户端 API 错误 5/5、查版本 5/5、加载 6 个副作用可释放。
- 已发布包 `0.1.6` 下载核验：`pickDirectory` 实现里已无任何 `remote.directoryPicker` 属性访问，
  走 `readService('remote.directoryPicker')`；`lib/index.js` 与 0.1.5 **逐字节相同**（本次只改客户端，
  升级后刷新页面即可，无需重启 DSH）。

**真实环境确认**：2026-10-17 用户刷新页面后点击「选择文件夹」，**正常弹出系统选择窗口**。
这也补上了桩验证无法证明的一环：`ctx.get('remote.directoryPicker')` 确实能看到 gateway 用
`ownerCtx.plugin({ name: remoteServiceKey(ns) })` 单独注册的命名空间服务。
源码依据：cordis 的门控只挂在 Context Proxy 的 `get` trap 上，而 `ReflectService.get()` →
`_getImpl()` 查不到时返回 `undefined` 而非抛错（`cordis/src/reflect.ts`）。

-----

## 技能浏览（未发布）

**目标**：不自己扫盘、不自己解析 `SKILL.md`，把 DSH 官方 skill 注册表的目录复用到笔记面板里，
点开即可在现有阅读器中看正文。只读。

**做法**
- 宿主新增 `GET /api/dsh-notes/skills`，数据来自 `ctx.skills`（官方 `@deepseek-ai/dsh-skill` 注册表），
  优先用 `snapshot()`（带 `complete` 标记），退到 `list()`。
- 注册表与会话表**不写进 `inject`**，一律 `ctx.get()` 可选获取：某环境没有 skill 插件时，
  入口显示一句提示，笔记本身完全不受影响（写进 inject 会连坐整个插件不加载）。
- 正文复用现成的 `/api/dsh-notes/read`：打开技能时把「根」切到 `dirname(SKILL.md)`，
  围栏照常生效。

**验证**（全部跑编译后的 `lib/`，注册表与提供方用的是**真实的** `dsh-skill` + `dsh-skill-filesystem`）

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `skilltest` | 26 / 26 | 真实注册表读到本机 3 个用户技能、按名排序、`path` 指向 `SKILL.md`、`invocation.modelInvocable` 取法（`quick-look` 判定为仅手动）；缺注册表 / `list` 返回 undefined / 注册表抛错三种降级；路由 200、字段齐全、非 loopback 403、非 GET 405、非 loopback Host 403、无注册表时 200 + `available:false` |
| `skille2e` | 7 / 7 | 三个真实技能的 `SKILL.md` 都能用「技能目录当根」通过 `read` 路由读到正文（4383 / 7357 / 1442 字符）；同时 `/etc/hosts` 仍被 403 拒绝 —— 围栏没有因为换了根而失效 |
| `icontest` | 6 / 6 | 临时技能根里 `assets/icon.png` 与根目录 `other.svg` 都被发现、MIME 正确、非图片文件不被当图标 |
| `skillwire` | 18 / 18 | 客户端打包含新路由、全部新类名与文案；未引入任何 Node/宿主模块；宿主 bundle 无 `@deepseek-ai/dsh-skill` 静态依赖、且确实通过 `ctx.get` 取服务 |

**回归**：13 个既有套件全绿（host 21、tree 16、pick 9、apierr 5、latest 7、update 32、meta 10、
save 11、refresh 17、search 12、searchwire 23、token 4、flash 11），共 **190** 条断言。

**未做真实 GUI 截图验证**：本机沙箱内 Chrome headless 无法启动
（`sandbox initialization failed: Operation not permitted`），因此界面层只有静态断言与
类型检查，交互效果以用户实际使用为准。

**第二轮修正（用户实测反馈：只看到内置技能、点了打不开）**

实测截图显示列表里全是 `office-*` 且都标「无文件」、点了只弹一句提示（且这是**任何已发布版本都没有的**新提示，说明新代码已生效）。

原因：技能有两类形状。文件提供方（`dsh-skill-filesystem`）给的候选带 `path`（`SKILL.md` 绝对路径）；
**插件内置的**（`dsh-skill-office` 等）只带 `resourceBase: { kind: 'directory', path }`，候选里根本没有文件路径。
所以「有 path 才能打开」这个判断对内置技能必然失败。

修法：新增 `GET /api/dsh-notes/skill-content?token=<opaque>`。列表时对每个无文件技能发一个
`randomBytes(12)` 的不透明 token（整表替换、30 分钟过期），客户端拿 token 换正文，
宿主再用注册表的 `get(name, {cwd})` 取内容。客户端**不接受按技能名直接取**，也把内置技能
渲染成**只读视图**（没有编辑框与保存按钮，不进 tab 列表）。

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `builtintest` | 21 / 21 | 真实 `dsh-skill-office` 下 3 个内置技能都被识别；3 条正文分别 6058 / 6800 / 9171 字符；拿技能名当 token → 410、无 token → 400、伪造 token → 410、非 loopback → 403；**重新列一次列表后旧 token 立即作废** |
| `skillwire` | 21 / 21 | 更新为断言新路由、只读视图类名与「内置」标签 |

**全量回归：18 个套件 / 259 条断言，全绿。**

**第三轮修复（用户实测：只看到系统内置的 7 个，自己的看不到）**

诊断字段把根因一次定住（详见 DEVELOPMENT.md 同名条目）：

1. `登记 dsh-office` 说明宿主平面拿到的注册表里**没有** `filesystem` 提供方。
2. DSH 的 `dsh-web-app` 补丁里 `skill-filesystem` 写着 `disabled: true`，注释明说
   "presets own local discovery" —— 本地技能发现被挪到了**每个 agent preset 的层**。
3. 要读那一层需要 `presets.serviceFor(live, 'skills')`，其中 `live` 是**活的 agent 对象**，
   宿主插件拿不到（`agents` 服务不在宿主平面）。

第三方技能中心插件 `@linxin666/dsh-client-ui-skill-explorer` 的源码注释写的是同一件事：

> "The web profile mounts the skill-filesystem provider only at the agent preset scope layer,
> so the host plane cannot read project/user skills from `ctx.skills` — the list route scans
> the official root conventions itself and merges registry entries"

**因此改为与它一致的思路**：宿主自己按 DSH 官方约定扫盘，再与注册表结果按名字合并。

| 项 | 内容 |
|---|---|
| 扫描根 | `<项目根>/.dsh/skills`(100)、`<项目根>/.agents/skills`(200)、自定义(300)、`~/.dsh/skills`(400，跳过 `.system`)、`~/.agents/skills`(500) |
| 形态 | `<name>/SKILL.md` 目录包 与 `<name>.md` 平铺文件；**不递归**；跳过 `.` 开头 |
| frontmatter | 自解析 `name`/`description`/`whenToUse`/`disable-model-invocation`，支持 `\|` 多行块与引号 |
| 合并 | 扫描优先（带真实 path，可直接打开）；注册表独有的一律保留（内置技能，正文走 token） |

**同时新增插件设置项**（用户要求「这是 plus 功能，默认开，不想要可以关」）：

- `apply.Config` 挂上 schemastery schema —— DSH 的设置框架按
  `entry.fiber.runtime.Config.toJSON()` 生成插件详情页表单，可选参数的 TS 类型声明**不产生**这个字段。
- **每个字段都必须 `.volatile()`**：`dsh-settings` 的 `volatileForm()` 对没有任何 volatile
  字段的 schema 直接 `return undefined`，该行不进配置目录，插件页那一行就没有「配置」入口。
- `skillsReading`（默认 `true`）：关掉后客户端不显示任何技能入口，两条技能路由返回 404。
- `skillRoots`：额外的技能目录。
- **读配置必须拆 volatile 包装**：解析出来是 `{ get(), [volatile.write]() }`，
  直接比较会恒真。统一走 `readConfig()`（`isVolatile()` → `get()`）。
- **volatile 改动不重启插件**，所以上限与开关一律调用时现读。

**配置页走 `plugins.bundle.config`**（照官方 `dsh-workbuddy-connect`）：

| 项 | 内容 |
|---|---|
| 席位 | `plugins.bundle.config`，key = **包名**（包级入口，直接渲染在包详情页）；另挂 `plugins.row.config`（key `<包名>#<行id>`）兼容老宿主 |
| 页面 | 自绘，不依赖 `configForms` / `SettingsFormModel` / `SettingsValueField` |
| 读 | `GET api/dsh-notes/config` → `{ values, writable }` |
| 写 | `POST api/dsh-notes/config` → `ctx.configEditor.edit(entry, change)` 落进 profile 的 `cordis.patch.yml` |
| 降级 | 没有 `configEditor` 时 `writable: false`，POST 返回 501，界面显示只读提示 |

**大小上限按 MB 显示**：界面填 `8`（右侧标 `MB`），存储仍按字节。
换算限定在显示/解析层（`bytesToMb` / `mbToBytes`），宿主 schema 与路由判断不动。
**不编辑不回写**：只有用户真的改了输入框才上报；非整 MB 的旧值显示时会舍入，
自动回写会把 `1000000` 悄悄改成 `996147`。

**验证**：`unittest` 44 条（默认显示 8、1~1024 MB 往返一致、小数换算、
非整 MB 旧值只显示不回写、SizeField 只有一处 onChange、清空恢复、存储仍是字节）、
`configwire` 23 条（两个席位都注册、key 拼法、客户端零 `configForms` 依赖、
路由存在、类型校验、写回通道、真正的 switch 控件）、
`configroute` 21 条（真跑路由：GET 读值含 volatile 拆包、无 editor 时 501、
POST 写进 profile 且保留既有字段、7 类坏输入全部 400 且一次都没写）、
`volatiletest` 11 条（volatileForm 接受、访问器陷阱、关掉后真 404）、
`configentry` 11 条（`configure.has(row)` 命中、旧写法反例）。
另更新 `grouptest`/`skillwire`/`sw2`/`menutest` 中因这次改动而失效的旧断言。

**验证**：新增 `scantest` 20 条（目录包 / 平铺 / 多行描述 / 无 frontmatter / 隐藏目录 /
`disable-model-invocation` / 真实用户技能 / 开关 404 / health 上报 / schema 含字段且默认 true），
另有测试证明 `~/.dsh/skills` 下真实技能被扫到且 path 正确。

**全量回归：20 个套件 / 287 条断言，全绿。**
（`skilltest`/`icontest`/`diagtest` 的 3 条旧断言因「有了扫描后降级语义变了」而更新：
没注册表时不再返回空列表，而是仍给出扫描结果。）

**已知边界**
- 技能页不进 tab 列表、不支持置顶：它不是文件，混进「最近打开的文件」会让状态恢复难解释。
- 内置技能只是**只读展示**：它的正文里可能追加了运行期说明（如 Office 技能的运行时路径），
  与实际加载给模型的内容一致，但不提供编辑。
- 点开技能后 tab 名用真实的 `SKILL.md`，**不用** `/技能名`：`FileTypeIcon` 与文档头都按名字
  推图标与路径，改了名字两者都会错（无扩展名会被当成 unknown 类型）。
- 打开技能会**切换当前笔记文件夹**到技能自己的目录（围栏所限）。这是刻意的取舍，
  已写进代码注释与开发文档；若日后觉得打扰，可改为记住「上次的笔记根」并在离开技能时还原。

**发布包完整性（真实打包 + 解包核对）**

本地是 `link:` 安装，包缺文件在开发机上看不出来，所以这项必须真打包验证：
- `node scripts/check-package.mjs`：用 `npm pack --dry-run --json` 取真实文件清单，
  核对 `lib/index.js`、`lib/client.js` 里的每个相对导入都在清单内
- 反向验证过它有效：把 `files` 退回旧的手写白名单，脚本以退出码 1 失败并明确指出
  `lib/index.js → ./globalInstructions.js`（与线上报错一致），因此 `prepublishOnly`
  会拦住这种包
- 打包后解包再核对：`lib/globalInstructions.js` 存在，入口相对导入全部命中
- 外部导入只允许已声明的依赖与 node 内置：实测为 `@deepseek-ai/cosmokit`、
  `@deepseek-ai/schemastery` + `node:crypto/fs/fs-promises/os/path/url`
- 文件数 45、其中 3 个 js（index / globalInstructions / client），未把
  `lib/client/*.js`（tsc 中间产物，440KB）打进包

**缺文件降级（真实构造坏安装环境）**

把 `lib/index.js`、`lib/agentInstructions.js`、`lib/client.js` 单独拷到一个目录、
**故意不放** `globalInstructions.js`，再 `import()` 宿主入口：
- ✅ 入口加载成功，导出了 `apply` / `inject` / `makeRoutes` 等 —— 插件可以激活
- ✅ 调 `loadAgentInstructions()` 抛出可读原因（含「请重新安装或更新本插件」），
  是普通异常而非未处理错误；二次调用稳定，不重复解析
- ✅ 正常环境下同一函数返回三个纯函数，`defaultAgentFilePath()` 为 `~/.dsh/AGENTS.md`
- ✅ 该路由失败时 `fail()` 回 500 + 文案；前端 `AgentFilesPane` 本就有 `.catch`
  兜底（不显示默认项），面板不会崩

**移除自带「检查更新 / 更新」按钮（0.1.24，官方能力已覆盖）**

决策依据不是猜的 —— 读官方 `@deepseek-ai/dsh-client-ui-plugin-manager` 的实现核对过：

- 官方插件页文案里已有完整流程：`版本`区块、`可更新到 {version}`、`已是最新版本`、
  `新版本需要更新 DSH`（**版本兼容性拦截**）、`updateRestored`（装失败**自动回滚**原版本）、
  `updateKept` / `updateBroken` / 安装输出。
- 其宿主服务 `pluginManager` 提供 `listVersions(name)`（查已发布的更新版本）与
  `updateBundle(name, version)`（装前校验「存在 / 声明 bundle / 兼容当前 DSH」，失败自动重装原版本）。
- 本插件原先自建的那套是「查 npm latest-tag + `installBundle` 覆盖安装」：**没有兼容性校验**，
  失败也没有回滚，两者都弱于官方。

清理范围（约 700 行，全部只服务这一个功能）：

- 客户端：`UpdateAction.tsx` 整文件 473 行；入口里 `plugins.detail.actions` 的 slot 注册与
  `pluginManager` 快照；`api.latestVersion()`；`HostHealth.localInstall`；`.dsh-notes-update*` 8 处样式。
- 宿主：`latestPublishedVersion()`、`latestCache` / `LATEST_TIMEOUT_MS`、`LatestVersion` 类型、
  `ROUTES.latestVersion` 及其路由处理、`selfPackageName()`、`LOCAL_INSTALL`、health 响应里的 `localInstall`。
- **保留** `pluginManager` 快照：它另有用途（本插件被卸载时清浏览器存储），
  卸载清理逻辑（`notes: cleanup on uninstall`）经核对仍在，未随控件一起被删。

验证方式与结果：

- ✅ 产物零残留：`lib/client.js`、`lib/index.js` 中 grep `UpdateAction` / `检查更新` /
  `latest-version` / `latestPublishedVersion` / `LOCAL_INSTALL` 全部 0 命中
- ✅ 模块登记与产物**完全配对**：MODULES 唯一模块 25 个、产物定义 25 个；
  无悬空 `__mod_X` 引用、无「登记了却没打包」、无「打包了却没登记」（这项直接对应历史上
  `__mod_X is not defined` 那个坑）
- ✅ bundle 体积 396.7 KB → **373.7 KB**
- ✅ `tsc` 无报错；`node --check lib/client.js` 通过
- ✅ 打包自检：48 个文件 / 其中 4 个 js，入口相对导入全部在包内

踩到的坑（已记入 DEVELOPMENT.md）：删掉源文件后 `tsc` **不会**删除旧产物，
`lib/client/UpdateAction.js` 仍在，而构建脚本读的正是 `lib/client/*.js`，
于是死代码照旧被打进 bundle（第一次重建后体积没变、还能 grep 到旧模块名）。
删模块必须同时：删源文件、摘掉 `MODULES` 登记、手动删 `lib/client/<模块>.*`。

**关闭未保存标签页的确认（0.1.25）**

起因是用户报告「没保存关闭后会丢」。先定性是哪条路径丢的 —— 用真实的
`lib/client/store.js` 模拟「打字 → 关窗口 → 重开」：

- ✅ 打字后处于未保存（`drafts` 有值）
- ✅ `beforeunload` 把 state（含草稿）补写进 localStorage
- ✅ 重开后 tab 恢复、草稿内容原样恢复、仍标记「未保存」
- ❌ **关标签页**：草稿被 `closeTab` 直接删除，没有任何提示

结论：关 DSH 有兜底、不会丢；**关标签页才是纯丢失**。所以修复只做这条，
不注册 window 级 `beforeunload`（全局事件属侵入，且内容本来就不会丢）。

改动三处：

- `store.ts`：新增 `CloseKind` / `idsForClose` / `tabsToClose`，三个批量关闭方法
  改为共用同一套规则 —— 预检集合与实际关闭集合不会漂移
- `Dialogs.tsx`：`ConfirmDialog` 增加可选次按钮以支持三选；不传时仍是两个按钮
- `NotesPanel.tsx`：四个关闭入口统一走 `requestClose`，有草稿才弹，没有就直接关

验证：

- ✅ 预检与实关一致 **8/8**：one / others / right / all 的集合、不存在的 id 返回空、
  「预检集合 == 实际被关掉的集合」、草稿随 tab 一并清除
- ✅ 新文案全部在产物中（注意：`tsc` 把中文转义成 `\uXXXX`，直接 grep 中文会
  误判成「没编译进去」，必须解码后再比对）
- ✅ 模块登记 25 / 产物定义 25，无悬空 `__mod_X` 引用、无「登记了却没打包」
- ✅ 打包自检：48 个文件 / 4 个 js，入口相对导入全在包内
- ⚠️ 未覆盖：弹层的真实点击链路（保存并关闭 → 写盘 → 关 tab）。产物只对外导出
  5 个符号，`ConfirmDialog` 无法脱离面板单独渲染，这条需要在重启 DSH 后于真实
  界面点一次

**issue #1：右键「打开」把二进制当纯文本（0.1.26）**

报告者说「.csv/.xlsx/.pdf 总是当纯文本打开，打开方式按钮从不出现」。实测下来
一半对一半不对：

- 左键点击 `.xlsx`/`.docx` → ✅ **正常**显示「此格式无法在阅读器中打开」+
  「用 WPS Office 打开」（用户截图确认）
- 右键 → 点「打开」 → ❌ 二进制内容被塞进纯文本编辑器
- `.csv` 本来就在宿主的文本白名单里，按纯文本打开**是设计如此**，不算 bug

根因是同一个判定散在三处，只有一处是对的：

| 位置 | 行为 |
|---|---|
| `Sidebar` 左键点击 | 按 `entry.editable` 分流到 `onOpenExternal` ✅ |
| `NotesPanel.openFile` | 二分「`.md` / 其余 → `txt`」，右键菜单直接调它 ❌ |
| `NotesPanel.openPinned` | 同样二分，置顶区打开也中招 ❌ |

修复分两层：

1. **右键菜单不再给这类文件「打开」**。它点开只能进一个提示页、再点一次
   「用 XX 打开」，等于多绕一步；左键点击本来就能到那个提示页，右键不重复入口。
   菜单项条件收紧为 `kind === 'file' && editable`（符号链接同样不给）。
2. 新增 `paths.openKindFor(name, readable?)` 作为唯一判定 —— 有宿主 `editable`
   时以宿主为准（白名单在宿主那边，客户端不复制一份），只有路径时（置顶区）
   按明确的二进制扩展名兜底。置顶区没有右键菜单，所以那里仍需要能正确落到
   `external` 提示页。

验证：

- ✅ 判定表 **16/16**：`README.MD` → md；`a.csv`（editable）→ txt；
  `a.xlsx`/`a.pdf`/`一体机接口文档.docx`/`a.png`（不可编辑）→ external；
  无 `editable` 时 xlsx/pdf/docx 仍 → external、csv → txt；`README`、`.gitignore` → txt
- ✅ 产物：`openKindFor` 出现 8 次，无新增悬空引用，打包自检 48 文件 / 4 个 js
- ⚠️ 未覆盖：右键菜单的真实点击，需重启 DSH 后在界面上点一次

**字数显示（0.1.26）**

- ✅ 计数口径 **8/8**：`你好 世界\n第二行` → 7、纯空白 → 0、
  `😀` → 1（不按 UTF-16 代理对算 2）、`hello world` → 10
- 口径说明：**包含 Markdown 标记符号**，`**粗体**` 计 6 字。若需要「纯文字
  口径」，得先解析 Markdown，属于另一个决定

**文档内查找（0.1.26）**

入口是**文档头左侧的放大镜**：点下去在**同一位置**展开成查找栏（覆盖文档头那一行），
鼠标不用上下移动，正文也不被遮挡。**不注册任何全局快捷键** —— DSH 允许各插件绑定
按键，本插件再去抢 ⌘F 就会与快捷键类插件打架，用户还看不出是被谁截走的。

编辑栏的匹配用**叠加色块**表示（textarea 内部不是 DOM，无法给文字上色）：
位置由「行号 × 行高 + canvas 量出的文字宽度」算出，滚动时整层平移、不逐块重算。
预览区用 CSS Custom Highlight API，**全部浅色、当前深色**，与编辑栏同一套配色。

这一版在验证过程中抓到三个真问题，都是静态读代码看不出来的：

- **两处 textarea 的折行行为不一致**：染色模式写了 `wrap="off"`，普通编辑栏没写，
  于是 md/txt 默认折行。一条超长行被折成多个视觉行后，「行号 × 行高」就不再等于
  视觉位置 —— 表现为**从那条长行之后，所有命中块整体上移一行**。
  定位办法：直接读用户那个文件的换行符与行内容（纯 LF、59 行、无特殊字符），
  排除内容问题后对照两个 textarea 的属性差异才锁定。修法是统一 `wrap="off"`。
- **色块压根没渲染**：坐标算法验证过了，但组件里只写了计算、没把元素放进 JSX。
  教训：用「手绘 DOM」验证算法，验不到「组件是否真的渲染」。
- **预览区少了一处匹配**：代码块正文与语法高亮是**异步**填进 DOM 的，算匹配时
  它还没出现，算完就不回看。修法是给预览区挂 `MutationObserver`，内容变化后
  节流 150ms 重算。

验证结果：

- ✅ 命中块位置：按用户的真实内容 + 窄宽度（模拟分栏）实测，5 处全部精确压中
- ✅ 跨节点匹配：预览里被 `<strong>` 切开的词也能正确高亮
- ✅ 异步内容补算：模拟「先 2 处、400ms 后插入 1 处」得到 `initial=2 final=3`
- ✅ 滚动定位：300 行文本跳到第 200 行，`scrollTop=4262.0`，目标落在视口上 1/3
- ✅ 不抢焦点：跳转后 `document.activeElement` 仍是查找输入框
- ✅ 打包自检 49 文件 / 4 个 js；模块登记 26 / 产物 26、无悬空引用
- ⚠️ 未解决：滚动时色块比文字**晚一帧**（textarea 滚动由浏览器合成线程处理，
  JS 收到 scroll 事件时已晚）。位置始终正确，只是跟手差一帧；要彻底同步得自建
  滚动容器，属于重写编辑器，本次不做
