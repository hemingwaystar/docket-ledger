/* ==========================================================================
   js/desk/views/projects.js — checklist-driven project tickets.
   A project IS a ticket (t.isProject) so the thread, composer, SLA, owner and
   bridge all work unchanged. On top of it: a task checklist (templated at
   creation, editable with manage_projects), per-task billing (hourly at the
   standard Ledger price, hourly at an override rate, or a flat fee — mix
   freely), time entries pinned to tasks, and a review flow: all tasks done →
   Submit for review (manage_projects) → Approve (approve_projects) → the
   project bills to Ledger over the bridge. Approval freezes the checklist.
   Owns: viewProjects · projChecklistCard (rendered inside the ticket view) ·
   the project helpers other views lean on (isProj/projTask/projLocked/
   projEditable/taskPayload/defaultTaskId/projHours) · task, billing and
   lifecycle controls.
   Endpoints: POST /api/projects · POST /api/projects/{id}/tasks ·
   PATCH /api/projects/{id}/tasks/{task_id} · DELETE /api/projects/{id}/tasks/
   {task_id} · PATCH /api/projects/{id}/billing ·
   POST /api/projects/{id}/{submit|reopen|approve|unlock|relock}.
   Invariants: new tasks carry local 'ptN' ids until the next hydrate swaps in
   the server uuid — srvId() gates every per-task mirror. The task DELETE is
   the API's one legitimate hard delete: an undone task with no time logged
   has no history to archive. Server refusals (409 / 423 project lock) land
   in oops() — alert + rehydrate, so the UI never drifts from the DB.
   ========================================================================== */

let PTSEQ = 1;
const mkTask = (label, mode='hourly') => ({ id:'pt'+(PTSEQ++), label, done:false, doneAt:null, doneBy:null, mode, rate:null, flat:null });
const isProj = t => !!(t && t.isProject);
const projTask = (t,id) => t.project.tasks.find(x=>x.id===id);
const projEditable = t => isProj(t) && t.project.status==='open';
/* full-ticket lock after approval: immutable to everyone except an admin
   unlock (approve_projects). Unlock reopens the TICKET (notes, time, props);
   the approved checklist & billing stay frozen — they already billed. */
function projLocked(t){ return isProj(t) && t.project.status==='approved' && !t.project.unlocked; }
function defaultTaskId(t){ const x=t.project.tasks.find(y=>!y.done)||t.project.tasks[0]; return x?x.id:null; }
function taskPayload(t, taskId){ if(!isProj(t)||!taskId) return null; const x=projTask(t,taskId); return x? {id:x.id,label:x.label} : null; }
function projHours(t, taskId){ return t.time.filter(e=>e.taskId===taskId).reduce((a,e)=>a+e.h,0); }
function projUnassignedTime(t){ return t.time.filter(e=>!e.taskId); }
function projSummary(t){
  const p=t.project; let flat=0, hourlyH=0;
  if(p.pmode==='flat'){
    /* one flat rate covers the whole project — every task, every hour */
    flat = p.projectFlat||0;
  } else {
    p.tasks.forEach(x=>{ const h=projHours(t,x.id);
      if(x.mode==='flat') flat += (x.flat||0); else hourlyH += h; });
  }
  return { flat, hourlyH, done:p.tasks.filter(x=>x.done).length, total:p.tasks.length, pflat:p.pmode==='flat' };
}
function projStatusChip(t){
  const s=t.project.status, sum=projSummary(t);
  if(s==='approved') return `<span class="chip st-solved"><span class="cdot"></span>Approved &amp; billed</span>`;
  if(s==='review')   return `<span class="chip st-pending"><span class="cdot"></span>In review</span>`;
  if(sum.total>0 && sum.done===sum.total) return `<span class="chip st-open"><span class="cdot"></span>Tasks complete</span>`;
  return `<span class="chip st-new"><span class="cdot"></span>In progress</span>`;
}

