/* ==========================================================================
   js/desk/views/props.js — the ticket properties sidebar and its actions:
   state/priority/owner/group, client move, primary contact, tech schedules
   (the on-hold Schedules bar — build 16), title rename, merge, related links,
   parent/child (one level) with the close-cascade prompt, and on-ticket caller
   verification.
   Owns: renderProps() · setProp() + cascadeModal/cascadeJust/cascadeAll ·
   setAssignees() · renderSchedules()/addSchedule/removeSchedule/schedMs/
   reconcileSched (build 16) · saveTitle() · mergeModal/doMerge ·
   linkModal/doLink/
   unlink · childModal/doChild/unchild · setPrimaryContact() ·
   reclientTicket() · verifyModal/vfySend/vfyCheck.
   Endpoints:
     PATCH /api/tickets/{id}                (state/priority/owner/group · title
                                             · primary contact)
     PUT   /api/tickets/{id}/assignees      (assigned techs — FULL REPLACE; the
                                             side table carries no version, so
                                             this never raises the 409 lock)
     POST   /api/tickets/{id}/schedules            (add one tech time block)
     DELETE /api/tickets/{id}/schedules/{sid}      (remove one block)
                                            (both write desk.tickets.pending_until
                                             as a DERIVED value = MIN future
                                             starts_at; no version → never 409.
                                             pending_until is no longer hand-set:
                                             Schedules drives the wake mechanism)
     POST  /api/tickets/{id}/client         (move to another client)
     POST  /api/tickets/{id}/merge
     POST  /api/tickets/{id}/links          (kind: related | child)
     POST  /api/tickets/{id}/unlink
     POST  /api/tickets/{id}/close-cascade  (parent + open children, one transaction)
     POST  /api/tickets/{id}/verify/start   (the server sends the code — the
                                             agent NEVER sees it)
     POST  /api/tickets/{id}/verify/check
   Invariants: local state mutates first, the API call fires only when local
   state actually changed, oops() on refusal. bulkApply (views/tickets.js)
   sets window._bulkRun around bulk changes so they never prompt the cascade.
   ========================================================================== */

/* ---------------- ticket merge & linking ---------------- */
function mergeModal(tid){
  if(!can('edit_props')) return;
  const t = tk(tid);
  const cands = state.tickets.filter(x=>x.id!==tid && !x.mergedInto);
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Merge #${tid} into…</h3><p>Everything moves to the target — the full thread (with a divider), every time entry, tags and the Cc list. This ticket becomes a closed stub that points at the target. This cannot be undone in the UI.</p></div>
    <div class="modal-body"><div class="field"><label>Target ticket</label>
      <select id="mgTarget">${cands.map(x=>`<option value="${x.id}">#${x.id} · ${esc((TITLES[x.id]||firstLine(x)).slice(0,60))} (${esc(client(x.clientId).name)})</option>`).join('')}</select></div>
      <div class="mini muted">Cross-client merges are allowed but flagged in the audit line.</div></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="doMerge(${tid})">Merge</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function doMerge(fromId){
  const el = document.getElementById('mgTarget');
  const from = tk(fromId), to = el ? tk(Number(el.value)) : null;
  if(!from || !to) return;
  const crossClient = from.clientId!==to.clientId;
  to.articles.push(art('sys', me(), nowMs(), `⬇ Merged from #${from.id} — “${TITLES[from.id]||firstLine(from)}” — thread and time follow`));
  from.articles.forEach(a=>{ to.articles.push(a); });
  from.time.forEach(e=>{ to.time.push(e); });
  to.tags = [...new Set([...to.tags, ...from.tags])];
  if(from.cc && from.cc.length) to.cc = [...new Set([...(to.cc||[]), ...from.cc])];
  from.articles = [ art('sys', me(), nowMs(), `Merged into #${to.id}`) ];
  from.time = [];
  from.st = 'closed'; from.mergedInto = to.id;
  delete from.pendingUntil;
  to.updatedAt = nowMs(); from.updatedAt = nowMs();
  log('Ticket merged', `#${from.id} → #${to.id}${crossClient?' · CROSS-CLIENT':''} · thread, time, tags and Cc moved`);
  bridgeSend('ticket-merged', { from:from.id, to:to.id });
  toast(`Merged into #${to.id} — everything moved; this ticket is now a stub.`);
  closeModal(); openTicket(to.id);
  $fetch('/api/tickets/'+fromId+'/merge',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({into:to.id})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),500); });
}
function linkModal(tid){
  if(!can('edit_props')) return;
  const cands = state.tickets.filter(x=>x.id!==tid && !x.mergedInto && !(tk(tid).links||[]).includes(x.id));
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Link a related ticket</h3><p>Links are two-way and purely navigational — nothing merges.</p></div>
    <div class="modal-body"><div class="field"><label>Ticket</label>
      <select id="lkTarget">${cands.map(x=>`<option value="${x.id}">#${x.id} · ${esc((TITLES[x.id]||firstLine(x)).slice(0,60))}</option>`).join('')}</select></div></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="doLink(${tid})">Link</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function doLink(tid){
  const el = document.getElementById('lkTarget');
  const other = el ? Number(el.value) : null;
  const a = tk(tid), b = other ? tk(other) : null; if(!a||!b) return;
  a.links = a.links||[]; b.links = b.links||[];
  const before = a.links.length;
  if(!a.links.includes(other)) a.links.push(other);
  if(!b.links.includes(tid)) b.links.push(tid);
  log('Tickets linked', `#${tid} ↔ #${other}`);
  closeModal(); render();
  if(a.links.length===before) return;              /* already linked */
  $fetch('/api/tickets/'+tid+'/links',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'related',other})})
    .then(async r=>{ if(!r.ok){ oops(await r.json().catch(()=>0)); setTimeout(()=>hydrate(),200); } });
}
function unlink(tid, other){
  const a = tk(tid), b = tk(other);
  const had = ((a||{}).links||[]).includes(other);
  if(a) a.links = (a.links||[]).filter(x=>x!==other);
  if(b) b.links = (b.links||[]).filter(x=>x!==tid);
  log('Tickets unlinked', `#${tid} ↔ #${other}`);
  render();
  if(!had) return;
  $fetch('/api/tickets/'+tid+'/unlink',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'related',other})})
    .then(async r=>{ if(!r.ok){ oops(await r.json().catch(()=>0)); setTimeout(()=>hydrate(),200); } });
}
/* parent/child links — hierarchy is strictly ONE level: a parent takes any
   number of children, but a child can NEVER itself be a parent, and the UI
   says exactly that instead of hiding the button. Server enforces the same. */
