/* ==========================================================================
   views/reports.js — portfolio & cost rollups with the Docket/Ledger filter
   contract: multi-select combos (empty = no filter), a purchased-date window,
   and CSV export of the FILTERED per-client rollup (gated a_export_csv).
   Read-only, no endpoints. Money figures need a_see_costs; without it the
   view keeps the counts and says why the dollars are hidden.
   Scope notes: the client filter also scopes licence/contract spend; MSP-wide
   licence pools (no client) ride only while NO client filter is set — they
   belong to everyone, so they'd inflate any single client's number.
   ========================================================================== */

function reportAssets(){
  const f=state.rf;
  let rows=liveAssets();
  if(f.client.length) rows=rows.filter(a=>f.client.includes(a.clientId));
  if(f.type.length)   rows=rows.filter(a=>f.type.includes(a.atype));
  if(f.status.length) rows=rows.filter(a=>f.status.includes(a.status));
  if(f.from||f.to)    rows=rows.filter(a=>inDateRange(a.purchasedOn, f.from, f.to));
  return rows;
}
function reportLicenses(){
  const f=state.rf;
  return liveLicenses().filter(l=> !f.client.length || (l.clientId && f.client.includes(l.clientId)));
}
function reportContracts(){
  const f=state.rf;
  return liveContracts().filter(c=> !f.client.length || f.client.includes(c.clientId));
}
function rfClear(){ state.rf={client:[], type:[], status:[], from:'', to:''}; render(); }

