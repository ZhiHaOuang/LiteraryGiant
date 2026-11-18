# 故事时间与人物历程 1.1

本版在原有书级资料契约上增加可计算的故事时间、人物叙事身份和状态前序检查。正文阅读顺序仍由 `documents.parent_id + sequence` 表达；故事发生顺序由事件约束表达；数据库创建时间和记录修订时间只用于编辑历史。三者不互相替代。

契约文件为 `dsh-plugins/lg-books/src/story-data/contract.json`，冻结旧版为 `contract-v1.json`。记录继续保存在原作品 SQLite 的故事资料表中，无需新增 Runtime 或独立数据库。旧记录不会因为软件升级而自动得到日期、主配角身份或作者确认。

## 数据结构

### 故事时间

保留 `story_time.kind` 的 `all`、`unknown`、`relative`、`interval`，增加 `range`。所有类型仍包含原来的 `label`、`after_event` 和 `before_event` 字段；没有边界时填 `null`。

| 字段 | 含义 |
| --- | --- |
| `range.coordinate.axis` | 时间轴稳定标识，例如 `clock:main`。同一标识必须具有同一约定起点；本版不自动推断起点或转换不同时间轴。 |
| `coordinate.unit` | `minute`、`hour`、`day`；按 60 分钟／小时、24 小时／日换算。非标准历法需要以后单独实现。 |
| `start_min / start_max` | 开始时刻的最小／最大可能坐标；相等表示此坐标已明确。 |
| `end_min / end_max` | 结束时刻的最小／最大可能坐标；检查区间是否仍有可行解释。 |
| `relative.offset.anchor_event` | 同书已登记的锚点事件。 |
| `offset.anchor_point` | 使用锚点事件的 `start` 或 `end`。 |
| `offset.min / offset.max / offset.unit` | 相对于锚点的开始时间偏移，可表达约数及负偏移。偏移只约束开始时间，不凭空生成事件时长。 |

只有 `range` 可以提供 `coordinate`，只有 `relative` 可以提供 `offset`。数值范围为正负十亿；计算还检查有限数值、上下界及事件关系一致性。时间标签保留原文含义，不由程序自动解析为公历、精确小时或年龄。

当前事件的 `offset` 可以传播锚点坐标；状态、关系或认知上的 `offset` 尚不解析为有效区间，人物时点查询将其保留为不确定。

例如“抵达后的第三天上午”可以先保留原文标签；若作者明确约定起点和上午范围，再填写相应坐标。没有足够依据时继续使用 `unknown`，不能为排序便利填入任意日期。

事件关系增加：

- `before`：严格先于。其与事件的 `after_event / before_event` 边界共同参与无环与坐标一致性检查。
- `simultaneous`：事件起止时段相同的强约束，可传递；不是“某一刻碰巧重叠”。
- `overlaps`：事件存在共同时间点或区间，允许端点相接；不要求起止相同，也不能据此确定二者的整体先后。

时间线返回的是偏序。拓扑展示层内的事件可能互不确定，跨层也不意味着任意两个事件都存在先后关系。`groups[].simultaneous` 才表示明确登记的同时关系；`unplaced` 保存尚无法定位的事件。不得把图形坐标、记录 ID 或章节编号当成新的故事证据。

### 人物叙事身份

新增记录类型 `role_assignment`，使用原有来源、审批、时间与作用域字段。其 `payload` 为：

```json
{
  "subject": "person:example",
  "prominence": "core",
  "roles": ["protagonist"]
}
```

`subject` 必须引用人物实体。`prominence` 为 `core / major / supporting / minor / unknown`；`roles` 为 `protagonist / antagonist / mentor / ally / other` 的不重复数组，分别表示主角、对抗者、导师、伙伴或其他叙事身份。重要程度和叙事功能是两个维度，不从出场次数或引用数自动推定。

公共 `scope.kind` 增加 `arc`，允许在故事段范围内登记身份。`scope.targets` 仍是已存在记录的 ID，不是章节文件名。仅有自由文字的范围说明不能保证自动命中某个时点：人物查询无法确定范围包含目标事件时，会把原本适用的记录降为不确定。场景 POV 继续属于场景，不由主角身份推导。

### 人物状态、关系与认知

