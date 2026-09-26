from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import time
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable, Iterator, Sequence, TypeVar

from fetcher.local_resources import available_cpu_count


DEFAULT_RAW_ROOT = Path("Library/TaciturnRaw/01_RawData")
DEFAULT_LITERATURE_ROOT = Path("/public/home/actueuo6co/GF72")
DEFAULT_TARGET_ROOT = Path("Library/TaciturnHuman")
HUMAN_LAYOUT_VERSION = "taciturn-human-library-v1"
MAX_COMPONENT_BYTES = 255
LITERATURE_CATEGORY_CODE = "22"
LITERATURE_GENRE = "文学"

CATEGORY_NAMES = {
    "00": "玄幻",
    "01": "奇幻",
    "02": "武侠",
    "03": "仙侠",
    "04": "都市",
    "05": "现实",
    "06": "言情",
    "07": "后宫",
    "08": "耽美",
    "09": "百合",
    "10": "历史",
    "11": "军事",
    "12": "科幻",
    "13": "悬疑",
    "14": "惊悚",
    "15": "游戏",
    "16": "体育",
    "17": "同人",
    "18": "二次元",
    "19": "轻小说",
    "20": "其他",
    "21": "露骨H",
    LITERATURE_CATEGORY_CODE: LITERATURE_GENRE,
}

_ID_RE = re.compile(r"^id(?P<number>\d{6})$")
_TREE_LINE_RE = re.compile(
    r"^(?P<prefix>(?:(?:│   |    ))*)(?:├── |└── )(?P<name>.*)$"
)
_SAFE_COMPONENT_RE = re.compile(r"[^0-9A-Za-z\u3400-\u4dbf\u4e00-\u9fff]+")
_VERSION_RE = re.compile(r"_v(?P<version>[2-9]\d*)\.[^.]+$", re.IGNORECASE)
_GENERIC_AUTHOR_COMPONENTS = {
    "其他",
    "选集与合集",
    "选集",
    "合集",
    "文学史与研究",
    "文学史",
    "文学研究",
    "待补全与替换",
    "资料",
    "综合",
}


@dataclass(slots=True)
class ExportItem:
    canonical_id: str
    category_code: str
    genre: str
    title: str
    author: str
    version: int
    suffix: str
    source: Path
    target: Path
    original_filename: str
    original_relative_path: str
    actual_filename: str
    characters: int = 0
    tags: str = ""
    title_sort_key: str = ""
    author_sort_key: str = ""
    literature_parts: tuple[str, ...] = ()
    source_size: int = 0

    @property
    def category_dir(self) -> str:
        return f"{self.category_code}_{self.genre}"

    @property
    def content_kind(self) -> str:
        return "文学PDF" if self.category_code == LITERATURE_CATEGORY_CODE else "小说TXT"


@dataclass(frozen=True, slots=True)
class CopyResult:
    item: ExportItem
    status: str


def _safe_component(value: object, fallback: str) -> str:
    cleaned = _SAFE_COMPONENT_RE.sub("_", str(value or "")).strip("_")
    return cleaned or fallback


def _truncate_utf8(value: str, maximum_bytes: int) -> str:
    if maximum_bytes <= 0:
        return ""
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return value
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore").rstrip("_")


def _fit_generated_filename(
    *,
    category_code: str,
    canonical_id: str,
    title: str,
    author: str,
    version: int,
    suffix: str,
) -> str:
    safe_title = _safe_component(title, "未命名")
    safe_author = _safe_component(author, "佚名")
    version_suffix = "" if version <= 1 else f"_v{version}"
    prefix = f"{category_code}_{canonical_id}_"
    ending = f"_{safe_author}{version_suffix}{suffix}"
    candidate = f"{prefix}{safe_title}{ending}"
    if len(os.fsencode(candidate)) <= MAX_COMPONENT_BYTES:
        return candidate

    # Keep the stable category/ID and version suffix. Cap an unexpectedly long
    # author first, then spend every remaining byte on the readable title.
    safe_author = _truncate_utf8(safe_author, 72) or "佚名"
    ending = f"_{safe_author}{version_suffix}{suffix}"
    title_budget = MAX_COMPONENT_BYTES - len(os.fsencode(prefix + ending))
    if title_budget < len("未命名".encode("utf-8")):
        safe_author = _truncate_utf8(safe_author, 24) or "佚名"
        ending = f"_{safe_author}{version_suffix}{suffix}"
        title_budget = MAX_COMPONENT_BYTES - len(os.fsencode(prefix + ending))
    safe_title = _truncate_utf8(safe_title, title_budget) or "未命名"
    candidate = f"{prefix}{safe_title}{ending}"
    if len(os.fsencode(candidate)) > MAX_COMPONENT_BYTES:
        raise ValueError(f"unable to fit visible filename in 255 bytes: {candidate!r}")
    return candidate


