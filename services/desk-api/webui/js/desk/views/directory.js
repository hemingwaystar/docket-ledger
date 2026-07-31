/* ==========================================================================
   js/desk/views/directory.js — the shared control plane page: the roles
   matrix (rendered by roles.js), groups & membership, activity types, the
   clients pointer, and the agents card with live credential badges — the
   hasPassword/mfa flags ride in on bootstrap's agent rows. Also owns the
   Entra CSV contact import (launched from a client page).
   Owns: viewDirectory · pwReset/mfaReset · entraParse · csvImportModal ·
   csvPreview · csvImportGo.
   Endpoints: POST /auth/admin/set-password · POST /auth/admin/reset-mfa ·
   POST /api/directory/contacts (one per fresh imported row).
   Invariants: password resets are admin-direct — the SERVER mints the temp
   password, it is shown ONCE here and never emailed. The CSV import dedupes
   on email and never overwrites an existing contact. The editors the cards
   call (agentModal/groupModal/typeModal and their saves) live in
   views/settings.js; the roles matrix lives in views/roles.js.
   ========================================================================== */

function viewDirectory(){
  return `
  <div class="notice info" style="margin-bottom:16px">${icon(IC.client)}<div><b>This is the shared control plane.</b> Clients, groups, agents, activity types and all role permissions are one set of records in the shared database — Docket, Ledger and any future app read and write the same rows. Every change here broadcasts to Ledger live; nothing syncs, because there is nothing to sync <i>from</i>.</div></div>
  <h3 style="margin:4px 0 10px;display:flex;align-items:center;gap:10px">Roles &amp; permissions <button class="btn sm" onclick="roleModal()">+ Add role</button></h3>
  ${rolesSection()}
  <div class="section-gap"></div>
  <div class="grid g-2">
    <div class="card card-pad">
      <div class="card-head flush"><h3>Groups &amp; membership</h3><span class="hint">boards, routing and access scopes — shared</span></div>
      ${GROUPS.map(g=>{ const arch=isArch(g); return `<div class="setting-row" style="align-items:flex-start;${arch?'opacity:.55':''}"><div class="sl" style="flex:1">
          <b>${esc(g.name)}</b>${arch?` <span class="chip st-closed"><span class="cdot"></span>Archived</span>`:''}
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:7px">${AGENTS.map(a=>`<label class="mini" style="display:inline-flex;gap:5px;align-items:center;text-transform:none;letter-spacing:0;cursor:pointer"><input type="checkbox" ${a.groups.includes(g.id)?'checked':''} ${arch?'disabled':''} onchange="toggleMembership('${g.id}','${a.id}')" style="width:auto;accent-color:var(--brand)">${esc(a.name.split(' ')[0])}</label>`).join('')}</div>
        </div>
        <button class="rowbtn" onclick="groupModal('${g.id}')">Rename</button>
        <button class="rowbtn" onclick="archiveGroup('${g.id}')">${arch?'Restore':'Archive'}</button></div>`;}).join('')}
      <button class="btn sm" style="margin-top:12px" onclick="groupModal()">+ Add group</button>
      <div class="mini muted" style="margin-top:8px">Membership drives ticket visibility here and client access in Ledger — one checkbox, both apps.</div>
    </div>
    <div>
      <div class="card card-pad">
        <div class="card-head flush"><h3>Activity types</h3><span class="hint">the timer logs against these — shared</span></div>
        ${ATYPES.filter(x=>x.name!=='Unclassified').map(x=>{ const arch=isArch(x); return `<div class="setting-row" ${arch?'style="opacity:.55"':''}><div class="sl"><b>${esc(x.name)}</b>${arch?' <span class="chip st-closed"><span class="cdot"></span>Archived</span>':''}<p>${x.billable?'billable — rate set in Ledger':'non-billable'}</p></div>
          <button class="rowbtn" onclick="typeModal('${x.id}')">Rename</button>
          <button class="rowbtn" onclick="archiveType('${x.id}')">${arch?'Restore':'Archive'}</button></div>`;}).join('')}
        <div class="setting-row" style="opacity:.65"><div class="sl"><b>Unclassified</b><p>sentinel — where unlabelled time parks; blocks period close in Ledger until reclassified</p></div></div>
        <button class="btn sm" style="margin-top:12px" onclick="typeModal()">+ Add type</button>
      </div>
      <div class="section-gap"></div>
      <div class="card card-pad">
        <div class="card-head flush"><h3>Clients</h3><span class="hint">shared directory</span></div>
        <div class="mini" style="margin-bottom:8px">${CLIENTS.filter(c=>c.status!=='archived').length} active · ${CLIENTS.filter(c=>c.status==='archived').length} archived — created or edited in the Clients tab, visible in Ledger the moment they're saved, with billing defaults applied there.</div>
        <button class="btn sm" onclick="go('clients')">Manage in Clients →</button>
      </div>
      <div class="section-gap"></div>
      <div class="card card-pad">
        <div class="card-head flush"><h3>Agents</h3><span class="hint">shared — sign-in matches by email</span></div>
        ${AGENTS.map(a=>`<div class="setting-row"><div class="sl" style="display:flex;gap:10px;align-items:center">${avatarOf(a)}<span><b>${esc(a.name)}</b><p style="margin:2px 0 0">${a.groups.map(gid=>esc(grp(gid)?.name||gid)).join(' · ')}</p></span></div>
          ${AUTH_CFG.localPasswords?`
            <span class="chip ${a.hasPassword?'st-solved':'st-closed'}" style="padding:1px 8px"><span class="cdot"></span>${a.hasPassword?'password':'no pw'}</span>
            <button class="rowbtn" onclick="pwReset('${a.id}')">${a.hasPassword?'Reset pw':'Set pw'}</button>
            <span class="chip ${a.mfa?'st-solved':'st-closed'}" style="padding:1px 8px"><span class="cdot"></span>${a.mfa?'MFA':'no MFA'}</span>
            ${a.mfa?`<button class="rowbtn" onclick="mfaReset('${a.id}')">Reset MFA</button>`:''}`:''}
          <select style="width:auto" onchange="setAgentRole('${a.id}',this.value)" title="${AUTH_CFG.roleMapping?'Entra mapping is ON — manual changes are overwritten at next sign-in':'Manual assignment — this IS the role'}">${state.roleDefs.filter(r=>r.active!==false && r.name!=='Customer').map(r=>`<option ${a.role===r.name?'selected':''}>${esc(r.name)}</option>`).join('')}</select>
          ${can('manage_settings')&&a.id!==state.meId?`<button class="rowbtn" onclick="deactivateAgent('${a.id}')">Deactivate</button>`:''}</div>`).join('')}
        ${can('manage_settings')?`<button class="btn sm" style="margin-top:12px" onclick="agentModal()">+ Add person</button>`:''}
        <div class="mini muted" style="margin-top:8px">${AUTH_CFG.roleMapping?'Roles assigned automatically from Entra groups — the selects preview, but the mapping wins at sign-in.':'Entra mapping is off: these selects are the source of truth for each person’s role.'} Deactivated people can’t sign in and leave the pickers; their tickets and time stay. Re-adding the same email restores them.</div>
      </div>
    </div>
  </div>`;
}

