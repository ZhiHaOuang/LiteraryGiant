# 文学语料冷存储

本次目标是将 `TaciturnRaw/01_RawData` 和 `02_CleanedData` 的展开文件转入
可恢复归档，保留目录占位。不要删除 `TaciturnHumanZip`、`ColdStorage`、
`03_ChapterAnalysis`、`Bridges`、`AbstractLibrary` 或其他项目。

## 已确认的来源与覆盖

`scripts/export_human_library.py` 从 `01_RawData/index.jsonl` 读取原始文本，
复制为含类别、书籍 ID、书名、作者的 TXT；同时另行导出外部文学 PDF。
`scripts/archive_human_library.py` 再将这份人类可读导出版按类别压成 ZIP。
它不包含逐章清洗 JSON，也不是原始目录的完整镜像。

2026-09-17 清单检查：129 个 ZIP；其中小说 TXT 共 276,109 本，与当前
原始索引一一对应，缺失、重复和多余小说 ID 均为 0；另有文学 PDF 5,796 份。
TXT 的 ZIP 声明解压大小合计 879,441,656,313 字节。
这些是清单检查结果，不能代替逐文件内容校验。

## 归档格式与保护

新工具 `scripts/cold_store_library.py` 仅依赖 Python 标准库。

- `plan.sqlite3` 保存固定的源路径、ZIP 对应关系和分片任务。
- `plan.json` 保存来源、数量和计划数据库的 SHA-256。
- `archives/raw-*.tar.gz` 保存原始元数据，以及指向现有 ZIP 的正文恢复映射。
  原始正文不会再压缩一份。`raw-root.tar.gz` 保留全局索引、目录和迁移信息。
- `archives/cleaned-*.tar.gz` 保存清洗目录内的所有文件、子目录和内嵌清单；
  默认每 50 个书籍目录一片。`cleaned-root.tar.gz` 保留顶层状态文件。
- 每个 TAR.GZ 最后包含 `.cold-storage-manifest.json`，记录文件 SHA-256、
  原相对路径和文件状态。`receipts/*.json` 记录校验及删除状态。

正文的源 SHA-256 必须与实际从 ZIP 解压得到的内容一致；新分片要完整
解压校验，且 gzip CRC 也必须通过。删除前再次检查源文件和归档未改变。
只删除验证清单中的文件，目录用 `rmdir` 移除；新增文件会阻止删除，
不会使用递归强制删除。每批先验证再清理，释放出的空间可供后续批次使用。

部分分片清理完成后，原始/清洗流水线不再具备完整输入。归档期间和之后
不要启动依赖这些展开目录的处理任务。已有抽象库和其他未清理产物仍保留。

## 执行与续做

以下目标为本次计划路径；以实际 `plan.json` 和回执为准，不代表任务已完成。

```bash
python -B -m scripts.cold_store_library plan \
  --raw Library/TaciturnRaw/01_RawData \
  --cleaned Library/TaciturnRaw/02_CleanedData \
  --human Library/TaciturnHumanZip \
  --output Library/ColdStorage/20260917 \
  --books-per-shard 50

python -B -m scripts.cold_store_library run \
  --output Library/ColdStorage/20260917 \
  --kind all --delete-verified
```

默认不删除源文件，只有 `--delete-verified` 才会清理验证通过的文件。
`--max-shards 1` 可限制本次执行一个正文/清洗分片；全局元数据始终在该阶段
所有分片完成后才删除。重跑同一 `run` 命令会跳过已完成批次。

`--workers 2` 可交错处理两个独立分片，减少等待文件读取的时间；默认是 1。
安全中断后再次运行时，已验证并删除的分片跳过，未完成删除的分片重新校验后
续做。中断压缩产生的 `.partial` 不会作为有效归档使用，也不会覆盖最终归档。

长任务可使用独立进程入口，把控制台输出也保存在持久化目录：

```bash
python -B -m scripts.cold_store_library start \
  --output Library/ColdStorage/20260917 \
  --kind all --delete-verified --workers 2

tail -n 20 Library/ColdStorage/20260917/events.jsonl
```

`worker.json` 记录 PID 和运行状态，`console.log` 保存输出及异常。
独立进程可避免终端断开导致的退出，但不能抵御容器销毁、重启或平台强制停止。
此时应确认旧进程已退出，再用同一个 `start` 命令续跑；不可只凭旧的 PID 文件
认定任务仍在运行，必须同时检查进程、锁和日志更新时间。

任务使用文件锁防止重复运行；已有归档不会被覆盖。失败留下的 `.partial`
供排查，不能视为有效归档。计划生成失败时会保留未完成目录，需要检查后
使用新的计划路径，不应覆盖旧计划。保留至少 20GiB 剩余空间。

## 恢复

恢复指定分片到新目录，不会覆盖已有文件：

```bash
python -B -m scripts.cold_store_library restore \
  --archive Library/ColdStorage/20260917/archives/cleaned-00000.tar.gz \
  --human Library/TaciturnHumanZip \
  --destination /root/private_data/LiteraryGiant-restored/02_CleanedData
```

恢复原始正文使用相应 `raw-XXXX.tar.gz`，并保持 `TaciturnHumanZip` 可访问；
需要恢复全局索引时再恢复 `raw-root.tar.gz` 到同一目标目录。
分片名与书籍路径对应关系可在 `plan.sqlite3` 的 `tasks` 表查询。

必须把 `ColdStorage` **和** `TaciturnHumanZip` 一同保留、备份。
原始元数据归档不能独立恢复正文。归档保证内容和目录结构可恢复，不保留
原 inode、硬链接关系或扩展属性。解压目标建议先使用独立目录验证，再接回项目。

## 资源条件

本会话读取的 cgroup 配额为 0.5 CPU、2GiB 内存，不能按宿主机 `nproc`
显示的 64 个 CPU 设置并发。工具默认串行、小分片，避免压满内存。
近 TB 的正文校验以及大量章节文件的归档/删除在此配额下可能运行很久。
应使用持久化回执判断进度，不能因等待时间长而跳过校验或提前删除。
