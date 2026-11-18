# Dashboard 资料读取与样例整理

2026-11-12。本次延续故事资料 1.1，补齐稳定读取层、覆盖提示和书级快照，不改变 Runtime，也不新增 Agent。结构化记录契约与界面读取契约分开版本化。

## Dashboard 实际需要什么

人物、情节、环境三板块已能容纳当前资料类型。主要缺口是资料完整性、身份连续性和解释可信度，不需要继续堆叠新的顶层栏目。

| 使用问题 | 现有能力与本次补齐 | 仍然有限的部分 |
| --- | --- | --- |
| 这是谁，在故事中有什么作用？ | 稳定实体 ID、别名、人物简介、侧写、重要程度与叙事身份；阶段评级单独显示 | 同名档案仅提示，不能自动确认合并；阶段身份不等于全书身份 |
| 他经历了什么，当时知道什么？ | 参与事件、认知主题、同属性状态链、事件前后投影和不确定项 | 没有明确有效期不能自动推定永久状态；人物说法不能当作世界事实 |
| 事件怎样推进，是否用到伏笔？ | 事件偏序、章节概括、线索及回收关系、叙事分析 | 现有记录不是穷尽提取；线索回收需原文支持，文学质量仍需人工评阅 |
| 世界设定有没有向读者揭露？ | 世界规则、地点、场景、其他实体、显式揭露关联 | 缺少揭露标记只能放入待核对；不能把资料存在等同读者知道 |
| 当前展示值不值得信任？ | 来源版本、段落引文、推测／陈述类型、候选／确认、修订历史、来源与依赖变化提示 | 引文校验只验证出处，不能证明解释正确 |
| 数据到底整理到哪里了？ | 新增已登记章节／全章数、候选／确认数、未定位事件、未知状态时间、缺失评级与重复档案提示 | “已登记来源”不代表该章完整提取；不把空白解释为不存在 |
| 以后更换界面会不会读不出？ | 固定读取版本、JSON Schema、集中适配器、独立快照校验、分页和回归测试 | 未来破坏性变化仍须新版本与迁移，不能承诺任何改动都自动兼容 |

优先保留这三板块和覆盖提示。章节阅读、写作会话、候选采纳继续由已有工作台承担；无需把原始聊天、编辑操作或自动文学评分都塞入 Dashboard。下一步有价值的是按待核对项定位记录、人工处理重复身份，以及扩大有证据的覆盖范围。

## 书内结构与权威边界

```text
<book>/
  manuscript/chapters/                 # 现有正文文件，不因本次整理改写
  .literarygiant/
    project.json                      # 稳定作品标识
    story.sqlite3                     # 权威正文版本、资料头版本与修订历史
  notes/story-data/
    README.md
    CURRENT.json                      # 当前完整快照指针；原子替换
    snapshots/<snapshot_id>/          # 不覆盖的内容寻址快照
      manifest.json                   # 版本、作品 ID、数据摘要、文件摘要
      overview.json                   # 覆盖与质量诊断
      records.json                    # 全部记录与证据、审批、依赖状态
      timeline.json                   # 部分顺序与时间查询资料
      sections/
        people.json                   # 记录 ID 索引，不复制权威内容
        plot.json
        world.json
    reviews/<operation>/
      batch.json                      # 本次候选导入批次与预期头版本
      review.json                     # 逐项变更原因与保留的未知
      receipt.json                    # 实际导入回执
      verification.json               # 数据保留及语义边界检查
```

数据库是唯一写入权威。快照是可重建的读取制品，不会监视并自动导回；手工修改 JSON 不会改变正式故事。`records.json` 保留稳定 ID、`revision`、`confirmed_revision`、`approval`、`basis`、`scope`、`story_time`、`payload`、`evidence`、`freshness` 和 `related_changed`。聊天、旧 notes 和其他书保持原位置，不增加第二套需要手工同步的事实库。

本次导出是作者侧完整视图，包含候选资料。它不能直接用作人物受限上下文；受限任务继续经过 `lg-context` 的信息边界。

## 固定读取接口

服务入口为 `lg-books` 的 `literaryBooks.storyOverview / storyData / storyTime`；HTTP 为 `POST /api/lg/books`。路径必须是该服务登记的作品。Dashboard 统一通过 `lg-dashboard/src/story-read.js` 读取并检查响应版本，版本不符直接提示，不静默显示空数据。

```json
{
  "action": "story-overview",
  "path": "/absolute/book",
  "options": { "through_chapter": 20, "confirmed_only": false }
}
```

HTTP 外层仍为 `{ "ok": true, "value": ... }`，失败为 `{ "ok": false, "error": ... }`；下表字段位于 `value`。

| action | 主要结果 | 范围与分页 |
| --- | --- | --- |
| `story-overview` | `counts / entities / chapters / total / coverage / quality / capabilities / limits` | 仅接受 `through_chapter / confirmed_only`；作者侧默认含候选 |
| `story-data` | `records / directory / entities / catalog / counts / total / offset / limit / chapters / runs` | 沿用类型、主体、搜索、排序和阅读截止过滤；分页最大 200；`total` 为当前过滤结果 |
| `story-time` | `records / events / timeline / character / chapters / entities / directory` | 沿用事件、人物、前后时点；默认不含候选，作者 UI 明确勾选候选 |
| `story-data-history` | 修订数组，包含历史记录及审批 | 保持旧接口；按稳定记录 ID 查询，不放入新的三类响应封套 |

前三类响应都有：