function childModal(tid){
  if(!can('edit_props')) return;
  const t = tk(tid); if(!t || t.mergedInto) return;
  if(t.parentId){ toast(`#${tid} is a child of #${t.parentId} — a child ticket can’t be a parent.`); return; }
  const cands = state.tickets.filter(x=>x.id!==tid && !x.mergedInto && !x.parentId
    && !(x.children&&x.children.length) && !(t.children||[]).includes(x.id));
  if(!cands.length){ toast('No eligible tickets — a child needs to be open-standing: not merged, not already a child, and without children of its own.'); return; }
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Add a child ticket</h3><p>One level only — the child files under this ticket, keeps its own client, time and SLA, and closes quietly (no close email) when this parent closes.</p></div>
    <div class="modal-body"><div class="field"><label>Ticket</label>
      <select id="chTarget">${cands.map(x=>`<option value="${x.id}">#${x.id} · ${esc((TITLES[x.id]||firstLine(x)).slice(0,60))}</option>`).join('')}</select></div></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="doChild(${tid})">Add child</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function doChild(tid){
  const el = document.getElementById('chTarget');
  const other = el ? Number(el.value) : null;
  const p = tk(tid), c = other ? tk(other) : null; if(!p||!c) return;
  if(p.parentId){ toast(`#${tid} is a child of #${p.parentId} — a child ticket can’t be a parent.`); return; }
  if(c.children&&c.children.length){ toast(`#${other} already has children — it can’t become a child.`); return; }
  if(c.parentId){ toast(`#${other} is already a child of #${c.parentId}.`); return; }
  p.children = p.children||[]; p.children.push(other); c.parentId = tid;
  p.articles.push(art('sys', me(), nowMs(), `Child ticket linked: #${other}`));
  c.articles.push(art('sys', me(), nowMs(), `Linked as a child of #${tid}`));
  log('Tickets linked', `#${tid} → child #${other}`);
  closeModal(); render();
  $fetch('/api/tickets/'+tid+'/links',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'child',other})})
    .then(async r=>{ if(!r.ok){ oops(await r.json().catch(()=>0)); setTimeout(()=>hydrate(),200); } });
}
function unchild(pid, cid){
  const p = tk(pid), c = tk(cid);
  const had = ((p||{}).children||[]).includes(cid) || (c||{}).parentId===pid;
  if(p) p.children = (p.children||[]).filter(x=>x!==cid);
  if(c && c.parentId===pid) c.parentId = null;
  log('Tickets unlinked', `#${pid} ⇸ child #${cid}`);
  render();
  if(!had) return;
  $fetch('/api/tickets/'+pid+'/unlink',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'child',other:cid})})
    .then(async r=>{ if(!r.ok){ oops(await r.json().catch(()=>0)); setTimeout(()=>hydrate(),200); } });
}

/* ---------------- schedule inputs / title / properties ---------------- */
/* datetime-local wants LOCAL wall-clock; toISOString() is UTC and shifted
   the displayed time by the timezone offset. Shared by the Schedules bar's
   start/end inputs (build 16) — was the Wake-up field's helper before. */
