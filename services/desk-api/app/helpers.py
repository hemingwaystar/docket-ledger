"""Lookups shared by the desk routers — every endpoint accepts human handles
(names, emails, labels) or uuids and resolves them here, one way, once."""
from fastapi import HTTPException


def one(cur, sql, args, err):
    cur.execute(sql, args)
    row = cur.fetchone()
    if row is None:
        raise HTTPException(422, err)
    return row


def client_id(cur, handle):
    return one(cur, "SELECT id FROM shared.clients WHERE name = %s OR id::text = %s",
               (handle, handle), "Unknown client")[0]


def group_id(cur, handle):
    return one(cur, "SELECT id FROM shared.groups WHERE name = %s OR id::text = %s",
               (handle, handle), "Unknown group")[0]


def agent(cur, email):
    return one(cur, "SELECT id, name FROM shared.agents WHERE lower(email) = lower(%s)",
               (email,), "Unknown agent")


def state_id(cur, label):
    return one(cur, "SELECT id FROM desk.ticket_states WHERE lower(label) = lower(%s) AND active",
               (label,), "Unknown state")[0]


def priority_id(cur, label):
    return one(cur, "SELECT id FROM desk.priorities WHERE lower(label) = lower(%s) AND active",
               (label,), "Unknown priority")[0]


def activity_type_id(cur, handle):
    return one(cur, "SELECT id FROM ledger.activity_types WHERE name = %s OR id::text = %s",
               (handle, handle), "Unknown activity type")[0]


def ticket_or_404(cur, ticket_id):
    cur.execute("""SELECT t.id, t.client_id, t.is_project, t.version, t.merged_into_id,
                          COALESCE(p.status, '') AS project_status,
                          COALESCE(p.unlocked, false) AS project_unlocked
                     FROM desk.tickets t
                     LEFT JOIN desk.projects p ON p.ticket_id = t.id
                    WHERE t.id = %s""", (ticket_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(404, "No such ticket")
    return row


def refuse_if_locked_project(row):
    """Approved + not admin-unlocked project tickets are immutable (mirrors
    the prototype's projLocked). row from ticket_or_404."""
    if row[2] and row[5] == "approved" and not row[6]:
        raise HTTPException(423, "Project is approved & locked — admin unlock required")