- `api_version: "lg.story-data.read.v1"`：读取契约版本，与记录 `schema_version: "1.1.0"` 独立。
- `book_id`：稳定作品 ID，文件夹改名不改变身份。
- `data_revision`：作品资料头、确认头和正文元数据／当前内容的摘要。它是缓存失效标记，不是故事时间或单条修订 ID。
- `chapters`：正文阅读顺序；不能将该顺序或事件展示分组当作故事发生顺序。

版本 Schema 位于 `dsh-plugins/lg-books/src/story-data/read-api-v1.json`。客户端容忍新增可选字段；删除／更改既有语义须发布新读取版本。分页缓存键应包含 `book_id + api_version + data_revision + 全部查询条件`；若跨页响应的数据版本发生变化，重新开始当前查询，不能拼接两个版本。

`coverage.chapters[].status` 只有 `registered / unreviewed`。场景文件的证据归入所属章节，单条记录在一章内多次引用只计一次。覆盖不是质量分数。`quality` 中的 ID 列表可用于以后增加跳转和过滤；本次 UI 先展示数量与重复名称提示。

概览与导出在同一 SQLite 读取快照内组装，显式限制 5000 条记录／500 个事件；超限返回错误，不给出看似完整的截断快照。当前样例在此范围内。超大作品的增量索引与分段快照属于后续工程，不宣称当前实现已经覆盖百万字全量图谱。

## 导出与离线重读

在仓库根目录使用已配置的 Node 24：

```sh
node dsh-plugins/scripts/export-story-data.mjs --book /absolute/book
node dsh-plugins/scripts/export-story-data.mjs --read /absolute/book/notes/story-data
```

可用 `--expected-revision <data_revision>` 防止导出已变化的数据。离线代码调用 `readStorySnapshot(directory)`，它校验指针、清单、固定文件集合、每个 SHA-256、整包摘要和内部作品／数据版本，不依赖数据库。输出路径不得经过符号链接；发现既有快照被修改会停止并保留原文件。摘要用于完整性检查，不是可信签名。

`snapshot_id` 是整个读取制品的摘要，`data_revision` 是源数据摘要，两者不同。展示代码改变也可能生成新 `snapshot_id`。旧快照保留，同一制品重复导出不增加另一份副本。日常修改数据库后应重新导出；Dashboard 在线读取始终访问实时 API，不会把旧快照误当最新数据库。

## 本轮样例整理范围

仅重新核对样例书已经有资料的第 1—20 章，共 390 条旧记录。新增 21 条（12 条阶段身份、4 个事件、3 个状态、2 条认知），修改 98 条内容，另有 232 条仅刷新已核对的关联版本、原内容不变。结果 411 条，全部候选，未替作者确认任何事实。

- 用自报姓名补全安娜早期档案，提议后续引用使用最早稳定 ID；旧重复实体、原 ID、原修订均保留。人物卡仍显示重复提示，不宣称已完成正式实体合并。
- 纠正外貌比喻被当作别名、人物猜测被当作真实死亡原因、卡尔误解被当作安娜死亡等问题。
- 补充有依据的先后／重叠关系，修正两条反向先后关系以及雨天停工与授课的反向因果。71 个事件、77 条显式时间关系，2 个事件仍未定位。
- 补同属性的衣着、拘束、控火状态链和防备变化；此前批准移除的跨属性错误链接不恢复。卡尔“以为安娜死了 → 亲眼确认仍活着”按人物认知主题记录。
- 角色评级限定前二十章，属于有引文支撑的分析判断。未确定的阵营／叙事功能保持空值；不补全书主配角等级。

仍有 28 条状态的时间类型为未知；具体有效期不能由触发事件或前序链自动补出。没有统一历法与起点，不创建绝对日期、假定年龄或任意时间坐标。复合事件、回述及平行支线的不确定性保留。第 21—100 章未纳入本轮复核；既有节奏、文风等分析也未因此被认证正确。

## 验证与回退

先在 LitIsLand 副本进行整理、来源校验、依赖和时间图检查、Node 回归及真实 React／Cordis 路由验证，再对照文件 SHA 应用最小变更。应用前保留一致性数据库备份；导入使用预期修订检查与事务。正文、正文版本和原资料修订必须保持不变。

源码可恢复本次文件备份；数据优先用追加候选修订撤销某项解释。数据库整体备份仅适用于备份后没有其他新写入的情况，不能用旧库覆盖后来作者的修改。删除快照或重复档案需另行获得具体授权。

本轮隔离及实际项目各 165 项 Node 回归通过，Dashboard 构建通过；实际组件和 Cordis 作品读取路由验证覆盖统计、阶段身份、原文与历史、事件前后、候选过滤、刷新／重载和 390px 深色布局，页面错误为 0。浏览器验证仅替身化 4 个宿主图标，不等同完整日常 Electron 宿主验收。CLI 校验并重读 411 条离线记录。100 个章节文档、195 个正文版本、391 条原资料修订与正文目录文件完整保留；现有 742 条资料修订。没有调用外部文学模型，没有提交或推送。


## 后续界面对齐（2026-11-12）

沿用本接口，未新增数据结构。阶段身份在人物列表显示范围与候选／确认；认知主题、各类前序记录及相对时间锚点已接入。情节内新增“读者揭示”入口，对应既有revelation，分页8条。前端按data_revision处理跨页更新，记录形状不兼容时明确报错，失败概览不保留旧统计。实现集中在story-read.js、story-fields.js、story-record.jsx和story-browser.jsx。

隔离及实际项目各158项相关回归、构建和独立已安装App验证通过；实际样例411条只读复核，任务前后版本摘要不变。详见handoff.md中“故事资料界面对齐新版读取与字段”。现有数据库仍是唯一权威，未重新导出或修改书内快照。
