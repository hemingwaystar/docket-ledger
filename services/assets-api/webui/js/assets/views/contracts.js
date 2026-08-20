/* ==========================================================================
   views/contracts.js — vendor contracts & warranties + covered-asset links.
   Endpoints: POST /api/contracts · PATCH /api/contracts/{id} (version-locked)
   · PUT /api/contracts/{id}/assets (full-replace membership).
   Same typed-term model as licences. The coverage picker is a multiCombo
   scoped to the chosen client's live assets; its selection lives in a modal-
   local array (window._ctSel) because the modal outlives render() rebuilds.
   ========================================================================== */

function contractRows(){
  const q=(state.cf.q||'').toLowerCase();
  let rows=liveContracts();
  if(q) rows=rows.filter(c=>(c.vendor+' '+CT_KIND_LABEL[c.kind]+' '+clientName(c.clientId)+' '+c.scopeNote).toLowerCase().includes(q));
  return rows;
}

function viewContracts(){
  const money=canSeeCosts();
  const rows=contractRows();
  const pg=paginate('ctList', rows);
  const total=rows.reduce((s,c)=>s+annualizedCents(c.costCents,c.termMonths),0);
  return `
  <div class="notice lock" style="margin-bottom:16px">${icon(IC.contracts)}
    <div>Coverage is bought on whatever term the vendor sold — type it in (monthly, 1–5 yr…), tick ↻ recurring if it auto-renews.
    Charges post to <b>Ledger</b> up front at each term start (Build 29); non-recurring terms raise a lapse ticket ${leadDays()} days out (Build 30).</div></div>
  <div class="toolbar">
    <div class="search"><span>${icon(IC.search)}</span><input type="search" data-fkey="ct-q" placeholder="Search contracts…" value="${esc(state.cf.q)}" oninput="state.cf.q=this.value;render()"></div>
    <div class="spacer"></div>
    ${can('a_export_csv')?`<button class="btn" onclick="exportContractsCSV()">Export CSV</button>`:''}
    ${can('a_manage_contracts')?`<button class="btn primary" onclick="contractModal('')">${icon(IC.plus)} Add contract</button>`:''}
  </div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Vendor / agreement</th><th>Type</th><th>Client</th><th>Coverage</th><th>Term</th><th>Term ends</th>${money?'<th class="num">Cost / term</th><th class="num">Annualised</th>':''}</tr></thead>
      <tbody>
      ${pg.slice.length?pg.slice.map(c=>`<tr class="clickable" onclick="openContract('${c.id}')">
        <td><div class="cell-title">${esc(c.vendor)}</div><div class="cell-meta">since ${c.termStartedOn?fmtDate(c.termStartedOn):'—'}</div></td>
        <td>${kindChip(c.kind)}</td>
        <td>${esc(clientName(c.clientId))}</td>
        <td class="mini" style="font-size:12.5px;color:var(--ink-2)">${(c.assetIds||[]).length?esc((c.assetIds||[]).slice(0,3).map(id=>{const a=assetById(id);return a?a.ciTag:'?';}).join(', ')+((c.assetIds||[]).length>3?' +'+((c.assetIds||[]).length-3):'')):esc(c.scopeNote||'—')}</td>
        <td>${termLabel(c.termMonths,c.recurring)}</td>
        <td>${hdot(c.endsOn)}</td>
        ${money?`<td class="num money">${fmtMoney(c.costCents)}</td>
        <td class="num money">${fmtMoney(annualizedCents(c.costCents,c.termMonths))}<span class="muted">/yr</span></td>`:''}</tr>`).join('')
      :`<tr><td colspan="${money?8:6}"><div class="empty">${icon(IC.contracts)}<div>No contracts match.</div></div></td></tr>`}
      ${money&&rows.length?`<tr style="border-top:2px solid var(--ink-3)"><td colspan="6" style="font-weight:600">Annualised vendor cost</td><td></td><td class="num money" style="font-weight:600">${fmtMoney(total)}<span class="muted">/yr</span></td></tr>`:''}
      </tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function exportContractsCSV(){
  if(!can('a_export_csv')) return;
  const rows=[['Vendor/agreement','Kind','Client','Covered CIs','Scope note','Term (months)','Recurring','Term started','Term ends','Cost/term']];
  contractRows().forEach(c=>rows.push([c.vendor,c.kind,clientName(c.clientId),
    (c.assetIds||[]).map(id=>{const a=assetById(id);return a?a.ciTag:id;}).join(' '),
    c.scopeNote,c.termMonths,c.recurring?'yes':'no',c.termStartedOn||'',c.endsOn||'',
    canSeeCosts()?(c.costCents/100).toFixed(2):'']));
  csvDownload('contracts.csv', rows);
  toast(rows.length-1+' contracts exported.');
}

function openContract(id){
  const c=state.contracts.find(x=>x.id===id); if(!c) return;
  const covered=(c.assetIds||[]).map(assetById).filter(Boolean);
  openModal(`
    <div class="modal-head"><div><h3>${esc(c.vendor)}</h3><p>${CT_KIND_LABEL[c.kind]} · ${esc(clientName(c.clientId))}</p></div>
      <button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="detail-grid">
        <div><div class="k">Term</div><div class="v">${termLabel(c.termMonths,c.recurring)}</div></div>
        <div><div class="k">Term ends</div><div class="v">${hdot(c.endsOn)}</div></div>
        <div><div class="k">Term started</div><div class="v">${c.termStartedOn?fmtDate(c.termStartedOn):'—'}</div></div>
        ${canSeeCosts()?`<div><div class="k">Cost / term</div><div class="v money">${fmtMoney(c.costCents)} <span class="mini muted">(${fmtMoney(annualizedCents(c.costCents,c.termMonths))}/yr)</span></div></div>`:''}
      </div>
      ${c.scopeNote?`<div class="line-sep"></div><div class="k" style="margin-bottom:4px">Coverage note</div><div style="font-size:13px;color:var(--ink-2)">${esc(c.scopeNote)}</div>`:''}
      <div class="line-sep"></div>
      <div class="k" style="margin-bottom:8px">Covered assets</div>
      ${covered.length?covered.map(a=>`<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line-2)">
        <span class="citag">${esc(a.ciTag)}</span><span style="flex:1">${esc(a.name)}</span>${statusChip(a.status)}</div>`).join('')
        :'<div class="mini muted">No linked CIs — coverage is described by the note only.</div>'}
      <div class="line-sep"></div>
      <div class="k" style="margin-bottom:8px">Changes</div>
      ${eventFeed('contract', id)}
    </div>
    <div class="modal-foot">
      ${can('a_manage_contracts')?`<button class="btn danger" onclick="archiveContract('${c.id}')">Archive</button>`:''}
      <button class="btn" onclick="closeModal()">Close</button>
      ${can('a_manage_contracts')?`<button class="btn primary" onclick="contractModal('${c.id}')">Edit contract</button>`:''}
    </div>`, true);
}

function archiveContract(id){
  const c=state.contracts.find(x=>x.id===id); if(!c||!can('a_manage_contracts')) return;
  closeModal();
  c.archived=true; log('Contract archived', c.vendor, id); render();
  post('PATCH','/api/contracts/'+id,{version:c.version, archived:true})
    .then(d=>{ if(d){ if(d.version) c.version=d.version; toast(`${c.vendor} archived.`); } });
}

/* ---- add / edit (coverage picker lives in the modal) ---- */
function ctCoverageCombo(){
  const clientId=document.getElementById('cf-client')?document.getElementById('cf-client').value:'';
  const opts=liveAssets().filter(a=>!clientId||a.clientId===clientId)
    .map(a=>({v:a.id,label:a.ciTag+' · '+a.name,sub:clientName(a.clientId)}));
  return multiCombo('cf-assets', opts, window._ctSel, v=>{
    if(v===null) window._ctSel.length=0;
    else { const i=window._ctSel.indexOf(v); if(i>=0) window._ctSel.splice(i,1); else window._ctSel.push(v); }
    const w=document.getElementById('cf-assets-wrap');
    if(w){ w.innerHTML=ctCoverageCombo(); const q=document.getElementById('cf-assets-q'); if(q){ q.focus(); multiOpen('cf-assets'); } }
  }, 'No linked CIs', true);
}

function contractModal(id){
  if(!can('a_manage_contracts')) return;
  const c=id?state.contracts.find(x=>x.id===id):null;
  window._ctSel=(c?(c.assetIds||[]).slice():[]);
  const cOpts=pickableClients().map(x=>({v:x.id,label:x.name}));
  openModal(`
    <div class="modal-head"><div><h3>${c?'Edit contract — '+esc(c.vendor):'Add contract'}</h3>
      <p>Type the term as sold (monthly, 1–5 yr…); link the CIs it covers so asset pages show their coverage.</p></div>
      <button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="field"><label>Vendor / agreement</label><input type="text" id="cf-vendor" value="${esc(c?c.vendor:'')}" placeholder="Dell ProSupport Plus"></div>
      <div class="detail-grid">
        <div class="field"><label>Kind</label><select id="cf-kind">${CT_KINDS.map(k=>`<option value="${k}" ${c&&c.kind===k?'selected':''}>${CT_KIND_LABEL[k]}</option>`).join('')}</select></div>
        <div class="field"><label>Client</label>${combo('cf-client', cOpts, c?c.clientId:'', function(){
          /* switching client prunes stale selections — coverage must never
             silently span clients (raw-uuid chips were the symptom) */
          const picked=document.getElementById('cf-client').value;
          window._ctSel=window._ctSel.filter(id=>{ const a=assetById(id); return a && (!picked||a.clientId===picked); });
          const w=document.getElementById('cf-assets-wrap'); if(w) w.innerHTML=ctCoverageCombo(); }, 'Pick a client…')}</div>
      </div>
      ${termFields('cf', c?c.termMonths:12, c?c.recurring:false)}
      <div class="detail-grid">
        <div class="field"><label>Term started</label><input type="date" id="cf-start" value="${c&&c.termStartedOn?c.termStartedOn:localISODate()}"></div>
        ${canSeeCosts()?`<div class="field"><label>Cost per term ($)</label><input type="number" id="cf-cost" min="0" step="0.01" value="${c?(c.costCents/100):''}" placeholder="0.00"></div>`:''}
      </div>
      <div class="field"><label>Covered assets</label><div id="cf-assets-wrap">${ctCoverageCombo()}</div></div>
      <div class="field"><label>Coverage note</label><input type="text" id="cf-scope" value="${esc(c?c.scopeNote:'')}" placeholder="e.g. All Barrett &amp; Cole servers"></div>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="saveContract('${c?c.id:''}')">${c?'Save contract':'Add contract'}</button></div>`, true);
  document.getElementById('cf-vendor').focus();
}

function saveContract(id){
  const g=x=>document.getElementById(x);
  const vendor=g('cf-vendor').value.trim();
  if(!vendor){ toast('The agreement needs a name.'); return; }
  const clientId=g('cf-client').value;
  if(!clientId){ toast('Pick a client.'); return; }
  const term=readTerm('cf');
  if(!term){ toast('The term must be 1–120 months (1–10 years).'); return; }
  const start=g('cf-start').value;
  if(!start){ toast('The term needs a start date.'); return; }
  const costEl=g('cf-cost');
  const costCents=costEl?Math.round(parseFloat(costEl.value||'0')*100):null;
  if(costEl&&(isNaN(costCents)||costCents<0)){ toast('Cost must be a positive amount.'); return; }
  const sel=window._ctSel.slice();
  closeModal();
  if(!id){
    const body={ vendor, kind:g('cf-kind').value, client_id:clientId,
      scope_note:g('cf-scope').value.trim(), term_months:term.months,
      recurring:term.recurring, term_started_on:start };
    if(costEl) body.cost_cents=costCents;
    log('Contract added', vendor);
    /* every rung guards on the previous response — a failed POST (or a
       failed coverage PUT) must never toast success (lying-chip class) */
    post('POST','/api/contracts',body).then(d=>{
      if(!d||!d.id) return;                    /* oops() already spoke */
      if(!sel.length){ toast(`Contract ${vendor} added.`); return; }
      return post('PUT','/api/contracts/'+d.id+'/assets',{asset_ids:sel})
        .then(d2=>{ if(d2) toast(`Contract ${vendor} added.`); });
    });
    return;
  }
  const c=state.contracts.find(x=>x.id===id); if(!c) return;
  const body={version:c.version};
  if(vendor!==c.vendor) body.vendor=vendor;
  if(g('cf-kind').value!==c.kind) body.kind=g('cf-kind').value;
  if(clientId!==c.clientId) body.client_id=clientId;
  if(g('cf-scope').value.trim()!==c.scopeNote) body.scope_note=g('cf-scope').value.trim();
  if(term.months!==c.termMonths) body.term_months=term.months;
  if(term.recurring!==c.recurring) body.recurring=term.recurring;
  if(start!==c.termStartedOn) body.term_started_on=start;
  if(costEl&&costCents!==c.costCents) body.cost_cents=costCents;
  const covChanged = sel.slice().sort().join()!== (c.assetIds||[]).slice().sort().join();
  if(Object.keys(body).length===1 && !covChanged){ toast('Nothing changed.'); return; }
  log('Contract updated', vendor, id);        /* only after the diff-guard */
  const sync = d=>{ if(d&&d.version) c.version=d.version; return d; };  /* in-window 409 guard (F1) */
  if(Object.keys(body).length>1){
    post('PATCH','/api/contracts/'+id, body).then(sync).then(d=>{
      if(!d) return;
      if(covChanged) return post('PUT','/api/contracts/'+id+'/assets',{asset_ids:sel}).then(sync)
        .then(d2=>{ if(d2) toast(`Contract ${vendor} saved.`); });
      toast(`Contract ${vendor} saved.`);
    });
  } else {
    post('PUT','/api/contracts/'+id+'/assets',{asset_ids:sel}).then(sync)
      .then(d=>{ if(d) toast(`Coverage for ${vendor} saved.`); });
  }
}