def _novel_filename(row: dict[str, object]) -> str:
    original = str(row.get("display_filename") or "")
    if not original or not original.endswith(".txt"):
        raise ValueError(f"invalid display_filename for {row.get('canonical_id')}: {original!r}")
    if "/" in original or "\\" in original or any(ord(ch) < 32 for ch in original):
        raise ValueError(f"unsafe display_filename: {original!r}")
    if len(os.fsencode(original)) <= MAX_COMPONENT_BYTES:
        return original
    decision = row.get("version_decision")
    version = int(row.get("edition_version") or 1)
    if isinstance(decision, dict):
        version = int(decision.get("display_version") or version)
    return _fit_generated_filename(
        category_code=str(row["category_code"]),
        canonical_id=str(row["canonical_id"]),
        title=str(row.get("title") or "未命名"),
        author=str(row.get("author") or "佚名"),
        version=version,
        suffix=".txt",
    )


def _safe_path_under(root: Path, relative: str) -> Path:
    # The roots are resolved once by their loaders. Performing realpath() for
    # every one of 276k remote files turns a lexical safety check into hundreds
    # of thousands of unnecessary lstat calls on ParaStor.
    parsed = PurePosixPath(relative)
    if parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts):
        raise ValueError(f"path escapes root {root}: {relative!r}")
    return root.joinpath(*parsed.parts)


def load_raw_items(raw_root: Path, target_root: Path) -> tuple[list[ExportItem], int]:
    raw_root = raw_root.resolve()
    index_path = raw_root / "index.jsonl"
    if not index_path.is_file():
        raise FileNotFoundError(index_path)
    items: list[ExportItem] = []
    seen_ids: set[str] = set()
    seen_targets: set[Path] = set()
    maximum_id = 0
    with index_path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"JSONL row is not an object at {index_path}:{line_no}")
            canonical_id = str(row.get("canonical_id") or "")
            match = _ID_RE.fullmatch(canonical_id)
            if match is None or canonical_id in seen_ids:
                raise ValueError(f"invalid or duplicate canonical ID at line {line_no}: {canonical_id!r}")
            seen_ids.add(canonical_id)
            maximum_id = max(maximum_id, int(match.group("number")))
            category_code = str(row.get("category_code") or "")
            genre = str(row.get("genre") or "")
            if CATEGORY_NAMES.get(category_code) != genre:
                raise ValueError(
                    f"category mismatch at line {line_no}: {category_code!r}/{genre!r}"
                )
            target_source = str(row.get("target_source") or "")
            if not target_source:
                raise ValueError(f"missing target_source at line {line_no}")
            source = _safe_path_under(raw_root, target_source)
            actual_filename = _novel_filename(row)
            target = (
                target_root
                / "01_RawData"
                / f"{category_code}_{genre}"
                / actual_filename
            )
            if target in seen_targets:
                raise ValueError(f"duplicate human-library target: {target}")
            seen_targets.add(target)
            decision = row.get("version_decision")
            version = int(row.get("edition_version") or 1)
            if isinstance(decision, dict):
                version = int(decision.get("display_version") or version)
            tags = row.get("tags")
            items.append(
                ExportItem(
                    canonical_id=canonical_id,
                    category_code=category_code,
                    genre=genre,
                    title=str(row.get("title") or "未命名"),
                    author=str(row.get("author") or "佚名"),
                    version=version,
                    suffix=".txt",
                    source=source,
                    target=target,
                    original_filename=str(row["display_filename"]),
                    original_relative_path=target_source,
                    actual_filename=actual_filename,
                    characters=int(row.get("characters") or 0),
                    tags="、".join(str(tag) for tag in tags) if isinstance(tags, list) else "",
                    title_sort_key=str(row.get("title_sort_key") or row.get("title") or ""),
                    author_sort_key=str(row.get("author_sort_key") or row.get("author") or ""),
                )
            )
    return items, maximum_id


