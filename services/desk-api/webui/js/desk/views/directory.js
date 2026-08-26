/* ==========================================================================
   js/desk/views/directory.js — the shared control plane page: the roles
   matrix (rendered by roles.js), groups & membership (member chips + a
   type-to-search adder — toggleMembership in settings.js stays the ONE
   control for add and remove), activity types, the clients pointer, and the
   agents card: per-agent group multiCombo plus the auth panel — the
   hasPassword/mfa/mfaPending/mfaAt flags ride in on bootstrap's agent rows.
   Also owns the Entra CSV contact import (launched from a client page).
   Owns: viewDirectory · pwReset/mfaReset · authModal · mfaEnrollSelf/
   mfaConfirmSelf · entraParse · csvImportModal · csvPreview · csvImportGo.
   Endpoints: POST /auth/admin/set-password · POST /auth/admin/reset-mfa ·
   POST /auth/mfa/enroll · POST /auth/mfa/confirm ·
   POST /api/directory/contacts (one per fresh imported row).
   Invariants: password resets are admin-direct — the SERVER mints the temp
   password; it is shown ONCE, inside authModal (a shown-once credential must
   persist until dismissed, never a 4.2s toast) and never emailed.
   Self-service TOTP enrollment is two-phase: /auth/mfa/enroll mints a
   PENDING secret, /auth/mfa/confirm proves possession before it goes live.
   The CSV import dedupes on email and never overwrites an existing contact.
   The editors the cards call (agentModal/groupModal/typeModal, their saves,
   toggleMembership and setAgentGroups) live in views/settings.js; the roles
   matrix lives in views/roles.js.
   ========================================================================== */

function viewDirectory(){
  const pgA = paginate('dirAgents', AGENTS);
  return `
  <h3 style="margin:4px 0 10px;display:flex;align-items:center;gap:10px">Roles &amp; permissions ${can('manage_roles')?`<button class="btn sm" onclick="roleModal()">+ Add role</button>`:''}</h3>
  ${rolesSection()}
  <div class="section-gap"></div>
  <div class="grid g-2">
    <div class="card card-pad">
      <div class="card-head flush"><h3>Groups &amp; membership</h3><span class="hint">boards, routing and access scopes — shared</span></div>
      ${GROUPS.map(g=>{ const arch=isArch(g);
        const members = AGENTS.filter(a=>a.groups.includes(g.id));
        const addable = AGENTS.filter(a=>!a.groups.includes(g.id)).map(a=>({v:a.id,label:a.name,sub:a.email}));
        return `<div class="setting-row" style="align-items:flex-start;${arch?'opacity:.55':''}"><div class="sl" style="flex:1">
          <b>${esc(g.name)}</b>${arch?` <span class="chip st-closed"><span class="cdot"></span>Archived</span>`:''}
          <span class="mini muted" style="margin-left:6px">${members.length} member${members.length===1?'':'s'}</span>
          <div style="display:flex;gap:4px 6px;flex-wrap:wrap;margin-top:7px">
            ${members.map(a=>`<span class="chip tagchip">${esc(a.name)}${arch?'':`<button onclick="toggleMembership('${g.id}','${a.id}')" title="remove">×</button>`}</span>`).join('')||'<span class="mini muted">no members</span>'}
          </div>
          ${arch||!addable.length?'':`<div style="max-width:260px;margin-top:7px">${combo('gmAdd-'+g.id, addable, '', ()=>{ const v=document.getElementById('gmAdd-'+g.id).value; if(v) toggleMembership(g.id, v); }, '+ Add member — type to search…')}</div>`}
        </div>
        <button class="rowbtn" onclick="groupModal('${g.id}')">Rename</button>
        <button class="rowbtn" onclick="archiveGroup('${g.id}')">${arch?'Restore':'Archive'}</button></div>`;}).join('')}
      <button class="btn sm" style="margin-top:12px" onclick="groupModal()">+ Add group</button>
      <div class="mini muted" style="margin-top:8px">Membership drives ticket visibility here and client access in Ledger — one list, both apps.</div>
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
        ${pgA.slice.map(a=>`<div class="setting-row"><div class="sl" style="display:flex;gap:10px;align-items:center">${avatarOf(a)}<span><b>${esc(a.name)}</b></span><span style="display:inline-block;min-width:200px;vertical-align:middle">${multiCombo('agGrp-'+a.id, GROUPS.filter(g=>!isArch(g)||a.groups.includes(g.id)).map(g=>({v:g.id,label:g.name,archived:isArch(g)})), a.groups, 'setAgentGroups', 'Groups…')}</span></div>
          ${AUTH_CFG.localPasswords?`
            <span class="chip ${a.hasPassword?'st-solved':'st-closed'}" style="padding:1px 8px"><span class="cdot"></span>${a.hasPassword?'password':'no pw'}</span>
            <span class="chip ${a.mfa?'st-solved':(a.mfaPending?'st-hold':'st-closed')}" style="padding:1px 8px"><span class="cdot"></span>${a.mfa?'MFA':(a.mfaPending?'MFA pending':'no MFA')}</span>
            <button class="rowbtn" onclick="authModal('${a.id}')">Auth…</button>`:''}
          <select style="width:auto" onchange="setAgentRole('${a.id}',this.value)" title="${AUTH_CFG.roleMapping?'Entra mapping is ON — manual changes are overwritten at next sign-in':'Manual assignment — this IS the role'}">${state.roleDefs.filter(r=>(r.active!==false || r.name===a.role) && r.name!=='Customer').map(r=>`<option value="${esc(r.name)}" ${a.role===r.name?'selected':''} ${r.active===false?'disabled':''}>${esc(r.name)}${r.active===false?' (archived)':''}</option>`).join('')}</select>
          ${(can('manage_settings')||can('manage_roles'))&&a.id!==state.meId?`<button class="rowbtn" onclick="deactivateAgent('${a.id}')">Deactivate</button>`:''}</div>`).join('')}
        ${pagerBar(pgA)}
        ${can('manage_settings')||can('manage_roles')?`<button class="btn sm" style="margin-top:12px" onclick="agentModal()">+ Add person</button>`:''}
        <div class="mini muted" style="margin-top:8px">${AUTH_CFG.roleMapping?'Roles assigned automatically from Entra groups — the selects preview, but the mapping wins at sign-in.':'Entra mapping is off: these selects are the source of truth for each person’s role.'} Deactivated people can’t sign in and leave the pickers; their tickets and time stay. Re-adding the same email restores them.</div>
      </div>
    </div>
  </div>`;
}

