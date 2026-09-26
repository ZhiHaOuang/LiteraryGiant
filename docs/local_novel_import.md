# 本地 TXT 小说整理流水线

这套入口用于 `/public/home/actueuo6co` 下的杂乱小说集。它不会把批次目录直接交给 hardmodel，也不会直接写入 `Library/TaciturnRaw`。按当前约定，暂存档案根目录是隔离的 `Library/Noise/`。

## 数据结构

```text
Library/Noise/
├── 玄幻/00_id000001_书名_作者.txt
├── 言情/06_id000002_书名_作者.txt
├── 科幻/12_id000003_书名_作者_v2.txt
├── ...                              # 其余固定分类
├── 其他/20_idNNNNNN_*.txt           # 无法可靠分类或需复核的文本
├── 露骨H/21_idNNNNNN_*.txt          # 明确露骨的成人内容
├── index.jsonl                      # 已发布可见版本、稳定 ID、来源和哈希
└── .state/                          # 隐藏的 SQLite、plan、journal 与断点缓存
```

文件名采用 `CC_idNNNNNN_清洗后的书名_作者[_vN].txt`：`CC` 是两位固定
分类码，`idNNNNNN` 是全库六位稳定 ID。作者缺失时统一写成 `佚名`。可见
文件名只保留中文、ASCII 英文字母、数字和英文下划线 `_`；不会出现
书名号、破折号或括号。原书名中的数字或英文缩写会保留。只有书名长到可能超过
Linux 单文件名 255 字节上限时，才附加 8 位 ASCII 摘要，避免截断后重名。

首次建库在分类、去重和版本判定完成后，按“分类码 → 书名拼音 → 作者拼音”
分配 ID。一旦发布，旧书 ID 永不重编；增量新书只从已占用的最大 ID 后追加。
因此“A–Z 排序”由 `index.jsonl` 中持久化的拼音键和行顺序表达，不会为了插入
一本 A 开头的新书而重命名旧文件。文件管理器若按文件名排序，显示的会是稳定 ID
顺序；需要 A–Z 书目时以 `index.jsonl` 为准。

`露骨H` 使用新增稳定分类码 `21`，不会改变既有 `00–20`。明确的肉文/H文/情色等
标题或正文证据会进入该类；历史原始目录 `/public/home/actueuo6co/后宫/` 作为强来源提示，
默认优先归入 `露骨H`，但更明确的下级分类目录仍可覆盖，因此不会无条件吞并全部文件。

同一作品的不同可见版本各自获得稳定 ID，并以 `_v2`、`_v3` 表示版本顺序；
`work_id` 用于关联同一作品。`index.jsonl` 每行只对应一个已成功发布的可见
canonical/edition 版本。重复、残缺候选、拒绝或已删除的来源不会混入公开书目，
它们完整保留在 SQLite、冻结 plan、`review.jsonl` 和最终 audit 中供追溯。

压缩包不会由扫描命令自动解压。对已经确认传输完成的来源，应先使用
`scripts/extract_novel_archives.py`：它先在同盘暂存目录解压，拒绝不安全路径和链接，
并把 `都市言情.zip` 发布为同级的 `都市言情/`；如果包内已经只有一层同名
`都市言情/` wrapper，只剥掉这一层，不会把书散落到压缩包父目录。同名文件按正文
SHA-256 判定（相同则复用、不同则保留冲突副本）。默认 `--verify-mode full` 最终逐文件
复验；批量初整可改用 `--verify-mode sample --sample-files 32`，此时仍全量核对成员数量、
最终路径、文件类型和字节数，但正文只对排序后均匀分布的 32 本做 SHA-256 抽样。两种模式
都只在源文件身份未变化后删除压缩包。空包、只有系统 noise、重复规范化成员路径以及未达到稳定时间的包都会拒绝
并保留；失败的 `.extract-*` 暂存会立即清理。单包失败不会阻断其余包，详情写入 journal/summary。
解压会改变稳定性快照，因此必须发生在 snapshot/scan/plan 之前。