/* ---- server mirrors shared by the task / billing / lifecycle controls ---- */
const projPatchTask=(tid,taskId,payload)=>
  $fetch('/api/projects/'+tid+'/tasks/'+taskId,{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
const projBillingPatch=(tid,payload)=>
  $fetch('/api/projects/'+tid+'/billing',{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
const projPost=(tid,action,payload)=>
  $fetch('/api/projects/'+tid+'/'+action,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),500); });

/* ---- checklist ---- */
function toggleTask(tid, taskId){
  const t=tk(tid), x=t&&isProj(t)? projTask(t,taskId) : null; if(!t||!x) return;
  if(!projEditable(t)) return;
  if(!(can('log_time')||can('manage_projects'))) return;
  x.done=!x.done; x.doneAt = x.done? nowMs() : null; x.doneBy = x.done? state.meId : null;
  t.updatedAt=nowMs();
  log(x.done?'Project task completed':'Project task reopened', `#${t.id} · “${x.label}”${x.done?' — by '+agent(state.meId).name:''}`);
  render();
  if(!srvId(taskId)) return;
  projPatchTask(tid,taskId, x.done?{done:true,done_by_email:ME.email}:{done:false});
}
function addProjTask(tid){
  const t=tk(tid); if(!can('manage_projects')||!projEditable(t)) return;
  const label=(prompt('Task label')||'').trim(); if(!label) return;
  const x=mkTask(label, t.project.defaultMode||'hourly');
  t.project.tasks.push(x);
  log('Project task added', `#${t.id} · “${label}”`); render();
  /* the rehydrate swaps the local 'ptN' id for the server uuid, so the
     row's edit/remove/billing mirrors work from the first click after */
  $fetch('/api/projects/'+tid+'/tasks',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({label:x.label,billing_mode:x.mode||'hourly'})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });
}
function renameProjTask(tid, taskId){
  const t=tk(tid), x=t&&isProj(t)? projTask(t,taskId) : null;
  if(!can('manage_projects')||!projEditable(t)||!x) return;
  const label=(prompt('Rename task', x.label)||'').trim(); if(!label||label===x.label) return;
  log('Project task renamed', `#${t.id} · “${x.label}” → “${label}”`); x.label=label; render();
  if(!srvId(taskId)) return;
  projPatchTask(tid,taskId,{label:x.label});
}
function rmProjTask(tid, taskId){
  const t=tk(tid), x=t&&isProj(t)? projTask(t,taskId) : null;
  if(!can('manage_projects')||!projEditable(t)||!x) return;
  if(x.done){ toast('Reopen the task before removing it.'); return; }
  if(projHours(t,taskId)>0){ toast('This task has time logged under it — move or remove the time first.'); return; }
  t.project.tasks = t.project.tasks.filter(y=>y.id!==taskId);
  log('Project task removed', `#${t.id} · “${x.label}”`); render();
  if(!srvId(taskId)) return;
  /* the one legitimate hard delete: undone + no time = nothing to archive;
     the server re-checks both and refuses with 409 otherwise */
  $fetch('/api/projects/'+tid+'/tasks/'+taskId,{method:'DELETE'})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

/* ---- billing ---- */
function setTaskBilling(tid, taskId, k, v, srcEl){
  const t=tk(tid), x=t&&isProj(t)? projTask(t,taskId) : null;
  if(!can('manage_projects')||!projEditable(t)||!x) return;
  const was={mode:x.mode,rate:x.rate,flat:x.flat};
  if(k==='mode'){
    if(v!=='hourly'&&v!=='flat') return;
    log('Task billing changed', `#${t.id} · “${x.label}” · ${x.mode} → ${v}`);
    x.mode=v; render();
    if(srvId(taskId) && x.mode!==was.mode) projPatchTask(tid,taskId,{billing_mode:x.mode});
    return;
  }
  const n = v===''? null : Number(v);
  if(v!=='' && (isNaN(n)||n<0)) return;
  if(k==='rate'){ log('Task hourly rate set', `#${t.id} · “${x.label}” · ${x.rate==null?'standard':'$'+x.rate} → ${n==null?'standard':'$'+n}/h`); x.rate=n; }
  if(k==='flat'){ log('Task flat fee set', `#${t.id} · “${x.label}” · $${x.flat||0} → $${n||0}`); x.flat=n; }
  commitRender(srcEl);
  if(!srvId(taskId)) return;
  if(x.rate!==was.rate)      projPatchTask(tid,taskId,{rate_cents:x.rate==null?-1:Math.round(x.rate*100)});
  else if(x.flat!==was.flat&&x.flat!=null) projPatchTask(tid,taskId,{flat_cents:Math.round(x.flat*100)});
}
function setProjectBilling(tid, k, v, srcEl){
  const t=tk(tid); if(!can('manage_projects')||!projEditable(t)) return;
  const p=t.project, was={pmode:p.pmode,projectFlat:p.projectFlat};
  if(k==='pmode'){
    if(v!=='tasks'&&v!=='flat') return;
    log('Project billing model changed', `#${t.id} · ${p.pmode==='flat'?'single flat rate':'per-task'} → ${v==='flat'?'single flat rate':'per-task'}`);
    p.pmode=v; render();
    if(p.pmode!==was.pmode) projBillingPatch(tid,{billing_model:p.pmode==='flat'?'project_flat':'per_task'});
    return;
  }
  if(k==='projectFlat'){
    const n = v===''? null : Number(v);
    if(v!=='' && (isNaN(n)||n<0)) return;
    log('Project flat rate set', `#${t.id} · $${p.projectFlat||0} → $${n||0}`);
    p.projectFlat=n; commitRender(srcEl);
    if(p.projectFlat!==was.projectFlat&&p.projectFlat!=null)
      projBillingPatch(tid,{project_flat_cents:Math.round(p.projectFlat*100)});
  }
}

/* ---- lifecycle: open → review → approved (+ admin unlock/relock) ---- */
function submitProject(tid){
  const t=tk(tid); if(!can('manage_projects')||!projEditable(t)) return;
  const sum=projSummary(t);
  if(sum.total===0){ toast('Add at least one task first.'); return; }
  if(sum.done<sum.total){ toast(`${sum.total-sum.done} task${sum.total-sum.done===1?'':'s'} still open — complete the checklist first.`); return; }
  const loose=projUnassignedTime(t);
  if(loose.length){ toast(`${loose.length} time entr${loose.length===1?'y isn’t':'ies aren’t'} assigned to a task — set the task on each entry first.`); return; }
  if(t.project.pmode==='flat'){
    if(!(t.project.projectFlat>0)){ toast('Set the project flat rate before submitting.'); return; }
  } else {
    const badFlat=t.project.tasks.filter(x=>x.mode==='flat'&&!(x.flat>0));
    if(badFlat.length){ toast(`Set the flat fee on “${badFlat[0].label}” before submitting.`); return; }
  }
  t.project.status='review'; t.project.submittedAt=nowMs(); t.project.submittedBy=state.meId;
  t.updatedAt=nowMs();
  log('Project submitted for review', `#${t.id} · ${sum.total} tasks · ${fmtHours(sum.hourlyH)} h hourly + $${sum.flat} flat — by ${agent(state.meId).name}`);
  toast('Project submitted — an approver signs off and it bills to Ledger.');
  render();
  projPost(tid,'submit');
}
function reopenProject(tid){
  const t=tk(tid); if(!t||!isProj(t)||t.project.status!=='review') return;
  if(!(can('approve_projects')||can('manage_projects'))) return;
  t.project.status='open'; t.project.submittedAt=null; t.project.submittedBy=null;
  log('Project review reopened', `#${t.id} — back to In progress — by ${agent(state.meId).name}`);
  render();
  projPost(tid,'reopen');
}
function approveProject(tid){
  const t=tk(tid); if(!can('approve_projects')||!t||!isProj(t)||t.project.status!=='review') return;
  const p=t.project;
  p.status='approved'; p.approvedAt=nowMs(); p.approvedBy=state.meId;
  if((st8(t.st)||{}).type!=='done'){ t.st='solved'; log('State changed', `#${t.id} · → Solved (project approved)`); }
  t.updatedAt=nowMs();
  const sum=projSummary(t);
  log('Project approved → Ledger', `#${t.id} · ${sum.total} tasks · ${fmtHours(sum.hourlyH)} h hourly + $${sum.flat} flat — approved by ${agent(state.meId).name}`);
  bridgeSend('project-approved', { ticket:t.id, title:TITLES[t.id]||firstLine(t), clientId:t.clientId,
    approvedBy:agent(state.meId).name, approvedAt:p.approvedAt, pmode:p.pmode||'tasks', projectFlat:p.projectFlat||null,
    tasks:p.tasks.map(x=>({ id:x.id, label:x.label, mode:x.mode, rate:x.rate, flat:x.flat, hours:projHours(t,x.id) })) });
  toast('Project approved — billing details sent to Ledger.');
  render();
  projPost(tid,'approve',{approver_email:ME.email});
}
function unlockProject(tid){
  const t=tk(tid); if(!can('approve_projects')||!isProj(t)||t.project.status!=='approved'||t.project.unlocked) return;
  t.project.unlocked=true;
  log('Project ticket unlocked (admin)', `#${t.id} — notes, time and properties editable again; approved billing stays frozen — by ${agent(state.meId).name}`);
  toast('Ticket unlocked — the approved checklist & billing remain frozen.');
  render();
  projPost(tid,'unlock');
}
function relockProject(tid){
  const t=tk(tid); if(!can('approve_projects')||!isProj(t)||!t.project.unlocked) return;
  t.project.unlocked=false;
  log('Project ticket re-locked', `#${t.id} — by ${agent(state.meId).name}`);
  render();
  projPost(tid,'relock');
}

/* ---- new project ---- */
function newProjectModal(){
  if(!can('manage_projects')) return;
  const m=document.getElementById('modal');
  m.innerHTML=`
    <div class="modal-head"><h3>New project</h3><p>A project is a ticket with a task checklist. Pick a template to preload the checklist — every task stays editable; billing is set per task (hourly, override rate, or flat fee).</p></div>
    <div class="modal-body">
      <div class="field"><label>Project title</label><input type="text" id="pjTitle" placeholder="e.g. Office relocation — Q3"></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Client</label>${combo('pjClient', CLIENTS.filter(c=>!c.sentinel&&c.status!=='archived').map(c=>({v:c.id,label:c.name,sub:c.domain||''})), (CLIENTS.find(c=>!c.sentinel&&c.status!=='archived')||{}).id||'', null, 'Search clients…')}</div>
        <div class="field"><label>Board / group</label><select id="pjGroup">${aGROUPS().map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Checklist template</label><select id="pjTpl">${PROJ_TEMPLATES.map(x=>`<option value="${x.id}" ${x.id==='onboard'?'selected':''}>${esc(x.name)} (${x.tasks.length} tasks)</option>`).join('')}</select></div>
        <div class="field"><label>Billing model</label><select id="pjMode"><option value="hourly">Per task — hourly (standard rates)</option><option value="flat">Per task — flat fee each</option><option value="pflat">Single flat rate — whole project</option></select></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="createProject()">Create project</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('pjTitle').focus();
}
function createProject(){
  const title=document.getElementById('pjTitle').value.trim();
  if(!title){ toast('The project needs a title.'); return; }
  const clientId=document.getElementById('pjClient').value, groupId=document.getElementById('pjGroup').value;
  const tpl=PROJ_TEMPLATES.find(x=>x.id===document.getElementById('pjTpl').value)||PROJ_TEMPLATES[0];
  const sel=document.getElementById('pjMode').value;
  const pmode = sel==='pflat' ? 'flat' : 'tasks';
  const mode = sel==='flat' ? 'flat' : 'hourly';
  const id=++state.ticketSeq;
  const t=mkTicket({ id, clientId, contactId:(client(clientId).contacts[0]||{}).id, groupId, ownerId:state.meId, st:'open', prio:2, tags:['project'],
    isProject:true, project:{ status:'open', template:tpl.id, defaultMode:mode, pmode, projectFlat:null, tasks:tpl.tasks.map(l=>mkTask(l,mode)), submittedAt:null, submittedBy:null, approvedAt:null, approvedBy:null },
    articles:[ art('sys', agent(state.meId), nowMs(), `Project created from template “${tpl.name}”`) ] });
  TITLES[id]=title;
  log('Project created', `#${id} · ${title} · ${esc(client(clientId).name)} · template “${tpl.name}” · ${tpl.tasks.length} tasks`);
  closeModal(); openTicket(id);
  $fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({title, client:clientId, group:groupId, owner_email:ME.email,
      tasks:tpl.tasks, billing_model:sel==='pflat'?'project_flat':'per_task',
      default_task_mode:sel==='flat'?'flat':'hourly'})})
    .then(async r=>{ const d=await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      /* the server row replaces the optimistic one on rehydrate; follow the
         open ticket across the id swap */
      if(state.ticketId===t.id&&d.id) state.ticketId=d.id;
      setTimeout(()=>hydrate(),500); });
}

