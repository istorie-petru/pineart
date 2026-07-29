"""Process-level configuration.

Distinct from the `settings` DB table: this file holds things that must be known
before the database exists (where the database *is*, where images go), while the
`settings` table holds user preferences that are edited at runtime through the UI.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    """Where the database and images live when `ARTBOARD_DATA_DIR` is unset.

    Deliberately *not* a path relative to the app's own checkout (`./data`):
    that put a real user's database and every image they own inside the same
    folder as the source code, which is wrong for two reasons — it's the kind
    of thing that gets accidentally committed or copied along with the repo,
    and `git pull`/reinstalling the app has no business living next to data
    that outlives any particular checkout of the code.

    Follows the platform's normal convention for "where does this app's data
    go" instead:
    - Root/system install (no real login session, e.g. a systemd service
      running as a dedicated system user with no home directory worth using):
      `/var/lib/pineart`, the standard Linux location for a system service's
      persistent state.
    - Ordinary user install: the XDG Base Directory spec's data home —
      `$XDG_DATA_HOME/pineart`, or `~/.local/share/pineart` if that variable
      isn't set.
    - Windows: `%APPDATA%\\Pineart`, the equivalent per-user app-data location.

    `ARTBOARD_DATA_DIR` always overrides this outright — this function only
    runs to pick a sensible default when nothing was configured.
    """
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        return (Path(base) if base else Path.home() / "AppData" / "Roaming") / "Pineart"

    # `geteuid` doesn't exist on Windows, hence the `os.name` branch above
    # running first. Root (or a system-service account with no meaningful
    # home directory) gets the shared system location instead of a home
    # directory that may not even exist or be writable for that account.
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return Path("/var/lib/pineart")

    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg_data_home) if xdg_data_home else Path.home() / ".local" / "share"
    return base / "pineart"


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ARTBOARD_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Field(default_factory=_default_data_dir)
    database_url: str | None = None

    @field_validator("data_dir", mode="after")
    @classmethod
    def _expand_data_dir(cls, value: Path) -> Path:
        # `Path("~/...")` does not expand `~` on its own — without this, an
        # explicit `ARTBOARD_DATA_DIR=~/somewhere` in `.env` would silently
        # create a literal folder named `~` in the current directory instead
        # of doing what it looks like it does.
        return value.expanduser()
    searxng_url: str = ""
    # Kept as a comma-separated string rather than a list[str]: pydantic-settings
    # tries to JSON-decode list-typed fields straight from the environment, so a
    # plain `A,B` value in .env would fail to parse before any validator ran.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    max_upload_bytes: int = 32 * 1024 * 1024
    # Marks the session cookie Secure. Off by default so plain-HTTP development
    # works — a Secure cookie is silently dropped over http, which looks like a
    # broken login rather than a configuration choice. Turn it on in production;
    # the systemd unit and compose file both do.
    secure_cookies: bool = False

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'db.sqlite3').resolve()}"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.images_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_config() -> Config:
    cfg = Config()
    cfg.ensure_dirs()
    return cfg