大包应先用 `--archive` 精确 dry-run，默认要求源包至少 600 秒未修改：

```bash
python scripts/extract_novel_archives.py \
  --archive '/public/home/actueuo6co/笔趣阁全站网络小说合集 31w本/都市言情.zip' \
  --run-dir runs/archive-extract-dry \
  --dry-run
```

确认 `dry_run_summary.json` 后，换一个正式 run 目录并去掉 `--dry-run`。整个已完成
目录也可用可重复的 `--source` 递归处理，例如七包并发 dry-run：

```bash
python scripts/extract_novel_archives.py \
  --source '/public/home/actueuo6co/笔趣阁全站网络小说合集 31w本' \
  --run-dir runs/archive-extract-all-dry \
  --workers 7 \
  --dry-run
```

正式初整采用抽样模式：

```bash
python scripts/extract_novel_archives.py \
  --source '/public/home/actueuo6co/笔趣阁全站网络小说合集 31w本' \
  --run-dir runs/archive-extract-all \
  --workers 7 \
  --verify-mode sample \
  --sample-files 32
```

`--workers 7` 表示同时处理七个压缩包；journal 写入会加锁，summary 始终按路径
顺序生成。并发模式不能与 `--fail-fast` 同时使用。EPUB 不在该脚本支持范围内，必须走
下节转换器。

若进程中断但同级 `.extract-压缩包名-*` 仍在，不能直接删包。先用
`scripts/finalize_novel_archive_staging.py --dry-run` 将 ZIP 中央目录与“已发布目录 + 暂存
目录”逐路径、逐大小核对；只有完整匹配并通过分布抽样后，去掉 `--dry-run` 才会接管暂存、
同步磁盘并删除原 ZIP。不完整暂存必须续解或重新解压。

## EPUB 必须在 snapshot 前单独处理

`novel-organize scan` 只接收整书 TXT；它不会把 EPUB 当 TXT，也不会替你转换。
因此“扫描时没有报错”不代表 EPUB 已经进入 catalog。不要让 EPUB 静默留在普通
scan 来源中：先用 `epub-to-txt` 独立审计，核对报告中的 `found`、`convertible`、
`rejected` 和 `errors`，再开始 TXT 的 snapshot。

转换器默认是只读 dry-run。它会校验实际读取的正文/必要元数据成员 CRC、路径穿越、压缩炸弹、ZIP 加密位、
DRM、OPF spine 顺序和有效正文，并报告书名、作者和章节标题。传输期间只能用
`--limit` 做 smoke；传输完全结束后先做一次不带 `--limit` 的完整 dry-run：

```bash
EPUB_TXT_ROOT=/public/home/actueuo6co/电子书转换TXT
EPUB_AUDIT=/tmp/literary-giant-epub-audit.jsonl

epub-to-txt \
  /public/home/actueuo6co/txt \
  /public/home/actueuo6co/其它 \
  /public/home/actueuo6co/晋江 \
  --output-root "$EPUB_TXT_ROOT" \
  --report "$EPUB_AUDIT"
```

确认 JSONL 审计结果和输出规划后，才显式执行：

```bash
epub-to-txt \
  /public/home/actueuo6co/txt \
  /public/home/actueuo6co/其它 \
  /public/home/actueuo6co/晋江 \
  --output-root "$EPUB_TXT_ROOT" \
  --report "$EPUB_AUDIT" \
  --confirmed
```

confirmed 模式会写出严格 UTF-8、无 BOM 的 TXT。验证通过的 EPUB 默认保留，
不会因转换成功而删除；验证拒绝的 EPUB（包括纯图/无有效文字、DRM/加密、损坏包、
危险路径或压缩炸弹）则会在 JSONL `rejected_pending_delete` 记录完成 `fsync`、且源文件
路径/大小/mtime/inode/SHA-256 再次匹配后删除，并追加 `rejected_deleted`。审计写入失败
或源文件发生变化时拒绝删除。由于 confirmed 会新增 TXT 并删除 rejected EPUB，它必须
发生在 `novel-organize snapshot` 之前；后续 snapshot/scan 要包含 `$EPUB_TXT_ROOT`（上例
目录位于默认 source base 下且名称含中文，会被默认来源发现，也可用 `--source` 显式指定）。
转换器采用有界 future 队列，单本解析异常不会中断整批。中断后可使用 `--resume`；
只有转换配置、源文件 stat/SHA，以及 confirmed 输出的 size/SHA 全部一致时才会跳过。
默认 `--workers` 取 CPU affinity、cgroup 配额与 16 三者的较小值；当前环境自动得到 7，
无需按宿主机显示的总核数手工放大。

