"""Small CLI entrypoints, used by the systemd timer and by hand.

Usage:
    python -m app.cli purge [--force]
    python -m app.cli reindex
    python -m app.cli set-password
"""

from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from .db import SessionLocal
from .models import Item
from .routers.trash import purge_expired
from .services import auth, search


def cmd_purge(force: bool) -> int:
    with SessionLocal() as db:
        count = purge_expired(db, force=force)
    print(f"Purged {count} item(s)")
    return 0


def cmd_reindex() -> int:
    """Rebuild the FTS index from scratch.

    Needed after restoring a .sqlite3 file that predates the FTS table, or if the
    index is ever suspected of being stale — it is maintained by explicit calls
    rather than triggers, so a rebuild path has to exist.
    """
    with SessionLocal() as db:
        items = list(db.scalars(select(Item)).all())
        for item in items:
            search.reindex_item(db, item)
    print(f"Reindexed {len(items)} item(s)")
    return 0


def cmd_set_password() -> int:
    """Set or reset the password from the machine itself.

    This is the account-recovery path, and the reason it needs no current
    password: anyone who can run this already has shell access to the data
    directory and could read the database directly. Pretending otherwise would
    add friction without adding security. Every existing session is revoked, so
    a forgotten password cannot be worked around by an already-open browser.
    """
    password = getpass.getpass("New password: ")
    confirm = getpass.getpass("Confirm: ")
    if password != confirm:
        print("Passwords do not match", file=sys.stderr)
        return 1
    with SessionLocal() as db:
        try:
            revoked = auth.force_set_password(db, password)
        except auth.AuthError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    print(f"Password set; {revoked} existing session(s) revoked")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="artboard")
    sub = parser.add_subparsers(dest="command", required=True)

    purge = sub.add_parser("purge", help="Hard-delete trashed items past the retention window")
    purge.add_argument("--force", action="store_true", help="Empty the trash regardless of age")

    sub.add_parser("reindex", help="Rebuild the full-text search index")
    sub.add_parser("set-password", help="Set or reset the login password, revoking all sessions")

    args = parser.parse_args(argv)
    if args.command == "purge":
        return cmd_purge(args.force)
    if args.command == "reindex":
        return cmd_reindex()
    if args.command == "set-password":
        return cmd_set_password()
    return 1


if __name__ == "__main__":
    sys.exit(main())
