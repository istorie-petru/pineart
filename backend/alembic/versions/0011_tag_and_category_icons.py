"""Add TagCategory.icon and Tag.icon

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-04

A category's icon is the default for every tag filed under it; a tag's own
icon, when set, wins — the same precedence `color` already uses. Both are
free-text keys into the frontend's fixed icon set (see icons.ts), stored
nullable so "no icon" is the default for every existing row.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tag_categories", sa.Column("icon", sa.String(length=32), nullable=True))
    op.add_column("tags", sa.Column("icon", sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("tags") as batch:
        batch.drop_column("icon")
    with op.batch_alter_table("tag_categories") as batch:
        batch.drop_column("icon")