## 为什么不能按书名去重

书名只用于召回候选。最终关系由正文决定：

- `byte_exact`：原始字节完全相同；
- `text_exact`：编码、BOM 或换行不同，规范文本相同；
- `same_edition`：长度、抽样句子覆盖率、Jaccard 和顺序一致性都达到严格阈值；
- `same_work_version`：全文件流式句子 shingle 显示正文高度包含但完整度不同，保留成同一作品的不同 edition；
- `possible_incomplete`：短版长度仅为长版的 45%–80%，正文 containment/order 均至少 99%，共享至少 24 个 anchors，且书名/作者不冲突；默认仍保留为 `_v2/_v3`，并进入 `review.jsonl`；
- `incomplete_duplicate`：只有显式使用 `plan --delete-high-confidence-incomplete` 时，且同一 edition 组的每一个交叉内容对都满足上述高置信条件，短版才会在计划中折叠到长版；
- `possible_same_work`：进入 `review.jsonl`，不自动合并；
- `title_collision`：同名但正文证据不符，明确保留为不同作品。

模糊关系采用正文的全文件、位置无关 bottom-k 指纹，并以 complete-link 约束聚类，避免 `A≈B、B≈C` 把实际不同的 A/C 传递合并。规则分类先利用原目录、书名和开头简介。困难条目可以交给本机 vLLM；默认每个受限请求放 2 本、同时维持 32 个请求，让 vLLM continuous batching。批量结果缺项或格式异常时只拆分重试受影响条目。`difficult` 模式只选择字段冲突、异常书名、确有作者线索但未解析成功，以及规则完全无法可靠分类的条目；先生成一次去重计划后，可用 `--representative-plan-run-id` 只处理保留版本。有限 smoke test 可用 `--candidate-sample-seed` 跨全库确定性抽样，避免只验证相邻目录的一种命名模式。LLM 不参与去重，也没有删除权限；任何请求回退会把 enrich run 标成 `partial` 并返回非零。

LLM 使用持久 HTTP 连接、有界头部预读和按不可变 prompt 输入建立的 SQLite cache；只有通过结构和字段校验的模型结果才会缓存，
网络失败、缺项和无效响应都会保留为可重试状态。书名、作者、分类分别设置信心锁；模型新增作者或别名必须
能在文件名/正文头部找到证据，显式作者不会被覆盖，低置信的 `书名-作者` 歧义则允许纠正或清空。
发布前可用 `--candidate-mode sanity` 只重跑明显过长或混入 HTML/正文提示的作者字段；这类值不会继续享受高置信锁。

## 稳定快照、smoke 与全量移动

数据传完后，先保存一次快照，至少等待一个稳定窗口，再执行扫描。扫描中只要还有 `unstable/error`，plan 就会拒绝生成；真正 `move` 时会重新计算当前快照并逐一核对当前 TXT 是否都已进入 plan。只要出现未规划文件、文件数/字节数/path/size/mtime 签名变化，或仍存在 `.raysync.uploading`/`.part` 等 sidecar，就会拒绝移动。

所有全局选项应写在子命令前：

