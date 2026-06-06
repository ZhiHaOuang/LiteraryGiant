#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path


DEFAULT_ENCODINGS = (
    "utf-8",
    "utf-8-sig",
    "gb18030",
    "gbk",
    "big5",
    "utf-16",
    "utf-16-le",
    "utf-16-be",
)


@dataclass(frozen=True)
class DecodeResult:
    encoding: str
    text: str
    score: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Incrementally preprocess txt files from textM into RawData, "
            "skip unchanged files, and maintain shared states.json."
        )
    )
    parser.add_argument(
        "-i",
        "--input-dir",
        type=Path,
        default=Path("TextM"),
        help="Input directory that contains source txt files. Default: TextM",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("RawData"),
        help="Output directory for normalized txt files. Default: RawData",
    )
    parser.add_argument(
        "-r",
        "--retrieval-dir",
        type=Path,
        default=Path("retrieval_file"),
        help="Directory that stores a copied states.json. Default: retrieval_file",
    )
    parser.add_argument(
        "--target-encoding",
        default="utf-8",
        help="Target encoding for output txt files. Default: utf-8",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=4,
        help="Zero-padding width for output file names. Default: 4",
    )
    return parser.parse_args()


def iter_txt_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        path
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == ".txt"
    )


def score_text(text: str) -> float:
    if not text:
        return -1e9

    total = len(text)
    printable = sum(ch.isprintable() or ch in "\r\n\t" for ch in text)
    cjk = sum("\u4e00" <= ch <= "\u9fff" for ch in text)
    replacement = text.count("\ufffd")
    null_bytes = text.count("\x00")
    control = sum(
        unicodedata.category(ch).startswith("C") and ch not in "\r\n\t"
        for ch in text
    )
    latin1_noise = sum(1 for ch in text if 0x80 <= ord(ch) <= 0xFF)

    return (
        printable / total * 80
        + cjk / total * 120
        - replacement * 50
        - null_bytes * 20
        - control * 5
        - latin1_noise / total * 20
    )


def decode_with_best_guess(raw: bytes) -> DecodeResult:
    candidates: list[DecodeResult] = []
    tried: set[str] = set()

    for encoding in DEFAULT_ENCODINGS:
        if encoding in tried:
            continue
        tried.add(encoding)
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        candidates.append(DecodeResult(encoding=encoding, text=text, score=score_text(text)))

    if not candidates:
        text = raw.decode("latin-1")
        return DecodeResult(encoding="latin-1", text=text, score=score_text(text))

    return max(candidates, key=lambda item: item.score)


def count_non_whitespace_chars(text: str) -> int:
    return sum(not ch.isspace() for ch in text)


def count_lines(text: str) -> int:
    return text.count("\n") + (1 if text and not text.endswith("\n") else 0)


def bytes_to_mb(size_bytes: int) -> float:
    return round(size_bytes / (1024 * 1024), 3)


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def empty_states(width: int) -> dict[str, object]:
    return {
        "name": "states",
        "run_count": 0,
        "next_index": f"{1:0{width}d}",
        "books": [],
    }


def normalize_book_record(book: dict[str, object], output_dir: Path | None = None) -> dict[str, object]:
    content_hash = book.get("content_hash")
    if content_hash is None and output_dir is not None and book.get("target_name"):
        target_path = output_dir / str(book["target_name"])
        if target_path.exists():
            content_hash = hashlib.sha256(target_path.read_bytes()).hexdigest()
    return {
        "index": book["index"],
        "source_name": book["source_name"],
        "target_name": book["target_name"],
        "preprocess_done": bool(book.get("preprocess_done", True)),
        "detected_encoding": book.get("detected_encoding"),
        "content_hash": content_hash,
        "char_count": int(book.get("char_count", 0)),
        "line_count": int(book.get("line_count", 0)),
        "file_size_mb": float(book.get("file_size_mb", 0.0)),
    }


def build_book_record(
    *,
    index: int,
    source_path: Path,
    raw: bytes,
    detected_encoding: str,
    text: str,
    target_path: Path,
) -> dict[str, object]:
    return {
        "index": f"{index:04d}",
        "source_name": source_path.name,
        "target_name": target_path.name,
        "preprocess_done": True,
        "detected_encoding": detected_encoding,
        "content_hash": sha256_bytes(raw),
        "char_count": count_non_whitespace_chars(text),
        "line_count": count_lines(text),
        "file_size_mb": bytes_to_mb(target_path.stat().st_size),
    }


