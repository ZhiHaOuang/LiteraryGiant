# LG 文学协作实验插件

第一版仅验证 DSH 主 Agent 委派一名文学分析成员。主 Agent 继续负责与作者交流；成员只读一个固定章节快照，输出带版本、段落引文和判断类型的候选分析。与旧 lg-agents、lg-director、Dashboard 无运行依赖。

当前为实验原型，不在桌面默认 profile 中启用。首次真实团队实验失败；修复后的读章接口通过真实定点测试，完整团队修正版尚未通过真实模型验收。详细结果和上游补丁见 [实验记录](../../experiments/literary-team-v1/README.md)。

## 输入与输出

`snapshotPath` 指定由宿主预先生成的 `lg.analysis-input.v1` JSON，包含 bookId、chapter、version、title、paragraphs 和 SHA-256。只有这个快照进入成员上下文，模型不能传入任意文件路径。快照只是已选版本的副本；源章节后来修改时，须重新生成快照，本插件不自动跟随。

`lg_read_chapter` 读取选定章节；`lg_read_analysis` 读取本会话团队保存的完整候选。任务成功必须提交 `lg.analysis-candidate.v1`，逐条区分 observation / inference，并提供在相应段落中确实存在的逐字引文。宿主校验引用存在性，不判断引文是否充分支持结论，也不能证明模型完全没有使用预训练知识。

候选保存在隔离工作区 `.agent-teams/literary-analysis/team.json` 的任务输出中；导出的 candidate.json 是实验材料，不是作品的正式设定。没有正文、数据库或 Canonical 写入工具。

## 执行限制

依赖固定 AgentTeams 0.1.29 加本地适配，以及 DSH 0.2.2-rc.1 的 `deliverHostMessage` 补丁。仅支持名为 `literary-analysis-v1` 的一个分析成员／一个任务的预设。完整配置由实验 profile 提供，插件同时用工具执行 guard 限制成员能力；不能只靠提示词。

委派成功后通过 `concludesTurn` 结束主 Agent 当前轮次，由成员回报唤醒；结果未完成时也结束轮次，避免查询循环。阅读报告后仍由作者判断是否有用。

重新分派、归档、成员增删及嵌套委派未开放。当前上游适配缺少定向清退能力，不能宣称完整 AgentTeams 兼容。角色扮演、规划、创作、多书切换、跨进程恢复和 UI 待后续小实验。

真实调用预算由实验 probe 统一拦截，覆盖主 Agent、成员及附带请求；它是实验组合的一部分，不是本插件独立的计费系统。部署时不能省略预算组件后仍声称有相同限制。
