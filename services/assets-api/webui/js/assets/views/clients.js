/* ==========================================================================
   views/clients.js — the per-client panel: a list of every client with its
   inventory rollup, and a client page showing THAT client's assets, licences
   and contracts with add-buttons pre-scoped to it (the modals take a
   presetClient arg). Read-only plus modal launches — the writes live in the
   items/licenses/contracts views' action functions.
   MSP-wide licence pools (clientId null) belong to every client at once, so
   they ride in a separate section on the client page, never in the counts.
   ========================================================================== */

function clientInv(cid){
  return {
    assets:   liveAssets().filter(a=>a.clientId===cid),
    licenses: liveLicenses().filter(l=>l.clientId===cid),
    contracts:liveContracts().filter(c=>c.clientId===cid),
  };
}

function viewClientsPage(){
  const q=(state.clf.q||'').toLowerCase();
  const money=canSeeCosts();
  /* every live non-sentinel client, plus archived ones that still hold inventory */
  const rows=state.clients.filter(c=>!c.sentinel)
    .filter(c=>!c.archived || clientInv(c.id).assets.length || clientInv(c.id).licenses.length || clientInv(c.id).contracts.length)
    .filter(c=>!q || c.name.toLowerCase().includes(q))
    .map(c=>{
      const inv=clientInv(c.id);
      const issues=needsAttention().filter(n=>n.cid===c.id).length;   /* id-match — name prefixes false-matched */
      const book=inv.assets.reduce((s,a)=>s+(a.costCents||0),0);
      const spend=inv.licenses.reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0)
                 +inv.contracts.reduce((s,x)=>s+annualizedCents(x.costCents,x.termMonths),0);
      return {c, inv, issues, book, spend};
    })
    .sort((a,b)=>(b.inv.assets.length-a.inv.assets.length) || a.c.name.localeCompare(b.c.name));
  const pg=paginate('clientsList', rows);
  return `
  <div class="toolbar">
    <div class="search"><span>${icon(IC.search)}</span><input type="search" data-fkey="clients-q" placeholder="Search clients…" value="${esc(state.clf.q)}" oninput="state.clf.q=this.value;render()"></div>
    <div class="spacer"></div>
    <span class="mini muted">${pg.total} client${pg.total===1?'':'s'}</span>
  </div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Client</th><th>Assets</th><th>Licences</th><th>Contracts</th><th>Needs attention</th>${money?'<th class="num">Book value</th><th class="num">Annualised spend</th>':''}</tr></thead>
      <tbody>
      ${pg.slice.length?pg.slice.map(r=>`<tr class="clickable" onclick="openClientPage('${r.c.id}')">
        <td><div class="cell-title">${esc(r.c.name)}${r.c.archived?' <span class="chip grey slim"><span class="cdot"></span>Archived</span>':''}</div></td>
        <td class="mono">${r.inv.assets.length}</td>
        <td class="mono">${r.inv.licenses.length}</td>
        <td class="mono">${r.inv.contracts.length}</td>
        <td>${r.issues?`<span class="chip brass slim"><span class="cdot"></span>${r.issues}</span>`:'<span class="muted">—</span>'}</td>
        ${money?`<td class="num money">${fmtMoney(r.book)}</td>
        <td class="num money">${fmtMoney(r.spend)}<span class="muted">/yr</span></td>`:''}</tr>`).join('')
      :`<tr><td colspan="${money?7:5}"><div class="empty">${icon(IC.client)}<div>No clients match.</div></div></td></tr>`}
      </tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function viewClientPage(){
  const c=client(state.clientId);
  if(!c) return `<div class="card"><div class="empty">${icon(IC.client)}<div>Client not found. <a href="#" onclick="go('clients');return false">Back to clients</a>.</div></div></div>`;
  const money=canSeeCosts();
  const inv=clientInv(c.id);
  const msp=liveLicenses().filter(l=>!l.clientId);
  const book=inv.assets.reduce((s,a)=>s+(a.costCents||0),0);
  const licSpend=inv.licenses.reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0);
  const ctSpend=inv.contracts.reduce((s,x)=>s+annualizedCents(x.costCents,x.termMonths),0);
  return `
  <button class="btn ghost sm" style="margin-bottom:12px" onclick="go('clients')">‹ All clients</button>
  <div class="grid g-4" style="margin-bottom:16px">
    <div class="card stat"><div class="lab">Assets</div><div class="val">${inv.assets.length}</div><div class="sub">${inv.assets.filter(a=>a.status==='inuse').length} in use</div></div>
    <div class="card stat"><div class="lab">Licences</div><div class="val">${inv.licenses.length}</div><div class="sub">${inv.licenses.filter(l=>l.seatsUsed>=l.seatsTotal).length} at capacity${msp.length?` · +${msp.length} MSP-wide`:''}</div></div>
    <div class="card stat"><div class="lab">Contracts</div><div class="val">${inv.contracts.length}</div><div class="sub">${inv.contracts.filter(x=>!x.recurring&&x.endsOn&&daysTo(x.endsOn)<=leadDays()).length} ending ≤ ${leadDays()}d</div></div>
    ${money?`<div class="card stat"><div class="lab">Book · spend</div><div class="val">${fmtMoney(book)}</div><div class="sub">${fmtMoney(licSpend+ctSpend)}/yr licences + contracts</div></div>`
      :`<div class="card stat"><div class="lab">Book · spend</div><div class="val muted">—</div><div class="sub">needs “See purchase &amp; contract costs”</div></div>`}
  </div>

  <div class="card" style="margin-bottom:16px">
    <div class="card-head"><h3>Assets</h3><span class="hint">${inv.assets.length}</span>
      ${can('a_manage_assets')&&!c.archived?`<button class="btn sm primary" style="margin-left:12px" onclick="assetModal('','${jsq(c.id)}')">${icon(IC.plus)} Add asset</button>`:''}</div>
    <table class="tbl"><tbody>
    ${inv.assets.length?inv.assets.map(a=>`<tr class="clickable" onclick="openAsset('${a.id}')">
      <td><span class="citag">${esc(a.ciTag)}</span></td>
      <td><div class="cell-title">${esc(a.name)}</div><div class="cell-meta">${esc(a.assignedTo||'—')}</div></td>
      <td><span class="type-badge"><span class="tibox">${icon(TYPEIC[a.atype]||IC.assets)}</span>${a.atype}</span></td>
      <td>${statusChip(a.status)}</td>
      <td class="num">${hdot(a.warrantyUntil)}</td></tr>`).join('')
      :'<tr><td><div class="empty">No assets for this client yet.</div></td></tr>'}
    </tbody></table>
  </div>

  <div class="card" style="margin-bottom:16px">
    <div class="card-head"><h3>Software &amp; Licences</h3><span class="hint">${inv.licenses.length}</span>
      ${can('a_manage_licenses')&&!c.archived?`<button class="btn sm primary" style="margin-left:12px" onclick="licenseModal('','${jsq(c.id)}')">${icon(IC.plus)} Add licence</button>`:''}</div>
    <table class="tbl"><tbody>
    ${inv.licenses.length?inv.licenses.map(l=>`<tr class="clickable" onclick="openLicense('${l.id}')">
      <td><div class="cell-title">${esc(l.product)}</div><div class="cell-meta">${esc(l.vendor||'—')}</div></td>
      <td class="mono">${l.seatsUsed}/${l.seatsTotal}${l.seatsUsed>=l.seatsTotal?' <span class="chip red slim"><span class="cdot"></span>full</span>':''}</td>
      <td>${termLabel(l.termMonths,l.recurring)}</td>
      <td>${endCell(l.endsOn,l.recurring)}</td>
      ${money?`<td class="num money">${fmtMoney(annualizedCents(licPoolCents(l),l.termMonths))}<span class="muted">/yr</span></td>`:''}</tr>`).join('')
      :'<tr><td><div class="empty">No client-specific licences.</div></td></tr>'}
    </tbody></table>
    ${msp.length?`<div class="card-pad" style="border-top:1px solid var(--line-2);padding:10px 18px"><span class="mini muted">Also covered by ${msp.length} MSP-wide pool${msp.length===1?'':'s'}: ${esc(msp.map(l=>l.product).join(', '))}</span></div>`:''}
  </div>

  <div class="card">
    <div class="card-head"><h3>Contracts &amp; Warranties</h3><span class="hint">${inv.contracts.length}</span>
      ${can('a_manage_contracts')&&!c.archived?`<button class="btn sm primary" style="margin-left:12px" onclick="contractModal('','${jsq(c.id)}')">${icon(IC.plus)} Add contract</button>`:''}</div>
    <table class="tbl"><tbody>
    ${inv.contracts.length?inv.contracts.map(x=>`<tr class="clickable" onclick="openContract('${x.id}')">
      <td><div class="cell-title">${esc(x.vendor)}</div><div class="cell-meta">${(x.assetIds||[]).length?(x.assetIds||[]).length+' linked CI'+((x.assetIds||[]).length===1?'':'s'):esc(x.scopeNote||'—')}</div></td>
      <td>${kindChip(x.kind)}</td>
      <td>${termLabel(x.termMonths,x.recurring)}</td>
      <td>${endCell(x.endsOn,x.recurring)}</td>
      ${money?`<td class="num money">${fmtMoney(annualizedCents(x.costCents,x.termMonths))}<span class="muted">/yr</span></td>`:''}</tr>`).join('')
      :'<tr><td><div class="empty">No contracts for this client yet.</div></td></tr>'}
    </tbody></table>
  </div>`;
}
