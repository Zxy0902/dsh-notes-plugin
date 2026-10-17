# dsh-client-ui-notes · DSH 笔记插件

在 DeepSeek Harness 里充当**备忘录 + 目录阅读器**的插件：左侧栏一个「笔记」按钮，
点开后中间主面板切换成阅读器 —— 左边文件夹树 + 置顶区，右边浏览器式 tab 栏，
支持 Markdown 左编辑右实时预览、txt 单栏编辑。

> 纯外部插件：只通过官方 Slot 机制接入，**不改动 DSH 任何源码**。

## 功能

| 能力 | 说明 |
|---|---|
| 左侧栏入口 | 「笔记」按钮排在会话栏上方的全局面板按钮区，默认顺序 30 |
| 浏览器式 tab 栏 | 切换、`×` 关闭、中键关闭、`+` 新建；未保存时显示小圆点 |
| 文件夹树 | 可选任意文件夹作为根，目录懒加载展开，当前文件高亮；根目录按「文件夹 / 根目录文件」分组 |
| 隐藏项过滤 | 不展示 `.` 开头的文件/目录（`.git`、`.obsidian` 等）与 `node_modules`，但不禁止访问 |
| 切换文件夹 | 左侧最上方按钮，调起 DSH 原生目录选择器 |
| 置顶区 | 最多 6 个；1 个占满整行、2 个并排、更多自动往下延伸。有独立分隔线，与文件树分区 |
| 置顶操作 | hover 文件行点右侧图钉，或点已置顶胶囊上的 `×` 取消 |
| 置顶排序 | **按住置顶项拖动即可调整顺序**，拖动时其他项实时让位、并显示落点指示线；顺序与单双栏偏好在重启后保留 |
| 置顶排版 | 「置顶」标题右侧的开关在**双栏 / 单栏**间切换：双栏省纵向空间，单栏文件名更完整 |
| 删除文件 | 文件行右键 → 删除 → 二次确认；移入**系统回收站**可再取回。（Windows 不提供，见「兼容性」） |
| 定位文件 | 文件行右键 → **在访达中打开**（macOS）/ **打开文件所在位置**（Windows）/ 在文件管理器中显示（Linux），由系统打开所在文件夹 |
| 树内定位 | 文件树标题栏的准星按钮：**一键展开当前打开文件所在的所有文件夹并滚过去高亮**，文件夹层级再深也不用一层层点 |
| 树批量折叠 | 标题栏的「打开所有文件夹 / 收起所有文件夹」两个按钮，一次展开或收拢整棵树（超大目录树到 500 个文件夹会提示已截断） |
| 拖拽移动 | 拖文件到文件夹上即移动进去，也可拖回文件树空白处移回根目录；悬停 600ms 自动展开目标文件夹，可拖进多层 |
| Markdown | 左侧编辑、右侧实时预览（用官方 `MarkdownText`，GFM + 代码高亮 + 安全过滤） |
| 显示方式 | 编辑 / 分栏 / **仅预览** 三段切换；仅预览时编辑框完全不渲染，纯阅读更清爽 |
| 同步滚动 | 两侧按比例联动；工具栏可一键关闭，关闭后各自独立滚动 |
| 自适应宽度 | 面板变窄时自动收起文件夹栏、改为上下堆叠，避免内容被挤成一列字 |
| 层级分明 | 文件夹栏是内缩的圆角区块；macOS 折叠会话栏后，**只有左栏**额外下移让开交通灯，右侧阅读区（tab 栏 + 正文）保持不动，避免顶部露出空白带 |
| 纯文本 | txt 单栏直接编辑，不显示无意义的预览栏 |
| 新建 | 先选类型（Markdown / 纯文本），再填文件名；自动补扩展名 |
| 手动保存 | `⌘S` / `Ctrl+S` 或保存按钮；未保存时 tab 有圆点、文档头显示「未保存」 |
| 状态记忆 | tab、当前 tab、置顶、展开的目录、滚动位置、未保存草稿都会保留 |
| 标签页管理 | tab 上右键可「关闭 / 关闭其他 / 关闭右侧标签页 / 关闭全部」；中键关闭 |
| 标签溢出 | 标签多到放不下时，栏右端出现向下尖头，点开下拉列出全部标签（含被裁掉的），当前项高亮 |
| 文件可见范围 | 文件树标题行有「可编辑 / 全部」开关（偏好持久化）。「可编辑」只列能在阅读器里打开的文件；「全部」连 `.doc`/`.pdf` 一起列出 |
| 打开方式 | 点这类不可预览的文件**不会直接弹出系统程序**，而是在阅读区开一个标签页：显示「此格式无法在阅读器中打开」+ 一个**打开方式**控件。左边按钮用默认应用打开，右边下拉列出系统里所有能打开它的应用，底部另有「显示文件位置」 |

## 安装

