/* ==========================================================================
   js/desk/views/audit.js — the Audit Log view and its filters.
   Owns: viewAudit() · setAF()/clearAF()/auditPreset() (the state.af filter
   bag) · auditFiltered(). state.audit hydrates from GET /api/bootstrap
   (api.js); CSV copy/export are the shared exporters in views/tickets.js
   (copyAuditCSV/exportAuditCSV).
   Endpoints: none.
   ========================================================================== */

function setAF(k,v){ (state.af=state.af||{}); state.af[k]=v; render(); }
function clearAF(){ state.af = { preset:'all', from:'', to:'', who:'all', action:'all', q:'' }; render(); }
function auditPreset(p){ state.af = Object.assign(state.af||{}, {preset:p, from:'', to:''}); render(); }
function auditFiltered(){
  const f = state.af || {};
  let rows = state.audit.slice();
  const cut = { '1h':1*H, '4h':4*H, '24h':24*H }[f.preset];
  if(cut) rows = rows.filter(a=>nowMs()-a.ts <= cut);
  /* date inputs are wall-clock; shift onto the nowMs() timeline */
  if(f.from) rows = rows.filter(a=>a.ts >= new Date(f.from+'T00:00').getTime()-(BOOT-NOW.getTime()));
  if(f.to) rows = rows.filter(a=>a.ts <= new Date(f.to+'T23:59').getTime()-(BOOT-NOW.getTime()));
  if(f.who && f.who!=='all') rows = rows.filter(a=>a.who===f.who);
  if(f.action && f.action!=='all') rows = rows.filter(a=>a.action===f.action);
  if(f.q){ const q=f.q.toLowerCase(); rows = rows.filter(a=>((a.action||'')+' '+(a.detail||'')+' '+(a.who||'')).toLowerCase().includes(q)); }
  return rows;
}
function viewAudit(){
  const f = state.af || (state.af = { preset:'all', from:'', to:'', who:'all', action:'all', q:'' });
  const opt = (v,l,cur)=>`<option value="${esc(v)}" ${cur===v?'selected':''}>${esc(l)}</option>`;
  const actions = [...new Set(state.audit.map(a=>a.action))].sort();
  const whos = [...new Set(state.audit.map(a=>a.who).filter(Boolean))].sort();
  const rows = auditFiltered();
  const anyF = f.preset!=='all'||f.from||f.to||f.who!=='all'||f.action!=='all'||f.q;
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
      <select style="width:auto" onchange="setAF('action',this.value)">${opt('all','All events',f.action)}${actions.map(a=>opt(a,a,f.action)).join('')}</select>
      <select style="width:auto" onchange="setAF('who',this.value)">${opt('all','All actors',f.who)}${whos.map(w=>opt(w,w,f.who)).join('')}</select>
      ${anyF?`<button class="btn sm ghost" onclick="clearAF()">Clear</button>`:''}
      <span class="spacer"></span><span class="mini muted">${rows.length} of ${state.audit.length} events</span>
    </div>
  </div></div>
  <div class="section-gap"></div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th style="width:150px">When</th><th style="width:170px">Who</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows.length? rows.map(a=>`<tr>
        <td class="time-cell">${fmtDT(a.ts)}</td>
        <td class="mini" style="padding-top:12px">${esc(a.who)}</td>
        <td><span class="cell-title">${esc(a.action)}</span></td>
        <td class="mini" style="padding-top:12px">${esc(a.detail)}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="mini muted" style="padding:18px 16px">Nothing matches these filters.</td></tr>`}</tbody>
    </table>
  </div>`;
}
