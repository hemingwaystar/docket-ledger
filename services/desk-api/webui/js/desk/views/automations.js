/* ==========================================================================
   js/desk/views/automations.js — Graph mail ingestion (auth card, mailboxes,
   outbound routing, master send switch) plus the Rules and Triggers BUILDERS.
   The builders only shape the jsonb definitions and CRUD them — execution is
   the mail-worker's engine (0019); no matching or firing happens here.
   Owns: viewAutomations · goBoard · ruleWhen/ruleThen · graphSet ·
   graphConnect/graphReconsent · graphDisconnect · toggleMailbox ·
   mailboxModal/saveMailbox · toggleOutboundMaster · sendasSet (the routing
   card's per-board sender picker) · toggleRule2/toggleTrig/
   deleteTrig/moveRule · ruleModal machinery + saveRule · trigModal machinery
   + saveTrig · cannedModal/saveCanned/deleteCanned · authSet/authToggleSSO/
   authToggleLocal/authToggleMapping · bizDay/bizHours/bizHolidays · slaSet
   (the Settings SLA inputs' handler) — the last three groups render on the
   Settings page but persist through this file's config mirrors.
   Endpoints: POST /api/automations/rules · PATCH /api/automations/rules/{id} ·
   POST /api/automations/rules/order · POST /api/settings/mailboxes ·
   PATCH /api/settings/mailboxes/{address} · POST /api/settings/mail/outbound ·
   PATCH /api/settings/groups/{group_id}/sendas ·
   POST /api/settings/graph/test · POST /api/settings/graph/disconnect ·
   PUT /api/settings/config/graph · PUT /api/settings/config/auth ·
   PUT /api/settings/config/sla · PUT /api/settings/config/business_hours ·
   POST /api/settings/canned · PATCH /api/settings/canned/{id}.
   Invariants: archive-first — trigger "delete" and canned "delete" PATCH an
   archive flag; rows history survives. Local state mutates first, the mirror
   fires only when it actually changed, oops() on refusal. Outbound routing
   shows the server-resolved effective sender (GROUP_SENDAS/GROUP_SENDAS_OVR,
   hydrated in api.js): fed-by derivation unless a per-board override (0026)
   pins another outbound-enabled address — receive-only is refused (422).
   Builder value pickers for list-valued fields are multi-selects saving the
   engine's comma any-of form ("a, b, c" — is/contains match ANY picked
   value, is not/not contains only when NONE do).
   ========================================================================== */