> **前置条件：本插件是图形界面插件**，只在 **Web GUI** 里有界面 —— 包括桌面应用，
> 以及终端里自己跑起来的 `dsh web`（浏览器访问）。
> 纯终端场景（`dsh headless "..."`、SDK、ACP）装了不会报错，但也**没有任何功能可用**：
> 界面所依赖的槽位与 `webServer` 服务都由 `@deepseek-ai/dsh-web-app` 提供。

**桌面应用目前只发布 macOS 与 Windows 版，没有 Linux 版。** Linux 用户需要自行安装
DSH CLI，再用 `dsh web` 在浏览器里使用（功能与桌面版一致）。

### 桌面应用（macOS / Windows）

在左侧栏打开**「插件」面板** → 点**「添加插件」** → 填入包名 `dsh-client-ui-notes` → 安装。

> 注意不是「设置 → 内置插件」那一页 —— 那页只用于**查看**本部署内置了哪些插件，不能安装。

### 终端 / 自建 profile（任意平台，含 Linux）

先建一个带 Web 界面的 profile，再把插件装进去：

```sh
# 1. 以 web 模板创建 profile（--dump-config 让它只建不启动，配置输出丢弃即可）
dsh --profile notes --from-default-profile web --dump-config > /dev/null

# 2. 把插件装进该 profile
dsh plugin --profile notes add dsh-client-ui-notes

# 3. 启动，然后在浏览器里打开它打印的地址
dsh --profile notes web
```

左侧栏出现「笔记」图标即为安装成功。

> ⚠️ **不要跳过第 1 步。** 直接 `dsh plugin add` 会让 DSH 自动创建一个以
> `@deepseek-ai/dsh-base` 为基础的 profile，而 **base 里没有 Web 界面层**
> （`@deepseek-ai/dsh-web-app`）。那样的 profile 启动 `web` 时界面出不来，
> 插件自然也无从显示。
>
> ⚠️ 也不能用 `dsh plugin --profile desktop` 去装桌面应用的 profile：
> 那个 profile 归应用独占管理，命令行写入会被拒绝
> （`profile "desktop" is managed exclusively by the Electron application`）。
> 桌面版请用上面的「插件」面板。

想确认插件层已登记，可以看合并后的配置：

```sh
dsh --profile notes --dump-config | grep -A2 dsh-client-ui-notes
# # == dsh-client-ui-notes
# - id: ui-notes
#   name: dsh-client-ui-notes
```

卸载：

```sh
dsh plugin --profile notes remove dsh-client-ui-notes
```

### 首次使用

插件初始没有任何笔记目录，需要两步：

1. 点左上角的**文件夹按钮**选一个目录作为笔记根目录；
2. 右侧文件树标题行的可见范围开关默认是「**可编辑**」（只列 `.md`/`.txt` 等能在阅读器里打开的文件）。
   想看 `.doc`/`.pdf` 这类文件就切到「**全部**」。

### 开发者方式（本地改动 + 热链接）

```sh
# 1. 构建
cd ~/dsh-notes-plugin
npm install          # 首次
npx tsc -p tsconfig.json
node scripts/build-client.mjs

# 2. 链接进目标 profile（以 desktop 为例）
cd ~/.dsh/profiles/desktop
ln -sfn ~/dsh-notes-plugin node_modules/dsh-client-ui-notes
```

然后在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": { "dsh-client-ui-notes": "link:/Users/你/dsh-notes-plugin" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-client-ui-notes" ] } }
}
```

重启 DSH 后，左侧栏出现「笔记」按钮。

> 用 `link:` 装的插件，**改了 `lib/` 下的产物必须重启 DSH** 才会生效：客户端产物是启动时
> 读取并缓存的，磁盘文件变化不会自动重载。

## 更新

三条路都能升级，效果一样：

| 方式 | 怎么用 |
|---|---|
| 插件详情页的「更新」 | 侧栏「插件」→ 点本插件卡片 → 顶部按钮。发现新版本后点一下即升（**0.1.7 起才真正可用**） |
| 插件市场 | 市场里搜到本插件后点「更新」 |
| 命令行 | `dsh plugin --profile <名字> add dsh-client-ui-notes@latest` |

每个版本改了什么见 [CHANGELOG](./CHANGELOG.md)。

> **从 0.1.6 及更早升上来时，详情页的「更新」按钮必然失败**：带 HMR 的宿主会在跑
> pnpm 之前就以 `already-installed` 拒绝「覆盖安装自己」，而旧版本正是这么做的。
> 需要**手动升级一次**（市场或插件页装到 0.1.7+），之后这个按钮才通。
>
> 手动升级若被 pnpm 的 `minimumReleaseAge`（新版本观察期）拦下，用**插件市场**装：
> 它会自动往 profile 的 `minimumReleaseAgeExclude` 追加放行规则，失败还会带
> `--config.minimum-release-age=0` 重试一次；插件页那条路没有这两个兜底。

## 工程结构

```
src/
  index.ts              Host 半边：文件读写路由 + 信任围栏
  client/
    index.tsx           插件入口：注册左侧栏按钮与主面板
    NotesPanel.tsx      面板 UI：树、置顶、tab 栏、编辑器
    store.ts            状态仓库 + localStorage 持久化（记忆功能）
    api.ts              Host 路由的浏览器端客户端
    styles.ts           样式（全部走 DSH 主题 token）
