"""Shared DB helper: pooled connections, per-transaction actor for audit."""
import os, pathlib
import psycopg

def _password() -> str:
    return pathlib.Path(os.environ["DATABASE_PASSWORD_FILE"]).read_text().strip()

def conninfo() -> str:
    return (
        f"host={os.environ['DATABASE_HOST']} dbname={os.environ['DATABASE_NAME']} "
        f"user={os.environ['DATABASE_USER']} password={_password()}"
    )

def connect(actor: str = "system"):
    """One connection, actor set for audit triggers. Use as context manager."""
    conn = psycopg.connect(conninfo())
    with conn.cursor() as cur:
        cur.execute("SET app.actor = %s", (actor,))
    return conn
