/* ==========================================================================
   js/desk/views/tickets.js — the queue and the ticket case file, plus the
   whole working loop: composer (reply/note + the native timer), time
   entries, tags, title, bulk actions and CSV export.
   Owns: overviews/setOverview/setQF/viewTickets · bulkToggle/bulkApply ·
   ticketsCSVRows/auditCSVRows/exportTicketsCSV/exportAuditCSV/copyRowsCSV/
   copyTicketsCSV/copyAuditCSV · viewTicket/renderArt · insertCanned/trigVars ·
   agentEmail · attachTime/editTimeEntry/removeTimeEntry · addAtts/rmAtt ·
   addTag/rmTag · checkPendingWakes · composerTimerStart/
   timerSeconds/timerStartMs/setTW/composerSpan/composerH/tickTimer (1 s
   interval)/timerReset · setComposer/renderComposer/sendArticle.
   Endpoints:
     POST  /api/tickets/{id}/articles   (sendArticle; staged files first via
                                         stageUploads → POST /api/uploads)
     POST  /api/tickets/{id}/tags       (addTag / rmTag / bulk tag)
     POST  /api/tickets/{id}/time       (attachTime)
     PATCH /api/time/{id}               (editTimeEntry / removeTimeEntry-void)
   Title edits and bulk owner/state/priority go through saveTitle/setProp
   in views/props.js.
   Invariants: desk.articles are immutable by DB design — notes and replies
   have no edit control. The ticket Cc list is server-owned (replies mail the
   stored list); nothing here edits it. SLA escalation notices are the server
   scanner's job — nothing here synthesizes them. Local mutation always lands
   before the mirroring fetch; a change that didn't happen never calls out.
   ========================================================================== */

/* ==========================================================================
   TICKETS — the queue
   ========================================================================== */
function overviews(){
  const sc = scoped(); const meIs = t=>t.ownerId===state.meId;
  const o = [
    { id:'myopen', label:'My assigned', f:t=>meIs(t)&&!isDone(t) },
  ];
  if(can('assign')) o.push({ id:'unassigned', label:'Unassigned', f:t=>!t.ownerId&&!isDone(t) });
  o.push(
    { id:'allopen', label: can('view_all')?'All open':'Group open', f:t=>!isDone(t) },
    { id:'pending', label:'Pending / hold', f:t=>(st8(t.st)||{}).type==='paused' },
    { id:'done', label:'Recently solved', f:t=>isDone(t) },
  );
  return o.map(x=>Object.assign(x,{n: sc.filter(x.f).length}));
}
function setOverview(id){ state.overview=id; render(); }
function setQF(k,v){ state.qf[k]=v; render(); }

