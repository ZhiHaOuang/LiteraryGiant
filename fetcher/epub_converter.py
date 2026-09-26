"""Safe, auditable EPUB to UTF-8 plain-text conversion.

The converter deliberately does not extract an EPUB onto the filesystem.  It
validates the ZIP container, follows the OPF spine for reading order, and
returns a structured inspection result before callers decide whether to write
or delete anything.
"""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import stat as stat_module
import unicodedata
import uuid
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Iterator, Mapping, Sequence
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from bs4 import (
    BeautifulSoup,
    Comment,
    Declaration,
    Doctype,
    NavigableString,
    ProcessingInstruction,
    Tag,
)


EPUB_MIMETYPE = b"application/epub+zip"
_FONT_OBFUSCATION_ALGORITHMS = {
    "http://www.idpf.org/2008/embedding",
    "http://ns.adobe.com/pdf/enc#RC",
}
_FONT_SUFFIXES = {".otf", ".ttf", ".woff", ".woff2"}
_XML_ENTITY_RE = re.compile(br"<!\s*ENTITY\b", re.I)
_XML_DOCTYPE_START_RE = re.compile(br"<!\s*DOCTYPE\b", re.I)
_SAFE_EXTERNAL_DOCTYPE_RE = re.compile(
    br"""
    <!\s*DOCTYPE\s+[A-Za-z_:][A-Za-z0-9_.:-]*
    (?:\s+(?:
        SYSTEM\s+(?:"[^"]*"|'[^']*')
        |
        PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')
    ))?\s*>
    """,
    re.I | re.X,
)
_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:[/\\]")
_GENERIC_SECTION_TITLE_RE = re.compile(
    r"^(?:chapter|section|cover|intro|contents?|title|toc|目录|封面|正文)\s*\d*$",
    re.I,
)
_HORIZONTAL_SPACE_RE = re.compile(r"[^\S\r\n]+")
_IGNORED_HTML_TAGS = {
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "head",
    "rt",
    "rp",
}
_BLOCK_HTML_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul",
}


@dataclass(frozen=True, slots=True)
class EpubLimits:
    """Resource limits applied before any member is decompressed."""

    max_members: int = 20_000
    max_total_uncompressed_bytes: int = 1024 * 1024 * 1024
    max_entry_uncompressed_bytes: int = 256 * 1024 * 1024
    max_compression_ratio: float = 200.0
    compression_ratio_min_bytes: int = 1024 * 1024
    max_xml_bytes: int = 4 * 1024 * 1024
    max_spine_items: int = 20_000
    min_meaningful_chars: int = 100


@dataclass(frozen=True, slots=True)
class SourceIdentity:
    path: str
    size_bytes: int
    mtime_ns: int
    sha256: str
    device_id: int
    inode: int

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class EpubChapter:
    order: int
    source_href: str
    title: str
    title_source: str
    text: str
    meaningful_chars: int
    image_count: int

    def metadata_dict(self) -> dict[str, object]:
        return {
            "order": self.order,
            "source_href": self.source_href,
            "title": self.title,
            "title_source": self.title_source,
            "meaningful_chars": self.meaningful_chars,
            "image_count": self.image_count,
        }


@dataclass(frozen=True, slots=True)
class EpubDocument:
    identity: SourceIdentity
    opf_path: str
    title: str
    authors: tuple[str, ...]
    language: str
    identifier: str
    chapters: tuple[EpubChapter, ...]
    spine_items: int
    total_meaningful_chars: int
    total_images: int
    warnings: tuple[str, ...] = ()

    def iter_rendered_text(self) -> Iterator[str]:
        """Yield deterministic no-BOM text without joining the whole book twice."""

        header = [f"书名：{self.title}"]
        if self.authors:
            header.append(f"作者：{'、'.join(self.authors)}")
        if self.language:
            header.append(f"语言：{self.language}")
        first = True
        header_text = "\n".join(header).replace("\ufeff", "").strip()
        if header_text:
            yield header_text
            first = False
        for chapter in self.chapters:
            body = chapter.text.strip()
            if chapter.title:
                body = f"{chapter.title}\n\n{body}" if body else chapter.title
            body = body.replace("\ufeff", "").strip()
            if not body:
                continue
            if not first:
                yield "\n\n"
            yield body
            first = False
        yield "\n"

    def render_text(self) -> str:
        """Render deterministic UTF-8 text (the returned string has no BOM)."""

        return "".join(self.iter_rendered_text())

    def metadata_dict(self, *, include_chapters: bool = True) -> dict[str, object]:
        payload: dict[str, object] = {
            "opf_path": self.opf_path,
            "title": self.title,
            "authors": list(self.authors),
            "language": self.language,
            "identifier": self.identifier,
            "spine_items": self.spine_items,
            "chapter_count": len(self.chapters),
            "total_meaningful_chars": self.total_meaningful_chars,
            "total_images": self.total_images,
            "warnings": list(self.warnings),
        }
        if include_chapters:
            payload["chapters"] = [chapter.metadata_dict() for chapter in self.chapters]
        return payload