def load_legacy_states(path: Path) -> dict[str, object]:
    legacy = read_json(path)

    if legacy.get("name") == "states":
        return {
            "name": "states",
            "run_count": int(legacy.get("run_count", 0)),
            "next_index": legacy.get("next_index", "0001"),
            "books": [normalize_book_record(book, path.parent) for book in legacy.get("books", [])],
        }

    books: list[dict[str, object]] = []

    if legacy.get("name") == "preprocess":
        books = [normalize_book_record(book, path.parent) for book in legacy.get("books", [])]
        next_index = legacy.get("next_index", "0001")
        run_count = int(legacy.get("run_count", 0))
    else:
        books = [
            {
                "index": item["index"],
                "source_name": item["source_name"],
                "target_name": item["target_name"],
                "preprocess_done": True,
                "detected_encoding": item.get("detected_encoding"),
                "content_hash": item.get("content_hash"),
                "char_count": int(item.get("char_count", 0)),
                "line_count": int(item.get("line_count", 0)),
                "file_size_mb": float(item.get("file_size_mb", 0.0)),
            }
            for item in legacy.get("completed_files", [])
        ]
        next_index = f"{int(legacy.get('next_index', 1)):04d}"
        run_count = int(legacy.get("run_count", 0))

    return {
        "name": "states",
        "run_count": run_count,
        "next_index": next_index,
        "books": sorted(books, key=lambda item: int(item["index"])),
    }


def load_states(
    *,
    raw_states_path: Path,
    retrieval_states_path: Path,
    legacy_state_path: Path,
    legacy_preprocess_raw_path: Path,
    legacy_preprocess_retrieval_path: Path,
    width: int,
) -> dict[str, object]:
    for candidate in (
        raw_states_path,
        retrieval_states_path,
        legacy_preprocess_raw_path,
        legacy_preprocess_retrieval_path,
        legacy_state_path,
    ):
        if candidate.exists():
            return load_legacy_states(candidate)
    return empty_states(width)


def should_skip(
    *,
    existing: dict[str, object] | None,
    source_path: Path,
    raw: bytes,
    output_dir: Path,
    decoded: DecodeResult,
) -> bool:
    if existing is None:
        return False

    target_path = output_dir / str(existing["target_name"])
    if not target_path.exists():
        return False

    if existing.get("source_name") != source_path.name:
        return False
    if existing.get("content_hash") != sha256_bytes(raw):
        return False
    if int(existing.get("char_count", -1)) != count_non_whitespace_chars(decoded.text):
        return False
    if int(existing.get("line_count", -1)) != count_lines(decoded.text):
        return False
    if float(existing.get("file_size_mb", -1.0)) != bytes_to_mb(target_path.stat().st_size):
        return False

    return True


def build_summary(
    *,
    states: dict[str, object],
    source_files: list[Path],
    input_dir: Path,
    output_dir: Path,
    retrieval_states_path: Path,
    target_encoding: str,
    processed_count: int,
    skipped_count: int,
) -> dict[str, object]:
    books = list(states["books"])
    source_names = {path.name for path in source_files}
    completed_count = sum(1 for book in books if book["source_name"] in source_names)
    total_source_files = len(source_files)
    pending_count = total_source_files - completed_count
    progress_percent = round(
        (completed_count / total_source_files * 100) if total_source_files else 100.0,
        3,
    )

    return {
        "name": "1_preprocess",
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "states_file": str(output_dir / "states.json"),
        "retrieval_states_file": str(retrieval_states_path),
        "target_encoding": target_encoding,
        "run_count": states["run_count"],
        "next_index": states["next_index"],
        "total_source_files": total_source_files,
        "completed_source_files": completed_count,
        "pending_source_files": pending_count,
        "progress_percent": progress_percent,
        "processed_count_this_run": processed_count,
        "skipped_count_this_run": skipped_count,
        "total_char_count": sum(int(book["char_count"]) for book in books),
        "total_file_size_mb": round(
            sum(float(book["file_size_mb"]) for book in books),
            3,
        ),
    }


