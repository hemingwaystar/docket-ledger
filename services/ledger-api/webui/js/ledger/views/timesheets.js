/* ==========================================================================
   Ledger — views/timesheets.js
   The Timesheets page: every logged entry (scoped by RBAC), filterable by
   period / client / tech / type / status / search, with row-level classify,
   start-end time editing, and batch submit / recall / remove-in-Docket.
   Also owns the state.tf filter setters (setTF/tsPreset/tsClear).
   client / tech / type / status filters are multi-select ARRAYS (empty =
   all; setTF toggles membership, 'all'/null clears); q / from / to stay
   scalar. Values never leave the browser — filtering is client-side only.
   Endpoints called here:
     PATCH /api/entries/{id}          — classify() {activity_type},
                                        saveTime() {started_at, ended_at},
                                        applyDeleteSelected() {void, void_reason}
     POST  /api/entries/{id}/submit   — applySubmitSelected(), per entry
     POST  /api/entries/{id}/recall   — recallSelected(), per entry
   Invariant: every mutation applies locally first, then mirrors to the
   server ONLY when local state actually changed — a locally-refused click
   (toast) must never reach the server. Server refusal → oops() (alert +
   rehydrate).
   ========================================================================== */

/* ---- filters ---- */
const TF_ARR=['client','tech','status','type'];   /* multi-select keys — empty array = all */
function setTF(k,v){
  if(TF_ARR.includes(k)){
    _mfNorm(state.tf,TF_ARR);
    if(v==null||v==='all') state.tf[k]=[];
    else { const a=state.tf[k], i=a.indexOf(v); if(i>=0) a.splice(i,1); else a.push(v); }
    render(); return;
  }
  state.tf[k]=v; if(k!=='q') render(); else { /* keep focus on search */ softRerender(); }
}
function tsPreset(p){ _presetDates(state.tf,p); render(); }
function tsClear(){ const sel=state.tf.sel, exp=state.tf.expanded; state.tf={client:[],tech:[],status:[],type:[],q:'',from:'',to:'',expanded:exp,sel:sel,_vis:[]}; render(); }
function toggleExpand(id){ state.tf.expanded = state.tf.expanded===id?null:id; render(); }

