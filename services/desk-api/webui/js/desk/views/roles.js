/* ==========================================================================
   js/desk/views/roles.js — Roles & access matrix (rendered inside Directory).
   Owns: rolesSection() · toggleRole · togglePerm (one path for BOTH apps'
   permissions — Ledger ids are l_*-prefixed) · applyPreset · archiveRole ·
   deleteRole · roleModal · saveRole · entraSet (the Entra-mapping inputs in
   Settings call it) · LEDGER_CATALOG (static vocabulary — mirrors the
   shared.permissions ledger rows 1:1; the checked state comes from
   state.roleDefs[].perms).
   Endpoints: POST /api/directory/roles · PATCH /api/directory/roles/{name}
   (note / rename / entra_group / active / add[] / remove[]) ·
   DELETE /api/directory/roles/{name}.
   Invariants: custom roles archive/restore (PATCH {active} — archived =
   hidden from pickers, holders keep it until reassigned) and hard-delete
   (DELETE — the ONE user-approved exception to no-DELETE, migration 0030);
   core roles keep their names (server 409s a rename; refused client-side
   too) and stay active. Delete is refused while any agent — including
   deactivated ones — still holds the role (server pre-check + 0030 guard
   trigger). Permission changes apply at each agent's next sign-in —
   sessions snapshot perms.
   ========================================================================== */

function toggleRole(name){ state.openRole = state.openRole===name? null : name; render(); }

/* Ledger's permission catalog, mirrored so the Directory can manage BOTH
   apps' matrices from one screen. Grants live in shared.role_permissions
   either way — one PATCH path serves both columns. */
const LEDGER_CATALOG = [
  {id:'l_view_own',       label:'View own time',                        group:'Visibility'},
  {id:'l_view_all',       label:"View all technicians' time",           group:'Visibility'},
  {id:'l_see_amounts',    label:'See billed rates & amounts',           group:'Visibility'},
  {id:'l_view_clients',   label:'View client billing breakdowns',       group:'Clients'},
  {id:'l_all_clients',    label:'Access every client',                  group:'Clients'},
  {id:'l_edit_own',       label:'Classify & edit own time',             group:'Editing'},
  {id:'l_edit_all',       label:"Edit anyone's time",                   group:'Editing'},
  {id:'l_submit',         label:'Submit time for review',               group:'Editing'},
  {id:'l_edit_submitted', label:'Adjust submitted (pre-approval) time', group:'Editing'},
  {id:'l_approve',        label:'Approve timesheets & billing periods', group:'Billing & admin'},
  {id:'l_export',         label:'Export approved periods',              group:'Billing & admin'},
  {id:'l_manage_clients', label:'Manage client billing & access',       group:'Billing & admin'},
  {id:'l_manage_types',   label:'Manage activity types & rates',        group:'Billing & admin'},
  {id:'l_view_audit',     label:'View the Ledger audit log',            group:'Billing & admin'},
  {id:'l_manage_settings',label:'Manage Ledger settings',               group:'Billing & admin'},
];

/* Assets' permission catalog (a_*-prefixed, migration 0037) — same
   one-PATCH-path management as the Ledger block. */
const ASSETS_CATALOG = [
  {id:'a_view',            label:'View the Assets app',                 group:'Visibility'},
  {id:'a_see_costs',       label:'See purchase & contract costs',       group:'Visibility'},
  {id:'a_manage_assets',   label:'Add & edit assets',                   group:'Inventory'},
  {id:'a_manage_licenses', label:'Manage software & licenses',          group:'Inventory'},
  {id:'a_manage_contracts',label:'Manage contracts & warranties',       group:'Inventory'},
  {id:'a_post_charges',    label:'Post charges to Ledger',              group:'Billing'},
  {id:'a_export_csv',      label:'Export & copy CSV data',              group:'Admin'},
  {id:'a_view_audit',      label:'View the Assets audit log',           group:'Admin'},
  {id:'a_manage_settings', label:'Manage Assets settings',              group:'Admin'},
];
function permLabel(pid){
  const p = PERM_CATALOG.find(x=>x.id===pid) || LEDGER_CATALOG.find(x=>x.id===pid)
    || ASSETS_CATALOG.find(x=>x.id===pid);
  return p? p.label : pid;
}

