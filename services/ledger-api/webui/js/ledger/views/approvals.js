/* ==========================================================================
   Ledger — views/approvals.js
   Timesheet approvals: buildTimesheets grouping, the Approvals filter set
   (setAF/afClear over state.af — AF_DEFAULTS and state.af live in state.js;
   the Audit page has its own state.auf/setAuf, never shared), and the
   approve / return / revoke actions. period / tech / group / client /
   status filters are multi-select ARRAYS (empty = all; setAF toggles
   membership, 'all'/null clears; 'expanded' stays scalar). Client-side only.
   Endpoints called here:
     POST /api/timesheets/approve      — tsApprove()
     POST /api/timesheets/return       — tsReturn() (with reason)
     POST /api/timesheets/revoke       — tsRevoke()
   Invariant: each action mutates local state first, then mirrors to the
   server ONLY when the click actually changed something — a locally-refused
   click (toast) never reaches the server. Period keys cross the boundary
   through srvPeriodKey (bug #22).
   ========================================================================== */

/* ===================== TIMESHEET APPROVALS =====================
   A "timesheet" is the bundle of one technician's live entries for one
   client in one billing period. Techs submit entries; a manager approves
   the timesheet here, which freezes those entries (revocable until the
   period itself is approved & locked). The Billing Periods page then
   reports manager approval progress instead of raw tech submission. */
