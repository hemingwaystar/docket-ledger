/* ==========================================================================
   newticket.js — the New-ticket modal.

   Owns: newTicketModal / ntContacts / createTicket · addContactModal +
   reopenTicketDraft (draft stash for the "+ new caller" detour) ·
   parseCSV (shared CSV splitter, consumed by the contact-import preview
   in views/directory.js). Caller verification lives in views/props.js.

   Endpoints:
     createTicket → POST /api/tickets                        (title, client,
                    group, contact_email, priority — names/labels, not ids)
   addContactModal saves through saveContact (views/clients.js), which owns
   POST /api/directory/contacts.

   Invariants: verification codes are generated and checked server-side only —
   the agent never sees the code, and it goes to the contact info ON FILE,
   never to a number the caller reads out. state.verify[ticketId] holds the
   in-flight challenge as {vid, method, masked}.
   ========================================================================== */

function newTicketModal(preClient){
  if(!can('create')) return;
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>New ticket</h3><p>Created on behalf of a customer — phone-in, walk-up, or proactive work.</p></div>
    <div class="modal-body">
      <div class="field"><label>Title</label><input type="text" id="ntTitle" placeholder="Short, specific summary"></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Client</label>${combo('ntClient', CLIENTS.filter(c=>c.status!=='archived').map(c=>({v:c.id, label:c.name, sub:c.domain!=='—'?c.domain:''})), preClient||'', ntContacts, 'Search clients…')}</div>
        <div class="field"><label>Contact${can('add_contacts')||can('manage_clients')?` <a href="#" style="float:right;text-transform:none;letter-spacing:0;font-weight:500;color:var(--brand)" onclick="addContactModal(document.getElementById('ntClient').value,true);return false">+ new caller</a>`:''}</label><span id="ntContactWrap">${combo('ntContact', [], '', null, 'Search contacts…')}</span></div>
        <div class="field"><label>Group</label><select id="ntGroup">${aGROUPS().map(g=>`<option value="${g.id}" ${DESK_UI.defaultGroup===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Priority</label><select id="ntPrio">${aPRIOS().map(p=>`<option value="${p.id}" ${p.id===2?'selected':''}>${p.label}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>First entry (internal note)</label><textarea id="ntBody" rows="3" placeholder="What was reported / what you're starting"></textarea></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="createTicket()">Create ticket</button></div>`;
  document.getElementById('scrim').classList.add('open');
  ntContacts();
}
function ntContacts(sel){
  const c = client(document.getElementById('ntClient').value);
  /* contact is optional — with none picked, no open email can go out (the
     trigger engine skips when there is no recipient) */
  const opts = [{v:'', label:'— no contact —', sub:'no open email goes out'},
    ...c.contacts.filter(p=>p.active!==false).map(p=>({v:p.id, label:p.name, sub:p.email}))];
  const pick = sel || (opts[1]?opts[1].v:'');
  document.getElementById('ntContactWrap').innerHTML = combo('ntContact', opts, pick, null, 'Search contacts…');
}
function createTicket(){
  const title = document.getElementById('ntTitle').value.trim() || 'Untitled ticket';
  const body = document.getElementById('ntBody').value.trim() || 'Ticket opened by agent.';
  if(!document.getElementById('ntClient').value){ toast('Pick a client first.'); return; }
  const id = state.nextId++;
  const t = mkTicket({ id, clientId:document.getElementById('ntClient').value, contactId:document.getElementById('ntContact').value||null,
    groupId:document.getElementById('ntGroup').value, ownerId:state.meId, st:'open', prio:Number(document.getElementById('ntPrio').value),
    tags:[], articles:[ art('note', me(), nowMs(), body) ], time:[], slaFrMet:true });
  TITLES[id] = title;
  log('Ticket created', `#${id} ${title}`);
  closeModal(); toast(`Ticket #${id} created and assigned to you.`);
  openTicket(id);
  const cl = client(t.clientId)||{}, gr = grp(t.groupId)||{};
  const p = (cl.contacts||[]).find(x=>x.id===t.contactId);
  /* note + owner ride the payload — pre-audit they were local-only and the
     hydrate wiped them: phone-in intake notes silently vanished */
  $fetch('/api/tickets',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ title, client:cl.name, group:gr.name,
      contact_email:p?p.email:null,
      priority:(prio(t.prio)||{label:'Normal'}).label,
      note:body, owner_email:(me()||{}).email||null })})
    .then(async r=>{ const d=await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);
      TITLES[d.id] = title;                /* the name follows the ticket to its server id */
      if(state.ticketId===t.id) state.ticketId = d.id;
      setTimeout(()=>hydrate(),500); });
}

/* "+ new caller" mid-draft: stash the half-typed ticket, borrow the contact
   form (fields + save live in views/clients.js), then restore the draft */
function addContactModal(clientId, fromTicket){
  if(!can('add_contacts') && !can('manage_clients')) return;
  const c = client(clientId);
  if(fromTicket) state._draft = { title:document.getElementById('ntTitle')?.value||'', body:document.getElementById('ntBody')?.value||'',
    groupId:document.getElementById('ntGroup')?.value, prio:document.getElementById('ntPrio')?.value };
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>Add contact — ${esc(c.name)}</h3><p>Email defaults to @${esc(c.domain)}.</p></div>
    <div class="modal-body">${contactFields()}</div>
    <div class="modal-foot"><button class="btn ghost" onclick="${fromTicket?`reopenTicketDraft('${c.id}')`:'closeModal()'}">Cancel</button><button class="btn primary" onclick="saveContact('${c.id}',${fromTicket?'true':'false'})">Add contact</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('acName').focus();
}
function reopenTicketDraft(clientId, selContact){
  const d = state._draft||{}; state._draft = null;
  newTicketModal(clientId);
  if(d.title) document.getElementById('ntTitle').value = d.title;
  if(d.body) document.getElementById('ntBody').value = d.body;
  if(d.groupId) document.getElementById('ntGroup').value = d.groupId;
  if(d.prio) document.getElementById('ntPrio').value = d.prio;
  if(selContact) ntContacts(selContact);
}

/* CSV splitter — quoted cells, escaped quotes, embedded newlines, CRLF */
function parseCSV(text){
  const rows = []; let row = [], cell = '', inQ = false;
  for(let i=0;i<text.length;i++){ const ch = text[i];
    if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else inQ=false; } else cell+=ch; }
    else if(ch==='"') inQ=true;
    else if(ch===','){ row.push(cell); cell=''; }
    else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n') i++; row.push(cell); cell=''; if(row.some(x=>x.trim()!=='')) rows.push(row); row=[]; }
    else cell+=ch;
  }
  if(cell!==''||row.length){ row.push(cell); if(row.some(x=>x.trim()!=='')) rows.push(row); }
  return rows;
}