def parse_literature_catalog(catalog: Path) -> list[tuple[str, ...]]:
    stack: list[str] = []
    rows: list[tuple[str, ...]] = []
    seen: set[tuple[str, ...]] = set()
    with catalog.open("r", encoding="utf-8-sig") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            match = _TREE_LINE_RE.fullmatch(raw_line.rstrip("\r\n"))
            if match is None:
                continue
            depth = len(match.group("prefix")) // 4
            if depth > len(stack):
                raise ValueError(f"invalid tree depth at {catalog}:{line_no}")
            stack = stack[:depth]
            stack.append(match.group("name"))
            if stack[-1].lower().endswith(".pdf"):
                parts = tuple(stack)
                if parts in seen:
                    raise ValueError(f"duplicate literature path at {catalog}:{line_no}")
                seen.add(parts)
                rows.append(parts)
    return rows


def _looks_structural_author(value: str) -> bool:
    if value in _GENERIC_AUTHOR_COMPONENTS:
        return True
    return value.endswith("文学") or value.endswith("文学史") or value.startswith("待补")


def _literature_metadata(parts: Sequence[str]) -> tuple[str, str]:
    stem = Path(parts[-1]).stem
    first_segment = stem.split(".", 1)[0].strip() or stem
    parent = parts[-2] if len(parts) >= 2 else ""
    author = parent
    if any(marker in parent for marker in ("全集", "文集", "丛书", "套装")) and len(parts) >= 3:
        author = parts[-3]
    if _looks_structural_author(author):
        author = ""

    country_author = re.search(r"[\[【][^\]】]{1,16}[\]】](?P<author>[^\[【]+)$", first_segment)
    if country_author and country_author.start() > 0:
        embedded_author = re.sub(
            r"(?:编著|主编|编选|著)$", "", country_author.group("author")
        ).strip()
        if not author and embedded_author:
            author = embedded_author
        first_segment = first_segment[: country_author.start()].strip()

    if not author:
        for segment in stem.split(".")[1:4]:
            match = re.fullmatch(r"(.+?)(?:编著|主编|编选|著)", segment.strip())
            if match:
                author = match.group(1).strip()
                break
    title = _safe_component(first_segment, "未命名")
    author = _safe_component(author, "佚名")
    return title, author


def load_literature_items(
    literature_root: Path,
    target_root: Path,
    *,
    first_id: int,
) -> list[ExportItem]:
    literature_root = literature_root.resolve()
    catalog = literature_root / "文学_文件目录.txt"
    if not catalog.is_file():
        raise FileNotFoundError(catalog)
    rows = parse_literature_catalog(catalog)
    items: list[ExportItem] = []
    versions: defaultdict[tuple[str, str], int] = defaultdict(int)
    for offset, parts in enumerate(rows):
        canonical_id = f"id{first_id + offset:06d}"
        relative = "/".join(parts)
        source = _safe_path_under(literature_root, relative)
        title, author = _literature_metadata(parts)
        version_key = (title, author)
        versions[version_key] += 1
        version = versions[version_key]
        actual_filename = _fit_generated_filename(
            category_code=LITERATURE_CATEGORY_CODE,
            canonical_id=canonical_id,
            title=title,
            author=author,
            version=version,
            suffix=".pdf",
        )
        target = (
            target_root
            / "01_RawData"
            / f"{LITERATURE_CATEGORY_CODE}_{LITERATURE_GENRE}"
            / actual_filename
        )
        items.append(
            ExportItem(
                canonical_id=canonical_id,
                category_code=LITERATURE_CATEGORY_CODE,
                genre=LITERATURE_GENRE,
                title=title,
                author=author,
                version=version,
                suffix=".pdf",
                source=source,
                target=target,
                original_filename=parts[-1],
                original_relative_path=relative,
                actual_filename=actual_filename,
                title_sort_key=title,
                author_sort_key=author,
                literature_parts=tuple(parts),
            )
        )
    return items


