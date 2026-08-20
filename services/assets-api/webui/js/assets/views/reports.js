/* ==========================================================================
   views/reports.js — portfolio & cost rollups. Read-only, no endpoints.
   Money figures need a_see_costs; without it the view keeps the counts and
   says why the dollars are hidden.
   ========================================================================== */

function viewReports(){
  const live=liveAssets();
  const money=canSeeCosts();
  const bookByClient={};
  live.forEach(a=>{ if(a.costCents!=null) bookByClient[a.clientId]=(bookByClient[a.clientId]||0)+a.costCents; });
  const totalBook=Object.values(bookByClient).reduce((s,n)=>s+n,0);
  const licSpend=liveLicenses().reduce((s,l)=>s+annualizedCents(l.costCents,l.termMonths),0);
  const ctSpend=liveContracts().reduce((s,c)=>s+annualizedCents(c.costCents,c.termMonths),0);
  const byType={};
  live.forEach(a=>{byType[a.atype]=(byType[a.atype]||0)+1;});
  return `
  ${money?'':`<div class="notice lock" style="margin-bottom:16px">${icon(IC.money)}<div>Dollar figures need the “See purchase &amp; contract costs” permission — counts only below.</div></div>`}
  <div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="lab">Hardware book value</div><div class="val">${money?fmtMoney(totalBook):'—'}</div><div class="sub">${live.length} tracked assets</div></div>
    <div class="card stat"><div class="lab">Annualised licence spend</div><div class="val">${money?fmtMoney(licSpend):'—'}</div><div class="sub">${liveLicenses().length} products</div></div>
    <div class="card stat"><div class="lab">Support &amp; warranty</div><div class="val">${money?fmtMoney(ctSpend):'—'}${money?'<span class="u">/yr</span>':''}</div><div class="sub">${liveContracts().length} agreements</div></div>
  </div>
  <div class="grid g-2">
    <div class="card">
      <div class="card-head"><h3>Assets by client</h3><span class="hint">${money?'book value = recorded purchase costs':'counts'}</span></div>
      <table class="tbl">
        <thead><tr><th>Client</th><th>Assets</th>${money?'<th style="width:220px">Share</th><th class="num">Book value</th>':''}</tr></thead>
        <tbody>
        ${[...new Set(live.map(a=>a.clientId))].map(cid=>({cid, n:live.filter(a=>a.clientId===cid).length, v:bookByClient[cid]||0}))
          .sort((a,b)=>money?(b.v-a.v):(b.n-a.n)).map(r=>`<tr>
          <td class="cell-title">${esc(clientName(r.cid))}</td>
          <td class="mono">${r.n}</td>
          ${money?`<td><div class="bar"><i style="width:${totalBook?Math.round(r.v/totalBook*100):0}%"></i></div></td>
          <td class="num money">${fmtMoney(r.v)}</td>`:''}</tr>`).join('')
          ||`<tr><td colspan="${money?4:2}"><div class="empty">No assets yet.</div></td></tr>`}
        ${money&&totalBook?`<tr style="border-top:2px solid var(--ink-3)"><td style="font-weight:600">Total</td><td></td><td></td><td class="num money" style="font-weight:600">${fmtMoney(totalBook)}</td></tr>`:''}
        </tbody>
      </table>
    </div>
    <div class="card card-pad">
      <div class="card-head" style="border:0;padding:0 0 10px"><h3>Fleet by type</h3></div>
      ${Object.keys(byType).length?Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`
        <div style="margin-bottom:11px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span class="type-badge"><span class="tibox">${icon(TYPEIC[t]||IC.assets)}</span>${t}</span><span class="mono">${n}</span></div>
          <div class="bar"><i style="width:${Math.round(n/Math.max(1,...Object.values(byType))*100)}%"></i></div>
        </div>`).join(''):'<div class="mini muted">No assets yet.</div>'}
    </div>
  </div>`;
}
