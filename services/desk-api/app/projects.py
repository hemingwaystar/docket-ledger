"""Project lifecycle — the prototype's checklist flow, server-enforced.
open → review → approved; approval freezes checklist+billing (DB triggers),
locks the ticket (423 via helpers.refuse_if_locked_project everywhere else),
and flips the project's open-period Ledger entries to submitted so they enter
the timesheet-approval chain. Unlock reopens the TICKET only."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter(prefix="/api/projects")


def _project(cur, ticket_id):
    cur.execute("""SELECT status, billing_model, project_flat_cents, unlocked
                     FROM desk.projects WHERE ticket_id = %s""", (ticket_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(404, "Not a project ticket")
    return row


class NewProject(BaseModel):
    title: str
    client: str
    group: str
    owner_email: str
    template: str | None = None            # name from desk.project_templates
    tasks: list[str] = []                  # or explicit labels
    billing_model: str = "per_task"        # per_task | project_flat
    default_task_mode: str = "hourly"      # hourly | flat


@router.post("", status_code=201)
def create_project(body: NewProject, request: Request):
    if body.billing_model not in ("per_task", "project_flat"):
        raise HTTPException(422, "billing_model must be per_task or project_flat")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects')
        with conn.cursor() as cur:
            client_id = helpers.client_id(cur, body.client)
            group_id = helpers.group_id(cur, body.group)
            owner_id, owner_name = helpers.agent(cur, body.owner_email)
            labels = list(body.tasks)
            tpl_name = None
            if body.template:
                cur.execute("SELECT name, tasks FROM desk.project_templates WHERE name = %s",
                            (body.template,))
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(422, "Unknown template")
                tpl_name = row[0]
                labels = [t["label"] for t in row[1]] + labels
            cur.execute("""INSERT INTO desk.tickets
                             (title, client_id, group_id, owner_id, state_id, priority_id,
                              is_project)
                           VALUES (%s, %s, %s, %s, %s, %s, true) RETURNING id""",
                        (body.title, client_id, group_id, owner_id,
                         helpers.state_id(cur, "Open"), helpers.priority_id(cur, "Normal")))
            (ticket_id,) = cur.fetchone()
            cur.execute("""INSERT INTO desk.projects (ticket_id, billing_model, template)
                           VALUES (%s, %s, %s)""",
                        (ticket_id, body.billing_model, tpl_name))
            for pos, label in enumerate(labels, start=1):
                cur.execute("""INSERT INTO desk.project_tasks
                                 (ticket_id, label, position, billing_mode)
                               VALUES (%s, %s, %s, %s)""",
                            (ticket_id, label, pos, body.default_task_mode))
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                           VALUES (%s, 'sys', %s, %s)""",
                        (ticket_id, owner_name,
                         f"Project created" + (f" from template “{tpl_name}”" if tpl_name else "")))
        auth.audit(conn, "desk", "Project created", f"ticket:{ticket_id}",
                   f"#{ticket_id} {body.title} · {body.client} · {len(labels)} tasks "
                   f"· {body.billing_model}")
        return {"id": ticket_id, "tasks": len(labels)}


class NewTask(BaseModel):
    label: str
    billing_mode: str = "hourly"