/* ---- per-agent auth panel (build 13) --------------------------------------
   ONE surface for everything credential-shaped: password status + reset, MFA
   status + admin reset, and self-service TOTP enrollment. `temp` carries a
   freshly minted one-time password — it stays on screen until dismissed
   (never a toast; render.js removes those after 4.2s). `enroll` carries
   {secret, otpauth_uri} from mfaEnrollSelf. The modal lives outside the
   render() cycle, same scrim pattern as roleModal. */
function authModal(tid, temp, enroll){
  /* the reset endpoints need manage_roles — the panel used to render for
     manage_settings-only admins whose every action 403'd (audit) */
  if(!can('manage_roles')){ toast('Password/MFA resets need the manage_roles permission.'); return; }
  const a = agent(tid); if(!a) return;
  const m = document.getElementById('modal');
  const mfaStatus = a.mfa ? `enrolled ${a.mfaAt?fmtDT(a.mfaAt):''}`
                  : (a.mfaPending ? 'pending — code never confirmed' : 'not enrolled');
  m.innerHTML = `
    <div class="modal-head"><h3>Authentication — ${esc(a.name)}</h3><p>Local credentials for <span class="tape">${esc(a.email)}</span>. SSO sign-in is untouched by anything here.</p></div>
    <div class="modal-body">
      <div class="field"><label>Password</label>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="mini muted" style="flex:1">${a.hasPassword?'argon2id set':'SSO only — no local password'}</span>
          <button class="btn sm" onclick="pwReset('${a.id}')">${a.hasPassword?'Reset password':'Set password'}</button>
        </div>
        ${temp?`<div class="field" style="margin-top:10px"><label>Temporary password — shown ONCE, hand it over directly</label>
          <div style="display:flex;gap:8px"><input readonly id="authTemp" value="${esc(temp)}" onclick="this.select()" style="font-family:'IBM Plex Mono',monospace;flex:1">
          <button class="btn sm" onclick="const i=document.getElementById('authTemp');i.select();navigator.clipboard?navigator.clipboard.writeText(i.value).then(()=>toast('Copied.'),()=>toast('Copy failed — the field is selected, copy manually.')):toast('Clipboard unavailable — the field is selected, copy manually.')">Copy</button></div></div>`:''}
      </div>
      <div class="field" style="margin-top:14px"><label>MFA (authenticator app)</label>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="mini muted" style="flex:1">${mfaStatus}</span>
          ${(a.mfa||a.mfaPending)?`<button class="btn sm" onclick="mfaReset('${a.id}')">Reset MFA</button>`:''}
          ${a.id===state.meId&&!a.mfa&&!enroll?`<button class="btn sm" onclick="mfaEnrollSelf('${a.id}')">${a.mfaPending?'Restart enrollment':'Enroll'}</button>`:''}
        </div>
        ${enroll?`<div style="margin-top:10px;word-break:break-all"><span class="mini muted">Enter this secret in your authenticator app, or open the link on your phone:</span>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;margin-top:6px"><b>${esc(enroll.secret)}</b></div>
          <a href="${esc(enroll.otpauth_uri)}" class="mini" style="color:var(--brand)">${esc(enroll.otpauth_uri.slice(0,60))}…</a></div>`:''}
        ${a.id===state.meId&&!a.mfa&&(enroll||a.mfaPending)?`<div style="display:flex;gap:8px;margin-top:10px">
          <input type="text" id="mfaCode" inputmode="numeric" placeholder="6-digit code" style="width:140px">
          <button class="btn sm primary" onclick="mfaConfirmSelf('${a.id}')">Confirm</button></div>`:''}
      </div>
      <div class="field" style="margin-top:14px"><label>Entra (SSO) binding</label>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="mini muted" style="flex:1">If this person's Entra identity changed (tenant migration, offboard/rehire), clear the stale binding — their next SSO sign-in re-binds the new one.</span>
          <button class="btn sm" onclick="entraUnbind('${a.id}')">Unbind Entra ID</button>
        </div>
      </div>
    </div>
    <div class="modal-foot"><span class="mini muted" style="margin-right:auto">MFA policy is “${esc(AUTH_CFG.mfa||'optional')}” — change it in Settings → Authentication.</span><button class="btn ghost" onclick="closeModal()">Close</button></div>`;
  document.getElementById('scrim').classList.add('open');
}

