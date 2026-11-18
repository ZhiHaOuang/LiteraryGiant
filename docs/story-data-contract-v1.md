# 书级故事数据契约 v1

本文保留 `1.0.0` 的历史定义。当前新增字段、时间查询、人物身份及迁移方式见 [故事时间与人物历程 1.1](story-time-v1.1.md)；旧记录不自动改写为新版。

本契约用于一本书内部的世界设定、事件、状态、认知、信息揭示、人物侧写、规划与文学分析。结构版本为 `1.0.0`。冻结机器规范为 [contract-v1.json](../dsh-plugins/lg-books/src/story-data/contract-v1.json)，逻辑校验在 [validate.js](../dsh-plugins/lg-books/src/story-data/validate.js)。本契约与 Agent、模型和 Dashboard 的实现独立。

一条记录表达一个可辨认的对象、变化或判断。名称和分类用短语；行动、原因、结果、认知和评价用完整句子；多个步骤用句子数组；关联用稳定 ID。未知信息保留未知，不用模型常识补齐。空数组表示本次未登记，不表示世界里不存在。

## 信息含义

世界规则描述作者或正文主张的世界状态；人物认知描述某个人相信、怀疑或否认什么；读者揭示描述正文曾呈现什么；规划描述作者准备怎样写。确认人物的误解不会使误解成为世界事实；选定规划不会创建实际事件。一个已确认的侧写仍是侧写，不是限制人物行为的规则。

`basis=text` 表示文本明确呈现，不保证不可靠叙述者说的都是世界真相。人物对白或传闻用 `character_statement`；动机、性格、情绪效果等解释用 `inference`；只有明确作者输入可用 `author`。模型导入不允许 `author`，也不能生成 `plan` 或 `requirement`。对正文逆向总结的情节结构应写为 `analysis`，不能伪称作者计划。

## 公共记录格式

所有下列字段必填。JSON Schema 拒绝未声明字段，新增字段须升级契约；自由标签仅用于说明，不能代替对象引用。

| 字段 | 格式与用途 |
| --- | --- |
| schema_version | 固定字符串 `1.0.0`；每一修订保留自身结构版本 |
| id | 1–120 位稳定 ASCII ID，字母开头，允许数字、冒号、下划线与连字符；名字改变不改变 ID |
| type | 下文 13 种类型之一，不允许更新时变更类型 |
| title | 1–100 字符的短标题 |
| summary | 1–800 字符的完整句子，概括本条，不堆叠整章摘要 |
| basis | text / character_statement / inference / author |
| scope | `{kind,description,targets}`；kind 为 book/chapter/scene/entity/region，targets 是关联记录 ID 数组 |
| story_time | `{kind,label,after_event,before_event}`，见时间规则 |
| evidence | 至多 16 个原文引用；非作者记录至少一个 |
| author_note | 作者依据，非作者记录填空字符串；作者记录必须非空，至多 800 字符 |
| links | 至多 24 条 `{relation,target,explanation}`；target 必须存在；explanation 至多 300 字符 |
| payload | 对应类型的受校验字段，见字段表 |

长度按 JSON Schema 的 Unicode 字符语义校验。数字 ID 用整数，不传数字字符串。没有可用引用的字段用 `null`，不能传“未知”或空字符串冒充 ID。

引用格式为 `{document_id,version_id,sha256,paragraph,quote}`。前两项引用本书正文版本；sha256 对完整正文 UTF-8 内容计算；paragraph 是按换行拆分、trim 并去除空行后的 1 起始序号；quote 是该段中逐字存在的 4–500 字符。引用校验只证明位置和字符串存在，不证明结论得到充分支持。引用不因章节重排而自动换成新版本。

links.relation 为 before、causes、enables、obstructs、supports、contradicts、reveals、pays_off、part_of、motivates。before 仅用于事件之间，必须无环；因果、动机和评价关系允许为推测。引用必须同书，不接受另一书的 ID。

## 时间与修订

故事时间、正文位置和编辑修订分开。`story_time.kind`：

- all：声明在适用范围内持续成立；不是“未来不许修改”。两个事件边界均为 null。
- unknown：时间未确定；两个边界均为 null，不按全时期处理。
- relative：至少提供一个事件边界，表示该事件以后或以前。
- interval：两端均引用事件，采用开始事件之后至结束事件之前的区间；边界事件自身的细部先后由 label 说明，不能猜测。

时间 label 是至多 200 字符的原文或说明，不是程序可比较的日期。v1 保存相对时间与区间，不自动把含糊的日历、倒叙和未知时间合成为一条总排序。Dashboard 的“读到第几章”筛选依据正文来源位置，不能冒充故事时间查询。

