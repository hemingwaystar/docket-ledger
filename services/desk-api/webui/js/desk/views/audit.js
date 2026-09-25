/* ==========================================================================
   js/desk/views/audit.js — the Audit Log view and its filters.
   Owns: viewAudit() · af()/setAF()/clearAF()/auditPreset() (the state.af
   filter bag — who/action are multi-select arrays, empty = all; multiCombo
   lives in render.js) · auditFiltered(). state.audit hydrates from
   GET /api/bootstrap (api.js); CSV copy/export are the shared exporters in
   views/tickets.js (copyAuditCSV/exportAuditCSV — they export the WHOLE
   log, not this view's slice, by design).
   Endpoints: none.
   ========================================================================== */

function af(){
  const f = state.af = Object.assign({ preset:'all', from:'', to:'', who:[], action:[], q:'' }, state.af||{});
  /* re-clone the array keys every read so the default empties are never
     shared into (or mutated through) live filter state */
  ['who','action'].forEach(k=>{ f[k] = Array.isArray(f[k]) ? f[k].slice() : []; });
  return f;
}
function setAF(k,v){ af()[k]=v; render(); }
/* multiCombo onchg targets — the component calls window[name](selectedArr),
   so each control gets its own named global (one function per control) */
function setAFAction(vals){ setAF('action', vals); }
function setAFWho(vals){ setAF('who', vals); }
function clearAF(){ state.af = null; af(); render(); }
function auditPreset(p){ Object.assign(af(), {preset:p, from:'', to:''}); render(); }
function auditFiltered(){
  const f = af();
  let rows = state.audit.slice();
  const cut = { '1h':1*H, '4h':4*H, '24h':24*H }[f.preset];
  if(cut) rows = rows.filter(a=>nowMs()-a.ts <= cut);
  /* date inputs are wall-clock; shift onto the nowMs() timeline */
  if(f.from) rows = rows.filter(a=>a.ts >= new Date(f.from+'T00:00').getTime()-(BOOT-NOW.getTime()));
  if(f.to) rows = rows.filter(a=>a.ts <= new Date(f.to+'T23:59').getTime()-(BOOT-NOW.getTime()));
  if(f.who.length) rows = rows.filter(a=>f.who.includes(a.who));
  if(f.action.length) rows = rows.filter(a=>f.action.includes(a.action));
  if(f.q){ const q=f.q.toLowerCase(); rows = rows.filter(a=>((a.action||'')+' '+(a.detail||'')+' '+(a.who||'')).toLowerCase().includes(q)); }
  return rows;
}
/* Events (audit.events — changes) vs Access log (audit.access — reads and
   disclosures, 0051). Both are view_audit only. */
function auditTabs(){
  const t = state.auditTab || 'events';
  return `<div class="seg" style="margin-bottom:10px">
    <button class="${t==='events'?'on':''}" onclick="state.auditTab='events';render()">Change events</button>
    <button class="${t==='access'?'on':''}" onclick="state.auditTab='access';render()">Access log</button></div>`;
}
function viewAudit(){
  if((state.auditTab||'events')==='access') return auditTabs() + viewAccessLog();
  return auditTabs() + viewAuditEvents();
}

/* ---- access log: server-filtered (kind / ticket / dates), text search is
   local over the fetched page. Filter values live in state.acf (never only
   in the DOM — background renders would wipe them). ---- */
