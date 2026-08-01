/* ==========================================================================
   js/desk/views/reports.js — reporting over the hydrated ticket set.
   Owns: state.rf filter state (RF_DEFAULTS / RF_ARRAYS / RF_BREAKDOWNS
   catalogs) · reportSlice() — the ONE filtered slice that the stat cards,
   charts, breakdown table and CSV export all read · reportBreakdown() ·
   viewReports · CSV export / copy (export_csv-gated).
   Endpoints: none — pure computation over state hydrated by api.js.
   Invariants: setRFQ re-renders live but restores focus + caret in the
   search box (the innerHTML rebuild would otherwise blur it on every
   keystroke — bug #26's lesson applied locally). The RF_ARRAYS filters are
   multi-selects (multiCombo, render.js): arrays of STRING values, empty
   array = no constraint. Archived entries stay out of the pickers unless
   currently selected (row 37).
   ========================================================================== */

/* Reports filter state: period preset or custom from/to range, date basis
   (updated vs created), group / client / tech / priority / state / tag
   multi-selects (empty = all), full-text search over titles + article
   bodies, and a selectable breakdown dimension for the table + CSV. */
const RF_DEFAULTS = { preset:'all', from:'', to:'', basis:'updated', group:[], client:[], tech:[], prio:[], st:[], tag:[], q:'', breakdown:'group' };
const RF_ARRAYS = ['group','client','tech','prio','st','tag'];
function rf(){
  const f = state.rf = Object.assign({}, RF_DEFAULTS, state.rf||{});
  /* re-clone the array keys every read so RF_DEFAULTS' empties are never
     shared into (or mutated through) live filter state */
  RF_ARRAYS.forEach(k=>{ f[k] = Array.isArray(f[k]) ? f[k].slice() : []; });
  return f;
}
function setRF(k,v){ rf()[k]=v; render(); }
/* multiCombo onchg targets — the component calls window[name](selectedArr),
   so each control gets its own named global (one function per control) */
function setRFGroup(vals){ setRF('group', vals); }
function setRFClient(vals){ setRF('client', vals); }
function setRFTech(vals){ setRF('tech', vals); }
function setRFPrio(vals){ setRF('prio', vals); }
function setRFSt(vals){ setRF('st', vals); }
function setRFTag(vals){ setRF('tag', vals); }
function setRFPreset(v){ const f=rf(); f.preset=v; f.from=''; f.to=''; render(); }
function setRFDate(k,v){ const f=rf(); f[k]=v; f.preset='custom'; render(); }
/* text search: re-render live but keep focus + caret in the search box
   (innerHTML rebuild would otherwise blur it on every keystroke) */
function setRFQ(el){ const pos=el.selectionStart; rf().q=el.value; render();
  const n=document.getElementById('rfQ'); if(n){ n.focus(); try{ n.setSelectionRange(pos,pos); }catch(_){} } }
function clearRF(){ const keep={ basis:rf().basis, breakdown:rf().breakdown }; state.rf = Object.assign({}, RF_DEFAULTS, keep); render(); }
/* the filtered slice — one function so the stat cards, charts, breakdown
   table and CSV export all see exactly the same tickets */
function reportSlice(){
  const f = rf();
  let sc = scoped();
  const bt = t => f.basis==='created' ? t.createdAt : t.updatedAt;
  if(f.from){ const s=new Date(f.from+'T00:00:00').getTime(); sc = sc.filter(t=>bt(t)>=s); }
  if(f.to){ const e=new Date(f.to+'T23:59:59').getTime(); sc = sc.filter(t=>bt(t)<=e); }
  if(!f.from && !f.to){
    const cut = { '24h':24*H, '7d':7*24*H, '30d':30*24*H }[f.preset];
    if(cut) sc = sc.filter(t=>nowMs()-bt(t) <= cut);
  }
  if(f.group.length) sc = sc.filter(t=>f.group.includes(String(t.groupId)));
  if(f.client.length) sc = sc.filter(t=>f.client.includes(String(t.clientId)));
  if(f.prio.length) sc = sc.filter(t=>f.prio.includes(String(t.prio)));
  if(f.tech.length) sc = sc.filter(t=>f.tech.includes(String(t.ownerId)) || t.time.some(e=>f.tech.includes(String(e.techId))));
  /* state entries mix two vocabularies — 'type:<kind>' pseudo-values and
     concrete state ids; a ticket matches if ANY selected entry matches */
  if(f.st.length) sc = sc.filter(t=>f.st.some(v=>
    v.startsWith('type:') ? (st8(t.st)||{}).type===v.slice(5) : t.st===v));
  if(f.tag.length) sc = sc.filter(t=>f.tag.some(v=>
    v==='(untagged)' ? t.tags.length===0 : t.tags.includes(v)));
  if(f.q){
    const ql = f.q.toLowerCase();
    sc = sc.filter(t =>
      String(t.id).includes(ql) ||
      (TITLES[t.id]||firstLine(t)).toLowerCase().includes(ql) ||
      client(t.clientId).name.toLowerCase().includes(ql) ||
      t.articles.some(a=>a.kind!=='sys' && (a.body||'').toLowerCase().includes(ql)));
  }
  return sc;
}
/* breakdown: group the slice by the chosen dimension with per-bucket metrics.
   Tag buckets can overlap (a ticket carries several tags) — that's expected. */
