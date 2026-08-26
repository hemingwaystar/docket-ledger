/* ==========================================================================
   js/desk/views/tickets.js — the queue and the ticket case file, plus the
   whole working loop: composer (reply/note + the native timer), time
   entries, tags, title, bulk actions and CSV export.
   Owns: ovPred/overviews (OverviewDef evaluator)/setOverview/setQF/viewTickets ·
   tabsModal/tabsDraw/tabsRow/tabsMove/tabsToggle/tabsAddCustom/tabsRmCustom/
   tabsSave (per-user queue-tab prefs) · bulkToggle/bulkApply/setBulkAsg/
   bulkAddTechs (bulk bar: Owner… sets the one owner; Assign to… multi-selects
   techs then adds them to every selected ticket via PUT .../assignees) ·
   ticketsCSVData/ticketsCSVRows/auditCSVRows/exportTicketsCSV/exportAuditCSV/copyRowsCSV/
   copyTicketsCSV/copyAuditCSV · viewTicket/renderArt · insertCanned/trigVars ·
   agentEmail · attachTime/editTimeEntry/removeTimeEntry · addAtts/rmAtt ·
   renderNoteEditor/editNote/addEditAtts/rmEditAtt (build 17: in-place edit of a
   sent internal NOTE — body + added attachments, optimistic then PATCH, audited) ·
   addTag/rmTag · checkPendingWakes · composerTimerStart/
   timerSeconds/timerStartMs/setTW/composerSpan/composerH/tickTimer (1 s
   interval)/timerReset · setComposer/renderComposer/sendArticle.
   Endpoints:
     POST  /api/tickets/{id}/articles   (sendArticle; staged files first via
                                         stageUploads → POST /api/uploads)
     PATCH /api/tickets/{id}/articles/{articleId}  (editNote — note body + newly
                                         staged attachments; audited before→after;
                                         returns the ONE reconciled article; updates
                                         desk.articles only, so no ticket.version → no 409)
     POST  /api/tickets/{id}/tags       (addTag / rmTag / bulk tag)
     POST  /api/tickets/{id}/time       (attachTime)
     PATCH /api/time/{id}               (editTimeEntry / removeTimeEntry-void)
     PUT   /auth/me/prefs               (tabsSave, via savePrefs — body is the
                                         whole prefs object; server keys it by
                                         session, nobody writes anyone else's)
   Title edits and bulk owner/state/priority go through saveTitle/setProp
   in views/props.js; bulk "Assign to…" (assigned techs) PUTs the assignee
   side table directly (bulkAddTechs) — no version, no 409.
   Invariants: only internal NOTES are editable after they're sent (body +
   ADDED attachments) — replies, mail-in and sys articles stay immutable by DB
   design (guard_article_immutability, 0001). The edit is refused (and the
   affordance hidden) once the note's linked timesheet is approved or its
   billing period is locked (a.time.approved||a.time.locked), on a locked
   project, and for anyone who is neither the author nor a billing supervisor;
   the SERVER re-checks all of it (PATCH 409/423) — the UI gate is a courtesy,
   oops() covers a stale button. Every edit writes an audit line (before →
   after). The ticket Cc list is server-owned (replies mail the
   stored list); nothing here edits it. SLA escalation notices are the server
   scanner's job — nothing here synthesizes them. Local mutation always lands
   before the mirroring fetch; a change that didn't happen never calls out.
   Queue tabs come ONLY from effectiveOverviews() (state.js: admin
   desk_ui.overviews shaped by me.prefs.overviews) — no tab list is hardcoded
   here. Queue filter values (qf group/prio/client/st/tag) are ARRAYS:
   empty = all; qf.scope is ''(anyone)/'mine'/'unassigned'; qf.from/qf.to are
   'YYYY-MM-DD' creation-date bounds (inclusive, local days; '' = no bound).
   ========================================================================== */

/* ==========================================================================
   TICKETS — the queue
   ========================================================================== */
/* ---- overview tabs: a pure evaluator over OverviewDefs -------------------
   effectiveOverviews() (state.js) supplies the list — admin desk_ui.overviews
   reordered/hidden per me.prefs.overviews, personal tabs at the end. Every
   OverviewDef key maps onto exactly one predicate below; an omitted or empty
   key is no constraint. */
function ovPred(def){
  return t=>{
    const s = st8(t.st)||{};
    if(def.scope==='mine' && !isMine(t)) return false;   /* owner OR assignee (isMine, state.js) */
    if(def.scope==='unassigned' && t.ownerId) return false;
    if(def.stateKinds?.length && !def.stateKinds.includes(s.type)) return false;
    if(def.states?.length && !def.states.includes(s.label)) return false;
    if(def.groups?.length && !def.groups.includes(t.groupId)) return false;
    if(def.clients?.length && !def.clients.includes(t.clientId)) return false;
    if(def.prios?.length && !def.prios.some(r=>String(r)===String(t.prio))) return false;
    if(def.tags?.length && !def.tags.some(x=>t.tags.includes(x))) return false;
    if(def.recentDays && t.updatedAt < nowMs()-def.recentDays*24*H) return false;
    return true;
  };
}
function overviews(){
  const sc = scoped();
  return effectiveOverviews()
    /* unassigned-scope tabs are triage tools — same gate the fixed tab had */
    .filter(d=>d.scope!=='unassigned' || can('assign'))
    .map(d=>({ id:d.id, def:d, f:ovPred(d),
      /* the shipped default's courtesy label for group-scoped users */
      label: d.label==='All open'&&!can('view_all') ? 'Group open' : d.label }))
    .map(x=>Object.assign(x,{n: sc.filter(x.f).length}));
}
function setOverview(id){ state.overview=id; render(); }
function setQF(k,v){ state.qf[k]=v; render(); }
/* named multiCombo handlers — the component calls window[name](selectedArr) */
function setQFGroup(vals){ setQF('group', vals); }
function setQFPrio(vals){ setQF('prio', vals); }
function setQFClient(vals){ setQF('client', vals); }
function setQFSt(vals){ setQF('st', vals); }
function setQFTag(vals){ setQF('tag', vals); }
/* bulk "Assign to…" staging — ticked techs live in state.bulkAsg until the
   Assign button applies them to the whole selection (bulkAddTechs) */
function setBulkAsg(vals){ state.bulkAsg = vals.slice(); render(); }
/* date-range setters — date inputs are segmented (the commitRender family):
   change fires while still focused, so the re-render defers to blur. The
   native clear (×) fires change with '' = bound removed. */
function setQFFrom(v, el){ if(state.qf.from===v) return; state.qf.from=v; commitRender(el); }
function setQFTo(v, el){ if(state.qf.to===v) return; state.qf.to=v; commitRender(el); }
/* stale-shape armor: anything that isn't an array (an old 'all', a bare id
   from a deep link) coerces in place — the ledger _mfNorm pattern */
function qfNorm(){
  ['group','prio','client','st','tag'].forEach(k=>{ const v=state.qf[k];
    if(!Array.isArray(v)) state.qf[k] = (v && v!=='all') ? [v] : []; });
  if(!['','mine','unassigned'].includes(state.qf.scope)) state.qf.scope = '';
  /* creation-date bounds: plain 'YYYY-MM-DD' from <input type=date>; anything
     else (missing key on old state shapes, stale garbage) resets to '' */
  ['from','to'].forEach(k=>{ const v=state.qf[k];
    if(typeof v!=='string' || (v && !/^\d{4}-\d{2}-\d{2}$/.test(v))) state.qf[k]=''; });
  /* prune selections that no longer resolve (a renamed custom state re-slugs
     its id; a tag's last ticket closes) — a ghost value would filter the
     queue to zero rows with no visible chip to remove */
  const known = {
    group: new Set(GROUPS.map(g=>g.id)),
    prio:  new Set(PRIOS.map(p=>String(p.id))),
    client:new Set(CLIENTS.map(c=>c.id)),
    st:    new Set(STATES.map(s=>String(s.id))),
    tag:   new Set(state.tickets.flatMap(t=>t.tags||[])),
  };
  ['group','client','tag'].forEach(k=>{ state.qf[k] = state.qf[k].filter(v=>known[k].has(v)); });
  ['prio','st'].forEach(k=>{ state.qf[k] = state.qf[k].filter(v=>known[k].has(String(v))); });
}
/* the same owner/assignee tests ovPred applies — the bar's scope select and
   any scope-carrying tab always agree on what "mine"/"unassigned" mean;
   "mine" routes through isMine (state.js): owner OR assignee (build 15) */
function qfScopeF(rows, scope){
  if(scope==='mine') return rows.filter(isMine);
  if(scope==='unassigned') return rows.filter(t=>!t.ownerId);
  return rows;
}

/* the bar's predicates over an already-overview-filtered slice — ONE
   function so the queue table and ticketsCSVRows can never drift
   (export = exactly what's shown, search box included) */
function qfApply(rows){
  qfNorm();
  const f = state.qf;
  if(f.group.length) rows = rows.filter(t=>f.group.includes(t.groupId));
  if(f.prio.length) rows = rows.filter(t=>f.prio.some(v=>String(v)===String(t.prio)));
  if(f.client.length) rows = rows.filter(t=>f.client.includes(t.clientId));
  if(f.st.length) rows = rows.filter(t=>f.st.some(v=>String(v)===String(t.st)));
  if(f.tag.length) rows = rows.filter(t=>f.tag.some(v=>t.tags.includes(v)));
  /* creation-date window, inclusive local days: from = that day's midnight,
     to = 23:59:59.999 (spanMs parses local; MIN-1 walks 23:59 to .999) */
  if(f.from){ const a=spanMs(f.from,'00:00'); rows = rows.filter(t=>t.createdAt>=a); }
  if(f.to){ const b=spanMs(f.to,'23:59')+MIN-1; rows = rows.filter(t=>t.createdAt<=b); }
  if(f.q){ const q=f.q.toLowerCase(); rows = rows.filter(t=> (TITLES[t.id]||'').toLowerCase().includes(q) || String(t.id).includes(q) || client(t.clientId).name.toLowerCase().includes(q)); }
  return qfScopeF(rows, f.scope);
}