function dtLocalVal(ms){
  const d=new Date(ms), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ==========================================================================
   TECH SCHEDULES (build 16) — the on-hold "Schedules" bar. Replaces the single
   Wake-up field: a list of per-tech time blocks (who works this paused ticket
   and when). The server keeps desk.tickets.pending_until = MIN(starts_at) among
   FUTURE schedule rows, so the EXISTING wake mechanism (mail-worker's
   wake_pending + the local checkPendingWakes) auto-resumes the ticket at the
   earliest scheduled start — untouched. pending_until is now DERIVED, never
   hand-set. renderSchedules is placed next to renderProps by viewTicket ONLY on
   paused tickets, mirroring where Wake-up used to live.
   startsAt/endsAt ride from bootstrap as ISO strings OR epoch ms — schedMs()
   normalizes either to ms for dtLocalVal/fmtDT; addSchedule POSTs ISO strings
   (the fixed contract). Modeled on setAssignees: the endpoints write a side
   table (never read/bump ticket.version → never the 409 lock), so each handler
   optimistically mutates + render()s, then reconciles t.schedules AND the
   derived t.pendingUntil from the authoritative response, oops() on refusal.
   ========================================================================== */
const schedMs = v => v==null? null : (typeof v==='number'? v : new Date(v).getTime());
/* reconcile local state against the endpoint's authoritative return: the full
   schedule list and the recomputed pending_until (the derived wake moment) */
function reconcileSched(t, d){
  if(d && Array.isArray(d.schedules)) t.schedules = d.schedules;
  if(d && ('pending_until' in d)){
    const pu = schedMs(d.pending_until);
    if(pu) t.pendingUntil = pu; else delete t.pendingUntil;
  }
  /* the schedule write bumps the ticket's version via the touch trigger — keep
     the optimistic-lock token fresh so the next property edit doesn't 409 */
  if(d && d.version) t.version = d.version;
  render();
}
function renderSchedules(t){
  const asg = can('assign');
  const list = (t.schedules||[]).slice().sort((a,b)=>(schedMs(a.startsAt)||0)-(schedMs(b.startsAt)||0));
  /* prefill the tech picker with the owner, then the first assignee, then the
     first active agent — the person most likely being scheduled */
  const dflt = t.ownerId || (t.assigneeIds||[])[0] || (AGENTS.find(a=>!isArch(a))||{}).id || '';
  return `
  <div>
    <div class="card props sched">
      <div class="prop"><div class="pk">Schedules</div>
        <div class="mini muted">At the earliest scheduled start, an on-hold ticket comes off hold automatically.</div></div>
      ${list.length? list.map(s=>{
        const nm = agent(s.agentId)?.name || '?';
        const a = schedMs(s.startsAt), b = schedMs(s.endsAt);
        const done = s.completedAt!=null;
        /* a block's own tech can check it off; anyone else needs 'assign' */
        const canToggle = can('assign') || String(s.agentId)===String(state.meId);
        return `<div class="prop sched-row${done?' sched-done':''}">
          <div style="display:flex;gap:8px;align-items:flex-start">
            ${canToggle?`<input type="checkbox" class="sched-chk" ${done?'checked':''}
                onclick="toggleScheduleDone(${t.id},'${jsq(s.id)}',this.checked)"
                title="${done?('Completed'+(s.completedBy?' by '+esc(s.completedBy):'')+' — click to reopen'):'Mark this schedule complete'}">`:''}
            <div style="flex:1;min-width:0">
              <div class="pv sched-nm" style="font-weight:600">${esc(nm)}</div>
              <div class="mini sched-when">${fmtDT(a)}${b?' – '+fmtDT(b):''}</div>
              ${s.note?`<div class="mini muted" style="margin-top:2px;white-space:pre-wrap">${esc(s.note)}</div>`:''}
              ${done&&s.completedBy?`<div class="mini muted" style="margin-top:2px">✓ ${esc(s.completedBy)}${s.completedAt?' · '+fmtDT(schedMs(s.completedAt)):''}</div>`:''}
            </div>
            ${asg?`<button class="rowbtn" style="padding:0 6px" onclick="removeSchedule(${t.id},'${jsq(s.id)}')" title="Remove this schedule">✕</button>`:''}
          </div></div>`;
      }).join('') : `<div class="prop"><div class="mini muted">No techs scheduled yet.</div></div>`}
      ${asg?`<div class="prop">
        <div class="pk">Add a tech</div>
        <select id="sched-tech-${t.id}">
          ${AGENTS.filter(a=>!isArch(a)).map(a=>`<option value="${a.id}" ${a.id===dflt?'selected':''}>${esc(a.name)}</option>`).join('')}
        </select>
        <div class="mini muted" style="margin:7px 0 3px">Start</div>
        <input type="datetime-local" id="sched-start-${t.id}" value="${dtLocalVal(nowMs())}" title="When this tech is scheduled to start — the earliest future start takes the ticket off hold">
        <div class="mini muted" style="margin:7px 0 3px">End</div>
        <input type="datetime-local" id="sched-end-${t.id}" title="Optional — when the block ends">
        <input type="text" id="sched-note-${t.id}" placeholder="Note (optional)" style="margin-top:7px">
        <button class="btn sm primary" style="margin-top:9px" onclick="addSchedule(${t.id})">Add schedule</button>
      </div>`:''}
    </div>
  </div>`;
}
/* read the add-row inputs, validate BEFORE touching the ticket (a blocked add
   leaves no side effects), optimistically append + render, POST ISO, reconcile */
function addSchedule(tid){
  if(!can('assign')) return;
  const t = tk(tid); if(!t) return;
  const tech = (document.getElementById('sched-tech-'+tid)||{}).value || '';
  const sv   = (document.getElementById('sched-start-'+tid)||{}).value || '';
  const ev   = (document.getElementById('sched-end-'+tid)||{}).value || '';
  const note = ((document.getElementById('sched-note-'+tid)||{}).value || '').trim();
  if(!tech){ toast('Pick a tech to schedule.'); return; }
  if(!sv){ toast('A schedule needs a start time.'); return; }
  const startMs = new Date(sv).getTime();
  if(isNaN(startMs)){ toast('That start time is invalid.'); return; }
  let endMs = null;
  if(ev){
    endMs = new Date(ev).getTime();
    if(isNaN(endMs)){ toast('That end time is invalid.'); return; }
    if(!(endMs>startMs)){ toast('End must be after start — schedule not added.'); return; }
  }
  /* --- validated; mutation begins --- */
  t.schedules = t.schedules || [];
  const nm = agent(tech)?.name || tech;
  /* a distinctively-prefixed temp id so removeSchedule can tell an un-mirrored
     optimistic row (nothing to DELETE) from a server bigint id */
  t.schedules.push({ id:'sched-tmp-'+(state.schedSeq=(state.schedSeq||0)+1),
    agentId:tech, startsAt:startMs, endsAt:endMs, note:note||null });
  t.schedules.sort((a,b)=>(schedMs(a.startsAt)||0)-(schedMs(b.startsAt)||0));
  t.articles.push(art('sys', me(), nowMs(), `Scheduled ${nm} ${fmtDT(startMs)}${endMs?'–'+fmtDT(endMs):''}`));
  log('Schedule added', `#${t.id} · ${nm} · ${fmtDT(startMs)}${endMs?'–'+fmtDT(endMs):''}`);
  render();
  $fetch('/api/tickets/'+tid+'/schedules',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({agent_id:tech, starts_at:new Date(startMs).toISOString(),
      ends_at:endMs?new Date(endMs).toISOString():null, note:note||null})})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      reconcileSched(t, d); });
}
/* optimistically splice the row + render, then DELETE and reconcile. An
   un-mirrored optimistic row (temp id) has nothing on the server to delete */
