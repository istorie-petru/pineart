"""Drop manual tag relations

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-27

The tag graph now only ever shows computed co-occurrence edges. Manual
relations added a second, hand-asserted edge kind, but graph rules (0007)
cover the actual use case that motivated them — pruning what co-occurrence
implies is more useful than hand-drawing extra lines — so the feature and its
table are removed rather than kept alongside an overlapping mechanism.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("tag_relations")


def downgrade() -> None:
    op.create_table(
        "tag_relations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tag_a_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tag_b_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.UniqueConstraint("tag_a_id", "tag_b_id", name="uq_tag_relation_pair"),
    )