function viewReports(){
  const f=state.rf, money=canSeeCosts();
  const rows=reportAssets(), lics=reportLicenses(), cts=reportContracts();
  const cOpts=state.clients.filter(c=>!c.sentinel).map(c=>({v:c.id,label:c.name+(c.archived?' (archived)':'')}));
  const tOpts=ATYPES.map(t=>({v:t,label:t}));
  const sOpts=Object.entries(ASSET_STATUS).map(([k,v])=>({v:k,label:v[1]}));
  const filtered=f.client.length||f.type.length||f.status.length||f.from||f.to;
  const bookByClient={};
  rows.forEach(a=>{ if(a.costCents!=null) bookByClient[a.clientId]=(bookByClient[a.clientId]||0)+a.costCents; });
  const totalBook=Object.values(bookByClient).reduce((s,n)=>s+n,0);
  const licSpend=lics.reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0);
  const ctSpend=cts.reduce((s,c)=>s+annualizedCents(c.costCents,c.termMonths),0);
  const byType={};
  rows.forEach(a=>{byType[a.atype]=(byType[a.atype]||0)+1;});
  return `
  <div class="toolbar">
    <span style="display:inline-block;min-width:190px;vertical-align:middle">${multiCombo('rf-client', cOpts, f.client, v=>mfToggle('rf','client',v), 'All clients')}</span>
    <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('rf-type', tOpts, f.type, v=>mfToggle('rf','type',v), 'All types')}</span>
    <span style="display:inline-block;min-width:150px;vertical-align:middle">${multiCombo('rf-status', sOpts, f.status, v=>mfToggle('rf','status',v), 'All statuses')}</span>
    <span class="mini muted">purchased</span>
    <input type="date" data-fkey="rf-from" value="${esc(f.from)}" onchange="state.rf.from=this.value;render()" title="Purchased from">
    <span class="mini muted">–</span>
    <input type="date" data-fkey="rf-to" value="${esc(f.to)}" onchange="state.rf.to=this.value;render()" title="Purchased to">
    ${filtered?`<button class="btn sm ghost" onclick="rfClear()">✕ Clear filters</button>`:''}
    <div class="spacer"></div>
    ${can('a_export_csv')?`<button class="btn" onclick="exportReportCSV()">Export CSV</button>`:''}
  </div>
  ${money?'':`<div class="notice lock" style="margin-bottom:16px">${icon(IC.money)}<div>Dollar figures need the “See purchase &amp; contract costs” permission — counts only below.</div></div>`}
  ${f.client.length&&liveLicenses().some(l=>!l.clientId)?`<div class="notice info" style="margin-bottom:16px">${icon(IC.license)}<div>MSP-wide licence pools are excluded while a client filter is set — they belong to every client at once.</div></div>`:''}
  <div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="lab">Hardware book value</div><div class="val">${money?fmtMoney(totalBook):'—'}</div><div class="sub">${rows.length} asset${rows.length===1?'':'s'}${filtered?' (filtered)':''}</div></div>
    <div class="card stat"><div class="lab">Annualised licence spend</div><div class="val">${money?fmtMoney(licSpend):'—'}</div><div class="sub">${lics.length} product${lics.length===1?'':'s'}</div></div>
    <div class="card stat"><div class="lab">Support &amp; warranty</div><div class="val">${money?fmtMoney(ctSpend):'—'}${money?'<span class="u">/yr</span>':''}</div><div class="sub">${cts.length} agreement${cts.length===1?'':'s'}</div></div>
  </div>
  <div class="grid g-2">
    <div class="card">
      <div class="card-head"><h3>By client</h3><span class="hint">${money?'book value + annualised spend':'counts'}</span></div>
      <table class="tbl">
        <thead><tr><th>Client</th><th>Assets</th>${money?'<th class="num">Book value</th><th class="num">Licences /yr</th><th class="num">Contracts /yr</th><th class="num">Total /yr</th>':''}</tr></thead>
        <tbody>
        ${reportClientRows(rows,lics,cts).map(r=>`<tr>
          <td class="cell-title">${esc(r.name)}</td>
          <td class="mono">${r.n}</td>
          ${money?`<td class="num money">${fmtMoney(r.book)}</td>
          <td class="num money">${fmtMoney(r.lic)}</td>
          <td class="num money">${fmtMoney(r.ct)}</td>
          <td class="num money" style="font-weight:600">${fmtMoney(r.lic+r.ct)}</td>`:''}</tr>`).join('')
          ||`<tr><td colspan="${money?6:2}"><div class="empty">Nothing matches the filters.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="card card-pad">
      <div class="card-head" style="border:0;padding:0 0 10px"><h3>Fleet by type</h3></div>
      ${Object.keys(byType).length?Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`
        <div style="margin-bottom:11px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span class="type-badge"><span class="tibox">${icon(TYPEIC[t]||IC.assets)}</span>${t}</span><span class="mono">${n}</span></div>
          <div class="bar"><i style="width:${Math.round(n/Math.max(1,...Object.values(byType))*100)}%"></i></div>
        </div>`).join(''):'<div class="mini muted">Nothing matches the filters.</div>'}
    </div>
  </div>`;
}

/* the per-client rollup both the table and the CSV read — one source */
function reportClientRows(rows,lics,cts){
  const ids=[...new Set([...rows.map(a=>a.clientId), ...lics.filter(l=>l.clientId).map(l=>l.clientId), ...cts.map(c=>c.clientId)])];
  const msp=lics.filter(l=>!l.clientId);
  const mspRow=msp.length?[{cid:null, name:'All clients (MSP-wide)', n:0, book:0,
    lic:msp.reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0), ct:0}]:[];
  return mspRow.concat(ids.map(cid=>({
    cid, name:clientName(cid),
    n:rows.filter(a=>a.clientId===cid).length,
    book:rows.filter(a=>a.clientId===cid).reduce((s,a)=>s+(a.costCents||0),0),
    lic:lics.filter(l=>l.clientId===cid).reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0),
    ct:cts.filter(c=>c.clientId===cid).reduce((s,c)=>s+annualizedCents(c.costCents,c.termMonths),0),
  }))).sort((a,b)=>(b.book+b.lic+b.ct)-(a.book+a.lic+a.ct) || b.n-a.n);
}

function exportReportCSV(){
  if(!can('a_export_csv')) return;
  const money=canSeeCosts();
  const rows=reportAssets(), lics=reportLicenses(), cts=reportContracts();
  const out=[['Client','Assets'].concat(money?['Book value','Licences /yr','Contracts /yr','Total /yr']:[])];
  reportClientRows(rows,lics,cts).forEach(r=>out.push(
    [r.name, r.n].concat(money?[(r.book/100).toFixed(2),(r.lic/100).toFixed(2),(r.ct/100).toFixed(2),((r.lic+r.ct)/100).toFixed(2)]:[])));
  csvDownload('assets-report.csv', out);
  toast(out.length-1+' client rows exported.');
}
