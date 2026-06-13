# LiteraryGiant — 长篇小说数据处理管线

## 项目概述

从多个小说网站抓取原始文本，经过清洗、去噪、章节拆分，产出结构化的 cleaned chapters 数据，供后续分析（角色提取、情节识别、世界观构建等）使用。

## 数据布局

```
Library/
├── indexes/
│   ├── books.json           ← 所有注册书籍的元数据（fetcher 写入）
│   └── cleaned_books.json   ← clean 注册表，维护 raw → clean 的映射
├── rawdata/
│   ├── novels/              ← 按 book_XXXX 分目录，每章一个 .txt
│   ├── stories/             ← 短篇小说
│   └── reviews/             ← 书评
├── reference/
│   └── facts/
│       └── cleaned_chapters/ ← hardmodel 产出，按 book_XXXX 分目录
│           ├── book_0001/
│           │   ├── index.json
│           │   ├── chapter_0001.json
│           │   └── ...
│           └── ...
└── ideas/                   ← 灵感种子（短篇/未分类内容）
```

---

## 管线流程

整个数据处理分为 **三个主要阶段**：

### 第一阶段：Fetcher（抓取）

**入口**：`fetcher/engine.py` → `FetcherEngine.fetch_novel(url)`

**步骤**：

1. **页面抓取** — 请求目标 URL，用站点适配器（`fetcher/adapters/`）解析 HTML
2. **章节发现** — 适配器从目录页提取所有章节链接，支持多页目录自动翻页
3. **分类判断** — 根据内容统计自动判定为 `book`（长篇小说）或 `story`（短篇）：
   - 总字数 ≥ 180,000 → 强判定为 book
   - 总字数 ≥ 100,000 且章节 ≥ 8 → 弱判定为 book
   - 发现章节 ≥ 20 → 以章节数判定为 book
   - 否则 → story
4. **并发下载** — 多线程并发抓取每章内容，支持断点续传、章节内多页拼接
5. **注册入库** — 写入 `books.json`，分配 `book_XXXX` ID，内容写入 `rawdata/novels/book_XXXX/chapter_0001.txt`

**关键文件**：
- `fetcher/engine.py` — 抓取引擎（站点无关）
- `fetcher/registry.py` — `BookRegistry`：管理 books.json 的增删改查
- `fetcher/adapters/` — 各站点适配器（DOM 解析、章节提取）

**输出**：
```
rawdata/novels/book_0001/
├── index.json          ← 抓取清单（标题、URL、每章状态）
├── chapter_0001.txt    ← 原始文本（未清洗）
├── chapter_0002.txt
└── ...
```

---

### 第二阶段：Hardmodel（清洗）

**入口**：`Jormungandr/hardmodel/scheduling.py` → `main()`

**步骤**：

1. **输入解析**（`source_resolver.py`）
   - 自动检测输入类型：单文件（全本 txt）、目录（每章 txt）、嵌套目录（多本书）
   - 读取 `index.json` 获取标题、章节清单等元数据
   - 产出统一的 `BookSource` 对象

2. **逐章清洗**（`chapter_cleaner.py`）
   - **规则去噪**：用正则/规则过滤广告、导航、版权声明、空白行等（`noise_patterns.py`）
   - **弱噪声分类**（可选）：对不确定的行，用 LLM（Qwen/VLLM）判断是否是噪声
   - **行级修剪**：消除多余换行、合并短行、修正标点
   - **标题提取**：从正文中识别章节号和卷号

3. **增量处理**（`processor.py`）
   - 支持 `--sync-state` 跟踪已处理的书籍和章节
   - 支持 `--use-clean-registry` 通过 `cleaned_books.json` 做 raw → clean ID 映射
   - 支持 `--pending-fetches` 自动发现未 clean 的新抓取内容
   - 未变更的书籍/章节自动跳过

4. **输出写入**（`manifest_writer.py`）
   - 每章一个 JSON 文件：`chapter_0001.json`
   - 每个 book 一个 `index.json` 目录清单

**关键文件**：
- `Jormungandr/hardmodel/scheduling.py` — CLI 入口，调度逻辑
- `Jormungandr/hardmodel/source_resolver.py` — 输入检测与统一化
- `Jormungandr/hardmodel/chapter_cleaner.py` — 章节清洗核心逻辑
- `Jormungandr/hardmodel/noise_patterns.py` — 噪声规则库
- `Jormungandr/hardmodel/processor.py` — 批处理与增量逻辑
- `Jormungandr/hardmodel/manifest_writer.py` — 输出文件写入