def build_export_plan(
    raw_root: Path,
    literature_root: Path,
    target_root: Path,
) -> list[ExportItem]:
    source_roots = (raw_root.resolve(), literature_root.resolve())
    target_root = target_root.resolve()
    for source_root in source_roots:
        if target_root == source_root or source_root in target_root.parents:
            raise ValueError(f"target root must not be inside a source root: {target_root}")
        if target_root in source_root.parents:
            raise ValueError(f"source root must not be inside target root: {source_root}")
    raw_items, maximum_id = load_raw_items(raw_root, target_root)
    literature_items = load_literature_items(
        literature_root,
        target_root,
        first_id=maximum_id + 1,
    )
    all_ids = {item.canonical_id for item in raw_items}
    for item in literature_items:
        if item.canonical_id in all_ids:
            raise ValueError(f"literature ID collides with raw ID: {item.canonical_id}")
        all_ids.add(item.canonical_id)
    targets = [item.target for item in raw_items + literature_items]
    if len(targets) != len(set(targets)):
        raise ValueError("human-library plan contains duplicate target paths")
    return raw_items + literature_items


T = TypeVar("T")
R = TypeVar("R")


def _bounded_parallel(
    values: Iterable[T],
    function: Callable[[T], R],
    *,
    workers: int,
    window_multiplier: int = 4,
) -> Iterator[R]:
    iterator = iter(values)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        pending: dict[Future[R], None] = {}
        for _ in range(max(workers, workers * window_multiplier)):
            try:
                value = next(iterator)
            except StopIteration:
                break
            pending[executor.submit(function, value)] = None
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                del pending[future]
                yield future.result()
                try:
                    value = next(iterator)
                except StopIteration:
                    continue
                pending[executor.submit(function, value)] = None