function removeSchedule(tid, schedId){
  if(!can('assign')) return;
  const t = tk(tid); if(!t) return;
  const before = (t.schedules||[]).length;
  const gone = (t.schedules||[]).find(s=>String(s.id)===String(schedId));
  t.schedules = (t.schedules||[]).filter(s=>String(s.id)!==String(schedId));
  if(t.schedules.length===before) return;           /* nothing removed */
  const nm = gone? (agent(gone.agentId)?.name||gone.agentId) : '';
  t.articles.push(art('sys', me(), nowMs(), `Schedule removed${nm?' — '+nm:''}`));
  log('Schedule removed', `#${t.id}${nm?' · '+nm:''}`);
  render();
  if(String(schedId).startsWith('sched-tmp-')) return;   /* never mirrored — nothing to DELETE */
  $fetch('/api/tickets/'+tid+'/schedules/'+encodeURIComponent(schedId),{method:'DELETE'})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      reconcileSched(t, d); });
}
/* mark a schedule block complete / reopen — strikes it through everywhere it
   shows (this Schedules bar + the Schedule calendar). The block's own tech can
   check it off; anyone else needs 'assign'. Optimistic like add/remove: stamp
   locally + render, POST, reconcile from the authoritative payload; a temp
   (un-mirrored) row toggles locally only (nothing on the server yet). */
function toggleScheduleDone(tid, schedId, done){
  const t = tk(tid); if(!t) return;
  const s = (t.schedules||[]).find(x=>String(x.id)===String(schedId)); if(!s) return;
  if(!(can('assign') || String(s.agentId)===String(state.meId))) return;
  s.completedAt = done ? nowMs() : null;
  s.completedBy = done ? (me()?.name || state.user.name) : null;
  const nm = agent(s.agentId)?.name || s.agentId;
  t.articles.push(art('sys', me(), nowMs(), `Schedule for ${nm} ${done?'completed':'reopened'}`));
  log(`Schedule ${done?'completed':'reopened'}`, `#${t.id} · ${nm}`);
  render();
  if(String(schedId).startsWith('sched-tmp-')) return;   /* not yet mirrored — local only */
  $fetch('/api/tickets/'+tid+'/schedules/'+encodeURIComponent(schedId)+'/complete',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({done:!!done})})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      reconcileSched(t, d); });
}

/* ---------------- ticket audit block ----------------
   The automatic events on a ticket — schedules, assignments, triggers,
   state/owner/title changes, merges — used to interleave with the human
   conversation in the thread. They live here instead, in their own sidebar
   card (newest first), so the thread stays a clean back-and-forth. These ARE
   the ticket's 'sys' articles; viewTicket now renders only mail-in/reply/note
   in the thread and hands the 'sys' ones to this card. Read-only — the events
   are written by the actions that cause them (and to the audit log). */
function renderAudit(t){
  const events = (t.articles||[]).filter(a=>a.kind==='sys').slice().reverse();
  return `<div class="card props audit">
    <div class="prop"><div class="pk">Audit</div>
      <div class="mini muted">Automatic events on this ticket — schedules, assignments, triggers and state changes.</div></div>
    ${events.length
      ? `<div class="audit-scroll">${events.map(a=>`
          <div class="prop audit-row">
            <div class="mini" style="color:var(--ink-2);line-height:1.5">${esc(a.body)}</div>
            <div class="mini muted" style="margin-top:2px">${fmtDT(a.ts)}</div>
          </div>`).join('')}</div>`
      : `<div class="prop"><div class="mini muted">No events yet.</div></div>`}
  </div>`;
}

function saveTitle(tid){
  const t = tk(tid); if(!t || projLocked(t)) return;
  if(!(can('edit_props') || t.ownerId===state.meId)) return;
  const v = document.getElementById('ttl-'+tid).value.trim();
  if(!v){ toast('A ticket needs a title.'); return; }
  const was = TITLES[tid]||firstLine(t);
  if(v !== was){
    TITLES[tid] = v;
    t.articles.push(art('sys', me(), nowMs(), `Title changed to “${v}”`));
    t.updatedAt = nowMs();
    log('Ticket renamed', `#${tid} · “${was}” → “${v}”`);
    toast('Title updated — audited.');
    $fetch('/api/tickets/'+tid,{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title:TITLES[tid],version:t.version})})
      .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
        if(d&&d.version) t.version=d.version;
        setTimeout(()=>hydrate(),400); });
  }
  state.editTitle = null; render();
}

