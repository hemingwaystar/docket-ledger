/* ==========================================================================
   views/overview.js — the landing page: portfolio stats, the needs-attention
   worklist (shared with the nav pip via render.js/needsAttention()), assets
   by type, soonest-ending coverage. Read-only — no endpoints.
   Docket ticket links land here in Build 28.
   ========================================================================== */

function viewOverview(){
  const live = liveAssets();
  const expiring = needsAttention();
  const licSpend = liveLicenses().reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0);
  const ctSpend  = liveContracts().reduce((s,c)=>s+annualizedCents(c.costCents,c.termMonths),0);
  const fullPools = liveLicenses().filter(l=>l.seatsUsed>=l.seatsTotal);
  const byType={};
  live.forEach(a=>{byType[a.atype]=(byType[a.atype]||0)+1;});
  const soonest=[...liveContracts().filter(c=>c.endsOn&&!c.recurring).map(c=>({name:c.vendor, sub:clientName(c.clientId)+' · '+termLabel(c.termMonths,c.recurring), end:c.endsOn, go:"go('contracts')"})),
                 ...liveLicenses().filter(l=>l.endsOn&&!l.recurring).map(l=>({name:l.product, sub:clientName(l.clientId)+' · '+termLabel(l.termMonths,l.recurring), end:l.endsOn, go:"go('licenses')"}))]
    .sort((a,b)=>daysTo(a.end)-daysTo(b.end)).slice(0,6);

  return `
  <div class="notice info" style="margin-bottom:18px">
    ${icon(IC.overview)}
    <div><b>One directory, three apps.</b> Assets shares clients with Docket and Ledger.
    Docket tickets naming an affected CI (Build 28) and charges posting to Ledger periods (Build 29) arrive next;
    coverage-lapse tickets to the “${esc(state.cfg.lapse_group||'Alerts')}” board follow (Build 30).</div>
  </div>

  <div class="grid g-4" style="margin-bottom:16px">
    <div class="card stat click" onclick="go('assets')"><div class="lab">Assets under management</div><div class="val">${live.length}</div><div class="sub">across ${new Set(live.map(a=>a.clientId)).size} clients</div></div>
    <div class="card stat click" onclick="go('assets')"><div class="lab">Needs attention ≤ ${leadDays()}d</div><div class="val" style="color:${expiring.length?'var(--warn)':'inherit'}">${expiring.length}</div><div class="sub">${expiring.filter(n=>n.sev==='red').length} already lapsed</div></div>
    <div class="card stat click" onclick="go('licenses')"><div class="lab">Licence pools</div><div class="val">${liveLicenses().length}</div><div class="sub">${fullPools.length} at capacity</div></div>
    ${canSeeCosts()
      ? `<div class="card stat click" onclick="go('reports')"><div class="lab">Annualised spend</div><div class="val">${fmtMoney(licSpend+ctSpend)}</div><div class="sub">licences ${fmtMoney(licSpend)} · contracts ${fmtMoney(ctSpend)}</div></div>`
      : `<div class="card stat"><div class="lab">Annualised spend</div><div class="val muted">—</div><div class="sub">needs “See purchase &amp; contract costs”</div></div>`}
  </div>

  <div class="grid g-3">
    <div class="card" style="grid-column:span 2">
      <div class="card-head"><h3>Needs attention</h3><span class="hint">${expiring.length} item${expiring.length===1?'':'s'}</span></div>
      <div>${expiring.length?expiring.map(n=>`
        <div style="display:flex;gap:11px;align-items:flex-start;padding:12px 18px;border-bottom:1px solid var(--line-2);cursor:pointer" onclick="${n.go}">
          <span class="chip ${n.sev} slim" style="margin-top:1px"><span class="cdot"></span></span>
          <div style="flex:1"><div style="font-weight:500">${esc(n.t)}</div><div class="cell-meta">${esc(n.s)}</div></div>
          <span class="muted" style="align-self:center">›</span>
        </div>`).join(''):'<div class="empty">Nothing needs attention.</div>'}</div>
    </div>
    <div class="card card-pad">
      <div class="card-head" style="border:0;padding:0 0 10px"><h3>Assets by type</h3></div>
      ${Object.keys(byType).length?Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`
        <div style="margin-bottom:11px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span class="type-badge"><span class="tibox">${icon(TYPEIC[t]||IC.assets)}</span>${t}</span><span class="mono">${n}</span></div>
          <div class="bar" title="${Math.round(n/live.length*100)}% of fleet"><i style="width:${Math.round(n/live.length*100)}%"></i></div>
        </div>`).join(''):'<div class="mini muted">No assets yet — add the first one on the Assets page.</div>'}
    </div>
  </div>

  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Coverage ending soonest</h3><span class="hint">contracts &amp; licence terms</span></div>
    <table class="tbl"><tbody>
    ${soonest.length?soonest.map(x=>`<tr class="clickable" onclick="${x.go}">
      <td><div class="cell-title">${esc(x.name)}</div><div class="cell-meta">${esc(x.sub)}</div></td>
      <td class="num">${hdot(x.end)}</td></tr>`).join('')
      :'<tr><td><div class="empty">No coverage on record.</div></td></tr>'}
    </tbody></table>
  </div>`;
}