/* ---- credential resets (admin-direct, §10.16) ----------------------------
   The server mints the temp password, revokes sessions and sets must-change;
   the response is the ONLY place the password ever appears — no email. */
function entraUnbind(tid){
  if(!can('manage_roles')) return;
  const a=agent(tid); if(!a) return;
  if(!confirm(`Clear ${a.name}'s Entra binding? Their next SSO sign-in with ${a.email} re-binds the new identity. Local password/MFA are untouched.`)) return;
  $fetch('/auth/admin/unbind-entra',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:a.email})})
    .then(async r=>{ const d=await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      toast('Entra binding cleared — next SSO sign-in re-binds.'); });
}
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
      render();
      authModal(tid, d.temp_password);
    });
}
function mfaReset(tid){
  const a = agent(tid); if(!a) return;
  $fetch('/auth/admin/reset-mfa',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({email:a.email})})
    .then(async r=>{
      if(!r.ok) return oops(await r.json().catch(()=>0));
      a.mfa = false; a.mfaPending = false;
      log('MFA reset', `${a.name} · by ${state.user.name} · TOTP revoked — they enroll at next sign-in (required policy) or from this panel`);
      toast(`${a.name.split(' ')[0]}’s MFA cleared — they enroll at next sign-in or from this panel.`);
      render();
      authModal(tid);
    });
}

/* ---- self-service TOTP (two-phase; sessions.py) ---------------------------
   enroll mints a PENDING secret (409s if MFA is already live — admin reset
   is the only replacement path); confirm proves possession and flips it
   live. Only my own row gets these controls. */
function mfaEnrollSelf(tid){
  const a = agent(tid); if(!a || a.id!==state.meId) return;
  $fetch('/auth/mfa/enroll',{method:'POST'}).then(async r=>{
    const d = await r.json().catch(()=>({}));
    if(!r.ok) return oops(d);
    a.mfaPending = true;
    log('MFA enrollment started', `${a.name} · pending code confirmation`);
    render();
    authModal(tid, null, d);          /* {secret, otpauth_uri} → modal shows secret + code input */
  });
}
function mfaConfirmSelf(tid){
  const a = agent(tid); if(!a || a.id!==state.meId) return;
  const code = (document.getElementById('mfaCode')||{}).value||'';
  if(!code.trim()){ toast('Enter the 6-digit code first.'); return; }
  $fetch('/auth/mfa/confirm',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({code:code.trim()})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      a.mfa = true; a.mfaPending = false;
      log('MFA enrolled', `${a.name} · self-service, code confirmed`);
      toast('MFA is on for your account.');
      closeModal(); render(); });
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