function setProp(tid,k,v,noCascade){
  /* closing a parent with open children: offer the cascade first. Children
     land in the SYSTEM state 'Closed: child ticket', so close-email triggers
     ("state → Closed/Solved") never fire for them. Bulk never prompts —
     bulkApply (views/tickets.js) raises window._bulkRun and the parents
     close alone; children keep their own lifecycle. */
  if(k==='st' && !noCascade && !window._bulkRun){
    const t0=tk(tid), tgt=st8(v);
    if(t0&&tgt&&tgt.type==='done'&&(st8(t0.st)||{}).type!=='done'){
      const openKids=(t0.children||[]).filter(id=>{const c=tk(id); return c&&(st8(c.st)||{}).type!=='done';});
      if(openKids.length){ cascadeModal(tid,v,openKids); return; }
    }
  }
  if(projLocked(tk(tid))){ toast('Approved project — properties are frozen. Admin unlock available on the checklist card.'); render(); return; }
  const t=tk(tid); if(!t) return;
  const was={st:t.st,prio:t.prio,ownerId:t.ownerId,groupId:t.groupId};
  if(k==='st'){ if(!can('edit_props')&&!can('close')) return;
    if((st8(v)||{}).type==='done' && !can('close')){ toast('Your role can’t close tickets.'); render(); return; }
    const from=st8(t.st)?.label||t.st;
    t.articles.push(art('sys', me(), nowMs(), 'State set to '+st8(v).label.toLowerCase())); t.st=v;
    log('State changed',`#${t.id} · ${from} → ${st8(v).label}`); }
  if(k==='prio'){ if(!can('edit_props')) return; const from=prio(t.prio)?.label||t.prio; t.prio=Number(v);
    log('Priority changed',`#${t.id} · ${from} → ${prio(t.prio).label}`); }
  if(k==='ownerId'){ if(!can('assign')) return; const from=t.ownerId?agent(t.ownerId).name:'unassigned'; t.ownerId=v||null;
    log('Owner changed',`#${t.id} · ${from} → ${v?agent(v).name:'unassigned'}`);
    t.articles.push(art('sys', me(), nowMs(), v?('Assigned to '+agent(v).name):'Owner cleared')); }
  if(k==='groupId'){ if(!can('assign')) return; const from=grp(t.groupId)?.name||t.groupId; t.groupId=v;
    log('Group changed',`#${t.id} · ${from} → ${grp(v).name}`); }
  t.updatedAt=nowMs(); render();
  let payload=null;
  if(t.st!==was.st)           payload={state:(st8(t.st)||{label:t.st}).label};
  else if(t.prio!==was.prio)  payload={priority:(prio(t.prio)||{label:'Normal'}).label};
  else if(t.ownerId!==was.ownerId) payload={owner_email:t.ownerId?((AGENTS.find(a=>a.id===t.ownerId)||{}).email||ME.email):''};
  else if(t.groupId!==was.groupId) payload={group:t.groupId};
  if(!payload) return;                             /* nothing changed */
  payload.version=t.version;
  $fetch('/api/tickets/'+tid,{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      if(d&&d.version) t.version=d.version;       /* pause → set wake within one hydrate window must not 409 */
      setTimeout(()=>hydrate(),400); });
}
function cascadeModal(tid,v,openKids){
  const m=document.getElementById('modal');
  m.innerHTML=`
    <div class="modal-head"><h3>Close child tickets too?</h3><p>${openKids.length} of ${(tk(tid).children||[]).length} child ticket${(tk(tid).children||[]).length===1?'':'s'} ${openKids.length===1?'is':'are'} still open: ${openKids.map(x=>'#'+x).join(', ')}. Closing them with this parent files them as “Closed: child ticket” — a quiet close: no close email goes out, each gets an internal note instead.</p></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn ghost" onclick="cascadeJust(${tid},'${v}')">Just this ticket</button><button class="btn primary" onclick="cascadeAll(${tid},'${v}')">Close them too</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function cascadeJust(tid,v){ closeModal(); setProp(tid,'st',v,true); }
/* one transaction on the server (bug #33's lesson: no partial ghosts) */
function cascadeAll(tid,v){
  closeModal();
  const t=tk(tid); if(!t) return;
  const ver=t.version;
  const kids=(t.children||[]).filter(id=>{const c=tk(id); return c&&(st8(c.st)||{}).type!=='done';});
  const cc=st8('child-closed')?'child-closed':'closed';
  t.articles.push(art('sys', me(), nowMs(), 'State set to '+(st8(v)||{label:v}).label.toLowerCase()));
  t.st=v;
  kids.forEach(id=>{ const c=tk(id); c.st=cc;
    c.articles.push(art('sys', me(), nowMs(), `Closed with parent #${tid} (${(st8(v)||{label:v}).label})`)); });
  t.articles.push(art('sys', me(), nowMs(),
    `Closed with ${kids.length} child ticket${kids.length===1?'':'s'}: ${kids.map(x=>'#'+x).join(', ')}`));
  log('Ticket closed with children', `#${tid} + ${kids.map(x=>'#'+x).join(', ')}`);
  render();
  $fetch('/api/tickets/'+tid+'/close-cascade',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({state:(st8(v)||{label:'Closed'}).label, version:ver})})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      if(d&&d.version) t.version=d.version;
      setTimeout(()=>hydrate(),400); });
}

/* ---------------- assigned techs (build 15) ----------------------------------
   Additional techs beyond the single OWNER: an assignee gains visibility and
   the ticket counts as theirs in "Mine"/"Assigned to me" (isMine, state.js).
   FULL-REPLACE membership, modeled EXACTLY on setAgentGroups (views/settings.js):
   slice the 'asg-' fkey prefix for the ticket id, take the multiCombo's
   selection, diff-guard (row 21), optimistic-mutate + render, then PUT the
   whole set. The endpoint writes only the desk.ticket_assignees side table —
   it never reads or bumps ticket.version — so no version rides the body and it
   can never raise the optimistic-lock 409; there is no success-rehydrate, oops()
   rehydrates only on refusal (same shape as setAgentGroups). */
function setAssignees(sel, fkey){
  if(!can('assign')) return;
  const t = tk(Number(fkey.slice('asg-'.length))); if(!t) return;
  const cur = t.assigneeIds || [];
  if(sel.length===cur.length && sel.every(id=>cur.includes(id))) return;   /* diff-guard (row 21) */
  t.assigneeIds = sel.slice();
  const names = t.assigneeIds.map(id=>agent(id)?.name||id).join(', ');
  log('Assignees changed', `#${t.id} · ${names||'none'}`);
  t.articles.push(art('sys', me(), nowMs(), names? 'Assignees: '+names : 'Assignees cleared'));
  render();
  $fetch('/api/tickets/'+t.id+'/assignees',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({assignees:t.assigneeIds.slice()})})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      /* reconcile against the authoritative applied set — the server skips any
         inactive/unknown id, so a stale selection can leave us ahead of it */
      if(d && Array.isArray(d.assignees) &&
         !(d.assignees.length===t.assigneeIds.length && d.assignees.every(id=>t.assigneeIds.includes(id)))){
        t.assigneeIds = d.assignees; render();
      } });
}