```bash
# 1. 传输结束后保存基线；该命令不读小说正文
novel-organize snapshot --output /tmp/novel-snapshot.json

# 2. 递归扫描。每个 TXT 被视为一本整书，支持断点续扫
# 正式跑不要加 --limit；完整遍历会把已消失/改名的旧 catalog 行标成 missing
novel-organize scan --workers 7

# 旧 catalog 升级时先预览 U+FFFD 质量重检；dry-run 不读正文、不改状态
novel-organize revalidate-quarantine \
  --max-literal-replacement-rate 0.0002 \
  --workers 7 \
  --run-id <quality-preview-id>

# 确认 summary 后，只严格复验 replacement-bearing 的旧 ok/quarantine 行
# 不扫描其余正文；会写逐文件 results.jsonl，但不改源 TXT
novel-organize revalidate-quarantine \
  --max-literal-replacement-rate 0.0002 \
  --workers 7 \
  --run-id <quality-apply-id> \
  --apply

# 3. 可选：只让本机 vLLM 处理低置信书名/分类
scripts/run_novel_metadata_vllm.sh models/weights/Qwen_14B
novel-organize enrich-metadata \
  --model novel-metadata \
  --base-url http://127.0.0.1:8000/v1 \
  --candidate-mode difficult \
  --representative-plan-run-id <initial-plan-id> \
  --items-per-request 2 \
  --batch-size 32

# 4. 内容优先地判重并生成 review 队列，不移动文件
novel-organize plan

# 可选：检查过 possible_incomplete 后另建一个显式折叠计划
# 这一步本身仍不删文件；真正删除还必须 apply --transfer-mode move
novel-organize plan --delete-high-confidence-incomplete

# 5. 先检查 Library/Noise/.state/runs/<plan-id>/summary.json 和 review.jsonl
# apply 直接写入分类目录，并在完整成功后原子更新 index.jsonl
novel-organize apply \
  --plan-run-id <plan-id> \
  --transfer-mode move \
  --workers 7 \
  --stability-snapshot /tmp/novel-snapshot.json \
  --confirm-transfer-complete

# 6. 重哈希验证分类文件
novel-organize verify --plan-run-id <plan-id> --workers 7
```

严格复验只接受：编码判定为 `high`、`U+FFFD/non-whitespace <= 0.0002`、使用所选
codec 全文件 `errors=strict` 解码成功，并且原始/规范正文哈希和计数都与扫描记录一致。
这样能区分源文本本来就含有的合法 `U+FFFD` 与坏字节在宽松解码时生成的替换符。旧
`ok` 若严格解码失败会降为 `quarantine` 并删除 anchors；旧 `quarantine` 验证成功会升为
`ok` 并从保存的 sketch 恢复 anchors。源文件身份或哈希变化会标成 `unstable`，阻止 plan，
而不是进入可删除队列。重检改变状态后必须生成新的 final plan；旧 frozen plan 只保留作
历史审计，不能继续 apply。

`apply --limit N` 只用于 smoke，会把 run 标成 `partial` 并报告 `remaining`，不会伪装成全量完成。apply 状态分别记录文件是 `copied`、`moved` 还是 `deduplicated`：即使先 copy 演练过，后续对同一 plan 执行 move 仍会验证分类文件并删除已确认稳定的源文件。move 总是先复制到独立 inode、哈希和 `fsync` 成功后再删源。重复来源也只有在代表文件已经按代表原始 SHA-256 复验后才会删除。

空间不足以先完整 copy 时，可在全量 move 中增加
`--preserve-existing-processed`。此开关只保留经过 provenance 哈希认证、且
`source_kind=existing_processed` 的旧库导出源；普通 raw 仍在目标 UTF-8 文件哈希和
fsync 成功后删除。这样 `index.jsonl` 生成后仍可用旧库导出做 ID map 三方复验。该开关
仅允许与 `--transfer-mode move` 同用，apply/verify 会分别记录并复验
`source_preserved` 与 `source_duplicate_preserved` 状态。

apply 的 worker 只并行互不冲突的 canonical/edition 转码；journal、SQLite 状态与删除结果仍由
单协调线程提交，并在所有代表本完成后才处理重复来源。verify 并行复验唯一目标文件。archive 级
跨进程锁会拒绝 apply/apply 或 apply/verify 同时操作同一库。默认 worker 数读取 CPU affinity 与
cgroup quota；当前环境会得到 7。

