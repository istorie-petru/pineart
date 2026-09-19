"""Links get their own page: rename category to group_name, add cover_item_id

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-19

Links move off the profile header's pill row onto their own grid-carded page.
Two changes to `link_directory`:
* `category` (added in 0007, never actually surfaced in the UI) is renamed to
  `group_name`, since that's what it's used for now -- grouping links into
  sections on the new page.
* `cover_item_id` -- a link's preview image, stored the same way an
  avatar/banner/board cover is: as a real Item kept out of the main grid via
  `derivative_target="link_cover"`, reusing the existing ingest/derivative
  pipeline instead of a second one-off image path.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("link_directory") as batch:
        batch.alter_column("category", new_column_name="group_name")
        batch.add_column(sa.Column("cover_item_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_link_directory_cover_item_id",
            "items",
            ["cover_item_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("link_directory") as batch:
        batch.drop_constraint("fk_link_directory_cover_item_id", type_="foreignkey")
        batch.drop_column("cover_item_id")
        batch.alter_column("group_name", new_column_name="category")