function acf(){ return state.acf = Object.assign({ kind:'', ticket:'', from:'', to:'', q:'' }, state.acf||{}); }
function accessQuery(){
  const f = acf(), p = new URLSearchParams({limit:'2000'});
  if(f.kind) p.set('kind', f.kind);
  if(/^\d+$/.test(String(f.ticket).trim())) p.set('ticket', String(f.ticket).trim());
  if(f.from) p.set('start', f.from);
  if(f.to) p.set('end', f.to);
  return p.toString();
}
function accessLoad(force){
  const q = accessQuery(), c = state.accessLog;
  if(!force && c && c.q===q && (c.loading || nowMs()-c.at < 30000)) return;
  state.accessLog = { q, rows:(c&&c.q===q)?c.rows:null, at:nowMs(), loading:true };
  $fetch('/api/access?'+q).then(async r=>{
    const d = await r.json().catch(()=>({}));
    if(!r.ok){ state.accessLog = { q, rows:[], at:nowMs(), loading:false, err:d.detail||('HTTP '+r.status) }; }
    else state.accessLog = { q, rows:d.access||[], at:nowMs(), loading:false };
    if(state.view==='audit' && state.auditTab==='access' && !editingText()) render();
  }).catch(()=>{ state.accessLog = { q, rows:[], at:nowMs(), loading:false, err:'unreachable' }; });
}
function setACF(k, v){ acf()[k] = v; accessLoad(); render(); }
function accessRows(){
  const f = acf(), c = state.accessLog || {};
  let rows = c.rows || [];
  if(f.q){ const q=f.q.toLowerCase(); rows = rows.filter(x=>((x.who||'')+' '+(x.detail||'')+' '+(x.ip||'')+' '+(x.ticketId||'')).toLowerCase().includes(q)); }
  return rows;
}
function accessCSVRows(){
  const data = [['when','who','app','what','ticket','detail','ip','user agent']];
  accessRows().forEach(x=>data.push([new Date(x.ts).toISOString(), x.who, x.app,
    ACCESS_KINDS[x.kind]||x.kind, x.ticketId||'', x.detail, x.ip, x.ua]));
  return data;
}
function viewAccessLog(){
  accessLoad();
  const f = acf(), c = state.accessLog || {};
  const rows = accessRows(), pg = paginate('access', rows);
  const anyF = f.kind||f.ticket||f.from||f.to||f.q;
  return `
  ${can('export_csv')?`<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
    <button class="btn sm" onclick="copyRowsCSV(accessCSVRows(),'Access log CSV')">Copy</button>
    <button class="btn primary" onclick="downloadCSV('docket-access-log-'+msDate(nowMs())+'.csv', accessCSVRows())">${icon(IC.export)}Export CSV</button>
  </div>`:''}
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
    <div class="mini muted">Every ticket opened, attachment downloaded, page load and export — who, when and from where. Kept permanently; visible only to roles with the audit permission.</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <select onchange="setACF('kind',this.value)" style="width:auto">
        <option value="">All access</option>
        ${Object.entries(ACCESS_KINDS).map(([k,l])=>`<option value="${k}" ${f.kind===k?'selected':''}>${esc(l)}</option>`).join('')}</select>
      <input type="text" inputmode="numeric" placeholder="Ticket #" value="${esc(f.ticket)}" style="width:110px" data-fkey="acf-ticket" onchange="setACF('ticket',this.value.replace(/[^0-9]/g,''))">
      <label class="mini muted" style="display:flex;align-items:center;gap:5px">from <input type="date" value="${f.from}" onchange="setACF('from',this.value)"></label>
      <label class="mini muted" style="display:flex;align-items:center;gap:5px">to <input type="date" value="${f.to}" onchange="setACF('to',this.value)"></label>
      <div class="search">${icon(IC.search)}<input type="text" placeholder="Search person, detail, IP…" value="${esc(f.q||'')}" data-fkey="acf-q" oninput="acf().q=this.value;render()"></div>
      ${anyF?`<button class="btn sm ghost" onclick="state.acf=null;accessLoad(true);render()">Clear</button>`:''}
      <button class="btn sm ghost" onclick="accessLoad(true);render()">Refresh</button>
      <span class="spacer"></span><span class="mini muted">${c.loading&&!c.rows?'Loading…':`${rows.length} record${rows.length===1?'':'s'}${(c.rows||[]).length>=2000?' (newest 2,000 — narrow the dates for more)':''}`}</span>
    </div>
  </div></div>
  <div class="section-gap"></div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th style="width:150px">When</th><th style="width:160px">Who</th><th style="width:170px">What</th><th style="width:90px">Ticket</th><th>Detail</th><th style="width:120px">From</th></tr></thead>
      <tbody>${c.err?`<tr><td colspan="6" class="mini" style="padding:18px 16px;color:var(--void)">Couldn’t load the access log — ${esc(c.err)}</td></tr>`
        : rows.length? pg.slice.map(x=>`<tr>
        <td class="time-cell">${fmtDT(x.ts)}</td>
        <td class="mini" style="padding-top:12px">${esc(x.who||'—')}</td>
        <td><span class="cell-title">${esc(ACCESS_KINDS[x.kind]||x.kind)}</span>${x.app==='ledger'?' <span class="mini muted">· Ledger</span>':''}</td>
        <td class="mini" style="padding-top:12px">${x.ticketId?`<a href="#" onclick="openTicket(${Number(x.ticketId)});return false" style="color:var(--brand)">#${Number(x.ticketId)}</a>`:'—'}</td>
        <td class="mini audit-detail" style="padding-top:12px">${esc(x.detail||'')}</td>
        <td class="mini muted tape" style="padding-top:12px" title="${esc(x.ua||'')}">${esc(x.ip||'')}</td>
      </tr>`).join('') : `<tr><td colspan="6" class="mini muted" style="padding:18px 16px">${c.loading?'Loading…':'Nothing matches these filters.'}</td></tr>`}</tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function viewAuditEvents(){
  const f = af();
  const actions = [...new Set(state.audit.map(a=>a.action))].sort();
  const whos = [...new Set(state.audit.map(a=>a.who).filter(Boolean))].sort();
  const rows = auditFiltered();
  const pg = paginate('audit', rows);
  const anyF = f.preset!=='all'||f.from||f.to||f.who.length||f.action.length||f.q;
  return `
  ${can('export_csv')?`<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
    <button class="btn sm" onclick="copyAuditCSV()">Copy</button>
    <button class="btn primary" onclick="exportAuditCSV()">${icon(IC.export)}Export CSV</button>
  </div>`:''}
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><span class="mini muted" style="width:52px;text-transform:uppercase;letter-spacing:.07em;font-weight:600">Period</span>
      <div class="seg">${[['1h','Last hour'],['4h','Last 4h'],['24h','Last 24h'],['all','All time']].map(([v,l])=>`<button class="${f.preset===v?'on':''}" onclick="auditPreset('${v}')">${l}</button>`).join('')}</div>
      <label class="mini muted" style="display:flex;align-items:center;gap:5px">from <input type="date" value="${f.from}" onchange="setAF('from',this.value)"></label>
      <label class="mini muted" style="display:flex;align-items:center;gap:5px">to <input type="date" value="${f.to}" onchange="setAF('to',this.value)"></label>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><span class="mini muted" style="width:52px;text-transform:uppercase;letter-spacing:.07em;font-weight:600">Filters</span>
      <div class="search">${icon(IC.search)}<input type="text" placeholder="Search action, detail, actor…" value="${esc(f.q||'')}" data-fkey="daf-q" oninput="setAF('q',this.value)"></div>
      <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('afAction', actions.map(a=>({v:a,label:a})), f.action, 'setAFAction', 'All events')}</span>
      <span style="display:inline-block;min-width:160px;vertical-align:middle">${multiCombo('afWho', whos.map(w=>({v:w,label:w})), f.who, 'setAFWho', 'All actors')}</span>
      ${anyF?`<button class="btn sm ghost" onclick="clearAF()">Clear</button>`:''}
      <span class="spacer"></span><span class="mini muted">${rows.length} of ${state.audit.length} events</span>
    </div>
  </div></div>
  <div class="section-gap"></div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th style="width:150px">When</th><th style="width:170px">Who</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows.length? pg.slice.map(a=>`<tr>
        <td class="time-cell">${fmtDT(a.ts)}</td>
        <td class="mini" style="padding-top:12px">${esc(a.who)}</td>
        <td><span class="cell-title">${esc(a.action)}</span></td>
        <td class="mini audit-detail" style="padding-top:12px">${auditBody(a.detail, 'al:'+a.ts+':'+a.action)}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="mini muted" style="padding:18px 16px">Nothing matches these filters.</td></tr>`}</tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}
