/* ==========================================================================
   Ledger — views/clients.js
   Client list + client detail: per-activity-type billing, retainer terms,
   ticket breakdown & filters (state.cf — tech / type / status are
   multi-select ARRAYS, empty = all; setCF toggles membership, 'all'/null
   clears; q / from / to stay scalar), and access control.
   Endpoints called here:
     PATCH /api/clients/{id}          — setClientCycle (cycle),
                                        toggleClientBillable (billable_default)
     PUT   /api/clients/{id}/rates    — clientRatePut (debounced 600 ms) for
                                        setClientRate (client-wide default),
                                        setClientTypeRate, toggleClientTypeBillable,
                                        clearClientTypeOverride (all-NULL row = inherit)
     PUT   /api/clients/{id}/default-rates — toggleClientUseDefaults (the
                                        client-wide “use global default rates”
                                        switch), toggleClientTypeDefault
                                        (per-type inherit toggle) — immediate,
                                        effective-dated flags
     PUT   /api/clients/{id}/access   — pushAccess (debounced 500 ms) for
                                        setClientAccessMode, toggleClientAccessTech,
                                        toggleClientAccessGroup
   Every mutation is optimistic: local state first, then the API call,
   oops() (alert + rehydrate) on error. retSet mutates local retainer terms
   only — no retainer endpoint exists; pricing math consumes them locally.
   ========================================================================== */

function viewClients(){
  const showMoney=canSeeMoney();
  const list=accessibleClients();
  const hidden=state.clients.length-list.length;
  const pg=paginate('clients',list);
  const rows=pg.slice.map(c=>{
    const es=state.entries.filter(e=>e.clientId===c.id && e.status!=='void' && !isLocked(e));
    let h=0,a=0; es.forEach(e=>{const p=priced(e); h+=p.h; a+=p.amount;});
    const acc = (!c.access||c.access.mode==='all')
      ? '<span class="chip nonbill slim"><span class="cdot"></span>Everyone</span>'
      : c.access.mode==='group'
      ? `<span class="chip submitted slim"><span class="cdot"></span>${(c.access.groups||[]).length} group${(c.access.groups||[]).length===1?'':'s'}</span>`
      : `<span class="chip submitted slim"><span class="cdot"></span>${(c.access.techs||[]).length} tech${(c.access.techs||[]).length===1?'':'s'}</span>`;
    return `<tr class="clickable" onclick="openClient('${c.id}')">
      <td><div class="cell-title">${esc(c.name)}${c.archivedInDocket?' <span class="chip void" style="padding:1px 8px;margin-left:6px"><span class="cdot"></span>archived in Docket</span>':''}</div><div class="cell-meta">client #${c.zorg}</div></td>
      <td><span class="chip nonbill" style="text-transform:capitalize;padding:1px 8px"><span class="cdot"></span>${c.cycle}</span></td>
      <td>${acc}</td>
      <td class="num">${es.length} · ${fmtHours(h)} h</td>
      ${showMoney?`<td class="num" style="font-weight:600">${fmtMoney(a)}</td>`:''}
      <td class="right"><button class="rowbtn" onclick="event.stopPropagation();openClient('${c.id}')">Open →</button></td>
    </tr>`;
  }).join('');
  return `
  ${hidden>0?`<div class="notice info" style="margin-bottom:16px">${icon(IC.client)}<div>${hidden} client${hidden===1?'':'s'} hidden — you don’t have access.</div></div>`:''}
  <div class="card"><table class="tbl">
    <thead><tr><th>Client</th><th>Cycle</th><th>Access</th><th class="num">Open work</th>${showMoney?'<th class="num">Amount</th>':''}<th></th></tr></thead>
    <tbody>${rows||`<tr><td colspan="6"><div class="empty">${icon(IC.client)}<div>No clients you can access.</div></div></td></tr>`}</tbody></table>${pagerBar(pg)}</div>`;
}