`state.previous_record` 必须指向同一主体、同一 `facet` 的状态，且前序链无环。不同属性不能串成一条状态链，例如衣着状态不能把拘束状态当成“上一个衣着状态”。已有字符串属性目前按精确值比较，别名归一化需要显式处理。

`relation` 可增加 `previous_record`，前序必须具有相同主体、对象和关系类别。`knowledge` 可增加 `topic` 与 `previous_record`；建立认知前序时，必须使用同一人物和同一稳定主题标识。`topic` 是命题主题键，不是额外实体引用。

前序表示故事中的变化；记录修订表示作者纠错。两者不能混用。候选修订仍不会覆盖此前作者确认的头版本。

`previous_record` 目前用于前序链一致性检查，不自动关闭前条记录的有效期；应登记明确时间边界，否则两条同时适用时仍会作为潜在冲突保留。

人物查询以目标事件的 `before` 或 `after` 为边界：前者表示事件开始之前，后者表示事件结束之后。时间坐标状态采用 `[start,end)` 区间。旧 `interval` 的开始事件之后／结束事件之前也保留明确边界。单独的 `trigger_event` 可说明触发事件刚结束时的变化，但不足以证明此后一直持续。

无法依据 `all`、显式边界／坐标或目标触发事件判定适用的状态保留为不确定。相同主体与属性出现不一致的适用状态时，返回潜在冲突和证据，不采用最后写入者覆盖，也不把人物成长或不同解释直接判为文学错误。

## 查询与上下文

领域函数 `readStoryTime(directory, options)` 位于 `story-data/queries.js`，由 `literaryBooks.storyTime(path, options)` 暴露。作者 HTTP 接口复用 `/api/lg/books`：

```json
{
  "action": "story-time",
  "path": "/absolute/book",
  "options": {
    "subject": "person:example",
    "event": "event:example",
    "phase": "after",
    "through_chapter": 12,
    "include_candidates": false
  }
}
```

`subject`、`event`、`through_chapter` 均可省略；只有人物和事件同时提供才返回人物时点结果。`phase` 默认为 `after`。默认只读取作者确认的当前有效记录；作者审阅界面可明确选择 `include_candidates=true`，必须持续显示候选状态。

返回内容包括 `timeline`、`character`、`entities`、`events`、`records`、`directory`、`chapters`、`revision` 和覆盖说明。`character` 区分 `certain`、`uncertain`、`conflicts`；这里的 certain 指时间条件可判定适用，不保证人物信念是世界真相。来源过期、关联内容改变以及撤回记录不参与计算。查询在同一 SQLite 读事务内取齐分页，最多 5000 条资料、其中最多 500 个事件，超限明确拒绝，需缩小阅读范围。全书写入图校验最多 50000 条记录，并设 2000 万步计算预算；迁移快照对 records、revisions、runs 各表另设 100000 行上限。这些是当前实现的容量边界，不能据此宣称百万字全书查询已经验证。

`through_chapter` 是正文来源的阅读截止位置，不是故事时间。倒叙场景需要同时传入事件位置与阅读范围，不能仅以“第几章”替代人物在当时的经历。

`lg-context` 增加显式 `story` 参数：

```json
{
  "audience": "character",
  "maxBytes": 6000,
  "story": {
    "subject": "person:example",
    "event": "event:example",
    "phase": "before",
    "through_chapter": 12
  }
}
```

人物时点模式不能混入旧整数位置、作者材料或普通文档；它使用同一故事查询服务，只注入已确认、当前有效、时间适用的本人认知。作者模式可获取带明确不确定标记的状态。查询范围和投影摘要进入来源收据，即使结果为空，后续新增确认记录也会使旧收据失效。

这只是上下文装配契约，不是完整安全沙箱；宿主仍需绑定任务身份、工具权限和会话信息边界。旧 `memory.view` 路径保留，不能宣称旧整数认知位置已经自动映射到新事件。

Dashboard 提供正文阅读顺序、故事发生顺序和人物经历视图。候选审阅、未知时间、未定位事件、潜在冲突分别显示；界面不会为可视化补造全书唯一时间线。