function togglePerm(name, pid){
  const r = state.roleDefs.find(x=>x.name===name); if(!r) return;
  const had = r.perms.has(pid);
  if(had) r.perms.delete(pid); else r.perms.add(pid);
  log('Role updated', `${name} · ${r.perms.has(pid)?'granted':'revoked'} “${permLabel(pid)}” — applies at next sign-in`);
  render();
  if(r.perms.has(pid)===had) return;                    /* diff-guard (row 21) */
  const payload = r.perms.has(pid)? {add:[pid]} : {remove:[pid]};
  $fetch('/api/directory/roles/'+encodeURIComponent(name),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
}

/* Presets cover the Docket matrix; l_* AND a_* grants ride untouched. The
   whole diff lands in ONE PATCH — add[]/remove[] batched. */
function applyPreset(name, preset){
  const r = state.roleDefs.find(x=>x.name===name); if(!r) return;
  const target = new Set(PRESETS[preset]);
  const add    = [...target].filter(p=>!r.perms.has(p));
  const remove = [...r.perms].filter(p=>!p.startsWith('l_') && !p.startsWith('a_') && !target.has(p));
  if(!add.length && !remove.length) return;             /* diff-guard (row 21) */
  remove.forEach(p=>r.perms.delete(p));
  add.forEach(p=>r.perms.add(p));
  log('Role preset applied', `${name} ← ${preset}`);
  render();
  $fetch('/api/directory/roles/'+encodeURIComponent(name),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({add, remove})})
    .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
}

/* ---- lifecycle: archive/restore (PATCH {active}) and hard delete (0030).
   Client guards mirror the server's: core roles are untouchable; delete is
   member-gated here on ACTIVE members only — deactivated holders are
   invisible to the UI (bootstrap agents ride WHERE a.active), so the server
   409 names the real count and the remedy, and oops() rehydrates the row
   back (the checkbox-truth pattern, bug-#30 class). */
function archiveRole(name){
  if(!can('manage_roles')) return;
  const r = state.roleDefs.find(x=>x.name===name); if(!r || r.core) return;
  const to = r.active===false;                       /* restoring? */
  r.active = to;
  log(to?'Role restored':'Role archived', `${name} · ${to?'back in the pickers':'hidden from pickers — current holders keep it until reassigned'}`);
  toast(`Role “${name}” ${to?'restored':'archived'}.`);
  render();
  $fetch('/api/directory/roles/'+encodeURIComponent(name),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:to})})
    .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
}
function deleteRole(name){
  if(!can('manage_roles')) return;
  const i = state.roleDefs.findIndex(x=>x.name===name);
  const r = state.roleDefs[i]; if(!r || r.core) return;
  /* live count, not the mapIn snapshot — setAgentRole mutates a.role without
     recomputing r.members, and the 409 remedy is exactly that reassign flow */
  const members = AGENTS.filter(a=>a.role===name).length;
  if(members>0){ toast(`${members} member${members===1?'':'s'} still hold “${name}” — reassign them first.`); return; }
  if(!confirm(`Delete role “${name}” permanently?\nIts permission grants go with it. The server refuses if any agent — including deactivated ones — still holds it.`)) return;
  state.roleDefs.splice(i,1);
  if(state.openRole===name) state.openRole=null;
  log('Role deleted', `${name} · hard-deleted — the audit log keeps its history`);
  toast(`Role “${name}” deleted.`);
  render();
  $fetch('/api/directory/roles/'+encodeURIComponent(name),{method:'DELETE'})
    .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
}

