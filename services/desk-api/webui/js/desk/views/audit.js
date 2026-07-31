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
function viewAudit(){
  const f = af();
  const actions = [...new Set(state.audit.map(a=>a.action))].sort();
  const whos = [...new Set(state.audit.map(a=>a.who).filter(Boolean))].sort();
  const rows = auditFiltered();
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
      <tbody>${rows.length? rows.map(a=>`<tr>
        <td class="time-cell">${fmtDT(a.ts)}</td>
        <td class="mini" style="padding-top:12px">${esc(a.who)}</td>
        <td><span class="cell-title">${esc(a.action)}</span></td>
        <td class="mini" style="padding-top:12px">${esc(a.detail)}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="mini muted" style="padding:18px 16px">Nothing matches these filters.</td></tr>`}</tbody>
    </table>
  </div>`;
}