@router.post("/{ticket_id}/tasks", status_code=201)
def add_task(ticket_id: int, body: NewTask, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status != "open":
                raise HTTPException(409, f"Project is in {status} — checklist frozen")
            cur.execute("""INSERT INTO desk.project_tasks (ticket_id, label, position, billing_mode)
                           VALUES (%s, %s,
                             COALESCE((SELECT max(position) + 1 FROM desk.project_tasks
                                        WHERE ticket_id = %s), 1), %s)
                           RETURNING id""",
                        (ticket_id, body.label, ticket_id, body.billing_mode))
            (task_id,) = cur.fetchone()
        auth.audit(conn, "desk", "Project task added", f"ticket:{ticket_id}",
                   f"#{ticket_id} · “{body.label}”")
        return {"id": str(task_id)}


class PatchTask(BaseModel):
    done: bool | None = None
    done_by_email: str | None = None
    label: str | None = None
    billing_mode: str | None = None        # hourly | flat
    rate_cents: int | None = None          # -1 clears (back to standard pricing)
    flat_cents: int | None = None


@router.patch("/{ticket_id}/tasks/{task_id}")
def patch_task(ticket_id: int, task_id: str, body: PatchTask, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects', 'log_time')
        # billing fields flow straight into Ledger pricing — log_time alone
        # may tick tasks and rename, never touch money (audit)
        if (body.billing_mode is not None or body.rate_cents is not None
                or body.flat_cents is not None):
            auth.need(who, 'manage_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status == "approved":
                raise HTTPException(409, "Project approved — checklist and billing frozen")
            cur.execute("""SELECT label FROM desk.project_tasks
                            WHERE id = %s AND ticket_id = %s""", (task_id, ticket_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such task on this project")
            notes = []
            if body.done is not None:
                if body.done:
                    if not body.done_by_email:
                        raise HTTPException(422, "done_by_email required when completing")
                    aid, name = helpers.agent(cur, body.done_by_email)
                    cur.execute("""UPDATE desk.project_tasks
                                      SET done_at = now(), done_by = %s WHERE id = %s""",
                                (aid, task_id))
                    notes.append(f"completed by {name}")
                else:
                    cur.execute("""UPDATE desk.project_tasks
                                      SET done_at = NULL, done_by = NULL WHERE id = %s""",
                                (task_id,))
                    notes.append("reopened")
            if body.label is not None:
                cur.execute("UPDATE desk.project_tasks SET label = %s WHERE id = %s",
                            (body.label, task_id))
                notes.append(f"renamed → “{body.label}”")
            if body.billing_mode is not None:
                if body.billing_mode not in ("hourly", "flat"):
                    raise HTTPException(422, "billing_mode must be hourly or flat")
                cur.execute("UPDATE desk.project_tasks SET billing_mode = %s WHERE id = %s",
                            (body.billing_mode, task_id))
                notes.append(f"billing → {body.billing_mode}")
            if body.rate_cents is not None:
                val = None if body.rate_cents < 0 else body.rate_cents
                cur.execute("UPDATE desk.project_tasks SET rate_cents = %s WHERE id = %s",
                            (val, task_id))
                notes.append("rate → " + ("standard" if val is None else f"{val}¢/h"))
            if body.flat_cents is not None:
                cur.execute("UPDATE desk.project_tasks SET flat_cents = %s WHERE id = %s",
                            (body.flat_cents, task_id))
                notes.append(f"flat fee → {body.flat_cents}¢")
        if notes:
            auth.audit(conn, "desk", "Project task updated", f"ticket:{ticket_id}",
                       f"#{ticket_id} · “{row[0]}” · " + " · ".join(notes))
        return {"ok": True, "changed": notes}


@router.delete("/{ticket_id}/tasks/{task_id}")
def remove_task(ticket_id: int, task_id: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status != "open":
                raise HTTPException(409, "Checklist frozen")
            cur.execute("SELECT count(*) FROM ledger.time_entries WHERE task_id = %s", (task_id,))
            if cur.fetchone()[0]:
                raise HTTPException(409, "Task has time logged under it — move the time first")
            cur.execute("""DELETE FROM desk.project_tasks
                            WHERE id = %s AND ticket_id = %s AND done_at IS NULL
                          RETURNING label""", (task_id, ticket_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(409, "Task missing or done — reopen before removing")
        auth.audit(conn, "desk", "Project task removed", f"ticket:{ticket_id}",
                   f"#{ticket_id} · “{row[0]}”")
        return {"ok": True}


class Flat(BaseModel):
    billing_model: str | None = None
    project_flat_cents: int | None = None


@router.patch("/{ticket_id}/billing")
def patch_billing(ticket_id: int, body: Flat, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status == "approved":
                raise HTTPException(409, "Approved project billing is immutable")
            notes = []
            if body.billing_model is not None:
                if body.billing_model not in ("per_task", "project_flat"):
                    raise HTTPException(422, "billing_model must be per_task or project_flat")
                cur.execute("UPDATE desk.projects SET billing_model = %s WHERE ticket_id = %s",
                            (body.billing_model, ticket_id))
                notes.append(f"model → {body.billing_model}")
            if body.project_flat_cents is not None:
                cur.execute("UPDATE desk.projects SET project_flat_cents = %s WHERE ticket_id = %s",
                            (body.project_flat_cents, ticket_id))
                notes.append(f"project flat → {body.project_flat_cents}¢")
        if notes:
            auth.audit(conn, "desk", "Project billing changed", f"ticket:{ticket_id}",
                       f"#{ticket_id} · " + " · ".join(notes))
        return {"ok": True, "changed": notes}


@router.post("/{ticket_id}/reopen")
def reopen(ticket_id: int, request: Request):
    """Pull a submitted project back out of review — the approver (or the
    submitter) wants changes before sign-off. approved is one-way; this only
    reverses review → open."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects', 'approve_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status != "review":
                raise HTTPException(409, f"Project is {status}, not in review")
            cur.execute("""UPDATE desk.projects
                              SET status = 'open', submitted_at = NULL, submitted_by = NULL
                            WHERE ticket_id = %s""", (ticket_id,))
        auth.audit(conn, "desk", "Project reopened from review", f"ticket:{ticket_id}",
                   f"#{ticket_id}")
        return {"ok": True}


@router.post("/{ticket_id}/submit")
def submit(ticket_id: int, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_projects')
        with conn.cursor() as cur:
            status, model, flat, _ = _project(cur, ticket_id)
            if status != "open":
                raise HTTPException(409, f"Project is already in {status}")
            cur.execute("""SELECT count(*) FILTER (WHERE done_at IS NULL),
                                  count(*) FILTER (WHERE billing_mode = 'flat'
                                                   AND COALESCE(flat_cents, 0) = 0),
                                  count(*)
                             FROM desk.project_tasks WHERE ticket_id = %s""", (ticket_id,))
            open_tasks, unfee_d, total = cur.fetchone()
            if total == 0:
                raise HTTPException(409, "Add at least one task first")
            if open_tasks:
                raise HTTPException(409, f"{open_tasks} tasks still open")
            if model == "project_flat":
                if not flat:
                    raise HTTPException(409, "Set the project flat rate first")
            elif unfee_d:
                raise HTTPException(409, f"{unfee_d} flat tasks have no fee set")
            cur.execute("SELECT count(*) FROM ledger.time_entries "
                        "WHERE ticket_id = %s AND task_id IS NULL AND status <> 'void'",
                        (ticket_id,))
            if cur.fetchone()[0]:
                raise HTTPException(409, "Some time entries have no task — assign them first")
            cur.execute("""UPDATE desk.projects
                              SET status = 'review', submitted_at = now()
                            WHERE ticket_id = %s""", (ticket_id,))
        auth.audit(conn, "desk", "Project submitted for review", f"ticket:{ticket_id}",
                   f"#{ticket_id} · {total} tasks complete")
        return {"ok": True}


class Approve(BaseModel):
    approver_email: str


@router.post("/{ticket_id}/approve")
def approve(ticket_id: int, body: Approve, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'approve_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status != "review":
                raise HTTPException(409, f"Project is in {status}, not review")
            aid, name = helpers.agent(cur, body.approver_email)
            cur.execute("""UPDATE desk.projects
                              SET status = 'approved', approved_at = now(), approved_by = %s
                            WHERE ticket_id = %s""", (aid, ticket_id))
            cur.execute("UPDATE desk.tickets SET state_id = %s WHERE id = %s",
                        (helpers.state_id(cur, "Solved"), ticket_id))
            cur.execute("""UPDATE ledger.time_entries e
                              SET submitted_at = now(),
                                  returned_at = NULL, returned_by = NULL, return_reason = NULL
                             FROM ledger.billing_periods bp
                            WHERE bp.id = e.period_id AND bp.status = 'open'
                              AND e.ticket_id = %s AND e.status <> 'void'
                              AND e.submitted_at IS NULL""", (ticket_id,))
            queued = cur.rowcount
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                           VALUES (%s, 'sys', %s,
                                   'Project approved — billing frozen, time queued for timesheet review')""",
                        (ticket_id, name))
        auth.audit(conn, "desk", "Project approved → Ledger", f"ticket:{ticket_id}",
                   f"#{ticket_id} approved by {name} · {queued} entries queued for timesheet approval")
        return {"ok": True, "entries_queued": queued}


@router.post("/{ticket_id}/unlock")
def unlock(ticket_id: int, request: Request):
    """Admin unlock: reopens the TICKET (notes/time/props). Checklist and
    billing stay frozen — they billed. Re-lock with /relock."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'approve_projects')
        with conn.cursor() as cur:
            status, *_ = _project(cur, ticket_id)
            if status != "approved":
                raise HTTPException(409, "Only approved projects lock")
            cur.execute("UPDATE desk.projects SET unlocked = true WHERE ticket_id = %s",
                        (ticket_id,))
        auth.audit(conn, "desk", "Project ticket unlocked (admin)", f"ticket:{ticket_id}",
                   f"#{ticket_id} — ticket editable; approved billing stays frozen")
        return {"ok": True}


@router.post("/{ticket_id}/relock")
def relock(ticket_id: int, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'approve_projects')
        with conn.cursor() as cur:
            _project(cur, ticket_id)
            cur.execute("UPDATE desk.projects SET unlocked = false WHERE ticket_id = %s",
                        (ticket_id,))
        auth.audit(conn, "desk", "Project ticket re-locked", f"ticket:{ticket_id}",
                   f"#{ticket_id}")
        return {"ok": True}