function viewTimesheets(){
  const f=_mfNorm(state.tf,TF_ARR), admin=isAdmin(), showMoney=canSeeMoney();
  let rows=scopedEntries().slice().sort((a,b)=>b.startedAt-a.startedAt);
  const [tfFrom,tfTo]=_dateRange(f);
  rows=rows.filter(e=>e.startedAt>=tfFrom && e.startedAt<=tfTo);
  /* every multi-select predicate is any-of; empty = no constraint */
  if(f.client.length) rows=rows.filter(e=>f.client.includes(e.clientId));
  if(admin && f.tech.length) rows=rows.filter(e=>f.tech.includes(e.techId));
  if(f.type.length) rows=rows.filter(e=>{const t=atype(e.typeId);
    return f.type.some(v=> v==='billable'?(t.billable&&!t.sentinel)
      : v==='nonbill'?(!t.billable&&!t.sentinel)
      : v==='unclassified'?t.sentinel : e.typeId===v);});
  if(f.status.length){
    rows=rows.filter(e=> f.status.some(s=> s==='void'?e.status==='void'
      : s==='locked'?(isLocked(e)&&e.status!=='void')
      : s==='approved'?(e.tsApproved&&!isLocked(e)&&e.status!=='void')
      : s==='submitted'?(e.submitted&&!e.tsApproved&&!isLocked(e)&&e.status!=='void')
      : (e.status==='pending'&&!isLocked(e)&&!e.submitted)));
  }
  if(f.q){ const q=f.q.toLowerCase(); rows=rows.filter(e=> (e.ticketTitle+e.content+client(e.clientId).name+tech(e.techId).name).toLowerCase().includes(q)); }

  let sumH=0,sumA=0; rows.forEach(e=>{const p=priced(e); if(e.status!=='void'){sumH+=p.h; sumA+=p.amount;}});

  const statuses = admin ? ['all','pending','submitted','approved','locked','void'] : ['all','pending','submitted','approved','locked'];
  const anyFilter = f.from||f.to||f.client.length||(admin&&f.tech.length)||f.type.length||f.status.length||f.q;
  /* archived types stay out of the options unless currently selected (row 37) */
  const typeSel=multiCombo('tfType',
    [{v:'billable',label:'Billable'},{v:'nonbill',label:'Non-billable'},{v:'unclassified',label:'Unclassified'},
     ...state.types.filter(t=>!t.sentinel&&(t.active!==false||f.type.includes(t.id))).map(t=>({v:t.id,label:t.name+(t.active===false?' (archived)':'')}))],
    f.type, function(v){ setTF('type',v); }, 'All types');
  const toolbar=`
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:13px">
    <div class="rpt-line"><span class="rpt-lab">Period</span>
      <div class="seg">
        <button onclick="tsPreset('7d')">Last 7 days</button>
        <button onclick="tsPreset('30d')">Last 30 days</button>
        <button onclick="tsPreset('90d')">Last 90 days</button>
        <button onclick="tsPreset('thismonth')">This month</button>
        <button onclick="tsPreset('all')">All time</button>
      </div>
      <label class="mini" style="display:flex;align-items:center;gap:6px">from <input type="date" value="${f.from||''}" onchange="setTF('from',this.value)"></label>
      <label class="mini" style="display:flex;align-items:center;gap:6px">to <input type="date" value="${f.to||''}" onchange="setTF('to',this.value)"></label>
    </div>
    <div class="rpt-line"><span class="rpt-lab">Filters</span>
      <div class="search">${icon(IC.search)}<input type="text" placeholder="Search ticket, note, client${admin?', tech':''}…" value="${esc(f.q)}" data-fkey="tf-q" oninput="setTF('q',this.value)"></div>
      <span style="display:inline-block;min-width:200px;vertical-align:middle">${multiCombo('tfClient', state.clients.filter(c=>!c.archivedInDocket||f.client.includes(c.id)).map(c=>({v:c.id,label:c.name+(c.archivedInDocket?' (archived)':'')})), f.client, function(v){ setTF('client',v); }, 'All clients')}</span>
      ${admin?`<span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('tfTech', state.techs.map(t=>({v:t.id,label:t.name})), f.tech, function(v){ setTF('tech',v); }, 'All techs')}</span>`:''}
      <span style="display:inline-block;min-width:170px;vertical-align:middle">${typeSel}</span>
      <div class="seg wrap">${statuses.map(s=>`<button class="${s==='all'?(f.status.length?'':'on'):(f.status.includes(s)?'on':'')}" onclick="setTF('status','${s}')">${s[0].toUpperCase()+s.slice(1)}</button>`).join('')}</div>
      ${anyFilter?`<button class="btn sm ghost" onclick="tsClear()">Clear</button>`:''}
    </div>
    <div class="rpt-line"><span class="rpt-lab">Showing</span><div class="mini">${rows.length} entr${rows.length===1?'y':'ies'} · <span class="tape">${fmtHours(sumH)}</span> h${showMoney?` · <span class="tape" style="font-weight:600;color:var(--ink)">${fmtMoney(sumA)}</span>`:''}</div></div>
  </div></div>`;

  const hint = admin ? '' : `<div class="notice info" style="margin:14px 0">${icon(IC.sheet)}<div>This is <b>your</b> time only. Classify each entry, then tick the ones you’ve finished and <b>Submit for review</b> — your timesheet administrator approves and bills from there. Once submitted or approved, an entry locks so the record stays accurate.</div></div>`;

  if(rows.length===0){ f._vis=[]; return toolbar+hint+`<div class="section-gap"></div><div class="card"><div class="empty">${icon(IC.sheet)}<div>No entries match these filters.</div></div></div>`; }

  // checkbox acts on any live (non-void, non-deleted) row; which actions are
  // offered depends on the signed-in person's permissions.
  const eligible = rows.filter(e=> e.status!=='void' && !e.zDeleted);
  /* selections survive paging: prune against the FULL filtered eligible set… */
  const eligibleIds = new Set(eligible.map(e=>e.id));
  Object.keys(f.sel).forEach(id=>{ if(!eligibleIds.has(id)) delete f.sel[id]; });
  const pg = paginate('timesheets', rows);
  /* …but 'Select all shown' (header checkbox + toggleSelAll via _vis) acts on
     the CURRENT PAGE only, so the checkbox never lies about what it toggles */
  const pageEligible = pg.slice.filter(e=> e.status!=='void' && !e.zDeleted);
  f._vis = pageEligible.map(e=>e.id);
  const selCount = Object.keys(f.sel).length;
  const allChecked = pageEligible.length>0 && pageEligible.every(e=>f.sel[e.id]);

  let selBar='';
  if(selCount){
    const sel=Object.keys(f.sel).map(id=>state.entries.find(e=>e.id===id)).filter(Boolean);
    const anySubmit=sel.some(canSubmitEntry), anyRecall=sel.some(canRecallEntry);
    const acts=[`<button class="btn sm" onclick="clearSel()">Clear</button>`];
    if(anyRecall) acts.push(`<button class="btn sm" onclick="recallSelected()">Recall</button>`);
    if(anySubmit) acts.push(`<button class="btn primary sm" onclick="confirmSubmitSelected()">Submit for review</button>`);
    acts.push(`<button class="btn danger sm" onclick="confirmDeleteSelected()" title="Remove the shared time entry on the Docket side">Delete in Docket</button>`);
    const okStyle = anySubmit||anyRecall;
    selBar = `<div class="selbar ${okStyle?'ok':''}">
      ${icon(okStyle?IC.check:IC.warn)}<div><b>${selCount}</b> selected</div>
      <div class="spacer"></div>${acts.join('')}
    </div>`;
  }

  const colCount = showMoney ? 8 : 7;
  const body = pg.slice.map(e=>{
    const c=client(e.clientId), t=tech(e.techId), p=priced(e), locked=isLocked(e), voided=e.status==='void';
    const cls = voided?'void':(locked?'locked-row':'');
    const canAct = !voided && !e.zDeleted;
    const editable = canEditEntry(e);
    const start=new Date(e.startedAt), end=new Date(e.endedAt);
    const main=`
      <tr class="${cls} ${f.sel[e.id]?'sel-row':''}">
        <td class="selcell">${canAct?`<input type="checkbox" class="rowchk" ${f.sel[e.id]?'checked':''} onclick="toggleSel('${e.id}',this.checked)" title="${admin?'Select to delete in Docket':'Select to submit for review'}">`:''}</td>
        <td class="primary-cell">
          <div class="cell-title">${esc(e.ticketTitle)}</div>
          <div class="cell-meta">${esc(c.name)} · #${e.zTicket}${e.zTask?' · <span title="Project task">'+esc(e.zTask.label)+'</span>':''}${admin?' · '+esc(t.name):''}${(!e.submitted&&e.returnedBy)?' · <span style="color:var(--warn);font-weight:600">returned</span>':''}${e.zDeleted?' · <span style="color:var(--void)">removed in Docket</span>':''}</div>
        </td>
        <td>${classifyControl(e)}</td>
        <td>
          <div class="time-cell"><b>${fmtTime(start)}</b> → <b>${fmtTime(end)}</b></div>
          <div class="cell-meta">${fmtDate(start)}</div>
        </td>
        <td class="num" style="font-weight:600">${fmtHours(p.h)}</td>
        ${showMoney?`<td class="num">${p.billable?fmtMoney(p.amount):'<span class="muted">—</span>'}</td>`:''}
        <td>${statusChip(e)}</td>
        <td class="right"><button class="rowbtn" onclick="toggleExpand('${e.id}')">${state.tf.expanded===e.id?'Hide':'Open'}</button></td>
      </tr>`;
    if(state.tf.expanded!==e.id) return main;
    const exp=`
      <tr class="expand"><td colspan="${colCount}"><div class="expand-inner">
        <div class="note-body">${esc(e.content)}</div>
        <div class="kv">
          <div><div class="k">Client</div><div class="v">${esc(c.name)}</div></div>
          <div><div class="k">Technician</div><div class="v">${esc(t.name)}</div></div>
          <div><div class="k">Activity</div><div class="v">${esc(atype(e.typeId).name)}</div></div>
          ${showMoney?`<div><div class="k">Rate</div><div class="v tape">${p.billable?fmtMoney(p.rate)+'/h':'—'}</div></div>`:''}
          <div><div class="k">Start</div><div class="v tape">${fmtStamp(e.startedAt)}</div></div>
          <div><div class="k">End</div><div class="v tape">${fmtStamp(e.endedAt)}</div></div>
          <div><div class="k">Docket</div><div class="v tape">entry #${e.zEntryId}${e.zArticleId?` · note #${e.zArticleId}`:''}</div>
            <button class="btn sm ghost" style="margin-top:6px" onclick="openInDocket(${e.zTicket})">Open ticket #${e.zTicket} in Docket ↗</button></div>
          <div><div class="k">Submitted</div><div class="v">${e.submitted?fmtStamp(e.submittedAt||e.createdAt):'<span class="muted">not yet</span>'}</div></div>
          <div><div class="k">Timesheet approval</div><div class="v">${e.tsApproved?fmtStamp(e.tsApprovedAt)+(e.tsApprovedBy?' · '+esc(e.tsApprovedBy):''):'<span class="muted">not yet</span>'}</div></div>
        </div>
        ${editable?`<div class="edit-time">
          <div class="mini" style="font-weight:600;margin-bottom:2px">Adjust time &amp; date</div>
          <div class="mini muted" style="margin-bottom:8px">Changes re-price this entry and, once saved, are written straight to the shared time record Docket reads.</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <label class="mini muted">Start<br><input type="datetime-local" id="st-${e.id}" min="2020-01-01T00:00" max="2027-12-31T23:59" value="${localDT(e.startedAt)}" style="margin-top:4px"></label>
            <label class="mini muted">End<br><input type="datetime-local" id="en-${e.id}" min="2020-01-01T00:00" max="2027-12-31T23:59" value="${localDT(e.endedAt)}" style="margin-top:4px"></label>
            <button class="btn sm primary" onclick="saveTime('${e.id}')">Save time &amp; date</button>
          </div>
        </div>`:''}
        ${locked?`<div style="margin-top:12px"><div class="notice lock">${icon(IC.lock)}<div>This entry’s billing period is approved and locked. It is immutable and can’t be edited or deleted.</div></div></div>`:''}
        ${(!locked&&!e.submitted&&e.returnedBy)?`<div style="margin-top:12px"><div class="notice warn">${icon(IC.warn)}<div><b>Returned by ${esc(e.returnedBy)}</b> ${e.returnedAt?fmtStamp(e.returnedAt):''}${e.returnReason?` — “${esc(e.returnReason)}”`:' — no note given'}. Fix it up and submit again.</div></div></div>`:''}
        ${(!locked&&e.tsApproved)?`<div style="margin-top:12px"><div class="notice info">${icon(IC.seal)}<div>Timesheet approved${e.tsApprovedBy?' by '+esc(e.tsApprovedBy):''} — this entry is frozen until the billing period locks.${admin?' Revoke on the Approvals page to reopen it.':''}</div></div></div>`
        :(!locked&&e.submitted)?`<div style="margin-top:12px"><div class="notice info">${icon(IC.check)}<div>Submitted for review${admin?'':' — waiting on your administrator to approve. You can still recall it until then.'}</div></div></div>`:''}
        ${e.zDeleted?`<div style="margin-top:12px"><div class="notice ${voided?'void-n':'warn'}" style="${voided?'background:var(--void-wash);color:var(--void);border:1px solid #e6cccc':''}">${icon(IC.warn)}<div>${voided?'The time entry was removed in Docket after logging. This ledger row is retained and voided (not billed) — the removal is recorded in the audit log.':'The time entry was removed in Docket after this period was locked. The billed entry is retained unchanged (approved periods are immutable); the removal is recorded in the audit log.'}</div></div></div>`:''}
      </div></td></tr>`;
    return main+exp;
  }).join('');

  return toolbar + hint + `<div class="section-gap"></div>` + selBar + `<div class="card"><table class="tbl">
    <thead><tr><th class="selcell"><input type="checkbox" ${allChecked?'checked':''} onclick="toggleSelAll(this.checked)" title="Select all shown"></th><th>Ticket / client${admin?' / tech':''}</th><th>Activity type</th><th>Time · date</th><th class="num">Hours</th>${showMoney?'<th class="num">Amount</th>':''}<th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody></table>${pagerBar(pg)}</div>`;
}

/* ---- row selection ---- */
function toggleSel(id,checked){ if(checked) state.tf.sel[id]=true; else delete state.tf.sel[id]; render(); }
function toggleSelAll(checked){ (state.tf._vis||[]).forEach(id=>{ if(checked) state.tf.sel[id]=true; else delete state.tf.sel[id]; }); render(); }
function clearSel(){ state.tf.sel={}; render(); }
function selectedEntries(){ return Object.keys(state.tf.sel).map(id=>state.entries.find(e=>e.id===id)).filter(e=>e && !e.zDeleted && e.status!=='void'); }

/* ---- classify ---- */
function classifyControl(e){
  const t=atype(e.typeId), locked=isLocked(e), voided=e.status==='void';
  const chip = t.sentinel
    ? `<span class="chip unclassified"><span class="cdot"></span>Unclassified</span>`
    : `<span class="chip ${t.billable?'billable':'nonbill'}"><span class="cdot"></span>${esc(t.name)}</span>`;
  // editable only if the signed-in person's permissions allow editing this entry
  const frozen = !canEditEntry(e);
  if(frozen) return chip;
  return `<div class="classify">
    <button class="rowbtn classify-btn" onclick="openClassify('${e.id}',event)">${chip}${icon(IC.caret,'caret')}</button>
    <div class="menu" id="menu-${e.id}">
      ${state.types.filter(a=>a.active).map(a=>`
        <button class="menu-item" onclick="classify('${e.id}','${a.id}')">
          <span class="cdot" style="width:7px;height:7px;border-radius:50%;background:${a.sentinel?'var(--warn)':a.billable?'var(--billable)':'var(--ink-3)'}"></span>
          <span class="mt">${esc(a.name)}</span>
          <span class="rate" title="${a.rateHist&&a.rateHist.length?('Rate history: '+a.rateHist.map(h=>h.from.slice(0,10)+' → '+fmtMoney(h.rate)).join(' · ')):''}">${a.sentinel?'—':a.billable?fmtMoney(a.rate)+'/h':'no charge'}${a.rateHist&&a.rateHist.length>1?' <span class="mini muted">· dated</span>':''}</span>
        </button>`).join('')}
    </div></div>`;
}
function classify(id,typeId){
  const e=state.entries.find(x=>x.id===id); if(!e||isLocked(e)) return;
  const was=e.typeId;
  const from=atype(e.typeId).name, to=atype(typeId).name;
  e.typeId=typeId; closeMenus();
  log(atype(typeId).sentinel?'Marked unclassified':'Classified', `${esc(client(e.clientId).name)} · #${e.zTicket}: ${from} → ${to}`, e.id);
  toast(`Classified as ${to}`); render();
  if(e.typeId===was||!srvId(id)) return;
  const ty=state.types.find(t=>t.id===e.typeId);
  $fetch('/api/entries/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({activity_type:ty?ty.name:e.typeId})})
    .then(async r=>{ if(!r.ok) oops(await r.json().catch(()=>0)); });
}

/* ---- technician: submit / recall selected own entries ---- */
function confirmSubmitSelected(){
  const ents=Object.keys(state.tf.sel).map(id=>state.entries.find(e=>e.id===id))
    .filter(e=>e && !e.submitted && !isLocked(e) && e.status!=='void' &&
       ((e.techId===state.myTechId && can('submit')) || can('edit_all')&&can('submit')));
  if(!ents.length){ toast('Nothing new to submit'); return; }
  const unclassified=ents.filter(e=>atype(e.typeId).sentinel);
  const rowsHtml=ents.map(e=>{const c=client(e.clientId),u=atype(e.typeId).sentinel;
    return `<tr><td><div class="cell-title" style="font-weight:500">${esc(e.ticketTitle)}</div><div class="cell-meta">${esc(c.name)} · #${e.zTicket}</div></td><td class="num">${fmtHours(e.hours)} h</td><td>${u?'<span class="chip unclassified slim"><span class="cdot"></span>needs a type</span>':'<span class="chip billable slim"><span class="cdot"></span>ready</span>'}</td></tr>`;}).join('');
  const blocked = unclassified.length>0;
  openModal(`<div class="modal-head"><h3>Submit ${ents.length} ${ents.length===1?'entry':'entries'} for review</h3><p>Your administrator will review and bill these. You can recall them until they’re approved.</p></div>
    <div class="modal-body">
      <table class="tbl" style="margin:0"><thead><tr><th>Entry</th><th class="num">Hours</th><th>State</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      ${blocked?`<div class="notice warn" style="margin-top:14px">${icon(IC.warn)}<div><b>${unclassified.length}</b> ${unclassified.length===1?'entry has':'entries have'} no activity type yet. Classify ${unclassified.length===1?'it':'them'} before submitting — un-typed time can’t be reviewed.</div></div>`
        :`<div class="notice info" style="margin-top:14px">${icon(IC.check)}<div>All classified and ready to submit.</div></div>`}
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button>${blocked?'':`<button class="btn primary" onclick="applySubmitSelected()">Submit for review</button>`}</div>`);
}
function applySubmitSelected(){
  const ents=Object.keys(state.tf.sel).map(id=>state.entries.find(e=>e.id===id))
    .filter(e=>e && !e.submitted && !isLocked(e) && e.status!=='void' && !atype(e.typeId).sentinel &&
       ((e.techId===state.myTechId && can('submit')) || can('edit_all')&&can('submit')));
  closeModal();
  ents.forEach(e=>{ e.submitted=true; e.submittedAt=Date.now();
    e.returnedBy=null; e.returnedAt=null; e.returnReason=null;
    log('Submitted for review',`${esc(client(e.clientId).name)} · #${e.zTicket} · ${fmtHours(e.hours)} h — submitted by ${esc(myName())}`,e.id); });
  state.tf.sel={};
  toast(`${ents.length} ${ents.length===1?'entry':'entries'} submitted for review`);
  render();
  const done=ents.filter(e=>srvId(e.id));
  if(!done.length) return;
  Promise.all(done.map(e=>$fetch('/api/entries/'+e.id+'/submit',{method:'POST'})))
    .then(async rs=>{ const bad=rs.find(r=>!r.ok);
      if(bad) return oops(await bad.json().catch(()=>0));
      setTimeout(hydrate,600); });
}
function recallSelected(){
  const ents=Object.keys(state.tf.sel).map(id=>state.entries.find(e=>e.id===id)).filter(e=>e && canRecallEntry(e));
  if(!ents.length){ toast('Nothing to recall'); return; }
  ents.forEach(e=>{ e.submitted=false; e.submittedAt=null;
    log('Recalled submission',`${esc(client(e.clientId).name)} · #${e.zTicket} — pulled back for edits by ${esc(myName())}`,e.id); });
  state.tf.sel={};
  toast(`${ents.length} ${ents.length===1?'entry':'entries'} recalled — editable again`);
  render();
  const done=ents.filter(e=>srvId(e.id));
  if(!done.length) return;
  Promise.all(done.map(e=>$fetch('/api/entries/'+e.id+'/recall',{method:'POST'})))
    .then(async rs=>{ const bad=rs.find(r=>!r.ok);
      if(bad) return oops(await bad.json().catch(()=>0));
      setTimeout(hydrate,600); });
}

/* ---- remove in Docket: void here, remove the shared record there ---- */
function confirmDeleteSelected(){
  const ents=selectedEntries();
  if(!ents.length){ toast('Nothing selected to delete'); return; }
  const rowsHtml=ents.map(e=>{const c=client(e.clientId),lk=isLocked(e);
    return `<tr><td><div class="cell-title" style="font-weight:500">${esc(e.ticketTitle)}</div><div class="cell-meta">${esc(c.name)} · #${e.zTicket}</div></td><td class="num">${fmtHours(e.hours)} h</td><td>${lk?'<span class="chip approved slim"><span class="cdot"></span>kept · locked</span>':'<span class="chip void slim"><span class="cdot"></span>voided</span>'}</td></tr>`;}).join('');
  const nLock=ents.filter(e=>isLocked(e)).length, nOpen=ents.length-nLock;
  openModal(`<div class="modal-head"><h3>Remove ${ents.length} time ${ents.length===1?'entry':'entries'} in Docket</h3><p>Removes ${ents.length===1?'this entry':'these entries'} on the Docket side. Review the outcome, then confirm.</p></div>
    <div class="modal-body">
      <table class="tbl" style="margin:0"><thead><tr><th>Entry</th><th class="num">Hours</th><th>Result</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      <div class="notice ${nLock?'lock':'warn'}" style="margin-top:14px">${icon(nLock?IC.lock:IC.warn)}<div>${nOpen?`<b>${nOpen}</b> in an open period → <b>voided</b> (not billed) but retained. `:''}${nLock?`<b>${nLock}</b> in a locked period → billed entry <b>kept unchanged</b> (immutable). `:''}Every deletion is written to the audit log.</div></div>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" onclick="applyDeleteSelected()">Remove in Docket</button></div>`);
}
function applyDeleteSelected(){
  const ents=selectedEntries(); closeModal();
  const voided=[];
  ents.forEach(e=>{
    e.zDeleted=true;
    notifyDocket({ type:'entry-removed', ticket:e.zTicket, techId:e.techId, typeId:e.typeId, h:e.hours, eid:(window._docketRev||{})[e.id]||null });
    if(isLocked(e)){
      log('Removed in Docket (locked)',`${esc(client(e.clientId).name)} · #${e.zTicket}: entry #${e.zEntryId} removed in Docket after approval — billed entry retained (immutable)`,e.id);
    } else {
      e.status='void'; e.voidedAt=Date.now(); e.voidReason='Removed in Docket';
      voided.push(e);
      log('Voided (removed in Docket)',`${esc(client(e.clientId).name)} · #${e.zTicket}: entry #${e.zEntryId} removed in Docket — ledger row voided (not billed), retained for audit`,e.id);
    }
  });
  state.tf.sel={};
  toast(`${ents.length} ${ents.length===1?'entry':'entries'} removed in Docket — audited`);
  if(state.view!=='timesheets') go('timesheets'); else render();
  const done=voided.filter(e=>srvId(e.id));
  if(!done.length) return;
  Promise.all(done.map(e=>$fetch('/api/entries/'+e.id,{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({void:true,void_reason:'removed in Ledger'})})))
    .then(async rs=>{ const bad=rs.find(r=>!r.ok);
      if(bad) return oops(await bad.json().catch(()=>0));
      setTimeout(hydrate,600); });
}

/* ---- edit an entry's start/end (and therefore date + duration) ---- */
function localDT(ms){ const d=new Date(ms), p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); }
function saveTime(id){
  const e=state.entries.find(x=>x.id===id); if(!e) return;
  if(!canEditEntry(e)){ toast('You can’t edit this entry'); return; }
  const st=document.getElementById('st-'+id), en=document.getElementById('en-'+id);
  if(!st||!en||!st.value||!en.value){ toast('Enter both a start and end'); return; }
  const s=new Date(st.value).getTime(), n=new Date(en.value).getTime();
  const _oldH=e.hours;
  if(!(n>s)){ toast('End must be after start'); return; }
  const per=periodFor(client(e.clientId).cycle, s);
  if(periodState(e.clientId,per.key).status!=='open'){ toast('That date falls in an approved period — pick another'); return; }
  const was={s:e.startedAt,en:e.endedAt};
  e.startedAt=s; e.endedAt=n; e.hours=Math.round((n-s)/3600000*100)/100;
  log('Time edited',`${esc(client(e.clientId).name)} · #${e.zTicket} → ${fmtDate(s)} ${fmtTime(s)}–${fmtTime(n)} · ${fmtHours(e.hours)} h`+(e.zEntryId?' · Docket record updated':''),e.id);
  notifyDocket({ type:'entry-updated', ticket:e.zTicket, techId:e.techId, typeId:e.typeId, oldH:_oldH, h:e.hours, startedAt:e.startedAt, endedAt:e.endedAt, eid:(window._docketRev||{})[e.id]||null });
  toast(`Updated to ${fmtHours(e.hours)} h${e.zEntryId?' — shared record updated; Docket sees it immediately':''}`);
  render();
  if((e.startedAt===was.s&&e.endedAt===was.en)||!srvId(id)) return;
  $fetch('/api/entries/'+id,{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({started_at:iso(e.startedAt),ended_at:iso(e.endedAt)})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
