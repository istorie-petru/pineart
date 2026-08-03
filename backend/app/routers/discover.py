"""SearXNG discovery proxy — the only genuinely async part of the app.

Isolated behind these two endpoints on purpose (architecture §10): a fork
swapping in a different discovery backend reimplements this file and nothing
else.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import get_config
from ..db import get_db
from ..schemas import DiscoverResponse, DiscoverResult, DiscoverSave, UploadResult
from ..serializers import item_out
from ..services import images, ingest, search, settings_store
from ..services import tags as tag_service

router = APIRouter(prefix="/api/discover", tags=["discovery"])

REQUEST_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MAX_REMOTE_BYTES = 32 * 1024 * 1024


def _searxng_base(db: Session) -> str:
    """The DB setting wins over the env var: it's what the Settings UI edits."""
    if not settings_store.get(db, "discovery.enabled"):
        raise HTTPException(
            status_code=409,
            detail="Discovery is disabled. Enable it in Settings and set a SearXNG URL.",
        )
    url = str(settings_store.get(db, "discovery.searxng_url") or "").strip()
    if not url:
        url = get_config().searxng_url.strip()
    if not url:
        raise HTTPException(status_code=409, detail="No SearXNG URL configured")
    return url.rstrip("/")


def _assert_public_http_url(url: str) -> None:
    """Reject non-HTTP schemes and addresses on the local/private network.

    Without this, `POST /api/discover/save` is a server-side request forgery
    primitive: the backend would happily fetch `http://127.0.0.1:8080/admin` or a
    cloud metadata endpoint and store the response. The check resolves the
    hostname first, because a public-looking name can point at 127.0.0.1.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http(s) URLs can be saved")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="URL has no host")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Could not resolve host") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
        ):
            raise HTTPException(
                status_code=400, detail="Refusing to fetch a private or loopback address"
            )


def apply_template(template: str, query: str) -> str:
    """Expand the saved template around what the user typed.

    Applied server-side rather than in the browser so the Feed's search box stays
    what it appears to be — the subject you are looking for — while the
    boilerplate that makes image search useful lives in one place and can be
    changed without touching the view.
    """
    clean = query.strip()
    if not template or "{query}" not in template:
        return clean
    return template.replace("{query}", clean).strip()


@router.get("/templates")
def templates(db: Session = Depends(get_db)) -> dict[str, object]:
    """Saved templates plus the recommended ones, for the Settings tab."""
    return {
        "active": settings_store.get(db, "discovery.query_template"),
        "saved": settings_store.get(db, "discovery.templates") or [],
        "recommended": settings_store.RECOMMENDED_TEMPLATES,
    }


@router.get("", response_model=DiscoverResponse)
async def discover(q: str, page: int = 1, db: Session = Depends(get_db)) -> DiscoverResponse:
    base = _searxng_base(db)
    expanded = apply_template(str(settings_store.get(db, "discovery.query_template") or ""), q)
    params = {"q": expanded, "categories": "images", "format": "json", "pageno": max(1, page)}
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.get(f"{base}/search", params=params)
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"SearXNG request failed: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="SearXNG returned a non-JSON response — is the JSON format enabled in its settings.yml?",
        ) from exc

    results = []
    for raw in payload.get("results", []):
        image_url = raw.get("img_src") or raw.get("url")
        if not image_url:
            continue
        results.append(
            DiscoverResult(
                title=raw.get("title"),
                image_url=image_url,
                thumbnail_url=raw.get("thumbnail_src") or raw.get("thumbnail"),
                source_url=raw.get("url"),
                engine=raw.get("engine"),
                width=raw.get("img_width"),
                height=raw.get("img_height"),
            )
        )
    # The expanded query is returned so the Feed can show what was actually
    # searched — otherwise a template quietly changing the results would look
    # like the engine misbehaving.
    return DiscoverResponse(query=q, expanded_query=expanded, results=results)


@router.post("/save", response_model=UploadResult, status_code=201)
async def save(payload: DiscoverSave, db: Session = Depends(get_db)) -> UploadResult:
    _assert_public_http_url(payload.image_url)
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(payload.image_url)
            response.raise_for_status()
            data = response.content
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch image: {exc}") from exc

    if len(data) > MAX_REMOTE_BYTES:
        raise HTTPException(status_code=413, detail="Remote image is too large")

    try:
        result = ingest.ingest(
            db, data, title=payload.title, source_url=payload.source_url or payload.image_url
        )
    except images.InvalidImageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if payload.tags:
        tag_service.add_item_tags(db, result.item, payload.tags)
        db.commit()
        search.reindex_item(db, result.item)

    return UploadResult(
        item=item_out(result.item),
        created=result.created,
        near_duplicate_ids=result.near_duplicate_ids,
    )
