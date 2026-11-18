# 故事资料 v1：使用、复现与扩展

## 1.1 更新：故事时间与人物经历（2026-11-11）

当前契约已增加人物重要程度／叙事身份、时间轴坐标与区间、相对偏移、同时／重叠关系和同属性状态前序校验，详见 [1.1 使用与迁移说明](story-time-v1.1.md)。下方关于缺失字段和“不迁移”的叙述保留为此前 v1 交付记录。

书级故事资料新增「故事发生顺序」和「人物经历」，与正文阅读顺序分开。时间视图默认只读已确认资料；样例书当前全部为候选，须勾选「包括候选（供作者审阅）」才显示其事件。人物经历按参照事件的之前／之后查询，分别显示确定适用、不确定和潜在冲突。编辑台材料选择可按人物和事件绑定认知上下文；只注入已确认且时间条件可判定适用的本人认知。

样例书已备份并迁移至 1.1，保留 390 条资料、全部原正文与历史；按作者单独批准追加 1 条候选修订，移除衣着状态指向拘束状态的错误前序。没有新增模型分析、推定日期或人物身份，也未确认任何候选。日常 App 保存编辑后重启加载源码链接；本轮没有强制退出 App 或重新打包 DMG。

## 此前 v1 交付记录

字段含义与边界见 [数据契约](story-data-contract-v1.md)，完整合成输入见 [example-batch.json](../contracts/story-data/example-batch.json)。这次扩展现有 `lg-books` 和 `lg-dashboard`，没有新增 Agent 插件或修改 Runtime。

## 在界面中查看

在 Bookshelf 打开一本书，其概览下方新增「故事资料」。按实体档案、世界设定、场景、事件、状态、关系、人物认知、读者揭示、情节线、规划、侧写、分析和作者要求分类；支持搜索、关联对象、正文截止范围与分页。展开记录可看类型字段、适用范围、故事时间、原文段落和修订历史，点击关联名称可定位对应记录。

「已登记来源」统计登记过的来源章节，不表示提取完整或没有错误。默认作者视图展示候选；「文本呈现」「人物说法」「分析推测」与采用状态分开。没有作者输入的规划／要求模块为空，这是预期行为。

正文截止范围是“截至哪些正文位置已经呈现”，不是世界时间查询。例如倒叙中的幼年经历仍可在后面的章节首次被读者得知。v1 不自动构造一条绝对时间线，也不把多条状态自动压成唯一“当前人物状态”。

日常 App 使用仓库源码链接时，重新启动后读取新的 Host 模块和 `client.js`。本次验收使用真实 DSH 源码 CLI、独立无凭据 profile、主项目插件与实际样例书；没有重新打包 DMG 或修改日常 profile。

## 服务接口

现有已认证 Books API 增加两个只读动作：

```json
{"action":"story-data","path":"/absolute/path/to/registered-book","options":{"type":"knowledge","through_chapter":20,"limit":8,"offset":0,"sort":"recommended"}}
```

```json
{"action":"story-data-history","path":"/absolute/path/to/registered-book","id":"record-id"}
```

`options` 还支持 query、subject、id；limit 为 1–200。作品必须已登记。受限查询的 audience 可以是 reader 或 character，后者还需 holder；两者都必须指定 through_chapter，只返回已确认、来源有效且显式依赖未变的对应记录，章节目录也截断。这是数据视图，不是认证机制：未来 Agent 工具必须从可信任务绑定身份、章节及权限，不能接受模型自报权限。

### 资料列表与排序（2026-11-11）

Dashboard 每页 8 条、一次展开一条。全部及非实体分类默认按来源章节 → 场景顺序（如有）→ 段落排列；同位置按固定类别、标题和 ID 稳定排序。列表按来源章节分组，无法定位的记录放在末尾，不把编辑时间当作故事时间。分析记录使用现有 summary 的前 56 个字符作为列表标题，类别／分析维度和来源位置另列；同章节同内容的记录用稳定序号区分，原始 title、全文与历史不改写，也不自动合并疑似重复条目。

人物与实体默认分为人物、势力、地点、物品、概念，同类按关联记录数降序，再按来源位置和名称排序。每一条非 rejected/withdrawn 的可见记录对一个实体最多计数一次，重复链接不重复计数；计数限制在所选阅读范围，搜索和实体筛选不改变统计口径。它统计结构化记录引用，不是正文词频、真实首次出场或文学重要性；重复实体和过量提取会影响排序。界面明确提示“重要级别尚未登记”，不自动贴主角／配角标签。

查询可选 `sort=recommended|source|name`，`references` 仅限实体；`entity_kind=character|group|place|object|concept` 仅限 `type=entity`。排序在分页前对完整筛选结果执行，返回 offset 会收敛到有效的末页；切换分类、筛选或作品重置页码。只读响应新增 `display`（title/category/facet/source/source_chapters/related_count/entity_kind），不属于写入契约，不得回填为 record 字段。来源章节顺序依据当前目录；场景来源沿父级找到章节。原有受限视图先筛选记录，再产生显示目录及计数。

### 分析 Agent 目前可补与仍缺的内容