function viewAutomations(){
  return `
  <div class="notice info" style="margin-bottom:16px">${icon(IC.mail)}<div><b>One Entra app registration, every mailbox.</b> Ingestion runs on Microsoft Graph change-notification subscriptions with application-type <span class="tape">Mail.Read</span>, scoped by an application access policy to just these mailboxes — the same pattern the verification sender uses for <span class="tape">Mail.Send</span>. Shared mailboxes need no license; licensed mailboxes work identically. A 60s delta-query poll backstops missed webhooks.</div></div>
  <div class="card card-pad" style="margin-bottom:16px">
    <div class="card-head flush"><h3>Microsoft Graph authentication</h3><span class="hint">one app registration · every mailbox and the verification sender ride on it</span></div>
    <div class="setting-row" style="align-items:flex-start"><div class="sl">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          <span class="mini muted">tenant</span><span class="tape">${esc(AUTH_CFG.tenant)}</span>
          <span class="mini muted">app (client) ID</span><input type="text" value="${esc(GRAPH_AUTH.clientId)}" class="in-mono" style="width:200px" onchange="graphSet('clientId',this.value,this)" ${GRAPH_AUTH.connected?'disabled title="Disconnect before changing the app registration"':''}>
        </div>
        ${secretRow('graphSecret')}
        <p>${GRAPH_AUTH.connected
          ? `Admin consent granted ${fmtDT(GRAPH_AUTH.consentedAt)} by ${esc(GRAPH_AUTH.consentedBy)} · scopes: ${GRAPH_AUTH.scopes.map(x=>`<span class="tape">${esc(x)}</span>`).join(' ')} · access policy limits it to the mailboxes below`
          : 'Not authenticated — mailboxes are paused and verification emails can’t send until an admin consents.'}</p>
      </div>
      ${GRAPH_AUTH.connected
        ? `<button class="rowbtn" onclick="graphReconsent()">Renew consent</button><button class="rowbtn" onclick="graphDisconnect()">Disconnect</button><span class="chip st-solved"><span class="cdot"></span>Authenticated</span>`
        : `<button class="btn sm primary" onclick="graphConnect()">Authenticate with Microsoft</button><span class="chip st-closed"><span class="cdot"></span>Disconnected</span>`}
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>Mailboxes</h3><span class="hint">each one files into a board with a default priority</span><span class="spacer"></span>
      <button class="btn sm primary" onclick="mailboxModal()">${icon(IC.plus)}Add mailbox</button></div>
    <table class="tbl">
      <thead><tr><th>Mailbox</th><th>Type</th><th>Board</th><th>Default priority</th><th>Outbound</th><th class="right">Today</th><th>Subscription</th><th></th></tr></thead>
      <tbody>${MAILBOXES.map(m=>`<tr ${m.status==='paused'?'style="opacity:.55"':''}>
        <td><div class="cell-title tape" style="font-size:12.5px">${esc(m.addr)}</div><div class="cell-meta">${esc(m.desc)}</div></td>
        <td>${m.type==='shared'?`<span class="chip st-open"><span class="cdot"></span>Shared</span>`:`<span class="chip st-pending"><span class="cdot"></span>Licensed</span>`}</td>
        <td class="mini" style="padding-top:13px"><a href="#" onclick="goBoard('${m.groupId}');return false" style="color:var(--brand);text-decoration:none;border-bottom:1px dotted var(--brand)">${esc(grp(m.groupId).name)}</a></td>
        <td style="padding-top:9px">${prioTag(m.prio)}</td>
        <td>${m.outbound?`<span class="chip st-solved"><span class="cdot"></span>Enabled</span>`:`<span class="chip st-hold"><span class="cdot"></span>Receive-only</span>`}</td>
        <td class="num">${m.today}</td>
        <td>${m.status==='connected'?`<span class="chip st-solved"><span class="cdot"></span>Connected</span>`:`<span class="chip st-hold"><span class="cdot"></span>Paused</span>`}</td>
        <td class="right"><button class="rowbtn" onclick="mailboxModal('${m.id}')">Edit</button>
          <button class="rowbtn" onclick="toggleMailbox('${m.id}')">${m.status==='connected'?'Pause':'Resume'}</button></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>
  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Outbound routing</h3><span class="hint">which address each board replies from</span><span class="spacer"></span>
      ${MAILCFG.outboundEnabled
        ? `<span class="chip st-solved"><span class="cdot"></span>Sending live</span>${can('manage_automations')?`<button class="rowbtn" onclick="toggleOutboundMaster()">Switch to recorded-only</button>`:''}`
        : `<span class="chip st-hold"><span class="cdot"></span>Recorded-only</span>${can('manage_automations')?`<button class="btn sm primary" onclick="toggleOutboundMaster()">Enable live sending</button>`:''}`}</div>
    <div style="padding:4px 16px 6px">
      ${aGROUPS().map(g=>{ const rb=mbox(GROUP_SENDAS[g.id]); const ovr=!!GROUP_SENDAS_OVR[g.id];
        const opts=MAILBOXES.filter(m=>m.outbound || (ovr&&rb&&m.id===rb.id));   /* row 37: an ineligible current pick stays visible */
        return `<div class="setting-row"><div class="sl"><b>${esc(g.name)}</b><p>${MAILBOXES.some(m=>m.groupId===g.id&&m.status==='connected')?`fed by ${MAILBOXES.filter(m=>m.groupId===g.id&&m.status==='connected').map(m=>m.addr.split('@')[0]+'@').join(', ')}`:'no inbound mailbox — tickets arrive by phone/agent'}</p></div>
        <span class="chip ${ovr?'st-pending':'st-open'}" title="${ovr?'an explicit override pins this sender':'follows the board’s fed-by mailbox'}"><span class="cdot"></span>${ovr?'Override':'Derived'}</span>
        ${can('manage_settings')
          ? `<select style="width:auto;max-width:250px" onchange="sendasSet('${g.id}',this.value)">
              <option value="" ${ovr?'':'selected'}>derived (default)${!ovr&&rb?' — '+esc(rb.addr):''}</option>
              ${opts.map(m=>`<option value="${esc(m.addr)}" ${ovr&&rb&&rb.id===m.id?'selected':''} ${m.outbound&&m.status!=='paused'?'':'disabled'}>${esc(m.addr)}${m.outbound?'':' (receive-only)'}${m.status==='paused'?' (paused)':''}</option>`).join('')}
            </select>`
          : `<span class="mini muted">replies from <span class="tape">${rb?esc(rb.addr):'—'}</span></span>`}</div>`;}).join('')}
      <div class="mini muted" style="padding:10px 0 12px">Every reply on a board goes out from <b>that board's address</b> — derived from the Mailboxes card above, unless an <b>override</b> pins one of the outbound-enabled addresses to the board. Move a ticket to another board and its replies follow. Agents never pick a sender per ticket; receive-only addresses (like noc@) can't be picked — the server refuses them.</div>
    </div>
  </div>
  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Rules</h3><span class="hint">run top to bottom on every inbound message — later rules see earlier changes</span><span class="spacer"></span>
      <button class="btn sm primary" onclick="ruleModal()">${icon(IC.plus)}New rule</button></div>
    <table class="tbl">
      <thead><tr><th style="width:36px"></th><th>Rule</th><th>When</th><th>Then</th><th class="right">Runs</th><th></th></tr></thead>
      <tbody>${RULES.map((r,i)=>`<tr ${r.enabled?'':'style="opacity:.5"'}>
        <td style="padding-top:12px"><input type="checkbox" ${r.enabled?'checked':''} onchange="toggleRule2('${r.id}')" title="${r.enabled?'disable':'enable'}"></td>
        <td><div class="cell-title">${esc(r.name)}</div><div class="cell-meta">#${i+1} in order</div></td>
        <td class="mini" style="padding-top:12px">${esc(ruleWhen(r))}</td>
        <td class="mini" style="padding-top:12px">${esc(ruleThen(r))}</td>
        <td class="num">${r.runs.toLocaleString()}</td>
        <td class="right"><button class="rowbtn" onclick="ruleModal('${r.id}')">Edit</button>
          ${i>0?`<button class="rowbtn" onclick="moveRule('${r.id}',-1)" title="run earlier">↑</button>`:''}
          ${i<RULES.length-1?`<button class="rowbtn" onclick="moveRule('${r.id}',1)" title="run later">↓</button>`:''}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>
  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Ticket triggers</h3><span class="hint">activator + conditions + actions — nothing is baked in, even the auto-replies live here</span><span class="spacer"></span>
      <button class="btn sm primary" onclick="trigModal()">${icon(IC.plus)}New trigger</button></div>
    <table class="tbl">
      <thead><tr><th style="width:36px"></th><th>Trigger</th><th>Activated by</th><th>Only if</th><th>Actions</th><th class="right">Runs</th><th></th></tr></thead>
      <tbody>${TRIGGERS.map(g=>`<tr ${g.enabled?'':'style="opacity:.5"'}>
        <td style="padding-top:12px"><input type="checkbox" ${g.enabled?'checked':''} onchange="toggleTrig('${g.id}')"></td>
        <td><div class="cell-title">${esc(g.name)}</div></td>
        <td class="mini" style="padding-top:12px">${esc(TRIG_EVENTS.find(e=>e.id===g.event)?.label.replace('…','')||g.event)}${g.event==='state'&&g.eventValue?esc(st8(g.eventValue)?.label||g.eventValue):''}</td>
        <td class="mini" style="padding-top:12px">${esc(groupsWhen(g.conds, c=>`${c.field} ${c.op} “${c.value}”`) || 'always')}</td>
        <td class="mini" style="padding-top:12px">${esc(g.actions.map(a=>({email:'email the customer',note:'internal note',tag:`tag “${a.value}”`,state:`state → ${st8(a.value)?.label||a.value}`,prio:`priority → ${prio(Number(a.value))?.label||a.value}`,group:`board → ${grp(a.value)?.name||a.value}`}[a.type])).join(' · '))}</td>
        <td class="num">${g.runs.toLocaleString()}</td>
        <td class="right"><button class="rowbtn" onclick="trigModal('${g.id}')">Edit</button>
          <button class="rowbtn" onclick="deleteTrig('${g.id}')">Delete</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="mini muted" style="padding:10px 16px 12px">Templates take variables: <span class="tape">#{ticket.number}</span> <span class="tape">#{ticket.title}</span> <span class="tape">#{customer.first}</span> <span class="tape">#{customer.name}</span> <span class="tape">#{client.name}</span> <span class="tape">#{agent.name}</span> <span class="tape">#{state.label}</span>. Auto-reply emails route through the same outbound resolution as agent replies.</div>
  </div>`;
}
function goBoard(gid){ state.qf.group = [gid]; state.overview='allopen'; go('tickets'); }

/* ---- row summaries (formatters only — matching lives in the worker) ----- */
function ruleWhen(r){
  const F = {from:'from address', fromDomain:'sender domain', to:'to mailbox', subject:'subject', text:'subject or body'};
  return groupsWhen(r.conds, c=>`${F[c.field]||c.field} ${c.op} “${c.value}”`) || 'every inbound message';
}
function ruleThen(r){
  const a = r.act, out = [];
  if(a.groupId) out.push(`board → ${grp(a.groupId).name}`);
  if(a.prio) out.push(`priority ${prio(a.prio).label}`);
  if(a.prioAtLeast) out.push(`priority at least ${prio(a.prioAtLeast).label}`);
  if(a.tag) out.push(`tag “${a.tag}”`);
  if(a.notify) out.push('notify the group');
  return out.join(' · ') || '—';
}

/* ---- Graph app card ----------------------------------------------------- */
let _graphT = null;
function graphSet(k, v, srcEl){
  const was = GRAPH_AUTH[k]; GRAPH_AUTH[k]=v.trim();
  log('Graph app changed', `${k}: ${was} → ${v.trim()}`);
  commitRender(srcEl);
  clearTimeout(_graphT);
  _graphT = setTimeout(()=>{
    $fetch('/api/settings/config/graph',{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({value:{tenant:GRAPH_AUTH.tenant||'',
        client_id:GRAPH_AUTH.clientId||'',
        connected:!!GRAPH_AUTH.connected}})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
  },600);
}
/* consent is proven by a real token acquisition server-side; the card then
   renders the server's connected flag, never a local guess (bug #32) */
function graphConnect(){
  toast('Testing the app registration against Microsoft…');
  $fetch('/api/settings/graph/test',{method:'POST'})
    .then(async r=>{ const d=await r.json().catch(()=>({}));
      if(!r.ok) return oops(d);                        /* 409 carries the real Microsoft error */
      toast('Authenticated — the worker starts polling within a minute.');
      setTimeout(()=>hydrate(),400); });
}
function graphReconsent(){ graphConnect(); }
function graphDisconnect(){
  GRAPH_AUTH.connected = false;
  const live = MAILBOXES.filter(m=>m.status==='connected');
  live.forEach(m=>{ m.status='paused'; });
  log('Graph consent revoked', `${GRAPH_AUTH.clientId} · ${live.length} mailbox${live.length===1?'':'es'} paused · verification email sender offline`);
  toast(`Disconnected — ${live.length} mailboxes paused; mail flow stops until re-consented.`);
  render();
  $fetch('/api/settings/graph/disconnect',{method:'POST'})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      setTimeout(()=>hydrate(),400); });
}

/* ---- mailboxes ---------------------------------------------------------- */
function toggleMailbox(id){
  const m=MAILBOXES.find(x=>x.id===id);
  if(m.status!=='connected' && !GRAPH_AUTH.connected){ toast('Authenticate the Graph app first — mailboxes can’t subscribe without consent.'); return; }
  m.status = m.status==='connected'?'paused':'connected';
  log(m.status==='connected'?'Mailbox resumed':'Mailbox paused', m.addr); render();
  $fetch('/api/settings/mailboxes/'+encodeURIComponent(m.addr),{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({paused:m.status==='paused'})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}
function mailboxModal(id){
  if(!can('manage_automations')) return;
  const m0 = id? MAILBOXES.find(x=>x.id===id) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${id?'Edit mailbox':'Add mailbox'}</h3><p>Shared mailboxes need no license — the app-scoped Graph subscription covers them. New addresses also need adding to the application access policy.</p></div>
    <div class="modal-body">
      <div class="field"><label>Address</label><input type="text" id="mbAddr" value="${esc(m0.addr||'')}" placeholder="team@hemingwaytechsolutions.com"></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Type</label><select id="mbType">
          <option value="shared" ${m0.type!=='licensed'?'selected':''}>Shared mailbox</option>
          <option value="licensed" ${m0.type==='licensed'?'selected':''}>Licensed mailbox</option></select></div>
        <div class="field"><label>Board (group)</label><select id="mbGroup">${aGROUPS().map(g=>`<option value="${g.id}" ${m0.groupId===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Default priority</label><select id="mbPrio">${aPRIOS().map(p=>`<option value="${p.id}" ${(m0.prio||2)===p.id?'selected':''}>${p.label}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Description</label><input type="text" id="mbDesc" value="${esc(m0.desc||'')}" placeholder="What lands here"></div>
      <label class="mini" style="display:flex;gap:8px;align-items:center;margin-top:4px"><input type="checkbox" id="mbOut" ${(id? m0.outbound : true)?'checked':''} style="width:auto"> Outbound enabled — agents can send replies as this address. Shared mailboxes also need <span class="tape">Mail.Send</span> in the access policy; uncheck for alert-only inboxes like noc@.</label>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveMailbox('${id||''}')">${id?'Save mailbox':'Add mailbox'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  document.getElementById('mbAddr').focus();
}
function saveMailbox(id){
  const addr = document.getElementById('mbAddr').value.trim().toLowerCase();
  if(!addr.includes('@')){ toast('That needs to be an email address.'); return; }
  const oldAddr = id? (MAILBOXES.find(x=>x.id===id)||{}).addr : null;
  const m = id? MAILBOXES.find(x=>x.id===id) : { id:'mb'+(nextMbIx++), status:'connected', today:0 };
  Object.assign(m, { addr, type:document.getElementById('mbType').value, groupId:document.getElementById('mbGroup').value,
    prio:Number(document.getElementById('mbPrio').value), desc:document.getElementById('mbDesc').value.trim(),
    outbound:document.getElementById('mbOut').checked });
  /* no local GROUP_SENDAS guessing: the server resolves effective senders
     (override → fed-by) and the post-save hydrate below pulls the truth */
  if(!id) MAILBOXES.push(m);
  log(id?'Mailbox updated':'Mailbox added', `${m.addr} → ${grp(m.groupId).name}`);
  toast(`${m.addr} ${id?'updated':'subscribed'} — remember the access policy covers it.`);
  closeModal(); render();
  const prioLabel = (PRIOS.find(p=>p.id===m.prio)||{label:'Normal'}).label;
  if(id){
    const patch={group:m.groupId, display_name:m.desc, default_priority:prioLabel,
                 outbound:m.outbound, type:m.type};
    if(oldAddr && oldAddr!==addr) patch.address=addr;
    $fetch('/api/settings/mailboxes/'+encodeURIComponent(oldAddr||addr),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
        setTimeout(()=>hydrate(),400); });
  }else{
    $fetch('/api/settings/mailboxes',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({address:addr, group:m.groupId, display_name:m.desc,
                           default_priority:prioLabel, outbound:m.outbound, type:m.type})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
        setTimeout(()=>hydrate(),400); });
  }
}

/* ---- master outbound switch: mail.outbound_enabled — a server refusal
   rolls the chip back so the UI never lies about the go-live state ---- */
function toggleOutboundMaster(){
  if(!can('manage_automations')) return;
  if(!MAILCFG.outboundEnabled && !confirm('Enable live sending? From this moment every agent reply and trigger email really goes out to customers.')) return;
  const was = MAILCFG.outboundEnabled;
  MAILCFG.outboundEnabled = !was;
  log(MAILCFG.outboundEnabled?'Outbound sending enabled':'Outbound sending disabled',
      MAILCFG.outboundEnabled?'replies and trigger emails now send':'recorded-only — replies stored, nothing sends');
  toast(MAILCFG.outboundEnabled?'Live sending ON — replies now reach customers.':'Recorded-only — replies are stored but not sent.');
  render();
  $fetch('/api/settings/mail/outbound',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({enabled:MAILCFG.outboundEnabled})})
    .then(async r=>{ if(!r.ok){ MAILCFG.outboundEnabled=was; render();
      return oops(await r.json().catch(()=>0)); } })
    .catch(()=>{ MAILCFG.outboundEnabled=was; render();
      toast('Live sync failed — the switch was NOT changed on the server.'); });
}

/* ---- per-board outbound override (0026) — the routing card's picker.
   '' = derived (PATCH mailbox:null clears the override row; house rule: an
   UPDATE to NULL, never a DELETE); an address pins that sender for the
   board. Optimistic with rollback — the Derived/Override chip never lies —
   then a hydrate pulls the server-resolved effective sender. The PATCH is
   manage_settings-gated server-side, so the picker only renders (and this
   only fires) for that permission. ---- */
function sendasSet(gid, addr){
  const g = grp(gid); if(!g || !can('manage_settings')) return;
  const wasId = GROUP_SENDAS[gid], wasOvr = !!GROUP_SENDAS_OVR[gid];
  const box = addr ? MAILBOXES.find(m=>m.addr===addr) : null;
  if(addr && !box) return;
  if(addr ? (wasOvr && box.id===wasId) : !wasOvr){ render(); return; }   /* no change — nothing to mirror */
  const rollback = ()=>{ if(wasId) GROUP_SENDAS[gid]=wasId; else delete GROUP_SENDAS[gid];
    GROUP_SENDAS_OVR[gid]=wasOvr; render(); };
  if(box){ GROUP_SENDAS[gid]=box.id; GROUP_SENDAS_OVR[gid]=true; }
  else{
    GROUP_SENDAS_OVR[gid]=false;
    /* local fed-by guess, same shape as the server's derivation; the hydrate
       below replaces it with the resolved truth */
    const fed = MAILBOXES.filter(m=>m.groupId===gid && m.status==='connected')
      .sort((a,b)=>(b.outbound?1:0)-(a.outbound?1:0))[0] || outboundBoxes()[0];
    if(fed) GROUP_SENDAS[gid]=fed.id; else delete GROUP_SENDAS[gid];
  }
  log(box?'Outbound sender overridden':'Outbound sender cleared',
      `${g.name}: ${box?box.addr:'derived from fed-by'}`);
  toast(box?`${g.name} now replies from ${box.addr}.`:`${g.name} follows its fed-by mailbox again.`);
  render();
  $fetch('/api/settings/groups/'+encodeURIComponent(gid)+'/sendas',{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({mailbox:addr||null})})
    .then(async r=>{ if(!r.ok){ rollback(); return oops(await r.json().catch(()=>0)); }
      setTimeout(()=>hydrate(),400); })            /* pull the resolved effective sender */
    .catch(()=>{ rollback();
      toast('Live sync failed — the sender was NOT changed on the server.'); });
}

/* ---- rules & triggers CRUD (one table server-side: automation_rules) ---- */
const ruleUp=(id,payload)=>$fetch('/api/automations/rules/'+encodeURIComponent(id),
  {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
const ruleMk=payload=>$fetch('/api/automations/rules',
  {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
    setTimeout(()=>hydrate(),400); });     /* pick up the server id */

function toggleRule2(id){ const r=RULES.find(x=>x.id===id); r.enabled=!r.enabled;
  log(r.enabled?'Rule enabled':'Rule disabled', r.name); render();
  if(isUuid(id)) ruleUp(id,{enabled:r.enabled}); }
function moveRule(id, dir){ const i=RULES.findIndex(x=>x.id===id); const j=i+dir;
  if(j<0||j>=RULES.length) return; [RULES[i],RULES[j]]=[RULES[j],RULES[i]];
  log('Rule reordered', `${RULES[j].name} ↔ ${RULES[i].name}`); render();
  const ids=RULES.map(r=>r.id).filter(isUuid);
  if(ids.length) $fetch('/api/automations/rules/order',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); }); }

function toggleTrig(id){ const g=TRIGGERS.find(x=>x.id===id); g.enabled=!g.enabled;
  log(g.enabled?'Trigger enabled':'Trigger disabled', g.name); render();
  if(isUuid(id)) ruleUp(id,{enabled:g.enabled}); }
function deleteTrig(id){ const i=TRIGGERS.findIndex(x=>x.id===id);
  log('Trigger deleted', TRIGGERS[i].name); toast(`Trigger “${TRIGGERS[i].name}” deleted.`); TRIGGERS.splice(i,1); render();
  if(isUuid(id)) ruleUp(id,{archived:true}); }   /* archive-first: runs history survives */

let _trigDraft = null;
let _ruleDraft = null;
function trigModal(id){
  if(!can('manage_automations')) return;
  const g0 = id? TRIGGERS.find(x=>x.id===id) : { name:'', event:'create', eventValue:'', conds:[], actions:[{type:'email', value:''}] };
  _trigDraft = { condGroups: condGroups(g0.conds), actions: JSON.parse(JSON.stringify(g0.actions)) };
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${id?'Edit trigger':'New trigger'}</h3><p>Zammad-style: activated by an event, filtered by conditions, then runs its actions in order.</p></div>
    <div class="modal-body" style="max-height:62vh;overflow:auto">
      <div class="field"><label>Name</label><input type="text" id="tgName" value="${esc(g0.name)}" placeholder="e.g. Auto-reply (on new tickets)"></div>
      <div class="grid g-2" style="gap:12px">
        <div class="field"><label>Activated by</label><select id="tgEvent" onchange="trigEventChanged()">${TRIG_EVENTS.map(e=>`<option value="${e.id}" ${g0.event===e.id?'selected':''}>${e.label}</option>`).join('')}</select></div>
        <div class="field" id="tgStateWrap" style="${g0.event==='state'?'':'display:none'}"><label>… to state</label><select id="tgEventState">${aSTATES().map(s=>`<option value="${s.id}" ${g0.eventValue===s.id?'selected':''}>${s.label}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Only if (rows must ALL match; OR groups match any — within a row, several picked values or commas mean any-of; leave empty for always)</label><div id="tgConds"></div>
        <button class="btn sm ghost" onclick="trigAddCond()">+ condition</button>
        <button class="btn sm ghost" onclick="trigAddOrGroup()">+ OR group</button></div>
      <div class="field"><label>Actions (run in order)</label><div id="tgActs"></div>
        <button class="btn sm ghost" onclick="trigAddAct()">+ action</button></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveTrig('${id||''}')">${id?'Save trigger':'Create trigger'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
  trigDrawConds(); trigDrawActs();
  document.getElementById('tgName').focus();
}
function trigEventChanged(){ document.getElementById('tgStateWrap').style.display = document.getElementById('tgEvent').value==='state'?'':'none'; }
function trigDrawConds(){
  const fieldOpts = c => ({
      state:    aSTATES().map(s=>s.label),
      priority: aPRIOS().slice().sort((a,b)=>b.id-a.id).map(p=>p.label),
      group:    aGROUPS().map(g=>g.name),
      client:   CLIENTS.filter(cl=>cl.status!=='archived').map(cl=>cl.name),
      mailbox:  MAILBOXES.map(m=>m.addr),
    }[c.field]);
  /* picker fields seed one value BEFORE drawing, so what saves is what shows
     (a lone value is a one-element any-of) */
  _trigDraft.condGroups.forEach(grpC=>grpC.forEach(c=>{
    const opts = fieldOpts(c);
    if(opts && !c.value) c.value = opts[0];
  }));
  const valCtl = (c,gi,i) => {
    const opts = fieldOpts(c);
    if(opts){
      /* multi-select saving the engine's comma any-of form ("a, b, c"):
         is/contains hit on ANY picked value, is not/not contains only when
         NONE do — a lone pick is a one-element any-of, so old single-value
         rules render and save identically. Values no longer offered
         (archived/renamed) stay selected until unpicked (row 37). */
      const picked = String(c.value||'').split(',').map(s=>s.trim()).filter(Boolean);
      const gone = picked.filter(v=>!opts.includes(v));
      return `<select multiple size="${Math.max(2,Math.min(gone.length+opts.length,4))}" style="flex:1" title="pick any number — the row matches ANY picked value; saved as comma any-of" onchange="_trigDraft.condGroups[${gi}][${i}].value=[...this.selectedOptions].map(o=>o.value).join(', ')">
        ${gone.map(v=>`<option value="${esc(v)}" selected>${esc(v)} (archived)</option>`).join('')}
        ${opts.map(o=>`<option value="${esc(o)}" ${picked.includes(o)?'selected':''} ${o.includes(',')?'disabled title="this name contains a comma — the any-of wire format can’t carry it; rename it to target it"':''}>${esc(o)}</option>`).join('')}</select>`;
    }
    return `<input type="text" value="${esc(c.value)}" oninput="_trigDraft.condGroups[${gi}][${i}].value=this.value" placeholder="${c.field==='tags'?'tag names — commas mean any-of':'address — commas mean any-of'}" style="flex:1">`;
  };
  const rowHtml = (c,gi,i)=>`
    <div class="grid g-2" style="gap:12px;margin-bottom:8px">
      <div class="grid g-2" style="gap:12px">
        <select onchange="_trigDraft.condGroups[${gi}][${i}].field=this.value;_trigDraft.condGroups[${gi}][${i}].value='';trigDrawConds()">${[['state','State'],['priority','Priority'],['group','Board / group'],['client','Client'],['tags','Tags'],['from','From address'],['mailbox','Arrival mailbox']].map(([v,l])=>`<option value="${v}" ${c.field===v?'selected':''}>${l}</option>`).join('')}</select>
        <select onchange="_trigDraft.condGroups[${gi}][${i}].op=this.value">${['is','is not','contains','not contains'].map(o=>`<option ${c.op===o?'selected':''}>${o}</option>`).join('')}</select>
      </div>
      <div style="display:flex;gap:8px">${valCtl(c,gi,i)}
        <button class="rowbtn" onclick="_trigDraft.condGroups[${gi}].splice(${i},1);if(!_trigDraft.condGroups[${gi}].length)_trigDraft.condGroups.splice(${gi},1);trigDrawConds()">×</button></div>
    </div>`;
  document.getElementById('tgConds').innerHTML = _trigDraft.condGroups.map((grpC,gi)=>
    (gi?`<div class="mini muted" style="text-align:center;margin:2px 0 8px">— or —</div>`:'')
    + grpC.map((c,i)=>rowHtml(c,gi,i)).join('')
  ).join('') || `<div class="mini muted" style="margin-bottom:8px">No conditions — fires on every matching event.</div>`;
}
function trigAddCond(){                       /* AND row in the LAST group */
  if(!_trigDraft.condGroups.length) _trigDraft.condGroups.push([]);
  _trigDraft.condGroups[_trigDraft.condGroups.length-1].push({field:'tags', op:'not contains', value:''});
  trigDrawConds(); }
function trigAddOrGroup(){                    /* fresh alternative group */
  _trigDraft.condGroups.push([{field:'tags', op:'not contains', value:''}]);
  trigDrawConds(); }
function trigDrawActs(){
  document.getElementById('tgActs').innerHTML = _trigDraft.actions.map((a,i)=>{
    const val =
      a.type==='email'||a.type==='note' ? `<textarea rows="3" oninput="_trigDraft.actions[${i}].value=this.value" placeholder="Template — variables like #{ticket.number} and #{customer.name} fill in at send time">${esc(a.value||'')}</textarea>` :
      a.type==='tag' ? `<input type="text" value="${esc(a.value||'')}" oninput="_trigDraft.actions[${i}].value=this.value" placeholder="tag name">` :
      a.type==='state' ? `<select onchange="_trigDraft.actions[${i}].value=this.value">${aSTATES().map(s=>`<option value="${s.id}" ${a.value===s.id?'selected':''}>${s.label}</option>`).join('')}</select>` :
      a.type==='prio' ? `<select onchange="_trigDraft.actions[${i}].value=this.value">${aPRIOS().map(p=>`<option value="${p.id}" ${String(a.value)===String(p.id)?'selected':''}>${p.label}</option>`).join('')}</select>` :
      a.type==='autoassign' ? `<select onchange="_trigDraft.actions[${i}].value=this.value"><option value="rr" ${a.value!=='least'?'selected':''}>Round-robin within the board</option><option value="least" ${a.value==='least'?'selected':''}>Least-loaded agent on the board</option></select>` :
      `<select onchange="_trigDraft.actions[${i}].value=this.value">${aGROUPS().map(g=>`<option value="${g.id}" ${a.value===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select>`;
    return `<div style="display:flex;gap:8px;margin-bottom:8px;align-items:flex-start">
      <select style="width:190px" onchange="_trigDraft.actions[${i}]={type:this.value,value:''};trigDrawActs()">
        ${[['email','Email the customer'],['note','Add internal note'],['tag','Add tag'],['state','Set state'],['prio','Set priority'],['group','Move to board'],['autoassign','Auto-assign owner']].map(([v,l])=>`<option value="${v}" ${a.type===v?'selected':''}>${l}</option>`).join('')}</select>
      <div style="flex:1">${val}</div>
      <button class="rowbtn" onclick="_trigDraft.actions.splice(${i},1);trigDrawActs()">×</button>
    </div>`;
  }).join('') || `<div class="mini muted" style="margin-bottom:8px">No actions yet.</div>`;
}
function trigAddAct(){ _trigDraft.actions.push({type:'email', value:''}); trigDrawActs(); }
function saveTrig(id){
  const name = document.getElementById('tgName').value.trim();
  if(!name){ toast('Give the trigger a name.'); return; }
  const actions = _trigDraft.actions.filter(a=>a.type==='state'||a.type==='prio'||a.type==='group'||a.type==='autoassign'? true : String(a.value||'').trim());
  if(!actions.length){ toast('A trigger needs at least one action.'); return; }
  actions.forEach(a=>{ if(a.type==='autoassign' && !a.value) a.value='rr';
    if((a.type==='state'||a.type==='prio'||a.type==='group') && !a.value){ a.value = a.type==='state'?STATES[0].id : a.type==='prio'?PRIOS[0].id : GROUPS[0].id; } });
  const g = id? TRIGGERS.find(x=>x.id===id) : { id:'tg'+(nextTrigIx++), enabled:true, runs:0 };
  const g0 = id? JSON.stringify(g) : null;
  Object.assign(g, { name, event:document.getElementById('tgEvent').value,
    eventValue: document.getElementById('tgEvent').value==='state'? document.getElementById('tgEventState').value : '',
    conds:packGroups(_trigDraft.condGroups), actions });
  if(!id) TRIGGERS.push(g);
  log(id?'Trigger updated':'Trigger created', name);
  toast(`Trigger “${name}” ${id?'saved':'created'}.`);
  closeModal(); render();
  if(id){
    if(JSON.stringify(g)!==g0 && isUuid(id)) ruleUp(id,{name:g.name,event:g.event,
      event_value:g.eventValue||'', conditions:g.conds, actions:g.actions});
  }else{
    ruleMk({kind:'trigger',name:g.name,event:g.event,event_value:g.eventValue||'',
      conditions:g.conds,actions:g.actions,enabled:true});
  }
}

function ruleModal(id){
  if(!can('manage_automations')) return;
  const r0 = id? RULES.find(x=>x.id===id) : { conds:[{field:'from',op:'contains',value:''}], act:{} };
  _ruleDraft = { condGroups: condGroups(r0.conds) };
  if(!id && !_ruleDraft.condGroups.length) _ruleDraft.condGroups=[[{field:'from',op:'contains',value:''}]];
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${id?'Edit rule':'New rule'}</h3><p>Rows must ALL match; OR groups match any; commas in a value mean any-of ("a, b, c" hits when any one matches). Leave conditions empty to match every inbound message.</p></div>
    <div class="modal-body" style="max-height:62vh;overflow:auto">
      <div class="field"><label>Rule name</label><input type="text" id="rName" value="${esc(r0.name||'')}" placeholder="e.g. Billing questions → Projects"></div>
      <div class="field"><label>When</label><div id="rConds"></div>
        <button class="btn sm ghost" onclick="ruleAddCond()">+ condition</button>
        <button class="btn sm ghost" onclick="ruleAddOrGroup()">+ OR group</button></div>
      <div class="field"><label>Then</label>
        <div class="grid g-2" style="gap:12px">
          <div class="field"><label>Move to board</label><select id="raGroup"><option value="">— leave as is —</option>${aGROUPS().map(g=>`<option value="${g.id}" ${r0.act.groupId===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Set priority</label><select id="raPrio"><option value="">— leave as is —</option>${aPRIOS().map(p=>`<option value="${p.id}" ${r0.act.prio===p.id?'selected':''}>${p.label}</option>`).join('')}<option value="min3" ${r0.act.prioAtLeast===3?'selected':''}>at least High</option><option value="min4" ${r0.act.prioAtLeast===4?'selected':''}>at least Urgent</option></select></div>
          <div class="field"><label>Add tag</label><input type="text" id="raTag" value="${esc(r0.act.tag||'')}" placeholder="optional"></div>
          <div class="field" style="padding-top:22px">
            <label class="mini" style="display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0"><input type="checkbox" id="raNotify" ${r0.act.notify?'checked':''} style="width:auto"> notify the board</label>
          </div>
        </div></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveRule('${id||''}')">${id?'Save rule':'Create rule'}</button></div>`;
  ruleDrawConds();
  document.getElementById('scrim').classList.add('open');
  document.getElementById('rName').focus();
}
function ruleDrawConds(){
  const rowHtml = (c,gi,i)=>`
    <div class="grid g-2" style="gap:12px;margin-bottom:8px" data-cond>
      <div class="grid g-2" style="gap:12px">
        <select onchange="_ruleDraft.condGroups[${gi}][${i}].field=this.value">${[['from','From address'],['fromDomain','Sender domain'],['to','To mailbox'],['subject','Subject'],['text','Subject or body']].map(([v,l])=>`<option value="${v}" ${c.field===v?'selected':''}>${l}</option>`).join('')}</select>
        <select onchange="_ruleDraft.condGroups[${gi}][${i}].op=this.value"><option value="contains" ${c.op==='contains'?'selected':''}>contains</option><option value="is" ${c.op==='is'?'selected':''}>is</option></select>
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" value="${esc(c.value)}" oninput="_ruleDraft.condGroups[${gi}][${i}].value=this.value" placeholder="value — commas mean any-of" style="flex:1">
        <button class="rowbtn" onclick="_ruleDraft.condGroups[${gi}].splice(${i},1);if(!_ruleDraft.condGroups[${gi}].length)_ruleDraft.condGroups.splice(${gi},1);ruleDrawConds()">×</button></div>
    </div>`;
  document.getElementById('rConds').innerHTML = _ruleDraft.condGroups.map((grpC,gi)=>
    (gi?`<div class="mini muted" style="text-align:center;margin:2px 0 8px">— or —</div>`:'')
    + grpC.map((c,i)=>rowHtml(c,gi,i)).join('')
  ).join('') || `<div class="mini muted" style="margin-bottom:8px">No conditions — matches every inbound message.</div>`;
}
function ruleAddCond(){
  if(!_ruleDraft.condGroups.length) _ruleDraft.condGroups.push([]);
  _ruleDraft.condGroups[_ruleDraft.condGroups.length-1].push({field:'from',op:'contains',value:''});
  ruleDrawConds(); }
function ruleAddOrGroup(){
  _ruleDraft.condGroups.push([{field:'from',op:'contains',value:''}]);
  ruleDrawConds(); }
function saveRule(id){
  const name = document.getElementById('rName').value.trim();
  if(!name){ toast('Give the rule a name.'); return; }
  const conds = packGroups(_ruleDraft.condGroups);
  const pv = document.getElementById('raPrio').value;
  const act = {};
  const gv = document.getElementById('raGroup').value; if(gv) act.groupId = gv;
  if(pv==='min3') act.prioAtLeast=3; else if(pv==='min4') act.prioAtLeast=4; else if(pv) act.prio=Number(pv);
  const tg = document.getElementById('raTag').value.trim(); if(tg) act.tag=tg;
  if(document.getElementById('raNotify').checked) act.notify=true;
  const r = id? RULES.find(x=>x.id===id) : { id:'r'+(nextRuleIx++), enabled:true, runs:0 };
  const r0 = id? JSON.stringify(r) : null;
  Object.assign(r, { name, conds, act });
  if(!id) RULES.push(r);
  log(id?'Rule updated':'Rule created', name);
  toast(`Rule “${name}” ${id?'saved':'created'} — it runs on the next inbound message.`);
  closeModal(); render();
  if(id){
    if(JSON.stringify(r)!==r0 && isUuid(id)) ruleUp(id,{name:r.name,conditions:r.conds,actions:r.act});
  }else{
    ruleMk({kind:'mail_rule',name:r.name,conditions:r.conds,actions:r.act,enabled:true});
  }
}

/* ---- canned responses (card renders on the Settings page) --------------- */
function cannedModal(cid){
  if(!can('manage_settings')) return;
  const c0 = cid? CANNED.find(x=>x.id===cid) : {};
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${cid?'Edit canned response':'Add canned response'}</h3><p>Template variables render per ticket: <span class="tape">#{customer.first}</span> <span class="tape">#{customer.name}</span> <span class="tape">##{ticket.number}</span> <span class="tape">#{ticket.title}</span> <span class="tape">#{agent.name}</span> <span class="tape">#{client.name}</span></p></div>
    <div class="modal-body">
      <div class="field"><label>Name</label><input type="text" id="cnName" value="${esc(c0.name||'')}"></div>
      <div class="field"><label>Body</label><textarea id="cnBody" rows="6" style="width:100%;font:inherit;font-size:13px">${esc(c0.body||'')}</textarea></div>
    </div>
    <div class="modal-foot">${cid?`<button class="btn ghost" style="margin-right:auto" onclick="deleteCanned('${cid}')">Delete</button>`:''}<button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveCanned('${cid||''}')">${cid?'Save':'Add'}</button></div>`;
  document.getElementById('scrim').classList.add('open');
}
function saveCanned(cid){
  const name = document.getElementById('cnName').value.trim();
  const body = document.getElementById('cnBody').value;
  if(!name || !body.trim()){ toast('Canned responses need a name and a body.'); return; }
  if(cid){
    const c=CANNED.find(x=>x.id===cid);
    log('Canned response updated', c.name===name?name:`${c.name} → ${name}`);
    c.name=name; c.body=body;
    if(srvId(cid)) $fetch('/api/settings/canned/'+encodeURIComponent(cid),{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({name,body})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
  }else{
    CANNED.push({ id:'cr'+(nextCannedIx++), name, body });
    log('Canned response added', name);
    $fetch('/api/settings/canned',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({name,body})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
        setTimeout(()=>hydrate(),400); });     /* pick up the server id */
  }
  closeModal(); render();
}
function deleteCanned(cid){
  const i = CANNED.findIndex(x=>x.id===cid);
  log('Canned response deleted', CANNED[i].name);
  const wasSrv = srvId(cid);
  CANNED.splice(i,1); closeModal(); render();
  if(wasSrv) $fetch('/api/settings/canned/'+encodeURIComponent(cid),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({active:false})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
}

/* ---- authentication card (renders on the Settings page) — every change
   funnels into one debounced PUT of the whole auth config ---- */
let _authT = null;
function authPut(){ clearTimeout(_authT); _authT=setTimeout(()=>{
  $fetch('/api/settings/config/auth',{method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({value:{sso_enabled:!!AUTH_CFG.ssoConnected,
      tenant:AUTH_CFG.tenant||'', client_id:AUTH_CFG.clientId||'',
      redirect_uri:AUTH_CFG.redirectUri||'',
      local_passwords:!!AUTH_CFG.localPasswords,
      role_mapping:!!AUTH_CFG.roleMapping, mfa:AUTH_CFG.mfa||'optional'}})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
},500); }
function authSet(k, v, srcEl){
  const was = AUTH_CFG[k]; AUTH_CFG[k]=v;
  log('Authentication config changed', `${k}: ${was} → ${v}`);
  commitRender(srcEl);
  authPut();
}
function authToggleSSO(){
  /* lockout guard: never let both sign-in paths go dark */
  if(AUTH_CFG.ssoConnected && !AUTH_CFG.localPasswords){
    toast('Enable local passwords first — disconnecting SSO with no fallback locks everyone out.'); return;
  }
  AUTH_CFG.ssoConnected = !AUTH_CFG.ssoConnected;
  log(AUTH_CFG.ssoConnected?'Entra SSO connected':'Entra SSO disconnected', AUTH_CFG.ssoConnected?`tenant ${AUTH_CFG.tenant}`:'local passwords remain as fallback');
  render();
  authPut();
}
function authToggleLocal(){
  if(AUTH_CFG.localPasswords && !AUTH_CFG.ssoConnected){
    toast('Reconnect SSO first — disabling the only sign-in method locks everyone out.'); return;
  }
  AUTH_CFG.localPasswords = !AUTH_CFG.localPasswords;
  log('Local passwords '+(AUTH_CFG.localPasswords?'enabled':'disabled'), AUTH_CFG.localPasswords?'fallback credentials active':'SSO only — nothing to phish');
  render();
  authPut();
}
function authToggleMapping(){
  AUTH_CFG.roleMapping = !AUTH_CFG.roleMapping;
  log(AUTH_CFG.roleMapping?'Entra role mapping enabled':'Entra role mapping disabled',
      AUTH_CFG.roleMapping?'group membership assigns roles at sign-in':'roles are now assigned manually per agent in the Directory');
  toast(AUTH_CFG.roleMapping?'Automatic — Entra groups assign roles at sign-in.':'Manual — set each agent’s role in Directory → Agents.');
  render();
  authPut();
}

/* ---- SLA targets + business hours (cards render on the Settings page);
   each editor mirrors its own app_config key, debounced ---- */
let _slaT = null, _bizT = null;
function slaPush(){ clearTimeout(_slaT); _slaT=setTimeout(()=>{
  const sla={}; Object.keys(SLA).forEach(k=>{ const p=SLA[k];
    if(p&&p.fr!=null) sla[k]={fr:Number(p.fr),res:Number(p.res)}; });
  $fetch('/api/settings/config/sla',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:sla})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
},600); }
function bizPush(){ clearTimeout(_bizT); _bizT=setTimeout(()=>{
  const biz={days:BIZ.days,start:BIZ.start,end:BIZ.end,holidays:BIZ.holidays};
  if(BIZ.tz) biz.tz=BIZ.tz;
  $fetch('/api/settings/config/business_hours',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({value:biz})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
},600); }
function slaSet(pid, k, v, label){
  SLA[pid] = SLA[pid]||{};
  SLA[pid][k] = Number(v)||SLA[pid][k];
  log('SLA changed', `${label} · ${k==='fr'?'first response':'resolution'}`);
  render();
  slaPush();
}
function bizDay(i, on){
  if(on && !BIZ.days.includes(i)) BIZ.days.push(i);
  if(!on) BIZ.days.splice(BIZ.days.indexOf(i),1);
  if(!BIZ.days.length){ BIZ.days.push(i); toast('At least one working day.'); }
  BIZ.days.sort();
  log('Business hours changed', `working days: ${BIZ.days.map(d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`);
  render();
  bizPush();
}
function bizHours(k, v, srcEl){
  const n = Number(v); if(isNaN(n)) return;
  const was = `${BIZ.start}:00–${BIZ.end}:00`;
  BIZ[k] = n;
  if(BIZ.end<=BIZ.start){ BIZ.end = BIZ.start+1; }
  log('Business hours changed', `${was} → ${BIZ.start}:00–${BIZ.end}:00`);
  commitRender(srcEl);
  bizPush();
}
function bizHolidays(v, srcEl){
  BIZ.holidays = v.split(',').map(x=>x.trim()).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x));
  log('Business hours changed', `holidays: ${BIZ.holidays.join(', ')||'none'}`);
  commitRender(srcEl);
  bizPush();
}
