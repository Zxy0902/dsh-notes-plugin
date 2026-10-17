# 已提交：awesome-dsh-plugin 收录

本目录存放提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的条目文件，与线上提交保持同步。

## 当前状态

- **PR**：[#7606 Add Zxy0902/dsh-notes-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7606)
  （2026-10-16 提交，分支 `Zxy0902:add-dsh-notes-plugin`）
- **`dsh-plugin` topic**：已给仓库加上
- **CI 现状**：`check`（条目格式 / awesome-lint / 站点构建）✅ 通过；`Submission gate` ❌，唯一原因
  是仓库年龄（gate 原文：`repository is 0.2 days old (needs 1)`）。这一项由 `regate.yml` 自动重跑
  清除，**不要**关闭或重开 PR，也不需要 push 空提交。
  <br>截至 2026-10-17T19:11（北京时间）复核，gate 仍是 10-16T15:16Z 那次旧判定，尚未到
  `regate` 的重跑轮次 —— 符合预期，不是卡住了。
- **预检**：本地跑过官方 `scripts/check-submission.mjs`，唯一未通过项就是年龄；`dsh.bundle`、
  仓库存在性、分类取值、条目格式全部通过。

## 时间线

- **2026-10-17T09:29:09Z**（北京时间 10-17 17:29）：仓库满 1 天，年龄门槛消除。
- **自动转绿**：`regate.yml` 对「年龄类失败」设有 **24 小时冷却**（距上次判定），而 gate 是
  2026-10-16T15:16Z 判的，所以最早要等到 2026-10-17T19:19Z 那一轮（cron `19 */6 * * *`）才会重跑。
  预计北京时间 10-18 03:19 前后自行变绿 —— 无需任何操作。

### 为什么不能手动加速（2026-10-17 实测）

一度以为「满 1 天后重跑一次 gate 就能立刻绿」，实测**做不到**：

- `POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/<id>/rerun-failed-jobs`
  返回 **`403 Must have admin rights to Repository`** —— upstream 仓库的 workflow 只有它自己的
  owner 能重跑，PR 作者没有权限；网页上的 Re-run 按钮对贡献者同样不可用。
- `pr-check.yml` 的触发是裸 `on: pull_request`，只监听 `opened / synchronize / reopened`，
  **不含 `edited`** —— 改 PR 标题或描述不会触发新 run（改 body 后 `updated_at` 变了、check
  没有新增，可印证）。
- 剩下能触发新 run 的只有 **push 一个提交** 或 **close + reopen**，而 contributing.md 明确写了
  「不要 resubmit、push 或 close and reopen，它是自己变绿的」。

结论：**什么都不用做，等 19:19Z 那轮 `regate`。**

## 条目文件

线上提交路径与文件名必须完全一致：

```
data/plugins/Zxy0902__dsh-notes-plugin.yml
```

内容即本目录下的 `Zxy0902__dsh-notes-plugin.yml`。**一个文件就是全部投稿** —— 两个 README 由
`data/plugins/*.yml` 生成、在 `main` 上自动重新生成，不要手工编辑，也不必由 PR 提交。

## 之后若要修改条目

改本目录的 yml → 用同样内容更新 fork 上 `add-dsh-notes-plugin` 分支的对应文件 → 更新既有 PR。
**只改自己这一条**，不要动别人的条目（gate 会列出 PR 修改的每一个既有条目）。

## 使用信号（2026-10-17 复核）

| 指标 | 读数 | 解读 |
|---|---|---|
| npm 官方下载量 | 查不到（`package not found`） | 新包未进 npm 的下载统计索引，通常要数天 |
| npmmirror 下载量 | 59 次，**全部集中在 2026-10-16** | 发布日镜像同步/回源，10-17 无新增 |
| GitHub star / fork / watch | 0 / 0 / 0 | |
| 仓库浏览（14 天） | 7 次 / 2 个独立访客 | |
| 克隆（14 天） | 76 次 / 33 个独立克隆者 | 本仓库没有 CI，这个量级基本是爬虫与代码扫描器 |
| 公开仓库依赖本包 | 0 | 代码搜索 `"dsh-client-ui-notes"` |

插件本身**零遥测**：除手动点「检查更新」时查一次 npm `latest`，不发任何请求，所以无法得知
具体谁在用、用了几次。真正的拐点是合并进精选列表 —— 市场只展示目录内的插件。

## 已核对的要求

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 真实可用代码（非占位/纯 README） | ✅ 已发布 npm |
| 仓库创建满 1 天 | ✅ 2026-10-17T09:29:09Z 已满（等 `regate` 重跑放行） |
| 加 `dsh-plugin` topic | ✅ |
| 描述不含营销词、且与代码相符 | ✅ 逐条对照过源码（删除行为据 `moveToTrash` 精确表述） |
| 已发 npm（预构建安装免 `allowBuilds` 授权） | ✅ `dsh-client-ui-notes@0.1.5` |
| 官方 `@deepseek-ai/*` 用 `peerDependencies` 声明 | ✅ |