| 信息 | 当前存储情况 | 后续要求 |
| --- | --- | --- |
| 可辨认的短标题 | 已有 title、summary | title 写具体对象／变化／判断，例如“来信揭示父亲仍可能生还”；不要只写“本章概括”。summary 一条一个判断。 |
| 正文发生／揭示位置 | 已有 evidence 的文档、版本和段落；章节序号由目录获得 | 引用准确的章节与段落；跨章判断保留多处证据。最早引文仅为本条记录的最早来源，不能冒充人物首次出场。 |
| 稳定实体身份 | 已有 id、name、aliases 与类型化引用 | 同一人物复用 ID、别名写 aliases；不要每章新建同名人物。当前不自动归并旧条目。 |
| 文学重要级别及排序依据 | **v1 没有** | 后续契约增加 importance：等级（核心／主要／次要／背景／未知）、同级次序、理由、证据、评估章节范围；身份角色（主角／对手等）另列，不混为重要性。未评估必须为未知。 |
| 故事时间的全局顺序 | 只有文字 label、事件边界与 before 关系，**没有完整可比较时间轴** | 当前可补明确的 before 和时间边界，区分倒叙与揭示顺序；未来需要时间轴 ID、发生区间或相对序号、不确定性和证据。只有局部先后依据时不得编造总顺序。 |

缺失字段需先升级 Schema、导入校验和旧数据读取／迁移规则，再让 Agent 按新版输出；v1 会拒绝随意增加 importance 等字段。本次不迁移数据库、不重新分析、不自动采用候选，不延续任何旧模型额度。

`src/story-data/store.js` 的 `importStoryData` 是内部事务入口，输入格式见数据契约。`decideStoryRecord` 是内部作者决定入口，需要作品、作者、理由、预期修订与操作 ID。两者均未作为新 HTTP 写入动作或模型工具开放。当前 Dashboard 仅阅读这批资料，不提供自动确认按钮。

## 实验脚本

脚本是开发实验入口，不是自动分析 Agent。需要 Python 的 certifi、PyYAML，以及项目固定的 Node 与现有插件依赖。API Key 或 DSH 官方账号凭据仅在内存中使用，固定官方推理域，禁止重定向，不写入输出。

先建立 SQLite 一致性备份和 manifest 副本，在 LitIsLand 隔离目录工作。以下命令默认只做离线预检与契约冻结，不调用模型：

```bash
LG_STORY_NODE="$PWD/.dsh-dev/node/bin/node"
python3 scripts/story-data-experiment.py --root "$PWD" --book /absolute/path/to/isolated-book --artifacts /absolute/path/to/private-experiment --node "$LG_STORY_NODE" --model deepseek-v4-pro --prompt-file scripts/story-data-prompt-v4.txt --transport source-paragraphs
```

只有获得本轮模型预算授权后才添加 `--execute`。本次授权为 10 CNY，脚本共用一个持久化账本：请求前按 UTF-8 字节上界、输出上限及双倍峰值价格预留；成功后按响应 usage 和峰值未命中价格保守结算，缓存折扣不用于扩大预算。缺少用量或未知网络结果保留预留额并停止。预算不足不发请求。

相同请求已有响应时只复用本地响应，不重复请求；不同请求不能冒用旧响应。每章最多一次自动格式补修；两次不通过则停下分析。原始请求、响应、无效批次和修正日志均保留。`accepted-batch.json` 仅表示通过导入校验，记录的 approval 仍是 candidate，绝不表示作者采纳。

在 `source-paragraphs` 传输协议中，模型选择段落序号，宿主按当前正文版本保存完整原文；本轮段落最长 197 字。超过契约 500 字上限的段落会失败，脚本不会静默截断。模型输出时间标签、可选事件锚点与 all_time，宿主确定 all/unknown/relative/interval，随后执行同一存储契约校验。段落存在不代表它充分支撑结论，语义仍需审读。

将已校验批次发布到指定实验书：

```bash
python3 scripts/publish-story-data-experiment.py --root "$PWD" --book /absolute/path/to/experiment-book --artifacts /absolute/path/to/private-experiment --node "$LG_STORY_NODE" --through 20
```

发布程序先保留数据库／manifest 备份，再逐批导入候选，保留原始实验文件与发布回执，检查原有数据表的行数和内容摘要、SQLite 完整性。档案在本书 `.literarygiant/experiments/story-data-20261111/`。失败批次不会部分写入；已成功批次保留并可幂等重放。

本次费用额度不会因脚本存在而自动延续到未来实验。不要把作品、响应、凭据或本机实验目录加入代码仓库。

## 修改数据与契约

- 纠正文句或判断：同一个 record ID，带 expected_revision 追加修订。
- 人物在剧情中发生新变化：创建另一条时间适用的记录，关联触发事件／此前状态。
- 确认或拒绝候选：作者决定另记一条修订，保留历史；新候选不覆盖旧确认。
- 新字段／类型：新增契约版本、显式迁移及回归，再在书的隔离备份上迁移。当前未知版本会拒绝读取或写入，不猜测转换。
- 数据回退：保留候选与备份；若需恢复旧库，先核对其间是否有作者其他写入，不能直接覆盖新工作。停止显示新模块不需要删除正文或旧状态表。

## 验证

```bash
.dsh-dev/node/bin/node --test dsh-plugins/lg-books/tests/*.test.mjs dsh-plugins/lg-dashboard/tests/*.test.mjs
.dsh-dev/node/bin/node dsh-plugins/scripts/build.mjs lg-dashboard
```

回归覆盖结构、来源版本、伪造引用、同书关联、事件顺序、作者边界、幂等与冲突、事务回滚、历史、依赖变更和受限目录。合成用例只证明机制；样例小说实验只提供提取结果与可审阅缺陷，不替代作者文学验收。