scripts/
  build-client.mjs      客户端 bundle 打包
cordis.patch.yml        profile 补丁：把插件插入插件名册
```

## 安全设计

Host 半边注册的路由能真实读写磁盘，因此：

- **信任围栏**：只接受 loopback 来源（校验 socket 地址 + Host 头 + 浏览器同源标记），
  拒绝 `sec-fetch-site: cross-site`，防 CSRF。
- **根目录约束**：每个请求都要带 `root`（用户显式选中的文件夹），目标路径必须落在
  root 之内，`../` 穿越与相对路径一律拒绝。
- **原子写**：先写同目录临时文件再 `rename`，不会出现半个文件。
- **删除可恢复**：删除优先移入**系统回收站**（macOS `~/.Trash`、Linux XDG 回收站），
  用户在文件管理器里能直接找回；系统回收站不可用时（如 Windows）回退到笔记根目录下的
  `dsh-notes-trash/`，该目录在文件树里可见，同样能取回。任何情况下都不是真删。
- **只允许 md/txt 新建**，文件名里禁止路径分隔符。

## 兼容性

### 操作系统

**怎么跑起一个有界面的 DSH** 各平台不同：

| | macOS | Windows | Linux |
|---|---|---|---|
| 桌面应用 | ✅ | ✅ | ❌ 官方未发布 |
| 自建 `dsh web` | ✅ | ✅ | ✅ |
| 插件运行环境 | 两者皆可 | 两者皆可 | 只能自建 |

插件功能各平台的差异：

| 能力 | macOS | Windows | Linux |
|---|---|---|---|
| 阅读器功能（树、标签页、编辑、预览、置顶、拖拽） | ✅ | ✅ | ✅ |
| 「打开方式」控件 | ✅ | ✅ | ✅ |
| **删除文件** | 系统「废纸篓」 | ❌ **不提供**（见下） | XDG 回收站 |
| 顶部避让窗口控件 | 生效 | 不触发（无此需求） | 不触发 |

**为什么 Windows 上没有删除**：Windows 没有可移植的用户态回收站路径 —— 真正的回收站只能
通过 `SHFileOperation` 或 PowerShell 的 `Microsoft.VisualBasic.FileIO.FileSystem` 写入，
而后者官方注明「非用户交互的应用程序不支持 `recycle` 参数」。做不到「可还原的删除」，
本插件就**不显示删除入口**（右键菜单里没有这一项，直接调接口也会被 403 拒绝）。

这是刻意的取舍：删除的本意是清理文件，若只是把文件挪进一个自建目录，既没清掉、又让用户
以为还能从系统回收站找回，反而更容易误判。其余平台删除进**系统回收站**，可正常还原。

> 补充：macOS / Linux 上若系统回收站本身写不进去（跨分区、权限不足等），会回退到笔记根目录下的
> `dsh-notes-trash/`。该目录**不以点开头**，因此在文件树里可见、可点开、可取回 ——
> 带点的目录会被文件树隐藏，那样用户就找不回误删的文件了。

### DSH 版本与依赖

- 目标 DSH：`>=0.2.0-rc.1`
- **零三方运行时依赖**：客户端 bundle 实际只 `require` 三个平台基线模块
  （`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`），
  宿主侧只用 Node 内置模块。打包脚本维护一份平台模块白名单
  （`react` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` /
  `dsh-client-ui-primitives` / `dsh-client-ui-slots`），**表外的模块一律不能用**，
  越界会在构建期直接报错。
- 所有槽位注册都包在 `ctx.slots.inject()` 里：**即使 DSH 未来删掉某个席位，
  插件也只是不显示，不会让启动失败。**
- 客户端 `inject` 里**必须显式声明 `remote.session`**。DSH 把每个 Remote 命名空间
  注册成独立的 cordis 服务（服务名就是 `remote.` + 命名空间名），而 cordis 的服务
  可见性按 fiber 隔离 —— 只声明 `remote` 是读不到 `remote.session` 的，会抛
  `cannot get property "remote.session" without inject`。官方 `ui-open-in-app`
  同样如此声明。

## 更多文档

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 开发笔记：实现过程中踩到并修复的坑（贡献者向） |
| [VERIFICATION.md](./VERIFICATION.md) | 验证记录：各项功能在真实环境中的实测结果 |