function viewTickets(){
  qfNorm();
  const ov = overviews();
  const cur = ov.find(o=>o.id===state.overview) || ov[0] || null;
  let rows = cur? scoped().filter(cur.f) : [];
  const f = state.qf;
  rows = qfApply(rows);
  rows.sort((a,b)=> b.prio-a.prio || (slaInfo(a)?.due||9e15)-(slaInfo(b)?.due||9e15) || b.updatedAt-a.updatedAt);
  /* done-only views read newest-first — priority/SLA order is meaningless after solve */
  if(cur && (cur.def.stateKinds||[]).join()==='done') rows.sort((a,b)=>b.updatedAt-a.updatedAt);
  const pg = paginate('tickets', rows);

  const bulkN = state.bulk.filter(id=>rows.some(r=>r.id===id)).length;
  return `
  ${bulkN? `<div class="notice info" style="margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <b>${bulkN} selected</b>
    ${can('assign')?`<select onchange="bulkApply('owner',this.value)" title="Sets the single owner of every selected ticket"><option value="">Owner…</option>${AGENTS.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <span style="display:inline-block;min-width:170px;vertical-align:middle" title="Tick techs, then Assign — they're added to every selected ticket; the owner is unchanged">${multiCombo('bulkAsg', AGENTS.filter(a=>a.active!==false).map(a=>({v:a.id,label:a.name})), state.bulkAsg||[], 'setBulkAsg', 'Assign to…', true)}</span>
    <button class="btn sm" ${(state.bulkAsg&&state.bulkAsg.length)?'':'disabled'} onclick="bulkAddTechs()">Assign${(state.bulkAsg&&state.bulkAsg.length)?' '+state.bulkAsg.length:''}</button>`:''}
    ${can('edit_props')?`<select onchange="bulkApply('st',this.value)"><option value="">Set state…</option>${aSTATES().filter(x=>!x.system).map(x=>`<option value="${x.id}">${x.label}</option>`).join('')}</select>
    <select onchange="bulkApply('prio',this.value)"><option value="">Set priority…</option>${aPRIOS().map(p=>`<option value="${p.id}">${p.label}</option>`).join('')}</select>
    <button class="btn sm" onclick="bulkApply('tag', prompt('Tag to add:'))">+ tag</button>`:''}
    <button class="btn sm ghost" onclick="state.bulk=[];render()">Clear</button>
  </div>`:''}
  <div class="toolbar">
    ${can('export_csv')?`<span style="order:99;margin-left:auto;display:inline-flex;gap:8px">
      <button class="btn sm" onclick="copyTicketsCSV()" title="Copies the CSV for the rows currently shown">Copy</button>
      <button class="btn primary" onclick="exportTicketsCSV()" title="Exports every row matching the current overview + filters — all pages">${icon(IC.export)}Export CSV</button>
    </span>`:''}
    <div class="seg wrap">${ov.map(o=>`<button class="${state.overview===o.id?'on':''}" onclick="setOverview('${jsq(o.id)}')">${esc(o.label)}<span class="pip">${o.n}</span></button>`).join('')}</div>
    <button class="btn sm ghost" onclick="tabsModal()" title="Customize tabs — reorder, hide, add personal tabs" style="padding:4px 8px">⚙</button>
    <span class="spacer"></span>
    ${can('create')?`<button class="btn primary" onclick="newTicketModal()">${icon(IC.plus)}New ticket</button>`:''}
  </div>
  <div class="toolbar">
    <div class="search">${icon(IC.search)}<input type="text" placeholder="Search title, number, client…" value="${esc(f.q)}" data-fkey="qf-q" oninput="setQF('q',this.value)"></div>
    <span style="display:inline-block;min-width:160px;vertical-align:middle">${multiCombo('qfGroup', GROUPS.filter(g=>!isArch(g)||f.group.includes(g.id)).map(g=>({v:g.id,label:g.name+(isArch(g)?' (archived)':'')})), f.group, 'setQFGroup', 'All groups')}</span>
    <span style="display:inline-block;min-width:150px;vertical-align:middle">${multiCombo('qfPrio', PRIOS.filter(p=>!isArch(p)||f.prio.some(v=>String(v)===String(p.id))).map(p=>({v:p.id,label:p.label+(isArch(p)?' (archived)':'')})), f.prio, 'setQFPrio', 'Any priority')}</span>
    <span style="display:inline-block;min-width:180px;vertical-align:middle">${multiCombo('qfClient', CLIENTS.filter(c=>c.status!=='archived'||f.client.includes(c.id)).map(c=>({v:c.id,label:c.name+(c.status==='archived'?' (archived)':''),sub:c.domain||''})), f.client, 'setQFClient', 'All clients')}</span>
    <span style="display:inline-block;min-width:150px;vertical-align:middle" title="System states are listed too — filtering by them is legitimate">${multiCombo('qfSt', STATES.filter(s=>!isArch(s)||f.st.some(v=>String(v)===String(s.id))).map(s=>({v:s.id,label:s.label+(isArch(s)?' (archived)':'')})), f.st, 'setQFSt', 'Any state')}</span>
    <span style="display:inline-block;min-width:130px;vertical-align:middle">${multiCombo('qfTag', [...new Set(scoped().flatMap(t=>t.tags))].sort().map(tg=>({v:tg,label:tg})), f.tag, 'setQFTag', 'Any tag')}</span>
    <span style="display:inline-flex;align-items:center;gap:5px;vertical-align:middle" title="Filter by creation date — inclusive; leave either blank for no bound">
      <span class="mini muted">created</span>
      <input type="date" value="${esc(f.from)}" data-fkey="qf-from" style="width:auto" onchange="setQFFrom(this.value,this)" title="Created on or after — from that day's local midnight">
      <span class="mini muted">–</span>
      <input type="date" value="${esc(f.to)}" data-fkey="qf-to" style="width:auto" onchange="setQFTo(this.value,this)" title="Created on or before — through that day's local end">
    </span>
    <select style="width:auto" onchange="setQF('scope',this.value)" title="Whose tickets — same tests the queue tabs use">
      <option value="">Anyone</option>
      <option value="mine" ${f.scope==='mine'?'selected':''}>Mine</option>
      <option value="unassigned" ${f.scope==='unassigned'?'selected':''}>Unassigned</option>
    </select>
  </div>
  <div class="card">
    ${rows.length? `<table class="tbl">
      <thead><tr>${can('edit_props')||can('assign')?'<th style="width:34px"></th>':''}<th style="width:64px">#</th><th>Ticket</th><th>State</th><th>Priority</th><th>Group</th><th>Owner</th><th>SLA</th><th class="right">Updated</th></tr></thead>
      <tbody>${pg.slice.map(t=>`
        <tr class="clickable" onclick="openTicket(${t.id})">
          ${can('edit_props')||can('assign')?`<td style="width:34px" onclick="event.stopPropagation()"><input type="checkbox" ${state.bulk.includes(t.id)?'checked':''} onchange="bulkToggle(${t.id},this.checked)" style="width:auto;accent-color:var(--brand)"></td>`:''}
          <td class="num"><span class="tape muted">#${t.id}</span></td>
          <td><div class="cell-title">${esc(TITLES[t.id]||firstLine(t))}</div>
              <div class="cell-meta">${esc(client(t.clientId).name)} · ${esc(contact(t.contactId)?.name||'')}${can('see_billing')&&timeTotal(t)?` · <span class="tape">${fmtHours(timeTotal(t))}h</span> logged`:''}</div></td>
          <td>${stateChip(t)}</td>
          <td>${prioTag(t.prio)}</td>
          <td class="mini" style="padding-top:13px">${esc(grp(t.groupId).name)}</td>
          <td>${t.ownerId? `<span style="display:inline-flex;align-items:center;gap:6px">${avatarOf(agent(t.ownerId))}<span class="mini">${esc(agent(t.ownerId).name.split(' ')[0])}</span></span>` : `<span class="chip st-pending"><span class="cdot"></span>Unassigned</span>`}</td>
          <td>${slaCell(t)}</td>
          <td class="num mini">${fmtAgo(t.updatedAt)}</td>
        </tr>`).join('')}</tbody></table>${pagerBar(pg)}`
    : `<div class="empty">${icon(IC.ticket)}<div>No tickets match this view. Clear a filter or switch overview.</div></div>`}
  </div>`;
}

/* ---- Customize tabs: per-user order / visibility / personal tabs ---------
   Works on a draft (state._tabsDraft) so Cancel costs nothing; Save applies
   locally then mirrors the WHOLE prefs object via savePrefs (PUT
   /auth/me/prefs). The admin tab set itself is standardized in Settings →
   Queue tabs — this modal only shapes how *I* see it. ---- */
