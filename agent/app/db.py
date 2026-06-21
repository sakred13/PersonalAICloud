"""
Database helper for the agent service.

Uses psycopg2 with a simple connection-per-call pattern (the agent is a
low-concurrency batch worker, not a high-traffic API, so a full async pool
would be overkill for now).

On startup, runs an idempotent migration that creates the file_tags table if
it does not already exist — this handles both fresh volumes and existing
Postgres volumes that pre-date this feature.
"""
import logging
from contextlib import contextmanager
from typing import Generator

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pg_pool

from .config import settings

logger = logging.getLogger(__name__)

# A small thread-safe connection pool (1-5 connections is plenty)
_pool: pg_pool.ThreadedConnectionPool | None = None

# ── DDL run on every startup (idempotent) ────────────────────────────────────
_MIGRATION_SQL = """
CREATE TABLE IF NOT EXISTS file_tags (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    tagged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_file_tags_user ON file_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_file_tags_tags ON file_tags USING GIN(tags);
"""


def init_db() -> None:
    """Create the connection pool and run startup migrations."""
    global _pool
    _pool = pg_pool.ThreadedConnectionPool(
        minconn=1,
        maxconn=5,
        dsn=settings.DATABASE_URL,
    )
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_MIGRATION_SQL)
        conn.commit()
    logger.info("[db] Connection pool ready, migrations applied.")


def close_db() -> None:
    """Gracefully close all pool connections on shutdown."""
    if _pool:
        _pool.closeall()


@contextmanager
def get_conn() -> Generator[psycopg2.extensions.connection, None, None]:
    """Context manager that checks out / returns a connection from the pool."""
    if _pool is None:
        raise RuntimeError("Database pool not initialised — call init_db() first.")
    conn = _pool.getconn()
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


def fetch_all_users() -> list[dict]:
    """Return all registered users as {id, username} dicts."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, username FROM users ORDER BY id")
            return [dict(row) for row in cur.fetchall()]


def upsert_tags(user_id: int, file_path: str, tags: list[str]) -> None:
    """Insert or update the tag list for a single file."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO file_tags (user_id, file_path, tags, tagged_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT (user_id, file_path)
                DO UPDATE SET tags = EXCLUDED.tags, tagged_at = NOW()
                """,
                (user_id, file_path, tags),
            )
        conn.commit()


def search_tags(user_id: int, query: str) -> list[dict]:
    """
    Return files where any query word matches either a tag or the file path as a substring.
    Results are ordered by relevance first, then date.
    """
    # Split query into individual words and wrap with wildcards
    words = [f"%{w.lower().strip()}%" for w in query.split() if w.strip()]
    if not words:
        return []

    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT file_path, tags, tagged_at,
                       (
                           (SELECT count(*) FROM unnest(tags) tag WHERE tag ILIKE ANY (%s)) +
                           (CASE WHEN file_path ILIKE ANY (%s) THEN 1 ELSE 0 END)
                       ) as relevance
                FROM file_tags
                WHERE user_id = %s
                  AND (
                      EXISTS (
                          SELECT 1 
                          FROM unnest(tags) tag 
                          WHERE tag ILIKE ANY (%s)
                      )
                      OR file_path ILIKE ANY (%s)
                  )
                ORDER BY relevance DESC, tagged_at DESC
                """,
                (words, words, user_id, words, words),
            )
            return [dict(row) for row in cur.fetchall()]


def get_tagged_paths(user_id: int) -> dict[str, float]:
    """
    Return a mapping of {file_path: tagged_at_timestamp} for all files
    already tagged for this user. Used by the batch job to skip unchanged files.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT file_path, EXTRACT(EPOCH FROM tagged_at) FROM file_tags WHERE user_id = %s",
                (user_id,),
            )
            return {row[0]: row[1] for row in cur.fetchall()}
