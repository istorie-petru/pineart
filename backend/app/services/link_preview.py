"""Fetches a link's preview image from its target page.

The same "unfurl" a chat app does when you paste a URL -- reads the page's
Open Graph / Twitter Card meta tags for an image, done server-side so the
browser is never the one making the cross-origin request (and so the target
can be checked against `services.net`'s SSRF guard first).

Every failure here -- unreachable host, no meta tag, an oversized response, a
private/loopback target -- resolves to `None` rather than raising. A link's
cover is a nice-to-have; a slow or broken site must never stop the link
itself from being created.
"""

from __future__ import annotations

import re
from urllib.parse import urljoin

import httpx

from . import net

REQUEST_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
MAX_HTML_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (compatible; PineartLinkPreview/1.0)"

# Matched independently of attribute order (real-world markup puts `content`
# before or after `property`/`name` about equally often) by pulling every
# attribute out of each `<meta>` tag on its own, rather than trying to encode
# an order into one regex.
_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_ATTR_RE = re.compile(r'([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*\'([^\']*)\'')
_IMAGE_KEYS = {"og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"}


def _extract_image_url(html: str, base_url: str) -> str | None:
    for tag_match in _META_TAG_RE.finditer(html):
        attrs: dict[str, str] = {}
        for m in _ATTR_RE.finditer(tag_match.group(0)):
            if m.group(1):
                attrs[m.group(1).lower()] = m.group(2)
            else:
                attrs[m.group(3).lower()] = m.group(4)
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        content = attrs.get("content")
        if key in _IMAGE_KEYS and content:
            return urljoin(base_url, content)
    return None


async def fetch_preview_image(url: str) -> bytes | None:
    """Best-effort fetch of the page's og:image/twitter:image bytes."""
    try:
        net.assert_public_http_url(url)
    except ValueError:
        return None

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": USER_AGENT})
            response.raise_for_status()
            html = response.text[:MAX_HTML_BYTES]
            page_url = str(response.url)
    except (httpx.HTTPError, UnicodeDecodeError):
        return None

    image_url = _extract_image_url(html, page_url)
    if not image_url:
        return None

    try:
        net.assert_public_http_url(image_url)
    except ValueError:
        return None

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(image_url, headers={"User-Agent": USER_AGENT})
            response.raise_for_status()
            data = response.content
    except httpx.HTTPError:
        return None

    if len(data) > MAX_IMAGE_BYTES:
        return None
    return data