function buildTimesheets(){
  const m={};
  state.entries.forEach(e=>{
    if(e.status==='void') return;
    const per=entryPeriod(e), k=e.techId+'|'+e.clientId+'|'+per.key;
    const g=m[k]||(m[k]={key:k,techId:e.techId,clientId:e.clientId,per,es:[]});
    g.es.push(e);
  });
  return Object.values(m).map(g=>{
    let h=0,amt=0,sub=0,app=0,uncl=0;
    g.es.forEach(e=>{ const p=priced(e); h+=p.h; amt+=p.amount;
      if(p.unclassified) uncl++;
      if(e.submitted||isLocked(e)) sub++;
      if(e.tsApproved||isLocked(e)) app++; });
    g.h=h; g.amt=amt; g.sub=sub; g.app=app; g.uncl=uncl; g.n=g.es.length;
    g.locked = periodState(g.clientId,g.per.key).status!=='open';
    g.status = g.locked ? 'locked'
             : g.app===g.n ? 'approved'
             : g.sub===g.n ? 'awaiting'
             : g.sub>0 ? 'partial' : 'open';
    return g;
  }).sort((a,b)=> b.per.start-a.per.start
      || client(a.clientId).name.localeCompare(client(b.clientId).name)
      || tech(a.techId).name.localeCompare(tech(b.techId).name));
}
function tsEntries(techId,clientId,perKey){
  return state.entries.filter(e=> e.status!=='void' && e.techId===techId &&
    e.clientId===clientId && entryPeriod(e).key===perKey);
}
function tsApprove(techId,clientId,perKey){
  if(!can('approve')) return;
  const es=tsEntries(techId,clientId,perKey);
  const open=es.filter(e=>!isLocked(e));
  if(open.some(e=>atype(e.typeId).sentinel)){ toast('Classify every entry before approving'); return; }
  if(open.some(e=>!e.submitted)){ toast('Not everything is submitted yet — wait for the technician or return the sheet'); return; }
  const todo=open.filter(e=>!e.tsApproved);
  if(!todo.length){ toast('Already approved'); return; }
  let h=0; todo.forEach(e=>{ e.tsApproved=true; e.tsApprovedAt=Date.now(); e.tsApprovedBy=myName(); h+=e.hours; });
  const per=periodFor(client(clientId).cycle, todo[0].startedAt);
  log('Timesheet approved', `${esc(tech(techId).name)} · ${esc(client(clientId).name)} · ${per.label} — ${todo.length} entr${todo.length===1?'y':'ies'}, ${fmtHours(h)} h — approved by ${esc(myName())}`);
  toast(`Timesheet approved — ${todo.length} entr${todo.length===1?'y':'ies'} locked from edits`);
  render();
  const t=state.techs.find(x=>x.id===techId), c=state.clients.find(x=>x.id===clientId);
  if(t&&c) post('/api/timesheets/approve',{tech_email:t.email,client:c.name,period_key:srvPeriodKey(perKey)});
}
function tsRevoke(techId,clientId,perKey){
  if(!can('approve')) return;
  const todo=tsEntries(techId,clientId,perKey).filter(e=>e.tsApproved && !isLocked(e));
  if(!todo.length){ toast('Nothing to revoke — the period may already be locked'); return; }
  todo.forEach(e=>{ e.tsApproved=false; e.tsApprovedAt=null; e.tsApprovedBy=null; });
  const per=periodFor(client(clientId).cycle, todo[0].startedAt);
  log('Timesheet approval revoked', `${esc(tech(techId).name)} · ${esc(client(clientId).name)} · ${per.label} — ${todo.length} entr${todo.length===1?'y':'ies'} back to Submitted — by ${esc(myName())}`);
  toast('Approval revoked — entries are Submitted again');
  render();
  const t=state.techs.find(x=>x.id===techId), c=state.clients.find(x=>x.id===clientId);
  if(t&&c) post('/api/timesheets/revoke',{tech_email:t.email,client:c.name,period_key:srvPeriodKey(perKey)});
}
function tsReturn(techId,clientId,perKey){
  if(!can('approve')) return;
  const todo=tsEntries(techId,clientId,perKey).filter(e=>e.submitted && !e.tsApproved && !isLocked(e));
  if(!todo.length){ toast('Nothing to return'); return; }
  const why=(prompt('Reason to return this timesheet to the technician (optional)')||'').trim();
  const at=Date.now();
  todo.forEach(e=>{ e.submitted=false; e.submittedAt=null;
    e.returnedBy=myName(); e.returnedAt=at; e.returnReason=why||null; });
  const per=periodFor(client(clientId).cycle, todo[0].startedAt);
  log('Timesheet returned', `${esc(tech(techId).name)} · ${esc(client(clientId).name)} · ${per.label} — ${todo.length} entr${todo.length===1?'y':'ies'} back to the technician${why?` — “${esc(why)}”`:''} — by ${esc(myName())}`);
  toast(`Timesheet returned to ${tech(techId).name}${why?' with a note':''}`);
  render();
  const t=state.techs.find(x=>x.id===techId), c=state.clients.find(x=>x.id===clientId);
  if(t&&c) post('/api/timesheets/return',{tech_email:t.email,client:c.name,
    period_key:srvPeriodKey(perKey),reason:why||''});
}
const AF_ARR=['tech','group','client','period','status'];   /* multi-select keys — empty array = all */
function setAF(k,v){
  if(AF_ARR.includes(k)){
    _mfNorm(state.af,AF_ARR);
    if(v==null||v==='all') state.af[k]=[];
    else { const a=state.af[k], i=a.indexOf(v); if(i>=0) a.splice(i,1); else a.push(v); }
    render(); return;
  }
  state.af[k]=v; render();
}
function afClear(){ state.af=_mfNorm(Object.assign({},AF_DEFAULTS),AF_ARR); render(); }
function viewApprovals(){
  const f=state.af=_mfNorm(Object.assign({},AF_DEFAULTS,state.af||{}),AF_ARR);
  const money=canSeeMoney();
  let sheets=buildTimesheets();
  /* period options across every cycle, newest first, value = period key */
  const perOpts=[...new Map(sheets.map(s=>[s.per.key,{key:s.per.key,label:s.per.label,start:s.per.start,cycle:client(s.clientId).cycle}])).values()]
    .sort((a,b)=>b.start-a.start);
  /* every multi-select predicate is any-of; empty = no constraint */
  if(f.tech.length)   sheets=sheets.filter(s=>f.tech.includes(s.techId));
  if(f.group.length)  sheets=sheets.filter(s=>techGroups(s.techId).some(g=>f.group.includes(g)));
  if(f.client.length) sheets=sheets.filter(s=>f.client.includes(s.clientId));
  if(f.period.length) sheets=sheets.filter(s=>f.period.includes(s.per.key));
  if(f.status.length) sheets=sheets.filter(s=>f.status.includes(s.status));
  const pg = paginate('approvals', sheets);
  const anyF=f.tech.length||f.group.length||f.client.length||f.period.length||f.status.length;
  const statuses=[['all','All'],['awaiting','Awaiting review'],['partial','Partially submitted'],['open','In progress'],['approved','Approved'],['locked','Locked']];
  const toolbar=`
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:13px">
    <div class="rpt-line"><span class="rpt-lab">Status</span>
      <div class="seg wrap">${statuses.map(([v,l])=>`<button class="${v==='all'?(f.status.length?'':'on'):(f.status.includes(v)?'on':'')}" onclick="setAF('status','${v}')">${l}</button>`).join('')}</div>
    </div>
    <div class="rpt-line"><span class="rpt-lab">Filters</span>
      <span style="display:inline-block;min-width:200px;vertical-align:middle">${multiCombo('afPeriod', perOpts.map(p=>({v:p.key,label:p.label+' ('+p.cycle+')'})), f.period, function(v){ setAF('period',v); }, 'All billing periods')}</span>
      <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('afTech', state.techs.map(t=>({v:t.id,label:t.name+(t.active===false?' (deactivated)':'')})), f.tech, function(v){ setAF('tech',v); }, 'All technicians')}</span>
      <span style="display:inline-block;min-width:160px;vertical-align:middle">${multiCombo('afGroup', state.zammadGroups.filter(g=>!g.archived||f.group.includes(g.id)).map(g=>({v:g.id,label:g.name+(g.archived?' (archived)':'')})), f.group, function(v){ setAF('group',v); }, 'All groups')}</span>
      <span style="display:inline-block;min-width:200px;vertical-align:middle">${multiCombo('afClient', state.clients.filter(c=>!c.archivedInDocket||f.client.includes(c.id)).map(c=>({v:c.id,label:c.name+(c.archivedInDocket?' (archived)':'')})), f.client, function(v){ setAF('client',v); }, 'All clients')}</span>
      ${anyF?`<button class="btn sm ghost" onclick="afClear()">Clear</button>`:''}
    </div>
    <div class="rpt-line"><span class="rpt-lab">Showing</span><div class="mini">${sheets.length} timesheet${sheets.length===1?'':'s'} · ${sheets.filter(s=>s.status==='awaiting').length} awaiting your review</div></div>
  </div></div>`;
  if(!sheets.length) return toolbar+`<div class="section-gap"></div><div class="card"><div class="empty">${icon(IC.seal)}<div>No timesheets match these filters.</div></div></div>`;
  const colCount = money?8:7;
  const body=pg.slice.map(s=>{
    const c=client(s.clientId), t=tech(s.techId);
    const gNames=techGroups(s.techId).map(gid=>{const g=state.zammadGroups.find(x=>x.id===gid); return g?g.name:gid;}).join(', ');
    let act='';
    if(s.status==='awaiting') act=`<button class="btn seal sm" onclick="event.stopPropagation();tsApprove('${s.techId}','${s.clientId}','${s.per.key}')">${icon(IC.seal)}Approve</button>
      <button class="btn sm" onclick="event.stopPropagation();tsReturn('${s.techId}','${s.clientId}','${s.per.key}')">Return</button>`;
    else if(s.status==='approved') act=`<button class="btn sm ghost" onclick="event.stopPropagation();tsRevoke('${s.techId}','${s.clientId}','${s.per.key}')">Revoke</button>`;
    else if(s.status==='partial') act=`<button class="btn sm" onclick="event.stopPropagation();tsReturn('${s.techId}','${s.clientId}','${s.per.key}')" title="Send the submitted part back so the tech finishes the sheet in one go">Return</button>`;
    else if(s.status==='locked') act=`<span class="mini muted">immutable</span>`;
    else act=`<span class="mini muted">waiting on tech</span>`;
    const main=`
      <tr style="cursor:pointer" onclick="setAF('expanded', state.af.expanded==='${s.key}'?null:'${s.key}')">
        <td><div class="cell-title">${esc(t.name)}${s.es.some(e=>e.zTask||projFor(e))?' <span class="chip nonbill" style="padding:0 7px;font-size:10px" title="Contains project time">project</span>':''}</div><div class="cell-meta">${esc(gNames||'—')}</div></td>
        <td><div class="cell-title" style="font-weight:500">${esc(c.name)}</div><div class="cell-meta" style="text-transform:capitalize">${c.cycle}</div></td>
        <td>${s.per.label}</td>
        <td class="num">${s.n}${s.uncl?` <span class="mini" style="color:var(--warn)">· ${s.uncl} uncl.</span>`:''}</td>
        <td class="num"><span class="tape">${fmtHours(s.h)}</span> h</td>
        ${money?`<td class="num" style="font-weight:600">${fmtMoney(s.amt)}</td>`:''}
        <td>${TS_STATUS_CHIP[s.status]}<div class="cell-meta" style="margin-top:2px">${s.sub}/${s.n} submitted · ${s.app}/${s.n} approved</div></td>
        <td class="right" style="white-space:nowrap">${act}</td>
      </tr>`;
    if(f.expanded!==s.key) return main;
    const lastApproved=s.es.filter(e=>e.tsApproved&&e.tsApprovedAt).sort((a,b)=>b.tsApprovedAt-a.tsApprovedAt)[0];
    const detail=s.es.slice().sort((a,b)=>a.startedAt-b.startedAt).map(e=>{
      const p=priced(e);
      return `<tr><td><div class="cell-title" style="font-weight:500">${esc(e.ticketTitle)}</div><div class="cell-meta">#${e.zTicket} · ${fmtDate(e.startedAt)}</div></td>
        <td>${atype(e.typeId).sentinel?'<span class="chip unclassified slim"><span class="cdot"></span>Unclassified</span>':esc(atype(e.typeId).name)}</td>
        <td class="num">${fmtHours(p.h)} h</td>${money?`<td class="num">${p.billable?fmtMoney(p.amount):'<span class="muted">—</span>'}</td>`:''}
        <td>${statusChip(e)}</td></tr>`; }).join('');
    return main+`<tr class="expand"><td colspan="${colCount}"><div class="expand-inner">
      <table class="tbl" style="margin:0"><thead><tr><th>Entry</th><th>Activity</th><th class="num">Hours</th>${money?'<th class="num">Amount</th>':''}<th>Status</th></tr></thead><tbody>${detail}</tbody></table>
      ${lastApproved?`<div class="mini muted" style="margin-top:10px">Approved ${fmtStamp(lastApproved.tsApprovedAt)} by ${esc(lastApproved.tsApprovedBy||'')}</div>`:''}
    </div></td></tr>`;
  }).join('');
  return toolbar+`<div class="section-gap"></div>
  <div class="notice info" style="margin-bottom:16px">${icon(IC.seal)}<div>Approving a timesheet <b>freezes its entries</b> — the technician can no longer edit or recall them (revocable here until the billing period itself is approved &amp; locked). The Billing Periods page tracks this approval, not raw submission.</div></div>
  <div class="card"><table class="tbl">
    <thead><tr><th>Technician</th><th>Client</th><th>Period</th><th class="num">Entries</th><th class="num">Hours</th>${money?'<th class="num">Amount</th>':''}<th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody></table>${pagerBar(pg)}</div>`;
}
