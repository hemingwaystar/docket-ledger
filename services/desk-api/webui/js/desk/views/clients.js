/* ==========================================================================
   js/desk/views/clients.js — the shared client directory (billing lives in
   Ledger; both apps read the same shared.clients / shared.contacts tables).
   Owns: viewClients · viewClient · clfNorm/setCLFSt/setCLFTag/setCLFOwner/
   setCLFQ/clientTicketRows (the client-page ticket filter bar over state.clf;
   openClient in render.js resets clf on every client switch) ·
   exportClientTicketsCSV/copyClientTicketsCSV · clientModal/saveClient ·
   setClientStatus (archive/restore) · contactFields/readContactFields ·
   editContactModal/saveContactEdit · saveContact (the add-contact save;
   addContactModal itself lives in newticket.js beside the ticket-draft flow).
   Endpoints: POST /api/directory/clients ·
   PATCH /api/directory/clients/{id} · POST /api/directory/contacts ·
   PATCH /api/directory/contacts/{id}.
   Invariants: archive-only, no delete. Every save mutates local state first,
   then mirrors, then rehydrates — oops() on refusal. Rows created here carry
   a local id until hydrate() brings the server uuid back; srvId() tells the
   two apart, so edits never PATCH an id the server has yet to mint.
   ========================================================================== */