/* ===================== CLIENT DETAIL ===================== */
const CF_ARR=['tech','type','status'];   /* multi-select keys — empty array = all */
function setCF(k,v){
  state.cf=state.cf||{tech:[],type:[],status:[],q:'',from:'',to:''};
  if(CF_ARR.includes(k)){
    _mfNorm(state.cf,CF_ARR);
    if(v==null||v==='all') state.cf[k]=[];
    else { const a=state.cf[k], i=a.indexOf(v); if(i>=0) a.splice(i,1); else a.push(v); }
    render(); return;
  }
  state.cf[k]=v; render();
}
function viewClient(){
  const c=client(state.clientId);
  if(!c) return `<div class="card"><div class="empty">${icon(IC.client)}<div>Client not found. <a href="#" onclick="go('clients');return false">Back to clients</a>.</div></div></div>`;
  if(!canAccessClient(c)) return `<div class="card"><div class="empty">${icon(IC.lock)}<div>You don’t have access to this client.</div></div></div>`;
  const manage=can('manage_clients'), showMoney=canSeeMoney(), cf=_mfNorm(state.cf||(state.cf={tech:[],type:[],status:[],q:'',from:'',to:''}),CF_ARR);
  const cycles=['weekly','monthly'];   /* biweekly died in build 9 — the server has no such period (0003) */
  const back=`<button class="btn sm ghost" onclick="go('clients')">← All clients</button>`;

  /* ---- billing: per-activity-type ---- */
  const typeRows=state.types.filter(t=>!t.sentinel && t.active!==false).map(t=>{
    const ov=(c.rates&&c.rates[t.id])||null;
    const effBill = ov&&ov.billable!=null ? !!ov.billable : !!t.billable;
    const tf=(c.defaultTypeFlags||{})[t.id];
    const dfOn = !!c.useDefaults && !(tf&&tf.enabled===false);
    const dfCur = dfOn && state.defaultRates[t.id] ? state.defaultRates[t.id].rate : null;
    const effRate = effBill ? (ov&&ov.rate!=null?ov.rate:(c.rateOverride!=null?c.rateOverride:(dfCur!=null?dfCur:t.rate))) : 0;
    const overridden = !!ov && (ov.rate!=null||ov.billable!=null);
    const src = ov&&ov.rate!=null ? 'client override'
              : (c.rateOverride!=null&&effBill) ? 'client default rate'
              : (dfCur!=null&&effBill) ? 'global default'
              : 'type rate';
    return `<tr>
      <td><div class="cell-title">${esc(t.name)}</div><div class="cell-meta">${t.note?esc(t.note):'<span class="muted">—</span>'}</div></td>
      <td>${manage
        ? `<div style="display:flex;align-items:center;gap:8px"><button class="toggle ${effBill?'on':''}" onclick="toggleClientTypeBillable('${c.id}','${t.id}')"></button><span class="mini">${effBill?'Billable':'Non-billable'}</span></div>`
        : `<span class="chip ${effBill?'billable':'nonbill'} slim"><span class="cdot"></span>${effBill?'Billable':'Non-billable'}</span>`}</td>
      <td class="num">${!showMoney?'<span class="muted">—</span>':(manage
        ? `<input type="number" min="0" step="5" value="${effBill?effRate:''}" placeholder="${effBill?(c.rateOverride!=null?c.rateOverride:(dfCur!=null?dfCur:t.rate)):'—'}" data-fkey="cr-${c.id}-${t.id}" oninput="setClientTypeRate('${c.id}','${t.id}',this.value)" ${effBill?'':'disabled'} style="width:100px;text-align:right">`
        : (effBill?fmtMoney(effRate)+'/h':'—'))}</td>
      <td class="mini muted">${showMoney?src:''}${overridden&&manage?` · <a href="#" onclick="clearClientTypeOverride('${c.id}','${t.id}');return false" style="color:inherit;text-decoration:underline">reset</a>`:''}${c.useDefaults&&manage?` · <label class="mini" style="display:inline-flex;gap:5px;align-items:center;text-transform:none;cursor:pointer"><input type="checkbox" ${!(tf&&tf.enabled===false)?'checked':''} onclick="toggleClientTypeDefault('${c.id}','${t.id}')" style="width:auto"> inherit default</label>`:''}</td>
    </tr>`;
  }).join('');

  const billing=`<div class="card">
    ${retainersOn()?`<div class="card-head"><h3>Retainer / block hours</h3><span class="hint">${c.retainer&&c.retainer.enabled?'agreement active':'no agreement'}</span></div>
    <div class="card-pad" style="border-bottom:1px solid var(--line)">
      ${(()=>{ const r=c.retainer||{}; const per=periodFor(c.cycle, new Date());
        const rm = retainerFor(c) ? retainerMath(c.id, per.key) : null;
        return `
        ${manage?`<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <label class="mini" style="display:inline-flex;gap:6px;align-items:center;text-transform:none;cursor:pointer"><input type="checkbox" ${r.enabled?'checked':''} onchange="retSet('${c.id}','enabled',this.checked,this)" style="width:auto;accent-color:var(--brand)"> agreement active</label>
          <span class="mini muted">included h / cycle</span><input type="number" min="0" step="0.5" value="${r.includedHours??0}" style="width:74px" onchange="retSet('${c.id}','includedHours',this.value,this)" ${r.enabled?'':'disabled'}>
          <span class="mini muted">overage $/h</span><input type="number" min="0" value="${r.overageRate??''}" placeholder="std" style="width:74px" onchange="retSet('${c.id}','overageRate',this.value,this)" ${r.enabled?'':'disabled'}>
          <span class="mini muted">rollover cap h</span><input type="number" min="0" step="0.5" value="${r.rolloverCap??0}" style="width:70px" onchange="retSet('${c.id}','rolloverCap',this.value,this)" ${r.enabled?'':'disabled'}>
        </div>`:''}
        ${rm?`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <div style="flex:1;height:10px;background:#e8edec;border-radius:6px;overflow:hidden"><div style="height:100%;width:${Math.min(100, rm.used/rm.included*100||0)}%;background:${rm.overageH>0?'var(--warn,#b3261e)':'var(--brand)'}"></div></div>
          <span class="tape" style="font-weight:600">${rm.used.toFixed(2)} / ${rm.included.toFixed(2)} h</span>
        </div>
        <div class="mini muted">${rm.base} h included${rm.rollover?` + ${rm.rollover.toFixed(2)} h rolled over`:''} · ${rm.covered.toFixed(2)} h covered${rm.overageH>0?` · <b style="color:#b3261e">${rm.overageH.toFixed(2)} h overage @ ${fmtMoney(rm.oRate)}/h = ${fmtMoney(rm.overageAmt)}</b>`:' · no overage'} · this ${c.cycle} period</div>
        ${r.note?`<div class="mini muted" style="margin-top:6px">${esc(r.note)}</div>`:''}`
        : `<div class="mini muted">No block-hour agreement — all billable time prices at the normal rates.${manage?' Tick “agreement active” to start one.':''}</div>`}`; })()}
    </div>`:''}
    <div class="card-head"><h3>Billing configuration</h3><span class="hint">${manage?'per-activity-type rates for this client':'read-only — needs “Manage client billing & access”'}</span></div>
    <div class="card-pad">
      <div class="grid g-4" style="margin-bottom:16px">
        <div><div class="mini muted">Billing cycle</div>${manage?`<select onchange="setClientCycle('${c.id}',this.value)" style="text-transform:capitalize;margin-top:4px">${cycles.map(cy=>`<option value="${cy}" ${c.cycle===cy?'selected':''}>${cy}</option>`).join('')}</select>`:`<div class="v" style="text-transform:capitalize">${c.cycle}</div>`}</div>
        <div><div class="mini muted">Client default rate (all billable types)</div>${(manage&&showMoney)?`<input type="number" min="0" step="5" placeholder="use type rate" value="${c.rateOverride??''}" data-fkey="crw-${c.id}" oninput="setClientRate('${c.id}',this.value)" style="width:150px;margin-top:4px">`:`<div class="v tape">${showMoney?(c.rateOverride!=null?fmtMoney(c.rateOverride)+'/h':'type rate'):'—'}</div>`}</div>
        <div><div class="mini muted">Billable by default</div>${manage?`<label class="mini" style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer"><input type="checkbox" ${c.billableDefault?'checked':''} onchange="toggleClientBillable('${c.id}')"> new time bills</label>`:`<div class="v">${c.billableDefault?'Yes':'No'}</div>`}</div>
        <div><div class="mini muted">Shared client ID</div><div class="v tape">#${c.zorg}</div></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        ${manage?`<button class="toggle ${c.useDefaults?'on':''}" onclick="toggleClientUseDefaults('${c.id}')"></button>`:''}
        <span class="mini"><b>Use global default rates</b></span>
        <span class="mini muted">${c.useDefaults?'billable types with no client rate price at the Settings defaults — toggle individual types below':'off — this client prices only from its own rates and the type base rates'}</span>
      </div>
      <table class="tbl">
        <thead><tr><th>Activity type</th><th>Billable (this client)</th><th class="num">Rate ($/h)</th><th>Effective from</th></tr></thead>
        <tbody>${typeRows}</tbody></table>
      <div class="mini muted" style="margin-top:10px">Rate resolution: <b>per-type override</b> → <b>client default rate</b> → <b>global default</b> (when switched on) → <b>activity-type rate</b>. Overrides only change <b>open</b> entries; locked periods never re-price.</div>
    </div>
  </div>`;

  /* ---- ticket breakdown & filtering ---- */
  let es=state.entries.filter(e=>e.clientId===c.id);
  if(!can('view_all')) es=es.filter(e=>e.techId===state.myTechId);
  const [cfFrom,cfTo]=_dateRange(cf);
  es=es.filter(e=>e.startedAt>=cfFrom && e.startedAt<=cfTo);
  /* every multi-select predicate is any-of; empty = no constraint */
  if(can('view_all') && cf.tech.length) es=es.filter(e=>cf.tech.includes(e.techId));
  if(cf.type.length) es=es.filter(e=>{const t=atype(e.typeId);
    return cf.type.some(v=> v==='billable'?(t.billable&&!t.sentinel)
      : v==='nonbill'?(!t.billable&&!t.sentinel)
      : v==='unclassified'?t.sentinel : e.typeId===v);});
  if(cf.status.length) es=es.filter(e=> cf.status.some(s=> s==='void'?e.status==='void':s==='locked'?(isLocked(e)&&e.status!=='void'):s==='approved'?(e.tsApproved&&!isLocked(e)&&e.status!=='void'):s==='submitted'?(e.submitted&&!e.tsApproved&&!isLocked(e)&&e.status!=='void'):(e.status==='pending'&&!isLocked(e)&&!e.submitted)));
  if(cf.q){const q=cf.q.toLowerCase(); es=es.filter(e=>(e.ticketTitle+e.content+tech(e.techId).name).toLowerCase().includes(q));}
  es=es.slice().sort((a,b)=>b.startedAt-a.startedAt);
  const pgE=paginate('clientEntries:'+c.id, es);
  // breakdown by activity type
  const byType={}; let tot={h:0,a:0,n:0};
  es.forEach(e=>{const p=priced(e); if(e.status==='void')return; const k=e.typeId; (byType[k]=byType[k]||{h:0,a:0,n:0}); byType[k].h+=p.h; byType[k].a+=p.amount; byType[k].n++; tot.h+=p.h; tot.a+=p.amount; tot.n++;});
  const breakdownRows=Object.keys(byType).map(k=>{const b=byType[k];return `<tr><td>${esc(atype(k).name)}</td><td class="num">${b.n}</td><td class="num">${fmtHours(b.h)}</td>${showMoney?`<td class="num" style="font-weight:600">${fmtMoney(b.a)}</td>`:''}</tr>`;}).join('');
  const cfAny = cf.from||cf.to||(can('view_all')&&cf.tech.length)||cf.type.length||cf.status.length||cf.q;
  const filters=`<div class="card" style="margin-bottom:12px"><div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="rpt-line"><span class="rpt-lab">Period</span>
      <div class="seg">
        <button onclick="cfPreset('7d')">7 days</button>
        <button onclick="cfPreset('30d')">30 days</button>
        <button onclick="cfPreset('90d')">90 days</button>
        <button onclick="cfPreset('thismonth')">This month</button>
        <button onclick="cfPreset('all')">All time</button>
      </div>
      <label class="mini" style="display:flex;align-items:center;gap:6px">from <input type="date" value="${cf.from||''}" onchange="setCF('from',this.value)"></label>
      <label class="mini" style="display:flex;align-items:center;gap:6px">to <input type="date" value="${cf.to||''}" onchange="setCF('to',this.value)"></label>
    </div>
    <div class="rpt-line"><span class="rpt-lab">Filters</span>
      <div class="search">${icon(IC.search)}<input type="text" placeholder="Search ticket, note${can('view_all')?', tech':''}…" value="${esc(cf.q)}" data-fkey="cf-q" oninput="setCF('q',this.value)"></div>
      ${can('view_all')?`<span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('cfTech', state.techs.map(t=>({v:t.id,label:t.name})), cf.tech, function(v){ setCF('tech',v); }, 'All techs')}</span>`:''}
      <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('cfType', [{v:'billable',label:'Billable'},{v:'nonbill',label:'Non-billable'},{v:'unclassified',label:'Unclassified'},...state.types.filter(t=>!t.sentinel&&(t.active!==false||cf.type.includes(t.id))).map(t=>({v:t.id,label:t.name+(t.active===false?' (archived)':'')}))], cf.type, function(v){ setCF('type',v); }, 'All types')}</span>
      <div class="seg wrap">${['all','pending','submitted','approved','locked','void'].map(s=>`<button class="${s==='all'?(cf.status.length?'':'on'):(cf.status.includes(s)?'on':'')}" onclick="setCF('status','${s}')">${s[0].toUpperCase()+s.slice(1)}</button>`).join('')}</div>
      ${cfAny?`<button class="btn sm ghost" onclick="cfClear()">Clear</button>`:''}
    </div>
    <div class="rpt-line"><span class="rpt-lab">Showing</span><div class="mini">${es.length} entr${es.length===1?'y':'ies'} · <span class="tape">${fmtHours(tot.h)}</span> h${showMoney?` · <span class="tape" style="font-weight:600;color:var(--ink)">${fmtMoney(tot.a)}</span>`:''}</div></div>
  </div></div>`;
  const ticketRows=pgE.slice.map(e=>{const p=priced(e);return `<tr class="${e.status==='void'?'void':(isLocked(e)?'locked-row':'')}">
    <td><div class="cell-title">${esc(e.ticketTitle)}</div><div class="cell-meta">#${e.zTicket}${can('view_all')?' · '+esc(tech(e.techId).name):''} · ${fmtDate(e.startedAt)}</div></td>
    <td>${atype(e.typeId).sentinel?'<span class="chip unclassified slim"><span class="cdot"></span>Unclassified</span>':esc(atype(e.typeId).name)}</td>
    <td class="num" style="font-weight:600">${fmtHours(p.h)}</td>
    ${showMoney?`<td class="num">${p.billable?fmtMoney(p.amount):'<span class="muted">—</span>'}</td>`:''}
    <td>${statusChip(e)}</td></tr>`;}).join('');
  const breakdown=`<div class="card">
    <div class="card-head"><h3>Ticket breakdown</h3><span class="hint">all of this client's logged time</span></div>
    <div class="card-pad">
      ${breakdownRows?`<table class="tbl" style="margin-bottom:16px"><thead><tr><th>Activity type</th><th class="num">Entries</th><th class="num">Hours</th>${showMoney?'<th class="num">Amount</th>':''}</tr></thead>
        <tbody>${breakdownRows}</tbody>
        <tfoot><tr class="rpt-total"><td>Total</td><td class="num">${tot.n}</td><td class="num">${fmtHours(tot.h)}</td>${showMoney?`<td class="num">${fmtMoney(tot.a)}</td>`:''}</tr></tfoot></table>`:''}
      ${filters}
      <table class="tbl"><thead><tr><th>Ticket</th><th>Activity</th><th class="num">Hours</th>${showMoney?'<th class="num">Amount</th>':''}<th>Status</th></tr></thead>
        <tbody>${ticketRows||`<tr><td colspan="5"><div class="empty" style="padding:20px">${icon(IC.sheet)}<div>No entries match.</div></div></td></tr>`}</tbody></table>${pagerBar(pgE)}
    </div>
  </div>`;

  /* ---- access control ---- */
  const mode = (c.access&&c.access.mode)||'all';
  const restricted = mode==='restricted', grouped = mode==='group';
  const techChecks=state.techs.map(t=>{
    const on=(c.access&&c.access.techs||[]).includes(t.id);
    return `<label class="perm ${on?'on':''}" style="max-width:230px">
      <input type="checkbox" ${on?'checked':''} ${manage&&restricted?'':'disabled'} onclick="toggleClientAccessTech('${c.id}','${t.id}')">
      <span>${esc(t.name)}</span></label>`;
  }).join('');
  const groupChecks=state.zammadGroups.filter(g=>!g.archived).map(g=>{
    const on=(c.access&&c.access.groups||[]).includes(g.id);
    const members=state.techs.filter(t=>(t.groups||[]).includes(g.id)).length;
    return `<label class="perm ${on?'on':''}" style="max-width:230px">
      <input type="checkbox" ${on?'checked':''} ${manage&&grouped?'':'disabled'} onclick="toggleClientAccessGroup('${c.id}','${g.id}')">
      <span>${esc(g.name)} <span class="mini muted">· ${members} tech${members===1?'':'s'}</span></span></label>`;
  }).join('');
  const radio=(m,label,sub)=>`<label class="mini" style="display:flex;align-items:center;gap:7px"><input type="radio" name="acc" ${mode===m?'checked':''} ${manage?'':'disabled'} onclick="setClientAccessMode('${c.id}','${m}')"> <b>${label}</b> ${sub||''}</label>`;
  const access=`<div class="card">
    <div class="card-head"><h3>Client access</h3><span class="hint">${manage?'who can see &amp; work this client':'read-only'}</span></div>
    <div class="card-pad">
      <div class="notice info" style="margin-bottom:14px">${icon(IC.lock)}<div>Restrict this client to specific technicians or groups. Anyone without access <b>won’t see the client, its tickets, or its billing</b> — and can’t log or edit time against it. People with the <b>“Access every client”</b> permission always have access.</div></div>
      <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:14px">
        ${radio('all','Everyone','with client access')}
        ${radio('restricted','Only selected technicians','')}
        ${radio('group','Technicians in selected groups','')}
      </div>
      ${restricted?`<div style="display:flex;flex-flow:row wrap;gap:8px">${techChecks}</div>`
        :grouped?`<div style="display:flex;flex-flow:row wrap;gap:8px">${groupChecks}</div>
           <div class="mini muted" style="margin-top:10px">A technician gets access if they belong to <b>any</b> selected group. Group membership is shared with Docket.</div>`
        :'<div class="mini muted">All technicians with client access can see and work this client.</div>'}
    </div>
  </div>`;

  return `<div style="margin-bottom:14px">${back}</div>
    ${billing}<div class="section-gap"></div>${breakdown}<div class="section-gap"></div>${access}`;
}
function cfPreset(p){ state.cf=state.cf||{tech:[],type:[],status:[],q:'',from:'',to:''}; _presetDates(state.cf,p); render(); }
function cfClear(){ state.cf={tech:[],type:[],status:[],q:'',from:'',to:''}; render(); }
function retSet(cid, k, v, srcEl){
  const c = client(cid); c.retainer = c.retainer||{ enabled:false, includedHours:0, overageRate:null, rolloverCap:0, note:'' };
  const was = JSON.stringify({e:c.retainer.enabled,i:c.retainer.includedHours,o:c.retainer.overageRate,r:c.retainer.rolloverCap});
  if(k==='enabled') c.retainer.enabled = !!v;
  else if(k==='overageRate') c.retainer.overageRate = v===''? null : Number(v);
  else c.retainer[k] = Number(v)||0;
  log('Retainer agreement changed', `${c.name}: ${k} → ${k==='enabled'?(c.retainer.enabled?'active':'off'):(c.retainer[k]??'standard rates')} (was ${was})`);
  commitRender(srcEl);
}

/* ---- client billing & rate overrides ---- */
function setClientCycle(id,v){
  const c=client(id); c.cycle=v;
  log('Client cycle changed',`${esc(c.name)} → ${v}`,id); render();
  if(v!=='monthly'&&v!=='weekly'){ toast('Live billing supports monthly or weekly cycles'); hydrate(); return; }
  $fetch('/api/clients/'+encodeURIComponent(id),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({cycle:v})})
    .then(async r=>{ if(!r.ok) return oops(await jshort(r)); });
}
function toggleClientBillable(id){
  const c=client(id); if(!c) return;
  c.billableDefault=!c.billableDefault; render();
  $fetch('/api/clients/'+encodeURIComponent(id),{method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({billable_default:c.billableDefault})})
    .then(async r=>{ if(!r.ok) return oops(await jshort(r)); });
}
/* effective-dated override history: one row per day, today's edits collapse */
const histToday=(arr,field,val)=>{
  const today=new Date().toISOString().slice(0,10);
  const rest=(arr||[]).filter(h=>h.from!==today);
  rest.push({from:today,[field]:val!=null?val:null});
  return rest;
};
const rateTimers={};
const clientRatePut=(cid,tid,o)=>{
  const k=cid+'|'+(tid||'wide');
  clearTimeout(rateTimers[k]);
  rateTimers[k]=setTimeout(()=>
    $fetch('/api/clients/'+encodeURIComponent(cid)+'/rates',{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({activity_type:tid,
        rate_cents:(o&&o.rate!=null)?Math.round(o.rate*100):null,
        billable:(o&&o.billable!=null)?o.billable:null})})
      .then(async r=>{ if(!r.ok) return oops(await jshort(r));
        setTimeout(()=>hydrate(),300); }),600);
};
function setClientRate(cid,v){
  const c=client(cid);
  c.rateOverride = v===''?null:Number(v);
  c.rateOverrideHist=histToday(c.rateOverrideHist,'rate',c.rateOverride!=null?c.rateOverride:null);
  clientRatePut(cid,null,(c.rateOverride!=null)?{rate:c.rateOverride}:null);
  render();
}
function setClientTypeRate(cid,tid,v){
  const c=client(cid); c.rates=c.rates||{};
  const o=c.rates[tid]||(c.rates[tid]={});
  if(v===''){ delete o.rate; } else { o.rate=Number(v); }
  if(o.rate==null&&o.billable==null) delete c.rates[tid];
  const ov=c.rates[tid]||(c.rates[tid]={});
  ov.rateHist=histToday(ov.rateHist,'rate',ov.rate!=null?ov.rate:null);
  clientRatePut(cid,tid,ov); render();              /* debounced PUT; latest wins */
}
function toggleClientTypeBillable(cid,tid){
  const c=client(cid); const t=atype(tid);
  c.rates=c.rates||{};
  const o=c.rates[tid]||(c.rates[tid]={});
  const eff=o.billable!=null?o.billable:t.billable;
  o.billable=!eff;
  if(o.billable===t.billable){ delete o.billable; if(o.rate==null) delete c.rates[tid]; }
  log('Client billing changed',`${esc(c.name)} · ${esc(t.name)} → ${(o.billable!=null?o.billable:t.billable)?'billable':'non-billable'}`,cid);
  const ov=(c.rates||{})[tid];
  if(ov) ov.billableHist=histToday(ov.billableHist,'billable',ov.billable!=null?ov.billable:null);
  clientRatePut(cid,tid,ov); render();
}
function clearClientTypeOverride(cid,tid){
  const c=client(cid); c.rates=c.rates||{};
  delete c.rates[tid];
  const o=(c.rates[tid]={});
  o.rateHist=histToday(o.rateHist,'rate',null);
  o.billableHist=histToday(o.billableHist,'billable',null);
  clientRatePut(cid,tid,null); render();          /* all-NULL row = inherit, history kept */
}
/* ---- global-default opt-in: the client-wide switch + per-type toggles.
   Toggles mirror IMMEDIATELY (no debounce — row 34's lesson): local flip +
   dated history row first, oops() on refusal. Effective-dated flags mean a
   flip today never re-prices earlier time. ---- */
function toggleClientUseDefaults(cid){
  const c=client(cid); if(!c) return;
  c.useDefaults=!c.useDefaults;
  c.useDefaultsHist=histToday(c.useDefaultsHist,'enabled',c.useDefaults);
  log('Client billing changed', `${esc(c.name)} → global default rates ${c.useDefaults?'ON':'OFF'} (effective today; earlier time keeps its pricing)`, cid);
  render();
  $fetch('/api/clients/'+encodeURIComponent(cid)+'/default-rates',{method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({activity_type:null,enabled:c.useDefaults})})
    .then(async r=>{ if(!r.ok) return oops(await jshort(r)); setTimeout(()=>hydrate(),300); });
}
function toggleClientTypeDefault(cid,tid){
  const c=client(cid); if(!c) return;
  c.defaultTypeFlags=c.defaultTypeFlags||{};
  const o=c.defaultTypeFlags[tid]||(c.defaultTypeFlags[tid]={enabled:null,hist:[]});
  const was=!(o.enabled===false);
  o.enabled=!was;
  o.hist=histToday(o.hist,'enabled',o.enabled);
  log('Client billing changed', `${esc(c.name)} · ${esc(atype(tid).name)} → ${o.enabled?'inherits':'excluded from'} global default rates (effective today)`, cid);
  render();
  $fetch('/api/clients/'+encodeURIComponent(cid)+'/default-rates',{method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({activity_type:tid,enabled:o.enabled})})
    .then(async r=>{ if(!r.ok) return oops(await jshort(r)); setTimeout(()=>hydrate(),300); });
}

/* ---- access control ---- */
let accTimers={};
const pushAccess=cid=>{
  clearTimeout(accTimers[cid]);
  accTimers[cid]=setTimeout(()=>{
    const a=(client(cid)||{}).access||{mode:'all',techs:[],groups:[]};
    $fetch('/api/clients/'+encodeURIComponent(cid)+'/access',{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:a.mode,techs:a.techs||[],groups:a.groups||[]})})
      .then(async r=>{ if(!r.ok) return oops(await jshort(r)); });
  },500);
};
function setClientAccessMode(cid,mode){ const c=client(cid); c.access=c.access||{mode:'all',techs:[],groups:[]}; c.access.mode=mode; c.access.techs=c.access.techs||[]; c.access.groups=c.access.groups||[]; if(mode==='restricted'&&!c.access.techs.length){ c.access.techs=[state.myTechId].filter(Boolean); } log('Client access changed',`${esc(c.name)} → ${mode==='all'?'everyone':mode==='group'?'by group':'restricted'}`,cid); pushAccess(cid); render(); }
function toggleClientAccessTech(cid,tid){ const c=client(cid); c.access=c.access||{mode:'restricted',techs:[],groups:[]}; c.access.techs=c.access.techs||[]; const i=c.access.techs.indexOf(tid); if(i>=0)c.access.techs.splice(i,1); else c.access.techs.push(tid); pushAccess(cid); render(); }
function toggleClientAccessGroup(cid,gid){ const c=client(cid); c.access=c.access||{mode:'group',techs:[],groups:[]}; c.access.groups=c.access.groups||[]; const i=c.access.groups.indexOf(gid); if(i>=0)c.access.groups.splice(i,1); else c.access.groups.push(gid); pushAccess(cid); render(); }
