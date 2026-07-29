"""Seed a running instance with generated artwork, boards, tags and links.

For trying the app out and for the frontend smoke test — not part of the
product. Requires the backend to be running, and must be run *on the server*
(it sets the demo password directly rather than going through the one-time
setup token, which only exists in the server log).

Usage: python scripts/seed_demo.py [http://127.0.0.1:8000]
"""

from __future__ import annotations

import http.client
import io
import json
import os
import random
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import SessionLocal  # noqa: E402
from app.services import auth  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
DEMO_PASSWORD = os.environ.get("ARTBOARD_DEMO_PASSWORD", "demo-password-123")

# Populated by `authenticate()` and sent with every subsequent request.
COOKIE = ""

TAG_SETS = [
    "landscape, plein-air",
    "portrait-study, sketch",
    "landscape, color-theory",
    "still-life, oil-painting",
    "color-theory, sketch",
    "landscape, impressionism, plein-air",
]


def generate(seed: int, size: tuple[int, int], color: tuple[int, int, int]) -> bytes:
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    inverse = tuple(255 - c for c in color)
    for x in range(width):
        f = x / max(1, width - 1)
        draw.line([(x, 0), (x, height)], fill=tuple(int(c * (1 - f) + i * f) for c, i in zip(color, inverse)))
    rng = random.Random(seed)
    for _ in range(4):
        x0, y0 = rng.uniform(0, 0.6), rng.uniform(0, 0.6)
        box = [width * x0, height * y0, width * (x0 + rng.uniform(0.15, 0.35)), height * (y0 + rng.uniform(0.15, 0.35))]
        shape = draw.ellipse if rng.random() < 0.5 else draw.rectangle
        shape(box, fill=inverse if rng.random() < 0.5 else color)
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def api(path: str, method: str = "GET", payload: object = None) -> object:
    headers = {"Cookie": COOKIE} if COOKIE else {}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{BASE}{path}",
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(request) as response:
        body = response.read()
    return json.loads(body) if body else None


def authenticate() -> None:
    """Set the demo password locally, then log in over HTTP like a browser would.

    Setting it directly is legitimate here and only here: this script runs on the
    server with access to the database file, which is exactly the trust level the
    CLI recovery path assumes.
    """
    global COOKIE
    with SessionLocal() as db:
        auth.force_set_password(db, DEMO_PASSWORD)

    request = urllib.request.Request(
        f"{BASE}/api/auth/login",
        method="POST",
        data=json.dumps({"password": DEMO_PASSWORD}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        COOKIE = response.headers["set-cookie"].split(";", 1)[0]


def upload(data: bytes, title: str, tags: str) -> dict:
    boundary = "----artboardseed"
    body = b""
    for key, value in (("title", title), ("tags", tags)):
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    body += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="seed.png"\r\n'
        f"Content-Type: image/png\r\n\r\n".encode()
    ) + data + f"\r\n--{boundary}--\r\n".encode()

    host = BASE.split("://", 1)[1]
    connection = http.client.HTTPConnection(host)
    connection.request(
        "POST",
        "/api/items",
        body,
        {"Content-Type": f"multipart/form-data; boundary={boundary}", "Cookie": COOKIE},
    )
    return json.loads(connection.getresponse().read())


def main() -> int:
    authenticate()
    for i in range(18):
        upload(
            generate(i, (400 + i * 13, 300 + (i % 5) * 70), (30 + i * 11, (90 + i * 29) % 200, max(20, 200 - i * 7))),
            f"Study No.{i + 1}",
            TAG_SETS[i % len(TAG_SETS)],
        )

    board = api("/api/boards", "POST", {"name": "Studies & Palettes", "description": "Color and value studies."})
    item_ids = [item["id"] for item in api("/api/items?limit=8")["items"]]
    api(f"/api/boards/{board['id']}/items", "PUT", {"item_ids": item_ids})

    tags = {tag["name"]: tag["id"] for tag in api("/api/tags")}
    api(
        "/api/boards",
        "POST",
        {
            "name": "All landscapes",
            "description": "Saved search — fills itself.",
            "is_dynamic": True,
            "query_tags": [{"tag_id": tags["landscape"], "match_mode": "any"}],
        },
    )
    api("/api/tags/relations", "POST", {"tag_a_id": tags["impressionism"], "tag_b_id": tags["oil-painting"]})
    api("/api/links", "POST", {"title": "ArtStation", "url": "https://artstation.com", "icon": "palette"})
    api("/api/links", "POST", {"title": "Rijksstudio", "url": "https://rijksmuseum.nl", "icon": "image"})

    api(f"/api/items/{item_ids[0]}/crop", "POST", {"x": 20, "y": 20, "w": 300, "h": 300, "target": "avatar"})
    api(f"/api/items/{item_ids[1]}/crop", "POST", {"x": 0, "y": 0, "w": 320, "h": 100, "target": "banner"})
    api(
        f"/api/items/{item_ids[2]}/crop",
        "POST",
        {"x": 0, "y": 0, "w": 300, "h": 200, "target": "board_cover", "board_id": board["id"]},
    )
    api(
        "/api/settings",
        "PUT",
        {
            "values": {
                "profile.display_name": "Art Archive",
                "profile.description": "A living archive of everything I save.",
            }
        },
    )

    print(
        f"Seeded {api('/api/items')['total']} items, "
        f"{len(api('/api/boards'))} boards, {len(api('/api/tags'))} tags"
    )
    print(f"Log in with the password: {DEMO_PASSWORD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