function viewClients(){
  const rows = CLIENTS.slice().sort((a,b)=> (a.status==='archived')-(b.status==='archived'));
  const pg = paginate('clients', rows);
  return `
  ${can('manage_clients')?`<div class="toolbar"><span class="spacer"></span><button class="btn primary" onclick="clientModal()">${icon(IC.plus)}New client</button></div>`:''}
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Client</th><th>Contacts</th><th class="right">Open</th><th class="right">Total</th><th class="right">Hours logged</th><th></th></tr></thead>
      <tbody>${pg.slice.map(c=>{
        const arch = c.status==='archived';
        const ts = state.tickets.filter(t=>t.clientId===c.id);
        const open = ts.filter(t=>!isDone(t)).length;
        const hrs = ts.reduce((a,t)=>a+timeTotal(t),0);
        const live = c.contacts.filter(p=>p.active!==false);
        return `<tr class="clickable" onclick="openClient('${c.id}')" ${arch?'style="opacity:.55"':''}>
          <td><div class="cell-title">${esc(c.name)} ${arch?`<span class="chip st-closed" style="margin-left:6px"><span class="cdot"></span>Archived</span>`:''}</div><div class="cell-meta">@${esc(c.domain)} · ${esc(c.city)}, ${esc(c.st)}${c.industry?` · ${esc(c.industry)}`:''}</div></td>
          <td class="mini" style="padding-top:13px">${live.map(p=>esc(p.name)).join(' · ')||'—'}</td>
          <td class="num">${open||'—'}</td>
          <td class="num">${ts.length}</td>
          <td class="num">${can('see_billing')? `<span class="tape">${fmtHours(hrs)}</span>`:'·'}</td>
          <td class="right">${can('see_billing')&&!arch?`<button class="rowbtn" onclick="event.stopPropagation();openLedger()">Billing → Ledger</button>`:''}</td>
        </tr>`;}).join('')}</tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function viewClient(){
  const c = client(state.clientId);
  if(!c) return '';
  const arch = c.status==='archived';
  const ts = state.tickets.filter(t=>t.clientId===c.id && ticketVisible(t)).sort((a,b)=>b.updatedAt-a.updatedAt);
  const open = ts.filter(t=>!isDone(t));
  const hrs = ts.reduce((a,t)=>a+timeTotal(t),0);
  const fts = clientTicketRows(c);                 /* stat tiles stay UNFILTERED (ts) */
  const pgT = paginate('clientTickets:'+c.id, fts);
  const pgC = paginate('contacts:'+c.id, c.contacts);
  const kv = (k,v,mono) => v? `<div class="setting-row" style="padding:7px 0"><div class="sl"><p style="margin:0">${k}</p></div><span class="${mono?'tape ':''}mini" style="text-align:right">${v}</span></div>`:'';
  const contactRow = p => {
    const off = p.active===false;
    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line);${off?'opacity:.5':''}">
      ${avatarOf({name:p.name,initials:p.name.split(' ').map(w=>w[0]).slice(0,2).join('')})}
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:500">${esc(p.name)} <span class="mini muted">· ${esc(p.title)}${p.dept?` · ${esc(p.dept)}`:''}</span>
          ${p.vip?`<span class="chip st-pending" style="margin-left:6px" title="VIP"><span class="cdot"></span>★ VIP</span>`:''}
          ${off?`<span class="chip st-closed" style="margin-left:6px"><span class="cdot"></span>Inactive</span>`:''}
          ${p.pref?`<span class="mini muted" style="margin-left:6px">prefers ${p.pref==='sms'?'SMS':p.pref}</span>`:''}</div>
        <div class="mini muted" style="margin-top:2px">${esc(p.email)}</div>
        <div class="mini muted tape" style="margin-top:2px;font-size:11px">${[p.phone?`w ${esc(p.phone)}`:'',p.mobile?`m ${esc(p.mobile)}`:'',p.fax?`f ${esc(p.fax)}`:''].filter(Boolean).join(' · ')||'no numbers on file'}</div>
        ${p.notes?`<div class="mini muted" style="margin-top:3px;font-style:italic">${esc(p.notes)}</div>`:''}
      </div>
      ${can('manage_clients')?`<button class="rowbtn" onclick="editContactModal('${c.id}','${p.id}')">Edit</button>`:''}
    </div>`;
  };
  return `
  <div class="toolbar"><button class="btn ghost sm" onclick="go('clients')">${icon(IC.back)}All clients</button>
    ${arch?`<span class="chip st-closed"><span class="cdot"></span>Archived client</span>`:''}
    <span class="spacer"></span>
    ${can('manage_clients')?`<button class="btn sm ghost" onclick="setClientStatus('${c.id}','${arch?'active':'archived'}')">${arch?'Restore client':'Archive client'}</button>
      <button class="btn sm" onclick="clientModal('${c.id}')">Edit details</button>`:''}
    ${can('see_billing')&&!arch?`<button class="btn" onclick="openLedger()">Billing in Ledger ${icon(IC.clock)}</button>`:''}
    ${can('create')&&!arch?`<button class="btn primary" onclick="newTicketModal('${c.id}')">${icon(IC.plus)}New ticket</button>`:''}</div>
  ${arch?`<div class="notice lock" style="margin-bottom:14px">${icon(IC.shield)}<div><b>Archived.</b> Kept for ticket history and billing records — no new tickets. ${can('manage_clients')?'Restore it to reactivate.':''} ${c.notes?esc(c.notes):''}</div></div>`:''}
  <div class="grid g-3">
    <div class="card stat"><div class="lab">Open tickets</div><div class="val tape">${open.length}</div><div class="sub">${ts.length} all time</div></div>
    <div class="card stat"><div class="lab">Hours logged</div><div class="val tape">${can('see_billing')?fmtHours(hrs):'·'}</div><div class="sub">${can('see_billing')?'':'amounts hidden for your role'}</div></div>
    <div class="card stat"><div class="lab">Client record</div><div class="val" style="font-size:17px;padding-top:6px">${arch?`<span class="chip st-closed"><span class="cdot"></span>Archived</span>`:`<span class="chip st-solved"><span class="cdot"></span>Active</span>`}</div><div class="sub">client since ${esc(c.since||'—')}${c.industry?` · ${esc(c.industry)}`:''}</div></div>
  </div>
  <div class="section-gap"></div>
  <div class="grid g-2">
    <div class="card card-pad">
      <div class="card-head flush"><h3>Organization</h3></div>
      ${kv('Address', [c.addr1,c.addr2].filter(Boolean).map(esc).join(', ') + (c.city?`<br>${esc(c.city)}, ${esc(c.st)} ${esc(c.zip)}`:''))}
      ${kv('Main phone', esc(c.phone||''), true)}
      ${kv('Fax', esc(c.fax||''), true)}
      ${kv('Website', c.website?`<a href="${esc(webHref(c.website))}" target="_blank" rel="noopener" style="color:var(--brand)">${esc(webLabel(c.website))}</a>`:'')}
      ${kv('Email domain', '@'+esc(c.domain), true)}
      ${kv('Timezone', esc((c.tz||'').replace('America/','').replace('_',' ')))}
      ${c.notes&&!arch?`<div class="mini muted" style="margin-top:10px;font-style:italic">${esc(c.notes)}</div>`:''}
    </div>
    <div class="card card-pad">
      <div class="card-head flush"><h3>Contacts</h3><span class="hint">${c.contacts.filter(p=>p.active!==false).length} active${c.contacts.some(p=>p.active===false)?` · ${c.contacts.filter(p=>p.active===false).length} inactive`:''}</span></div>
      ${pgC.slice.map(contactRow).join('')}${pagerBar(pgC)}
      ${(can('add_contacts')||can('manage_clients'))&&!arch?`<span style="display:inline-flex;gap:8px;margin-top:12px"><button class="btn sm" onclick="addContactModal('${c.id}')">${icon(IC.plus)}Add contact</button><button class="btn sm ghost" onclick="csvImportModal('${c.id}')">${icon(IC.export)}Import from Entra (CSV)</button></span>`:''}
    </div>
  </div>
  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Tickets</h3><span class="hint">${fts.length}${fts.length!==ts.length?` of ${ts.length}`:''} · within your access</span>
      <span class="spacer"></span>
      ${can('export_csv')?`<button class="btn sm" onclick="copyClientTicketsCSV('${c.id}')" title="Copies the CSV for the rows currently shown">Copy</button>
      <button class="btn sm primary" onclick="exportClientTicketsCSV('${c.id}')" title="Exports every row matching the filters — all pages">${icon(IC.export)}Export CSV</button>`:''}
    </div>
    <div class="toolbar" style="padding:10px 16px 0;margin:0">
      <div class="search">${icon(IC.search)}<input type="text" placeholder="Search title, number…" value="${esc(clfNorm().q)}" data-fkey="clf-q" oninput="setCLFQ(this.value)"></div>
      <span style="display:inline-block;min-width:150px;vertical-align:middle" title="System states are listed too — filtering by them is legitimate">${multiCombo('clfSt', STATES.map(s=>({v:String(s.id),label:s.label,archived:isArch(s)})), clfNorm().st, 'setCLFSt', 'Any state')}</span>
      <span style="display:inline-block;min-width:130px;vertical-align:middle">${multiCombo('clfTag', [...new Set(ts.flatMap(t=>t.tags))].sort().map(tg=>({v:tg,label:tg})), clfNorm().tag, 'setCLFTag', 'Any tag')}</span>
      <span style="display:inline-block;min-width:160px;vertical-align:middle">${multiCombo('clfOwner', [{v:'(unassigned)',label:'Unassigned'},...AGENTS.map(a=>({v:a.id,label:a.name}))], clfNorm().owner, 'setCLFOwner', 'Any owner')}</span>
    </div>
    ${fts.length? `<table class="tbl"><tbody>${pgT.slice.map(t=>`
      <tr class="clickable" onclick="openTicket(${t.id})">
        <td class="num" style="width:64px"><span class="tape muted">#${t.id}</span></td>
        <td><div class="cell-title">${esc(TITLES[t.id]||firstLine(t))}</div><div class="cell-meta">${esc(contact(t.contactId)?.name||'')} · ${esc(grp(t.groupId).name)}</div></td>
        <td style="width:120px">${stateChip(t)}</td>
        <td style="width:100px">${prioTag(t.prio)}</td>
        <td class="num mini" style="width:90px">${fmtAgo(t.updatedAt)}</td>
      </tr>`).join('')}</tbody></table>${pagerBar(pgT)}` : `<div class="empty">${ts.length? 'No tickets match — clear a filter.' : 'No tickets yet for this client.'}</div>`}
  </div>`;
}

