"""Noise-line patterns used to filter web-novel cruft.

Web-novel raw text often contains ads, navigation prompts, SEO spam,
and reader-interaction boilerplate. The constants in this module are
used by :class:`~Jormungandr.hardmodel.chapter_cleaner.RawNovelBook` to detect and remove
such lines during the cleaning pass.

Noise signals are divided into two tiers:

* **Strong signals** — when *any one* of these matches the line is almost
  certainly noise.  Keep the list high-precision to avoid false positives.
* **Weak signals** — each signal alone is not conclusive, but when
  *multiple* weak signals fire on the same line it becomes suspicious.
  Lines that hit weak signals but no strong signals are candidates for
  model-based fallback classification.
"""

from __future__ import annotations

import re

# =========================================================================
# Tier 1 — Strong noise signals (single match → noise)
# =========================================================================

# Regex patterns — a match anywhere in the line classifies it as noise.
STRONG_NOISE_PATTERNS: list[re.Pattern] = [
    re.compile(r"^\s*(?:上一章|下一章|返回目录|章节目录|加入书签|目录|书页|章节报错|纠错|刷新页面)\s*$"),
    re.compile(r"^\s*https?://\S+", re.IGNORECASE),
    re.compile(r"^\s*(?:www|[Ww]{3})\."),
    re.compile(r"^\s*(?:手机用户请|手机用户请浏览|请到.{0,10}阅读|最新网址|首发地址|纯文字在线阅读|天才一秒记住|一秒记住|扫码(?:下载|关注)|app下载|欢迎加入)"),
    re.compile(r"^\s*(?:关注公众号|微信公众号|搜索公众号|扫码下载|扫码关注)"),
    re.compile(r"^\s*(?:本章(?:未完|完)|未完待续)\s*$"),
    re.compile(r"^[\(（](?:本章完|未完待续)[\)）]$"),
    re.compile(r"\(本章完\)", re.IGNORECASE),
    re.compile(r"(?:QQ群?|vx|微信|V信|群号)[:：]?\s*[0-9A-Za-z\-]{5,}"),
    re.compile(r"\b(?:https?://|www\.)\S+\b"),
    re.compile(r"\b[a-zA-Z0-9\-]+\.(?:com|cn|net|org|cc|io)\b"),
    re.compile(r"^\s*(?:ps|PS)[:：].*", re.IGNORECASE),
    # Site-specific ad lines (from various novel sites)
    re.compile(r"请记住本[,，]?站域名[,，]?\s*\S*"),
    re.compile(r"记住本站"),
    re.compile(r"本书首发"),
    re.compile(r"最新章节[：: ].*"),
]

# Token matches — if ANY of these tokens appear in the line, it's noise.
# These are high-confidence keywords that rarely appear in novel prose.
STRONG_NOISE_TOKENS: tuple[str, ...] = (
    "app下载",
    "二维码",
    "扫码",
    "公众号",
    "最新章节列表",
    "txt下载",
    "备用网址",
    "首发地址",
)

# =========================================================================
# Tier 2 — Weak noise signals (need model confirmation)
# =========================================================================