**输出**（每章一个 JSON）：
```json
{
  "chapter_id": "0001C0001",
  "order": 1,
  "raw_title": "第1章 序章",
  "clean_title": "序章",
  "chapter_no": 1,
  "volume_title": null,
  "volume_no": null,
  "content": "清洗后的正文内容...",
  "char_count": 3408,
  "paragraph_count": 91,
  "dialogue_ratio": 0.13,
  "metadata": {
    "source_path": "Library/rawdata/novels/book_0027/chapter_0001.txt",
    "has_content": true
  }
}
```

---

### 第三阶段：后续处理（规划中）

数据布局已预留以下目录，尚未实现：

| 目录 | 用途 |
|------|------|
| `reference/facts/characters/` | 角色提取与关系图谱 |
| `reference/facts/plot_segments/` | 情节分段与冲突弧线 |
| `reference/facts/relationships/` | 角色关系网络 |
| `reference/facts/worldbuilding/` | 世界观元素（地点、道具、规则） |
| `reference/facts/chapter_features/` | 章节级别特征向量 |
| `reference/facts/memes/` | 梗/金句/名场面提取 |

---

## ID 体系说明

### 两套编号系统

项目使用 **两套独立的 ID**：

| 体系 | 来源 | 含义 |
|------|------|------|
| **Rawdata ID** | `books.json`（fetcher 分配） | 按注册顺序递增，存在空号（注册但未抓取的） |
| **Cleaned ID** | `cleaned_books.json`（hardmodel 分配） | 密集重排，只包含实际有 clean 产出的书 |

### 为什么不对齐？

Rawdata 中存在「注册了但没抓取」的书（例如帝霸、武煉巔峰），如果 cleaned ID 和 rawdata ID 保持一致，clean 序列就会出现空洞。为了 clean 结果的密集性，hardmodel 按实际产出顺序重新编号，并通过 `metadata.source_path` 字段记录每章对应的 rawdata 源文件。

**示例**：
```
cleaned/book_0012 ← rawdata/book_0013（跳过了 rawdata/book_0012「帝霸」，因为未被抓取）
cleaned/book_0013 ← rawdata/book_0014
cleaned/book_0016 ← rawdata/book_0018（跳过了 rawdata/book_0017「史上最強鍊氣期」）
```

### 如何追溯

每个 cleaned chapter JSON 的 `metadata.source_path` 记录了原始文件的绝对路径，可以精确追溯到对应的 rawdata 章节。

---

## 运行命令

### 抓取

```bash
# 单本
python -m fetcher fetch "https://ixdzs.tw/read/445273"

# 批量（从 URL 列表文件）
python -m fetcher batch urls.txt
```

### 清洗

```bash
# 处理单本书
python -m Jormungandr.hardmodel Library/rawdata/novels/book_0001 --use-clean-registry

# 处理整个 rawdata 目录（增量，自动跳过已处理的）
python -m Jormungandr.hardmodel Library/rawdata/novels --use-clean-registry

# 只处理新抓取的（基于 fetch run index）
python -m Jormungandr.hardmodel . --pending-fetches --use-clean-registry

# 强制重处理
python -m Jormungandr.hardmodel Library/rawdata/novels/book_0001 --use-clean-registry --force

# 带 LLM 弱噪声分类
python -m Jormungandr.hardmodel Library/rawdata/novels \
    --use-clean-registry \
    --noise-classifier-model Qwen/Qwen2.5-1.5B-Instruct \
    --noise-classifier-backend vllm
```

---

## 当前数据状态

### 抓取

- 注册书籍：214 本（last_id=221）
- 成功抓取：187 本（总字数 3.39 亿，总章节 116,735）
- 未抓取：27 本
- 来源覆盖 8 个站点：ixdzs.tw、ibiquge.com、qushucheng.com、trxs.cc、kanunu8.com、bqquge.com、dingdian365.com、sudugu.org

### 清洗

- 已 clean：118 本（78,938 章，约 2.3 亿字）
- 未 clean：47 本（18,990 章，约 0.7 亿字）

### 已知问题

- **bqquge.com 反爬**：该站点的抓取结果全部是固定长度的噪音（346 字/章），需要适配器修复
- **短章书籍**：部分书只有 5-8 章（kanunu8.com 短篇），content_type 分类可能需要调整
- **后续维度未跑**：characters、plot_segments、relationships 等都还是空的
