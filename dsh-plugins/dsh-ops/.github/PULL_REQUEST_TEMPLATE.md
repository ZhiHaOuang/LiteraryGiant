<!-- 标题：<type>(<scope>): <subject>（英文，conventional 形式）。
     正文：删掉不适用的段落，但 Validation 段请保留并给出实际读数。
     English: keep the four sections; Validation carries real command output and the URL of the
     `CI required` run, not ticks. -->

Closes #

## What was wrong

<!-- 现象、最小复现、以及在什么环境下测到的。写清"改之前是什么行为"。 -->

## The change

<!-- 改了哪些文件、为什么这样改。刻意没做什么也写在这里。 -->

## Validation

<!-- 下面的清单是提醒，不是「勾完就算」：Validation 段必须给出实际命令与输出（含 passed/skipped/failed 计数）。

     每个 PR 都必须有一次由 pull_request 事件触发的 CI run，并在这里贴出聚合检查 `CI required`
     的 run URL。只跑 workflow_dispatch、或只在 release 分支 push 上变绿，都不算（见 #303）。
     English: every PR needs one run triggered by pull_request; paste the `CI required` run URL.
     A hand-dispatched run or a green push run on a release branch does not count.

     gh run list --branch <branch> --workflow ci.yml --event pull_request --limit 1
     gh run view <run-id> --json url,event,conclusion --jq '"\(.url) \(.event) \(.conclusion)"'

     Fork 贡献者（#150）有两条可验证路径：(a) 直接向上游仓库开 PR，由上游触发 pull_request run
     （首次可能停在 action_required，需维护者批准）；(b) 在 fork 内从 feature 分支向 fork 的默认
     分支开 PR（事件同样是 pull_request），贴那次 run URL 并注明它是 fork 内 run。
     仅手工 workflow_dispatch 或仅 push 事件仍不算数。
     English: fork contributors (#150) have two verifiable paths: (a) open the PR upstream so the
     repository triggers the pull_request run (a first run may wait for `action_required` approval);
     or (b) open a PR inside the fork from the feature branch to its default branch, which is also a
     `pull_request` event — paste that URL and mark it as the fork run. A hand-dispatched or
     push-only run still does not count. -->

- [ ] 本 PR 有一次 `pull_request` 事件触发的 `CI required` run，且已把该 run 的 URL 贴到下方代码块
- [ ] `npm run verify` 的实际输出（或 `DSH_OPS_REQUIRE_RUNTIME=1 npm run verify`）
- [ ] 撤掉本次实现后，相关检查会变红（行为级红绿，而非只看代码结构）
- [ ] `docs/CHANGELOG.md` 的 `## [Unreleased]` 已加条目（行为或发行物文档有变化时；若判定不需要，在 Validation 段写明理由）
- [ ] 行为变化已同步相关 docs
- [ ] 未新增依赖，未改 `package.json` 的版本与 `optionalDependencies`
- [ ] 改了面向模型的描述或参数时：说明它对 schema / 提示词字节的影响，并同步受影响的文档

```
$ <命令>
<输出>

$ gh run view <run-id> --json url,event,conclusion --jq '"\(.url) \(.event) \(.conclusion)"'
<CI required 的 run URL，event 必须是 pull_request>
```

## Environment

<!-- OS 与架构、Node 版本、所基于的上游 main commit、安装通道（registry / 本地 tarball）。 -->