/* ---- credential resets (admin-direct, §10.16) ----------------------------
   The server mints the temp password, revokes sessions and sets must-change;
   the response is the ONLY place the password ever appears — no email. */
function pwReset(tid){
  const a = agent(tid); if(!a) return;
  $fetch('/auth/admin/set-password',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:a.email})})
    .then(async r=>{
      const d = await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      const was = a.hasPassword;
      a.hasPassword = true;
      log(was?'Password reset':'Password set', `${a.name} · by ${state.user.name} · temporary password issued in-app (shown once), must change at next sign-in — no email sent`);
      toast(`${a.name.split(' ')[0]}’s temporary password (shown ONCE — hand it over directly): ${d.temp_password}`);
      render();
    });
}
function mfaReset(tid){
  const a = agent(tid); if(!a) return;
  $fetch('/auth/admin/reset-mfa',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:a.email})})
    .then(async r=>{
      if(!r.ok) return oops(await r.json().catch(()=>0));
      a.mfa = false;
      log('MFA reset', `${a.name} · by ${state.user.name} · TOTP secret revoked — re-enrolls at next local sign-in`);
      toast(`${a.name.split(' ')[0]}’s MFA cleared — they re-enroll at next sign-in.`);
      render();
    });
}

/* ---- Entra CSV contact import --------------------------------------------
   Accepts the export from Entra admin center → Users → Download users (or
   any CSV with recognizable headers — ENTRA_COLMAP). Dedupes on email. */
