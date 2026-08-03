"""Add TagGraphRule.name

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-27

Optional — a rule with no name displays a composed one (e.g. "Anime ✕ Hinata
via Haikyu") rather than forcing a name on every rule. Existing rules get NULL
and pick up the composed display name automatically.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tag_graph_rules", sa.Column("name", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("tag_graph_rules") as batch:
        batch.drop_column("name")
