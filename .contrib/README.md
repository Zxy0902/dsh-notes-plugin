# 待提交：awesome-dsh-plugin 收录

本目录存放提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的条目文件，便于日后直接取用。

## 为什么还没提

该列表的收录要求里有一条硬门槛：**仓库创建满 1 天**（由 CI 自动检查）。
本仓库创建于 2026-10-16T09:29:09Z，未满时提交会被自动拒绝。
（官方说明：未达标就把功能做完再提交，重新提交不会有任何影响。）

## 怎么提

1. 给仓库加上 `dsh-plugin` topic：
   仓库首页 → 右上「⚙️」齿轮（About 右侧）→ Topics 填 `dsh-plugin` → Save

2. Fork [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

3. 在 fork 里新建文件，路径与文件名必须完全一致：

   ```
   data/plugins/Zxy0902__dsh-notes-plugin.yml
   ```

   内容即本目录下的 `Zxy0902__dsh-notes-plugin.yml`。

4. 提交并开 PR。**一个文件就是全部投稿** —— 两个 README 由脚本从
   `data/plugins/*.yml` 生成，不要手工编辑它们。

## 已核对的要求

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 真实可用代码（非占位/纯 README） | ✅ 已发布 npm |
| 仓库创建满 1 天 | ⏳ 2026-10-17T09:29Z 后满足 |
| 加 `dsh-plugin` topic | ⬜ 待做 |
| 描述不含营销词、且与代码相符 | ✅ 逐条对照过源码 |
