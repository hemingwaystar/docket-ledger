/* ==========================================================================
   Ledger — views/audit.js
   Audit-log view: filterable event list over state.audit (server-written,
   read-only truth — nothing here edits it), plus CSV download / clipboard
   copy of the filtered rows. Filters live in state.auf — its own object
   and its own setAuf/clearAuf, independent of Approvals' state.af — and
   are built on first visit.
   No server endpoints called.
   ========================================================================== */

function viewAudit(){
  const f = state.auf || (state.auf = {from:'', to:'', actor:'all', action:'all', entity:'all', q:''});
  const opt=(v,l,cur)=>`<option value="${esc(v)}" ${cur===v?'selected':''}>${esc(l)}</option>`;
  const actions=[...new Set(state.audit.map(a=>a.action))].sort();
  const actors=[...new Set(state.audit.map(a=>a.actor).filter(Boolean))].sort();
  /* area = the entityId PREFIX ('entry:…' → entry) — the old a.entity field
     never existed, so the whole filter dimension was silently dead (audit) */
  const entities=[...new Set(state.audit.map(a=>(a.entityId||'').split(':')[0]).filter(Boolean))].sort();
  const entLabel={entry:'Entries',period:'Billing periods',client:'Clients'};
  const filtered=auditFiltered();
  const pg=paginate('audit',filtered);
  const controls=`
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:13px">
    <div class="rpt-line"><span class="rpt-lab">Period</span>
      <div class="seg">
        <button onclick="auditPreset('7d')">Last 7 days</button>
        <button onclick="auditPreset('30d')">Last 30 days</button>
        <button onclick="auditPreset('thismonth')">This month</button>
        <button onclick="auditPreset('all')">All time</button>
      </div>
      <label class="mini" style="display:flex;align-items:center;gap:6px">from <input type="date" value="${f.from}" onchange="setAuf('from',this.value)"></label>
      <label class="mini" style="display:flex;align-items:center;gap:6px">to <input type="date" value="${f.to}" onchange="setAuf('to',this.value)"></label>
    </div>
    <div class="rpt-line"><span class="rpt-lab">Filters</span>
      <div class="search">${icon(IC.search)}<input type="text" placeholder="Search detail, event, actor…" value="${esc(f.q)}" data-fkey="laf-q" oninput="setAuf('q',this.value)"></div>
      <select onchange="setAuf('action',this.value)">${opt('all','All events',f.action)}${actions.map(a=>opt(a,a,f.action)).join('')}</select>
      <select onchange="setAuf('actor',this.value)">${opt('all','All actors',f.actor)}${actors.map(a=>opt(a,a,f.actor)).join('')}</select>
      ${entities.length?`<select onchange="setAuf('entity',this.value)">${opt('all','All areas',f.entity)}${entities.map(e=>opt(e,entLabel[e]||e,f.entity)).join('')}</select>`:''}
      ${(f.from||f.to||f.actor!=='all'||f.action!=='all'||f.entity!=='all'||f.q)?`<button class="btn sm ghost" onclick="clearAuf()">Clear</button>`:''}
    </div>
  </div></div>`;
  const body = filtered.length
    ? pg.slice.map(a=>`
      <tr>
        <td class="time-cell" style="white-space:nowrap">${fmtStamp(a.ts)}</td>
        <td><span class="chip ${auditChip(a.action)}"><span class="cdot"></span>${esc(a.action)}</span></td>
        <td>${esc(a.detail)}</td>
        <td class="cell-meta">${esc(a.actor)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="padding:26px;text-align:center" class="muted">No events match these filters. Widen the date range or clear a filter.</td></tr>`;
  return `<div class="notice info" style="margin-bottom:16px">${icon(IC.audit)}<div>Every change is recorded here and can’t be edited — including entries <b>removed in Docket</b>, so a removed time event is always accounted for — the ledger keeps its own record.</div></div>
  ${controls}
  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Audit log</h3><span class="hint">${filtered.length} of ${state.audit.length} event${state.audit.length===1?'':'s'}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn sm" onclick="copyAudit()">Copy</button>
        <button class="btn primary" onclick="downloadAudit()">${icon(IC.export)}Export CSV</button>
      </div></div>
    <table class="tbl">
      <thead><tr><th style="width:150px">When</th><th style="width:190px">Event</th><th>Detail</th><th style="width:140px">Actor</th></tr></thead>
      <tbody>${body}</tbody></table>${pagerBar(pg)}</div>`;
}
function setAuf(k,v){ state.auf[k]=v; if(k!=='q') render(); else softRerender(); }
function clearAuf(){ state.auf={from:'', to:'', actor:'all', action:'all', entity:'all', q:''}; render(); }
function auditRange(){
  const f=state.auf||{};
  const from = f.from ? new Date(f.from+'T00:00:00').getTime() : -Infinity;
  const to   = f.to   ? new Date(f.to+'T23:59:59').getTime()   :  Infinity;
  return [from,to];
}
function auditFiltered(){
  const f=state.auf||{}; const [from,to]=auditRange();
  let rows=state.audit.filter(a=>a.ts>=from && a.ts<=to);
  if(f.action&&f.action!=='all') rows=rows.filter(a=>a.action===f.action);
  if(f.actor &&f.actor!=='all')  rows=rows.filter(a=>a.actor===f.actor);
  if(f.entity&&f.entity!=='all') rows=rows.filter(a=>((a.entityId||'').split(':')[0])===f.entity);
  if(f.q){ const q=f.q.toLowerCase(); rows=rows.filter(a=>((a.action||'')+' '+(a.detail||'')+' '+(a.actor||'')).toLowerCase().includes(q)); }
  return rows;
}
function auditPreset(p){
  const now=NOW, f=state.auf;
  const d=n=>n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
  if(p==='all'){ f.from=''; f.to=''; }
  else if(p==='thismonth'){ f.from=d(new Date(now.getFullYear(),now.getMonth(),1)); f.to=d(now); }
  else { const days=p==='7d'?7:30; const s=new Date(now); s.setDate(now.getDate()-days); f.from=d(s); f.to=d(now); }
  render();
}
function auditCSV(){
  const q=v=>{ v=String(v==null?'':v); if(/^[=+\-@]/.test(v)) v="'"+v; /* formula-injection guard (audit) */
    return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const lines=[['When','Event','Detail','Actor','Area'].join(',')];
  auditFiltered().forEach(a=>lines.push([new Date(a.ts).toISOString(), a.action, a.detail, a.actor, (a.entityId||'').split(':')[0]].map(q).join(',')));
  return lines.join('\r\n');
}
function downloadAudit(){
  if(!auditFiltered().length){ toast('Nothing to export'); return; }
  const blob=new Blob([auditCSV()],{type:'text/csv;charset=utf-8'}); const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download='ledger-audit.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1200); toast('Exported ledger-audit.csv');
}
function copyAudit(){
  if(!auditFiltered().length){ toast('Nothing to copy'); return; }
  const csv=auditCSV();
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(csv).then(()=>toast('Audit copied — paste into a spreadsheet'),()=>toast('Copy blocked by browser'));
  else toast('Clipboard unavailable in this browser');
}
function auditChip(action){
  if(/approv/i.test(action)) return 'approved';
  if(/export/i.test(action)) return 'exported';
  if(/delete|void/i.test(action)) return 'void';
  if(/unclass/i.test(action)) return 'unclassified';
  if(/classif|reclass/i.test(action)) return 'billable';
  return 'pending';
}