残缺检测刻意采用两级权限：默认 plan 只有“标记/复核”权限，不会把候选短版变成重复来源；显式开关也只改变 plan，只有之后明确执行 `apply --transfer-mode move` 才会删除已验证的短版。作者冲突、标题证据不足、共享 anchors 不够、乱序或仅靠模糊传递关系的条目一律不自动折叠。长版沿用自己已分配的永久 ID；短版曾经取得的 ID 不会转给新书，因此增量导入不会重编号旧书。

## 统计与逐文件审计

扫描、LLM、plan 和 apply 都必须保留可追溯记录。新版 LLM 审计会同时写入
SQLite `metadata_events` 和 run 目录的 `results.jsonl`，每条包含规则初值
`before`、模型原始提议 `proposal`、护栏后的 `after`、修改字段和接受/拒绝原因。
历史旧格式可以在源文件 size/mtime 与扫描记录完全一致时补齐；该命令只新增审计行，
不修改小说或当前元数据：

```bash
python scripts/backfill_legacy_metadata_audit.py \
  --catalog /tmp/literary-giant-front6/catalog.sqlite3
```

任意阶段都能生成一次一致的只读快照报告；全量结束后对最终 plan 再生成正式报告：

```bash
python scripts/report_novel_import_audit.py \
  --catalog Library/Noise/.state/catalog.sqlite3 \
  --plan-run-id <final-plan-id> \
  --output-dir Library/Noise/.state/final-audit \
  --supplemental-jsonl <epub-audit.jsonl> \
  --supplemental-jsonl <archive-extract-run/journal.jsonl>
```

输出固定为：

- `summary.json`：每轮 pipeline 的起止状态、扫描状态/编码/分类、各阶段滤除数、
  去重与 apply 状态、实际丢弃正文数和审计文件 SHA-256；
- `files.jsonl`：每个原文件一行，记录原路径/文件名/大小/mtime/哈希、检测编码、
  规则与最终元数据、plan、最终去向；
- `changes.jsonl`：字段级 `before -> proposal -> after`，以及原文件名/编码到最终
  `CC_idNNNNNN_书名_作者[_vN].txt`/UTF-8 无 BOM 的变化；
- `deletions.jsonl`：所有实际删除的原路径、大小、哈希、原因、删除时间、重复目标
  或保留路径；
- `supplemental_events.jsonl`：EPUB 和压缩包脚本的原始审计事件及来源行号。

删除统计明确区分两类：`content_discarded=true` 才表示无效、转换失败或纯图 EPUB
导致正文被丢弃；`content_preserved=true` 表示源路径虽因成功移动、去重或压缩包替换
而删除，但内容已在最终分类文件、重复代表本或解压目录中保留。报告从 SQLite WAL 的
同一个只读快照导出，因此扫描即使仍在并行提交，`summary.json` 的总数也会与
`files.jsonl` 行数严格一致。

## 增量导入

新批次可以重复执行同一套 `snapshot -> scan -> plan -> apply -> verify`。扫描缓存以
路径、大小、mtime 和指纹算法版本为键：未变化文件不重新读取全文；已经移动进
Noise 的记录不会因原来源目录为空而标成 missing，并会继续参与新书的全文去重。
即使上传工具复用了旧文件名，目录中的新内容也会生成新记录，旧归档记录不会被覆盖。

plan 会基于“旧库 + 新批次”重新做全局一致性聚类，避免只在新批次内部去重。
上一 completed plan 的路径、稳定 ID、source identity、hash 与 apply 状态会通过物化表批量复用；
apply 仍会现场要求目标为非 symlink 普通文件。已验证目标的 dev/inode/size/mtime/ctime 全部
未变时只需一次 `lstat`；身份变化时才重新读取正文并刷新标记，目标缺失或损坏则重建，不能只凭
SQLite 状态假完成。独立的 verify 始终全文复验，不使用这条快速路径。apply 是幂等和可续跑的，只发布未满足项；全部成功后原子重写一份完整
`index.jsonl`。因此磁盘正文和索引不会出现只更新一半却被标成完成的状态。