def cleanup_legacy_files(paths: list[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


def run() -> None:
    args = parse_args()
    input_dir = args.input_dir.resolve()
    output_dir = args.output_dir.resolve()
    retrieval_dir = args.retrieval_dir.resolve()

    raw_states_path = output_dir / "states.json"
    retrieval_states_path = retrieval_dir / "states.json"
    summary_path = output_dir / "1_preprocess.json"
    legacy_state_path = retrieval_dir / "state.json"
    legacy_preprocess_raw_path = output_dir / "preprocess.json"
    legacy_preprocess_retrieval_path = retrieval_dir / "preprocess.json"

    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")
    if not input_dir.is_dir():
        raise NotADirectoryError(f"Input path is not a directory: {input_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    retrieval_dir.mkdir(parents=True, exist_ok=True)

    source_files = iter_txt_files(input_dir)
    if not source_files:
        raise FileNotFoundError(f"No txt files found under: {input_dir}")

    states = load_states(
        raw_states_path=raw_states_path,
        retrieval_states_path=retrieval_states_path,
        legacy_state_path=legacy_state_path,
        legacy_preprocess_raw_path=legacy_preprocess_raw_path,
        legacy_preprocess_retrieval_path=legacy_preprocess_retrieval_path,
        width=args.width,
    )

    books = sorted(
        [normalize_book_record(book, output_dir) for book in states.get("books", [])],
        key=lambda item: int(item["index"]),
    )
    states["name"] = "states"
    states["books"] = books

    book_map = {book["source_name"]: book for book in books}
    hash_map = {
        book["content_hash"]: book
        for book in books
        if book.get("content_hash")
    }
    run_count = int(states.get("run_count", 0)) + 1
    next_index = int(states.get("next_index", f"{1:0{args.width}d}"))

    processed_count = 0
    skipped_count = 0

    for source_path in source_files:
        raw = source_path.read_bytes()
        decoded = decode_with_best_guess(raw)
        content_hash = sha256_bytes(raw)
        existing = book_map.get(source_path.name)

        if should_skip(
            existing=existing,
            source_path=source_path,
            raw=raw,
            output_dir=output_dir,
            decoded=decoded,
        ):
            skipped_count += 1
            continue

        existing_by_hash = hash_map.get(content_hash)
        if existing is None and existing_by_hash is not None:
            skipped_count += 1
            continue

        if existing is None:
            index = next_index
            target_name = f"{index:0{args.width}d}.txt"
            next_index += 1
        else:
            index = int(existing["index"])
            target_name = str(existing["target_name"])

        target_path = output_dir / target_name
        target_path.write_text(decoded.text, encoding=args.target_encoding)
        book_map[source_path.name] = build_book_record(
            index=index,
            source_path=source_path,
            raw=raw,
            detected_encoding=decoded.encoding,
            text=decoded.text,
            target_path=target_path,
        )
        hash_map[content_hash] = book_map[source_path.name]
        processed_count += 1

    states["books"] = sorted(book_map.values(), key=lambda item: int(item["index"]))
    states["run_count"] = run_count
    states["next_index"] = f"{next_index:0{args.width}d}"

    write_json(raw_states_path, states)
    shutil.copy2(raw_states_path, retrieval_states_path)

    summary = build_summary(
        states=states,
        source_files=source_files,
        input_dir=input_dir,
        output_dir=output_dir,
        retrieval_states_path=retrieval_states_path,
        target_encoding=args.target_encoding,
        processed_count=processed_count,
        skipped_count=skipped_count,
    )
    write_json(summary_path, summary)

    cleanup_legacy_files(
        [
            legacy_state_path,
            legacy_preprocess_raw_path,
            legacy_preprocess_retrieval_path,
        ]
    )
    for step_file in retrieval_dir.glob("step_*.json"):
        step_file.unlink(missing_ok=True)

    print(f"Processed this run: {processed_count}")
    print(f"Skipped this run: {skipped_count}")
    print(f"Next index: {states['next_index']}")
    print(f"States file: {raw_states_path}")
    print(f"Retrieval states file: {retrieval_states_path}")
    print(f"Summary file: {summary_path}")


if __name__ == "__main__":
    run()
