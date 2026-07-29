"""Add Item.variant_label

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-26

A free-text name for one file within its artwork's version set — "Grayscale",
"Outline", "V2 scan" — distinct from `derivative_target`, which is a
system-assigned role (avatar/banner/board_cover), not a description. No
foreign key involved, so a plain ADD COLUMN is enough; unlike 0003 and 0005,
this one does not need batch mode.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("variant_label", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("items") as batch:
        batch.drop_column("variant_label")