function reportBreakdown(sc){
  const f = rf();
  const push = (m,k,t)=>{ (m.get(k)||m.set(k,[]).get(k)).push(t); };
  const m = new Map();
  sc.forEach(t=>{
    if(f.breakdown==='group') push(m, grp(t.groupId).name, t);
    else if(f.breakdown==='client') push(m, client(t.clientId).name, t);
    else if(f.breakdown==='tech') push(m, t.ownerId?agent(t.ownerId).name:'(unassigned)', t);
    else if(f.breakdown==='prio') push(m, prio(t.prio).label, t);
    else if(f.breakdown==='state') push(m, st8(t.st).label, t);
    else if(f.breakdown==='tag'){ if(t.tags.length===0) push(m,'(untagged)',t); else t.tags.forEach(tag=>push(m,tag,t)); }
  });
  const rows = [...m.entries()].map(([label,ts])=>{
    const frs = ts.map(t=>{ const r=t.articles.find(a=>a.kind==='reply'); return r? (r.ts-t.createdAt)/H : null; }).filter(x=>x!==null).sort((a,b)=>a-b);
    return { label, n:ts.length,
      open: ts.filter(t=>!isDone(t)).length,
      resolved: ts.filter(isDone).length,
      hours: ts.reduce((a,t)=>a+timeTotal(t),0),
      medFR: frs.length? frs[Math.floor(frs.length/2)] : null };
  }).sort((a,b)=>b.n-a.n || b.hours-a.hours);
  return rows;
}
const RF_BREAKDOWNS = [['group','By group'],['client','By client'],['tech','By technician'],['prio','By priority'],['state','By state'],['tag','By tag']];
function reportCSVRowsDk(){
  const f = rf();
  const dim = (RF_BREAKDOWNS.find(([v])=>v===f.breakdown)||['','Dimension'])[1].replace('By ','');
  const data = [[dim.toLowerCase(), 'tickets', 'open', 'resolved', 'hours_logged', 'median_first_response_h']];
  reportBreakdown(reportSlice()).forEach(r=>
    data.push([r.label, r.n, r.open, r.resolved, r.hours.toFixed(2), r.medFR===null?'':r.medFR.toFixed(2)]));
  return data;
}
function exportReportCSV(){ if(!can('export_csv')){ toast('Your role can’t export data — ask an admin for the “Export & copy CSV data” permission.'); return; } downloadCSV(`docket-report-${rf().breakdown}-${msDate(nowMs())}.csv`, reportCSVRowsDk()); }
function copyReportCSV(){ if(!can('export_csv')) return; copyRowsCSV(reportCSVRowsDk(), 'Report CSV'); }
function viewReports(){
  const f = rf();
  const sc = reportSlice();
  const anyF = f.preset!=='all'||f.from||f.to||RF_ARRAYS.some(k=>f[k].length)||f.q;
  const opt = (v,l,cur)=>`<option value="${esc(String(v))}" ${cur===String(v)?'selected':''}>${esc(l)}</option>`;
  const rows = (items, keyFn, labFn) => {
    const m = new Map();
    items.forEach(t=>{ const k=keyFn(t); m.set(k,(m.get(k)||0)+1); });
    const max = Math.max(1,...m.values());
    return [...m.entries()].sort((a,b)=>b[1]-a[1]).map(([k,n])=>
      `<tr><td>${labFn(k)}</td><td style="width:50%"><div class="bar"><i style="width:${(n/max*100).toFixed(0)}%"></i></div></td><td class="num">${n}</td></tr>`).join('')
      || `<tr><td class="mini muted" colspan="3" style="padding:14px 16px">Nothing in this slice.</td></tr>`;
  };
  const openT = sc.filter(t=>!isDone(t));
  const frs = sc.map(t=>{ const r=t.articles.find(a=>a.kind==='reply'); return r? (r.ts-t.createdAt)/H : null; }).filter(x=>x!==null).sort((a,b)=>a-b);
  const med = frs.length? frs[Math.floor(frs.length/2)] : 0;
  const hrsByTech = new Map();
  sc.forEach(t=>t.time.forEach(e=>{ if(!f.tech.length||f.tech.includes(String(e.techId))) hrsByTech.set(e.techId,(hrsByTech.get(e.techId)||0)+e.h); }));
  const allTags = [...new Set(scoped().flatMap(t=>t.tags))].sort();
  const custom = f.from||f.to;
  const bd = reportBreakdown(sc);
  const pgB = paginate('reportBd', bd);
  const dimLabel = (RF_BREAKDOWNS.find(([v])=>v===f.breakdown)||['','Group'])[1].replace('By ','');
  const bdRows = pgB.slice.map(r=>`<tr>
      <td><div class="cell-title" style="font-weight:500">${esc(r.label)}</div></td>
      <td class="num">${r.n}</td><td class="num">${r.open}</td><td class="num">${r.resolved}</td>
      <td class="num"><span class="tape">${fmtHours(r.hours)}</span> h</td>
      <td class="num">${r.medFR===null?'<span class="muted">—</span>':`<span class="tape">${r.medFR.toFixed(1)}</span> h`}</td>
    </tr>`).join('') || `<tr><td class="mini muted" colspan="6" style="padding:14px 16px">Nothing in this slice.</td></tr>`;
  return `
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:13px">
    <div class="rpt-line"><span class="rpt-lab">Period</span>
      <div class="seg">${[['24h','Last 24h'],['7d','Last 7 days'],['30d','Last 30 days'],['all','All time']].map(([v,l])=>`<button class="${(!custom&&f.preset===v)?'on':''}" onclick="setRFPreset('${v}')">${l}</button>`).join('')}</div>
      <label class="mini" style="display:flex;align-items:center;gap:6px">from <input type="date" value="${f.from||''}" onchange="setRFDate('from',this.value)"></label>
      <label class="mini" style="display:flex;align-items:center;gap:6px">to <input type="date" value="${f.to||''}" onchange="setRFDate('to',this.value)"></label>
      <select style="width:auto" onchange="setRF('basis',this.value)" title="Which timestamp the period applies to">${opt('updated','Activity (updated) in range',f.basis)}${opt('created','Opened (created) in range',f.basis)}</select>
    </div>
    <div class="rpt-line"><span class="rpt-lab">Filters</span>
      <div class="search">${icon(IC.search)}<input type="text" id="rfQ" placeholder="Search number, title, client, article text…" value="${esc(f.q)}" oninput="setRFQ(this)" style="width:250px"></div>
      <span style="display:inline-block;min-width:160px;vertical-align:middle">${multiCombo('rfGroup', GROUPS.map(g=>({v:String(g.id),label:g.name,archived:isArch(g)})), f.group, 'setRFGroup', 'All groups')}</span>
      <span style="display:inline-block;min-width:180px;vertical-align:middle">${multiCombo('rfClient', CLIENTS.map(c=>({v:String(c.id),label:c.name,sub:c.domain||'',archived:c.status==='archived'})), f.client, 'setRFClient', 'All clients')}</span>
      <span style="display:inline-block;min-width:160px;vertical-align:middle">${multiCombo('rfTech', AGENTS.map(a=>({v:String(a.id),label:a.name})), f.tech, 'setRFTech', 'All technicians')}</span>
      <span style="display:inline-block;min-width:140px;vertical-align:middle">${multiCombo('rfPrio', PRIOS.map(p=>({v:String(p.id),label:p.label,archived:isArch(p)})), f.prio, 'setRFPrio', 'Any priority')}</span>
      <span style="display:inline-block;min-width:150px;vertical-align:middle">${multiCombo('rfSt', [{v:'type:open',label:'Any open'},{v:'type:paused',label:'Any paused'},{v:'type:done',label:'Any done'},...STATES.map(s=>({v:String(s.id),label:'— '+s.label,archived:isArch(s)}))], f.st, 'setRFSt', 'Any state')}</span>
      <span style="display:inline-block;min-width:130px;vertical-align:middle">${multiCombo('rfTag', [{v:'(untagged)',label:'(untagged)'},...allTags.map(tg=>({v:tg,label:tg}))], f.tag, 'setRFTag', 'Any tag')}</span>
      ${anyF?`<button class="btn sm ghost" onclick="clearRF()">Clear</button>`:''}
    </div>
    <div class="rpt-line"><span class="rpt-lab">Breakdown</span>
      <div class="seg wrap">${RF_BREAKDOWNS.map(([v,l])=>`<button class="${f.breakdown===v?'on':''}" onclick="setRF('breakdown','${v}')">${l}</button>`).join('')}</div>
      <span class="spacer"></span><span class="mini muted">${sc.length} ticket${sc.length===1?'':'s'} in this slice</span>
      ${can('export_csv')?`<button class="btn sm" onclick="copyReportCSV()" title="Copies the breakdown table as CSV">Copy</button>
      <button class="btn primary sm" onclick="exportReportCSV()" title="Exports the breakdown table — filters applied">${icon(IC.export)}Export CSV</button>`:''}
    </div>
  </div></div>
  <div class="section-gap"></div>
  <div class="grid g-3">
    <div class="card stat"><div class="lab">Median first response</div><div class="val tape">${med.toFixed(1)}<span class="u">h</span></div><div class="sub">across ${frs.length} answered tickets</div></div>
    <div class="card stat"><div class="lab">Open in slice</div><div class="val tape">${openT.length}</div><div class="sub">${openT.filter(t=>t.prio>=3).length} high/urgent</div></div>
    <div class="card stat"><div class="lab">Resolved in slice</div><div class="val tape">${sc.filter(isDone).length}</div><div class="sub">with ${fmtHours(sc.reduce((a,t)=>a+timeTotal(t),0))} h logged</div></div>
  </div>
  <div class="section-gap"></div>
  <div class="grid g-2">
    <div class="card"><div class="card-head"><h3>Open tickets by group</h3></div><table class="tbl"><tbody>${rows(openT,t=>t.groupId,k=>esc(grp(k).name))}</tbody></table></div>
    <div class="card"><div class="card-head"><h3>Open tickets by priority</h3></div><table class="tbl"><tbody>${rows(openT,t=>t.prio,k=>prioTag(k))}</tbody></table></div>
    <div class="card"><div class="card-head"><h3>Tickets by client</h3></div><table class="tbl"><tbody>${rows(sc,t=>t.clientId,k=>esc(client(k).name))}</tbody></table></div>
    <div class="card"><div class="card-head"><h3>Hours logged by technician</h3></div>
      <table class="tbl"><tbody>${[...hrsByTech.entries()].sort((a,b)=>b[1]-a[1]).map(([tid,h])=>
        `<tr><td>${esc(agent(tid).name)}</td><td class="num"><span class="tape">${fmtHours(h)}</span> h</td></tr>`).join('') || `<tr><td class="mini muted" style="padding:14px 16px">No time in this slice.</td></tr>`}</tbody></table></div>
  </div>
  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Breakdown ${esc(dimLabel.toLowerCase()==='priority'?'by priority':'by '+dimLabel.toLowerCase())}</h3><span class="hint">the whole slice, one row per ${esc(dimLabel.toLowerCase())}${f.breakdown==='tag'?' · a ticket can carry several tags, so rows can overlap':''}</span></div>
    <table class="tbl">
      <thead><tr><th>${esc(dimLabel)}</th><th class="num">Tickets</th><th class="num">Open</th><th class="num">Resolved</th><th class="num">Hours</th><th class="num">Median FR</th></tr></thead>
      <tbody>${bdRows}</tbody>
    </table>
    ${pagerBar(pgB)}
  </div>`;
}
