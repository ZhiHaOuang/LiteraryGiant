"""Verified, resumable cold storage for the two expanded TaciturnRaw stages.

Only the standard library is required. Existing human ZIPs supply raw text;
all other files, including raw metadata, are stored in independent TAR.GZ shards.
Deletion is opt-in and uses the verified manifest, never recursive tree removal.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterator

MANIFEST = ".cold-storage-manifest.json"
CHUNK = 1024 * 1024
ID_RE = re.compile(r"(?:^|_)id(\d{6})(?:_|\.)")
BOOK_RE = re.compile(r"id\d{6}\Z")
EVENT_LOG: Path | None = None
EVENT_LOCK = threading.Lock()


def emit(event: str, **values: Any) -> None:
    line = json.dumps({"time": time.time(), "event": event, **values}, ensure_ascii=False)
    with EVENT_LOCK:
        print(line, flush=True)
        if EVENT_LOG is not None:
            with EVENT_LOG.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")


def signature(path: Path) -> list[int]:
    value = path.lstat()
    return [value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns]


def safe_path(root: Path, name: str) -> Path:
    parts = PurePosixPath(name)
    if not name or parts.is_absolute() or ".." in parts.parts or "\\" in name:
        raise ValueError(f"Unsafe relative path: {name!r}")
    if str(parts) != name or name == ".":
        raise ValueError(f"Non-canonical relative path: {name!r}")
    return root.joinpath(*parts.parts)


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sha256_stream(handle: BinaryIO) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while data := handle.read(CHUNK):
        digest.update(data)
        size += len(data)
    return digest.hexdigest(), size


def sha256_file(path: Path) -> str:
    with path.open("rb") as handle:
        return sha256_stream(handle)[0]


class HashingReader:
    def __init__(self, handle: BinaryIO):
        self.handle = handle
        self.digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        value = self.handle.read(size)
        self.digest.update(value)
        return value


def walk_paths(root: Path, names: list[str], *, missing_ok: bool = False) -> Iterator[tuple[str, list[int]]]:
    stack = list(reversed(names))
    while stack:
        name = stack.pop()
        path = safe_path(root, name)
        try:
            snap = signature(path)
        except FileNotFoundError:
            if missing_ok:
                continue
            raise
        if not (stat.S_ISDIR(snap[2]) or stat.S_ISREG(snap[2])):
            raise ValueError(f"Refusing symlink or special file: {path}")
        yield name, snap
        if stat.S_ISDIR(snap[2]):
            with os.scandir(path) as children:
                stack.extend(sorted((f"{name}/{child.name}" for child in children), reverse=True))


def build_plan(raw: Path, cleaned: Path, human: Path, output: Path, books_per_shard: int = 50) -> dict[str, Any]:
    if books_per_shard < 1:
        raise ValueError("books_per_shard must be positive")
    raw, cleaned, human, output = [p.resolve() for p in (raw, cleaned, human, output)]
    for source in (raw, cleaned, human):
        if not source.is_dir() or output == source or source in output.parents or output in source.parents:
            raise ValueError(f"Invalid or overlapping source/output: {source}, {output}")
    output.mkdir(parents=True, exist_ok=False)
    database = output / "plan.sqlite3"
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA cache_size=-4096")
        connection.executescript("""
            CREATE TABLE raw_books(id TEXT PRIMARY KEY, source TEXT UNIQUE, parent TEXT UNIQUE,
                                   zip TEXT, member TEXT, bytes INTEGER);
            CREATE TABLE cleaned_books(name TEXT PRIMARY KEY);
            CREATE TABLE tasks(id TEXT PRIMARY KEY, kind TEXT, paths TEXT, external TEXT, bytes INTEGER);
            CREATE INDEX raw_zip ON raw_books(zip);
        """)
        loaded = 0
        with (raw / "index.jsonl").open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                identifier, source = row["canonical_id"], row["target_source"]
                if not BOOK_RE.fullmatch(identifier):
                    raise ValueError(f"Invalid raw ID: {identifier}")
                path = safe_path(raw, source)
                if path.parent.name != identifier:
                    raise ValueError(f"Raw ID/path mismatch: {source}")
                connection.execute("INSERT INTO raw_books(id,source,parent) VALUES(?,?,?)",
                                   (identifier, source, path.parent.relative_to(raw).as_posix()))
                loaded += 1
                if loaded % 50000 == 0:
                    emit("plan_raw_index", books=loaded)
        zip_count = pdf_count = 0
        for archive in sorted(human.glob("*/*.zip")):
            zip_count += 1
            with zipfile.ZipFile(archive) as zipped:
                seen: set[str] = set()
                for info in zipped.infolist():
                    if info.is_dir():
                        continue
                    safe_path(human, info.filename)
                    if info.filename in seen:
                        raise ValueError(f"Duplicate ZIP member: {archive}/{info.filename}")
                    seen.add(info.filename)
                    if info.filename.startswith("22_"):
                        pdf_count += 1
                        continue
                    match = ID_RE.search(PurePosixPath(info.filename).name)
                    if match is None:
                        raise ValueError(f"Missing ID in ZIP member: {info.filename}")
                    identifier = "id" + match.group(1)
                    found = connection.execute("SELECT zip FROM raw_books WHERE id=?", (identifier,)).fetchone()
                    if found is None or found[0] is not None:
                        raise ValueError(f"Extra or duplicate ZIP ID: {identifier}")
                    connection.execute("UPDATE raw_books SET zip=?,member=?,bytes=? WHERE id=?",
                                       (archive.relative_to(human).as_posix(), info.filename, info.file_size, identifier))
            if zip_count % 20 == 0:
                emit("plan_zip_coverage", archives=zip_count)
        if connection.execute("SELECT count(*) FROM raw_books WHERE zip IS NULL").fetchone()[0]:
            raise ValueError("Human ZIPs do not cover every raw book")

        root_paths: list[str] = []
        known_categories = {row[0].split("/")[0] for row in connection.execute("SELECT parent FROM raw_books")}
        actual_books = 0
        for item in raw.iterdir():
            if item.name not in known_categories:
                root_paths.append(item.name)
                continue
            if item.is_symlink() or not item.is_dir():
                raise ValueError(f"Invalid raw category: {item}")
            with os.scandir(item) as entries:
                for entry in entries:
                    relative = f"{item.name}/{entry.name}"
                    found = connection.execute("SELECT 1 FROM raw_books WHERE parent=?", (relative,)).fetchone()
                    if found:
                        if not entry.is_dir(follow_symlinks=False):
                            raise ValueError(f"Invalid raw book directory: {relative}")
                        actual_books += 1
                        if actual_books % 50000 == 0:
                            emit("plan_raw_directories", books=actual_books)
                    else:
                        if BOOK_RE.fullmatch(entry.name):
                            raise ValueError(f"Unindexed raw book must be investigated: {relative}")
                        root_paths.append(relative)
        raw_count = connection.execute("SELECT count(*) FROM raw_books").fetchone()[0]
        if raw_count != actual_books:
            raise ValueError("Raw index and directory inventory disagree")
        connection.execute("INSERT INTO tasks VALUES(?,?,?,?,?)",
                           ("raw-root", "raw", json.dumps(sorted(root_paths)), "{}", 0))
        for index, (zip_name,) in enumerate(connection.execute("SELECT DISTINCT zip FROM raw_books ORDER BY zip").fetchall()):
            rows = connection.execute("SELECT source,parent,member,bytes FROM raw_books WHERE zip=? ORDER BY id", (zip_name,)).fetchall()
            external = {source: {"zip": zip_name, "member": member, "size": size} for source, _, member, size in rows}
            connection.execute("INSERT INTO tasks VALUES(?,?,?,?,?)",
                               (f"raw-{index:04d}", "raw", json.dumps([r[1] for r in rows]),
                                json.dumps(external, ensure_ascii=False), sum(r[3] for r in rows)))

        clean_root_paths: list[str] = []
        with os.scandir(cleaned) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False) and BOOK_RE.fullmatch(entry.name):
                    connection.execute("INSERT INTO cleaned_books VALUES(?)", (entry.name,))
                else:
                    clean_root_paths.append(entry.name)
        connection.execute("INSERT INTO tasks VALUES(?,?,?,?,?)",
                           ("cleaned-root", "cleaned", json.dumps(sorted(clean_root_paths)), "{}", 0))
        cursor = connection.execute("SELECT name FROM cleaned_books ORDER BY name")
        group = 0
        while rows := cursor.fetchmany(books_per_shard):
            connection.execute("INSERT INTO tasks VALUES(?,?,?,?,?)",
                               (f"cleaned-{group:05d}", "cleaned", json.dumps([r[0] for r in rows]), "{}", 0))
            group += 1
        connection.commit()
        summary = {"format": 1, "raw": str(raw), "cleaned": str(cleaned), "human": str(human),
                   "output": str(output), "raw_books": raw_count, "human_zip_files": zip_count,
                   "literature_pdf_files": pdf_count,
                   "raw_text_bytes": connection.execute("SELECT sum(bytes) FROM raw_books").fetchone()[0],
                   "cleaned_books": connection.execute("SELECT count(*) FROM cleaned_books").fetchone()[0],
                   "books_per_cleaned_shard": books_per_shard, "cleaned_shards": group,
                   "raw_categories": sorted(known_categories),
                   "root_identities": {"raw": signature(raw)[:3], "cleaned": signature(cleaned)[:3],
                                       "human": signature(human)[:3]},
                   "raw_category_identities": {name: signature(raw / name)[:3] for name in known_categories}}
    finally:
        connection.close()
    summary["plan_sha256"] = sha256_file(database)
    atomic_json(output / "plan.json", summary)
    (output / "archives").mkdir()
    (output / "receipts").mkdir()
    emit("plan_complete", **summary)
    return summary


def build_archive(root: Path, paths: list[str], external: dict[str, Any], archive: Path, task: str,
                  minimum_free_bytes: int = 20 * 1024**3) -> None:
    if archive.exists():
        raise FileExistsError(archive)
    temporary = archive.with_name(f".{archive.name}.{os.getpid()}.partial")
    entries: list[dict[str, Any]] = []
    started = last_report = time.monotonic()
    total_bytes = 0
    with temporary.open("xb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", compresslevel=1, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as output:
                for name, snap in walk_paths(root, paths):
                    if name == MANIFEST:
                        raise ValueError(f"Reserved archive filename: {name}")
                    if time.monotonic() - last_report > 20 or not entries:
                        free = shutil.disk_usage(archive.parent).free
                        if free < minimum_free_bytes:
                            raise RuntimeError(f"Free-space gate reached: {free} bytes")
                        emit("archive_progress", task=task, entries=len(entries), source_bytes=total_bytes,
                             elapsed_seconds=round(time.monotonic() - started), free_bytes=free)
                        last_report = time.monotonic()
                    row: dict[str, Any] = {"path": name, "signature": snap}
                    if stat.S_ISDIR(snap[2]):
                        row["kind"] = "directory"
                        info = tarfile.TarInfo(name)
                        info.type, info.mode, info.mtime = tarfile.DIRTYPE, stat.S_IMODE(snap[2]), snap[4] // 10**9
                        output.addfile(info)
                    else:
                        row["kind"] = "external" if name in external else "file"
                        descriptor = os.open(safe_path(root, name), os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(descriptor, "rb") as source:
                            if row["kind"] == "external":
                                digest, length = sha256_stream(source)
                                row.update(external[name])
                                if length != snap[3] or row["size"] != length:
                                    raise ValueError(f"ZIP/source size mismatch: {name}")
                            else:
                                info = tarfile.TarInfo(name)
                                info.size, info.mode, info.mtime = snap[3], stat.S_IMODE(snap[2]), snap[4] // 10**9
                                reader = HashingReader(source)
                                output.addfile(info, reader)
                                digest = reader.digest.hexdigest()
                            row["sha256"] = digest
                        if signature(safe_path(root, name)) != snap:
                            raise RuntimeError(f"Source changed while archiving: {name}")
                        total_bytes += snap[3]
                    entries.append(row)
                if set(external) - {r["path"] for r in entries if r["kind"] == "external"}:
                    raise ValueError("An indexed raw source file is missing")
                payload = json.dumps({"format": 1, "task": task, "source_root": str(root),
                                      "roots": paths, "entries": entries}, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")
                info = tarfile.TarInfo(MANIFEST)
                info.size = len(payload)
                output.addfile(info, io.BytesIO(payload))
        destination.flush()
        os.fsync(destination.fileno())
    # Link publication cannot overwrite an existing, possibly verified archive.
    os.link(temporary, archive)
    temporary.unlink()
    sync_directory(archive.parent)
    emit("archive_written", task=task, files=sum(r["kind"] != "directory" for r in entries),
         source_bytes=total_bytes, archive_bytes=archive.stat().st_size)


def verify_archive(archive: Path, human: Path) -> tuple[dict[str, Any], dict[str, list[int]]]:
    before = signature(archive)
    actual: dict[str, tuple[str, int, str]] = {}
    payload: dict[str, Any] | None = None
    with gzip.open(archive, "rb") as compressed:
        with tarfile.open(fileobj=compressed, mode="r|") as source:
            for member in source:
                if member.name == MANIFEST:
                    if payload is not None or not member.isfile() or member.size > 128 * 1024**2:
                        raise ValueError("Invalid archive manifest")
                    handle = source.extractfile(member)
                    assert handle is not None
                    payload = json.load(handle)
                    continue
                safe_path(Path("/validation"), member.name)
                if payload is not None or member.name in actual:
                    raise ValueError("Duplicate member or content after manifest")
                if member.isdir():
                    actual[member.name] = ("directory", 0, "")
                elif member.isfile():
                    handle = source.extractfile(member)
                    assert handle is not None
                    digest, length = sha256_stream(handle)
                    actual[member.name] = ("file", length, digest)
                else:
                    raise ValueError(f"Unsupported TAR member: {member.name}")
        while compressed.read(CHUNK):
            pass  # Consume the gzip trailer so its CRC is checked as well.
    if payload is None or payload.get("format") != 1:
        raise ValueError("Missing/unsupported manifest")
    expected: set[str] = set()
    external_rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in payload["entries"]:
        name = row["path"]
        safe_path(Path("/validation"), name)
        if name in seen:
            raise ValueError(f"Duplicate manifest path: {name}")
        seen.add(name)
        if row["kind"] == "external":
            external_rows.append(row)
            continue
        expected.add(name)
        wanted = ("directory", 0, "") if row["kind"] == "directory" else ("file", row["signature"][3], row["sha256"])
        if actual.get(name) != wanted:
            raise ValueError(f"Archive content mismatch: {name}")
    if set(actual) != expected:
        raise ValueError("Archive inventory mismatch")
    guards: dict[str, list[int]] = {}
    with contextlib.ExitStack() as stack:
        opened: dict[str, zipfile.ZipFile] = {}
        for index, row in enumerate(external_rows, 1):
            name = row["zip"]
            zipped_path = safe_path(human, name)
            if name not in opened:
                guards[name] = signature(zipped_path)
                opened[name] = stack.enter_context(zipfile.ZipFile(zipped_path))
            with opened[name].open(row["member"]) as handle:
                digest, length = sha256_stream(handle)
            if digest != row["sha256"] or length != row["signature"][3]:
                raise ValueError(f"Human ZIP differs from raw source: {row['path']}")
            if index % 100 == 0:
                emit("raw_verified", task=payload["task"], books=index, total=len(external_rows))
    for name, snap in guards.items():
        if signature(safe_path(human, name)) != snap:
            raise RuntimeError(f"ZIP changed during verification: {name}")
    if signature(archive) != before:
        raise RuntimeError("Archive changed during verification")
    emit("archive_verified", task=payload["task"], entries=len(payload["entries"]))
    return payload, guards


def retire_sources(root: Path, payload: dict[str, Any], archive: Path, human: Path,
                   receipt_path: Path, receipt: dict[str, Any]) -> None:
    if str(root) != payload["source_root"] or not receipt.get("verified"):
        raise ValueError("Unverified or wrong-root deletion request")
    if signature(archive) != receipt["archive_signature"]:
        raise RuntimeError("Verified archive has changed")
    for name, snap in receipt["zip_signatures"].items():
        if signature(safe_path(human, name)) != snap:
            raise RuntimeError(f"Verified human ZIP has changed: {name}")
    expected = {row["path"]: row for row in payload["entries"]}
    resume = bool(receipt.get("deletion_started"))
    current: set[str] = set()
    for name, snap in walk_paths(root, payload["roots"], missing_ok=resume):
        current.add(name)
        row = expected.get(name)
        if row is None:
            raise RuntimeError(f"New source file/directory appeared: {name}")
        wanted = row["signature"]
        changed = snap[:3] != wanted[:3] if row["kind"] == "directory" else snap != wanted
        if changed:
            raise RuntimeError(f"Source changed since verification: {name}")
    if not resume and current != set(expected):
        raise RuntimeError("Source inventory changed since verification")
    receipt["deletion_started"] = True
    atomic_json(receipt_path, receipt)
    files = directories = 0
    for row in payload["entries"]:
        if row["kind"] == "directory":
            continue
        path = safe_path(root, row["path"])
        try:
            snap = signature(path)
        except FileNotFoundError:
            if resume:
                continue
            raise
        if snap != row["signature"]:
            raise RuntimeError(f"Source changed immediately before unlink: {path}")
        path.unlink()
        files += 1
        if files % 10000 == 0:
            emit("retire_progress", task=payload["task"], removed_files=files)
    directory_rows = [r for r in payload["entries"] if r["kind"] == "directory"]
    for row in sorted(directory_rows, key=lambda r: r["path"].count("/"), reverse=True):
        path = safe_path(root, row["path"])
        try:
            if signature(path)[:3] != row["signature"][:3]:
                raise RuntimeError(f"Directory replaced before removal: {path}")
            path.rmdir()  # A concurrent new file prevents removal; it is never discarded.
            directories += 1
        except FileNotFoundError:
            if not resume:
                raise
    receipt.update(deleted=True, deleted_files=files, deleted_directories=directories)
    atomic_json(receipt_path, receipt)
    emit("retired", task=payload["task"], removed_files=files, removed_directories=directories)


def process_task(config: dict[str, Any], task: tuple[Any, ...], *, delete: bool,
                 minimum_free_bytes: int) -> dict[str, Any]:
    name, kind, paths_json, external_json, _ = task
    output, root, human = Path(config["output"]), Path(config[kind]), Path(config["human"])
    for key in (kind, "human"):
        if signature(Path(config[key]))[:3] != config["root_identities"][key]:
            raise RuntimeError(f"Source root replaced: {config[key]}")
    archive = output / "archives" / f"{name}.tar.gz"
    receipt_path = output / "receipts" / f"{name}.json"
    previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    if previous.get("deleted"):
        if signature(archive) != previous["archive_signature"]:
            raise RuntimeError(f"Completed archive changed: {archive}")
        for zipped, snap in previous["zip_signatures"].items():
            if signature(safe_path(human, zipped)) != snap:
                raise RuntimeError(f"Completed human ZIP changed: {zipped}")
        emit("task_already_complete", task=name)
        return previous
    if not archive.exists():
        if kind == "raw":
            for path in json.loads(paths_json):
                category = path.split("/")[0]
                wanted = config["raw_category_identities"].get(category)
                if wanted is not None and signature(root / category)[:3] != wanted:
                    raise RuntimeError(f"Raw category replaced: {category}")
        build_archive(root, json.loads(paths_json), json.loads(external_json), archive, name, minimum_free_bytes)
    payload, guards = verify_archive(archive, human)
    if payload["task"] != name or payload["source_root"] != str(root) or payload["roots"] != json.loads(paths_json):
        raise ValueError("Archive does not belong to this planned task")
    receipt = {"task": name, "verified": True, "archive_signature": signature(archive),
               "archive_sha256": sha256_file(archive), "zip_signatures": guards,
               "deletion_started": previous.get("deletion_started", False), "deleted": False,
               "entries": len(payload["entries"]), "archive_bytes": archive.stat().st_size,
               "file_count": sum(r["kind"] != "directory" for r in payload["entries"]),
               "source_bytes": sum(r["signature"][3] for r in payload["entries"] if r["kind"] != "directory")}
    atomic_json(receipt_path, receipt)
    if delete:
        if kind == "raw":
            for path in payload["roots"]:
                category = path.split("/")[0]
                wanted = config["raw_category_identities"].get(category)
                if wanted is not None and signature(root / category)[:3] != wanted:
                    raise RuntimeError(f"Raw category replaced: {category}")
        retire_sources(root, payload, archive, human, receipt_path, receipt)
    return receipt


def restore_archive(archive: Path, human: Path, destination: Path) -> None:
    payload, _ = verify_archive(archive, human)
    expected = {row["path"]: row for row in payload["entries"]}
    destination = destination.absolute()
    destination.mkdir(parents=True, exist_ok=True)

    def target(name: str) -> Path:
        path = safe_path(destination, name)
        for parent in [destination, *path.relative_to(destination).parents]:
            candidate = parent if parent.is_absolute() else destination / parent
            if candidate.is_symlink():
                raise ValueError(f"Refusing restoration through symlink: {candidate}")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            if member.name == MANIFEST:
                continue
            path = target(member.name)
            if member.isdir():
                if path.is_symlink():
                    raise ValueError(f"Symlink destination: {path}")
                path.mkdir(exist_ok=True)
            else:
                handle = source.extractfile(member)
                assert handle is not None
                with path.open("xb") as output:
                    reader = HashingReader(handle)
                    shutil.copyfileobj(reader, output, CHUNK)
                if reader.digest.hexdigest() != expected[member.name]["sha256"]:
                    raise RuntimeError(f"Restoration checksum mismatch: {member.name}")
    with contextlib.ExitStack() as stack:
        opened: dict[str, zipfile.ZipFile] = {}
        for row in payload["entries"]:
            if row["kind"] != "external":
                continue
            zipped = row["zip"]
            if zipped not in opened:
                opened[zipped] = stack.enter_context(zipfile.ZipFile(safe_path(human, zipped)))
            with opened[zipped].open(row["member"]) as source, target(row["path"]).open("xb") as output:
                reader = HashingReader(source)
                shutil.copyfileobj(reader, output, CHUNK)
            if reader.digest.hexdigest() != row["sha256"]:
                raise RuntimeError(f"Restoration checksum mismatch: {row['path']}")
    emit("restored", task=payload["task"], destination=str(destination))


def run_plan(output: Path, kind: str, *, delete: bool, maximum: int, minimum_free_bytes: int,
             workers: int = 1) -> None:
    if workers < 1:
        raise ValueError("workers must be positive")
    output = output.resolve()
    config = json.loads((output / "plan.json").read_text())
    if str(output) != config["output"] or sha256_file(output / "plan.sqlite3") != config["plan_sha256"]:
        raise ValueError("Plan moved or changed")
    with (output / "run.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        worker = {"pid": os.getpid(), "started": time.time(), "state": "running", "kind": kind,
                  "delete_verified": delete, "workers": workers}
        atomic_json(output / "worker.json", worker)
        outcome = "failed"
        connection = sqlite3.connect(f"file:{output / 'plan.sqlite3'}?mode=ro", uri=True)
        connection.execute("PRAGMA cache_size=-4096")
        try:
            completed = 0
            for stage in (["raw", "cleaned"] if kind == "all" else [kind]):
                root_task = connection.execute("SELECT * FROM tasks WHERE id=?", (stage + "-root",)).fetchone()
                assert root_task is not None
                process_task(config, root_task, delete=False, minimum_free_bytes=minimum_free_bytes)
                tasks = connection.execute("SELECT * FROM tasks WHERE kind=? AND id!=? ORDER BY bytes,id", (stage, stage + "-root"))
                exhausted = False
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    pending = set()
                    while True:
                        while not exhausted and len(pending) < workers and (not maximum or completed + len(pending) < maximum):
                            task = tasks.fetchone()
                            if task is None:
                                exhausted = True
                                break
                            receipt_path = output / "receipts" / f"{task[0]}.json"
                            prior = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
                            if prior.get("deleted") or (not delete and prior.get("verified")):
                                archive = output / "archives" / f"{task[0]}.tar.gz"
                                if signature(archive) != prior["archive_signature"]:
                                    raise RuntimeError(f"Completed archive changed: {archive}")
                                for zipped, snap in prior["zip_signatures"].items():
                                    if signature(safe_path(Path(config["human"]), zipped)) != snap:
                                        raise RuntimeError(f"Completed human ZIP changed: {zipped}")
                                continue
                            pending.add(executor.submit(process_task, config, task, delete=delete,
                                                        minimum_free_bytes=minimum_free_bytes))
                        if not pending:
                            break
                        done, pending = wait(pending, return_when=FIRST_COMPLETED)
                        for future in done:
                            future.result()
                            completed += 1
                if maximum and completed >= maximum:
                    emit("batch_limit", completed_shards=completed)
                    outcome = "batch_limit"
                    return
                if delete:
                    process_task(config, root_task, delete=True, minimum_free_bytes=minimum_free_bytes)
                    root = Path(config[stage])
                    if stage == "raw":
                        for category in config["raw_categories"]:
                            path = safe_path(root, category)
                            if path.exists():
                                path.rmdir()
                    leftovers = {p.name for p in root.iterdir()} - {".gitkeep", "ARCHIVED.md"}
                    if leftovers:
                        raise RuntimeError(f"Unplanned files remain in {root}: {sorted(leftovers)[:10]}")
                    (root / ".gitkeep").touch(exist_ok=True)
                    marker = root / "ARCHIVED.md"
                    if not marker.exists():
                        marker.write_text(f"# 已转入冷存储\n\n此目录的展开文件已逐文件校验后归档。\n\n"
                                          f"归档计划：`{output}`\n阶段：`{stage}`\n"
                                          "恢复方法见项目 `docs/library_cold_storage.md`。\n", encoding="utf-8")
                    emit("stage_retired", stage=stage, root=str(root))
            emit("run_complete", delete=delete, kind=kind)
            outcome = "complete"
        finally:
            connection.close()
            worker.update(state=outcome, finished=time.time())
            atomic_json(output / "worker.json", worker)


def start_plan(output: Path, kind: str, *, delete: bool, maximum: int,
               minimum_free_gib: float, workers: int) -> subprocess.Popen:
    output = output.resolve()
    if not (output / "plan.json").is_file():
        raise FileNotFoundError(output / "plan.json")
    # The worker takes this same lock for its entire lifetime. A concurrent
    # launcher can at worst spawn a worker that exits before touching sources.
    with (output / "run.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    command = [sys.executable, "-B", "-m", "scripts.cold_store_library", "run",
               "--output", str(output), "--kind", kind, "--workers", str(workers),
               "--max-shards", str(maximum), "--minimum-free-gib", str(minimum_free_gib)]
    if delete:
        command.append("--delete-verified")
    log = output / "console.log"
    with log.open("ab", buffering=0) as handle:
        process = subprocess.Popen(command, cwd=Path(__file__).resolve().parent.parent,
                                   stdin=subprocess.DEVNULL, stdout=handle,
                                   stderr=subprocess.STDOUT, start_new_session=True)
    atomic_json(output / f"launch-{process.pid}.json", {"pid": process.pid, "started": time.time(),
                                                        "command": command, "log": str(log)})
    emit("launched", pid=process.pid, console_log=str(log))
    return process


def main() -> int:
    global EVENT_LOG
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--raw", type=Path, required=True)
    plan.add_argument("--cleaned", type=Path, required=True)
    plan.add_argument("--human", type=Path, required=True)
    plan.add_argument("--output", type=Path, required=True)
    plan.add_argument("--books-per-shard", type=int, default=50)
    for name in ("run", "start"):
        run = commands.add_parser(name)
        run.add_argument("--output", type=Path, required=True)
        run.add_argument("--kind", choices=("raw", "cleaned", "all"), default="all")
        run.add_argument("--delete-verified", action="store_true")
        run.add_argument("--max-shards", type=int, default=0)
        run.add_argument("--minimum-free-gib", type=float, default=20)
        run.add_argument("--workers", type=int, default=1)
    restore = commands.add_parser("restore")
    restore.add_argument("--archive", type=Path, required=True)
    restore.add_argument("--human", type=Path, required=True)
    restore.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "plan":
        build_plan(args.raw, args.cleaned, args.human, args.output, args.books_per_shard)
    elif args.command in {"run", "start"}:
        if args.max_shards < 0 or args.minimum_free_gib < 0 or args.workers < 1:
            parser.error("Limits must be non-negative")
        if args.command == "start":
            start_plan(args.output, args.kind, delete=args.delete_verified, maximum=args.max_shards,
                       minimum_free_gib=args.minimum_free_gib, workers=args.workers)
        else:
            EVENT_LOG = args.output.resolve() / "events.jsonl"
            run_plan(args.output, args.kind, delete=args.delete_verified, maximum=args.max_shards,
                     minimum_free_bytes=int(args.minimum_free_gib * 1024**3), workers=args.workers)
    else:
        restore_archive(args.archive, args.human, args.destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