/* ---- views ---- */
function viewProjects(){
  const rows = scoped().filter(isProj).sort((a,b)=>b.updatedAt-a.updatedAt);
  const table = rows.map(t=>{
    const sum=projSummary(t), c=client(t.clientId);
    const pct = sum.total? Math.round(sum.done/sum.total*100) : 0;
    return `<tr style="cursor:pointer" onclick="openTicket(${t.id})">
      <td><div class="cell-title">${esc(TITLES[t.id]||firstLine(t))}</div><div class="cell-meta">#${t.id} · ${esc(grp(t.groupId).name)}</div></td>
      <td>${esc(c.name)}</td>
      <td>${t.ownerId?esc(agent(t.ownerId).name):'<span class="muted mini">—</span>'}</td>
      <td style="min-width:140px"><div class="bar"><i style="width:${pct}%"></i></div><div class="mini muted" style="margin-top:2px">${sum.done}/${sum.total} tasks</div></td>
      <td class="num"><span class="tape">${fmtHours(sum.hourlyH)}</span> h</td>
      <td class="num">${sum.pflat?`<span class="tape">$${sum.flat.toLocaleString()}</span> project flat`:sum.flat>0?`<span class="tape">$${sum.flat.toLocaleString()}</span> flat${sum.hourlyH>0?' + hourly':''}`:'<span class="mini muted">hourly</span>'}</td>
      <td>${projStatusChip(t)}</td>
    </tr>`; }).join('');
  return `
  <div class="toolbar">
    <span class="mini muted">${rows.length} project${rows.length===1?'':'s'} in your scope · a project is a ticket — it also appears in the queue, tagged <span class="chip tagchip" style="padding:1px 8px">project</span></span>
    <span class="spacer"></span>
    ${can('manage_projects')?`<button class="btn primary" onclick="newProjectModal()">${icon(IC.plus)}New project</button>`:''}
  </div>
  <div class="card">${rows.length?`<table class="tbl">
    <thead><tr><th>Project</th><th>Client</th><th>Owner</th><th>Checklist</th><th class="num">Hourly time</th><th class="num">Billing</th><th>Status</th></tr></thead>
    <tbody>${table}</tbody></table>`
    :`<div class="empty">${icon(IC.proj)}<div>No projects yet.${can('manage_projects')?' Create one — pick a checklist template and set per-task billing.':''}</div></div>`}</div>`;
}
function projChecklistCard(t){
  const p=t.project, sum=projSummary(t), open=projEditable(t), mng=can('manage_projects');
  const loose=projUnassignedTime(t).length;
  const pflat = p.pmode==='flat';
  const taskRows = p.tasks.map(x=>{
    const h=projHours(t,x.id);
    const billing = pflat
      ? `<span class="mini muted" title="Covered by the project flat rate">— project rate —</span>`
      : open&&mng
      ? `<select style="width:auto;font-size:12px;padding:3px 6px" onchange="setTaskBilling(${t.id},'${x.id}','mode',this.value)">
           <option value="hourly" ${x.mode==='hourly'?'selected':''}>Hourly</option><option value="flat" ${x.mode==='flat'?'selected':''}>Flat fee</option></select>
         ${x.mode==='hourly'
           ? `<input type="number" min="0" step="5" placeholder="std rate" value="${x.rate==null?'':x.rate}" style="width:88px;font-size:12px;padding:3px 6px" title="$/h override — empty = standard Ledger pricing" onchange="setTaskBilling(${t.id},'${x.id}','rate',this.value,this)">`
           : `<span class="mini">$</span><input type="number" min="0" step="50" placeholder="0" value="${x.flat==null?'':x.flat}" style="width:88px;font-size:12px;padding:3px 6px" title="Fixed fee for this task, regardless of hours" onchange="setTaskBilling(${t.id},'${x.id}','flat',this.value,this)">`}`
      : (x.mode==='flat' ? `<span class="mini tape">$${(x.flat||0).toLocaleString()} flat</span>` : `<span class="mini tape">${x.rate!=null?('$'+x.rate+'/h'):'std hourly'}</span>`);
    return `<tr class="${x.done?'locked-row':''}">
      <td class="selcell"><input type="checkbox" ${x.done?'checked':''} ${open&&(can('log_time')||mng)?'':'disabled'} onclick="toggleTask(${t.id},'${x.id}')" title="${x.done?'Reopen':'Mark complete'}"></td>
      <td><div class="cell-title" style="font-weight:500;${x.done?'text-decoration:line-through;color:var(--ink-3)':''}">${esc(x.label)}</div>
        ${x.done?`<div class="cell-meta">done ${fmtAgo(x.doneAt)}${x.doneBy?' by '+esc(agent(x.doneBy).name.split(' ')[0]):''}</div>`:''}</td>
      <td style="white-space:nowrap">${billing}</td>
      <td class="num"><span class="tape">${fmtHours(h)}</span> h</td>
      <td class="right">${open&&mng?`<button class="rowbtn" onclick="renameProjTask(${t.id},'${x.id}')" title="Rename">Edit</button><button class="rowbtn" onclick="rmProjTask(${t.id},'${x.id}')" title="Remove (no time, not done)">×</button>`:''}</td>
    </tr>`; }).join('');
  let foot='';
  if(p.status==='approved'){
    foot=`<div class="notice lock">${icon(IC.seal)}<div><b>Approved ${fmtAgo(p.approvedAt)} by ${esc(agent(p.approvedBy)?.name||'')}.</b> ${p.unlocked?'Checklist &amp; billing stay frozen, but the ticket is <b>admin-unlocked</b> — notes, time and properties are editable.':'The whole ticket is locked — checklist, billing, thread, time and properties are immutable.'}</div>
      <span class="spacer"></span>
      ${can('approve_projects')? (p.unlocked
        ? `<button class="btn sm" onclick="relockProject(${t.id})">${icon(IC.seal)}Re-lock</button>`
        : `<button class="btn sm ghost" onclick="unlockProject(${t.id})" title="Reopens notes, time and properties; the approved billing stays frozen">Unlock (admin)</button>`) : ''}</div>`;
  } else if(p.status==='review'){
    foot=`<div class="notice info">${icon(IC.clock)}<div><b>Submitted for review ${fmtAgo(p.submittedAt)} by ${esc(agent(p.submittedBy)?.name||'')}.</b> ${can('approve_projects')?'Approve to bill the project to Ledger, or reopen it.':'Waiting on an approver.'}</div>
      <span class="spacer"></span>
      ${can('approve_projects')?`<button class="btn seal sm" onclick="approveProject(${t.id})">${icon(IC.seal)}Approve &amp; bill</button>`:''}
      ${(can('approve_projects')||mng)?`<button class="btn sm ghost" onclick="reopenProject(${t.id})">Reopen</button>`:''}</div>`;
  } else {
    const ready = sum.total>0 && sum.done===sum.total && loose===0;
    foot=`<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="mini muted">${sum.done}/${sum.total} tasks complete${loose?` · <span style="color:var(--warn)">${loose} time entr${loose===1?'y':'ies'} without a task</span>`:''}</span>
      <span class="spacer"></span>
      ${mng?`<button class="btn sm ghost" onclick="addProjTask(${t.id})">${icon(IC.plus)}Add task</button>`:''}
      ${mng?`<button class="btn primary sm" ${ready?'':'disabled title="Complete every task and assign all time to tasks first"'} onclick="submitProject(${t.id})">Submit for review</button>`:''}
    </div>`;
  }
  const billingRow = `<div class="card-pad" style="border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span class="mini" style="font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)">Billing model</span>
    ${open&&mng?`<div class="seg">
      <button class="${!pflat?'on':''}" onclick="setProjectBilling(${t.id},'pmode','tasks')" title="Each task bills hourly (standard or override rate) or as its own flat fee — mix freely">Per task</button>
      <button class="${pflat?'on':''}" onclick="setProjectBilling(${t.id},'pmode','flat')" title="One fixed fee covers the entire project regardless of hours">Single flat rate</button>
    </div>`:`<span class="mini tape">${pflat?'single flat rate':'per task'}</span>`}
    ${pflat?(open&&mng
      ?`<span class="mini">$</span><input type="number" min="0" step="100" placeholder="0" value="${p.projectFlat==null?'':p.projectFlat}" style="width:110px;font-size:12.5px;padding:4px 6px" title="Fixed fee for the whole project" onchange="setProjectBilling(${t.id},'projectFlat',this.value,this)">`
      :`<span class="tape" style="font-weight:600">$${(p.projectFlat||0).toLocaleString()} flat — whole project</span>`):''}
  </div>`;
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-head"><h3>Project checklist</h3>${projStatusChip(t)}
      <span class="hint" style="margin-left:auto">${sum.pflat?`$${sum.flat.toLocaleString()} flat — whole project`:`${fmtHours(sum.hourlyH)} h hourly${sum.flat>0?` · $${sum.flat.toLocaleString()} in flat fees`:''}`} · detail &amp; pricing in Ledger</span></div>
    ${billingRow}
    <table class="tbl"><thead><tr><th class="selcell"></th><th>Task</th><th>Billing</th><th class="num">Time</th><th></th></tr></thead>
    <tbody>${taskRows || `<tr><td colspan="5" class="mini muted" style="padding:14px 16px">No tasks yet${mng?' — add the first one below':''}.</td></tr>`}</tbody></table>
    <div class="card-pad" style="border-top:1px solid var(--line)">${foot}</div>
  </div>`;
}