/* ---------------- client move & primary contact ---------------- */
/* move a ticket — and, from intake, its sender — to the right client */
function reclientTicket(tid, targetId){
  const t = tk(tid); const target = client(targetId);
  if(!t || !target || target.sentinel || !can('edit_props')) return;
  const was = t.clientId;
  const src = client(t.clientId);
  const p = contact(t.contactId);
  if(p && src && src.sentinel){
    src.contacts.splice(src.contacts.indexOf(p),1);
    target.contacts.push(p);
    p.notes = (p.notes? p.notes+' ' : '') + `Claimed into ${target.name} from Unassigned intake.`;
  }
  const wasName = src?.name || '—';
  t.clientId = targetId;
  t.tags = t.tags.filter(x=>x!=='unrouted');
  t.articles.push(art('sys', me(), nowMs(), `Moved to ${target.name}${p?` · ${p.name} added to their contacts`:''}`));
  t.updatedAt = nowMs();
  log('Ticket moved to client', `#${tid} · ${wasName} → ${target.name}${p?` · sender claimed as contact`:''}`);
  bridgeSend('ticket-reclient', { ticket:tid, clientId:targetId });
  toast(`#${tid} now belongs to ${target.name} — Ledger entries follow.`);
  render();
  if(t.clientId===was) return;                     /* nothing changed */
  $fetch('/api/tickets/'+tid+'/client',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client:targetId,version:t.version})})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      if(d&&d.version) t.version=d.version;
      setTimeout(()=>hydrate(),400); });
}
/* the person verification targets and replies address — the ticket's contact */
function setPrimaryContact(tid, pid){
  const t = tk(tid);
  if(!t || !can('edit_props') || projLocked(t)) return;
  const norm = v => v || null;
  if(norm(pid) === norm(t.contactId)) return;
  const p = pid ? contact(pid) : null;
  if(pid && !p) return;
  t.contactId = pid || null;
  t.articles.push(art('sys', me(), nowMs(), p? `Primary contact set to ${p.name} — verification and replies now address them` : 'Primary contact cleared'));
  t.updatedAt = nowMs();
  log('Primary contact changed', `#${tid} → ${p?p.name:'—'}`);
  render();
  $fetch('/api/tickets/'+tid,{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({contact:pid||'',version:t.version})})
    .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
      if(d&&d.version) t.version=d.version;
      setTimeout(()=>hydrate(),400); });
}

/* ==========================================================================
   CALLER VERIFICATION — contact info comes from the record on file, never
   from the caller. The server sends the code and the agent NEVER sees it;
   only the caller reading it back can verify. Result posts to the thread.
   ========================================================================== */
