# 修订影响

在 DSH 侧栏的「修订影响」选择已登记作品、来源文档和版本，点击「查询引用」。所有版本模式还会列出只登记文档的时间线、伏笔和场景卡输入。作者可以据此返回故事记忆、规划或编辑台核对对应记录。

插件通过 `literaryBooks.readState` 查询作品。Host 服务为 `literaryImpact`，网页接口为 `POST /api/lg/impact`。操作包括 `documents(path, query, offset)`、`versions(path, document, offset)` 和 `inspect(path, document, version, offset)`。版本参数使用作品数据库的版本 ID，传入 null 查询所有版本。每页最多 50 项。

查询读取事实与提案的来源、版本的编辑依据、原生生成和上下文收据、场景计划和正文审阅。创作方向与认知的正式选择交给已启用的 lg-planning 和 lg-memory 校验。旧 LG 生成收据支持 read_document、render_story_context 和 story_source_document 的文档内容或选段，先验证历史输出摘要及引用版本归属。旧收据里的索引、其他来源类型以及缺少输入记录的版本分别计数。插件报告直接登记的引用，文学上的连带影响仍由作者判断。

每种查询扫描最多 5000 行，累计扫描预算为 16 MiB，单条元数据最多 1 MiB。达到上限时页面提示覆盖不全。应用使用项目本机的 Node 和 DSH 插件打包命令。插件依赖 lg-books，查询只读且无需模型。回归夹具由旧 LG 的 make_observation、make_receipt 和 version_metadata 在合成数据上生成。