显式指定少量来源和条数做演练：

```bash
novel-organize \
  --archive-root /tmp/Library/Noise-smoke \
  --source /public/home/actueuo6co/晋江/2024晋江热榜 \
  scan --limit 20 --workers 2 --stable-age-seconds 600
```

默认会识别这些来源：`txt`、`其他`（也兼容不存在的“其它”拼法）、`晋江`、`武侠修真`、`玄幻魔法`、`科幻小说`、`网游竞技`、`笔趣阁全站网络小说合集 31w本`、`小说合集2`，以及基目录下后续新增的其他中文名顶层文件夹。`--source/--source-base` 只对 snapshot/scan 有效；plan 总是处理当前 archive catalog，防止命令看起来限定了来源、实际却悄悄忽略。

## 接入现有已处理书库

现有 `TaciturnRaw` 不直接改号。先将 cleaned 章节按 manifest 顺序拼成严格
UTF-8、无 BOM 的整书，书名和作者与每章字节区间写入 provenance。cleaned
缺失时才回退到 raw；旧的 `book_*` / `story_*` 只作为溯源键，新库统一
使用不区分类型的 `idNNNNNN`。

```bash
PROCESSED_EXPORT=runs/existing-import-staging

# 先只读预览，然后显式写入独立 staging；不修改 Library
processed-corpus-migrate export-existing --library-root Library
processed-corpus-migrate export-existing \
  --library-root Library \
  --workers 7 \
  --apply \
  --staging-root "$PROCESSED_EXPORT"
```

`--workers` 是并行读取进程数。对本机 7 核但远程小文件延迟较高的目录，可设为
`28`，用额外进程重叠 I/O 等待；cgroup 仍将实际 CPU 限制在 7 核。若只读计划
已经完成，执行阶段应复用它，避免再次扫描全部章节：

```bash
processed-corpus-migrate export-existing \
  --library-root Library \
  --input-plan-dir runs/existing-import-plan \
  --refresh-unavailable \
  --plan-dir runs/existing-import-plan-refreshed \
  --workers 28 \
  --apply \
  --staging-root "$PROCESSED_EXPORT"
```

cleaned 中明确为空、缺失或不可解析的少数章节只在所有严格来源均失败后才允许
跳过；护栏为每书不超过 16 章且不超过 manifest 的 5%。每个跳过项都会写入
`omitted_chapters`，超过阈值则整书仍标记为 unavailable。

全局 snapshot/scan 时，将 `"$PROCESSED_EXPORT/imports"` 和所有新 raw 根目录一起作为
`--source`。organizer 只信任与 `source.txt` 实际 SHA-256 完全一致的
provenance，并将旧库来源标记为 `source_kind=existing_processed`、
`source_priority=100`。因此它与新 raw 正文重复时，已处理版本成为代表本；
哈希或 sidecar 不一致则 scan 报错，plan 不会继续。

普通 raw 只要出现解码替换字符就继续 quarantine。对上述已验证 processed export，
若文件本身是高置信严格 UTF-8、provenance 哈希一致，且历史遗留的字面 `U+FFFD`
比例不超过 `0.0002`，scan 可保留整书，并把数量和比例写入
`title_evidence_json`；超过阈值仍 quarantine。

首次发布必须先用 `copy`，让 organizer 原子生成最终 `index.jsonl`，同时保留
export staging 供三方哈希复验：

```bash
novel-organize --archive-root Library/Noise apply \
  --plan-run-id <plan-id> \
  --transfer-mode copy \
  --stability-snapshot <包含新raw和processed-export的snapshot.json> \
  --confirm-transfer-complete

# 默认只读；检查通过后才显式写 id map 和审计文件
processed-corpus-migrate build-id-map \
  --organizer-index Library/Noise/index.jsonl \
  --import-root "$PROCESSED_EXPORT" \
  --organizer-plan Library/Noise/.state/runs/<plan-id>/plan.jsonl

processed-corpus-migrate build-id-map \
  --organizer-index Library/Noise/index.jsonl \
  --import-root "$PROCESSED_EXPORT" \
  --organizer-plan Library/Noise/.state/runs/<plan-id>/plan.jsonl \
  --plan-dir runs/processed-id-map-audit \
  --output-id-map runs/post-merge-id-map.json
```

