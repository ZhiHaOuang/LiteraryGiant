"""Shared utilities for web novel fetching: encoding detection, rate limiting, retries."""

from __future__ import annotations

import logging
import random
import re
import time
from collections import Counter

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default HTTP headers to avoid being blocked
# ---------------------------------------------------------------------------

DEFAULT_HEADERS: dict[str, str] = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
}

# ---------------------------------------------------------------------------
# User-Agent pool
# ---------------------------------------------------------------------------

_USER_AGENTS: list[str] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
]


def random_user_agent() -> str:
    """Return a random User-Agent string."""
    return random.choice(_USER_AGENTS)


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------


class RateLimiter:
    """Simple rate limiter with configurable minimum delay and jitter."""

    def __init__(self, min_delay: float = 1.5, jitter: float = 0.5) -> None:
        self._min_delay = float(min_delay)
        self._jitter = float(jitter)
        self._last_call: float = 0.0

    def wait(self) -> None:
        """Block until at least `min_delay` seconds have passed since last call."""
        now = time.monotonic()
        elapsed = now - self._last_call
        if elapsed < self._min_delay:
            sleep_time = self._min_delay - elapsed + random.uniform(0, self._jitter)
            time.sleep(sleep_time)
        self._last_call = time.monotonic()


# ---------------------------------------------------------------------------
# Encoding detection
# ---------------------------------------------------------------------------

# Priority order for Chinese encodings
_FALLBACK_ENCODINGS = ("gb18030", "gbk", "utf-8", "gb2312", "big5", "utf-16")

# Characters that indicate a successful CJK decode
_CJK_START = 0x4E00
_CJK_END = 0x9FFF
_CJK_EXT_A_START = 0x3400
_CJK_EXT_A_END = 0x4DBF
_CJK_COMPAT_START = 0xF900
_CJK_COMPAT_END = 0xFAFF


def _is_cjk(char: str) -> bool:
    """Check if a single character is in the CJK Unified Ideographs range."""
    cp = ord(char)
    return (
        (_CJK_START <= cp <= _CJK_END)
        or (_CJK_EXT_A_START <= cp <= _CJK_EXT_A_END)
        or (_CJK_COMPAT_START <= cp <= _CJK_COMPAT_END)
    )


def _score_text(text: str) -> float:
    """Score decoded text quality. Higher = better.

    Rewards CJK characters and printable characters.
    Penalizes replacement characters (U+FFFD) and null bytes.
    """
    if not text:
        return -1.0

    total = len(text)
    cjk_count = sum(1 for ch in text if _is_cjk(ch))
    printable = sum(1 for ch in text if ch.isprintable() or ch in ("\n", "\r", "\t"))
    replacements = text.count("�")
    nulls = text.count("\x00")

    if total == 0:
        return -1.0

    cjk_ratio = cjk_count / total
    printable_ratio = printable / total
    replacement_penalty = replacements / max(total, 1) * 2.0
    null_penalty = nulls / max(total, 1) * 5.0

    return cjk_ratio * 0.6 + printable_ratio * 0.4 - replacement_penalty - null_penalty


def detect_encoding(
    raw_bytes: bytes,
    declared_charset: str | None = None,
    html_snippet: str | None = None,
) -> str:
    """Detect the most likely encoding for a byte buffer.

    Args:
        raw_bytes: Raw HTTP response body bytes.
        declared_charset: Charset from Content-Type header or ``<meta>`` tag.
        html_snippet: A snippet of HTML decoded with a safe fallback (e.g. latin-1)
            for extracting ``<meta charset>`` information.

    Returns:
        Encoding name suitable for ``bytes.decode()``.
    """
    # First, try the declared charset if available.
    if declared_charset:
        try:
            decoded = raw_bytes.decode(declared_charset)
            score = _score_text(decoded)
            # If score is borderline, still prefer declared but validate
            if score > -0.5:
                return declared_charset
        except (LookupError, UnicodeDecodeError):
            pass

    # Try to extract charset from html_snippet if provided
    if html_snippet:
        match = re.search(
            r'<meta[^>]+charset=["\']?\s*([\w-]+)', html_snippet, re.IGNORECASE
        )
        if match:
            charset = match.group(1).lower()
            try:
                decoded = raw_bytes.decode(charset)
                if _score_text(decoded) > 0:
                    return charset
            except (LookupError, UnicodeDecodeError):
                pass

    # Fallback: try common Chinese encodings and pick the best score
    best_encoding = "utf-8"
    best_score = -float("inf")

    for encoding in _FALLBACK_ENCODINGS:
        try:
            decoded = raw_bytes.decode(encoding, errors="replace")
            score = _score_text(decoded)
            if score > best_score:
                best_score = score
                best_encoding = encoding
        except (LookupError, UnicodeDecodeError):
            continue

    logger.debug("Encoding detection: best=%s score=%.3f", best_encoding, best_score)
    return best_encoding


def decode_response(response: requests.Response) -> str:
    """Decode an HTTP response using the best-guess encoding.

    Uses the Content-Type header charset, ``<meta charset>`` tag, and
    fallback scoring to determine the correct encoding.
    """
    raw_bytes = response.content
    declared_charset: str | None = None

    # Check Content-Type header
    content_type = response.headers.get("Content-Type", "")
    match = re.search(r"charset=([\w-]+)", content_type, re.IGNORECASE)
    if match:
        declared_charset = match.group(1).lower()

    # Get a safe snippet for meta-charset extraction
    html_snippet: str | None = None
    try:
        html_snippet = raw_bytes[:8192].decode("latin-1")
    except Exception:
        pass

    encoding = detect_encoding(raw_bytes, declared_charset, html_snippet)
    return raw_bytes.decode(encoding, errors="replace")


# ---------------------------------------------------------------------------
# Retry helper
# ---------------------------------------------------------------------------


def build_session(
    max_retries: int = 3,
    backoff_factor: float = 1.0,
    timeout: int = 30,
) -> requests.Session:
    """Build a ``requests.Session`` with retry logic and default headers.

    Args:
        max_retries: Maximum number of retries on transient errors.
        backoff_factor: Backoff multiplier for retries (1.0 → 1s, 2s, 4s).
        timeout: Request timeout in seconds.

    Returns:
        A configured ``requests.Session``.
    """
    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)

    retry_strategy = Retry(
        total=max_retries,
        backoff_factor=backoff_factor,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    # Inject timeout as a default for every request
    session.request = lambda method, url, **kwargs: requests.Session.request(  # type: ignore[assignment]
        session, method, url, timeout=timeout, **kwargs
    )
    return session


def fetch_page(
    session: requests.Session,
    url: str,
    encoding: str | None = None,
) -> tuple[str, str]:
    """Fetch a web page and return (decoded_text, final_url).

    Args:
        session: A ``requests.Session`` to use.
        url: The URL to fetch.
        encoding: Force a specific encoding. Detected automatically if ``None``.

    Returns:
        Tuple of (decoded HTML text, final URL after redirects).
    """
    response = session.get(url)
    response.raise_for_status()

    if encoding:
        text = response.content.decode(encoding, errors="replace")
    else:
        text = decode_response(response)

    # If the response has no apparent text, raise an error
    if not text or len(text.strip()) < 50:
        raise RuntimeError(f"Fetched page at {url} is too short ({len(text)} bytes)")

    return text, response.url