class EpubRejection(ValueError):
    """A content validation failure, safe to record as a rejected EPUB."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


@dataclass(frozen=True, slots=True)
class EpubInspection:
    identity: SourceIdentity
    document: EpubDocument | None = None
    rejection_code: str = ""
    rejection_reason: str = ""
    rejection_details: Mapping[str, object] = field(default_factory=dict)

    @property
    def accepted(self) -> bool:
        return self.document is not None

    def to_dict(
        self,
        *,
        status: str | None = None,
        output_path: str | None = None,
        output_sha256: str | None = None,
        include_chapters: bool = True,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema": "literary-giant-epub-conversion-v1",
            "status": status or ("convertible" if self.accepted else "rejected"),
            "source": self.identity.to_dict(),
        }
        if self.document is not None:
            payload["epub"] = self.document.metadata_dict(
                include_chapters=include_chapters
            )
        else:
            payload["rejection"] = {
                "code": self.rejection_code,
                "reason": self.rejection_reason,
                "details": dict(self.rejection_details),
            }
        if output_path is not None:
            payload["output_path"] = output_path
        if output_sha256 is not None:
            payload["output_sha256"] = output_sha256
        return payload


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _absolute_path(path: str | Path) -> Path:
    """Return an absolute path without dereferencing its final symlink."""

    return Path(os.path.abspath(os.fspath(Path(path).expanduser())))


def snapshot_epub(path: str | Path) -> SourceIdentity:
    source = _absolute_path(path)
    before = source.lstat()
    if stat_module.S_ISLNK(before.st_mode) or not stat_module.S_ISREG(before.st_mode):
        raise EpubRejection("unsafe_source", f"EPUB source is not a regular file: {source}")
    digest = _sha256_path(source)
    after = source.lstat()
    if not stat_module.S_ISREG(after.st_mode) or (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise EpubRejection("source_changed", f"EPUB changed while hashing: {source}")
    return SourceIdentity(
        path=str(source),
        size_bytes=after.st_size,
        mtime_ns=after.st_mtime_ns,
        sha256=digest,
        device_id=after.st_dev,
        inode=after.st_ino,
    )


def source_identity_unchanged(
    identity: SourceIdentity, *, verify_digest: bool = True
) -> bool:
    path = Path(identity.path)
    try:
        current = path.lstat()
    except FileNotFoundError:
        return False
    if stat_module.S_ISLNK(current.st_mode) or not stat_module.S_ISREG(current.st_mode):
        return False
    if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
        identity.device_id,
        identity.inode,
        identity.size_bytes,
        identity.mtime_ns,
    ):
        return False
    if verify_digest and _sha256_path(path) != identity.sha256:
        return False
    after = path.lstat()
    return stat_module.S_ISREG(after.st_mode) and (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ) == (
        identity.device_id,
        identity.inode,
        identity.size_bytes,
        identity.mtime_ns,
    )


def _member_key(value: str) -> str:
    if not value or "\x00" in value:
        raise EpubRejection("unsafe_path", f"Unsafe empty/NUL ZIP member: {value!r}")
    normalized = value.replace("\\", "/")
    if normalized.startswith("/") or _DRIVE_PATH_RE.match(normalized):
        raise EpubRejection("unsafe_path", f"Absolute ZIP member path: {value!r}")
    parts = PurePosixPath(normalized).parts
    if ".." in parts:
        raise EpubRejection("unsafe_path", f"Parent traversal ZIP member: {value!r}")
    key = posixpath.normpath(normalized)
    if key in {"", "."} or key.startswith("../"):
        raise EpubRejection("unsafe_path", f"Unsafe ZIP member path: {value!r}")
    return key


def _is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0o170000
    return mode == stat_module.S_IFLNK


def _validate_zip(
    archive: zipfile.ZipFile,
    limits: EpubLimits,
) -> tuple[dict[str, str], list[str]]:
    infos = archive.infolist()
    if len(infos) > limits.max_members:
        raise EpubRejection(
            "zip_bomb",
            f"EPUB has too many ZIP members: {len(infos)} > {limits.max_members}",
        )
    member_map: dict[str, str] = {}
    total_uncompressed = 0
    total_compressed = 0
    for info in infos:
        key = _member_key(info.filename)
        if key in member_map:
            raise EpubRejection("unsafe_path", f"Duplicate normalized ZIP path: {key}")
        member_map[key] = info.filename
        if _is_zip_symlink(info):
            raise EpubRejection("unsafe_path", f"Symlink ZIP member is not allowed: {key}")
        if info.flag_bits & 0x1:
            raise EpubRejection("zip_encrypted", f"Encrypted ZIP member: {key}")
        if info.file_size > limits.max_entry_uncompressed_bytes:
            raise EpubRejection(
                "zip_bomb",
                f"ZIP member is too large: {key} ({info.file_size} bytes)",
            )
        if info.file_size >= limits.compression_ratio_min_bytes:
            ratio = info.file_size / max(1, info.compress_size)
            if ratio > limits.max_compression_ratio:
                raise EpubRejection(
                    "zip_bomb",
                    f"Suspicious compression ratio for {key}: {ratio:.1f}",
                )
        total_uncompressed += info.file_size
        total_compressed += info.compress_size
        if total_uncompressed > limits.max_total_uncompressed_bytes:
            raise EpubRejection(
                "zip_bomb",
                "EPUB uncompressed size exceeds configured limit",
                details={"total_uncompressed_bytes": total_uncompressed},
            )
    warnings: list[str] = []
    if "mimetype" not in member_map:
        warnings.append("missing-mimetype-member")
    else:
        mimetype = _read_member(archive, member_map, "mimetype", maximum=256).strip()
        if mimetype != EPUB_MIMETYPE:
            warnings.append("nonstandard-mimetype")
    # Do not call ZipFile.testzip(): it decompresses every asset and rejects an
    # otherwise readable book when an unused cover/font/image has a bad CRC.
    # CRC and compression support are still checked by ZipFile when each
    # required metadata, navigation, or spine member is actually consumed.
    if total_compressed == 0 and total_uncompressed:
        raise EpubRejection("zip_bomb", "EPUB has non-empty data with zero compressed size")
    return member_map, warnings


def _read_member(
    archive: zipfile.ZipFile,
    member_map: Mapping[str, str],
    key: str,
    *,
    maximum: int | None = None,
) -> bytes:
    actual = member_map.get(key)
    if actual is None:
        raise EpubRejection("malformed_epub", f"Required EPUB member is missing: {key}")
    info = archive.getinfo(actual)
    if maximum is not None and info.file_size > maximum:
        raise EpubRejection("zip_bomb", f"EPUB metadata member is too large: {key}")
    try:
        return archive.read(actual)
    except NotImplementedError:
        # Unsupported compression is an operational conversion error, not a
        # content-validation verdict that authorizes source deletion.
        raise
    except (RuntimeError, zipfile.BadZipFile, EOFError) as exc:
        raise EpubRejection("corrupt_zip", f"Could not read EPUB member {key}: {exc}") from exc


def _safe_xml(data: bytes, *, label: str, limits: EpubLimits) -> ElementTree.Element:
    if len(data) > limits.max_xml_bytes:
        raise EpubRejection("zip_bomb", f"XML metadata is too large: {label}")
    if _XML_ENTITY_RE.search(data):
        raise EpubRejection("unsafe_xml", f"ENTITY is not allowed in {label}")
    # EPUB2 NCX files commonly carry the standard external NISO DOCTYPE.
    # ElementTree does not need it; strip only a declaration without an
    # internal subset.  Any unmatched/complex DOCTYPE remains a rejection.
    data_without_doctype = _SAFE_EXTERNAL_DOCTYPE_RE.sub(b"", data)
    if _XML_DOCTYPE_START_RE.search(data_without_doctype):
        raise EpubRejection("unsafe_xml", f"Unsafe DOCTYPE is not allowed in {label}")
    try:
        return ElementTree.fromstring(data_without_doctype)
    except ElementTree.ParseError as exc:
        raise EpubRejection("malformed_epub", f"Invalid XML in {label}: {exc}") from exc


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _attribute(element: ElementTree.Element, name: str) -> str:
    for key, value in element.attrib.items():
        if _local_name(key) == name:
            return value
    return ""


def _first_text(root: ElementTree.Element, local_name: str) -> str:
    for element in root.iter():
        if _local_name(element.tag) == local_name:
            value = " ".join("".join(element.itertext()).split())
            if value:
                return value
    return ""


def _resolved_reference(base_member: str, href: str) -> str:
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc:
        raise EpubRejection("malformed_epub", f"External EPUB spine reference: {href}")
    raw_path = unquote(parsed.path).replace("\\", "/")
    if not raw_path:
        raise EpubRejection("malformed_epub", f"Empty EPUB reference: {href}")
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(base_member), raw_path))
    if joined.startswith("/") or joined == ".." or joined.startswith("../"):
        raise EpubRejection("unsafe_path", f"EPUB reference escapes archive root: {href}")
    return _member_key(joined)


def _inspect_encryption(
    archive: zipfile.ZipFile,
    member_map: Mapping[str, str],
    limits: EpubLimits,
) -> list[str]:
    encryption_key = "META-INF/encryption.xml"
    if encryption_key not in member_map:
        return []
    root = _safe_xml(
        _read_member(archive, member_map, encryption_key, maximum=limits.max_xml_bytes),
        label=encryption_key,
        limits=limits,
    )
    encrypted_items: list[tuple[str, str]] = []
    for encrypted_data in root.iter():
        if _local_name(encrypted_data.tag) != "EncryptedData":
            continue
        algorithm = ""
        uri = ""
        for child in encrypted_data.iter():
            local = _local_name(child.tag)
            if local == "EncryptionMethod":
                algorithm = _attribute(child, "Algorithm")
            elif local == "CipherReference":
                uri = _attribute(child, "URI")
        encrypted_items.append((algorithm, uri))
    if not encrypted_items:
        return ["empty-encryption-metadata"]
    for algorithm, uri in encrypted_items:
        suffix = Path(urlsplit(uri).path).suffix.lower()
        if algorithm not in _FONT_OBFUSCATION_ALGORITHMS or suffix not in _FONT_SUFFIXES:
            raise EpubRejection(
                "drm_encrypted",
                f"EPUB contains encrypted/DRM content: {uri or '<unknown>'}",
                details={"algorithm": algorithm, "uri": uri},
            )
    return ["font-obfuscation-present"]


def _toc_title_map(
    archive: zipfile.ZipFile,
    member_map: Mapping[str, str],
    manifest: Mapping[str, tuple[str, str, str]],
    limits: EpubLimits,
) -> dict[str, str]:
    titles: dict[str, str] = {}
    for _item_id, (member, media_type, properties) in manifest.items():
        if media_type == "application/x-dtbncx+xml":
            root = _safe_xml(
                _read_member(archive, member_map, member, maximum=limits.max_xml_bytes),
                label=member,
                limits=limits,
            )
            for nav_point in root.iter():
                if _local_name(nav_point.tag) != "navPoint":
                    continue
                label = ""
                target = ""
                for child in nav_point.iter():
                    local = _local_name(child.tag)
                    if local == "navLabel" and not label:
                        label = " ".join("".join(child.itertext()).split())
                    elif local == "content" and not target:
                        target = _attribute(child, "src")
                if label and target:
                    titles.setdefault(_resolved_reference(member, target), label)
        elif "nav" in properties.split():
            blob = _read_member(archive, member_map, member)
            soup = BeautifulSoup(blob, "html.parser")
            for anchor in soup.find_all("a", href=True):
                label = _visible_text(anchor)
                href = str(anchor["href"])
                parsed = urlsplit(href)
                # EPUB3 navigation documents may legitimately contain
                # external or same-document links that are not spine titles.
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                if label:
                    titles.setdefault(_resolved_reference(member, href), label)
    return titles


_NON_TEXT_HTML_NODES = (Comment, Doctype, Declaration, ProcessingInstruction)


def _walk_html(node: Tag | NavigableString, output: list[str]) -> None:
    """Iteratively extract visible text, including from deeply nested HTML."""

    # Each frame holds a child iterator plus whether the parent needs a
    # trailing block newline.  This stays O(depth), even for a body containing
    # millions of sibling nodes.
    stack: list[tuple[Iterator[object], bool]] = [(iter((node,)), False)]
    while stack:
        children, close_block = stack[-1]
        try:
            current = next(children)
        except StopIteration:
            stack.pop()
            if close_block:
                output.append("\n")
            continue
        if isinstance(current, _NON_TEXT_HTML_NODES):
            continue
        if isinstance(current, NavigableString):
            output.append(str(current))
            continue
        if not isinstance(current, Tag):
            continue
        name = (current.name or "").lower()
        if name in _IGNORED_HTML_TAGS:
            continue
        if name == "br":
            output.append("\n")
            continue
        is_block = name in _BLOCK_HTML_TAGS
        if is_block:
            output.append("\n")
        stack.append((iter(current.children), is_block))


def _visible_text(node: Tag) -> str:
    tokens: list[str] = []
    _walk_html(node, tokens)
    return " ".join(_normalize_plain_text("".join(tokens)).split())


def _normalize_plain_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value).replace("\ufeff", "")
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    value = _HORIZONTAL_SPACE_RE.sub(" ", value)
    lines: list[str] = []
    blank = False
    for raw_line in value.split("\n"):
        line = raw_line.strip()
        if not line:
            if lines and not blank:
                lines.append("")
            blank = True
            continue
        lines.append(line)
        blank = False
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def _meaningful_chars(value: str) -> int:
    return sum(ch.isalnum() for ch in value)


def _canonical_title(value: str) -> str:
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", value).casefold())


def _is_generic_title(value: str) -> bool:
    return not value or bool(_GENERIC_SECTION_TITLE_RE.fullmatch(value.strip()))


def _html_section(blob: bytes, *, toc_title: str, member: str, order: int) -> EpubChapter:
    soup = BeautifulSoup(blob, "html.parser")
    heading = ""
    for tag in soup.find_all(("h1", "h2", "h3", "h4", "h5", "h6")):
        heading = _visible_text(tag)
        if heading:
            break
    document_title = ""
    if soup.title is not None:
        document_title = _visible_text(soup.title)
    title = heading
    title_source = "heading" if heading else ""
    if not title.strip() and toc_title.strip():
        title, title_source = toc_title, "toc"
    elif _is_generic_title(title) and not _is_generic_title(toc_title):
        title, title_source = toc_title, "toc"
    if not title.strip() and document_title.strip():
        title, title_source = document_title, "document-title"
    elif _is_generic_title(title) and not _is_generic_title(document_title):
        title, title_source = document_title, "document-title"
    if not title.strip():
        title, title_source = f"section_{order:04d}", "generated"

    body = soup.body or soup
    image_count = len(body.find_all(("img", "svg", "image", "picture", "object")))
    tokens: list[str] = []
    _walk_html(body, tokens)
    text = _normalize_plain_text("".join(tokens))
    lines = text.splitlines()
    leading_titles = {_canonical_title(title), _canonical_title(heading)} - {""}
    if lines and _canonical_title(lines[0]) in leading_titles:
        text = _normalize_plain_text("\n".join(lines[1:]))
    return EpubChapter(
        order=order,
        source_href=member,
        title=title,
        title_source=title_source,
        text=text,
        meaningful_chars=_meaningful_chars(text),
        image_count=image_count,
    )


def _load_document(
    source: Path,
    identity: SourceIdentity,
    limits: EpubLimits,
) -> EpubDocument:
    try:
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, EOFError) as exc:
        raise EpubRejection("corrupt_zip", f"Not a readable EPUB ZIP: {exc}") from exc
    with archive:
        member_map, warnings = _validate_zip(archive, limits)
        warnings.extend(_inspect_encryption(archive, member_map, limits))
        container_key = "META-INF/container.xml"
        container = _safe_xml(
            _read_member(archive, member_map, container_key, maximum=limits.max_xml_bytes),
            label=container_key,
            limits=limits,
        )
        rootfiles = [
            _attribute(element, "full-path")
            for element in container.iter()
            if _local_name(element.tag) == "rootfile" and _attribute(element, "full-path")
        ]
        if not rootfiles:
            raise EpubRejection("malformed_epub", "EPUB container has no OPF rootfile")
        opf_key = _member_key(unquote(rootfiles[0]).replace("\\", "/"))
        opf = _safe_xml(
            _read_member(archive, member_map, opf_key, maximum=limits.max_xml_bytes),
            label=opf_key,
            limits=limits,
        )

        title = _first_text(opf, "title") or source.stem
        creators: list[tuple[str, str]] = []
        for element in opf.iter():
            if _local_name(element.tag) != "creator":
                continue
            value = " ".join("".join(element.itertext()).split())
            if value:
                creators.append((value, _attribute(element, "role").lower()))
        author_values = [value for value, role in creators if role in {"", "aut", "author"}]
        if not author_values:
            author_values = [value for value, _role in creators]
        authors = tuple(dict.fromkeys(author_values))
        language = _first_text(opf, "language")
        identifier = _first_text(opf, "identifier")

        manifest: dict[str, tuple[str, str, str]] = {}
        for element in opf.iter():
            if _local_name(element.tag) != "item":
                continue
            item_id = _attribute(element, "id")
            href = _attribute(element, "href")
            if not item_id or not href:
                continue
            if item_id in manifest:
                raise EpubRejection("malformed_epub", f"Duplicate manifest id: {item_id}")
            member = _resolved_reference(opf_key, href)
            manifest[item_id] = (
                member,
                _attribute(element, "media-type").lower(),
                _attribute(element, "properties").lower(),
            )
        spine_ids: list[str] = []
        spine_item_count = 0
        skipped_non_linear = 0
        for element in opf.iter():
            if _local_name(element.tag) == "itemref":
                item_id = _attribute(element, "idref")
                if item_id:
                    spine_item_count += 1
                if item_id and _attribute(element, "linear").strip().casefold() == "no":
                    skipped_non_linear += 1
                elif item_id:
                    spine_ids.append(item_id)
        if not spine_ids:
            raise EpubRejection("malformed_epub", "EPUB OPF has no spine items")
        if spine_item_count > limits.max_spine_items:
            raise EpubRejection("zip_bomb", "EPUB spine item count exceeds configured limit")
        if skipped_non_linear:
            warnings.append(f"linear-no-spine-items-skipped:{skipped_non_linear}")
        try:
            toc_titles = _toc_title_map(archive, member_map, manifest, limits)
        except EpubRejection as exc:
            # Navigation labels improve chapter names but are not required to
            # recover spine text.  A corrupt/malformed optional NCX/nav file
            # must not authorize deletion of an otherwise readable novel.
            if exc.code not in {"corrupt_zip", "malformed_epub"}:
                raise
            warnings.append(f"optional-navigation-skipped:{exc.code}")
            toc_titles = {}

        chapters: list[EpubChapter] = []
        total_images = 0
        skipped_empty = 0
        for spine_order, item_id in enumerate(spine_ids, start=1):
            manifest_item = manifest.get(item_id)
            if manifest_item is None:
                raise EpubRejection(
                    "malformed_epub", f"Spine idref is missing from manifest: {item_id}"
                )
            member, media_type, _properties = manifest_item
            if member not in member_map:
                raise EpubRejection("malformed_epub", f"Spine document is missing: {member}")
            if media_type not in {"application/xhtml+xml", "text/html"} and not member.lower().endswith(
                (".html", ".htm", ".xhtml")
            ):
                if media_type.startswith("image/") or member.lower().endswith(
                    (".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp")
                ):
                    total_images += 1
                warnings.append(f"non-html-spine-item:{member}")
                continue
            chapter = _html_section(
                _read_member(archive, member_map, member),
                toc_title=toc_titles.get(member, ""),
                member=member,
                order=spine_order,
            )
            total_images += chapter.image_count
            if chapter.meaningful_chars == 0:
                skipped_empty += 1
                continue
            chapters.append(chapter)
        if skipped_empty:
            warnings.append(f"empty-spine-items-skipped:{skipped_empty}")
        total_chars = sum(chapter.meaningful_chars for chapter in chapters)
        if total_chars < limits.min_meaningful_chars:
            code = "image_only" if total_images else "no_valid_text"
            raise EpubRejection(
                code,
                "EPUB has no sufficiently substantial readable spine text",
                details={
                    "meaningful_chars": total_chars,
                    "images": total_images,
                    "spine_items": len(spine_ids),
                },
            )
        return EpubDocument(
            identity=identity,
            opf_path=opf_key,
            title=title,
            authors=authors,
            language=language,
            identifier=identifier,
            chapters=tuple(chapters),
            spine_items=len(spine_ids),
            total_meaningful_chars=total_chars,
            total_images=total_images,
            warnings=tuple(dict.fromkeys(warnings)),
        )


def inspect_epub(
    path: str | Path,
    *,
    limits: EpubLimits | None = None,
) -> EpubInspection:
    """Inspect and decode one EPUB without writing or deleting files."""

    source = _absolute_path(path)
    try:
        identity = snapshot_epub(source)
    except EpubRejection:
        raise
    try:
        document = _load_document(source, identity, limits or EpubLimits())
        after = source.lstat()
        if not stat_module.S_ISREG(after.st_mode) or (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ) != (
            identity.device_id,
            identity.inode,
            identity.size_bytes,
            identity.mtime_ns,
        ):
            raise EpubRejection("source_changed", f"EPUB changed while inspecting: {source}")
        return EpubInspection(identity=identity, document=document)
    except EpubRejection as exc:
        return EpubInspection(
            identity=identity,
            rejection_code=exc.code,
            rejection_reason=str(exc),
            rejection_details=exc.details,
        )
    except (zipfile.BadZipFile, EOFError, UnicodeError, ValueError) as exc:
        return EpubInspection(
            identity=identity,
            rejection_code="malformed_epub",
            rejection_reason=f"{type(exc).__name__}: {exc}",
        )


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _regular_file_matches(path: Path, *, size_bytes: int, sha256: str) -> bool:
    try:
        current = path.lstat()
    except FileNotFoundError:
        return False
    return (
        stat_module.S_ISREG(current.st_mode)
        and current.st_size == size_bytes
        and _sha256_path(path) == sha256
    )


def write_utf8_text(document: EpubDocument, destination: str | Path) -> dict[str, object]:
    """Atomically publish one strict UTF-8, no-BOM TXT without overwriting."""

    target = _absolute_path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        raise FileExistsError(f"Refusing to write through TXT destination symlink: {target}")
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        digest_builder = hashlib.sha256()
        byte_count = 0
        with temporary.open("xb") as handle:
            for text in document.iter_rendered_text():
                # Chapter strings are already resident in the inspected
                # document, but encode/write them in bounded pieces so one
                # large chapter does not allocate another book-sized bytes.
                for offset in range(0, len(text), 1024 * 1024):
                    encoded = text[offset : offset + 1024 * 1024].encode("utf-8")
                    if byte_count == 0 and encoded.startswith(b"\xef\xbb\xbf"):
                        raise AssertionError("converter generated a UTF-8 BOM")
                    handle.write(encoded)
                    digest_builder.update(encoded)
                    byte_count += len(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        digest = digest_builder.hexdigest()
        if target.exists():
            if not _regular_file_matches(
                target, size_bytes=byte_count, sha256=digest
            ):
                raise FileExistsError(f"TXT destination exists with different content: {target}")
            return {
                "status": "already_present",
                "path": str(target),
                "sha256": digest,
                "bytes": byte_count,
            }
        try:
            os.link(temporary, target)
        except FileExistsError:
            if not _regular_file_matches(
                target, size_bytes=byte_count, sha256=digest
            ):
                raise FileExistsError(f"TXT destination appeared with different content: {target}")
        temporary.unlink(missing_ok=True)
        _fsync_directory(target.parent)
        return {
            "status": "converted",
            "path": str(target),
            "sha256": digest,
            "bytes": byte_count,
        }
    finally:
        temporary.unlink(missing_ok=True)


def delete_rejected_epub(inspection: EpubInspection) -> None:
    """Delete a rejected source only after its recorded identity is reverified."""

    if inspection.accepted:
        raise ValueError("Refusing to delete an accepted EPUB as a rejected source")
    if not source_identity_unchanged(inspection.identity):
        raise RuntimeError(f"Rejected EPUB changed after inspection: {inspection.identity.path}")
    source = Path(inspection.identity.path)
    source.unlink()
    _fsync_directory(source.parent)


def inspection_json(inspection: EpubInspection, **kwargs: object) -> str:
    """Serialize an inspection record for JSONL audit logs."""

    return json.dumps(inspection.to_dict(**kwargs), ensure_ascii=False, sort_keys=True)