function viewTickets(){
  const ov = overviews();
  const cur = ov.find(o=>o.id===state.overview) || ov[0];
  let rows = scoped().filter(cur.f);
  const f = state.qf;
  if(f.group!=='all') rows = rows.filter(t=>t.groupId===f.group);
  if(f.prio!=='all') rows = rows.filter(t=>String(t.prio)===f.prio);
  if(f.client!=='all') rows = rows.filter(t=>t.clientId===f.client);
  if(f.q){ const q=f.q.toLowerCase(); rows = rows.filter(t=> (TITLES[t.id]||'').toLowerCase().includes(q) || String(t.id).includes(q) || client(t.clientId).name.toLowerCase().includes(q)); }
  rows.sort((a,b)=> b.prio-a.prio || (slaInfo(a)?.due||9e15)-(slaInfo(b)?.due||9e15) || b.updatedAt-a.updatedAt);
  if(cur.id==='done') rows.sort((a,b)=>b.updatedAt-a.updatedAt);

  const bulkN = state.bulk.filter(id=>rows.some(r=>r.id===id)).length;
  return `
  ${bulkN? `<div class="notice info" style="margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <b>${bulkN} selected</b>
    ${can('assign')?`<select onchange="bulkApply('owner',this.value)"><option value="">Assign to…</option>${AGENTS.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>`:''}
    ${can('edit_props')?`<select onchange="bulkApply('st',this.value)"><option value="">Set state…</option>${aSTATES().filter(x=>!x.system).map(x=>`<option value="${x.id}">${x.label}</option>`).join('')}</select>
    <select onchange="bulkApply('prio',this.value)"><option value="">Set priority…</option>${aPRIOS().map(p=>`<option value="${p.id}">${p.label}</option>`).join('')}</select>
    <button class="btn sm" onclick="bulkApply('tag', prompt('Tag to add:'))">+ tag</button>`:''}
    <button class="btn sm ghost" onclick="state.bulk=[];render()">Clear</button>
  </div>`:''}
  <div class="toolbar">
    ${can('export_csv')?`<span style="order:99;margin-left:auto;display:inline-flex;gap:8px">
      <button class="btn sm" onclick="copyTicketsCSV()" title="Copies the CSV for the rows currently shown">Copy</button>
      <button class="btn primary" onclick="exportTicketsCSV()" title="Exports exactly the rows currently shown — overview + filters applied">${icon(IC.export)}Export CSV</button>
    </span>`:''}
    <div class="seg wrap">${ov.map(o=>`<button class="${state.overview===o.id?'on':''}" onclick="setOverview('${o.id}')">${o.label}<span class="pip">${o.n}</span></button>`).join('')}</div>
    <span class="spacer"></span>
    ${can('create')?`<button class="btn primary" onclick="newTicketModal()">${icon(IC.plus)}New ticket</button>`:''}
  </div>
  <div class="toolbar">
    <div class="search">${icon(IC.search)}<input type="text" placeholder="Search title, number, client…" value="${esc(f.q)}" data-fkey="qf-q" oninput="setQF('q',this.value)"></div>
    <select onchange="setQF('group',this.value)">${['all',...GROUPS.filter(g=>!isArch(g)||f.group===g.id).map(g=>g.id)].map(g=>`<option value="${g}" ${f.group===g?'selected':''}>${g==='all'?'All groups':grp(g).name+(isArch(grp(g))?' (archived)':'')}</option>`).join('')}</select>
    <select onchange="setQF('prio',this.value)"><option value="all">Any priority</option>${PRIOS.filter(p=>!isArch(p)||f.prio==String(p.id)).map(p=>`<option value="${p.id}" ${f.prio==String(p.id)?'selected':''}>${p.label}${isArch(p)?' (archived)':''}</option>`).join('')}</select>
    <span style="display:inline-block;min-width:180px;vertical-align:middle">${combo('qfClient', [{v:'all',label:'All clients',blank:true},...CLIENTS.filter(c=>c.status!=='archived'||f.client===c.id).map(c=>({v:c.id,label:c.name+(c.status==='archived'?' (archived)':''),sub:c.domain||''}))], f.client, function(){ setQF('client', document.getElementById('qfClient').value); }, 'All clients')}</span>
  </div>
  <div class="card">
    ${rows.length? `<table class="tbl">
      <thead><tr>${can('edit_props')||can('assign')?'<th style="width:34px"></th>':''}<th style="width:64px">#</th><th>Ticket</th><th>State</th><th>Priority</th><th>Group</th><th>Owner</th><th>SLA</th><th class="right">Updated</th></tr></thead>
      <tbody>${rows.map(t=>`
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
        </tr>`).join('')}</tbody></table>`
    : `<div class="empty">${icon(IC.ticket)}<div>No tickets match this view. Clear a filter or switch overview.</div></div>`}
  </div>`;
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
        if(can('edit_props') && !t.tags.includes(v)){
          t.tags.push(v); n++;
          $fetch('/api/tickets/'+id+'/tags',{method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({add:[v],remove:[]})})
            .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
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

/* ---- CSV: exports exactly the rows currently shown ---- */
function ticketsCSVRows(){
  const ov = overviews(); const cur = ov.find(o=>o.id===state.overview) || ov[0];
  let rows = scoped().filter(cur.f);
  const f = state.qf;
  if(f.group!=='all') rows = rows.filter(t=>t.groupId===f.group);
  if(f.prio!=='all') rows = rows.filter(t=>String(t.prio)===f.prio);
  if(f.client!=='all') rows = rows.filter(t=>t.clientId===f.client);
  const data = [['number','title','client','contact','group','state','priority','owner','tags','opened','updated','hours_logged','sla_due','sla_breached']];
  rows.forEach(t=>{ const sla = slaInfo(t);
    data.push([t.id, TITLES[t.id]||firstLine(t), client(t.clientId).name, contact(t.contactId)?.email||'', grp(t.groupId).name,
      st8(t.st).label, prio(t.prio).label, t.ownerId?agent(t.ownerId).name:'', t.tags.join('; '),
      new Date(t.createdAt).toISOString(), new Date(t.updatedAt).toISOString(), fmtHours(timeTotal(t)),
      sla? new Date(sla.due).toISOString():'', sla? (sla.breached?'YES':'no'):'' ]);
  });
  return data;
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
function viewTicket(){
  const t = tk(state.ticketId);
  if(!t || !ticketVisible(t)) return `<div class="empty">${icon(IC.ticket)}<div>Ticket not found in your scope.</div></div>`;
  const c = client(t.clientId), p = contact(t.contactId);
  const canWork = can('reply')||can('note');
  const closedNote = t.st==='closed' ? `<div class="notice lock" style="margin-bottom:14px">${icon(IC.audit)}<div><b>Closed.</b> A customer reply re-opens it automatically; its logged time is already priced in Ledger${can('see_billing')?' and locks with the billing period':''}.</div></div>` : '';

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
             ${can('edit_props')||t.ownerId===state.meId?`<button class="rowbtn" onclick="state.editTitle=${t.id};render()" title="Rename — audited">Edit</button>`:''}
             ${can('edit_props')&&!t.mergedInto?`<button class="rowbtn" onclick="mergeModal(${t.id})" title="Move this whole ticket into another">Merge…</button><button class="rowbtn" onclick="linkModal(${t.id})" title="Two-way related link">Link…</button><button class="rowbtn" onclick="childModal(${t.id})" title="Make another ticket a child of this one">Add child…</button>`:''}</h2>`}
      <div class="cell-meta" style="margin-top:3px">${stateChip(t)} &nbsp;${prioTag(t.prio)} &nbsp;<span class="mini">·</span>&nbsp;
        <span class="mini">${can('view_clients')?`<a href="#" onclick="openClient('${c.id}');return false" style="text-decoration:none;border-bottom:1px dotted var(--ink-3)">${esc(c.name)}</a>`:esc(c.name)} · ${esc(p?.name||'')} &lt;${esc(p?.email||'')}&gt;</span>
        ${t.tags.includes(VERIFIED_TAG)?`&nbsp;<span class="chip st-solved" title="Identity verified via one-time code — see the thread"><span class="cdot"></span>Verified</span>`:''}</div>
    </div>
    ${slaInfo(t)? `<div style="padding-top:6px">${slaCell(t)}</div>`:''}
  </div>
  ${closedNote}
  <div class="tk-layout">
    <div>
      ${isProj(t)? projChecklistCard(t) : ''}
      <div class="card" style="padding:4px 18px">
        <div class="thread">${t.articles.map(a=>renderArt(t,a)).join('')}</div>
      </div>
      ${projLocked(t)? `<div class="notice lock" style="margin-top:14px">${icon(IC.seal)}<div><b>Approved &amp; locked.</b> This project ticket is immutable — no notes, replies, time or property changes.${can('approve_projects')?' Use <b>Unlock (admin)</b> on the checklist card if something genuinely needs fixing.':' An admin can unlock it if something genuinely needs fixing.'}</div></div>`
        : canWork? renderComposer(t) : `<div class="notice lock" style="margin-top:14px">${icon(IC.shield)}<div>Your role can view this ticket but not respond. Ask a dispatcher or admin if that looks wrong.</div></div>`}
    </div>
    ${renderProps(t)}
  </div>`;
}

function renderArt(t,a){
  if(a.kind==='sys') return `<div class="art sys"><div class="art-sysline"><span class="sdot"></span><span>${esc(a.body)}</span><span class="sts">${fmtDT(a.ts)}</span></div></div>`;
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
  const noteActions = mayAttach
    ? `<span style="margin-left:auto;display:inline-flex;gap:6px">
         <button class="rowbtn" onclick="attachTime(${t.id},'${a.id}')" title="Attach a time entry — starts as a 15-min span ending at this ${a.kind==='reply'?'email':'note'}'s timestamp; adjust it inline">+ time</button></span>`
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
      <div class="art-top" style="display:flex;align-items:center;gap:8px"><b>${esc(a.author.name)}</b>${kindLab}${noteActions}<span class="art-ts">${fmtDT(a.ts)}</span></div>
      ${bodyHtml}
      ${a.atts&&a.atts.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${a.atts.map(f=>`<span class="chip" style="background:#eef2f1;cursor:pointer" onclick="attOpen('${f.id||''}')" title="${esc(f.type)}">📎 ${esc(f.name)} <span class="mini muted">${fmtKB(f.size)}</span></span>`).join('')}</div>`:''}
      ${timeChip}
    </div>
  </div>`;
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
      e.eid=d.id; });                            /* edits now mirror; hydrate relinks later */
}

function editTimeEntry(tid, i, k, v, srcEl){
  const t = tk(tid), e = t.time[i]; if(!e) return;
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
function addTag(tid){
  if(!can('edit_props')||projLocked(tk(tid))) return;
  const t=tk(tid); const v=prompt('Tag'); if(!v) return;
  const before=t.tags.slice();
  t.tags.push(v.toLowerCase().replace(/\s+/g,'-'));
  log('Tag added',`#${t.id} · ${v}`); render();
  const add=t.tags.filter(x=>!before.includes(x));
  if(!add.length) return;                        /* duplicate — nothing new to mirror */
  $fetch('/api/tickets/'+tid+'/tags',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({add,remove:[]})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
function rmTag(tid,i){
  if(!can('edit_props')||projLocked(tk(tid))) return;
  const t=tk(tid); const before=t.tags.slice();
  log('Tag removed',`#${t.id} · ${t.tags[i]}`); t.tags.splice(i,1); render();
  const rem=before.filter(x=>!t.tags.includes(x));
  if(!rem.length) return;                        /* a twin remains — nothing to mirror */
  $fetch('/api/tickets/'+tid+'/tags',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({add:[],remove:rem})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
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