function verifyModal(tid){
  if(!can('verify_identity')) return;
  const t = tk(tid), p = contact(t.contactId);
  const dest = [];
  const phoneNo = p?.mobile || p?.phone;
  if(VCFG.sms.enabled && phoneNo) dest.push({ method:'sms',   label:`SMS to ${maskPhone(phoneNo)}`,   masked:maskPhone(phoneNo) });
  if(VCFG.email.enabled && p?.email) dest.push({ method:'email', label:`Email to ${maskEmail(p.email)}`, masked:maskEmail(p.email) });
  if(!VCFG.sms.enabled && !VCFG.email.enabled){ toast('Both verification channels are disabled — enable SMS or email in Settings.'); return; }
  const m = document.getElementById('modal');
  if(!dest.length){
    m.innerHTML = `
      <div class="modal-head"><h3>Verify caller — ticket #${t.id}</h3><p>${esc(p?.name||'Unknown contact')}</p></div>
      <div class="modal-body"><div class="notice lock">${icon(IC.shield)}<div><b>No phone or email on file.</b> Add a number to ${esc(p?.name||'the contact')}'s record first — codes only ever go to stored contact info, never to a number the caller reads out.</div></div></div>
      <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Close</button></div>`;
    document.getElementById('scrim').classList.add('open');
    return;
  }
  m.innerHTML = `
    <div class="modal-head"><h3>Verify caller — ticket #${t.id}</h3><p>${esc(p.name)} · ${esc(client(t.clientId).name)}. The code goes to the contact info <b>on file</b> — never to a number the caller provides.</p></div>
    <div class="modal-body" id="vfyBody">
      <div class="field"><label>Send a one-time code</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
          ${dest.map(d=>`<button class="btn" onclick="vfySend(${t.id},'${d.method}','${d.masked}')">${d.label}</button>`).join('')}
        </div></div>
      <div class="mini muted" style="margin-top:6px">Expires after ${VCFG.ttlMin} minutes · ${VCFG.attempts} attempts · result is logged to the ticket either way.</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function vfySend(tid, method, masked){
  const b=document.getElementById('vfyBody'); if(!b) return;
  b.innerHTML='<div class="mini muted">Sending code…</div>';
  $fetch('/api/tickets/'+tid+'/verify/start',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:method})})
    .then(async r=>{
      const d=await r.json().catch(()=>({}));
      if(!r.ok){
        b.innerHTML='<div class="notice lock">'+icon(IC.shield)+
          '<div><b>Could not send.</b> '+esc(d.detail||'Unknown error')+'</div></div>';
        return;
      }
      state.verify[tid]={vid:d.id, method, masked:d.masked};
      const chan=method==='sms'?'SMS':'email';
      b.innerHTML=`
        <div class="notice info" style="margin-bottom:12px">${icon(IC.shield)}<div>Code sent via <b>${chan}</b> to <span class="tape">${esc(d.masked)}</span>. Ask the caller to read it back to you — it is never shown here.</div></div>
        <div class="field"><label>Code the caller reads back</label>
          <input type="text" id="vfyCode" maxlength="6" placeholder="6 digits" style="letter-spacing:.3em;font-size:16px" onkeydown="if(event.key==='Enter')vfyCheck(${tid})"></div>
        <div class="mini muted" id="vfyMsg">${d.attempts} attempts · expires in ${d.ttl_min} min</div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn primary" onclick="vfyCheck(${tid})">Verify code</button>
          <button class="btn ghost sm" onclick="vfySend(${tid},'${method}','${esc(masked)}')">Resend</button>
        </div>`;
      document.getElementById('vfyCode').focus();
    });
}
function vfyCheck(tid){
  const ch=state.verify[tid]; if(!ch) return;
  const entered=(document.getElementById('vfyCode')||{value:''}).value.trim();
  if(!entered) return;
  $fetch('/api/tickets/'+tid+'/verify/check',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({verification_id:ch.vid, code:entered})})
    .then(async r=>{
      const d=await r.json().catch(()=>({}));
      const body=document.getElementById('vfyBody'), msg=document.getElementById('vfyMsg');
      if(!r.ok){ if(msg) msg.innerHTML='<span style="color:var(--void)">'+esc(d.detail||'Check failed')+'</span>'; return; }
      if(d.result==='verified'){
        delete state.verify[tid];
        body.innerHTML='<div class="notice info" style="border-color:var(--brand)">'+icon(IC.shield)+
          '<div><b>Verified.</b> An audit note was posted to the thread and the ticket is tagged <span class="chip tagchip">identity-verified</span>. Proceed with the sensitive request.</div></div>';
        document.querySelector('#modal .modal-foot').innerHTML=
          '<button class="btn primary" onclick="closeModal()">Back to ticket</button>';
        setTimeout(()=>hydrate(),400);
      } else if(d.result==='failed'){
        delete state.verify[tid];
        body.innerHTML='<div class="notice lock" style="border-color:var(--void)">'+icon(IC.shield)+
          '<div><b>Verification failed.</b> The attempt budget is spent — a FAILED note is on the ticket so the attempt is on the record. Do not action sensitive requests for this caller.</div></div>';
        document.querySelector('#modal .modal-foot').innerHTML=
          '<button class="btn primary" onclick="closeModal()">Back to ticket</button>';
        setTimeout(()=>hydrate(),400);
      } else if(d.result==='expired'){
        if(msg) msg.innerHTML='<span style="color:var(--void)">Code expired — send a new one.</span>';
      } else {
        if(msg) msg.innerHTML='<span style="color:var(--void)">Not a match — '+d.attempts_left+' attempt'+(d.attempts_left===1?'':'s')+' remaining.</span>';
        const inp=document.getElementById('vfyCode'); if(inp){ inp.value=''; inp.focus(); }
      }
    });
}

/* ---------------- the sidebar ---------------- */
function renderProps(t){
  const s = slaInfo(t);
  const lk = projLocked(t);
  const dis = k => ((can(k)&&!lk)?'':'disabled');
  return `
  <div>
    <div class="card props">
      <div class="prop"><div class="pk">State</div>
        <select onchange="setProp(${t.id},'st',this.value)" ${(can('edit_props')||can('close'))&&!lk?'':'disabled'}>
          ${STATES.filter(x=>(!isArch(x)&&!x.system)||t.st===x.id).map(x=>`<option value="${x.id}" ${t.st===x.id?'selected':''}>${esc(x.label)}${isArch(x)?' (archived)':''}</option>`).join('')}</select></div>
      <div class="prop"><div class="pk">Priority</div>
        <select onchange="setProp(${t.id},'prio',this.value)" ${dis('edit_props')}>
          ${PRIOS.filter(p=>!isArch(p)||t.prio===p.id).map(p=>`<option value="${p.id}" ${t.prio===p.id?'selected':''}>${esc(p.label)}${isArch(p)?' (archived)':''}</option>`).join('')}</select></div>
      <div class="prop"><div class="pk">Owner</div>
        <select onchange="setProp(${t.id},'ownerId',this.value)" ${dis('assign')}>
          <option value="">— unassigned —</option>
          ${AGENTS.map(a=>`<option value="${a.id}" ${t.ownerId===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="prop"><div class="pk">Assigned techs</div>
        ${can('assign')&&!lk
          ? multiCombo('asg-'+t.id, AGENTS.filter(a=>!isArch(a)||(t.assigneeIds||[]).includes(a.id)).map(a=>({v:a.id,label:a.name,sub:a.email,archived:isArch(a)})), t.assigneeIds||[], 'setAssignees', 'Assign techs…')
          : `<div class="v mini">${(t.assigneeIds||[]).map(id=>esc(agent(id)?.name||'?')).join(', ')||'—'}</div>`}
        <div class="mini muted" style="margin-top:4px">Extra techs beyond the owner — each also sees this ticket and it counts in their “Mine” / Assigned to me.</div></div>
      <div class="prop"><div class="pk">Group</div>
        <select onchange="setProp(${t.id},'groupId',this.value)" ${dis('assign')}>
          ${GROUPS.filter(g=>!isArch(g)||t.groupId===g.id).map(g=>`<option value="${g.id}" ${t.groupId===g.id?'selected':''}>${esc(g.name)}${isArch(g)?' (archived)':''}</option>`).join('')}</select></div>
      <div class="prop"><div class="pk">Client</div>
        ${can('edit_props')&&!lk? combo('cliMove-'+t.id, CLIENTS.filter(c=>(!c.sentinel && !(c.archived||c.status==='archived')) || t.clientId===c.id).map(c=>({v:c.id,label:c.name+(c.sentinel?' (intake)':''),sub:c.domain||''})), t.clientId, function(){ const v=document.getElementById('cliMove-'+t.id).value; if(v && v!==t.clientId) reclientTicket(t.id, v); }, 'Search clients…')
          : `<div class="v mini">${esc(client(t.clientId).name)}</div>`}
        <div class="mini muted" style="margin-top:4px">Moving re-homes the ticket — open Ledger entries follow; approved/locked billing stays put</div></div>
      <div class="prop"><div class="pk">Primary contact</div>
        ${can('edit_props')&&!lk? combo('tkContact-'+t.id,
            [{v:'',label:'— none —'},
             ...((client(t.clientId)||{contacts:[]}).contacts||[]).filter(p=>p.active!==false||p.id===t.contactId).map(p=>({v:p.id,label:(p.vip?'★ ':'')+p.name,sub:p.email}))],
            t.contactId||null, function(){ setPrimaryContact(t.id, document.getElementById('tkContact-'+t.id).value); }, 'Search contacts…')
          : `<div class="v mini">${(contact(t.contactId)||{}).name?esc(contact(t.contactId).name):'—'}</div>`}
        ${(contact(t.contactId)||{}).vip?`<span class="chip st-pending" style="margin-top:4px" title="VIP contact"><span class="cdot"></span>★ VIP</span>`:''}
        <div class="mini muted" style="margin-top:4px">Caller verification and outgoing replies address this person</div></div>
      ${t.parentId?`<div class="prop"><div class="pk">Parent ticket</div>
        <div class="mini" style="display:flex;gap:6px;align-items:center;margin:3px 0"><a href="#" onclick="openTicket(${t.parentId});return false" style="color:var(--brand)">#${t.parentId}</a>${(pp=>pp?`<span ${stChipAttrs(st8(pp.st))}><span class="cdot"></span>${esc((st8(pp.st)||{}).label||pp.st)}</span> <span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((TITLES[pp.id]||firstLine(pp)).slice(0,36))}</span>`:'<span class="muted">not in view</span>')(tk(t.parentId))}${can('edit_props')?`<button class="rowbtn" style="padding:0 5px" onclick="unchild(${t.parentId},${t.id})" title="Detach from the parent">×</button>`:''}</div></div>`:''}
      ${(t.children&&t.children.length)?`<div class="prop"><div class="pk">Child tickets · ${t.children.filter(id=>{const c=tk(id);return c&&(st8(c.st)||{}).type!=='done';}).length} open of ${t.children.length}</div>
        ${t.children.map(id=>{const ct=tk(id); return `<div class="mini" style="display:flex;gap:6px;align-items:center;margin:3px 0"><a href="#" onclick="openTicket(${id});return false" style="color:var(--brand)">#${id}</a>${ct?`<span ${stChipAttrs(st8(ct.st))}><span class="cdot"></span>${esc((st8(ct.st)||{}).label||ct.st)}</span> <span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((TITLES[id]||firstLine(ct)).slice(0,36))}</span>`:'<span class="muted" style="flex:1">not in view</span>'}${can('edit_props')?`<button class="rowbtn" style="padding:0 5px" onclick="unchild(${t.id},${id})">×</button>`:''}</div>`;}).join('')}</div>`:''}
      ${(t.links&&t.links.length)?`<div class="prop"><div class="pk">Linked tickets</div>
        ${t.links.map(id=>{const lt=tk(id); return `<div class="mini" style="display:flex;gap:6px;align-items:center;margin:3px 0"><a href="#" onclick="openTicket(${id});return false" style="color:var(--brand)">#${id}</a> <span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lt?esc((TITLES[id]||firstLine(lt)).slice(0,40)):'not in view'}</span>${can('edit_props')?`<button class="rowbtn" style="padding:0 5px" onclick="unlink(${t.id},${id})">×</button>`:''}</div>`;}).join('')}</div>`:''}
      <div class="prop"><div class="pk">Tags</div>
        <div class="tagrow">${t.tags.map((tag,i)=>`<span class="chip tagchip">${esc(tag)}${can('edit_props')?`<button onclick="rmTag(${t.id},${i})" title="remove">×</button>`:''}</span>`).join('')}
        ${can('edit_props')?`<button class="tagadd" onclick="addTag(${t.id})">+ tag</button>`:''}</div></div>
      <div class="prop"><div class="pk">Service level</div>
        ${s? `<div class="sla-line ${s.breached?'breach-sla':(s.due-nowMs()<2*H?'due-sla':'ok-sla')}"><span class="sdot"></span>${s.kind} due · ${fmtIn(s.due)}</div>
              <div class="mini muted" style="margin-top:3px">${prio(t.prio).label}: first response ${SLA[t.prio].fr}h · resolution ${SLA[t.prio].res}h</div>`
            : `<div class="mini muted">Clock paused — ${st8(t.st).label.toLowerCase()}</div>`}</div>
      <div class="prop"><div class="pk">Identity</div>
        ${t.tags.includes(VERIFIED_TAG)
          ? `<div class="sla-line ok-sla"><span class="sdot"></span>Caller verified</div><div class="mini muted" style="margin-top:3px;margin-bottom:${can('verify_identity')?'8px':'0'}">audit note in the thread</div>
             ${can('verify_identity')? `<button class="btn sm" onclick="verifyModal(${t.id})">${icon(IC.shield)}Verify again</button>`:''}`
          : `<div class="mini muted" style="margin-bottom:${can('verify_identity')?'8px':'0'}">Not verified this ticket</div>
             ${can('verify_identity')? `<button class="btn sm" onclick="verifyModal(${t.id})">${icon(IC.shield)}Verify caller</button>`:''}`}
      </div>
      <div class="prop"><div class="kv" style="margin:0">
        <div><div class="k">Opened</div><div class="v mini">${fmtDT(t.createdAt)}</div></div>
        <div><div class="k">Updated</div><div class="v mini">${fmtAgo(t.updatedAt)}</div></div>
      </div></div>
    </div>
  </div>`;
}