function roleModal(name){
  if(!can('manage_roles')&&!can('manage_settings')) return;
  const r0 = name? state.roleDefs.find(r=>r.name===name) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${name?'Edit role — '+esc(name):'Add role'}</h3><p>Roles map 1:1 to Entra security groups (e.g. <span class="tape">SG-Desk-${esc((name||'NewRole').replace(/\s+/g,''))}</span>). ${name?(r0.core?'Core roles keep their names — the description is editable.':'Rename and description apply in both apps.'):'New roles start with no permissions — grant them from the matrix or a preset after saving.'}</p></div>
    <div class="modal-body">
      <div class="field"><label>Role name</label><input type="text" id="rlName" value="${esc(r0.name||'')}" ${r0.core?'readonly':''} placeholder="e.g. Billing Reviewer"></div>
      <div class="field"><label>Description</label><input type="text" id="rlNote" value="${esc(r0.note||'')}" placeholder="What this role is for"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveRole('${jsq(name||'')}')">${name?'Save role':'Add role'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById(r0.core?'rlNote':'rlName').focus();
}

function saveRole(oldName){
  const name = document.getElementById('rlName').value.trim();
  const note = document.getElementById('rlNote').value.trim();
  if(!name){ toast('The role needs a name.'); return; }
  if(name!==oldName && state.roleDefs.some(r=>r.name===name)){ toast('A role with that name already exists.'); return; }
  if(oldName){
    const r = state.roleDefs.find(x=>x.name===oldName); if(!r) return;
    if(r.core && name!==oldName){ toast('Core roles keep their names — add a custom role instead.'); return; }
    const changed = name!==oldName || note!==r.note;
    if(name!==oldName){
      log('Role renamed', `${oldName} → ${name} — both apps`);
      if(state.openRole===oldName) state.openRole=name;
    } else if(note!==r.note){ log('Role description updated', name); }
    r.name=name; r.note=note;
    toast(`Role “${name}” saved — applies in both apps.`);
    closeModal(); render();
    if(!changed) return;                                /* diff-guard (row 21) */
    const payload = {note}; if(name!==oldName) payload.rename=name;
    $fetch('/api/directory/roles/'+encodeURIComponent(oldName),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
    return;
  }
  state.roleDefs.push({ name, note, perms:new Set(), members:0, core:false, entra:'', active:true });
  log('Role added', `${name} — grant permissions in the matrix; assign people via the matching Entra group`);
  toast(`Role “${name}” saved — applies in both apps.`);
  closeModal(); render();
  $fetch('/api/directory/roles',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({name, note})})
    .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
}

/* Entra group ↔ role mapping — the inputs live on the Settings page's
   Authentication card and render roleDefs[].entra */
function entraSet(role, v, srcEl){
  const r = state.roleDefs.find(x=>x.name===role); if(!r) return;
  const was = r.entra||'', next = v.trim();
  if(next===was) return;                                /* diff-guard (row 21) */
  r.entra = next;
  log('Role mapping changed', `${role}: ${was||'—'} → ${next||'—'} · applies at next sign-in`);
  commitRender(srcEl);
  $fetch('/api/directory/roles/'+encodeURIComponent(role),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({entra_group:next})})
    .then(async r2=>{ if(!r2.ok) return oops(await r2.json().catch(()=>0)); });
}

