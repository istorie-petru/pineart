"""Add tag categories (supercategories) and Tag.category_id

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-26

Tags can now be filed under a supercategory (Character, Show, Media type, …),
which is what lets board search group tags into sections and lets a tag's
displayed colour come from its category instead of being set one tag at a
time. Existing tags get no category — that assignment happens by hand, the
same way tag colour already does.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tag_categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("color", sa.String(7), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.create_index("ix_tag_categories_slug", "tag_categories", ["slug"])

    # Batch mode because SQLite cannot add a column with a foreign key in place;
    # env.py sets render_as_batch, per the note in 0003.
    with op.batch_alter_table("tags") as batch:
        batch.add_column(sa.Column("category_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_tags_category", "tag_categories", ["category_id"], ["id"], ondelete="SET NULL"
        )
    op.create_index("ix_tags_category_id", "tags", ["category_id"])


def downgrade() -> None:
    op.drop_index("ix_tags_category_id", table_name="tags")
    with op.batch_alter_table("tags") as batch:
        batch.drop_constraint("fk_tags_category", type_="foreignkey")
        batch.drop_column("category_id")
    op.drop_index("ix_tag_categories_slug", table_name="tag_categories")
    op.drop_table("tag_categories")