def populate_source_sizes(items: Sequence[ExportItem], *, workers: int) -> int:
    def inspect(item: ExportItem) -> ExportItem:
        source_stat = item.source.stat()
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError(f"source is not a regular file: {item.source}")
        if source_stat.st_size <= 0:
            raise ValueError(f"source is empty: {item.source}")
        item.source_size = source_stat.st_size
        return item

    total = 0
    completed = 0
    started = time.monotonic()
    next_report = started + 10.0
    for item in _bounded_parallel(items, inspect, workers=workers):
        total += item.source_size
        completed += 1
        now = time.monotonic()
        if now >= next_report:
            print(
                json.dumps(
                    {
                        "stage": "source_stat",
                        "completed": completed,
                        "total": len(items),
                        "elapsed_seconds": round(now - started, 1),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            next_report = now + 10.0
    return total


def _copy_one(item: ExportItem) -> CopyResult:
    item.target.parent.mkdir(parents=True, exist_ok=True)
    source_stat = item.source.stat()
    if source_stat.st_size != item.source_size:
        raise RuntimeError(f"source changed after planning: {item.source}")
    try:
        target_stat = item.target.stat()
    except FileNotFoundError:
        target_stat = None
    if target_stat is not None:
        if (source_stat.st_dev, source_stat.st_ino) == (target_stat.st_dev, target_stat.st_ino):
            raise RuntimeError(f"hardlink detected; refusing target: {item.target}")
        if target_stat.st_size != source_stat.st_size:
            raise RuntimeError(f"existing target has unexpected size: {item.target}")
        return CopyResult(item=item, status="skipped")

    temporary = item.target.parent / f".{item.canonical_id}.partial"
    temporary.unlink(missing_ok=True)
    try:
        shutil.copyfile(item.source, temporary)
        temporary_stat = temporary.stat()
        if temporary_stat.st_size != source_stat.st_size:
            raise RuntimeError(f"copied size mismatch: {item.source} -> {temporary}")
        if (source_stat.st_dev, source_stat.st_ino) == (
            temporary_stat.st_dev,
            temporary_stat.st_ino,
        ):
            raise RuntimeError(f"copy unexpectedly created a hardlink: {temporary}")
        os.replace(temporary, item.target)
        return CopyResult(item=item, status="copied")
    finally:
        temporary.unlink(missing_ok=True)


def copy_items(items: Sequence[ExportItem], *, workers: int) -> dict[str, int | float]:
    total_bytes = sum(item.source_size for item in items)
    started = time.monotonic()
    next_report = started + 10.0
    completed = copied = skipped = processed_bytes = 0
    print(
        json.dumps(
            {
                "stage": "copy",
                "status": "started",
                "files": len(items),
                "bytes": total_bytes,
                "workers": workers,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    for result in _bounded_parallel(items, _copy_one, workers=workers):
        completed += 1
        processed_bytes += result.item.source_size
        if result.status == "copied":
            copied += 1
        else:
            skipped += 1
        now = time.monotonic()
        if now >= next_report or completed == len(items):
            elapsed = max(now - started, 0.001)
            rate = processed_bytes / elapsed
            remaining = max(total_bytes - processed_bytes, 0)
            print(
                json.dumps(
                    {
                        "stage": "copy",
                        "completed": completed,
                        "total": len(items),
                        "copied": copied,
                        "skipped": skipped,
                        "processed_bytes": processed_bytes,
                        "total_bytes": total_bytes,
                        "percent": round(processed_bytes * 100 / total_bytes, 3)
                        if total_bytes
                        else 100.0,
                        "mib_per_second": round(rate / (1024 * 1024), 2),
                        "eta_seconds": round(remaining / rate, 1) if rate else None,
                        "elapsed_seconds": round(elapsed, 1),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            next_report = now + 10.0
    elapsed = time.monotonic() - started
    return {
        "files": len(items),
        "bytes": total_bytes,
        "copied": copied,
        "skipped": skipped,
        "elapsed_seconds": elapsed,
    }


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.partial"
    try:
        temporary.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _novel_category_catalog(items: Sequence[ExportItem], *, genre: str) -> str:
    ordered = sorted(
        items,
        key=lambda item: (
            item.author_sort_key.casefold(),
            item.author.casefold(),
            item.title_sort_key.casefold(),
            item.title.casefold(),
            item.canonical_id,
        ),
    )
    lines = [f"{genre}目录"]
    current_author = None
    for item in ordered:
        if item.author != current_author:
            lines.append(f"├── {item.author}")
            current_author = item.author
        lines.append(f"│   ├── {item.actual_filename}")
    return "\n".join(lines) + "\n"


def _literature_catalog(items: Sequence[ExportItem]) -> str:
    tree: dict[str, dict] = {}
    for item in items:
        node = tree
        for component in item.literature_parts[:-1]:
            node = node.setdefault(component, {})
        node[item.actual_filename] = {}

    lines = ["文学目录"]

    def render(node: dict[str, dict], prefix: str) -> None:
        entries = list(node.items())
        for index, (name, children) in enumerate(entries):
            last = index == len(entries) - 1
            lines.append(f"{prefix}{'└── ' if last else '├── '}{name}")
            if children:
                render(children, prefix + ("    " if last else "│   "))

    render(tree, "")
    return "\n".join(lines) + "\n"


def _write_workbook(items: Sequence[ExportItem], target_root: Path) -> Path:
    try:
        import xlsxwriter
    except ImportError as exc:  # pragma: no cover - exercised by deployment guard
        raise RuntimeError(
            "XlsxWriter is required; install the project with the human-export extra"
        ) from exc

    catalog_root = target_root / "02_Catalog"
    catalog_root.mkdir(parents=True, exist_ok=True)
    output = catalog_root / "全部书目.xlsx"
    temporary = catalog_root / ".全部书目.xlsx.partial"
    temporary.unlink(missing_ok=True)
    temp_dir = catalog_root / ".xlsx_tmp"
    shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True)
    try:
        workbook = xlsxwriter.Workbook(
            str(temporary),
            {"constant_memory": True, "tmpdir": str(temp_dir)},
        )
        workbook.set_properties(
            {
                "title": "TaciturnHuman 全部书目",
                "comments": HUMAN_LAYOUT_VERSION,
            }
        )
        worksheet = workbook.add_worksheet("全部书目")
        header_format = workbook.add_format(
            {"bold": True, "bg_color": "#D9EAF7", "border": 1}
        )
        headers = [
            "ID",
            "分类代码",
            "分类",
            "书名",
            "作者",
            "版本",
            "格式",
            "文件名",
            "相对路径",
            "原始文件名",
            "原始路径",
            "字符数",
            "文件大小_字节",
            "标签",
            "状态",
        ]
        for column, header in enumerate(headers):
            worksheet.write(0, column, header, header_format)
        worksheet.freeze_panes(1, 0)
        worksheet.autofilter(0, 0, len(items), len(headers) - 1)
        widths = [12, 10, 10, 36, 22, 8, 10, 58, 66, 52, 70, 14, 18, 36, 12]
        for column, width in enumerate(widths):
            worksheet.set_column(column, column, width)
        for row_number, item in enumerate(items, start=1):
            relative_target = item.target.relative_to(target_root).as_posix()
            values: list[object] = [
                item.canonical_id,
                item.category_code,
                item.genre,
                item.title,
                item.author,
                item.version,
                item.suffix.lstrip(".").upper(),
                item.actual_filename,
                relative_target,
                item.original_filename,
                item.original_relative_path,
                item.characters if item.characters else "",
                item.source_size,
                item.tags,
                "已到位",
            ]
            for column, value in enumerate(values):
                worksheet.write(row_number, column, value)
        workbook.close()
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
        shutil.rmtree(temp_dir, ignore_errors=True)
    return output


def write_catalogs(items: Sequence[ExportItem], target_root: Path) -> None:
    target_root = target_root.resolve()
    category_root = target_root / "02_Catalog" / "分类目录"
    category_root.mkdir(parents=True, exist_ok=True)
    grouped: defaultdict[str, list[ExportItem]] = defaultdict(list)
    for item in items:
        grouped[item.category_code].append(item)
    unexpected_codes = set(grouped) - set(CATEGORY_NAMES)
    if unexpected_codes:
        raise ValueError(f"unexpected catalog categories: {sorted(unexpected_codes)}")
    for category_code, genre in CATEGORY_NAMES.items():
        category_items = grouped.get(category_code, [])
        text = (
            _literature_catalog(category_items)
            if category_code == LITERATURE_CATEGORY_CODE
            else _novel_category_catalog(category_items, genre=genre)
        )
        _atomic_write_text(category_root / f"{category_code}_{genre}.txt", text)
    _write_workbook(items, target_root)


def verify_export(
    items: Sequence[ExportItem],
    target_root: Path,
    *,
    workers: int = 1,
) -> dict[str, int]:
    target_root = target_root.resolve()
    counts: defaultdict[str, int] = defaultdict(int)
    bytes_by_kind: defaultdict[str, int] = defaultdict(int)
    same_inode = 0
    missing = 0
    wrong_size = 0

    def inspect(item: ExportItem) -> tuple[ExportItem, int, bool, bool, bool]:
        try:
            source_stat = item.source.stat()
            target_stat = item.target.stat()
        except FileNotFoundError:
            return item, 0, True, False, False
        return (
            item,
            target_stat.st_size,
            False,
            source_stat.st_size != target_stat.st_size,
            (source_stat.st_dev, source_stat.st_ino)
            == (target_stat.st_dev, target_stat.st_ino),
        )

    for item, target_size, is_missing, has_wrong_size, has_same_inode in _bounded_parallel(
        items,
        inspect,
        workers=max(1, workers),
    ):
        missing += int(is_missing)
        wrong_size += int(has_wrong_size)
        same_inode += int(has_same_inode)
        if is_missing:
            continue
        counts[item.category_code] += 1
        bytes_by_kind[item.content_kind] += target_size
    catalog_root = target_root / "02_Catalog"
    allowed_catalog_entries = {"全部书目.xlsx", "分类目录"}
    actual_catalog_entries = {path.name for path in catalog_root.iterdir()}
    category_files = list((catalog_root / "分类目录").glob("*.txt"))
    if missing or wrong_size or same_inode:
        raise RuntimeError(
            f"verification failed: missing={missing}, wrong_size={wrong_size}, same_inode={same_inode}"
        )
    if actual_catalog_entries != allowed_catalog_entries:
        raise RuntimeError(f"unexpected permanent catalog entries: {actual_catalog_entries}")
    if len(category_files) != len(CATEGORY_NAMES):
        raise RuntimeError(f"expected 23 category catalogs, found {len(category_files)}")
    if not (catalog_root / "全部书目.xlsx").is_file():
        raise RuntimeError("missing 全部书目.xlsx")
    return {
        "files": len(items),
        "bytes": sum(bytes_by_kind.values()),
        "novel_files": sum(counts[code] for code in CATEGORY_NAMES if code != "22"),
        "literature_files": counts["22"],
        "novel_bytes": bytes_by_kind["小说TXT"],
        "literature_bytes": bytes_by_kind["文学PDF"],
        "category_catalogs": len(category_files),
    }


def select_smoke_items(items: Sequence[ExportItem], per_category: int) -> list[ExportItem]:
    grouped: defaultdict[str, list[ExportItem]] = defaultdict(list)
    for item in items:
        if len(grouped[item.category_code]) < per_category:
            grouped[item.category_code].append(item)
    return [item for code in sorted(grouped) for item in grouped[code]]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build the independent, human-readable Taciturn novel library."
    )
    parser.add_argument("--raw-root", type=Path, default=DEFAULT_RAW_ROOT)
    parser.add_argument("--literature-root", type=Path, default=DEFAULT_LITERATURE_ROOT)
    parser.add_argument("--target-root", type=Path, default=DEFAULT_TARGET_ROOT)
    parser.add_argument("--workers", type=int, default=available_cpu_count())
    parser.add_argument(
        "--mode",
        choices=("plan", "copy", "catalog", "verify", "all"),
        default="all",
    )
    parser.add_argument(
        "--smoke-per-category",
        type=int,
        default=0,
        help="Restrict the run to the first N items in each category.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=20_000_000_000,
        help="Free-space reserve retained after all missing copies.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    workers = max(1, int(args.workers))
    raw_root = args.raw_root.resolve()
    literature_root = args.literature_root.resolve()
    target_root = args.target_root.resolve()
    items = build_export_plan(raw_root, literature_root, target_root)
    if args.smoke_per_category:
        items = select_smoke_items(items, max(1, args.smoke_per_category))
    raw_items = sum(item.category_code != "22" for item in items)
    literature_items = len(items) - raw_items
    print(
        json.dumps(
            {
                "stage": "plan",
                "layout_version": HUMAN_LAYOUT_VERSION,
                "target": str(target_root),
                "files": len(items),
                "novels": raw_items,
                "literature": literature_items,
                "first_literature_id": next(
                    (item.canonical_id for item in items if item.category_code == "22"),
                    None,
                ),
                "last_literature_id": next(
                    (
                        item.canonical_id
                        for item in reversed(items)
                        if item.category_code == "22"
                    ),
                    None,
                ),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if args.mode == "plan":
        return 0

    total_bytes = populate_source_sizes(items, workers=workers)
    if args.mode in {"copy", "all"}:
        target_root.parent.mkdir(parents=True, exist_ok=True)
        missing_bytes = sum(
            item.source_size
            for item in items
            if not item.target.exists()
        )
        free_bytes = shutil.disk_usage(target_root.parent).free
        if missing_bytes + args.minimum_free_bytes > free_bytes:
            raise RuntimeError(
                f"insufficient free space: missing={missing_bytes}, free={free_bytes}, "
                f"reserve={args.minimum_free_bytes}"
            )
        print(
            json.dumps(
                {
                    "stage": "space_gate",
                    "source_bytes": total_bytes,
                    "missing_bytes": missing_bytes,
                    "free_bytes": free_bytes,
                    "minimum_free_bytes": args.minimum_free_bytes,
                }
            ),
            flush=True,
        )
        copy_items(items, workers=workers)
    if args.mode in {"catalog", "all"}:
        # A successful copy/all pass has already checked every target. A
        # catalog-only recovery run still needs a target gate, but performs it
        # in parallel instead of issuing 281k sequential remote stat calls.
        if args.mode == "catalog":
            def validate_catalog_target(item: ExportItem) -> ExportItem:
                if not item.target.is_file() or item.target.stat().st_size != item.source_size:
                    raise RuntimeError(
                        f"cannot catalog missing or incomplete target: {item.target}"
                    )
                return item

            for _item in _bounded_parallel(
                items,
                validate_catalog_target,
                workers=workers,
            ):
                pass
        print(json.dumps({"stage": "catalog", "status": "started"}), flush=True)
        write_catalogs(items, target_root)
        print(json.dumps({"stage": "catalog", "status": "complete"}), flush=True)
    if args.mode in {"verify", "all"}:
        result = verify_export(items, target_root, workers=workers)
        print(
            json.dumps({"stage": "verify", "status": "complete", **result}),
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
