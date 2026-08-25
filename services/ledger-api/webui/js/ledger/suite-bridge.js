/* ==========================================================================
   Ledger — suite-bridge.js
   Live link to Docket when both run inside the suite shell. Time logged,
   edited or removed on a Docket ticket lands here instantly, through the
   same rules real entries follow (voided, never hard-deleted). All posts
   target location.origin explicitly — never '*' (fix D11). No server calls;
   the shared database is reconciled by the next hydrate.
   ========================================================================== */
window._docketMap = {};   /* docket eid → ledger entry id */
window._docketRev = {};   /* ledger entry id → docket eid */
function notifyDocket(payload){ try{ if(window.parent!==window) window.parent.postMessage(Object.assign({src:'ledger'}, payload), location.origin); }catch(e){} }
function openDirectoryInDocket(){
  if(window.parent!==window){ window.parent.postMessage({src:'ledger', type:'open-directory'}, location.origin); }
  else toast('Open the suite (suite.html) to jump between the apps.');
}
function openInDocket(ticket){
  if(window.parent!==window){ window.parent.postMessage({src:'ledger', type:'open-ticket', ticket}, location.origin); }
  else toast('Open the suite (suite.html) to jump between the apps.');
}
window.addEventListener('message', ev=>{
  /* only accept relayed messages from our own suite shell */
  if(window.parent===window || ev.source!==window.parent) return;
  const d = ev.data || {};
  if(d.src!=='docket') return;
  if(d.type==='time-logged'){
    const startedAt=new Date(d.startedAt||Date.now()).getTime();
    const e={
      id:'e'+(state.seq++), zEntryId:null, zArticleId:null, zTicket:d.ticket,
      clientId:d.clientId, techId:d.techId, ticketTitle:d.title||('Ticket #'+d.ticket),
      /* no type picked in Docket → the SENTINEL (Unclassified), never the
         prototype-era 'a0' which no hydrated type matches — that fallback
         froze every render until the next hydrate (audit) */
      typeId:d.typeId||((state.types.find(t=>t.sentinel)||{}).id||null),
      content:d.note||'Logged from Docket.',
      startedAt, endedAt:startedAt+d.h*3600000, hours:Math.round(d.h*100)/100,
      status:'pending', source:'docket-live', createdAt:Date.now(),
      voidedAt:null, voidReason:null, zDeleted:false,
      submitted:false, submittedAt:null,
      tsApproved:false, tsApprovedAt:null, tsApprovedBy:null,
      returnedBy:null, returnedAt:null, returnReason:null,
      zTask:null
    };
    state.entries.push(e);
    if(d.startedAt && d.endedAt){ e.startedAt=d.startedAt; e.endedAt=d.endedAt; e.hours=Math.round((d.endedAt-d.startedAt)/36000)/100; }
    if(d.task) e.zTask = { id:d.task.id, label:d.task.label };
    if(d.eid){ window._docketMap[d.eid] = e.id; window._docketRev[e.id] = d.eid; }
    log('Entry received from Docket', `${client(d.clientId)?.name||d.clientId} · #${d.ticket}: ${fmtHours(d.h)} h · ${atype(e.typeId)?.name||e.typeId} — arrived live over the shared database`, e.id);
    toast(`⚡ ${fmtHours(d.h)} h just landed from Docket ticket #${d.ticket}.`);
    render();
    /* swap the local ghost for the REAL server row promptly: until the
       hydrate lands, every action on the ghost is a guarded no-op (audit).
       Delay generously — Docket's POST (behind attachment staging) must
       commit first or the hydrate briefly wipes the ghost with nothing to
       replace it; the focus rehydrate heals any residual race. */
    setTimeout(()=>{ try{ hydrate(); }catch(_e){} }, 2500);
  }
  const findByHeuristic = ()=> state.entries.find(x=> x.zTicket===d.ticket && x.techId===d.techId
      && x.status!=='void' && !x.zDeleted && Math.abs(x.hours-(d.oldH!=null?d.oldH:d.h))<0.011);
  if(d.type==='time-updated'){
    const id = window._docketMap[d.eid]; let e = id && state.entries.find(x=>x.id===id);
    if(!e) e = findByHeuristic();
    if(!e) return;
    if(e.status==='approved' || e.status==='locked' || isLocked(e) || e.tsApproved){
      log('Docket edit refused (locked)', `#${e.zTicket}: the ${e.tsApproved?'manager-approved':'billed'} entry is immutable — Docket change recorded but not applied`, e.id);
    } else {
      const was = e.hours;
      if(d.startedAt) e.startedAt = d.startedAt;
      if(d.endedAt) e.endedAt = d.endedAt;
      if(d.startedAt||d.endedAt) e.periodKey=null;   /* server re-homes (0042) — drop the stale key */
      e.hours = d.h; if(!d.endedAt) e.endedAt = e.startedAt + d.h*3600000;
      if(d.typeId) e.typeId = d.typeId;
      if(d.task!==undefined) e.zTask = d.task? { id:d.task.id, label:d.task.label } : null;
      log('Time edited in Docket', `${client(e.clientId)?.name} · #${e.zTicket}: ${fmtHours(was)} h → ${fmtHours(d.h)} h · ${atype(e.typeId)?.name}`, e.id);
      toast(`⚡ Docket updated #${e.zTicket} — now ${fmtHours(d.h)} h.`);
    }
    render();
  }
  if(d.type==='time-removed'){
    const id = window._docketMap[d.eid]; let e = id && state.entries.find(x=>x.id===id);
    if(!e) e = findByHeuristic();
    if(!e) return;
    if(e.status==='approved' || e.status==='locked' || isLocked(e) || e.tsApproved){
      log('Removed in Docket (locked)', `#${e.zTicket}: ${e.tsApproved?'manager-approved':'billed'} entry retained (immutable); removal recorded`, e.id);
    } else {
      e.status='void'; e.voidedAt=Date.now(); e.voidReason='Removed in Docket';
      log('Voided (removed in Docket)', `${client(e.clientId)?.name} · #${e.zTicket}: ledger row voided (not billed), retained for audit`, e.id);
      toast(`⚡ Docket removed an entry on #${e.zTicket} — row voided, kept for audit.`);
    }
    render();
  }
  /* ---- directory sync: Docket hosts the shared control plane ---- */
  const upsertClient = (cl)=>{
    let c = state.clients.find(x=>x.id===cl.id);
    if(!c){
      c = { id:cl.id, zorg: String(cl.id||'').slice(0,8), name:cl.name, cycle:'monthly', rateOverride:null,
            billableDefault:true, billableDefaultHist:[], rates:{}, access:{mode:'all', techs:[]},
            useDefaults:false, useDefaultsHist:[], defaultTypeFlags:{} };
      state.clients.push(c);
      log('Client received from Directory', `${cl.name} — created in Docket, billing defaults applied (monthly cycle, standard rates)`);
      toast(`⚡ New client from Docket: ${cl.name} — set its cycle and rates here.`);
    } else if(c.name!==cl.name){
      log('Client renamed via Directory', `${c.name} → ${cl.name}`);
      c.name = cl.name;
    }
    c.archivedInDocket = cl.active===false;
  };
  const upsertGroup = (g)=>{
    let x = state.zammadGroups.find(y=>y.id===g.id);
    if(!x){ state.zammadGroups.push({ id:g.id, name:g.name, archived:g.active===false }); log('Group received from Directory', g.name); }
    else { if(x.name!==g.name){ log('Group renamed via Directory', `${x.name} → ${g.name}`); x.name=g.name; } x.archived = g.active===false; }
  };
  const upsertAgent = (a)=>{
    const t = state.techs.find(x=>x.id===a.id);
    if(t){ const was=t.groups.join(', ');
      t.groups = a.groups.slice(); t.name=a.name; if(a.initials) t.initials=a.initials;
      if(was!==t.groups.join(', ')) log('Group membership via Directory', `${a.name}: ${was||'—'} → ${t.groups.join(', ')}`); }
    else { state.techs.push({ id:a.id, zuser:null, name:a.name, initials:a.initials||'??', groups:a.groups.slice() });
      log('Agent received from Directory', a.name); }
  };
  const upsertType = (x)=>{
    const t = state.types.find(y=>y.id===x.id);
    if(!t){ state.types.splice(state.types.length-1, 0, { id:x.id, ztype:null, name:x.name, billable:!!x.billable, rate:0, sentinel:false, active:true, note:'' });
      log('Activity type received from Directory', `${x.name} — non-billable until a rate is set here`);
      toast(`⚡ New activity type from Docket: ${x.name} — set billable + rate here.`); }
    else { if(t.name!==x.name){ log('Activity type renamed via Directory', `${t.name} → ${x.name}`); t.name=x.name; }
      if(x.active!==undefined && t.active!==x.active){ t.active = x.active;
        log(x.active?'Activity type restored via Directory':'Activity type archived via Directory', t.name); } }
  };
  if(d.type==='project-approved' && d.ticket){
    state.projects = state.projects||{};
    state.projects[d.ticket] = { ticket:d.ticket, title:d.title||('Project #'+d.ticket), clientId:d.clientId,
      pmode:d.pmode||'tasks', projectFlat:d.projectFlat||null,
      tasks:(d.tasks||[]).slice(), approvedBy:d.approvedBy||'Docket', approvedAt:d.approvedAt||Date.now() };
    let marked=0;
    state.entries.forEach(e=>{
      if(e.zTicket!==d.ticket || e.status==='void' || isLocked(e)) return;
      if(!e.submitted){ e.submitted=true; e.submittedAt=Date.now();
        e.returnedBy=null; e.returnedAt=null; e.returnReason=null; marked++; }
    });
    const flat = d.pmode==='flat' ? (d.projectFlat||0) : (d.tasks||[]).filter(x=>x.mode==='flat').reduce((a,x)=>a+(x.flat||0),0);
    log('Project approved in Docket', `${client(d.clientId)?.name||d.clientId} · #${d.ticket} “${d.title||''}” — ${d.tasks?d.tasks.length:0} tasks, $${flat} in flat fees, hourly tasks price by task rate — approved by ${d.approvedBy||'?'}; ${marked} entr${marked===1?'y':'ies'} queued for timesheet approval`);
    toast(`⚡ Project #${d.ticket} approved — ${flat>0?('$'+flat+' flat registered, '):''}${marked} entr${marked===1?'y':'ies'} submitted. Review them on the Approvals page (bundled into each tech’s timesheet for the period).`);
    render();
  }
  if(d.type==='ticket-reclient' && d.ticket && d.clientId){
    let moved = 0;
    state.entries.forEach(e=>{ if(e.zTicket===d.ticket && e.status!=='void' && e.status!=='approved' && e.status!=='locked'){ e.clientId = d.clientId; moved++; } });
    if(moved){ log('Ticket moved to client in Docket', `#${d.ticket} → ${client(d.clientId)?.name||d.clientId}: ${moved} entr${moved===1?'y':'ies'} repriced under the new client`); render(); }
  }
  if(d.type==='ticket-merged'){
    let moved = 0;
    state.entries.forEach(e=>{ if(e.zTicket===d.from){ e.zTicket = d.to; moved++; } });
    if(moved){ log('Ticket merged in Docket', `#${d.from} → #${d.to}: ${moved} entr${moved===1?'y':'ies'} relabelled`); render(); }
  }
  if(d.type==='dir-client-upsert'){ upsertClient(d.client); render(); }
  if(d.type==='dir-group-upsert'){ upsertGroup(d.group); render(); }
  if(d.type==='dir-group-delete'){
    const i = state.zammadGroups.findIndex(g=>g.id===d.groupId);
    if(i>=0){ log('Group deleted via Directory', state.zammadGroups[i].name); state.zammadGroups.splice(i,1);
      state.clients.forEach(c=>{ if(c.access.groups) c.access.groups = c.access.groups.filter(g=>g!==d.groupId); });
      render(); }
  }
  if(d.type==='dir-agent-upsert'){ upsertAgent(d.agent); render(); }
  if(d.type==='dir-role-upsert' && d.role){
    let r = d.role.oldName ? state.zammadRoles.find(x=>x.name===d.role.oldName) : state.zammadRoles.find(x=>x.name===d.role.name);
    if(!r){ r = { name:d.role.name, tech:true, note:d.role.note||'', perms:(d.role.ledgerPerms||[]).slice() }; state.zammadRoles.push(r);
      log('Role added via Directory', `${d.role.name} · ${r.perms.length} Ledger permissions`); }
    else {
      if(d.role.oldName && d.role.oldName!==d.role.name) log('Role renamed via Directory', `${d.role.oldName} → ${d.role.name}`);
      r.name = d.role.name; r.note = d.role.note||r.note;
      if(d.role.ledgerPerms) r.perms = d.role.ledgerPerms.slice();
      if(d.role.active!==undefined && r.archived!==!d.role.active){ r.archived = !d.role.active;
        log(r.archived?'Role archived via Directory':'Role restored via Directory', r.name); }
    }
    render();
  }
  if(d.type==='dir-role-delete' && d.name){
    const i = state.zammadRoles.findIndex(x=>x.name===d.name);
    if(i>=0){ log('Role deleted via Directory', d.name); state.zammadRoles.splice(i,1); render(); }
  }
  if(d.type==='dir-role-perms' && d.role){
    let r = state.zammadRoles.find(x=>x.name===d.role.name);
    if(!r){ r = { name:d.role.name, tech:true, note:d.role.note||'', perms:[] }; state.zammadRoles.push(r); }
    const was = r.perms.length;
    r.perms = d.role.perms.slice();
    log('Role updated via Directory', `${d.role.name}: ${was} → ${r.perms.length} Ledger permissions`);
    render();
  }
  if(d.type==='dir-type-upsert' && d.typeRec){ upsertType(d.typeRec); render(); }
  if(d.type==='dir-snapshot' && d.snapshot){
    const sn = d.snapshot;
    sn.clients.forEach(upsertClient);
    sn.groups.forEach(upsertGroup);
    sn.agents.forEach(upsertAgent);
    sn.types.forEach(upsertType);
    if(sn.roles) sn.roles.forEach(rr=>{
      let r = state.zammadRoles.find(x=>x.name===rr.name);
      if(!r){ state.zammadRoles.push({ name:rr.name, tech:true, note:rr.note||'', perms:(rr.ledgerPerms||[]).slice() }); }
      else if(rr.ledgerPerms) r.perms = rr.ledgerPerms.slice();
    });
    log('Directory reconciled', `${sn.clients.length} clients · ${sn.groups.length} groups · ${sn.agents.length} agents · ${sn.types.length} activity types — authoritative copy from the shared control plane`);
    render();
  }
});
