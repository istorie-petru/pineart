"""Fold existing freeform crops into their artwork's versions

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-26

Crops used to be ordinary items, so every crop ever made is sitting in the feed
as a separate card next to the picture it came from. This backfills the
relationship the app now uses, so existing collections are tidied rather than
only new crops behaving correctly.

Profile crops (avatar/banner/board cover) need no data change: they are
identified by `derivative_target` and are now filtered out of grids by that.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT id, parent_item_id FROM items "
            "WHERE parent_item_id IS NOT NULL AND derivative_target IS NULL "
            "AND version_of_id IS NULL"
        )
    ).fetchall()
    if not rows:
        return

    parents = dict(
        connection.execute(
            sa.text("SELECT id, parent_item_id FROM items WHERE parent_item_id IS NOT NULL")
        ).fetchall()
    )
    existing = {row[0] for row in connection.execute(sa.text("SELECT id FROM items")).fetchall()}

    for item_id, parent_id in rows:
        # A crop of a crop must land on the artwork, not on the intermediate
        # file: version sets are flat, and a chain here would produce versions of
        # versions that nothing in the app knows how to display.
        root = parent_id
        seen = {item_id}
        while root in parents and root not in seen:
            seen.add(root)
            root = parents[root]
        if root not in existing or root == item_id:
            continue
        connection.execute(
            sa.text("UPDATE items SET version_of_id = :root WHERE id = :id"),
            {"root": root, "id": item_id},
        )


def downgrade() -> None:
    # Only the rows this migration created a link for are unlinked; versions
    # added deliberately through the app have no parent_item_id and are left be.
    op.get_bind().execute(
        sa.text(
            "UPDATE items SET version_of_id = NULL "
            "WHERE parent_item_id IS NOT NULL AND version_of_id = parent_item_id"
        )
    )