function entraParse(text){
  const rows = parseCSV(text.trim());
  if(rows.length<2) return { err:'Need a header row plus at least one user.' };
  const hdr = rows[0].map(h=>h.toLowerCase().replace(/[^a-z]/g,''));
  const col = {};
  for(const [field, names] of Object.entries(ENTRA_COLMAP)){ const ix = hdr.findIndex(h=>names.includes(h)); if(ix>=0) col[field]=ix; }
  if(col.email===undefined) return { err:'No email column found — expected one of: mail, userPrincipalName, email.' };
  if(col.name===undefined)  return { err:'No name column found — expected displayName / name.' };
  const users = rows.slice(1).map(r=>({
    name:(r[col.name]||'').trim(), email:(r[col.email]||'').trim().toLowerCase(),
    title:col.title!==undefined?(r[col.title]||'').trim():'', dept:col.dept!==undefined?(r[col.dept]||'').trim():'',
    phone:col.phone!==undefined?(r[col.phone]||'').replace(/[\[\]"]/g,'').trim():'', mobile:col.mobile!==undefined?(r[col.mobile]||'').trim():'',
  })).filter(u=>u.email && u.name);
  return { users };
}
function csvImportModal(cid){
  if(!can('add_contacts') && !can('manage_clients')) return;
  const c = client(cid);
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Import contacts — ${esc(c.name)}</h3><p>Entra admin center → Users → <b>Download users</b>, then paste the CSV or choose the file. Recognized columns: displayName, mail / userPrincipalName, jobTitle, department, businessPhones, mobilePhone — extras are ignored. Existing emails are skipped, never overwritten.</p></div>
    <div class="modal-body">
      <input type="file" accept=".csv,text/csv" style="margin-bottom:8px" onchange="const f=this.files[0]; if(f){ const r=new FileReader(); r.onload=()=>{ document.getElementById('csvText').value=r.result; csvPreview('${cid}'); }; r.readAsText(f); }">
      <textarea id="csvText" rows="7" style="width:100%;font-family:'IBM Plex Mono',monospace;font-size:11.5px" placeholder="displayName,userPrincipalName,jobTitle,department&#10;First Last,user@example.com,Office Manager,Admin" oninput="csvPreview('${cid}')"></textarea>
      <div id="csvPrev" class="mini muted" style="margin-top:8px">Paste or choose a file to preview.</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" id="csvGo" disabled onclick="csvImportGo('${cid}')">Import</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function csvPreview(cid){
  const c = client(cid);
  const out = document.getElementById('csvPrev'); const go = document.getElementById('csvGo');
  const r = entraParse(document.getElementById('csvText').value);
  if(r.err){ out.innerHTML = `<span style="color:var(--void)">${esc(r.err)}</span>`; go.disabled = true; return; }
  const have = new Set(c.contacts.map(p=>p.email.toLowerCase()));
  const fresh = r.users.filter(u=>!have.has(u.email));
  const skip = r.users.length - fresh.length;
  out.innerHTML = `<b>${r.users.length}</b> users parsed · <b style="color:var(--brand)">${fresh.length} new</b>${skip?` · ${skip} already exist (skipped)`:''}
    ${fresh.slice(0,5).map(u=>`<div style="margin-top:4px">→ ${esc(u.name)} <span class="tape">${esc(u.email)}</span>${u.title?` · ${esc(u.title)}`:''}</div>`).join('')}${fresh.length>5?`<div style="margin-top:4px">… and ${fresh.length-5} more</div>`:''}`;
  go.disabled = fresh.length===0;
}
let nextImportIx = 1;
function csvImportGo(cid){
  const c = client(cid);
  const r = entraParse(document.getElementById('csvText').value);
  if(r.err) return;
  const have = new Set(c.contacts.map(p=>p.email.toLowerCase()));
  const fresh = r.users.filter(u=>!have.has(u.email));
  if(!fresh.length) return;
  fresh.forEach(u=>{
    c.contacts.push({ id:'px'+(nextImportIx++), name:u.name, title:u.title, dept:u.dept, email:u.email, phone:u.phone, mobile:u.mobile, fax:'', pref:'email', notes:'Imported from Entra CSV.', active:true });
  });
  log('Contacts imported from Entra CSV', `${c.name} · ${fresh.length} added, ${r.users.length-fresh.length} skipped (already existed) · by ${state.user.name}`);
  toast(`${fresh.length} contact${fresh.length===1?'':'s'} imported into ${c.name}.`);
  closeModal(); render();
  Promise.all(fresh.map(u=>$fetch('/api/directory/contacts',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client:cid, name:u.name, email:u.email,
        title:u.title||'', department:u.dept||'', phone:u.phone||'',
        mobile:u.mobile||''})})))
    .then(async rs=>{ const bad=rs.find(x=>!x.ok);
      if(bad) return oops(await bad.json().catch(()=>0));
      setTimeout(()=>hydrate(),500); });           /* swap temp ids for server rows */
}
