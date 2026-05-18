# Sync Fork With Upstream

这份文档记录如何把自己的 fork 仓库同步到原始仓库（upstream）。

适用场景：

- 本地仓库的 `origin` 指向你自己的 fork
- 你希望把 fork 的 `main` 同步到原始项目最新的 `main`
- 你本地可能还有自己额外的提交，希望保留下来

## 1. 检查当前仓库状态

先确认当前分支、工作区是否干净、远程仓库配置是否正确：

```powershell
git status --short --branch
git remote -v
git branch -vv
```

重点确认：

- `origin` 应该是你自己的 fork
- 当前通常在 `main`
- 最好先保证没有未提交改动

如果有未提交改动，建议先提交或暂存，否则同步过程中更容易混乱。

## 2. 添加原始仓库为 upstream

如果仓库里还没有 `upstream`，先添加：

```powershell
git remote add upstream https://github.com/<owner>/<repo>.git
```

查看是否添加成功：

```powershell
git remote -v
```

例如这次仓库的配置是：

- `origin`: `https://github.com/yinhuadong-007/OpenCLI.git`
- `upstream`: `https://github.com/jackwener/opencli.git`

## 3. 拉取 upstream 最新代码

```powershell
git fetch upstream
```

然后查看本地 `main` 和 `upstream/main` 的差异：

```powershell
git rev-list --left-right --count main...upstream/main
git log --oneline --decorate -n 5 main
git log --oneline --decorate -n 5 upstream/main
```

输出类似：

```text
1    109
```

这表示：

- 左边 `1` 是本地 `main` 独有的提交数
- 右边 `109` 是 `upstream/main` 独有的提交数

## 4. 选择同步方式

常见有两种：

### 情况 A：本地没有自己的额外提交

如果本地只是落后于 upstream，没有自己的提交，可以直接快进：

```powershell
git checkout main
git merge --ff-only upstream/main
```

### 情况 B：本地有自己的额外提交

如果你本地还有自己的提交，推荐使用 rebase，把自己的提交“放到”最新 upstream 之后：

```powershell
git checkout main
git branch backup/pre-sync-YYYY-MM-DD
git rebase upstream/main
```

这样历史会更干净，也更适合 fork 跟进上游。

## 5. 遇到冲突时怎么处理

如果 `git rebase upstream/main` 出现冲突，Git 会暂停并提示你手动解决。

先看状态：

```powershell
git status --short
```

查看冲突文件后，手工编辑解决冲突。解决完成后：

```powershell
git add <冲突文件1> <冲突文件2>
git rebase --continue
```

如果还有下一个冲突，就继续重复：

1. 编辑冲突文件
2. `git add ...`
3. `git rebase --continue`

常用补救命令：

```powershell
git rebase --abort
git rebase --skip
```

说明：

- `--abort`：放弃这次 rebase，回到开始前状态
- `--skip`：跳过当前冲突提交，不推荐随便用，除非你明确知道这次提交可以不要

## 6. 当前这次实际冲突案例

这次同步 `OpenCLI` 时，分叉情况是：

- 本地 `main` 比 upstream 多 1 个提交
- upstream 比本地 `main` 多 109 个提交

本地独有提交是：

```text
89b271c  【google trends 抓取】
```

rebase 时主要冲突出现在 `package.json`。

处理原则是：

- 保留 upstream 当前版本的整体内容
- 保留自己真正需要的改动
- 不要把旧分支里已经过时的配置整块覆盖掉 upstream 新版本

本次处理后的思路是：

- 保留 upstream 新版测试脚本和版本信息
- 保留你自己的 `prepare` 脚本修改

## 7. rebase 完成后检查结果

rebase 结束后，执行：

```powershell
git status --short --branch
git log --oneline --decorate -n 10
```

确认：

- 已经回到 `main`
- 工作区干净
- 你的提交已经位于最新 upstream 提交之后

## 8. 推送回自己的 fork

因为 rebase 会改写提交历史，所以通常需要强制推送，但推荐使用更安全的方式：

```powershell
git push --force-with-lease origin main
```

不要随便用：

```powershell
git push --force origin main
```

`--force-with-lease` 更安全，它会在远端有你未预期的新变化时阻止覆盖。

## 9. 推荐的完整命令流程

日常同步 fork 时，可以按这个顺序执行：

```powershell
git status --short --branch
git remote -v
git fetch upstream
git rev-list --left-right --count main...upstream/main
git branch backup/pre-sync-YYYY-MM-DD
git rebase upstream/main  或者 git merge upstream/main
git push --force-with-lease origin main
```

如果 `upstream` 还没配置，先补这一条：

```powershell
git remote add upstream https://github.com/<owner>/<repo>.git
```

## 10. 当前仓库的特殊提醒

当前仓库现在还处于 rebase 中间态，`git status --short --branch` 会显示类似：

```text
## HEAD (no branch)
```

这说明 rebase 还没有完成。

此时不要直接切分支，也不要乱 reset，正确做法是：

```powershell
git status --short
git add package.json .gitignore clis/google/trends-explore.ts
git rebase --continue
```

如果继续过程中没有新冲突，最后再执行：

```powershell
git push --force-with-lease origin main
```

## 11. 一个简短原则

同步 fork 时，优先遵循这三个原则：

- 先 `fetch upstream`，不要盲目直接推
- 有自己提交时优先 `rebase upstream/main`
- 推送改写历史后的分支时，优先用 `--force-with-lease`
