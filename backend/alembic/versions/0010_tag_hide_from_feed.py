"""Add Tag.hide_from_feed

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-27

Opts a tag's items out of passive browsing (the Feed) while leaving them
visible in any board they belong to and in a search that names the tag
explicitly — see `services/queries.build_query`. Existing tags default to
`False`, i.e. nothing changes for a tag until someone hides it by hand.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tags",
        sa.Column("hide_from_feed", sa.Boolean(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    with op.batch_alter_table("tags") as batch:
        batch.drop_column("hide_from_feed")
