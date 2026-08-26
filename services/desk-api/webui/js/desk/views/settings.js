/* ==========================================================================
   js/desk/views/settings.js — viewSettings plus the shared-directory editors
   the Directory page's cards call: groups, agents & membership, activity
   types — and the desk vocabularies: ticket states, priorities, queue-tab &
   dashboard defaults (desk_ui), caller verification config, secrets, and
   the read-only PAT list.
   Owns: viewSettings · groupModal/saveGroup/archiveGroup · agentModal/
   saveAgent/deactivateAgent/toggleMembership/setAgentGroups/setAgentRole ·
   typeModal/saveType/archiveType · stateModal/saveState/archiveState/moveState ·
   stSwatches/stateColorSet/stateDescSet/stPalPick (state decor, 0027) ·
   prioModal/savePrio/archivePrio · prioSwatches/prioColorSet (priority
   decor, 0028) · deskUiCard/ovModal/saveOverview/moveOverview/hideOverview/
   dashHiddenDefault/setDashHiddenDefault/setDefaultGroup/deskUiPush (+ deskOvs/
   ensureDeskOvs/ovSlug/ovSummary helpers) · vcfgSet/vcfgToggle/
   vcfgTogglePost · secretRow/secretSave · tokensRefresh/tokenRows.
   Endpoints: POST /api/directory/groups · PATCH /api/directory/groups/{id} ·
   POST /api/directory/agents · PATCH /api/directory/agents/{email} ·
   POST /api/directory/types · PATCH /api/directory/types/{id} ·
   POST /api/settings/states · PATCH /api/settings/states/{state_id} ·
   POST /api/settings/priorities · PATCH /api/settings/priorities/{id} ·
   PUT /api/settings/config/desk_ui · PUT /api/settings/config/verification ·
   PUT /api/settings/secrets/{name} · GET /api/settings/tokens.
   Invariants: archive-first everywhere — nothing here deletes (row 35);
   hiding a queue tab marks its OverviewDef active:false IN PLACE, the
   definition never leaves desk_ui.overviews. Local state mutates first, the
   API call fires only when something actually changed (row 21), oops() on
   refusal. Verification channel toggles mirror IMMEDIATELY with rollback
   (bug-#30 class, row 34) — never debounced. desk_ui always saves WHOLE
   ({overviews, dashboardStates} — design §Storage's pinned shape); the
   working list starts from DESK_UI / DEFAULT_OVERVIEWS (state.js), seeded
   in full on the first edit. System ticket states are machine-written and
   excluded from editing (0025); a state's kind and a core state's label are
   immutable server-side — decor (color/description, 0027) is editable on
   every NON-system state, core included: swatch clicks mirror immediately
   (single-click state, row 34), descriptions debounce like typed fields. The SLA/business-hours cards render here but
   persist via automations.js's config mirrors (slaSet/bizDay/bizHours/
   bizHolidays); the auth card's handlers (authSet/authToggle*) and
   cannedModal live there too; entraSet lives in roles.js. PATCHing a state
   needs its server uuid (row.sid).
   ========================================================================== */

/* ---- groups: rename / add / archive (shared.groups) --------------------- */
let nextGroupIx = 1;
function groupModal(gid){
  if(!can('manage_settings')) return;
  const g0 = gid? grp(gid) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${gid?'Rename group':'Add group'}</h3><p>A group is a board, a routing target and an access scope in one. Mailboxes, boards and role visibility all key off it.</p></div>
    <div class="modal-body"><div class="field"><label>Group name</label><input type="text" id="gpName" value="${esc(g0.name||'')}" placeholder="e.g. Security"></div></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveGroup('${gid||''}')">${gid?'Save':'Add group'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('gpName').focus();
}
function saveGroup(gid){
  const name = document.getElementById('gpName').value.trim();
  if(!name){ toast('The group needs a name.'); return; }
  if(gid){
    const g = grp(gid); if(!g) return;
    const was = g.name;
    if(name===was){ closeModal(); render(); return; }
    log('Group renamed', `${was} → ${name}`); g.name = name;
    bridgeSend('dir-group-upsert', { group:{ id:g.id, name, active:!isArch(g) } });
    toast(`Group “${name}” saved.`);
    closeModal(); render();
    $fetch('/api/directory/groups/'+encodeURIComponent(gid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
        setTimeout(()=>hydrate(),400); });
    return;
  }
  const g = { id:'g_x'+(nextGroupIx++), name };
  GROUPS.push(g); GROUP_SENDAS[g.id] = (outboundBoxes()[0]||{}).id;
  log('Group added', name);
  bridgeSend('dir-group-upsert', { group:{ id:g.id, name, active:true } });
  toast(`Group “${name}” saved.`);
  closeModal(); render();
  $fetch('/api/directory/groups',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });           /* swap temp id for server truth */
}
function archiveGroup(gid){
  const g = grp(gid); if(!g) return;
  if(!isArch(g) && aGROUPS().length<=1){ toast('At least one group has to stay active.'); return; }
  g.active = isArch(g)? true : false;
  bridgeSend('dir-group-upsert', { group:{ id:g.id, name:g.name, active:!isArch(g) } });
  if(isArch(g)){ MAILBOXES.filter(m=>m.groupId===gid && m.status==='connected').forEach(m=>{ m.status='paused'; });
    log('Group archived', `${g.name} — pickers hide it, tickets keep it, its mailboxes paused`); toast(`${g.name} archived. Its inbound mailboxes were paused; existing tickets stay put.`); }
  else { log('Group restored', g.name); toast(`${g.name} restored — resume its mailboxes in Automations if you want mail flowing again.`); }
  render();
  $fetch('/api/directory/groups/'+encodeURIComponent(gid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:g.active!==false})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });
}