/* ---- client-page ticket filters (state.clf — view-owned; the queue's qf
   stays in views/tickets.js). Arrays = any-of, empty = all; owner carries the
   '(unassigned)' sentinel (the reports '(untagged)' pattern). openClient()
   (render.js) resets clf on every client switch. ---- */
function clfNorm(){
  const f = state.clf || (state.clf = { st:[], tag:[], owner:[], q:'' });
  ['st','tag','owner'].forEach(k=>{ if(!Array.isArray(f[k])) f[k]=[]; });
  if(typeof f.q!=='string') f.q='';
  /* prune ghost selections — the qfNorm reasoning (row 37 / build 11) */
  const stKnown = new Set(STATES.map(s=>String(s.id)));
  const agKnown = new Set(AGENTS.map(a=>a.id)); agKnown.add('(unassigned)');
  const tagKnown = new Set(state.tickets.flatMap(t=>t.tags||[]));
  f.st = f.st.filter(v=>stKnown.has(String(v)));
  f.owner = f.owner.filter(v=>agKnown.has(v));
  f.tag = f.tag.filter(v=>tagKnown.has(v));
  return f;
}
/* named multiCombo handlers — desk's component calls window[name](selectedArr) */
function setCLFSt(vals){ clfNorm().st = vals; render(); }
function setCLFTag(vals){ clfNorm().tag = vals; render(); }
function setCLFOwner(vals){ clfNorm().owner = vals; render(); }
function setCLFQ(v){ clfNorm().q = v; render(); }
/* the ONE filtered slice — table and CSV both read this, so export = exactly
   what's filtered (the build-11 qfApply lesson) */
