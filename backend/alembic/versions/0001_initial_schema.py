"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2026-07-25

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("hash", sa.String(64), nullable=False, unique=True),
        sa.Column("phash", sa.String(32), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("parent_item_id", sa.Integer(), sa.ForeignKey("items.id", ondelete="SET NULL")),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("filesize", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(64), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("dominant_color", sa.String(7), nullable=True),
        sa.Column("orientation", sa.String(9), nullable=False),
        sa.Column("derivative_target", sa.String(16), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("added_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_items_added_at_is_deleted", "items", ["added_at", "is_deleted"])
    op.create_index("ix_items_hash", "items", ["hash"])
    op.create_index("ix_items_phash", "items", ["phash"])
    op.create_index("ix_items_parent_item_id", "items", ["parent_item_id"])

    op.create_table(
        "tags",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("color", sa.String(7), nullable=True),
    )
    op.create_index("ix_tags_slug", "tags", ["slug"])

    op.create_table(
        "item_tags",
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_item_tags_tag_id", "item_tags", ["tag_id"])
    op.create_index("ix_item_tags_item_id", "item_tags", ["item_id"])

    op.create_table(
        "tag_relations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tag_a_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tag_b_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.UniqueConstraint("tag_a_id", "tag_b_id", name="uq_tag_relation_pair"),
    )

    op.create_table(
        "boards",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("cover_item_id", sa.Integer(), sa.ForeignKey("items.id", ondelete="SET NULL")),
        sa.Column("is_dynamic", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )

    op.create_table(
        "board_items",
        sa.Column("board_id", sa.Integer(), sa.ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("items.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.create_index("ix_board_items_board_id_position", "board_items", ["board_id", "position"])

    op.create_table(
        "board_query_tags",
        sa.Column("board_id", sa.Integer(), sa.ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("match_mode", sa.String(3), nullable=False, server_default="any"),
    )

    op.create_table(
        "board_subboard_tags",
        sa.Column("board_id", sa.Integer(), sa.ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
    )

    op.create_table(
        "link_directory",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("icon", sa.String(32), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )

    op.create_table(
        "settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
    )

    op.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5("
        "title, description, tags, tokenize='unicode61')"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS items_fts")
    for table in (
        "settings",
        "link_directory",
        "board_subboard_tags",
        "board_query_tags",
        "board_items",
        "boards",
        "tag_relations",
        "item_tags",
        "tags",
        "items",
    ):
        op.drop_table(table)
