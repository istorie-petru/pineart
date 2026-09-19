"""Guards for the handful of places the backend fetches a URL a user supplied."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def assert_public_http_url(url: str) -> None:
    """Reject non-HTTP schemes and addresses on the local/private network.

    Without this, fetching a user-supplied URL server-side is a server-side
    request forgery primitive: the backend would happily fetch
    `http://127.0.0.1:8080/admin` or a cloud metadata endpoint and act on the
    response. The check resolves the hostname first, because a public-looking
    name can point at 127.0.0.1.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http(s) URLs can be fetched")
    if not parsed.hostname:
        raise ValueError("URL has no host")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise ValueError("Could not resolve host") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
        ):
            raise ValueError("Refusing to fetch a private or loopback address")