`build-id-map` 会同时复验 export marker/manifest、每本书的 provenance 和
`Noise/index.jsonl`。公开 index 只含 canonical/edition；冻结 `plan.jsonl` 仅用于按明确的
`duplicate_of_file_id`、最终 ID、edition/work 身份及正文哈希/重叠证据补回被省略的
processed source-duplicate，绝不按书名或作者猜测。它要求 export、index 与冻结计划的
processed identity 集合完全一致，也会拒绝旧 ID
被改号、一个旧 identity 指向多个新 ID、同一 ID 存在多个代表本，或已处理
书被拒绝却没有最终 ID。增量运行可以传 `--base-id-map <上次的map.json>`；已有
映射只能保留，不能重编。

然后先在独立 staging 生成上游改号结果，再删除 export 来源：

```bash
# 只读预览
processed-corpus-migrate reindex-staging \
  --library-root Library \
  --import-root "$PROCESSED_EXPORT" \
  --id-map runs/post-merge-id-map.json

# 仍只写 staging，不切换正式 Library
processed-corpus-migrate reindex-staging \
  --library-root Library \
  --import-root "$PROCESSED_EXPORT" \
  --id-map runs/post-merge-id-map.json \
  --apply \
  --staging-root runs/processed-reindex-staging

# reindex 成功后，对同一 organizer plan 改用 move 续跑，不会重复复制
novel-organize --archive-root Library/Noise apply \
  --plan-run-id <plan-id> \
  --transfer-mode move \
  --stability-snapshot <同一snapshot.json> \
  --confirm-transfer-complete
novel-organize --archive-root Library/Noise verify --plan-run-id <plan-id>
```

reindex staging 的 canonical 目录是 `corpus/idNNNNNN/`，章节 ID 是
`idNNNNNNCNNNNNN`，`content_type=content`；同时生成改写后的 index/Bridge JSON
副本。它故意不开关正式 Library、不删旧目录，也不假装已重建所有历史章节
载荷；正式切换前必须对 staging 做独立验收。最终整书档案仍是简单的
`Library/Noise/<分类>/*.txt + index.jsonl`，这些 staging 文件只用于旧上游迁移。

## Noise 晋升为分类化 01_RawData

最终物理目录固定为下面四层；`stories_cleaned` 已退休，不再创建：

```text
Library/TaciturnRaw/
├── 00_Stories/idNNNNNN/             # 暂存并保留的短篇原始资源
├── 01_RawData/<机器类别>/idNNNNNN/  # 分类整书、source.txt、index.json
├── 02_CleanedData/idNNNNNN/         # 已完成 hardmodel 的可复用资源
└── 03_ChapterAnalysis/idNNNNNN/      # 章节语义分析资源
```

Bridge、LLMExtracted、注册表和 JSON 内部引用使用同一个 `idNNNNNN`；章节 ID
统一为 `idNNNNNNCNNNNNN`。旧 `book_*`/`story_*` 映射只保存在不可变迁移审计中，
一次性迁移会直接改写源 JSON 和注册表，运行期不查映射。已存在且 provenance 与
raw 哈希一致的 cleaned 结果登记为 reusable，后续 hardmodel 只处理缺失 ID。

正式切换使用冻结且无 blocker 的计划；命令只迁移资源并发布就绪门禁，不启动模型：

```bash
python -m scripts.migrate_taciturn_layout \
  --input-plan runs/taciturn-layout-v2-plan-20260722/plan.json \
  --apply --workers 28 \
  --audit-root Library/indexes/migrations/taciturn-layout-v2-20260722
```

全量验证通过后使用 `novels-raw-migrate` 生成独立迁移计划。目标 raw 布局使用
稳定机器标签，不把可能继续修正的中文作者或书名放进真实路径：

