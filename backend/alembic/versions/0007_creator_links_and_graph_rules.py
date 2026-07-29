"""Creator links and tag-graph suppression rules

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-26

Two additions:
* `tag_categories.links_enabled` + `tags.link_url` — a category can allow its
  tags to carry a single outbound link (a creator's shop, profile, portfolio);
  not every category means something outside the collection.
* `tag_graph_rules` — user-defined pruning of the computed co-occurrence graph,
  e.g. "don't connect a Category tag to a Character tag when that Character
  already connects to a Show tag" (see the model docstring for the full case).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tag_categories",
        sa.Column("links_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column("tags", sa.Column("link_url", sa.Text(), nullable=True))

    op.create_table(
        "tag_graph_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "from_category_id",
            sa.Integer(),
            sa.ForeignKey("tag_categories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "to_category_id",
            sa.Integer(),
            sa.ForeignKey("tag_categories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "via_category_id",
            sa.Integer(),
            sa.ForeignKey("tag_categories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "from_category_id", "to_category_id", "via_category_id", name="uq_tag_graph_rule"
        ),
    )


def downgrade() -> None:
    op.drop_table("tag_graph_rules")
    with op.batch_alter_table("tags") as batch:
        batch.drop_column("link_url")
    with op.batch_alter_table("tag_categories") as batch:
        batch.drop_column("links_enabled")