人物受伤再康复：创建两条不同时间适用的状态，关联触发事件。作者把左臂纠正为右臂：为原记录追加修订，不制造新事件。人物经历由事件参与关系得到；人物档案、认知和侧写共享实体 ID。

## 类型与字段

下面的详细字段表由同一契约生成。所有字段都必填；数组可以为空。每个类型可以按实际内容缺省为零条，尤其没有作者输入时规划和作者要求应为空。不要为了填满 Dashboard 伪造记录。

### 实体档案 `entity`

| 字段 | 格式 |
| --- | --- |
| entity_kind | character / group / place / object / concept |
| name | 短语或名称，不拼接多个无关信息。 长度 1–80 字符 |
| aliases | 数组（最多 20 项），每项：短语或名称，不拼接多个无关信息。 长度 1–80 字符 |
| description | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–800 字符 |

### 世界设定 `world_rule`

| 字段 | 格式 |
| --- | --- |
| statement | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| domain | 短语或名称，不拼接多个无关信息。 长度 1–80 字符 |
| conditions | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| exceptions | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |

### 场景 `scene`

| 字段 | 格式 |
| --- | --- |
| pov | 记录 ID 或 null |
| narrator | 短语或名称，不拼接多个无关信息。 长度 1–80 字符 |
| location | 记录 ID 或 null |
| participants | 数组（最多 20 项），每项：记录 ID |
| purpose | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| opening | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| ending | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |

### 事件 `event`

| 字段 | 格式 |
| --- | --- |
| actors | 数组（最多 20 项），每项：记录 ID |
| location | 记录 ID 或 null |
| action | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| outcome | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| motivation | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 0–600 字符 |
| scene | 记录 ID 或 null |

### 人物与物品状态 `state`

| 字段 | 格式 |
| --- | --- |
| subject | 记录 ID |
| facet | 短语或名称，不拼接多个无关信息。 长度 1–80 字符 |
| value | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| previous_record | 记录 ID 或 null |
| trigger_event | 记录 ID 或 null |

### 关系变化 `relation`

| 字段 | 格式 |
| --- | --- |
| subject | 记录 ID |
| object | 记录 ID |
| relation | 短语或名称，不拼接多个无关信息。 长度 1–80 字符 |
| description | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| trigger_event | 记录 ID 或 null |

### 人物认知 `knowledge`

| 字段 | 格式 |
| --- | --- |
| holder | 记录 ID |
| proposition | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| stance | believes / doubts / denies / uncertain |
| acquired_by | experience / told / read / inference / unknown |
| trigger_event | 记录 ID 或 null |

### 读者信息揭示 `revelation`

| 字段 | 格式 |
| --- | --- |
| proposition | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| presentation | narration / statement / hint / correction / reveal |
| speaker | 记录 ID 或 null |
| about_record | 记录 ID 或 null |

### 情节线与伏笔 `thread`

| 字段 | 格式 |
| --- | --- |
| question | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| thread_kind | conflict / mystery / foreshadowing / relationship / goal |
| progress | possible / open / resolved / abandoned |
| setup_records | 数组（最多 20 项），每项：记录 ID |
| planned_payoff | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 0–600 字符 |
| actual_payoff | 数组（最多 20 项），每项：记录 ID |

### 创作规划 `plan`

| 字段 | 格式 |
| --- | --- |
| level | book / arc / chapter / scene |
| parent | 记录 ID 或 null |
| objective | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| steps | 数组（最多 30 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| expected_changes | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| constraints | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| reveal | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| withhold | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| selection | option / selected / cancelled |
| realized_events | 数组（最多 20 项），每项：记录 ID |

### 人物侧写 `portrait`

| 字段 | 格式 |
| --- | --- |
| subject | 记录 ID |
| aspect | desire / value / fear / behavior / voice / contradiction / growth |
| description | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| counterevidence | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 0–600 字符 |

### 分析与概括 `analysis`

| 字段 | 格式 |
| --- | --- |
| dimension | summary / rhythm / emotion / style / theme / logic |
| assessment | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–1600 字符 |
| limitations | 数组（最多 12 项），每项：完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–240 字符 |
| about | 数组（最多 20 项），每项：记录 ID |

### 作者要求 `requirement`

| 字段 | 格式 |
| --- | --- |
| category | style / viewpoint / constraint / preference |
| instruction | 完整中文句子，说明一个明确判断；不写 Markdown 标题。 长度 1–600 字符 |
| strength | must / prefer |
| targets | 数组（最多 20 项），每项：记录 ID |

## 人物侧写与信息揭示