```text
Library/TaciturnRaw/01_RawData/
├── 总目录.txt
├── 00_xuanhuan/
│   ├── 目录.txt
│   ├── id000001/
│   │   ├── source.txt
│   │   └── index.json
│   └── id000002/
└── 21_explicit_h/
```

中文类别、作者、书名和 `_v2/_v3` 展示名保存在全局/分类 `目录.txt` 及 JSON
索引。`02_CleanedData`、`03_ChapterAnalysis`、`Bridges/novels_plot`、`BridgeIndex`
和 `LLMExtracted` 均继续使用唯一的 `idNNNNNN` 目录；章节使用
`idNNNNNNCNNNNNN`。这样中文 label 可以调整而不破坏 clean、chapter、plot、
bridge 的外键。

版本排序优先保留已验证的最长版本；长度接近时优先现有已处理版本。冻结 review
中具有有序包含证据的短版标记为 `review_probable_incomplete`，仅凭长度的短版标记
为 `review_possible_incomplete`。两者默认都不自动删除，必须经过后续内容审查。
若旧稳定 ID 意外对应多个 edition cluster，第一个簇保留旧 ID，后续簇只从当前
高水位继续分配，并写入 `id_collision_repairs.jsonl`。

```bash
novels-raw-migrate \
  --organizer-index Library/Noise/index.jsonl \
  --noise-root Library/Noise \
  --collision-repairs runs/processed-id-map-audit/id_collision_repairs.jsonl \
  --id-map runs/post-merge-id-map.json \
  --organizer-review Library/Noise/.state/runs/<plan-id>/review.jsonl \
  plan --plan-dir runs/novels-raw-migration-plan

# 先做无破坏 hardlink smoke；不会切换 Library
novels-raw-migrate <同上参数> stage \
  --staging-root runs/novels-raw-migration-smoke --limit 32
```

冻结 Noise 已完成一次 errors=0 的全量规范哈希验证后，可用并行、只做文件类型与
hardlink inode 检查的快速模式。它不会再次顺序读取约 780 GiB 正文；正式验收仍应
跨类别抽样调用与发布阶段相同的规范哈希函数：

```bash
novels-raw-migrate <同上参数> stage \
  --staging-root runs/novels-raw-staging-full \
  --transfer-mode hardlink \
  --verification-mode trusted_frozen \
  --workers 14
```

staging 会将不同类别交错提交给 worker，避免远端文件系统在单一类别目录产生元数据
写锁热点；单本索引可重复生成，最终总索引、分类目录和 summary 使用持久化原子写。

正式 staging 默认使用 hardlink，避免临时复制约 780 GiB 正文；Noise 与旧
`01_RawData` 在独立验收完成前都保留。正式切换必须是单独、显式的事务，不属于
plan 或 stage 命令。

## 正文清洗边界

归档阶段将选中正文严格转换成 UTF-8（无 BOM），转换后再次检查 UTF-8 解码和
规范正文哈希。编码歧义、解码替换字符、过短文本，或转换后无法保持统一正文的
来源，在确认 move 模式下会删除，并将原因保留在 SQLite、冻结 plan、运行 journal 和最终 audit 中。
广告、章节切分和正文噪声仍交给现有 hardmodel。已归档的
`CC_idNNNNNN_*.txt` 能被 hardmodel 的 source resolver 识别为彼此独立的整书，因此
可以按分类目录投入，且下游直接保留 `idNNNNNN`。尚未归档、不符合该命名
的杂乱 TXT 目录仍应逐本处理，以免被误解为同一本书的逐章文件。对这种扁平
Noise 分类目录不要启用 `--materialize-source-chapters`：该可选模式仍把章节回写到
共享的来源目录；默认的 cleaned 输出会按 `idNNNNNN` 独立建目录，不受影响。

同样不要把十几万本 Noise 作品逐本调用 `BookRegistry.register()`：现有 `books.json` 适合少量正式作品，不是这类全量语料的索引后端。需要晋升到 `TaciturnRaw` 时，应先从 `index.jsonl` 或 `.state/catalog.sqlite3` 选定、复核一个小批次，再做专门的批量晋升事务。
