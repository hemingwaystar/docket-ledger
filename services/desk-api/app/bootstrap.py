"""First-admin bootstrap — run inside the container:
  docker compose exec desk-api python -m app.bootstrap you@hemingwaytech.com "Your Name"
Creates (or updates) the agent as Admin with a temp password printed ONCE."""
import secrets
import sys
from argon2 import PasswordHasher
from . import db


def main():
    if len(sys.argv) < 2:
        print("usage: python -m app.bootstrap <email> [name]")
        sys.exit(1)
    email = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else email.split("@")[0].title()
    temp = secrets.token_urlsafe(12)
    hashed = PasswordHasher().hash(temp)
    with db.connect("admin:bootstrap") as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM shared.roles WHERE name = 'Admin'")
        (role_id,) = cur.fetchone()
        cur.execute("""INSERT INTO shared.agents
                         (name, email, initials, role_id, password_hash, password_must_change)
                       VALUES (%s, %s, %s, %s, %s, true)
                       ON CONFLICT (email) DO UPDATE
                         SET role_id = EXCLUDED.role_id,
                             password_hash = EXCLUDED.password_hash,
                             password_must_change = true
                       RETURNING id""",
                    (name, email, "".join(w[0] for w in name.split()[:2]).upper(),
                     role_id, hashed))
        (aid,) = cur.fetchone()
        cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                       VALUES ('auth', 'Admin bootstrapped', %s,
                               %s)""",
                    (f"agent:{aid}", f"{email} — temp password issued at the console, must change"))
        conn.commit()
    print(f"Admin ready: {email}")
    print(f"Temp password (shown once, must change at first login): {temp}")


if __name__ == "__main__":
    main()
