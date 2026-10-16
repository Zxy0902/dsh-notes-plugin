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
- **预检**：本地跑过官方 `scripts/check-submission.mjs`，唯一未通过项就是年龄；`dsh.bundle`、
  仓库存在性、分类取值、条目格式全部通过。

## 时间线与手动加速

- **2026-10-17T09:29:09Z**（北京时间 10-17 17:29）：仓库满 1 天，年龄门槛消除。
- **自动转绿**：`regate.yml` 对「年龄类失败」设有 **24 小时冷却**（距上次判定），而 gate 是
  2026-10-16T15:16Z 判的，所以最早要等到 2026-10-17T19:19Z 那一轮（cron `19 */6 * * *`）才会重跑。
  预计北京时间 10-18 03:19 前后自行变绿 —— 无需任何操作。
- **想更早绿**（必须等满 1 天之后再动手）：直接重跑 gate 那次 run，不受 24 小时冷却限制。
  网页路径：仓库 → Actions → 找到 `Submission gate` 那次 run → **Re-run jobs**；或重跑
  `PR check`（[run 38921389649](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/actions/runs/38921389649)），
  它会重新触发 gate。

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

## 已核对的要求

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 真实可用代码（非占位/纯 README） | ✅ 已发布 npm |
| 仓库创建满 1 天 | ⏳ 2026-10-17T09:29:09Z 后由 CI 自动放行 |
| 加 `dsh-plugin` topic | ✅ |
| 描述不含营销词、且与代码相符 | ✅ 逐条对照过源码（删除行为据 `moveToTrash` 精确表述） |
| 已发 npm（预构建安装免 `allowBuilds` 授权） | ✅ `dsh-client-ui-notes@0.1.5` |
| 官方 `@deepseek-ai/*` 用 `peerDependencies` 声明 | ✅ |
