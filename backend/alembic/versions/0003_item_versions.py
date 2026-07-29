"""Add artwork versions and the canonical-file pointer

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-26

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Batch mode because SQLite cannot add a column with a foreign key in place;
    # env.py sets render_as_batch, and this is the migration that needs it.
    with op.batch_alter_table("items") as batch:
        batch.add_column(sa.Column("version_of_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("canonical_version_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_items_version_of", "items", ["version_of_id"], ["id"], ondelete="CASCADE"
        )
        batch.create_foreign_key(
            "fk_items_canonical_version", "items", ["canonical_version_id"], ["id"], ondelete="SET NULL"
        )
    op.create_index("ix_items_version_of_id", "items", ["version_of_id"])


def downgrade() -> None:
    op.drop_index("ix_items_version_of_id", table_name="items")
    with op.batch_alter_table("items") as batch:
        batch.drop_constraint("fk_items_canonical_version", type_="foreignkey")
        batch.drop_constraint("fk_items_version_of", type_="foreignkey")
        batch.drop_column("canonical_version_id")
        batch.drop_column("version_of_id")
