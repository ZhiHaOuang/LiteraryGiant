# LiteraryGiant

中文长篇网文处理与生成实验管线。

## 项目结构

```
fetcher/          # 网站小说抓取引擎（当前焦点）
hardmodel/        # 规则切章：原始 txt → 章节 JSON
softmodel/        # 语义抽取：章节正文 → 角色/冲突/伏笔等特征
infermodel/       # 情节聚合：章节特征 → 全局 plot 段
generatemodel/    # 结构生成：plot 库 → 新 plot/chapter JSON
Jormungandr/      # hardmodel 的另一套实现
shared/           # 公共工具（路径常量、状态管理、JSON 解析）
scripts/          # 辅助脚本（数据同步、校验）
```

## Fetcher — 网站小说抓取引擎

网站无关的多线程小说抓取器，采用适配器模式。只需写一个 `BaseAdapter` 子类即可支持新网站。

### 安装

```bash
conda env create -f environment.yml
conda activate literary-giant
pip install -e .
```

核心依赖只有 `beautifulsoup4` 和 `requests`。

### CLI 用法

```bash
# 抓取一本小说（自动探测网站适配器）
python -m fetcher https://www.bqquge.com/507

# 限制章节数（测试用）
python -m fetcher --max-chapters 10 https://www.bqquge.com/507

# 并行抓取（--concurrency 控制并发数）
python -m fetcher --concurrency 5 --delay 0.3 https://www.bqquge.com/507

# 多站点并行抓取：不同域名同时跑，同域名共享 --delay 限速
python -m fetcher --site-concurrency 4 --concurrency 3 --delay 0.5 \
  https://www.bqquge.com/507 https://www.ibiquge.com/167/

# 抓取单篇短篇故事，输出 story_XXXX/story.txt
python -m fetcher --content-type story \
  https://www.51shucheng.net/kehuan/liucixinduanpian/18513.html

# 发现新书（排行榜）
python -m fetcher --discover https://www.bqquge.com/paihang

# 导入本地 txt 文件
python -m fetcher --import 平行万宙.txt --title 平行万宙

# 查看已注册的书
python -m fetcher --summary

# 列出支持的网站适配器
python -m fetcher --list-adapters

# 调试模式
python -m fetcher -v --max-chapters 3 https://www.bqquge.com/507
```

### Python API

```python
from fetcher import FetcherEngine, get_adapter_for_url

# 自动选择适配器
adapter_cls = get_adapter_for_url("https://www.bqquge.com/507")
engine = FetcherEngine(
    adapter_cls(),
    max_chapters=10,    # 只抓 10 章（测试）
    concurrency=5,      # 5 章并行
    min_delay=0.3,      # 请求间隔 0.3 秒
)
path = engine.fetch_novel("https://www.bqquge.com/507")
print(path)  # → Yggdrasil/sources/raw_text/book_0001/
```

### 数据流

```
CLI: python -m fetcher <url>
  → fetcher/scheduling.py:main()
    → FetcherEngine(adapter).fetch_novel(url)
      → 1. 抓取目录页 → 提取书名 + 章节列表
      → 2. 注册到 Yggdrasil/indexes/books.json
      → 3. 并行抓取章节 → runs/fetch/<run_id>/<book_slug>/
      → 4. 校验（完成率、空文件检查）
      → 5. 提升到正式目录 → Yggdrasil/sources/raw_text/<book_slug>/
```

### 适配器架构

每个网站只需要实现一个 `BaseAdapter` 子类（约 100-150 行代码）：

| 方法 | 职责 |
|------|------|
| `extract_title(soup, url)` | 从目录页提取书名 |
| `extract_chapter_list(soup, url)` | 解析章节列表 |
| `extract_content(soup, url)` | 提取单章正文 |
| `extract_next_page_url(soup, url)` | 提取多页章节的"下一页"链接 |
| `predict_page_urls(first_url, page2_url)` | 预测多页章节的剩余页 URL（可选） |
| `is_index_url(url)` | 判断 URL 是否为目录页 |

当前已支持：

- **笔趣阁** (`www.bqquge.com`) — `BqqugeAdapter`
- **笔趣阁小说网** (`www.ibiquge.com`) — `IbiqugeAdapter`
- **同人小说网** (`www.trxs.cc`) — `TrxsAdapter`
- **无忧书城短篇/短篇集** (`www.51shucheng.net`) — `WuyouShuchengAdapter`

### 关键技术特性

- **线程安全 Session**：`threading.local()` 确保每个线程独立 Session，多章并行安全
- **两级并发**：章节间 `ThreadPoolExecutor` + 章节内多页并行
- **多站点并行**：多个输入 URL 可按域名并行抓取，同一域名共享限速器
- **断点续传**：每 10 章 checkpoint manifest 到磁盘，崩溃可续
- **内存友好**：章节内容流式写盘，不堆积内存
- **原子写 + 文件锁**：`BookRegistry` 用 `fcntl.flock` + `os.replace` 防止并发损坏
- **指数退避重试**：覆盖 403（临时封 IP）、连接超时、ReadTimeout
- **编码自动检测**：三层策略（Content-Type → meta charset → CJK 评分遍历）