2026-11-12 起，人物列表及人物经历的选择器复用已登记的重要等级排序。只有 `scope.kind=book`、`scope.targets=[]` 且 `story_time.kind=all` 的当前有效身份参与全书等级；可见记录中已确认的判断优先于候选，同级再按关联数量。候选评级持续标注。不同全书评级存在冲突时显示待核对；阶段性、时间未知或限定时点的身份仍可展开查看，但不扩展为全书等级。过期、关联变化、拒绝或撤回的身份不用于评级。资料卡可直接打开身份记录的证据和历史，原始状态不改写。

接口支持 `sort=importance`（仅实体），界面默认实体排序采用同一规则，也可切回关联数量或正文顺序。展示元数据增加 `display.character_role`；这是只读投影，不属于导入契约。已有结构不意味着每个人物已有评级：本轮只读核对样例书仍为 390 条记录、0 条 role_assignment，67 个事件中 55 个 story_time.kind=unknown。该书的等级会显示未评级，后续写入有效记录即可直接用于展示，不会自动触发模型补填。

## 兼容、迁移与旧数据修复

1.0.0 与 1.1.0 记录按各自冻结契约验证。旧库可继续读取历史；写入新版内容前，需要显式迁移。迁移只更新故事资料契约元数据和幂等操作回执，保留原正文、记录 ID、全部 payload、修订链、候选／确认状态和头版本。

离线命令从仓库根运行，使用已准备的 Node 24：

```bash
.dsh-dev/node/bin/node dsh-plugins/scripts/migrate-story-time.mjs --book /absolute/book
.dsh-dev/node/bin/node dsh-plugins/scripts/migrate-story-time.mjs --book /absolute/book --apply --token PREVIEW_TOKEN --backup-dir /existing/outside/backup
```

第一条只预览。第二条要求备份目录已存在且位于作品之外，拒绝通过符号链接指向书内的目录。迁移前用 SQLite backup API 保存一致性数据库及 `project.json`，验证备份、原作品与预览 token 相同，再执行迁移。备份不包含配置、凭据或完整聊天。失败产物保留并报告路径；命令不自动恢复或删除文件。

如果旧数据存在跨主体／跨属性前序、循环或时间约束矛盾，预览返回 `issues`，实际迁移停止。旧记录仍可查看，不能通过跳过校验或自动改写 payload 来宣布迁移成功。本轮真实资料预检发现跨属性状态前序；其修订须单独确认具体范围，再追加候选修订，不能把迁移授权当作任意改写剧情的授权。是否修复属于资料判断，旧版读取兼容不等于旧数据已经满足新约束。

修复路径：

1. 核对问题记录及原文，确定它是错误前序、错误属性还是需要拆分的变化。没有依据时保留待判断。
2. 通过原 `lg.story-data.batch.v1` 导入接口，使用冻结的 `legacyContractHash`、原记录的 `schema_version=1.0.0` 和准确 `expected_revision` 提交修订；保留原证据并明确修订来源。同一批修复全部导致校验失败的关联，避免半套状态通过。
3. 导入仍产生候选，不自动确认；历史 payload 保留。若关联记录依赖旧内容摘要，会显示需要复核。
4. 再次预览并备份迁移。作者确认与正式作品采纳继续走各自授权路径。

已迁移作品再以当前 token 运行命令返回 `unchanged`，不重复备份或写入。旧模型提取批次不能借旧哈希写入 1.1.0 字段。

## 生成与验证

`scripts/make_story_data_contract.py` 从原始 1.0.0 定义开始，核验冻结旧文件相等后生成 1.1.0 契约及分类目录；冻结文件存在时绝不覆写，内容不符则先报错。没有旧冻结文件的新测试目录可生成它。

`story-contract-generator.test.mjs` 把生成器复制到独立临时根目录运行，比较当前契约与 catalog 的完整 JSON 和规范化摘要，并验证篡改冻结版本会被拒绝。它不会在运行期间改写项目中的契约。

迁移命令回归覆盖只读预览、一致性备份、正文与全部故事历史保持不变、重复执行、过期 token 以及书内备份拒绝。时间、查询和上下文测试分别验证循环、倒叙、并行、未知、前序与版本失效。合成回归证明执行语义，不代表所有旧数据已迁移或文学质量已验收。
