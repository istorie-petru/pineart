"""Rename Tag.hide_from_feed to Tag.nsfw

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-20

The generic "hide from feed" flag (0010) becomes a specific NSFW marker: an
NSFW-tagged item is now skipped by ordinary browsing everywhere (Feed *and*
any board it belongs to, not just the Feed), unless Settings -> Collection ->
"Switch to NSFW mode" is on, in which case browsing shows *only* NSFW-tagged
items -- see `services/queries.build_query`. A plain rename, no data loss:
whatever a tag's flag was set to carries over unchanged.
"""
from __future__ import annotations

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("tags") as batch:
        batch.alter_column("hide_from_feed", new_column_name="nsfw")


def downgrade() -> None:
    with op.batch_alter_table("tags") as batch:
        batch.alter_column("nsfw", new_column_name="hide_from_feed")