function tabsModal(){
  const p = state.prefs.overviews || {};
  /* adminOverviews() (state.js) carries the shipped-default fallback — raw
     DESK_UI.overviews is undefined until an admin first saves the card */
  const adminIds = adminOverviews().filter(o=>!isArch(o)).map(d=>d.id);
  const order = (p.order||[]).filter(id=>adminIds.includes(id));
  adminIds.forEach(id=>{ if(!order.includes(id)) order.push(id); });
  const custom = JSON.parse(JSON.stringify(p.custom||[]));
  const known = adminIds.concat(custom.map(d=>d.id));
  state._tabsDraft = { order, hidden:(p.hidden||[]).filter(id=>known.includes(id)), custom };
  state._tabsBase = JSON.stringify(state._tabsDraft);
  tabsDraw();
}
function tabsRow(def, i, n, isCustom){
  const hid = state._tabsDraft.hidden.includes(def.id);
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
    <button class="rowbtn" ${i===0?'disabled':''} onclick="tabsMove(${i},-1,${isCustom})" title="Move up">↑</button>
    <button class="rowbtn" ${i===n-1?'disabled':''} onclick="tabsMove(${i},1,${isCustom})" title="Move down">↓</button>
    <span style="flex:1;min-width:0;${hid?'opacity:.45':''}">${esc(def.label)}${isCustom?' <span class="mini muted">personal</span>':''}</span>
    <label class="mini" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" ${hid?'':'checked'} onchange="tabsToggle('${jsq(def.id)}',this.checked)" style="width:auto;accent-color:var(--brand)">shown</label>
    ${isCustom?`<button class="rowbtn" onclick="tabsRmCustom(${i})" title="Remove this personal tab">×</button>`:''}
  </div>`;
}
function tabsDraw(){
  const d = state._tabsDraft;
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Customize queue tabs</h3><p>Order, visibility and personal tabs are yours alone — the shared tab set is standardized by admins in Settings → Queue tabs.</p></div>
    <div class="modal-body">
      ${d.order.map((id,i)=>{ const def=adminOverviews().find(x=>x.id===id); return def? tabsRow(def,i,d.order.length,false) : ''; }).join('')}
      ${d.custom.length?`<div class="mini muted" style="margin:10px 0 2px;text-transform:uppercase;letter-spacing:.06em">Personal tabs</div>`:''}
      ${d.custom.map((def,i)=>tabsRow(def,i,d.custom.length,true)).join('')}
      <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <div class="mini muted" style="text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Add a personal tab</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="tabLabel" placeholder="Label" style="flex:1;min-width:150px">
          <select id="tabScope" style="width:auto" title="Whose tickets the tab shows">
            <option value="all">Anyone's</option><option value="mine">Mine</option><option value="unassigned">Unassigned</option>
          </select>
          <span class="mini" style="display:inline-flex;gap:9px;align-items:center" title="Which state kinds count — all three checked = no constraint">
            ${['open','paused','done'].map(k=>`<label style="display:inline-flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" id="tabK-${k}" ${k!=='done'?'checked':''} style="width:auto;accent-color:var(--brand)">${k}</label>`).join('')}
          </span>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">
          <div style="flex:1;min-width:170px"><div class="mini muted">Boards — any of; none = all</div>
            <div style="max-height:110px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-top:4px">
              ${aGROUPS().map(g=>`<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;padding:2px 0;cursor:pointer"><input type="checkbox" id="tabG-${g.id}" style="width:auto;accent-color:var(--brand)">${esc(g.name)}</label>`).join('')||'<span class="mini muted">No boards.</span>'}
            </div></div>
          <div style="flex:1;min-width:150px"><div class="mini muted">Priorities — any of; none = all</div>
            <div style="max-height:110px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-top:4px">
              ${aPRIOS().map(p=>`<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;padding:2px 0;cursor:pointer"><input type="checkbox" id="tabP-${p.id}" style="width:auto;accent-color:var(--brand)">${esc(p.label)}</label>`).join('')}
            </div></div>
          <div style="flex:1;min-width:180px"><div class="mini muted">Clients — any of; none = all</div>
            <div style="max-height:110px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-top:4px">
              ${CLIENTS.filter(c=>c.status!=='archived').map(c=>`<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;padding:2px 0;cursor:pointer"><input type="checkbox" id="tabC-${c.id}" style="width:auto;accent-color:var(--brand)">${esc(c.name)}</label>`).join('')||'<span class="mini muted">No clients.</span>'}
            </div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <input type="text" id="tabTags" placeholder="tags, comma-separated — any of" style="flex:1;min-width:160px">
          <label class="mini" style="display:inline-flex;gap:5px;align-items:center">updated in last <input type="number" id="tabDays" min="1" style="width:64px"> days</label>
          <button class="btn sm" onclick="tabsAddCustom()">Add tab</button>
        </div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="tabsSave()">Save</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function tabsMove(i, dir, isCustom){
  const arr = isCustom? state._tabsDraft.custom : state._tabsDraft.order;
  const j = i+dir; if(j<0 || j>=arr.length) return;
  [arr[i],arr[j]] = [arr[j],arr[i]];
  tabsDraw();
}
function tabsToggle(id, on){
  const d = state._tabsDraft;
  if(on) d.hidden = d.hidden.filter(x=>x!==id);
  else if(!d.hidden.includes(id)) d.hidden.push(id);
  tabsDraw();
}
function tabsRmCustom(i){
  const d = state._tabsDraft;
  const gone = d.custom.splice(i,1)[0];
  if(gone) d.hidden = d.hidden.filter(x=>x!==gone.id);
  tabsDraw();
}
function tabsAddCustom(){
  const label = document.getElementById('tabLabel').value.trim();
  if(!label){ toast('Give the tab a label first.'); return; }
  const d = state._tabsDraft;
  const taken = adminOverviews().map(x=>x.id).concat(d.custom.map(x=>x.id));
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'tab';
  let id = base, ix = 2;
  while(taken.includes(id)) id = base+'-'+(ix++);
  const def = { id, label, scope: document.getElementById('tabScope').value };
  const kinds = ['open','paused','done'].filter(k=>document.getElementById('tabK-'+k).checked);
  if(kinds.length && kinds.length<3) def.stateKinds = kinds;   /* all three = no constraint — omit */
  const gs = aGROUPS().filter(g=>document.getElementById('tabG-'+g.id)?.checked).map(g=>g.id);
  if(gs.length) def.groups = gs;
  const ps = aPRIOS().filter(p=>document.getElementById('tabP-'+p.id)?.checked).map(p=>p.id);
  if(ps.length) def.prios = ps;
  const cs = CLIENTS.filter(c=>c.status!=='archived' && document.getElementById('tabC-'+c.id)?.checked).map(c=>c.id);
  if(cs.length) def.clients = cs;
  const tags = (document.getElementById('tabTags').value||'').split(',').map(s=>s.trim().toLowerCase().replace(/\s+/g,'-')).filter(Boolean);
  if(tags.length) def.tags = tags;
  const days = parseInt(document.getElementById('tabDays').value, 10);
  if(days>0) def.recentDays = days;
  d.custom.push(def);
  tabsDraw();
}
function tabsSave(){
  const d = state._tabsDraft; if(!d) return;
  if(JSON.stringify(d)===state._tabsBase){ state._tabsDraft=null; closeModal(); return; }   /* untouched — nothing to write */
  state._tabsDraft = null;
  toast('Queue tabs saved — the layout is yours alone.');
  closeModal();
  /* savePrefs applies the merge, diffs against the UNMUTATED state.prefs,
     renders, and PUTs — assigning state.prefs first would blind its guard */
  savePrefs({ overviews: { order:d.order, hidden:d.hidden, custom:d.custom } });
}

/* ---- bulk actions — each change audited individually ---- */
function bulkToggle(tid, on){
  if(on && !state.bulk.includes(tid)) state.bulk.push(tid);
  if(!on) state.bulk = state.bulk.filter(x=>x!==tid);
  render();
}
function bulkApply(k, v){
  if(!v){ render(); return; }
  const ids = state.bulk.slice(); let n = 0;
  /* bulk never prompts the close cascade — parents close alone; children
     keep their own lifecycle (setProp in views/props.js checks the flag) */
  window._bulkRun = true;
  try{
    ids.forEach(id=>{
      const t = tk(id); if(!t || t.mergedInto) return;
      if(k==='tag'){
        /* normalize like addTag/the server (audit: the raw prompt value
           made ghost chips), skip locked projects, sync the version bump */
        const nv=v.toLowerCase().trim().replace(/\s+/g,'-');
        if(can('edit_props') && nv && !t.tags.includes(nv) && !projLocked(t)){
          t.tags.push(nv); n++;
          $fetch('/api/tickets/'+id+'/tags',{method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({add:[nv],remove:[]})})
            .then(async r=>{ const d=await r.json().catch(()=>({}));
              if(!r.ok) return oops(d);
              if(d.version){ t.version=d.version; t.updatedAt=d.updatedAt||t.updatedAt; } });
        }
        return;
      }
      if(k==='owner' && can('assign')){ setProp(id,'ownerId',v); n++; }
      if(k==='st' && (can('edit_props')||can('close'))){ setProp(id,'st',v); n++; }
      if(k==='prio' && can('edit_props')){ setProp(id,'prio',v); n++; }
    });
  } finally { window._bulkRun = false; }
  if(k==='tag' && n) log('Bulk tag added', `“${v}” on ${n} tickets`);
  state.bulk = [];
  toast(`Applied to ${n} ticket${n===1?'':'s'} — each change audited individually.`);
  render();
}
/* bulk "Assign to…" — adds every ticked tech (state.bulkAsg) to every selected
   ticket, ADDITIVELY (owner untouched, existing assignees kept). One PUT per
   ticket of the merged set (the side table carries no version → no 409);
   reconciles to the server's returned set. Keeps the ticket selection, clears
   the staged techs. Skips merged/locked-project tickets and no-op tickets. */
function bulkAddTechs(){
  if(!can('assign')) return;
  const techs = (state.bulkAsg||[]).slice();
  if(!techs.length){ toast('Tick one or more techs to assign.'); return; }
  const ids = state.bulk.slice(); let n = 0;
  ids.forEach(id=>{
    const t = tk(id); if(!t || t.mergedInto || projLocked(t)) return;
    const before = t.assigneeIds||[];
    const merged = [...new Set([...before, ...techs])];
    if(merged.length===before.length) return;        /* every tech already on it */
    t.assigneeIds = merged; n++;
    t.articles.push(art('sys', me(), nowMs(), 'Assignees: '+merged.map(x=>agent(x)?.name||x).join(', ')));
    $fetch('/api/tickets/'+id+'/assignees',{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({assignees:merged})})
      .then(async r=>{ const d=await r.json().catch(()=>0); if(!r.ok) return oops(d);
        if(d && Array.isArray(d.assignees)) t.assigneeIds = d.assignees; });
  });
  const names = techs.map(x=>agent(x)?.name||x).join(', ');
  if(n) log('Bulk assigned', `${names} → ${n} ticket${n===1?'':'s'}`);
  state.bulkAsg = [];                                 /* clear staged techs; keep the ticket selection */
  toast(n? `Assigned ${names} to ${n} ticket${n===1?'':'s'}.` : 'Those techs are already on the selected tickets.');
  render();
}

/* ---- CSV: exports every row matching the current filters — all pages ---- */
/* the ONE ticket-CSV shape — the queue export and the client-page export
   (views/clients.js) both build through this, so the columns can never drift */
function ticketsCSVData(rows){
  const data = [['number','title','client','contact','group','state','priority','owner','tags','opened','updated','hours_logged','sla_due','sla_breached']];
  rows.forEach(t=>{ const sla = slaInfo(t);
    data.push([t.id, TITLES[t.id]||firstLine(t), client(t.clientId).name, contact(t.contactId)?.email||'', grp(t.groupId).name,
      st8(t.st).label, prio(t.prio).label, t.ownerId?agent(t.ownerId).name:'', t.tags.join('; '),
      new Date(t.createdAt).toISOString(), new Date(t.updatedAt).toISOString(), fmtHours(timeTotal(t)),
      sla? new Date(sla.due).toISOString():'', sla? (sla.breached?'YES':'no'):'' ]);
  });
  return data;
}
function ticketsCSVRows(){
  const ov = overviews(); const cur = ov.find(o=>o.id===state.overview) || ov[0] || null;
  return ticketsCSVData(qfApply(cur? scoped().filter(cur.f) : []));
}
function auditCSVRows(){
  const data = [['when','who','action','detail']];
  state.audit.forEach(a=>data.push([new Date(a.ts).toISOString(), a.who, a.action, a.detail]));
  return data;
}
function exportTicketsCSV(){ if(!can('export_csv')){ toast('Your role can’t export data — ask an admin for the “Export & copy CSV data” permission.'); return; } downloadCSV(`docket-tickets-${msDate(nowMs())}.csv`, ticketsCSVRows()); }
function exportAuditCSV(){ if(!can('export_csv')) return; downloadCSV(`docket-audit-${msDate(nowMs())}.csv`, auditCSVRows()); }
function copyRowsCSV(rows, what){
  const csv = rows.map(r=>r.map(csvEsc).join(',')).join('\n');
  const done = ()=>toast(`${what} — ${rows.length-1} rows copied.`);
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(csv).then(done, done);
  else done();
}
function copyTicketsCSV(){ if(!can('export_csv')) return; copyRowsCSV(ticketsCSVRows(), 'Tickets CSV'); }
function copyAuditCSV(){ if(!can('export_csv')) return; copyRowsCSV(auditCSVRows(), 'Audit CSV'); }

/* ==========================================================================
   TICKET — the case file: thread + native note timer + properties
   ========================================================================== */
/* one reorderable block in the ticket stack: a slim bar (label + up/down) above
   the block's existing card markup. Up is disabled on the first block, down on
   the last; moveTicketBlock persists the new order per user (state.js). */
function tkBlockWrap(id, content, isFirst, isLast){
  return `<div class="tk-block" data-block="${id}">
    <div class="tk-block-bar">
      <span class="tk-block-lbl">${esc(TK_BLOCK_LABEL[id]||id)}</span>
      <span class="spacer"></span>
      <button class="rowbtn" ${isFirst?'disabled':''} onclick="moveTicketBlock('${id}',-1)" title="Move up">↑</button>
      <button class="rowbtn" ${isLast?'disabled':''} onclick="moveTicketBlock('${id}',1)" title="Move down">↓</button>
    </div>
    ${content}
  </div>`;
}

function viewTicket(){
  const t = tk(state.ticketId);
  if(!t || !ticketVisible(t)) return `<div class="empty">${icon(IC.ticket)}<div>Ticket not found in your scope.</div></div>`;
  const c = client(t.clientId), p = contact(t.contactId);
  const canWork = can('reply')||can('note');
  const closedNote = t.st==='closed' ? `<div class="notice lock" style="margin-bottom:14px">${icon(IC.audit)}<div><b>Closed.</b> A customer reply re-opens it automatically; its logged time is already priced in Ledger${can('see_billing')?' and locks with the billing period':''}.</div></div>` : '';

  /* Ticket blocks (build 21): the case file is a full-width vertical STACK of
     blocks — Properties, Conversation, Schedule, Audit — that each tech orders
     to their own taste (ticketBlockOrder, persisted in prefs). The thread
     carries only human articles; 'sys' events live in Audit (build 20). */
  const conv = t.articles.filter(a=>a.kind!=='sys');
  const threadBlock =
      `${isProj(t)? projChecklistCard(t) : ''}
      <div class="card" style="padding:4px 18px">
        <div class="thread">${conv.length ? conv.map(a=>renderArt(t,a)).join('')
          : `<div class="mini muted" style="padding:12px 0">No conversation yet — automatic events are in the Audit panel.</div>`}</div>
      </div>
      ${projLocked(t)? `<div class="notice lock" style="margin-top:14px">${icon(IC.seal)}<div><b>Approved &amp; locked.</b> This project ticket is immutable — no notes, replies, time or property changes.${can('approve_projects')?' Use <b>Unlock (admin)</b> on the checklist card if something genuinely needs fixing.':' An admin can unlock it if something genuinely needs fixing.'}</div></div>`
        : canWork? renderComposer(t) : `<div class="notice lock" style="margin-top:14px">${icon(IC.shield)}<div>Your role can view this ticket but not respond. Ask a dispatcher or admin if that looks wrong.</div></div>`}`;
  const blocks = { props: renderProps(t), thread: threadBlock, schedule: renderSchedules(t), audit: renderAudit(t) };
  const order = ticketBlockOrder();
  const stack = order.map((id,i)=>tkBlockWrap(id, blocks[id], i===0, i===order.length-1)).join('');

  return `
  <div class="tk-head">
    <button class="btn ghost sm" onclick="go('tickets')" title="Back to queue">${icon(IC.back)}Queue</button>
    <div style="min-width:0;flex:1">
      ${client(t.clientId)?.sentinel?`<div class="notice" style="background:#fdf6e8;border:1px solid var(--seal);margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span style="color:var(--seal);font-weight:700">Unrouted</span>
        <span class="mini">arrived from an unknown sender — pick where it belongs; the sender moves into that client's contacts</span>
        ${can('edit_props')?`<span style="display:inline-block;min-width:230px">${combo('rc-'+t.id, CLIENTS.filter(c=>!c.sentinel && c.status!=='archived').map(c=>({v:c.id,label:c.name,sub:c.domain||''})), '', function(){ reclientTicket(t.id, document.getElementById('rc-'+t.id).value); }, 'Search clients…')}</span>`:''}
      </div>`:''}
      ${t.mergedInto?`<div class="notice info" style="margin-bottom:10px">${icon(IC.ticket)}<div><b>Merged.</b> This ticket's thread and time now live on <a href="#" onclick="openTicket(${t.mergedInto});return false" style="color:var(--brand);font-weight:600">#${t.mergedInto}</a>.</div></div>`:''}
      ${state.editTitle===t.id
        ? `<div style="display:flex;gap:8px;align-items:center">
             <input type="text" id="ttl-${t.id}" value="${esc(TITLES[t.id]||firstLine(t))}" style="font-size:19px;font-weight:600;flex:1;min-width:280px" onkeydown="if(event.key==='Enter')saveTitle(${t.id});if(event.key==='Escape'){state.editTitle=null;render();}">
             <button class="btn sm primary" onclick="saveTitle(${t.id})">Save</button>
             <button class="btn sm ghost" onclick="state.editTitle=null;render()">Cancel</button></div>`
        : `<h2 style="display:flex;align-items:center;gap:8px">${esc(TITLES[t.id]||firstLine(t))} <span class="tk-num">#${t.id}</span>
             ${can('edit_props')?`<button class="rowbtn" onclick="state.editTitle=${t.id};render()" title="Rename — audited">Edit</button>`:''}
             ${can('edit_props')&&!t.mergedInto?`<button class="rowbtn" onclick="mergeModal(${t.id})" title="Move this whole ticket into another">Merge…</button><button class="rowbtn" onclick="linkModal(${t.id})" title="Two-way related link">Link…</button><button class="rowbtn" onclick="childModal(${t.id})" title="Make another ticket a child of this one">Add child…</button>`:''}</h2>`}
      <div class="cell-meta" style="margin-top:3px">${stateChip(t)} &nbsp;${prioTag(t.prio)} &nbsp;<span class="mini">·</span>&nbsp;
        <span class="mini">${can('view_clients')?`<a href="#" onclick="openClient('${c.id}');return false" style="text-decoration:none;border-bottom:1px dotted var(--ink-3)">${esc(c.name)}</a>`:esc(c.name)} · ${esc(p?.name||'')} &lt;${esc(p?.email||'')}&gt;</span>
        ${t.tags.includes(VERIFIED_TAG)?`&nbsp;<span class="chip st-solved" title="Identity verified via one-time code — see the thread"><span class="cdot"></span>Verified</span>`:''}</div>
    </div>
    ${slaInfo(t)? `<div style="padding-top:6px">${slaCell(t)}</div>`:''}
  </div>
  ${closedNote}
  <div class="tk-stack">${stack}</div>`;
}

function renderArt(t,a){
  if(a.kind==='sys') return `<div class="art sys"><div class="art-sysline"><span class="sdot"></span><span>${esc(a.body)}</span><span class="sts">${fmtDT(a.ts)}</span></div></div>`;
  /* deleted note/reply (build 26): a muted TOMBSTONE in place — no body, no
     time chip, no actions. The content, actor and voided time live in the
     Audit block + global Audit Log (the server ships the body stripped). */
  if(a.deletedAt){
    const kl = a.kind==='note' ? 'Internal note' : 'Public reply';
    return `<div class="art deleted"><div class="art-sysline"><span class="sdot"></span>
      <span>🗑 <b>${kl}</b> deleted by ${esc(a.deletedBy||'—')}<span class="mini muted"> — content is in the Audit log</span></span>
      <span class="sts">${fmtDT(a.deletedAt)}</span></div></div>`;
  }
  const isAgent = a.kind!=='mail-in';
  const kindLab = a.kind==='mail-in' ? `<span class="art-kind mail">Email received</span>`
               : a.kind==='note'    ? `<span class="art-kind note">Internal note</span>`
                                    : `<span class="art-kind">${a.auto?'Auto-reply':'Reply sent'}${a.from?` · ${esc(a.from.split('@')[0])}@`:''}</span>${a.to?`<span class="mini muted" style="margin-left:2px">to ${esc(a.to)}</span>`:''}`;
  const av = isAgent ? (a.author.initials||'??') : (a.author.name||'?').split(' ').map(w=>w[0]).slice(0,2).join('');
  const tIdx = a.time ? t.time.indexOf(a.time) : -1;
  const mayEditT = a.time && tIdx>=0 && (can('see_billing') || (can('log_time') && a.time.techId===state.meId));
  const timeChip = a.time && mayEditT
    ? `<div class="art-time"><span class="chip ledger" style="gap:6px;flex-wrap:wrap"><span class="cdot"></span>
         <input type="date" value="${msDate(a.time.startedAt)}" style="width:118px;padding:1px 3px;font-size:11.5px;border:1px solid var(--line);border-radius:5px;background:#fff" onchange="editTimeEntry(${t.id},${tIdx},'date',this.value,this)" title="Date — audited">
         <input type="time" value="${msTime(a.time.startedAt)}" style="width:76px;padding:1px 3px;font-size:11.5px;border:1px solid var(--line);border-radius:5px;background:#fff" onchange="editTimeEntry(${t.id},${tIdx},'start',this.value,this)" title="Start — audited">–<input type="time" value="${msTime(a.time.endedAt)}" style="width:76px;padding:1px 3px;font-size:11.5px;border:1px solid var(--line);border-radius:5px;background:#fff" onchange="editTimeEntry(${t.id},${tIdx},'end',this.value,this)" title="End — audited">
         <span class="tape" style="font-weight:600">${fmtHours(a.time.h)} h</span>
         &nbsp;→ Ledger ·
         <select style="width:auto;font-size:11.5px;padding:1px 18px 1px 4px;border:1px solid var(--line);border-radius:5px;background:#fff" onchange="editTimeEntry(${t.id},${tIdx},'typeId',this.value)" title="Reclassify — audited">${ATYPES.filter(x=>!isArch(x)||a.time.typeId===x.id).map(x=>`<option value="${x.id}" ${a.time.typeId===x.id?'selected':''}>${esc(x.name)}${isArch(x)?' (archived)':''}</option>`).join('')}</select>
         ${isProj(t)?`· <select style="width:auto;max-width:150px;font-size:11.5px;padding:1px 18px 1px 4px;border:1px solid var(--line);border-radius:5px;background:#fff" ${projEditable(t)?'':'disabled'} onchange="editTimeEntry(${t.id},${tIdx},'taskId',this.value)" title="Which checklist task this time bills under — audited"><option value="">— no task —</option>${t.project.tasks.map(x=>`<option value="${x.id}" ${a.time.taskId===x.id?'selected':''}>${esc(x.label)}</option>`).join('')}</select>`:''}
         <button class="rowbtn" style="padding:0 6px" onclick="removeTimeEntry(${t.id},${tIdx})" title="Remove this entry — Ledger keeps a voided row">×</button></span></div>`
    : a.time && can('see_billing')
    ? `<div class="art-time"><span class="chip ledger"><span class="cdot"></span><span class="tape">${msTime(a.time.startedAt)}–${msTime(a.time.endedAt)} · ${fmtHours(a.time.h)} h</span>&nbsp;→ Ledger · ${esc(atype(a.time.typeId).name)}${isProj(t)&&a.time.taskId?` · ${esc(projTask(t,a.time.taskId)?.label||'')}`:''}</span></div>`
    : (a.time && can('log_time') ? `<div class="art-time"><span class="chip ledger"><span class="cdot"></span><span class="tape">${msTime(a.time.startedAt)}–${msTime(a.time.endedAt)} · ${fmtHours(a.time.h)} h</span> logged</span></div>` : '');
  const isMineOrSup = (a.author?.id===state.meId) || can('see_billing');
  const mayAttach = (a.kind==='note'||a.kind==='reply') && !a.auto && can('log_time') && isMineOrSup && !a.time;
  /* note editing (build 17): ONLY internal notes, never auto-generated, by the
     author OR a billing supervisor (the same isMineOrSup shape the +time gate
     uses), never on a locked project, and NEVER once the linked timesheet is
     approved or its billing period is locked — the note freezes with the money.
     The server (PATCH .../articles/{id}) re-checks every clause; if this button
     is stale (e.g. the timesheet was just approved) the 423/409 + oops() covers
     it. Replies / mail-in / sys stay immutable. */
  const mayEditNote = a.kind==='note' && !a.auto && isMineOrSup && !projLocked(t)
    && !(a.time && (a.time.approved || a.time.locked));
  const editing = mayEditNote && state.editNote===a.id;
  const editBtn = (mayEditNote && !editing)
    ? `<button class="rowbtn" onclick="state.editNote='${jsq(a.id)}';state.editAtts=[];render()" title="Edit this note — the change is audited (before → after)">Edit</button>`
    : '';
  const attachBtn = mayAttach
    ? `<button class="rowbtn" onclick="attachTime(${t.id},'${jsq(a.id)}')" title="Attach a time entry — starts as a 15-min span ending at this ${a.kind==='reply'?'email':'note'}'s timestamp; adjust it inline">+ time</button>`
    : '';
  /* delete (build 26): a note OR public reply, never auto-generated, on any
     ticket the tech can reach (no extra permission — a product choice), never
     on a locked project, and NEVER once the linked timesheet is approved or its
     billing period is locked (it freezes with the money — same clause the Edit
     affordance uses). The server (DELETE .../articles/{id}) re-checks every
     clause; a stale button routes through oops(). mail-in / sys stay
     undeletable. Confirmation + the linked-time void happen in deleteArticle. */
  const mayDelete = (a.kind==='note'||a.kind==='reply') && !a.auto && !projLocked(t)
    && !(a.time && (a.time.approved || a.time.locked))
    && srvId(a.id);   /* only a server-persisted article can be deleted — a just-composed one has a local id until the next hydrate reconciles it */
  const delBtn = mayDelete
    ? `<button class="rowbtn danger" onclick="deleteArticle(${t.id},'${jsq(a.id)}')" title="Delete this ${a.kind==='reply'?'public reply':'internal note'}${a.time?' and void its linked time entry':''} — you'll confirm; it's audited (who, content, when)">Delete</button>`
    : '';
  const noteActions = (editBtn||attachBtn||delBtn)
    ? `<span style="margin-left:auto;display:inline-flex;gap:6px">${editBtn}${attachBtn}${delBtn}</span>`
    : '';
  /* transparency: a muted "(edited …)" marker on ANY article the server marked
     edited — editedAt/editedBy ride every article (mapIn defaults them to null
     for a pre-0034 bootstrap, so the marker only lights when truly set) */
  const editedMark = a.editedAt
    ? `<span class="mini muted" title="Edited by ${esc(a.editedBy||'—')}" style="margin-left:2px">(edited ${esc(fmtDT(a.editedAt))})</span>`
    : '';
  const attsHtml = a.atts&&a.atts.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${a.atts.map(f=>`<span class="chip" style="background:#eef2f1;cursor:pointer" onclick="attOpen('${f.id||''}')" title="${esc(f.type)}">📎 ${esc(f.name)} <span class="mini muted">${fmtKB(f.size)}</span></span>`).join('')}</div>`
    : '';
  const bodyHtml = a.kind==='mail-in' && a.bodyHtml && !state.plainMail?.[a.id]
    ? `<div class="art-body" style="padding:0">
         <iframe sandbox="" style="width:100%;height:auto;min-height:120px;max-height:420px;border:0;border-radius:6px;background:#fff"
           srcdoc="${esc('<!doctype html><meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;default-src \'none\'; style-src \'unsafe-inline\';&quot;><base target=&quot;_blank&quot;><body style=&quot;margin:10px;font:13.5px/1.5 -apple-system,Segoe UI,sans-serif;color:#1c2b33;word-break:break-word&quot;>')}${esc(a.bodyHtml)}"></iframe>
         <div class="mini muted" style="padding:4px 10px 8px"><a href="#" onclick="(state.plainMail=state.plainMail||{})['${a.id}']=true;render();return false" style="color:inherit">View plain text</a> · images &amp; scripts blocked</div>
       </div>`
    : `<div class="art-body" style="white-space:pre-wrap">${esc(a.body)}</div>${a.kind==='mail-in'&&a.bodyHtml?`<div class="mini muted" style="margin-top:4px"><a href="#" onclick="delete (state.plainMail||{})['${a.id}'];render();return false" style="color:inherit">View formatted</a></div>`:''}`;
  return `<div class="art ${a.kind} ${isAgent?'agent':''}">
    <span class="avatar">${esc(av)}</span>
    <div class="art-main">
      <div class="art-top" style="display:flex;align-items:center;gap:8px"><b>${esc(a.author.name)}</b>${kindLab}${editedMark}${noteActions}<span class="art-ts">${fmtDT(a.ts)}</span></div>
      ${editing ? renderNoteEditor(t,a) : `${bodyHtml}${attsHtml}`}
      ${timeChip}
    </div>
  </div>`;
}

/* ---- note editing (build 17): inline editor + the save control ------------
   Mirrors the composer's staging mechanism EXACTLY — new files stage into
   state.editAtts (each {name,size,type,_file}); on Save they upload via
   stageUploads (→ their row ids) and the PATCH claims them, just like
   sendArticle. Only the ONE note being edited shows the editor (its id ===
   state.editNote), so the single global state.editAtts is unambiguous. Open
   and Cancel are inline state sets (the same pattern as the title editor) —
   the body reverts to a.body on Cancel because nothing mutated it until Save. */
function renderNoteEditor(t, a){
  const staged = state.editAtts || [];
  return `<div class="note-edit" style="margin-top:6px">
    <textarea id="editBody-${esc(a.id)}" style="width:100%;min-height:92px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;resize:vertical;box-sizing:border-box" placeholder="The note can't be emptied — write something or Cancel.">${esc(a.body)}</textarea>
    ${(a.atts&&a.atts.length)?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center"><span class="mini muted">kept:</span>${a.atts.map(f=>`<span class="chip" style="background:#eef2f1" title="${esc(f.type||'')} — existing attachments stay; edits only ADD">📎 ${esc(f.name)} <span class="mini muted">${fmtKB(f.size)}</span></span>`).join('')}</div>`:''}
    ${staged.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${staged.map((f,i)=>`<span class="chip" style="background:#eef2f1"><span>📎 ${esc(f.name)}</span> <span class="mini muted">${fmtKB(f.size)}</span><button class="rowbtn" style="padding:0 5px" onclick="rmEditAtt(${i})" title="Remove before saving">×</button></span>`).join('')}</div>`:''}
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <label class="rowbtn" style="cursor:pointer" title="Add files to this note — staged now, uploaded on Save">📎 attach<input type="file" multiple style="display:none" onchange="addEditAtts(this)"></label>
      <span style="flex:1"></span>
      <button class="btn sm primary" onclick="editNote(${t.id},'${jsq(a.id)}')">Save</button>
      <button class="btn sm ghost" onclick="state.editNote=null;state.editAtts=[];render()">Cancel</button>
    </div>
  </div>`;
}

/* the Save control (one function per control): optimistic body/attachment
   update lands first + render, THEN stageUploads → PATCH; the returned article
   reconciles the one row (body, editedAt/By, the authoritative attachment
   list) without a full rehydrate — this endpoint touches desk.articles only,
   so there is no ticket.version and it can't raise the 409 version-conflict.
   Any server refusal (stale button after the timesheet was approved → 423,
   permission → 403, guard → 409) routes through oops(): alert + rehydrate. */
function editNote(tid, aid){
  const t = tk(tid); if(!t) return;
  const a = t.articles.find(x=>x.id===aid); if(!a) return;
  /* re-assert the gate locally so a stale DOM handler can't skip it (the
     server enforces regardless — this is the courtesy check) */
  if(a.kind!=='note' || a.auto){ toast('Only internal notes can be edited.'); return; }
  if(projLocked(t)){ toast('This project is approved & locked — an admin can unlock it from the checklist card.'); return; }
  if(a.time && (a.time.approved || a.time.locked)){ toast('The linked timesheet is approved — the note is frozen with it.'); return; }
  if(!((a.author?.id===state.meId) || can('see_billing'))) return;
  const el = document.getElementById('editBody-'+aid);
  const body = (el ? el.value : a.body).trim();
  if(!body){ toast('A note can’t be emptied — write something or cancel.'); return; }
  const staged = (state.editAtts||[]).slice();
  const before = a.body;
  if(body===before && !staged.length){ state.editNote=null; state.editAtts=[]; render(); return; }  /* no-op — nothing to mirror */
  /* --- all checks passed; optimistic mutation --- */
  a.body = body;
  if(staged.length) a.atts = (a.atts||[]).concat(staged);
  a.editedAt = nowMs(); a.editedBy = state.user.name;
  state.editNote = null; state.editAtts = [];
  /* build 22: a note edit is now a first-class ticket event — it lands on the
     ticket's Audit block (sys article, before→after) AND marks the ticket
     'updated' (the server _touches it; the reconcile below syncs the fresh
     version + updated_at so the next property edit can't 409). */
  const clip = s => { s=String(s||''); return s.length>120 ? s.slice(0,120)+'…' : s; };
  t.articles.push(art('sys', me(), nowMs(),
    `Internal note edited — before “${clip(before)}” → after “${clip(body)}”`
    + (staged.length?` · +${staged.length} attachment${staged.length===1?'':'s'}`:'')));
  t.updatedAt = nowMs();
  log('Note edited', `#${t.id}${staged.length?` · +${staged.length} attachment${staged.length===1?'':'s'}`:''}`);
  toast(`Note updated${staged.length?` · ${staged.length} attachment${staged.length===1?'':'s'} added`:''} — audited; the thread shows “(edited).”`);
  render();
  /* --- mirror: staged files first (each returns its row id), then PATCH the
     note claiming them — the server links the rows, writes the audit line and
     returns the reconciled article --- */
  stageUploads(staged).then(ids=>{
    const payload = { body };
    if(ids.length) payload.attachment_ids = ids;
    return $fetch('/api/tickets/'+tid+'/articles/'+aid,{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  }).then(async r=>{ const d=await r.json().catch(()=>0);
    if(!r.ok) return oops(d);
    /* the note edit now bumps the ticket's version + updated_at server-side —
       sync both (there is no rehydrate here) so a following property edit can't
       409 and the board shows the fresh "Updated" time */
    if(d && d.version) t.version = d.version;
    if(d && typeof d.updatedAt==='number') t.updatedAt = d.updatedAt;
    const ra = d && d.article;                 /* the reconciled article the server returns */
    if(ra){
      if(typeof ra.body==='string') a.body = ra.body;
      if('editedAt' in ra) a.editedAt = ra.editedAt;
      if('editedBy' in ra) a.editedBy = ra.editedBy;
      /* server returns the authoritative list in its OWN key shape
         (filename/byteSize/mimeType) — map it to the UI's att shape */
      if(Array.isArray(ra.attachments)) a.atts = ra.attachments.map(f=>({id:f.id, name:f.filename, size:f.byteSize, type:f.mimeType}));
      render();
    }
  }).catch(d=>oops(d));
}

/* delete a note or public reply (build 26): confirm → optimistic tombstone +
   void the linked time entry → DELETE mirror. Re-asserts every gate locally so
   a stale DOM handler can't skip it (the server enforces regardless — DELETE
   .../articles/{id} re-checks and 423s a just-approved timesheet / 409s the
   guard, both routed through oops()). The article stays in t.articles as a
   tombstone (deletedAt/deletedBy set, body cleared); its linked entry is voided
   (Ledger keeps the voided row); a sys article lands on the Audit block and
   log() mirrors the global Audit Log — both differentiate note vs reply. */
function deleteArticle(tid, aid){
  const t = tk(tid); if(!t) return;
  const a = t.articles.find(x=>x.id===aid); if(!a) return;
  if(a.deletedAt) return;                                   /* already a tombstone */
  if(a.kind!=='note' && a.kind!=='reply'){ toast('Only internal notes and public replies can be deleted.'); return; }
  if(a.auto){ toast('Auto-generated entries can’t be deleted.'); return; }
  if(projLocked(t)){ toast('This project is approved & locked — an admin can unlock it from the checklist card.'); return; }
  if(a.time && (a.time.approved || a.time.locked)){ toast('The linked timesheet is approved or its billing period is locked — this can’t be deleted.'); return; }
  /* the article must be server-persisted before we can delete it: a just-composed
     note/reply keeps its local id until the next hydrate reconciles it, and a
     DELETE on that id would 404. Guard BEFORE any optimistic mutation/toast so we
     never claim "deleted — audited" for an action that never reached the server.
     (renderArt also hides the Delete button while the id is local — this is the
     defensive twin for a stale handler.) */
  if(!srvId(aid)){ toast('This note is still saving — give it a moment, then try again.'); return; }
  const kindLab = a.kind==='reply' ? 'public reply' : 'internal note';
  const kl2 = a.kind==='reply' ? 'Public reply' : 'Internal note';
  const voidedH = a.time ? a.time.h : 0;
  const timeLine = a.time ? `\n\nIts linked time entry (${fmtHours(a.time.h)} h) will be voided — Ledger keeps a voided row.` : '';
  if(!confirm(`Delete this ${kindLab}?${timeLine}\n\nThe content, who deleted it, and when are recorded in the ticket Audit block and the global Audit Log. It’s replaced by a tombstone in the thread and can’t be restored from the app.`)) return;
  /* --- all checks passed; optimistic mutation --- */
  const before = a.body;
  if(a.time){                                               /* void + unlink the entry locally */
    const i = t.time.indexOf(a.time); if(i>=0) t.time.splice(i,1);
    delete a.time;
  }
  a.deletedAt = nowMs(); a.deletedBy = state.user.name; a.body = ''; a.bodyHtml = null; a.atts = [];
  const clip = s => { s=String(s||''); return s.length>120 ? s.slice(0,120)+'…' : s; };
  const detail = `${kl2} deleted — “${clip(before)}”` + (voidedH?` · ${fmtHours(voidedH)} h voided`:'');
  t.articles.push(art('sys', me(), nowMs(), detail));       /* Audit block sibling */
  t.updatedAt = nowMs();
  log(`${kl2} deleted`, `#${t.id} · “${clip(before)}”` + (voidedH?` · ${fmtHours(voidedH)} h voided`:''));  /* global Audit Log */
  toast(`${kl2} deleted — audited.` + (voidedH?' Linked time voided in Ledger.':''));
  render();
  $fetch('/api/tickets/'+tid+'/articles/'+aid,{method:'DELETE'})
    .then(async r=>{ const d=await r.json().catch(()=>0);
      if(!r.ok) return oops(d);
      /* the delete bumps the ticket's version + updated_at server-side — sync
         both (no rehydrate here) so a following property edit can't 409 and the
         board shows the fresh "Updated" time */
      if(d && d.version) t.version = d.version;
      if(d && typeof d.updatedAt==='number') t.updatedAt = d.updatedAt;
    }).catch(d=>oops(d));
}

/* editor attachment controls — mirror addAtts/rmAtt but stage into
   state.editAtts and preserve the in-progress textarea value across the
   render (the editBody textarea is markup-prefilled from a.body, so a plain
   render would otherwise discard whatever the editor typed) */
function addEditAtts(inp){
  state.editAtts = state.editAtts||[];
  [...inp.files].forEach(f=>{ if(!state.editAtts.some(x=>x.name===f.name && x.size===f.size)) state.editAtts.push({ name:f.name, size:f.size, type:f.type||'application/octet-stream', _file:f }); });
  inp.value='';
  const aid = state.editNote;
  const body = document.getElementById('editBody-'+aid)?.value; render();
  const b2 = document.getElementById('editBody-'+aid); if(b2 && body!=null) b2.value = body;
}
function rmEditAtt(i){
  const aid = state.editNote;
  const body = document.getElementById('editBody-'+aid)?.value;
  state.editAtts.splice(i,1); render();
  const b2 = document.getElementById('editBody-'+aid); if(b2 && body!=null) b2.value = body;
}

/* ---- canned responses: a local text convenience — the insert renders the
   template variables for this ticket and drops the text into the composer ---- */
function trigVars(t, tpl){
  const p = contact(t.contactId)||{}, c = client(t.clientId)||{}, o = t.ownerId? agent(t.ownerId) : null;
  return tpl
    .replaceAll('#{ticket.number}', String(t.id))
    .replaceAll('#{ticket.title}', TITLES[t.id]||firstLine(t))
    .replaceAll('#{customer.first}', ((p.name||'customer').trim().split(/\s+/)[0])||'customer')
    .replaceAll('#{customer.name}', p.name||'customer')
    .replaceAll('#{client.name}', c.name||'')
    .replaceAll('#{agent.name}', o? o.name : state.user.name)
    .replaceAll('#{state.label}', st8(t.st)?.label||t.st);
}
function insertCanned(tid, sel){
  const c = CANNED.find(x=>x.id===sel.value); sel.value=''; if(!c) return;
  const t = tk(tid);
  const ta = document.getElementById('composeBody');
  const rendered = trigVars(t, c.body);
  ta.value = ta.value ? (ta.value.replace(/\s+$/,'') + '\n\n' + rendered) : rendered;
  ta.focus();
  composerTimerStart(tid);
}

/* --- time entries: editable on the ticket, every change audited ----------- */
function agentEmail(id){ return (AGENTS.find(a=>a.id===id)||{}).email||ME.email; }

function attachTime(tid, aid){
  const t = tk(tid), a = t.articles.find(x=>x.id===aid); if(!a || a.time || a.auto || (a.kind!=='note'&&a.kind!=='reply')) return;
  if(!can('log_time')) return;
  if(projLocked(t)) return;
  const techId = AGENTS.some(x=>x.id===a.author?.id) ? a.author.id : state.meId;
  if(techId!==state.meId && !can('see_billing')) return;
  const e = { startedAt:a.ts-15*MIN, endedAt:a.ts, h:spanH(a.ts-15*MIN, a.ts), typeId:(state.composer.typeId||null), techId, eid:'te'+(state.teSeq=(state.teSeq||0)+1) };
  if(isProj(t)) e.taskId = state.composer.taskId || defaultTaskId(t) || null;
  a.time = e; t.time.push(e);
  t.updatedAt = nowMs();
  log('Time entry added to '+(a.kind==='reply'?'email':'note'), `#${t.id} · ${agent(techId).name.split(' ')[0]} · ${msTime(e.startedAt)}–${msTime(e.endedAt)} = ${fmtHours(e.h)} h · ${atype(e.typeId).name}`);
  bridgeSend('time-logged', { eid:e.eid, ticket:t.id, title:TITLES[t.id]||firstLine(t), clientId:t.clientId, techId, typeId:e.typeId, h:e.h, startedAt:e.startedAt, endedAt:e.endedAt, note:a.body.slice(0,140), task: taskPayload(t, e.taskId) });
  toast(`Time attached to the note — ${msTime(e.startedAt)}–${msTime(e.endedAt)} = ${fmtHours(e.h)} h. Adjust the span inline.`);
  render();
  $fetch('/api/tickets/'+tid+'/time',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({article_id:srvId(aid)?aid:null,
      started_at:iso(e.startedAt), ended_at:iso(e.endedAt),
      activity_type:typeName(e.typeId), technician_email:agentEmail(e.techId),
      task_id:srvId(e.taskId)?e.taskId:null,
      note:a.body.slice(0,140)})})
    .then(async r=>{ const d=await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      e.eid=d.id;
      /* the server _touch bumped the ticket version — sync it or the next
         property edit 409s on the stale lock (audit; build 14b/16 F1) */
      if(d.version){ t.version=d.version; t.updatedAt=d.updatedAt||t.updatedAt; } });
}

function editTimeEntry(tid, i, k, v, srcEl){
  const t = tk(tid), e = t.time[i]; if(!e) return;
  if(!srvId(e.eid)){ /* mid-save (audit): mutating now would toast success and
                        silently never reach the server */
    toast('This entry is still saving — try again in a second.'); commitRender(srcEl); return; }
  if(projLocked(t)){ toast('Approved project — time is frozen. Admin unlock available on the checklist card.'); commitRender(srcEl); return; }
  if(!(can('see_billing') || (can('log_time') && e.techId===state.meId))) return;
  const was = { s:e.startedAt, en:e.endedAt, ty:e.typeId, ta:e.taskId };
  const oldH = e.h;
  if(k==='date' || k==='start' || k==='end'){
    if(k!=='date' && !validT(v)){ commitRender(srcEl); return; }
    if(k==='date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)){ commitRender(srcEl); return; }
    let a = e.startedAt, b = e.endedAt;
    if(k==='date'){ const dur=b-a; a = spanMs(v, msTime(a)); b = a + dur; }
    if(k==='start') a = spanMs(msDate(e.startedAt), v);
    if(k==='end')   b = spanMs(msDate(e.endedAt), v);
    if(!(b>a)){ toast('End must be after start — change not saved. (Worked past noon? 4:30 PM is 16:30.)'); commitRender(srcEl); return; }
    e.startedAt=a; e.endedAt=b; e.h = spanH(a,b);
    log('Time entry edited', `#${t.id} · ${agent(e.techId).name.split(' ')[0]} · ${msTime(was.s)}–${msTime(was.en)} → ${msTime(a)}–${msTime(b)} on ${msDate(a)} = ${fmtHours(e.h)} h`);
  } else if(k==='typeId'){
    log('Time entry reclassified', `#${t.id} · ${atype(e.typeId).name} → ${atype(v).name}`);
    e.typeId = v;
  } else if(k==='taskId'){
    if(!isProj(t) || !projEditable(t)) return;
    const wasT = e.taskId? (projTask(t,e.taskId)?.label||'?') : '(no task)';
    const nowT = v? (projTask(t,v)?.label||'?') : '(no task)';
    log('Time entry moved between tasks', `#${t.id} · ${wasT} → ${nowT}`);
    e.taskId = v||null;
  }
  t.updatedAt = nowMs();
  bridgeSend('time-updated', { eid:e.eid, startedAt:e.startedAt, endedAt:e.endedAt, h:e.h, oldH, techId:e.techId, typeId:e.typeId, ticket:t.id, task: taskPayload(t, e.taskId) });
  toast(`Span saved — ${msTime(e.startedAt)}–${msTime(e.endedAt)} = ${fmtHours(e.h)} h. Audited and mirrored in Ledger.`); commitRender(srcEl);
  if(e.startedAt===was.s && e.endedAt===was.en && e.typeId===was.ty && e.taskId===was.ta) return;
  if(!srvId(e.eid)) return;                      /* local-only entry (pre-mirror) */
  $fetch('/api/time/'+e.eid,{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({started_at:iso(e.startedAt), ended_at:iso(e.endedAt),
      activity_type:typeName(e.typeId),
      task_id:e.taskId?(srvId(e.taskId)?e.taskId:undefined):''})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

function removeTimeEntry(tid, i){
  if(projLocked(tk(tid))){ toast('Approved project — time is frozen.'); return; }
  const t = tk(tid), e = t.time[i]; if(!e) return;
  if(!srvId(e.eid)){ /* mid-save (audit): removing now would claim a voided
                        Ledger row while the server row survives and BILLS */
    toast('This entry is still saving — try again in a second.'); return; }
  if(!(can('see_billing') || (can('log_time') && e.techId===state.meId))) return;
  const holder = t.articles.find(a=>a.time===e);
  if(holder) delete holder.time;
  t.time.splice(i,1);
  t.updatedAt = nowMs();
  log('Time entry removed', `#${t.id} · ${agent(e.techId).name.split(' ')[0]} · ${fmtHours(e.h)} h (${atype(e.typeId).name}) — Ledger row voided, not deleted`);
  bridgeSend('time-removed', { eid:e.eid, ticket:t.id, techId:e.techId, typeId:e.typeId, h:e.h });
  toast('Entry removed here — Ledger keeps a voided row for the audit trail.'); render();
  if(!srvId(e.eid)) return;                      /* never mirrored — nothing to void */
  $fetch('/api/time/'+e.eid,{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({void:true,void_reason:'removed from ticket'})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

/* ---- composer attachments: staged locally, uploaded on send ---- */
function addAtts(inp){
  const cm = state.composer; cm.atts = cm.atts||[];
  [...inp.files].forEach(f=>{ if(!cm.atts.some(x=>x.name===f.name && x.size===f.size)) cm.atts.push({ name:f.name, size:f.size, type:f.type||'application/octet-stream', _file:f }); });
  inp.value='';
  const body = document.getElementById('composeBody')?.value; render();
  const b2 = document.getElementById('composeBody'); if(b2 && body!=null) b2.value = body;
}
function rmAtt(i){
  state.composer.atts.splice(i,1);
  const body = document.getElementById('composeBody')?.value; render();
  const b2 = document.getElementById('composeBody'); if(b2 && body!=null) b2.value = body;
}

/* ---- tags ---- */
/* build 22: a tag change is a first-class ticket event — optimistic sys article
   on the ticket Audit block + 'updated' bump; the endpoint _touches the ticket
   and returns the fresh version/updated time, synced here (no rehydrate) so a
   following property edit can't 409. */
function tagSynced(t){ return async r=>{ const d=await r.json().catch(()=>0);
  if(!r.ok) return oops(d);
  if(d && d.version) t.version=d.version;
  if(d && typeof d.updatedAt==='number'){ t.updatedAt=d.updatedAt; render(); } }; }
function addTag(tid){
  if(!can('edit_props')||projLocked(tk(tid))) return;
  const t=tk(tid); const v=prompt('Tag'); if(!v) return;
  const before=t.tags.slice();
  t.tags.push(v.toLowerCase().replace(/\s+/g,'-'));
  const add=t.tags.filter(x=>!before.includes(x));
  if(!add.length){ render(); return; }           /* duplicate — nothing new to mirror */
  t.articles.push(art('sys', me(), nowMs(), 'Tags added: '+add.join(', ')));
  t.updatedAt=nowMs();
  log('Tag added',`#${t.id} · ${v}`); render();
  $fetch('/api/tickets/'+tid+'/tags',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({add,remove:[]})}).then(tagSynced(t));
}
/* reply-CC list — visible + editable (review: capture went live with no way
   to see or prune it; agents were copying recipients they couldn't control) */
function _ccPatch(t, next){
  $fetch('/api/tickets/'+t.id,{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({version:t.version, cc:next})})
    .then(async r=>{ const d=await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      if(d.version){ t.version=d.version; t.updatedAt=d.updatedAt||nowMs(); } });
}
function addCc(tid){
  if(!can('edit_props')||projLocked(tk(tid))) return;
  const t=tk(tid);
  const v=(prompt('Address to CC on every agent reply:')||'').trim().toLowerCase();
  if(!v||v.indexOf('@')<1) return;
  const next=[...new Set([...(t.cc||[]), v])];
  if(next.length===(t.cc||[]).length) return;
  t.cc=next; log('Reply CC added',`#${t.id} · ${v}`); render();
  _ccPatch(t, next);
}
function rmCc(tid,i){
  if(!can('edit_props')||projLocked(tk(tid))) return;
  const t=tk(tid); const gone=(t.cc||[])[i]; if(!gone) return;
  const next=(t.cc||[]).filter((_,x)=>x!==i);
  t.cc=next; log('Reply CC removed',`#${t.id} · ${gone}`); render();
  _ccPatch(t, next);
}
function rmTag(tid,i){
  if(!can('edit_props')||projLocked(tk(tid))) return;
  const t=tk(tid); const before=t.tags.slice(); const gone=t.tags[i];
  t.tags.splice(i,1);
  const rem=before.filter(x=>!t.tags.includes(x));
  if(!rem.length){ render(); return; }           /* a twin remains — nothing to mirror */
  t.articles.push(art('sys', me(), nowMs(), 'Tags removed: '+rem.join(', ')));
  t.updatedAt=nowMs();
  log('Tag removed',`#${t.id} · ${gone}`); render();
  $fetch('/api/tickets/'+tid+'/tags',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({add:[],remove:rem})}).then(tagSynced(t));
}


/* ---- wake timers: the server reopens pending tickets authoritatively;
   this mirrors the flip locally the second it falls due, so the queue
   never shows a stale "pending" row between hydrates ---- */
function checkPendingWakes(){
  let woke = false;
  state.tickets.forEach(t=>{
    if(t.pendingUntil && nowMs() >= t.pendingUntil && (st8(t.st)||{}).type==='paused'){
      const was = st8(t.st).label;
      delete t.pendingUntil;
      t.st = 'open'; t.updatedAt = nowMs();
      t.articles.push(art('sys', {name:'Automation'}, nowMs(), '⏰ Wake timer reached — reopened from '+was.toLowerCase()));
      state.audit.unshift({ ts:nowMs(), who:'Automation', action:'Ticket reopened (wake timer)', detail:`#${t.id} · ${was} → Open` });
      woke = true;
    }
  });
  if(woke) render();
}

/* ---------------- composer + the native timer ---------------- */
function composerTimerStart(tid){
  if(state.timer && state.timer.ticketId===tid) return;
  state.timer = { ticketId:tid, startedReal:Date.now() };
  const el=document.getElementById('timerPill'); if(el) el.classList.add('run');
  tickTimer();
}
function timerSeconds(){ return state.timer ? (Date.now()-state.timer.startedReal)/1000 : 0; }
/* the running timer's start on the app clock; now if no timer runs */
function timerStartMs(){ return state.timer ? NOW.getTime() + (state.timer.startedReal - BOOT) : nowMs(); }
function setTW(k,v){
  const cm = state.composer;
  cm.tw = cm.tw || { date:msDate(timerStartMs()), start:msTime(timerStartMs()), end:msTime(nowMs()) };
  if(k!=='date' && !validT(v)) return;              /* partial “:30 --” keystrokes never poison the span */
  if(k==='date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
  cm.tw[k] = v; cm.tw.manual = true;
  const el = document.getElementById('twH'); if(el){ const h=composerH(); el.textContent = isNaN(h)? '0.00' : h.toFixed(2); }
}
function composerSpan(){
  const cm = state.composer;
  if(cm.tw && cm.tw.manual){
    const a = spanMs(cm.tw.date, cm.tw.start); let b = spanMs(cm.tw.date, cm.tw.end);
    return { a, b };
  }
  const a = timerStartMs(); const b = nowMs();
  return { a, b };
}
function composerH(){ const {a,b} = composerSpan(); const h = spanH(a,b); return isNaN(h)? 0 : h; }
function tickTimer(){
  checkPendingWakes();
  const el=document.getElementById('timerClock');
  if(el && state.timer && state.timer.ticketId===state.ticketId) el.textContent = fmtClock(timerSeconds());
  if(state.timer && !(state.composer.tw&&state.composer.tw.manual)){
    const te=document.getElementById('twEnd'); if(te && document.activeElement!==te) te.value = msTime(nowMs());
    const ts2=document.getElementById('twStart'); if(ts2 && document.activeElement!==ts2) ts2.value = msTime(timerStartMs());
    const td=document.getElementById('twDate'); if(td && document.activeElement!==td) td.value = msDate(timerStartMs());
    const hh=document.getElementById('twH'); if(hh){ const h=composerH(); hh.textContent = isNaN(h)? '0.00' : h.toFixed(2); }
  }
}
setInterval(tickTimer, 1000);
function timerReset(){ state.timer=null; state.composer.tw=null; const el=document.getElementById('timerPill'); if(el){el.classList.remove('run'); document.getElementById('timerClock').textContent='00:00';} }

function setComposer(k,v){ state.composer[k]=v;
  if(k==='kind'){
    /* full re-render so the button label, meta line, placeholder and time
       tools all follow the tab — preserving whatever's typed */
    const body = document.getElementById('composeBody')?.value;
    render();
    const b2 = document.getElementById('composeBody');
    if(b2 && body!=null){ b2.value = body; }
    return;
  }
}

function renderComposer(t){
  const cm = state.composer;
  const running = state.timer && state.timer.ticketId===t.id;
  const canReply = can('reply'), canNote = can('note');
  if(!canReply && cm.kind==='reply') cm.kind='note';
  return `
  <div class="composer ${cm.kind==='note'?'note-mode':''}" id="composer">
    <div class="composer-tabs">
      ${canReply?`<button class="ctab ${cm.kind==='reply'?'on':''}" data-k="reply" onclick="setComposer('kind','reply')">Public reply</button>`:''}
      ${canNote?`<button class="ctab ${cm.kind==='note'?'on':''}" data-k="note" onclick="setComposer('kind','note')">Internal note</button>`:''}
      <span class="spacer"></span>
      <span class="mini muted">${cm.kind==='reply'
        ? `sends from <span class="tape">${esc(outboundFor(t).addr.split('@')[0])}@</span> <span title="Replies always go out from the board's address — configured per board in Automations → Outbound routing">(${esc(grp(t.groupId).name)} board)</span>`
        : 'visible to agents only'}</span>
    </div>
    ${cm.kind==='reply'?`
    <div class="mail-fields" style="display:flex;flex-direction:column;gap:7px;padding:9px 14px;border-bottom:1px solid var(--line);background:#fbfcfb">
      <div style="display:flex;gap:8px;align-items:center">
        <span class="mini muted" style="width:26px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">To</span>
        <input type="text" id="mailTo" value="${esc(cm.to ?? (contact(t.contactId)?.email||''))}" oninput="setComposer('to',this.value)" style="flex:1;font-size:12.5px" placeholder="recipient@example.com">
      </div>
    </div>`:''}
    <div id="attStage" style="display:${(state.composer.atts||[]).length?'flex':'none'};gap:6px;flex-wrap:wrap;padding:8px 14px 0">
      ${(state.composer.atts||[]).map((f,i)=>`<span class="chip" style="background:#eef2f1"><span>📎 ${esc(f.name)}</span><span class="mini muted">${fmtKB(f.size)}</span><button class="rowbtn" style="padding:0 5px" onclick="rmAtt(${i})">×</button></span>`).join('')}
    </div>
    <textarea id="composeBody" placeholder="${cm.kind==='reply'?'Write to the customer — the clock below runs while you type…':'Note for the team — the clock below runs while you type…'}" onfocus="composerTimerStart(${t.id})" oninput="composerTimerStart(${t.id})"></textarea>
    <div class="composer-foot">
      <select style="width:auto;max-width:170px;font-size:12px" onchange="insertCanned(${t.id}, this)" title="Insert a canned response — template variables render for this ticket">
        <option value="">✏ canned…</option>
        ${CANNED.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
      <label class="rowbtn" style="cursor:pointer" title="Attach files — stored in object storage, scanned, then linked to this ${cm.kind==='reply'?'email':'note'}">📎 attach<input type="file" multiple style="display:none" onchange="addAtts(this)"></label>
      <span class="time-tools" style="display:inline-flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="timer-pill ${running?'run':''}" id="timerPill" title="The clock fills the end time while you type — or set date, start and end yourself; hours are always derived from the span">
        <span class="tdot"></span>
        <span class="tclock" id="timerClock" style="font-size:12px">${running?fmtClock(timerSeconds()):'00:00'}</span>
        <button class="treset" onclick="timerReset()" title="Discard tracked time">reset</button>
      </span>
      ${can('log_time')?`
      <span class="mini muted" style="display:inline-flex;align-items:center;gap:5px">
        <input type="date" id="twDate" value="${cm.tw?.date||msDate(running?timerStartMs():nowMs())}" style="width:130px;font-size:12px;padding:4px 6px" onchange="setTW('date',this.value)">
        <input type="time" id="twStart" value="${cm.tw?.start||msTime(running?timerStartMs():nowMs())}" style="width:86px;font-size:12px;padding:4px 6px" onchange="setTW('start',this.value)">
        –
        <input type="time" id="twEnd" value="${cm.tw?.end||msTime(nowMs())}" style="width:86px;font-size:12px;padding:4px 6px" onchange="setTW('end',this.value)">
        = <span class="tape" id="twH" style="font-weight:600">${composerH().toFixed(2)}</span> h
      </span>`:''}
      ${can('log_time')?`
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2)">
        <input type="checkbox" ${cm.logTime?'checked':''} onchange="setComposer('logTime',this.checked)" style="accent-color:var(--brand)">
        log to Ledger as
      </label>
      <select onchange="setComposer('typeId',this.value)" ${cm.logTime?'':'disabled'}>
        ${aATYPES().map(a=>`<option value="${a.id}" ${cm.typeId===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}
      </select>
      ${isProj(t)?`<span class="mini muted">under task</span>
      <select onchange="setComposer('taskId',this.value)" ${cm.logTime?'':'disabled'} title="Project time lands under a checklist task — Ledger prices it by the task's billing">
        <option value="">— pick a task —</option>
        ${t.project.tasks.map(x=>`<option value="${x.id}" ${(cm.taskId||defaultTaskId(t))===x.id?'selected':''}>${esc(x.label)}${x.done?' ✓':''}</option>`).join('')}
      </select>`:''}`:''}
      </span>
      <span class="spacer"></span>
      <button class="btn primary" onclick="sendArticle(${t.id})">${cm.kind==='reply'?'Send reply':'Add note'}</button>
    </div>
  </div>`;
}

function sendArticle(tid){
  const t = tk(tid); const cm = state.composer;
  const body = document.getElementById('composeBody').value.trim();
  if(!body){ toast('Write something first — the composer is empty.'); return; }
  if(cm.kind==='reply' && !can('reply')) return;
  if(cm.kind==='note' && !can('note')) return;
  if(projLocked(t)){ toast('This project is approved & locked — an admin can unlock it from the checklist card.'); return; }
  /* validate EVERYTHING before touching the ticket — a blocked send must
     leave no side effects (no state, no time, nothing) */
  const to = cm.kind==='reply' ? (cm.to ?? contact(t.contactId)?.email ?? '').trim() : null;
  if(cm.kind==='reply' && !to){ toast('The reply needs a To address.'); return; }
  let logged = null;
  if(can('log_time') && cm.logTime){
    const { a:spA, b:spB } = composerSpan();
    if(!(spB>spA) || isNaN(spB-spA)){ toast('Set a real span — end after start. (Worked past noon? 4:30 PM is 16:30.)'); return; }
    const h = spanH(spA, spB);
    if(h < 0.01){ toast('That span rounds to 0.00 h — adjust the start or end time.'); return; }
    logged = { startedAt:spA, endedAt:spB, h, typeId: cm.typeId, techId: state.meId, eid:'te'+(state.teSeq=(state.teSeq||0)+1) };
    if(isProj(t)){
      logged.taskId = cm.taskId || defaultTaskId(t);
      if(!logged.taskId){ toast('Pick the checklist task this time belongs to.'); return; }
    }
  }
  /* --- all checks passed; mutations begin --- */
  const sig = cm.kind==='reply' ? AGENT_SIGS[state.meId] : null;
  const outBody = sig ? body + '\n\n' + sig : body;
  const a = art(cm.kind==='reply'?'reply':'note', me(), nowMs(), outBody);
  if(cm.kind==='reply'){
    a.from = outboundFor(t).addr;
    a.to = to;
  }
  if(cm.atts && cm.atts.length){ a.atts = cm.atts; cm.atts = []; }
  if(logged){
    if(cm.tw && cm.tw.manual) log('Time entered manually', `#${t.id} · ${msTime(logged.startedAt)}–${msTime(logged.endedAt)} on ${msDate(logged.startedAt)} = ${fmtHours(logged.h)} h`);
    cm.tw = null;
    a.time = logged;
    t.time.push(logged);
  }
  t.articles.push(a);
  /* audit the ADDITION as its own ticket event (build 24) — mirrors the server;
     the note/reply body is the article above, this is the compact who/what line
     that shows in the Audit block (the thread already shows the content). Match
     the server's sent-vs-recorded wording using the client's known outbound
     state (MAILCFG.outboundEnabled + a connected outbound mailbox for this
     ticket) so recorded-only replies — the default — don't briefly read "sent". */
  const _om = outboundFor(t);
  const _willSend = MAILCFG.outboundEnabled && !!_om && _om.outbound && _om.status==='connected';
  /* include the content (capped, matching the server's cap_text) so the audit
     shows WHAT was added and the optimistic line matches the server's wording */
  const _snip = a.body.length>4000 ? a.body.slice(0,4000)+`… [+${a.body.length-4000} more chars]` : a.body;
  const replyLbl = (_willSend ? ('Public reply sent to '+to) : ('Public reply recorded (to '+to+')')) + ` — “${_snip}”`;
  t.articles.push(art('sys', me(), nowMs(), cm.kind==='reply' ? replyLbl : `Internal note added — “${_snip}”`));
  if(logged) bridgeSend('time-logged', { eid:logged.eid, ticket:t.id, title:TITLES[t.id]||firstLine(t), clientId:t.clientId, techId:logged.techId, typeId:logged.typeId, h:logged.h, startedAt:logged.startedAt, endedAt:logged.endedAt, note:body.slice(0,140), task: taskPayload(t, logged.taskId) });
  if(cm.kind==='reply'){ t.slaFrMet = true; }
  if(t.st==='new' && cm.kind==='reply'){
    t.st='open';
    log('State changed', `#${t.id} · New → Open (first reply)`);
  }
  t.updatedAt = nowMs();
  log(cm.kind==='reply'?'Reply sent':'Note added', `#${t.id} ${TITLES[t.id]||''}`.trim() + (logged?` · ${fmtHours(logged.h)}h → Ledger (${atype(logged.typeId).name})`:'') + (a.atts?` · ${a.atts.length} attachment${a.atts.length===1?'':'s'}`:''));
  state.timer=null;
  toast(cm.kind==='reply'
    ? (logged? `Reply sent · ${fmtHours(logged.h)} h logged to Ledger.` : 'Reply sent.')
    : (logged? `Note added · ${fmtHours(logged.h)} h logged to Ledger.` : 'Note added.'));
  render();
  /* mirror: staged files first (each returns its row id), then the article
     that claims them — the server links the rows and mails them on replies */
  const payload={kind:a.kind==='reply'?'reply':'note', body:a.body,
                 author_email:ME.email};
  /* the editable To override MUST travel — the server honors it first in its
     recipient COALESCE; without it the reply mails the ticket contact while
     the thread shows the typed address (audit) */
  if(a.kind==='reply'&&a.to) payload.to=a.to;
  if(a.time) payload.time={started_at:iso(a.time.startedAt||Date.now()-a.time.h*36e5),
    ended_at:iso(a.time.endedAt||Date.now()),
    activity_type:typeName(a.time.typeId), technician_email:ME.email,
    task_id:a.time.taskId&&a.time.taskId.length>10?a.time.taskId:null};
  stageUploads(a.atts).then(ids=>{
    if(ids.length) payload.attachment_ids=ids;
    return $fetch('/api/tickets/'+tid+'/articles',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  }).then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),700); })
    .catch(d=>oops(d));
}