function clientTicketRows(c){
  const f = clfNorm();
  let rows = state.tickets.filter(t=>t.clientId===c.id && ticketVisible(t));
  if(f.st.length) rows = rows.filter(t=>f.st.some(v=>String(v)===String(t.st)));
  if(f.tag.length) rows = rows.filter(t=>f.tag.some(v=>t.tags.includes(v)));
  if(f.owner.length) rows = rows.filter(t=>f.owner.some(v=> v==='(unassigned)' ? !t.ownerId : t.ownerId===v));
  if(f.q){ const q=f.q.toLowerCase(); rows = rows.filter(t=>(TITLES[t.id]||firstLine(t)).toLowerCase().includes(q) || String(t.id).includes(q)); }
  return rows.sort((a,b)=>b.updatedAt-a.updatedAt);
}
function exportClientTicketsCSV(cid){
  if(!can('export_csv')){ toast('Your role can’t export data — ask an admin for the “Export & copy CSV data” permission.'); return; }
  const c = client(cid); if(!c) return;
  downloadCSV(`docket-${c.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')}-tickets-${msDate(nowMs())}.csv`, ticketsCSVData(clientTicketRows(c)));
}
function copyClientTicketsCSV(cid){
  if(!can('export_csv')) return;
  const c = client(cid); if(!c) return;
  copyRowsCSV(ticketsCSVData(clientTicketRows(c)), 'Client tickets CSV');
}

/* ---- contacts: add / edit — full record; technicians can add, admins can
   edit everything. The shared field set for both modals: ---- */
