"""Alembic environment.

`render_as_batch=True` is set from the very first migration, not retroactively:
SQLite cannot ALTER or DROP a column in place, so without batch mode any future
migration beyond "add a column" fails. Batch mode makes Alembic emit the
create-new-table / copy / drop / rename dance instead.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import get_config
from app.models import Base

config = context.config
config.set_main_option("sqlalchemy.url", get_config().resolved_database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            # The FTS5 virtual table and its shadow tables are not in
            # Base.metadata; without this filter, autogenerate would helpfully
            # offer to drop them on every revision.
            include_object=_include_object,
        )
        with context.begin_transaction():
            context.run_migrations()


def _include_object(obj, name, type_, reflected, compare_to) -> bool:  # noqa: ANN001
    if type_ == "table" and (name == "items_fts" or name.startswith("items_fts_")):
        return False
    return True


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