function rolesSection(){
  const groups  = [...new Set(PERM_CATALOG.map(p=>p.group))];
  const lgroups = [...new Set(LEDGER_CATALOG.map(p=>p.group))];
  const agroups = [...new Set(ASSETS_CATALOG.map(p=>p.group))];
  const total   = ALL_PERMS.length + LEDGER_CATALOG.length + ASSETS_CATALOG.length;
  return `
  <div class="notice info" style="margin-bottom:14px">${icon(IC.shield)}<div><b>All RBAC lives here.</b> One role list, three permission matrices — what each role can do in <b>Docket</b>, in <b>Ledger</b> and in <b>Assets</b> — managed in one place and mapped from the same Entra security groups. Changes apply at each agent’s next sign-in; the other apps’ Settings pages point back here.</div></div>
  ${state.roleDefs.map(r=>{
    const open = state.openRole===r.name;
    const arch = r.active===false;
    const mem  = AGENTS.filter(a=>a.role===r.name).length; /* live — r.members is a hydrate snapshot */
    return `<div class="role-card ${open?'open':'collapsed'}" ${arch?'style="opacity:.55"':''}>
      <div class="role-card-head">
        <div class="role-card-toggle" onclick="toggleRole('${jsq(r.name)}')">
          <span class="role-caret">▶</span>
          <div style="min-width:0"><b style="font-size:14px">${esc(r.name)}</b>
          <div class="mini muted">${esc(r.note)} · ${mem} member${mem===1?'':'s'} · ${r.perms.size}/${total} permissions</div></div>
        </div>
        <span class="chip ${r.perms.has('view_all')?'st-open':'st-closed'}"><span class="cdot"></span>${r.perms.has('view_all')?'sees all tickets':'scoped view'}</span>
        ${arch?'<span class="chip st-closed"><span class="cdot"></span>Archived</span>':''}
        <button class="rowbtn" onclick="event.stopPropagation();roleModal('${jsq(r.name)}')">${r.core?'Edit':'Rename'}</button>
        ${r.core||!can('manage_roles')?'':`<button class="rowbtn" onclick="event.stopPropagation();archiveRole('${jsq(r.name)}')">${arch?'Restore':'Archive'}</button>
        <button class="rowbtn" onclick="event.stopPropagation();deleteRole('${jsq(r.name)}')">Delete</button>`}
      </div>
      ${open? `<div class="perm-grid">
        ${groups.map(g=>`<div class="perm-col"><div class="perm-group">${g}</div>
          ${PERM_CATALOG.filter(p=>p.group===g).map(p=>`
            <label class="perm ${r.perms.has(p.id)?'on':''}"><input type="checkbox" ${r.perms.has(p.id)?'checked':''} onchange="togglePerm('${jsq(r.name)}','${p.id}')">${esc(p.label)}</label>`).join('')}
        </div>`).join('')}
      </div>
      <div class="role-presets"><span class="mini muted">Reset to preset:</span>
        ${Object.keys(PRESETS).map(k=>`<button class="btn sm ghost" onclick="applyPreset('${jsq(r.name)}','${k}')">${k}</button>`).join('')}
      </div>
      <div style="border-top:1px dashed var(--line);margin:0 16px;padding:12px 0 4px"><span class="mini muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600">Ledger permissions</span></div>
      <div class="perm-grid" style="padding-top:4px">
        ${lgroups.map(g=>`<div class="perm-col"><div class="perm-group">${g}</div>
          ${LEDGER_CATALOG.filter(p=>p.group===g).map(p=>`
            <label class="perm ${r.perms.has(p.id)?'on':''}"><input type="checkbox" ${r.perms.has(p.id)?'checked':''} onchange="togglePerm('${jsq(r.name)}','${p.id}')">${esc(p.label)}</label>`).join('')}
        </div>`).join('')}
      </div>
      <div style="border-top:1px dashed var(--line);margin:0 16px;padding:12px 0 4px"><span class="mini muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600">Assets permissions</span></div>
      <div class="perm-grid" style="padding-top:4px">
        ${agroups.map(g=>`<div class="perm-col"><div class="perm-group">${g}</div>
          ${ASSETS_CATALOG.filter(p=>p.group===g).map(p=>`
            <label class="perm ${r.perms.has(p.id)?'on':''}"><input type="checkbox" ${r.perms.has(p.id)?'checked':''} onchange="togglePerm('${jsq(r.name)}','${p.id}')">${esc(p.label)}</label>`).join('')}
        </div>`).join('')}
      </div>
      `:''}
    </div>`;
  }).join('')}`;
}