let nextContactIx = 100;
function contactFields(p){ p=p||{};
  return `
    <div class="grid g-2" style="gap:12px">
      <div class="field"><label>Full name</label><input type="text" id="acName" value="${esc(p.name||'')}" placeholder="First Last"></div>
      <div class="field"><label>Role / title</label><input type="text" id="acTitle" value="${esc(p.title||'')}" placeholder="e.g. Office manager"></div>
      <div class="field"><label>Department</label><input type="text" id="acDept" value="${esc(p.dept||'')}" placeholder="e.g. Operations"></div>
      <div class="field"><label>Preferred contact</label><select id="acPref">
        ${['email','sms','phone','fax'].map(x=>`<option value="${x}" ${(p.pref||'email')===x?'selected':''}>${x==='sms'?'SMS':x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div>
      <div class="field"><label>Work phone</label><input type="text" id="acPhone" value="${esc(p.phone||'')}" placeholder="(555) 555-0100"></div>
      <div class="field"><label>Mobile</label><input type="text" id="acMobile" value="${esc(p.mobile||'')}" placeholder="used for SMS verification"></div>
      <div class="field"><label>Fax</label><input type="text" id="acFax" value="${esc(p.fax||'')}" placeholder="if they still have one"></div>
      <div class="field"><label>Email</label><input type="text" id="acEmail" value="${esc(p.email||'')}"></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="acNotes" rows="2" placeholder="Anything the next tech should know — hours, how to reach them, quirks">${esc(p.notes||'')}</textarea></div>
    <label class="mini" style="display:flex;gap:8px;align-items:center;margin-top:4px"><input type="checkbox" id="acVip" ${p.vip?'checked':''} style="width:auto"> ★ VIP</label>`;
}
function readContactFields(c, p){ p=p||{};
  const name = document.getElementById('acName').value.trim();
  return Object.assign(p, {
    name, title:document.getElementById('acTitle').value.trim()||'Contact',
    dept:document.getElementById('acDept').value.trim(),
    pref:document.getElementById('acPref').value,
    phone:document.getElementById('acPhone').value.trim(),
    mobile:document.getElementById('acMobile').value.trim(),
    fax:document.getElementById('acFax').value.trim(),
    email:document.getElementById('acEmail').value.trim() || (name?name.toLowerCase().split(/\s+/)[0]+'@'+c.domain:''),
    notes:document.getElementById('acNotes').value.trim(),
    vip:(document.getElementById('acVip')||{}).checked===true,
  });
}
/* the server's contact payload — raw field values, read before the modal
   closes (defaults like title 'Contact' are a local display convenience) */
function contactPayload(){
  const g = id => { const el=document.getElementById(id); return el?el.value.trim():''; };
  /* vip is an EXPLICIT boolean — unchecking must clear it server-side, so
     the key is always present, never omitted (row 38's field-list lesson) */
  return { name:g('acName'), email:g('acEmail'), title:g('acTitle'),
           department:g('acDept'), phone:g('acPhone'), mobile:g('acMobile'),
           vip:(document.getElementById('acVip')||{}).checked===true };
}
function saveContact(clientId, fromTicket){
  const c = client(clientId);
  const name = document.getElementById('acName').value.trim();
  if(!name){ toast('A name is the one thing a contact needs.'); return; }
  const payload = Object.assign({client:clientId}, contactPayload());
  const p = readContactFields(c, { id:'p'+(nextContactIx++), active:true });
  c.contacts.push(p);
  log('Contact added', `${p.name} <${p.email}> → ${c.name}`);
  toast(`${p.name} added to ${c.name}.`);
  if(fromTicket){ reopenTicketDraft(clientId, p.id); } else { closeModal(); render(); }
  $fetch('/api/directory/contacts',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      if(!fromTicket) hydrate(); });               // ticket draft flow hydrates on create
}
function editContactModal(clientId, pid){
  if(!can('manage_clients')) return;
  const c = client(clientId), p = c.contacts.find(x=>x.id===pid);
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Edit contact — ${esc(p.name)}</h3><p>${esc(c.name)}</p></div>
    <div class="modal-body">${contactFields(p)}
      <label class="mini" style="display:flex;gap:8px;align-items:center;margin-top:4px"><input type="checkbox" id="acActive" ${p.active!==false?'checked':''} style="width:auto"> Active — uncheck when someone leaves; they stay on old tickets but drop out of pickers</label></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveContactEdit('${c.id}','${p.id}')">Save contact</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function saveContactEdit(clientId, pid){
  const c = client(clientId), p = c.contacts.find(x=>x.id===pid);
  if(!document.getElementById('acName').value.trim()){ toast('A name is the one thing a contact needs.'); return; }
  const payload = contactPayload();
  const act = document.getElementById('acActive');
  readContactFields(c, p);
  p.active = act ? act.checked : true;
  log('Contact updated', `${p.name} · ${c.name}${p.active?'':' · marked inactive'}`);
  toast(`${p.name} updated.`);
  closeModal(); render();
  if(!srvId(pid)) return;                          // local row — server id not minted yet
  $fetch('/api/directory/contacts/'+encodeURIComponent(pid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({active:p.active}, payload))})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      hydrate(); });
}

/* ---- client organizations — create / edit / archive (admin) ---- */
let nextClientIx = 10;
function clientModal(cid){
  if(!can('manage_clients')) return;
  const c = cid? client(cid) : {};
  const f = (id,lab,val,ph) => `<div class="field"><label>${lab}</label><input type="text" id="${id}" value="${esc(val||'')}" ${ph?`placeholder="${ph}"`:''}></div>`;
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${cid?'Edit client — '+esc(c.name):'New client'}</h3><p>The full organization record — Docket and Ledger both read it.</p></div>
    <div class="modal-body" style="max-height:60vh;overflow:auto">
      <div class="grid g-2" style="gap:12px">
        ${f('clName','Organization name',c.name,'Acme Corp')}
        ${f('clDomain','Email domain',c.domain,'acme.com')}
        ${f('clIndustry','Industry',c.industry,'e.g. Legal services')}
        ${f('clWebsite','Website',c.website,'https://…')}
        ${f('clPhone','Main phone',c.phone,'(555) 555-0100')}
        ${f('clFax','Fax',c.fax,'')}
        ${f('clAddr1','Address line 1',c.addr1,'Street')}
        ${f('clAddr2','Address line 2',c.addr2,'Suite / floor')}
        ${f('clCity','City',c.city,'')}
        <div class="grid g-2" style="gap:12px">${f('clSt','State',c.st,'VA')}${f('clZip','ZIP',c.zip,'')}</div>
        ${f('clTz','Timezone',c.tz||'America/New_York','America/New_York')}
        ${f('clSince','Client since',c.since,'YYYY-MM')}
      </div>
      <div class="field"><label>Account notes</label><textarea id="clNotes" rows="2" placeholder="Site access, escalation quirks, anything the whole team should know">${esc(c.notes||'')}</textarea></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveClient('${cid||''}')">${cid?'Save client':'Create client'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('clName').focus();
}
function saveClient(cid){
  const g = id => { const el=document.getElementById(id); return el?el.value.trim():''; };
  if(!g('clName')){ toast('The organization needs a name.'); return; }
  const name = g('clName'), dom = g('clDomain');
  const profile = {};
  ['industry','website','phone','fax','addr1','addr2','city','st','zip','tz','since','notes']
    .forEach(k=>{ const v=g('cl'+k[0].toUpperCase()+k.slice(1)); if(v) profile[k]=v; });
  profile.notes = g('clNotes');
  const isNew = !cid;
  const c = isNew? { id:'c'+(nextClientIx++), status:'active', contacts:[] } : client(cid);
  Object.assign(c, { name, domain:dom||c.domain||'example.com', industry:g('clIndustry'), website:g('clWebsite'),
    phone:g('clPhone'), fax:g('clFax'), addr1:g('clAddr1'), addr2:g('clAddr2'), city:g('clCity'), st:g('clSt'), zip:g('clZip'),
    tz:g('clTz'), since:g('clSince'), notes:profile.notes });
  if(isNew) CLIENTS.push(c);
  log(isNew?'Client created':'Client updated', `${c.name} · @${c.domain}`);
  bridgeSend('dir-client-upsert', { client:{ id:c.id, name:c.name, active:c.status!=='archived' }, isNew });
  toast(`${c.name} ${isNew?'created':'updated'}.`);
  closeModal();
  if(isNew){ openClient(c.id); } else render();
  if(isNew){
    $fetch('/api/directory/clients',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name, domains:dom?[dom]:[], profile})})
      .then(async r=>{ const d=await r.json().catch(()=>({}));
        if(!r.ok) return oops(d);
        if(state.clientId===c.id) state.clientId=d.id;
        hydrate(); });
  }else{
    const patch = {name, profile}; if(dom) patch.domains=[dom];   // blank leaves server domains untouched
    $fetch('/api/directory/clients/'+encodeURIComponent(cid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(patch)})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
        hydrate(); });
  }
}
function setClientStatus(cid, status){
  const c = client(cid);
  if(c.sentinel){ toast('Unassigned intake is the catch-all — it has to stay.'); return; }
  const was = c.status;
  c.status = status;
  log(status==='archived'?'Client archived':'Client restored', c.name);
  bridgeSend('dir-client-upsert', { client:{ id:c.id, name:c.name, active:status!=='archived' } });
  toast(`${c.name} ${status==='archived'?'archived — history kept, no new tickets':'restored to active'}.`);
  render();
  if(c.status===was) return;                       // nothing changed — nothing to mirror
  $fetch('/api/directory/clients/'+encodeURIComponent(cid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({archived:status==='archived'})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      hydrate(); });
}