侧写一条记录只描述一个 aspect，并结合场景解释倾向。反例用 counterevidence 保存；没有反例可填空字符串，不能编造。性格不采用固定 MBTI 或强制数值量表。多个欲望、恐惧、行为模式分别成记录，可拥有不同依据与时间。

知识 stance 表示人物态度，不能用“系统判断世界真实”的标签替代。读者揭示 presentation 区分旁白、人物说法、暗示、纠正和揭晓；本系统不声称每个真实读者都已经理解或相信了它。未登记人物认知不代表人物不知道。

伏笔 progress=possible 表示分析者怀疑有后续作用；open 表示有明确未解决的问题；resolved 必须引用实际回收记录；planned_payoff 只是计划说明。正文提取不能利用原著后文记忆补写回收或作者意图。

## 存储与状态

每书沿用 `.literarygiant/story.sqlite3`。正文继续由 documents/document_versions 保存。新增 lg_story_data_records（稳定身份和候选／确认头）、lg_story_data_revisions（不可变修订）、lg_story_data_runs（方法与覆盖来源）、lg_story_data_operations（幂等回执）、lg_story_data_meta（契约版本及摘要）。不修改旧事实、认知或正文表，不把新结果自动并入旧 Canonical。

每条修订有独立 revision ID、previous ID、run ID、内容摘要、关联内容摘要与创建时间。模型写入的 approval 始终为 candidate。作者操作可以生成 confirmed/rejected/withdrawn 修订；作者、理由和操作 ID 留痕。新增候选或拒绝候选不会覆盖以前确认的版本；withdrawn 撤回当前确认。确认只改变编辑状态，不改变内容类型。

freshness 是查询时计算的 current/stale/unavailable/invalid，分别表示来源仍有效、当前正文版本变化、来源不存在、摘要或引文损坏。related_changed 显示引用记录内容改变或被撤回；仅确认状态变化不视为内容改变。该机制覆盖显式关联，不能保证发现全部隐含文学影响。

查询返回记录、候选／确认状态、来源有效性和关联变化。作者视图可查看所有候选；人物与读者视图仅返回已确认且当前有效的对应认知／揭示记录，并要求正文截止范围。它们目前是有依据的记录历史，不是完整角色模拟器；工具权限与会话隔离须在后续 Agent 接入时另行绑定，不能靠调用方自报 audience 保证授权。

Dashboard 查询附带的 `display` 是只读展示元数据（标题片段、来源位置、关联计数等），不写回修订，不属于上面的公共记录格式。v1 没有文学重要级别、主配角身份或完整可比较的故事时间轴；实体关联计数不替代这些信息。展示排序与下一版字段建议见 [使用说明](story-data-operations.md#资料列表与排序2026-11-11)。

## 批量写入契约

`lg.story-data.batch.v1` 包含 contract_hash、book_id、branch（v1 仅 main）、operation、run、coverage 和 records。records 每项为 `{expected_revision,record}`；首次创建 expected_revision=null，更新必须给出读取时的 revision。单次至多 1500 条／8 MB。

run 至少包含 id、producer（model/author）、method；模型实验还登记模型名、提示词摘要与原始响应位置。coverage 每项为 `{document_id,version_id,sha256,status,note}`，status 为 complete/partial/missing；模型至少有一项覆盖。complete 指已提供并处理该章文本，不保证事实无遗漏。缺失正文独立标记，不插造事件。

同一 operation 携带相同内容重放，返回原回执；不同内容复用 ID 被拒绝。本批所有来源、关联和版本在同一事务中核对，任何一条失败则整批回滚。模型输出校验失败会保留原响应，不静默丢弃错误记录后声称全量成功。

## 扩展与迁移

未知类型和结构版本拒绝写入。新增字段或类型时先新增版本契约、迁移程序和旧数据读取测试；先在隔离副本备份、迁移、核对，再迁移作品。现阶段不自动跨版本迁移，也不支持多分支合并。运行产物和 Dashboard 展示不作为另一份可独立编辑的正式状态。

## 首轮正文整理与验收

先冻结 Schema、程序校验、字段说明和提取提示词，再处理实验书前 20 章。按章保留输入版本、响应、用量和校验结果；跨章传递有限实体目录，后文不能进入前文输入。所有提取结果保存为候选；用户可以在 Dashboard 按模块、章节、实体、来源与状态审阅。

没有作者规划的类别允许为空。数据结构通过、引文通过、人工语义审阅是三种不同证据。最终报告分别记录覆盖率、无效记录、遗漏与错误样例、实际用量及后续分析 Agent 应改进的提示词。

完整的合成样例批次位于 `contracts/story-data/example-batch.json`，覆盖全部 13 类；这些内容只用于契约验证，不是文学质量证据。
