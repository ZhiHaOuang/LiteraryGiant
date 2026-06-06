"""Abstract base adapter interface for web novel site parsers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from bs4 import BeautifulSoup


@dataclass(frozen=True, slots=True)
class ChapterEntry:
    """Represents a single chapter in a novel's table of contents.

    Attributes:
        title: Clean chapter title, e.g. "第一章 楔子".
        url: Absolute URL to the chapter content page.
        order: 1-based chapter order as listed on the index page.
    """

    title: str
    url: str
    order: int


class BaseAdapter(ABC):
    """Abstract base class for site-specific novel scrapers.

    Each supported website gets its own adapter subclass. The adapter
    knows the DOM structure of the site and provides extraction methods
    that operate on pre-parsed ``BeautifulSoup`` objects.

    Subclasses must:

    * Set the ``domain`` class attribute (e.g. ``"www.bqquge.com"``).
    * Implement all four abstract methods.
    * Optionally override ``preprocess_html`` and ``postprocess_content``.

    The adapter is **stateless with respect to network I/O** — it never
    makes HTTP requests directly.  All methods receive a ``soup`` and a
    *base_url* for resolving relative links.
    """

    domain: str = ""

    # ------------------------------------------------------------------
    # Abstract methods — every adapter MUST implement these
    # ------------------------------------------------------------------

    @abstractmethod
    def extract_title(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract the novel's title from the index/chapter-list page.

        Args:
            soup: Parsed HTML of the index page.
            base_url: The resolved URL of the index page (for context).

        Returns:
            Clean novel title, e.g. ``"万族之劫"``.
        """
        ...

    @abstractmethod
    def extract_chapter_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[ChapterEntry]:
        """Parse the index page and return a list of chapter entries.

        Args:
            soup: Parsed HTML of the index page.
            base_url: The resolved URL of the index page (for resolving relative links).

        Returns:
            List of ``ChapterEntry`` in document order.
        """
        ...

    @abstractmethod
    def extract_content(self, soup: BeautifulSoup, base_url: str) -> str:
        """Extract and clean the body text from a single chapter page.

        Args:
            soup: Parsed HTML of the chapter page.
            base_url: The resolved URL of the chapter page.

        Returns:
            Cleaned chapter body text, paragraphs separated by ``\\n``.
        """
        ...

    @abstractmethod
    def is_index_url(self, url: str) -> bool:
        """Check whether *url* is a chapter-list (index) page for this site.

        Args:
            url: A URL to check.

        Returns:
            ``True`` if the URL looks like an index page, ``False`` otherwise.
        """
        ...

    # ------------------------------------------------------------------
    # Optional hooks — override in subclasses when needed
    # ------------------------------------------------------------------

    def preprocess_html(self, html: str, url: str) -> str:
        """Prepare raw HTML before BeautifulSoup parsing.

        Override to remove known problematic regions (e.g. anti-crawl
        obfuscation) that interfere with parsing.

        Args:
            html: Raw HTML string.
            url: The URL this HTML came from.

        Returns:
            Cleaned HTML string.
        """
        return html

    def extract_book_list(
        self, soup: BeautifulSoup, base_url: str
    ) -> list[dict]:
        """Extract a list of books from a listing page (排行榜, 分类, 搜索).

        The default implementation returns an empty list.  Site adapters
        that support book discovery should override this method.

        Args:
            soup: Parsed HTML of the listing page.
            base_url: The resolved URL of the listing page.

        Returns:
            List of dicts with keys ``title`` and ``url``.
        """
        return []

    def extract_next_page_url(self, soup: BeautifulSoup, base_url: str) -> str | None:
        """Extract the URL of the next page of a multi-page chapter.

        Returns ``None`` if the chapter has no more pages.  The default
        implementation returns ``None`` (single-page chapters).

        Args:
            soup: Parsed HTML of the current chapter page.
            base_url: The resolved URL of the current page.

        Returns:
            Absolute URL of the next page, or ``None``.
        """
        return None

    def postprocess_content(self, content: str) -> str:
        """Minimal post-processing after DOM extraction.

        The fetcher does **not** perform text-level cleaning — that is the
        responsibility of :mod:`Jormungandr.hardmodel`.  This hook exists only for
        site-specific fixes that are inseparable from extraction (e.g.
        decoding obfuscated text).

        The default implementation normalises line endings only.

        Args:
            content: Raw text extracted by :meth:`extract_content`.

        Returns:
            Text with normalised line endings.
        """
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        return content.strip()