# Regex patterns that are *suspicious* but not conclusive.
# A line matching one of these might be a reader interaction, or might
# be legitimate dialogue/narration.  Multiple weak hits increase confidence.
WEAK_NOISE_PATTERNS: list[re.Pattern] = [
    re.compile(r"(?:求|来点|跪求).{0,8}(?:收藏|月票|推荐票|订阅|打赏)"),
    re.compile(r"(?:欢迎|可以|记得|喜欢).{0,8}(?:收藏|订阅|投票|打赏|分享|支持)"),
    re.compile(r"(?:加入|欢迎加入).{0,8}(?:书友群|读者群|QQ群|微信群)"),
    re.compile(r"(?:搜索|关注).{0,8}(?:公众号|微信公众号)"),
    re.compile(r"(?:首发|发布).{0,12}(?:网站|平台|地址)"),
    re.compile(r"(?:广告|推广|赞助)"),
    re.compile(r"^\s*(?:求收藏|请收藏|求月票|求推荐(?:票)?|求订阅|求打赏|各种求)\s*"),
    re.compile(r"^\s*(?:作者有话说|作家的话|题外话)"),
    re.compile(r"^\s*----+$"),
    re.compile(r"(?:读者|书友|大家|各位).{0,10}(?:支持|捧场|鼓励)"),
    re.compile(r"(?:作者|笔者|菌).{0,10}(?:拜谢|感谢|求|跪求)"),
    re.compile(r"[微vV]信\s*[：:]\s*\w+"),
    re.compile(r"(?:关注|收藏|订阅|投).{0,5}(?:一下|本书|作者|这本)"),
    re.compile(r"^\s*ps[:：]?\s*", re.IGNORECASE),
]

# Tokens that are weak indicators of noise — only meaningful when
# combined with other signals or when the line is otherwise suspicious.
WEAK_NOISE_TOKENS: tuple[str, ...] = (
    "收藏",
    "月票",
    "打赏",
    "推荐票",
    "书友群",
    "订阅",
    "追更",
    "催更",
    "求票",
    "加群",
)

# =========================================================================
# Legacy aliases — kept for backward compatibility
# =========================================================================

DEFAULT_NOISE_PATTERNS = STRONG_NOISE_PATTERNS + WEAK_NOISE_PATTERNS

SHORT_NOISE_TOKENS: tuple[str, ...] = (
    "收藏", "月票", "打赏", "推荐票", "书友群", "订阅", "追更",
    "点击", "投票", "催更", "评论", "点赞", "分享", "关注",
    "上一章", "下一章", "返回目录", "章节报错", "纠错", "求票",
)

MEDIUM_NOISE_TOKENS: tuple[str, ...] = (
    "广告", "推广", "公众号", "扫码", "二维码", "app下载",
    "下载地址", "最新网址", "首发", "官方", "福利", "加群",
    ".com", ".cn", "http", "www.", "备用网址",
)

NOISE_REGEXES = STRONG_NOISE_PATTERNS + WEAK_NOISE_PATTERNS

# =========================================================================
# Classification helpers
# =========================================================================


def classify_noise_line(line: str) -> tuple[bool, bool]:
    """Classify a single (already-normalised) line for noise.

    Args:
        line: A line that has already been through :func:`normalize_line`.

    Returns:
        A ``(is_strong_noise, is_weak_noise)`` tuple.

        * ``is_strong_noise`` — the line should be discarded immediately.
        * ``is_weak_noise`` — the line is suspicious and should be checked
          by a model-based fallback when available.
        * If both are ``False`` the line is considered clean.
    """
    # --- strong check ---
    # Tokens
    for token in STRONG_NOISE_TOKENS:
        if token in line:
            return (True, False)
    # Patterns
    for pattern in STRONG_NOISE_PATTERNS:
        if pattern.search(line):
            return (True, False)

    # --- weak check ---
    weak_count = 0
    for token in WEAK_NOISE_TOKENS:
        if token in line:
            weak_count += 1
    for pattern in WEAK_NOISE_PATTERNS:
        if pattern.search(line):
            weak_count += 1

    # A line needs at least 2 weak hits to be considered suspicious,
    # otherwise a single weak token would flag too many legitimate lines.
    if weak_count >= 2:
        return (False, True)

    return (False, False)


def has_any_noise(pattern_list: list[re.Pattern], line: str) -> bool:
    """Return ``True`` if *line* matches any pattern in *pattern_list*."""
    return any(pat.search(line) for pat in pattern_list)


def has_any_token(token_tuple: tuple[str, ...], line: str) -> bool:
    """Return ``True`` if *line* contains any token from *token_tuple*."""
    return any(token in line for token in token_tuple)