/* ---- agents: add / deactivate / membership / role (shared.agents) ------- */
function agentModal(){
  if(!(can('manage_settings')||can('manage_roles'))) return;  /* the server accepts either (audit) */
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Add person</h3><p>Creates the agent record sign-in matches on — SSO users can sign in the moment they’re added. Group membership drives ticket visibility here and client access in Ledger.</p></div>
    <div class="modal-body">
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Full name</label><input type="text" id="agName" placeholder="First Last"></div>
        <div class="field"><label>Email (sign-in identity)</label><input type="text" id="agEmail" placeholder="person@hemingwaytechsolutions.com"></div>
        <div class="field"><label>Initials</label><input type="text" id="agInit" placeholder="auto from the name" maxlength="3"></div>
        <div class="field"><label>Role</label><select id="agRole">${state.roleDefs.filter(r=>r.active!==false&&r.name!=='Customer').map(r=>`<option ${r.name==='Technician'?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field" style="margin-top:8px"><label>Groups</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">${aGROUPS().map((g,i)=>`<label class="mini" style="display:inline-flex;gap:5px;align-items:center;text-transform:none;letter-spacing:0;cursor:pointer"><input type="checkbox" class="agGrp" value="${g.id}" ${i===0?'checked':''} style="width:auto;accent-color:var(--brand)">${esc(g.name)}</label>`).join('')}</div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveAgent()">Add person</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('agName').focus();
}
function saveAgent(){
  const name = document.getElementById('agName').value.trim();
  const email = document.getElementById('agEmail').value.trim().toLowerCase();
  if(!name){ toast('Give them a name.'); return; }
  if(!email.includes('@')){ toast('The email is what sign-in matches — it needs to be real.'); return; }
  if(AGENTS.some(x=>(x.email||'').toLowerCase()===email)){ toast('That email is already in the directory.'); return; }
  let initials = document.getElementById('agInit').value.trim().toUpperCase();
  if(!initials) initials = name.split(/\s+/).map(w=>w[0]).join('').slice(0,3).toUpperCase();
  const role = document.getElementById('agRole').value;
  const groups = [...document.querySelectorAll('.agGrp:checked')].map(el=>el.value);
  if(!groups.length){ toast('Pick at least one group — membership drives visibility.'); return; }
  const a = { id:'ag'+Date.now(), name, email, initials, role, groups };
  AGENTS.push(a);
  log('Agent added', `${name} <${email}> · ${role} · ${groups.map(g=>grp(g)?.name||g).join(', ')}`);
  toast(`${name.split(' ')[0]} added — they can sign in now.`);
  closeModal(); render();
  $fetch('/api/directory/agents',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:a.name, email:a.email, initials:a.initials,
                         role:a.role, groups:a.groups.slice()})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });           /* swap temp id for server truth */
}
function deactivateAgent(tid){
  if(!(can('manage_settings')||can('manage_roles'))) return;  /* the server accepts either (audit) */
  const a = agent(tid); if(!a) return;
  if(tid===state.meId){ toast('You can’t deactivate yourself — another admin has to.'); return; }
  if(!confirm(`Deactivate ${a.name}? They can’t sign in and leave the pickers; their tickets and time stay. Re-adding the same email restores them.`)) return;
  const email = a.email;
  AGENTS.splice(AGENTS.findIndex(x=>x.id===tid),1);
  log('Agent deactivated', a.name);
  toast(`${a.name.split(' ')[0]} deactivated.`);
  render();
  $fetch('/api/directory/agents/'+encodeURIComponent(email),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:false})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
function toggleMembership(gid, tid){
  if(!can('manage_settings')) return;
  const a = agent(tid); if(!a) return;
  const has = a.groups.includes(gid);
  if(has && a.groups.length===1){ toast(`${a.name.split(' ')[0]} needs at least one group.`); return; }
  if(has) a.groups.splice(a.groups.indexOf(gid),1); else a.groups.push(gid);
  log(has?'Removed from group':'Added to group', `${a.name} ${has?'−':'+'} ${grp(gid).name}`);
  bridgeSend('dir-agent-upsert', { agent:{ id:a.id, name:a.name, initials:a.initials, groups:a.groups.slice() } });
  toast(`${a.name.split(' ')[0]} ${has?'removed from':'added to'} ${grp(gid).name} — applies in Ledger too.`);
  render();
  /* the mirror sends the FULL groups list; a refusal re-hydrates via oops()
     so the membership UI tells the truth (bug-#30 class) */
  $fetch('/api/directory/agents/'+encodeURIComponent(a.email),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({groups:a.groups.slice()})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
/* the agent-row group multiCombo (views/directory.js) lands here: a GLOBAL
   NAME handler (render.js calls window[name](selectedArr, fkey)) — same
   endpoint, same full-list replace semantics as toggleMembership, two views
   of one membership truth */
function setAgentGroups(sel, fkey){
  if(!can('manage_settings')) return;
  const a = agent(fkey.slice('agGrp-'.length)); if(!a) return;
  if(!sel.length){ toast(`${a.name.split(' ')[0]} needs at least one group.`); render(); return; }
  if(sel.length===a.groups.length && sel.every(g=>a.groups.includes(g))) return;   /* diff-guard (row 21) */
  a.groups = sel.slice();
  log('Groups updated', `${a.name} → ${a.groups.map(g=>grp(g)?.name||g).join(', ')} — applies in Ledger too`);
  bridgeSend('dir-agent-upsert', { agent:{ id:a.id, name:a.name, initials:a.initials, groups:a.groups.slice() } });
  render();
  $fetch('/api/directory/agents/'+encodeURIComponent(a.email),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({groups:a.groups.slice()})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
function setAgentRole(tid, role){
  const a = agent(tid); if(!a || a.role===role) return;
  const was = a.role;
  a.role = role;
  log('Agent role assigned', `${a.name}: ${was||'—'} → ${role}${AUTH_CFG.roleMapping?' · NOTE: Entra mapping is on — overwritten at next sign-in':''}`);
  bridgeSend('dir-agent-upsert', { agent:{ id:a.id, name:a.name, initials:a.initials, groups:a.groups.slice() } });
  render();
  $fetch('/api/directory/agents/'+encodeURIComponent(a.email),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({role:a.role})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

/* ---- activity types: rename / add / archive (ledger.activity_types —
   names + lifecycle here; billable + rates stay in Ledger) --------------- */
let nextTypeIx = 1;
function typeModal(xid){
  if(!can('manage_settings')) return;
  const x0 = xid? ATYPES.find(a=>a.id===xid) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${xid?'Rename activity type':'Add activity type'}</h3><p>Types are shared: the ticket timer logs against them here; billable status and rates are configured in Ledger.</p></div>
    <div class="modal-body"><div class="field"><label>Name</label><input type="text" id="atName" value="${esc(x0.name||'')}" placeholder="e.g. After-hours"></div></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveType('${xid||''}')">${xid?'Save':'Add type'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('atName').focus();
}
function saveType(xid){
  const name = document.getElementById('atName').value.trim();
  if(!name){ toast('The type needs a name.'); return; }
  if(xid){
    const x = ATYPES.find(a=>a.id===xid); if(!x) return;
    const was = x.name;
    if(name===was){ closeModal(); render(); return; }
    log('Activity type renamed', `${was} → ${name}`); x.name = name;
    bridgeSend('dir-type-upsert', { typeRec:{ id:x.id, name, billable:!!x.billable, active:!isArch(x) } });
    toast(`Type “${name}” saved — set its rate in Ledger.`);
    closeModal(); render();
    if(isUuid(xid)) $fetch('/api/directory/types/'+encodeURIComponent(xid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
    return;
  }
  const x = { id:'at'+(nextTypeIx++), name, billable:false };
  ATYPES.push(x);
  log('Activity type added', name);
  bridgeSend('dir-type-upsert', { typeRec:{ id:x.id, name, billable:false, active:true } });
  toast(`Type “${name}” saved — set its rate in Ledger.`);
  closeModal(); render();
  $fetch('/api/directory/types',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });           /* swap temp id for server truth */
}
function archiveType(xid){
  const x = ATYPES.find(a=>a.id===xid); if(!x) return;
  if(x.name==='Unclassified'){ toast('Unclassified is the sentinel — it has to stay.'); return; }
  if(!isArch(x) && aATYPES().filter(t=>t.name!=='Unclassified').length<=1){ toast('At least one working type has to stay active.'); return; }
  x.active = isArch(x)? true : false;
  log(isArch(x)?'Activity type archived':'Activity type restored', `${x.name}${isArch(x)?' — hidden from pickers; entries carrying it keep it':''}`);
  bridgeSend('dir-type-upsert', { typeRec:{ id:x.id, name:x.name, billable:!!x.billable, active:!isArch(x) } });
  toast(`“${x.name}” ${isArch(x)?'archived — gone from pickers in both apps; existing entries untouched':'restored'}.`);
  render();
  if(isUuid(xid)) $fetch('/api/directory/types/'+encodeURIComponent(xid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!isArch(x)})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

/* ---- ticket states: add / rename / archive / reorder (desk.ticket_states).
   The kind is immutable after create; core states keep their labels (the
   mail pipeline resolves them by label); system states aren't editable at
   all — the server 422s and the card doesn't offer it. -------------------- */
function stateModal(sid){
  if(!can('manage_settings')) return;
  const s0 = sid? st8(sid) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${sid?'Edit state — '+esc(s0.label):'Add state'}</h3><p>The label is yours; the <b>type</b> defines behavior everywhere — SLA clocks, the pending/hold tab, "recently solved", reports — and is fixed once the state exists.</p></div>
    <div class="modal-body">
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Label</label><input type="text" id="stLabel" value="${esc(s0.label||'')}" placeholder="e.g. Waiting on vendor"></div>
        <div class="field"><label>Behaves as</label><select id="stType" ${sid?'disabled title="behavior is load-bearing — the kind is immutable after create"':''}>
          <option value="open" ${s0.type==='open'?'selected':''}>Open — SLA clock runs</option>
          <option value="paused" ${s0.type==='paused'?'selected':''}>Paused — SLA clock stops</option>
          <option value="done" ${s0.type==='done'?'selected':''}>Done — counts as resolved</option></select></div>
      </div>
      ${sid?'':`
      <div class="field" style="margin-top:8px"><label>Color</label>
        <input type="hidden" id="stColor" value="">
        <div id="stPal" style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;align-items:center">${ST_PALETTE.map(p=>`<button class="chip ${p.tok}" data-tok="${p.tok}" title="${esc(p.label)}" onclick="stPalPick('${p.tok}')" style="cursor:pointer"><span class="cdot"></span>${esc(p.label)}</button>`).join('')}
          <input type="color" value="#7a8a99" title="any color — the RGB square" onchange="stPalHex(this.value)" style="width:26px;height:24px;padding:0;border:none;background:none;cursor:pointer">
        </div><div class="mini muted" style="margin-top:4px">No pick = the default chip style. Pills or the color square — recolor any time from the state's row.</div></div>
      <div class="field" style="margin-top:8px"><label>Description</label><input type="text" id="stDescNew" placeholder="what this state means — shows in this editor"></div>`}
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveState('${sid||''}')">${sid?'Save state':'Add state'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('stLabel').focus();
}
function saveState(sid){
  const label = document.getElementById('stLabel').value.trim();
  if(!label){ toast('The state needs a label.'); return; }
  if(sid){
    const s = st8(sid); if(!s || s.core || s.system) return;
    const was = s.label;
    if(label===was){ closeModal(); render(); return; }
    log('State updated', `${was} → ${label}`); s.label = label;
    toast(`State “${label}” saved.`);
    closeModal(); render();
    if(isUuid(s.sid)) $fetch('/api/settings/states/'+encodeURIComponent(s.sid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({label})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
        setTimeout(()=>hydrate(),400); });         /* the state's slug id re-derives from the label */
    return;
  }
  const kind = document.getElementById('stType').value;
  const color = document.getElementById('stColor').value;
  const desc = document.getElementById('stDescNew').value.trim();
  const s = { id:label.toLowerCase().replace(/\s+/g,'-'), sid:null, label, type:kind,
              cls:color||'st-hold', desc, core:false, active:true, system:false };
  STATES.push(s);
  log('State added', `${label} (${kind})`);
  toast(`State “${label}” saved — it's in every state picker now.`);
  closeModal(); render();
  const body = { label, kind };                      /* omitted = default decor (0027) */
  if(color) body.color = color;
  if(desc) body.description = desc;
  $fetch('/api/settings/states',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>{ const d = await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      s.sid = d.id;
      setTimeout(()=>hydrate(),400); });
}
function archiveState(sid){
  const s = st8(sid); if(!s || s.system) return;
  if(!isArch(s)){
    const remaining = aSTATES().filter(x=>x.id!==sid);
    if(!remaining.some(x=>x.type==='open')){ toast('That’s the last active running-SLA state — add or restore another first.'); return; }
    if(!remaining.some(x=>x.type==='done')){ toast('That’s the last active resolved state — add or restore another first.'); return; }
    s.active = false;
    const inIt = state.tickets.filter(t=>t.st===sid).length;
    log('State archived', `${s.label}${inIt?` · ${inIt} ticket${inIt===1?'':'s'} still in it`:''}`);
    toast(`“${s.label}” archived — gone from pickers${inIt?`; ${inIt} ticket${inIt===1?' keeps':'s keep'} it until moved`:''}.`);
  } else { s.active = true; log('State restored', s.label); toast(`“${s.label}” restored.`); }
  render();
  if(isUuid(s.sid)) $fetch('/api/settings/states/'+encodeURIComponent(s.sid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:s.active!==false})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
function moveState(sid, dir){
  const i = STATES.findIndex(x=>x.id===sid), j = i+dir;
  if(i<0 || j<0 || j>=STATES.length) return;
  if(STATES[i].system || STATES[j].system) return;   /* the cascade state keeps its slot */
  [STATES[i],STATES[j]] = [STATES[j],STATES[i]];
  log('States reordered', `${STATES[j].label} ↔ ${STATES[i].label}`);
  render();
  /* positions are 1..N in list order (seeded that way; creates append max+1),
     so each swapped row's new position is its index+1 */
  [i,j].forEach(ix=>{ const s = STATES[ix];
    if(isUuid(s.sid)) $fetch('/api/settings/states/'+encodeURIComponent(s.sid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({position:ix+1})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
  });
}

/* ---- state decor (0027): color + description on any non-system state —
   core states included, only their label is protected. The stored value
   overlays ST_DECOR in mapIn; everything below edits the overlaid row. ---- */
/* the row's swatch strip: one pill per ST_PALETTE token (current ringed;
   clicking the ringed pill un-picks) + a free RGB square (11b —
   <input type=color>, zero dependencies) + a ↺ default affordance when
   the state carries any custom decor */
const stSwatches = s => ST_PALETTE.map(p=>
  `<button class="chip ${p.tok}" title="${esc(p.label)}${!s.hex&&s.cls===p.tok?' — click again for default':''}" onclick="stateColorSet('${jsq(s.id)}','${p.tok}')" style="cursor:pointer${!s.hex&&s.cls===p.tok?';outline:2px solid var(--brand);outline-offset:1px':''}"><span class="cdot"></span></button>`).join('')
  + `<input type="color" value="${s.hex||'#7a8a99'}" title="any color — the RGB square" onchange="stateColorSet('${jsq(s.id)}',this.value)" style="width:24px;height:22px;padding:0;border:none;background:none;cursor:pointer;vertical-align:middle${s.hex?';outline:2px solid var(--brand);outline-offset:1px;border-radius:4px':''}">`
  + (s.hex||s.cls!==stDefCls(s)? `<button class="rowbtn" title="back to the shipped default" onclick="stateColorSet('${jsq(s.id)}','')">↺</button>`:'');
/* the shipped default chip class for a state — what NULL color renders as */
const stDefCls = s => { const dec = ST_DECOR[s.id];
  return dec ? dec.cls : (s.id==='child-closed' ? 'st-closed' : 'st-hold'); };
/* a color pick is single-click state (row 34): mirror IMMEDIATELY — never
   debounced — and only when the chip actually changes (row 21).
   val: palette token · '#rrggbb' hex · '' = reset to shipped default */
function stateColorSet(sid, val){
  const s = st8(sid); if(!s || s.system) return;
  const def = stDefCls(s);
  const was = s.hex || s.cls;
  let body;
  if(val===''){                              /* ↺ default */
    if(!s.hex && s.cls===def) return;
    delete s.hex; s.cls = def; body = {color:null};
  } else if(stHexOk(val)){                   /* the RGB square */
    const hx = val.toLowerCase();
    if(s.hex===hx) return;
    s.hex = hx; s.cls = def; body = {color:hx};
  } else {                                   /* a palette pill */
    if(!ST_PALETTE.some(p=>p.tok===val)) return;
    const reset = !s.hex && s.cls===val;     /* ringed pill clicked = un-pick */
    if(reset && val===def) return;
    delete s.hex; s.cls = reset ? def : val; body = {color: reset ? null : val};
  }
  log('State recolored', `${s.label}: ${was} → ${body.color || `default (${def})`}`);
  render();
  if(isUuid(s.sid)) $fetch('/api/settings/states/'+encodeURIComponent(s.sid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
/* descriptions are typed — debounced like every typed config field; clearing
   the input stores NULL (the server's reset-to-default) and the row falls
   back to the shipped ST_DECOR text */
const _stDescT = {};
function stateDescSet(sid, v, srcEl){
  const s = st8(sid); if(!s || s.system) return;
  const typed = v.trim();
  const next = typed || (ST_DECOR[s.id]||{}).desc || '';
  if(next===s.desc){ commitRender(srcEl); return; }             /* diff-guard (row 21) */
  log('State description changed', `${s.label}: ${s.desc||'—'} → ${next||'—'}`);
  s.desc = next;
  commitRender(srcEl);
  if(!isUuid(s.sid)) return;
  clearTimeout(_stDescT[sid]);
  _stDescT[sid] = setTimeout(()=>{
    $fetch('/api/settings/states/'+encodeURIComponent(s.sid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({description: typed||null})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
  },600);
}
/* add-state modal pick — the modal isn't render()-rebuilt, so the ring is
   painted by hand; clicking the ringed pill un-picks (= default decor) */
function stPalPick(tok){
  const h = document.getElementById('stColor'); if(!h) return;
  h.value = h.value===tok? '' : tok;
  document.querySelectorAll('#stPal .chip').forEach(el=>{
    el.style.outline = el.dataset.tok===h.value? '2px solid var(--brand)' : 'none';
    el.style.outlineOffset = '1px'; });
}
/* the modal's RGB square (11b) — a hex pick clears any pill ring */
function stPalHex(v){
  const h = document.getElementById('stColor'); if(!h || !stHexOk(v)) return;
  h.value = v.toLowerCase();
  document.querySelectorAll('#stPal .chip').forEach(el=>{ el.style.outline='none'; });
}

/* ---- priorities: rename / add / archive (desk.priorities — label/rank/
   active only; SLA hours live in app_config and mirror via slaSet) -------- */
/* priority decor (0028) — the state-decor pattern verbatim: pills from
   PRIO_PALETTE + the RGB square + ↺ when custom; immediate diff-guarded
   PATCH {color}; pid-gated. Default flag = the rank-derived class. */
const prioDefCls = p => 'p'+Math.min(4,Math.max(1,Number(p.rank||p.id)||1));
const prioSwatches = p => PRIO_PALETTE.map(x=>
  `<button class="prio ${x.tok}" title="${esc(x.label)}${!p.hex&&p.cls===x.tok?' — click again for default':''}" onclick="prioColorSet(${p.id},'${x.tok}')" style="cursor:pointer;border:none;background:none;padding:2px${!p.hex&&p.cls===x.tok?';outline:2px solid var(--brand);outline-offset:1px;border-radius:4px':''}"><span class="pflag"></span></button>`).join('')
  + `<input type="color" value="${p.hex||'#7a8a99'}" title="any color — the RGB square" onchange="prioColorSet(${p.id},this.value)" style="width:24px;height:22px;padding:0;border:none;background:none;cursor:pointer;vertical-align:middle${p.hex?';outline:2px solid var(--brand);outline-offset:1px;border-radius:4px':''}">`
  + (p.hex||p.cls!==prioDefCls(p)? `<button class="rowbtn" title="back to the tier-order default" onclick="prioColorSet(${p.id},'')">↺</button>`:'');
function prioColorSet(pid, val){
  const p = prio(pid); if(!p) return;
  const def = prioDefCls(p);
  const was = p.hex || p.cls;
  let body;
  if(val===''){                              /* ↺ default */
    if(!p.hex && p.cls===def) return;
    delete p.hex; p.cls = def; body = {color:null};
  } else if(stHexOk(val)){                   /* the RGB square */
    const hx = val.toLowerCase();
    if(p.hex===hx) return;
    p.hex = hx; p.cls = def; body = {color:hx};
  } else {                                   /* a palette pill */
    if(!PRIO_PALETTE.some(x=>x.tok===val)) return;
    const reset = !p.hex && p.cls===val;     /* ringed pill clicked = un-pick */
    if(reset && val===def) return;
    delete p.hex; p.cls = reset ? def : val; body = {color: reset ? null : val};
  }
  log('Priority recolored', `${p.label}: ${was} → ${body.color || `default (${def})`}`);
  render();
  if(isUuid(p.pid)) $fetch('/api/settings/priorities/'+encodeURIComponent(p.pid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
function prioModal(pid){
  if(!can('manage_settings')) return;
  const p0 = pid? prio(pid) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${pid?'Rename priority — '+esc(p0.label):'Add priority tier'}</h3><p>${pid?'Recolor from the tier’s row — pills or the RGB square.':'New tiers slot in as the most urgent — they sort first everywhere and get their own SLA targets.'}</p></div>
    <div class="modal-body">
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Label</label><input type="text" id="prLabel" value="${esc(p0.label||'')}" placeholder="e.g. Critical"></div>
        ${pid?'':`<div class="field"><label>First response (h)</label><input type="number" id="prFr" value="1" min="1"></div>
        <div class="field"><label>Resolution (h)</label><input type="number" id="prRes" value="4" min="1"></div>`}
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="savePrio(${pid||0})">${pid?'Save tier':'Add tier'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('prLabel').focus();
}
function savePrio(pid){
  const label = document.getElementById('prLabel').value.trim();
  if(!label){ toast('The tier needs a label.'); return; }
  if(pid){
    const p = prio(pid); if(!p) return;
    const was = p.label;
    if(label===was){ closeModal(); render(); return; }
    log('Priority updated', `${was} → ${label}`); p.label = label;
    toast(`Priority “${label}” saved.`);
    closeModal(); render();
    if(isUuid(p.pid)) $fetch('/api/settings/priorities/'+encodeURIComponent(p.pid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({label})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
    return;
  }
  const rank = Math.max(0, ...PRIOS.map(p=>p.rank||p.id)) + 1;
  const p = { id:rank, pid:null, rank, label,
              cls:'p'+Math.min(4,Math.max(1,rank)), active:true };
  PRIOS.push(p);
  SLA[rank] = { fr:Number(document.getElementById('prFr').value)||1,
                res:Number(document.getElementById('prRes').value)||4 };
  log('Priority added', `${label} (tier ${rank})`);
  toast(`Priority “${label}” saved.`);
  closeModal(); render();
  slaPush();                                       /* the new tier's SLA targets → app_config */
  $fetch('/api/settings/priorities',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({label, rank})})
    .then(async r=>{ const d = await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      p.pid = d.id;
      setTimeout(()=>hydrate(),400); });
}
function archivePrio(pid){
  const p = prio(pid); if(!p) return;
  if(!isArch(p) && aPRIOS().length<=1){ toast('At least one priority tier has to stay active.'); return; }
  p.active = isArch(p)? true : false;
  if(isArch(p)){ log('Priority archived', p.label); toast(`“${p.label}” archived — gone from pickers; tickets carrying it keep their SLA.`); }
  else { log('Priority restored', p.label); toast(`“${p.label}” restored.`); }
  render();
  if(isUuid(p.pid)) $fetch('/api/settings/priorities/'+encodeURIComponent(p.pid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:p.active!==false})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

/* ---- queue tabs & dashboard defaults — ONE app_config key, desk_ui:
   {overviews:[OverviewDef,...], dashboardStates:[shown label,...]} (design
   §Storage — pinned shape, both sides). This card edits the ADMIN defaults
   everyone starts from; per-user shaping (reorder/hide/personal tabs, the
   dashboard card's ⚙) lives in prefs, not here. The working list is
   DESK_UI.overviews when customized, else DEFAULT_OVERVIEWS; the first edit
   seeds the whole shipped list so the PUT always carries complete truth.
   A hidden tab is active:false in place — archive-style, never removed. --- */
const deskOvs = () => (Array.isArray(DESK_UI.overviews)&&DESK_UI.overviews.length)? DESK_UI.overviews : DEFAULT_OVERVIEWS;
function ensureDeskOvs(){
  if(!Array.isArray(DESK_UI.overviews)||!DESK_UI.overviews.length)
    DESK_UI.overviews = JSON.parse(JSON.stringify(DEFAULT_OVERVIEWS));
  return DESK_UI.overviews;
}
let _duiT = null;
function deskUiPush(){ clearTimeout(_duiT); _duiT = setTimeout(()=>{
  $fetch('/api/settings/config/desk_ui',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:DESK_UI})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
},600); }
function ovSlug(label, taken){
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'tab';
  let id = base, n = 2;
  while(taken.some(o=>o.id===id)) id = base+'-'+(n++);
  return id;
}
function ovSummary(o){
  const parts = [{all:"everyone's tickets",mine:'assigned to the viewer',unassigned:'unassigned'}[o.scope]||o.scope];
  if(o.stateKinds?.length) parts.push(o.stateKinds.join(' / '));
  if(o.states?.length) parts.push('states: '+o.states.join(', '));
  if(o.groups?.length) parts.push('boards: '+o.groups.map(g=>grp(g)?.name||g).join(', '));
  if(o.clients?.length) parts.push(o.clients.length>3 ? o.clients.length+' clients'
    : 'clients: '+o.clients.map(c=>client(c)?.name||c).join(', '));
  if(o.prios?.length) parts.push('priority: '+o.prios.map(p=>prio(Number(p))?.label||p).join(', '));
  if(o.tags?.length) parts.push('tags: '+o.tags.join(', '));
  if(o.recentDays) parts.push('updated in the last '+o.recentDays+'d');
  return parts.join(' · ');
}
function moveOverview(id, dir){
  const list = ensureDeskOvs();
  const i = list.findIndex(o=>o.id===id), j = i+dir;
  if(i<0 || j<0 || j>=list.length) return;
  [list[i],list[j]] = [list[j],list[i]];
  log('Queue tabs reordered', `${list[j].label} ↔ ${list[i].label}`);
  render();
  deskUiPush();
}
function hideOverview(id){
  const list = ensureDeskOvs();
  const o = list.find(x=>x.id===id); if(!o) return;
  const was = isArch(o);
  if(!was && list.filter(x=>!isArch(x)).length<=1){ toast('At least one queue tab has to stay visible.'); return; }
  if(was) delete o.active; else o.active = false;
  log(was?'Queue tab restored':'Queue tab hidden', o.label);
  toast(`“${o.label}” ${was?'is back in everyone’s tab bar':'hidden — the definition stays; restore it any time'}.`);
  render();
  deskUiPush();
}
/* the admin default expressed as HIDDEN labels — multiCombo's
   empty-selection-=-All convention maps exactly onto §Storage's
   absent-key = all-shown semantics. Storage stays SHOWN labels; only the
   control inverts. */
function dashHiddenDefault(){
  const all = aSTATES().map(s=>s.label);
  return Array.isArray(DESK_UI.dashboardStates) ? all.filter(l=>!DESK_UI.dashboardStates.includes(l)) : [];
}
function setDashHiddenDefault(vals){
  const all = aSTATES().map(s=>s.label);
  const cur = Array.isArray(DESK_UI.dashboardStates) ? DESK_UI.dashboardStates : null;
  const next = vals.length ? all.filter(l=>!vals.includes(l)) : null;   /* null = absent key — all shown, future states auto-visible */
  if(JSON.stringify(cur)===JSON.stringify(next)) return;               /* diff-guard (row 21) */
  if(next===null) delete DESK_UI.dashboardStates; else DESK_UI.dashboardStates = next;
  log('Dashboard default changed', `Queue by state · hidden by default: ${vals.length? vals.join(', ') : 'none'}`);
  render();
  deskUiPush();
}
function setTimeCycle(v){
  const cur = DESK_UI.timeCycle==='weekly'?'weekly':'monthly';
  if(v===cur) return;                                                  /* diff-guard */
  if(v==='weekly') DESK_UI.timeCycle='weekly'; else delete DESK_UI.timeCycle;  /* absent = monthly */
  log('Dashboard time cycle changed', v==='weekly'?'weekly (Mon–Sun)':'monthly (calendar month)');
  render();
  deskUiPush();
}
function setDefaultGroup(v){
  const cur = DESK_UI.defaultGroup || '';
  if(v===cur) return;                                                  /* diff-guard */
  if(v) DESK_UI.defaultGroup = v; else delete DESK_UI.defaultGroup;    /* absent key = first board */
  log('Default ticket group changed', v?(grp(v)?.name||v):'first board');
  render();
  deskUiPush();
}
function ovModal(id){
  if(!can('manage_settings')) return;
  const o0 = id? deskOvs().find(x=>x.id===id) : { scope:'all' };
  if(!o0) return;
  const has = (arr,v)=>Array.isArray(arr)&&arr.includes(v);
  const ck = (cls,v,on,label)=>`<label class="mini" style="display:inline-flex;gap:5px;align-items:center;text-transform:none;letter-spacing:0;cursor:pointer"><input type="checkbox" class="${cls}" value="${esc(v)}" ${on?'checked':''} style="width:auto;accent-color:var(--brand)">${esc(label)}</label>`;
  /* archived states/boards/tiers stay out of the boxes unless this def
     already carries them (row 37) */
  const stOpts = aSTATES().map(s=>({v:s.label,l:s.label}));
  (o0.states||[]).forEach(v=>{ if(!stOpts.some(x=>x.v===v)) stOpts.push({v,l:v+' (archived)'}); });
  const gOpts = aGROUPS().map(g=>({v:g.id,l:g.name}));
  (o0.groups||[]).forEach(v=>{ if(!gOpts.some(x=>x.v===v)) gOpts.push({v,l:(grp(v)?.name||v)+' (archived)'}); });
  const cOpts = CLIENTS.filter(c=>c.status!=='archived').map(c=>({v:c.id,l:c.name}));
  (o0.clients||[]).forEach(v=>{ if(!cOpts.some(x=>x.v===v)) cOpts.push({v,l:(client(v)?.name||v)+' (archived)'}); });
  const pOpts = aPRIOS().slice().sort((a,b)=>b.id-a.id).map(p=>({v:String(p.id),l:p.label}));
  (o0.prios||[]).forEach(v=>{ if(!pOpts.some(x=>x.v===String(v))) pOpts.push({v:String(v),l:(prio(Number(v))?.label||('tier '+v))+' (archived)'}); });
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${id?'Edit queue tab — '+esc(o0.label):'Add queue tab'}</h3><p>A tab is a saved filter over the queue — a section left empty puts no constraint from that section. It lands in everyone's tab bar; people can still hide or reorder it for themselves.</p></div>
    <div class="modal-body" style="max-height:62vh;overflow:auto">
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Label</label><input type="text" id="ovLabel" value="${esc(o0.label||'')}" placeholder="e.g. Escalations"></div>
        <div class="field"><label>Whose tickets</label><select id="ovScope">
          <option value="all" ${o0.scope==='mine'||o0.scope==='unassigned'?'':'selected'}>Everyone's</option>
          <option value="mine" ${o0.scope==='mine'?'selected':''}>Assigned to the viewer</option>
          <option value="unassigned" ${o0.scope==='unassigned'?'selected':''}>Unassigned</option></select></div>
      </div>
      <div class="field"><label>State kind</label><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">${[['open','Open — SLA runs'],['paused','Paused'],['done','Resolved']].map(([v,l])=>ck('ovKind',v,has(o0.stateKinds,v),l)).join('')}</div></div>
      <div class="field"><label>Specific states</label><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">${stOpts.map(x=>ck('ovState',x.v,has(o0.states,x.v),x.l)).join('')}</div></div>
      <div class="field"><label>Boards</label><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">${gOpts.map(x=>ck('ovGroup',x.v,has(o0.groups,x.v),x.l)).join('')}</div></div>
      <div class="field"><label>Clients</label><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;max-height:110px;overflow:auto">${cOpts.map(x=>ck('ovClient',x.v,has(o0.clients,x.v),x.l)).join('')||'<span class="mini muted">No clients.</span>'}</div></div>
      <div class="field"><label>Priorities</label><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">${pOpts.map(x=>ck('ovPrio',x.v,(o0.prios||[]).some(p=>String(p)===x.v),x.l)).join('')}</div></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Tags (comma-separated — any of them)</label><input type="text" id="ovTags" value="${esc((o0.tags||[]).join(', '))}"></div>
        <div class="field"><label>Updated in the last … days</label><input type="number" id="ovRecent" min="1" value="${o0.recentDays||''}" placeholder="no time window"></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveOverview('${id||''}')">${id?'Save tab':'Add tab'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('ovLabel').focus();
}
function saveOverview(id){
  const label = document.getElementById('ovLabel').value.trim();
  if(!label){ toast('The tab needs a label.'); return; }
  const pick = cls => [...document.querySelectorAll('.'+cls+':checked')].map(el=>el.value);
  const def = { id, label, scope: document.getElementById('ovScope').value };
  const kinds = pick('ovKind');
  if(kinds.length && kinds.length<3) def.stateKinds = kinds;   /* all three = any kind = omitted */
  const states = pick('ovState'); if(states.length) def.states = states;
  const groups = pick('ovGroup'); if(groups.length) def.groups = groups;
  const clients = pick('ovClient'); if(clients.length) def.clients = clients;
  const prios = pick('ovPrio').map(Number); if(prios.length) def.prios = prios;
  const tags = document.getElementById('ovTags').value.split(',').map(s=>s.trim()).filter(Boolean);
  if(tags.length) def.tags = tags;
  const days = Math.floor(Number(document.getElementById('ovRecent').value));
  if(days>=1) def.recentDays = days;
  const list = ensureDeskOvs();
  if(id){
    const i = list.findIndex(o=>o.id===id); if(i<0) return;
    if(list[i].active===false) def.active = false;             /* hidden survives an edit */
    if(JSON.stringify(def)===JSON.stringify(list[i])){ closeModal(); render(); return; }
    log('Queue tab updated', list[i].label===label? label : `${list[i].label} → ${label}`);
    list[i] = def;
  }else{
    def.id = ovSlug(label, list);                    /* the id is permanent — prefs reference it */
    list.push(def);
    log('Queue tab added', label);
  }
  toast(`Tab “${label}” saved — it's in everyone's tab bar on their next load.`);
  closeModal(); render();
  deskUiPush();
}
function deskUiCard(){
  const list = deskOvs();
  const custom = Array.isArray(DESK_UI.overviews)&&DESK_UI.overviews.length;
  return `
    <div class="card card-pad">
      <div class="card-head flush"><h3>Queue tabs &amp; dashboard</h3><span class="hint">the defaults everyone starts from — people fine-tune their own</span></div>
      ${list.map((o,i)=>{ const arch=isArch(o); return `<div class="setting-row" ${arch?'style="opacity:.55"':''}><div class="sl"><b>${esc(o.label)}</b>${arch?` <span class="chip st-closed"><span class="cdot"></span>Hidden</span>`:''}<p>${esc(ovSummary(o))}</p></div>
        ${i>0?`<button class="rowbtn" onclick="moveOverview('${jsq(o.id)}',-1)" title="list earlier">↑</button>`:''}
        ${i<list.length-1?`<button class="rowbtn" onclick="moveOverview('${jsq(o.id)}',1)" title="list later">↓</button>`:''}
        <button class="rowbtn" onclick="ovModal('${jsq(o.id)}')">Edit</button>
        <button class="rowbtn" onclick="hideOverview('${jsq(o.id)}')">${arch?'Show':'Hide'}</button></div>`;}).join('')}
      <button class="btn sm" style="margin-top:12px" onclick="ovModal()">+ Add tab</button>
      <div class="mini muted" style="margin-top:8px">${custom?'Customized — saved as the shared default for every agent.':'Showing the shipped defaults — the first change saves the whole list as the shared default.'} Hiding is archive-style: the definition stays and can be restored. Personal tabs and per-user order live on each person's queue (⚙), not here.</div>
      <div class="card-head flush" style="margin-top:16px"><h3>Dashboard — queue by state</h3><span class="hint">shown by default · each person can override on the card</span></div>
      <div style="margin-top:6px;max-width:360px">${multiCombo('duiDashHide', aSTATES().map(s=>({v:s.label,label:s.label})), dashHiddenDefault(), 'setDashHiddenDefault', 'No states hidden', true)}</div>
      <div class="mini muted" style="margin-top:8px">Pick the states to <b>hide</b> from the dashboard’s Queue-by-state card by default; anyone who has set their own view on the card (⚙) is untouched. No selection = every active state shows, and new states show automatically.</div>
      <div class="card-head flush" style="margin-top:16px"><h3>New tickets</h3><span class="hint">what the New-ticket form starts on</span></div>
      <div class="field inline-sm" style="margin-top:6px"><label>Default ticket group</label>
        <select onchange="setDefaultGroup(this.value)" style="max-width:360px">
          <option value="">— first board —</option>
          ${aGROUPS().map(g=>`<option value="${g.id}" ${DESK_UI.defaultGroup===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}
          ${DESK_UI.defaultGroup&&!aGROUPS().some(g=>g.id===DESK_UI.defaultGroup)?`<option value="${esc(DESK_UI.defaultGroup)}" selected>${esc(grp(DESK_UI.defaultGroup)?.name||DESK_UI.defaultGroup)} (archived)</option>`:''}
        </select></div>
      <div class="card-head flush" style="margin-top:16px"><h3>Dashboard — time this cycle</h3><span class="hint">the window the hours card sums</span></div>
      <div class="field inline-sm" style="margin-top:6px"><label>Cycle</label>
        <select onchange="setTimeCycle(this.value)" style="max-width:360px">
          <option value="monthly" ${DESK_UI.timeCycle!=='weekly'?'selected':''}>Monthly — calendar month</option>
          <option value="weekly" ${DESK_UI.timeCycle==='weekly'?'selected':''}>Weekly — Mon–Sun (Ledger's weekly cycle)</option>
        </select></div>
      <div class="mini muted" style="margin-top:8px">Matches the Ledger billing cycles — the dashboard's “Time this cycle” card sums non-voided ticket time logged inside the current window.</div>
    </div>`;
}

/* ---- caller verification config — one app_config key. Value edits are
   debounced; the Enable/Disable + thread-post toggles mirror IMMEDIATELY
   with rollback (bug-#30 class, row 34: the chip must never lie) ---------- */
let _vcfgT = null;
function vcfgPush(){ clearTimeout(_vcfgT); _vcfgT = setTimeout(()=>{
  $fetch('/api/settings/config/verification',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:VCFG})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
},600); }
function vcfgSet(path, v, srcEl){
  const [a,b] = path.split('.');
  if(b) VCFG[a] = VCFG[a]||{};
  const was = b? VCFG[a][b] : VCFG[a];
  let nv = v;
  if(path==='ttlMin' || path==='attempts'){ nv = Number(v); if(isNaN(nv)||nv<1){ commitRender(srcEl); return; } }
  if(b) VCFG[a][b] = nv; else VCFG[a] = nv;
  if(nv===was){ commitRender(srcEl); return; }
  log('Verification config changed', `${path}: ${was===''||was==null?'—':was} → ${nv===''?'—':nv}`);
  commitRender(srcEl);
  vcfgPush();
}
function vcfgToggle(chan){
  const other = chan==='sms'?'email':'sms';
  if(VCFG[chan].enabled && !VCFG[other].enabled){ toast('Keep at least one verification channel enabled.'); return; }
  const was = VCFG[chan].enabled;
  VCFG[chan].enabled = !was;
  log('Verification channel '+(VCFG[chan].enabled?'enabled':'disabled'), chan.toUpperCase());
  render();
  $fetch('/api/settings/config/verification',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:VCFG})})
    .then(async r=>{ if(!r.ok){ VCFG[chan].enabled=was; render();
      return oops(await r.json().catch(()=>0)); } })
    .catch(()=>{ VCFG[chan].enabled=was; render();
      toast('Live sync failed — the channel was NOT changed on the server.'); });
}
function vcfgTogglePost(){
  const was = VCFG.postToThread;
  VCFG.postToThread = !was;
  log('Verification audit posting '+(VCFG.postToThread?'enabled':'disabled'), 'thread posting — the Audit Log itself always records outcomes');
  render();
  $fetch('/api/settings/config/verification',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:VCFG})})
    .then(async r=>{ if(!r.ok){ VCFG.postToThread=was; render();
      return oops(await r.json().catch(()=>0)); } })
    .catch(()=>{ VCFG.postToThread=was; render();
      toast('Live sync failed — thread posting was NOT changed on the server.'); });
}

/* ---- secrets: write-only PUT — plaintext goes in, only set/rotated
   metadata ever comes back ------------------------------------------------ */
const SECRET_NAMES  = { graphSecret:'graph', entraSecret:'entra_oidc',
                        voipKey:'voipms', twilioToken:'twilio' };
const SECRET_LABELS = { graphSecret:'Graph app client secret',
                        entraSecret:'Entra OIDC client secret',
                        voipKey:'voip.ms API password',
                        twilioToken:'Twilio auth token' };
function secretRow(key){
  const sx = SECRETS[key] || { set:false, at:null, by:'', label:SECRET_LABELS[key]||key };
  return `<div class="field inline-sm" style="margin:8px 0"><label>${esc(sx.label)}</label>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    ${state._rotating===key
      ? `<input type="password" id="sec-${key}" placeholder="paste new secret" style="width:220px;font-family:'IBM Plex Mono',monospace;font-size:12px">
         <button class="btn sm primary" onclick="secretSave('${key}')">Save</button>
         <button class="btn sm ghost" onclick="state._rotating=null;render()">Cancel</button>`
      : `<span class="tape">${sx.set?'••••••••••••':'— not set —'}</span>
         ${sx.set&&sx.at?`<span class="mini muted">rotated ${fmtDT(sx.at)}${sx.by?' by '+esc(sx.by):''}</span>`:''}
         <button class="rowbtn" onclick="state._rotating='${key}';render()">${sx.set?'Rotate':'Set'}</button>`}
    </div></div>`;
}
function secretSave(key){
  const el = document.getElementById('sec-'+key);
  const v = el? el.value : '';
  if(!v || v.length<8){ toast('Secrets need at least 8 characters.'); return; }
  const sx = SECRETS[key] || (SECRETS[key] = { set:false, at:null, by:'', label:SECRET_LABELS[key]||key });
  const was = sx.set;
  sx.set = true; sx.at = Date.now(); sx.by = state.user.name;
  state._rotating = null;
  log(was?'Secret rotated':'Secret set', `${sx.label} · by ${state.user.name} · stored encrypted, write-only — value never displayed again`);
  toast(`${sx.label} ${was?'rotated':'saved'} — encrypted at rest, never shown again.`);
  render();
  if(!SECRET_NAMES[key]) return;
  $fetch('/api/settings/secrets/'+SECRET_NAMES[key],{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:v})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });           /* pull the real rotation meta */
}

/* ---- personal access tokens: read-only metadata list. No mint/revoke in
   the UI — PATs are operator-minted (scripts/create-token.sh) ------------- */
let _tokens = null, _tokensAt = 0, _tokensBusy = false, _tokensErr = false;
function tokensRefresh(){
  if(_tokensBusy || (_tokens!==null && nowMs()-_tokensAt < 30000)) return;
  _tokensBusy = true;
  $fetch('/api/settings/tokens')
    .then(async r=>{
      _tokensBusy = false; _tokensAt = nowMs();
      if(!r.ok){ _tokensErr = true; _tokens = _tokens||[]; }
      else { const d = await r.json().catch(()=>({})); _tokens = d.tokens||[]; _tokensErr = false; }
      if(state.view==='settings') render();
    })
    .catch(()=>{ _tokensBusy = false; _tokensAt = nowMs(); _tokensErr = true; _tokens = _tokens||[];
      if(state.view==='settings') render(); });
}
function tokenRows(){
  tokensRefresh();
  if(_tokens===null) return `<div class="mini muted">Loading tokens…</div>`;
  if(_tokensErr)     return `<div class="mini muted">Couldn’t load the token list — check desk-api logs.</div>`;
  if(!_tokens.length) return `<div class="mini muted">No personal access tokens yet.</div>`;
  return _tokens.map(k=>`<div class="setting-row"><div class="sl"><b>${esc(k.name)}</b><p>created ${fmtDT(k.createdAt)} · ${k.lastUsedAt?'last used '+fmtDT(k.lastUsedAt):'never used'}</p></div><span class="chip st-solved"><span class="cdot"></span>Active</span></div>`).join('');
}

/* ---- the Settings page -------------------------------------------------- */
function viewSettings(){
  const smsProv = VCFG.sms.provider||'voip.ms';
  return `
  <div class="grid g-2">
    <div class="card card-pad">
      <div class="card-head flush"><h3>Groups</h3><span class="hint">shared — managed in the Directory</span></div>
      <div class="mini" style="margin-bottom:10px">${aGROUPS().length} active group${aGROUPS().length===1?'':'s'}${GROUPS.some(isArch)?` · ${GROUPS.filter(isArch).length} archived`:''} — groups, membership and archiving live in the shared <b>Directory</b>, so Docket and Ledger always agree.</div>
      <button class="btn sm" onclick="go('directory')">Open Directory →</button>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>API access</h3><span class="hint">personal access tokens — script reports &amp; automations</span></div>
      ${tokenRows()}
      <div class="mini muted" style="margin-top:10px">Endpoints: <span class="tape">GET /api/tickets</span> · <span class="tape">GET /api/tickets/{id}</span> · <span class="tape">GET /api/reports/queue</span> · <span class="tape">GET /api/audit</span> — authenticate with <span class="tape">Authorization: Bearer &lt;token&gt;</span>.</div>
      <div class="mini muted" style="margin-top:6px">Tokens are minted and revoked operator-side (<span class="tape">scripts/create-token.sh</span>) — values are hashed at rest and never shown here.</div>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Canned responses</h3><span class="hint">insert from the composer · template variables render per ticket</span></div>
      ${CANNED.map(c=>`<div class="setting-row"><div class="sl"><b>${esc(c.name)}</b><p>${esc(c.body.slice(0,80))}…</p></div><button class="rowbtn" onclick="cannedModal('${c.id}')">Edit</button></div>`).join('')}
      <button class="btn sm" style="margin-top:12px" onclick="cannedModal()">+ Add canned response</button>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Business hours</h3><span class="hint">SLA clocks only run inside these</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i)=>`<label class="mini" style="display:inline-flex;gap:4px;align-items:center;text-transform:none;cursor:pointer"><input type="checkbox" ${BIZ.days.includes(i)?'checked':''} onchange="bizDay(${i},this.checked)" style="width:auto;accent-color:var(--brand)">${d}</label>`).join('')}
      </div>
      <div class="fgrid">
        <div class="field inline-sm"><label>from</label><input type="number" min="0" max="23" value="${BIZ.start}" style="width:64px" onchange="bizHours('start',this.value,this)"></div>
        <div class="field inline-sm"><label>to</label><input type="number" min="1" max="24" value="${BIZ.end}" style="width:64px" onchange="bizHours('end',this.value,this)"></div>
        <div class="field inline-sm" style="flex:1;min-width:200px"><label>holidays</label><input type="text" value="${esc(BIZ.holidays.join(', '))}" style="width:100%;font-size:12px" onchange="bizHolidays(this.value,this)" placeholder="YYYY-MM-DD, comma-separated"></div>
      </div>
      <div class="mini muted" style="margin-top:8px">A ticket opened Friday 5 PM won't breach on Saturday — due dates walk only working minutes.</div>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Ticket states</h3><span class="hint">editable vocabulary — behavior comes from the type</span></div>
      ${STATES.map((s,i)=>{ const arch=isArch(s); return `<div class="setting-row" ${arch?'style="opacity:.55"':''}><div class="sl"><b><span ${stChipAttrs(s)}><span class="cdot"></span>${esc(s.label)}</span></b>${arch?` <span class="chip st-closed"><span class="cdot"></span>Archived</span>`:''}${s.system
        ? `<p>${esc(s.desc||'')}</p>`
        : `<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:7px 0 5px">${stSwatches(s)}</div>
        <input type="text" id="stDesc-${s.id}" value="${esc(s.desc||'')}" placeholder="what this state means" style="width:100%;max-width:420px;font-size:12px" onchange="stateDescSet('${jsq(s.id)}',this.value,this)">`}</div>
        <span class="mini muted">${s.type==='open'?'SLA runs':s.type==='paused'?'SLA paused':'resolved'}</span>
        ${s.system?`<span class="mini muted">system — cascade-written</span>`:`
        ${(i>0&&!STATES[i-1].system)?`<button class="rowbtn" onclick="moveState('${jsq(s.id)}',-1)" title="list earlier">↑</button>`:''}
        ${(i<STATES.length-1&&!STATES[i+1].system)?`<button class="rowbtn" onclick="moveState('${jsq(s.id)}',1)" title="list later">↓</button>`:''}
        ${s.core?'':`<button class="rowbtn" onclick="stateModal('${jsq(s.id)}')">Edit</button>`}
        <button class="rowbtn" onclick="archiveState('${jsq(s.id)}')">${arch?'Restore':'Archive'}</button>`}</div>`;}).join('')}
      <button class="btn sm" style="margin-top:12px" onclick="stateModal()">+ Add state</button>
      <div class="mini muted" style="margin-top:8px">Any state can be archived — tickets already in it keep it until moved. At least one running-SLA state and one resolved state must stay active. Core states keep their names (the mail pipeline resolves them by label) — their color and description are yours; the cascade-written system state isn't editable; behavior is fixed at creation. Clearing a description restores the shipped text.</div>
    </div>
    ${deskUiCard()}
    <div class="card card-pad">
      <div class="card-head flush"><h3>Priorities &amp; SLA</h3><span class="hint">tiers are editable — targets in hours drive the SLA column</span></div>
      ${PRIOS.slice().sort((a,b)=>b.id-a.id).map(p=>{ const arch=isArch(p); return `<div class="setting-row" ${arch?'style="opacity:.55"':''}><div class="sl"><b>${prioTag(p.id)}</b>${arch?` <span class="chip st-closed" style="margin-left:6px"><span class="cdot"></span>Archived</span>`:''}
        <div style="display:flex;gap:3px;align-items:center;margin-top:5px">${prioSwatches(p)}</div></div>
        <div class="fgrid">
          <div class="field inline-sm"><label>first response</label><input type="number" value="${SLA[p.id]?.fr??''}" min="1" style="width:64px" onchange="slaSet(${p.id},'fr',this.value,'${jsq(p.label)}')"></div>
          <div class="field inline-sm"><label>resolution</label><input type="number" value="${SLA[p.id]?.res??''}" min="1" style="width:64px" onchange="slaSet(${p.id},'res',this.value,'${jsq(p.label)}')"></div>
        </div>
        <button class="rowbtn" onclick="prioModal(${p.id})">Rename</button>
        <button class="rowbtn" onclick="archivePrio(${p.id})">${arch?'Restore':'Archive'}</button>
      </div>`;}).join('')}
      <button class="btn sm" style="margin-top:12px" onclick="prioModal()">+ Add priority tier</button>
      <div class="mini muted" style="margin-top:8px">Higher tiers sort above lower ones in every queue; escalation rules ("at least High") compare by tier order. Archiving hides a tier from pickers while tickets that carry it keep their SLA.</div>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Caller verification</h3><span class="hint">one-time codes for sensitive requests</span></div>
      <div class="setting-row" style="align-items:flex-start"><div class="sl"><b>SMS</b>
          <div class="fgrid" style="margin-top:6px">
            <div class="field inline-sm"><label>provider</label><select style="width:auto" onchange="vcfgSet('sms.provider',this.value,this)"><option ${smsProv==='voip.ms'?'selected':''}>voip.ms</option><option ${smsProv==='Twilio'?'selected':''}>Twilio</option></select></div>
            <div class="field inline-sm"><label>sending DID</label><input type="text" value="${esc(VCFG.sms.did)}" class="in-mono" style="width:140px" onchange="vcfgSet('sms.did',this.value,this)"></div>
          </div>
          ${smsProv==='voip.ms'
            ? `<div class="field inline-sm" style="margin-top:8px"><label>voip.ms API username</label><input type="text" value="${esc(VCFG.sms.apiUser)}" class="in-mono" style="width:220px" onchange="vcfgSet('sms.apiUser',this.value,this)"></div>${secretRow('voipKey')}`
            : `<div class="field inline-sm" style="margin-top:8px"><label>Twilio account SID</label><input type="text" value="${esc(VCFG.sms.twilioSid)}" placeholder="AC…" class="in-mono" style="width:220px" onchange="vcfgSet('sms.twilioSid',this.value,this)"></div>${secretRow('twilioToken')}`}
        </div>
        <button class="rowbtn" onclick="vcfgToggle('sms')">${VCFG.sms.enabled?'Disable':'Enable'}</button>
        <span class="chip ${VCFG.sms.enabled?'st-solved':'st-closed'}"><span class="cdot"></span>${VCFG.sms.enabled?'Connected':'Off'}</span></div>
      <div class="setting-row" style="align-items:flex-start"><div class="sl"><b>Email</b>
          <div class="field inline-sm" style="margin-top:6px"><label>Microsoft Graph · sends from</label>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input type="text" value="${esc(VCFG.email.from)}" class="in-mono" style="width:280px" onchange="vcfgSet('email.from',this.value,this)"><span class="mini muted">(app-scoped Mail.Send)</span></div>
          </div></div>
        <button class="rowbtn" onclick="vcfgToggle('email')">${VCFG.email.enabled?'Disable':'Enable'}</button>
        <span class="chip ${VCFG.email.enabled?'st-solved':'st-closed'}"><span class="cdot"></span>${VCFG.email.enabled?'Connected':'Off'}</span></div>
      <div class="setting-row"><div class="sl"><b>Policy</b><p>6-digit code · stored as a salted hash, never plaintext · destination always the contact record, shown masked</p></div>
        <div class="fgrid">
          <div class="field inline-sm"><label>expires</label><div style="display:flex;gap:6px;align-items:center"><input type="number" value="${VCFG.ttlMin}" min="1" max="60" style="width:56px" onchange="vcfgSet('ttlMin',this.value,this)"><span class="mini muted">min</span></div></div>
          <div class="field inline-sm"><label>attempts</label><input type="number" value="${VCFG.attempts}" min="1" max="5" style="width:56px" onchange="vcfgSet('attempts',this.value,this)"></div>
        </div></div>
      <div class="setting-row"><div class="sl"><b>Audit</b><p>Pass or fail, the outcome lands in the Audit Log always; this controls whether it's also posted to the ticket thread and tagged</p></div>
        <button class="rowbtn" onclick="vcfgTogglePost()">${VCFG.postToThread?'Disable thread posts':'Enable thread posts'}</button>
        <span class="chip ${VCFG.postToThread?'st-solved':'st-closed'}"><span class="cdot"></span>${VCFG.postToThread?'Posting to thread':'Audit Log only'}</span></div>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Channels</h3><span class="hint">how tickets arrive</span></div>
      <div class="setting-row"><div class="sl"><b>Microsoft Graph mail</b><p>${MAILBOXES.length} mailbox${MAILBOXES.length===1?'':'es'} (${MAILBOXES.filter(m=>m.type==='shared').length} shared, ${MAILBOXES.filter(m=>m.type==='licensed').length} licensed) · webhook subscriptions + 60s delta poll · outbound routed per ticket/board${can('manage_automations')?` — <a href="#" onclick="go('automations');return false" style="color:var(--brand)">authenticate &amp; manage in Automations</a>`:''}</p></div><span class="chip ${GRAPH_AUTH.connected?'st-solved':'st-closed'}"><span class="cdot"></span>${GRAPH_AUTH.connected?'Connected':'Not authenticated'}</span></div>
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Authentication</h3><span class="hint">who gets in, and as what</span></div>
      <div class="setting-row" style="align-items:flex-start"><div class="sl"><b>Microsoft Entra ID SSO</b>
          <div style="margin:8px 0 2px;max-width:560px">
            <div class="field inline-sm" style="margin-bottom:8px"><label>OIDC · tenant</label><input type="text" value="${esc(AUTH_CFG.tenant)}" class="in-mono" style="width:100%" onchange="authSet('tenant',this.value,this)"></div>
            <div class="field inline-sm" style="margin-bottom:8px"><label>client ID</label><input type="text" value="${esc(AUTH_CFG.clientId)}" placeholder="Graph app's ID by default" class="in-mono" style="width:100%" onchange="authSet('clientId',this.value,this)"></div>
            <div class="field inline-sm"><label>redirect URI</label><input type="text" value="${esc(AUTH_CFG.redirectUri)}" placeholder="https://…/auth/oidc/callback (blank = derive from request)" class="in-mono" style="width:100%" onchange="authSet('redirectUri',this.value,this)"></div>
          </div>
          <div class="mini muted" style="margin-bottom:4px">Sessions are shared with Ledger — one sign-in, both apps.</div>
          ${secretRow('entraSecret')}
          <div class="mini muted">Secrets live encrypted in the shared database — never in compose files or env vars; rotate here, both apps pick it up live.</div>
        </div>
        <button class="rowbtn" onclick="authToggleSSO()">${AUTH_CFG.ssoConnected?'Disconnect':'Connect'}</button>
        <span class="chip ${AUTH_CFG.ssoConnected?'st-solved':'st-closed'}"><span class="cdot"></span>${AUTH_CFG.ssoConnected?'Connected':'Off'}</span></div>
      <div class="setting-row" style="align-items:flex-start"><div class="sl"><b>Entra role mapping</b>
          <p style="margin-bottom:6px">${AUTH_CFG.roleMapping
            ? 'Security groups → roles, applied at each sign-in. Manual role edits in the Directory are overwritten at the user’s next sign-in.'
            : 'Disabled — every user’s role is assigned manually in the <b>Directory → Agents</b> card; Entra only authenticates.'}</p>
          <div style="${AUTH_CFG.roleMapping?'':'opacity:.45;pointer-events:none'}">
          ${state.roleDefs.filter(r=>r.active!==false).map(r=>`<div class="field inline-sm" style="margin:8px 0">
            <label>→ ${esc(r.name)}</label>
            <input type="text" value="${esc(r.entra)}" placeholder="SG-…" class="in-mono" style="width:200px" onchange="entraSet('${jsq(r.name)}',this.value,this)"></div>`).join('')}
          </div>
        </div>
        <button class="rowbtn" onclick="authToggleMapping()">${AUTH_CFG.roleMapping?'Disable':'Enable'}</button>
        <span class="chip ${AUTH_CFG.roleMapping?'st-solved':'st-closed'}"><span class="cdot"></span>${AUTH_CFG.roleMapping?'Automatic':'Manual'}</span></div>
      <div class="setting-row" style="align-items:flex-start"><div class="sl"><b>Local passwords &amp; MFA</b>
          <p>${AUTH_CFG.localPasswords?'Enabled — fallback credentials active alongside SSO. Passwords are argon2id-hashed; MFA is TOTP (authenticator app).':'Disabled — no separate credentials to phish or rotate.'} Break-glass admin lives in the vault.</p>
          ${AUTH_CFG.localPasswords?`
          <div style="margin:8px 0">
            <div class="field inline-sm"><label>MFA policy</label>
              <select style="width:auto" onchange="authSet('mfa',this.value,this)"><option value="required" ${AUTH_CFG.mfa==='required'?'selected':''}>Required (TOTP)</option><option value="optional" ${AUTH_CFG.mfa==='optional'?'selected':''}>Optional</option></select></div>
            <div class="mini muted" style="margin-top:4px">per-person passwords and MFA are reset in <a href="#" onclick="go('directory');return false" style="color:var(--brand)">Directory → Agents</a> — no email links, resets are admin-direct</div>
          </div>`:''}
        </div>
        <button class="rowbtn" onclick="authToggleLocal()">${AUTH_CFG.localPasswords?'Disable':'Enable'}</button>
        <span class="chip ${AUTH_CFG.localPasswords?'st-solved':'st-closed'}"><span class="cdot"></span>${AUTH_CFG.localPasswords?'On':'Off'}</span></div>
    </div>
  </div>`;
}
