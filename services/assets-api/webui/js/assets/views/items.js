/* ==========================================================================
   views/items.js — the Assets (CI) page and its action functions.
   Endpoints: POST /api/assets · PATCH /api/assets/{id} (version-locked).
   One function per control: optimistic local mutate + diff-guard + fetch +
   oops() rollback. Archive hides a row (archived seg shows them); 'retired'
   is a lifecycle STATUS and stays listed.
   ========================================================================== */

function assetRows(){
  const f=state.af, q=(f.q||'').toLowerCase();
  let rows = f.status==='archived' ? state.assets.filter(a=>a.archived)
           : liveAssets().filter(a=> f.status==='all'||a.status===f.status);
  if(f.client.length) rows=rows.filter(a=>f.client.includes(a.clientId));
  if(f.type.length)   rows=rows.filter(a=>f.type.includes(a.atype));
  if(f.cov!=='all')   rows=rows.filter(a=> f.cov==='none' ? !a.warrantyUntil
                                         : (!!a.warrantyUntil && covClass(a.warrantyUntil)===f.cov));
  if(f.from||f.to)    rows=rows.filter(a=>inDateRange(a.purchasedOn, f.from, f.to));
  if(q) rows=rows.filter(a=>(a.ciTag+' '+a.name+' '+a.assignedTo+' '+clientName(a.clientId)+' '+a.serial+' '+a.vendor).toLowerCase().includes(q));
  return rows;
}

function afClear(){ state.af={status:state.af.status, q:state.af.q, client:[], type:[], cov:'all', from:'', to:''}; render(); }

function viewAssetsPage(){
  const f=state.af;
  const counts={all:liveAssets().length, archived:state.assets.filter(a=>a.archived).length};
  Object.keys(ASSET_STATUS).forEach(k=>counts[k]=liveAssets().filter(a=>a.status===k).length);
  const seg=[['all','All'],['inuse','In use'],['stock','In stock'],['repair','In repair'],['retired','Retired'],['archived','Archived']]
    .map(([k,l])=>`<button class="${f.status===k?'on':''}" onclick="state.af.status='${k}';render()">${l}<span class="pip">${counts[k]||0}</span></button>`).join('');
  const money=canSeeCosts();
  /* filter options: archived clients ride along so their assets stay findable
     (row-37 doctrine: keep them out only when nothing references them) */
  const cOpts=state.clients.filter(c=>!c.sentinel).map(c=>({v:c.id,label:c.name+(c.archived?' (archived)':'')}));
  const tOpts=ATYPES.map(t=>({v:t,label:t}));
  const filtered = f.client.length||f.type.length||f.cov!=='all'||f.from||f.to;
  const pg=paginate('assetsList', assetRows());
  return `
  <div class="toolbar">
    <div class="seg">${seg}</div>
    <div class="search"><span>${icon(IC.search)}</span><input type="search" data-fkey="assets-q" placeholder="Search assets…" value="${esc(f.q)}" oninput="state.af.q=this.value;render()"></div>
    <div class="spacer"></div>
    ${can('a_export_csv')?`<button class="btn" onclick="exportAssetsCSV()">Export CSV</button>`:''}
    ${can('a_manage_assets')?`<button class="btn primary" onclick="assetModal('')">${icon(IC.plus)} Add asset</button>`:''}
  </div>
  <div class="toolbar" style="margin-top:-4px">
    <span style="display:inline-block;min-width:190px;vertical-align:middle">${multiCombo('aft-client', cOpts, f.client, v=>mfToggle('af','client',v), 'All clients')}</span>
    <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('aft-type', tOpts, f.type, v=>mfToggle('af','type',v), 'All types')}</span>
    <select data-fkey="af-cov" onchange="state.af.cov=this.value;render()" title="Warranty health">
      <option value="all" ${f.cov==='all'?'selected':''}>Warranty: any</option>
      <option value="ok" ${f.cov==='ok'?'selected':''}>Active (beyond ${leadDays()}d)</option>
      <option value="due" ${f.cov==='due'?'selected':''}>Expiring ≤ ${leadDays()}d</option>
      <option value="breach" ${f.cov==='breach'?'selected':''}>Expired</option>
      <option value="none" ${f.cov==='none'?'selected':''}>No warranty on record</option>
    </select>
    <span class="mini muted">purchased</span>
    <input type="date" data-fkey="af-from" value="${esc(f.from)}" onchange="state.af.from=this.value;render()" title="Purchased from">
    <span class="mini muted">–</span>
    <input type="date" data-fkey="af-to" value="${esc(f.to)}" onchange="state.af.to=this.value;render()" title="Purchased to">
    ${filtered?`<button class="btn sm ghost" onclick="afClear()">✕ Clear filters</button>`:''}
    <span class="mini muted" style="margin-left:auto">${pg.total} match${pg.total===1?'':'es'}</span>
  </div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>CI tag</th><th>Asset</th><th>Type</th><th>Client</th><th>Assigned to</th><th>Status</th><th>Warranty</th>${money?'<th class="num">Cost</th>':''}</tr></thead>
      <tbody>
      ${pg.slice.length?pg.slice.map(a=>`<tr class="clickable" onclick="openAsset('${a.id}')">
        <td><span class="citag">${esc(a.ciTag)}</span></td>
        <td><div class="cell-title">${esc(a.name)}</div><div class="cell-meta">${esc(a.vendor||'—')} · ${esc(a.serial||'no serial')}</div></td>
        <td><span class="type-badge"><span class="tibox">${icon(TYPEIC[a.atype]||IC.assets)}</span>${a.atype}</span></td>
        <td>${esc(clientName(a.clientId))}</td>
        <td>${esc(a.assignedTo||'—')}</td>
        <td>${statusChip(a.status)}${a.archived?' <span class="chip grey slim"><span class="cdot"></span>Archived</span>':''}</td>
        <td>${hdot(a.warrantyUntil)}</td>
        ${money?`<td class="num money">${a.costCents!=null?fmtMoney(a.costCents):'<span class="muted">—</span>'}</td>`:''}</tr>`).join('')
      :`<tr><td colspan="${money?8:7}"><div class="empty">${icon(IC.assets)}<div>No assets match.</div></div></td></tr>`}
      </tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function exportAssetsCSV(){
  if(!can('a_export_csv')) return;
  const rows=[['CI tag','Name','Type','Client','Assigned to','Status','Serial','Vendor','Purchased','Warranty until','Cost','Note']];
  assetRows().forEach(a=>rows.push([a.ciTag,a.name,a.atype,clientName(a.clientId),a.assignedTo,a.status,
    a.serial,a.vendor,a.purchasedOn||'',a.warrantyUntil||'',
    canSeeCosts()&&a.costCents!=null?(a.costCents/100).toFixed(2):'',a.note]));
  csvDownload('assets.csv', rows);
  toast(rows.length-1+' assets exported.');
}

/* ---- detail modal ---- */
function openAsset(id){
  const a=assetById(id); if(!a) return;
  const cov=contractsCovering(id);
  openModal(`
    <div class="modal-head">
      <span class="tibox" style="width:34px;height:34px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center;color:var(--ink-3)">${icon(TYPEIC[a.atype]||IC.assets)}</span>
      <div><h3>${esc(a.name)}</h3><p><span class="citag">${esc(a.ciTag)}</span> · ${a.atype} · ${esc(clientName(a.clientId))}</p></div>
      <button class="x" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">
      <div class="toolbar" style="margin-bottom:16px">${statusChip(a.status)}${a.archived?'<span class="chip grey slim"><span class="cdot"></span>Archived</span>':''}<span class="hdot ${covClass(a.warrantyUntil)}"><span class="sdot"></span>Warranty ${covText(a.warrantyUntil)}</span></div>
      <div class="detail-grid">
        <div><div class="k">Assigned to</div><div class="v">${esc(a.assignedTo||'—')}</div></div>
        <div><div class="k">Vendor</div><div class="v">${esc(a.vendor||'—')}</div></div>
        <div><div class="k">Serial</div><div class="v mono">${esc(a.serial||'—')}</div></div>
        <div><div class="k">Purchased</div><div class="v">${a.purchasedOn?fmtDate(a.purchasedOn):'—'}</div></div>
        ${canSeeCosts()?`<div><div class="k">Purchase cost</div><div class="v money">${a.costCents!=null?fmtMoney(a.costCents):'—'}</div></div>`:''}
        <div><div class="k">Warranty ends</div><div class="v">${a.warrantyUntil?fmtDate(a.warrantyUntil):'—'}</div></div>
      </div>
      ${a.note?`<div class="line-sep"></div><div class="k" style="margin-bottom:4px">Note</div><div style="font-size:13px;color:var(--ink-2)">${esc(a.note)}</div>`:''}
      ${cov.length?`<div class="line-sep"></div><div class="notice lock">${icon(IC.contracts)}<div>Covered by <b>${esc(cov[0].vendor)}</b> — ${termLabel(cov[0].termMonths,cov[0].recurring)}${canSeeCosts()?' · '+fmtMoney(cov[0].costCents)+'/term':''}, ends ${cov[0].endsOn?fmtDate(cov[0].endsOn):'—'}.${cov.length>1?' (+'+(cov.length-1)+' more)':''}</div></div>`:''}
      <div class="line-sep"></div>
      <div class="k" style="margin-bottom:8px">Changes</div>
      ${eventFeed('asset', id)}
    </div>
    <div class="modal-foot">
      ${can('a_manage_assets')?`<button class="btn ${a.archived?'':'danger'}" onclick="toggleArchiveAsset('${a.id}')">${a.archived?'Restore':'Archive'}</button>`:''}
      <button class="btn" onclick="closeModal()">Close</button>
      ${can('a_manage_assets')?`<button class="btn primary" onclick="assetModal('${a.id}')">Edit asset</button>`:''}
    </div>`, true);
}

function toggleArchiveAsset(id){
  const a=assetById(id); if(!a||!can('a_manage_assets')) return;
  const to=!a.archived;
  closeModal();
  a.archived=to; log(to?'Asset archived':'Asset restored', a.ciTag+' '+a.name, id); render();
  post('PATCH','/api/assets/'+id,{version:a.version, archived:to})
    .then(d=>{ if(d){ if(d.version) a.version=d.version; toast(`${a.ciTag} ${to?'archived':'restored'}.`); } });
}

/* ---- add / edit modal ---- */
function assetModal(id, presetClient){
  if(!can('a_manage_assets')) return;
  const a=id?assetById(id):null;
  const cOpts=pickableClients().map(c=>({v:c.id,label:c.name}));
  /* an edited record whose client was archived must still SHOW its client
     (a blank picker misread as unset — review finding) */
  if(a && !cOpts.some(o=>o.v===a.clientId)) cOpts.unshift({v:a.clientId, label:clientName(a.clientId)+' (archived)'});
  openModal(`
    <div class="modal-head"><div><h3>${a?'Edit asset — '+esc(a.ciTag):'Add asset'}</h3>
      <p>${a?'Version-locked: if someone else edited this asset first, the save is refused — reopen and retry.':'A CI tag is the asset’s handle across the suite (e.g. LT-0451).'}</p></div>
      <button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="detail-grid">
        <div class="field"><label>CI tag</label><input type="text" id="af-tag" value="${esc(a?a.ciTag:'')}" placeholder="LT-0001"></div>
        <div class="field"><label>Type</label><select id="af-type">${ATYPES.map(t=>`<option ${a&&a.atype===t?'selected':''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Name</label><input type="text" id="af-name" value="${esc(a?a.name:'')}" placeholder="Dell Latitude 7440"></div>
      <div class="detail-grid">
        <div class="field"><label>Client</label>${combo('af-client', cOpts, a?a.clientId:(presetClient||''), null, 'Pick a client…')}</div>
        <div class="field"><label>Assigned to</label><input type="text" id="af-user" value="${esc(a?a.assignedTo:'')}" placeholder="Person, rack, room…"></div>
        <div class="field"><label>Status</label><select id="af-status">${Object.entries(ASSET_STATUS).map(([k,v])=>`<option value="${k}" ${a&&a.status===k?'selected':''}>${v[1]}</option>`).join('')}</select></div>
        <div class="field"><label>Serial</label><input type="text" id="af-serial" value="${esc(a?a.serial:'')}"></div>
        <div class="field"><label>Vendor</label><input type="text" id="af-vendor" value="${esc(a?a.vendor:'')}"></div>
        <div class="field"><label>Purchased</label><input type="date" id="af-purch" value="${a&&a.purchasedOn?a.purchasedOn:''}"></div>
        <div class="field"><label>Warranty until</label><input type="date" id="af-warr" value="${a&&a.warrantyUntil?a.warrantyUntil:''}"></div>
        ${canSeeCosts()?`<div class="field"><label>Purchase cost ($)</label><input type="number" id="af-cost" min="0" step="0.01" value="${a&&a.costCents!=null?(a.costCents/100):''}" placeholder="—"></div>`:''}
      </div>
      <div class="field"><label>Note</label><textarea id="af-note" rows="2">${esc(a?a.note:'')}</textarea></div>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="saveAsset('${a?a.id:''}')">${a?'Save asset':'Add asset'}</button></div>`, true);
  document.getElementById(a?'af-name':'af-tag').focus();
}

function saveAsset(id){
  const g=x=>document.getElementById(x);
  const tag=g('af-tag').value.trim(), name=g('af-name').value.trim(), clientId=g('af-client').value;
  if(!tag||!name){ toast('CI tag and name are both required.'); return; }
  if(!clientId){ toast('Pick a client.'); return; }
  const costEl=g('af-cost');
  const costRaw=costEl?costEl.value.trim():'';
  const costCents=costRaw===''?null:Math.round(parseFloat(costRaw)*100);
  if(costCents!=null && (isNaN(costCents)||costCents<0)){ toast('Cost must be a positive amount.'); return; }
  const vals={ ci_tag:tag, name, atype:g('af-type').value, client_id:clientId,
    assigned_to:g('af-user').value.trim(), status:g('af-status').value,
    serial:g('af-serial').value.trim(), vendor:g('af-vendor').value.trim(),
    purchased_on:g('af-purch').value||'', warranty_until:g('af-warr').value||'',
    note:g('af-note').value.trim() };
  closeModal();
  if(!id){
    if(costEl){ if(costCents!=null) vals.cost_cents=costCents; }
    if(!vals.purchased_on) delete vals.purchased_on;
    if(!vals.warranty_until) delete vals.warranty_until;
    log('Asset added', tag+' '+name);
    post('POST','/api/assets',vals).then(d=>{ if(d) toast(`Asset ${tag} added.`); });
    return;
  }
  const a=assetById(id); if(!a) return;
  /* PATCH only what changed (diff-guard, row 21) */
  const body={version:a.version};
  if(vals.ci_tag!==a.ciTag) body.ci_tag=vals.ci_tag;
  if(vals.name!==a.name) body.name=vals.name;
  if(vals.atype!==a.atype) body.atype=vals.atype;
  if(vals.client_id!==a.clientId) body.client_id=vals.client_id;
  if(vals.assigned_to!==a.assignedTo) body.assigned_to=vals.assigned_to;
  if(vals.status!==a.status) body.status=vals.status;
  if(vals.serial!==a.serial) body.serial=vals.serial;
  if(vals.vendor!==a.vendor) body.vendor=vals.vendor;
  if(vals.purchased_on!==(a.purchasedOn||'')) body.purchased_on=vals.purchased_on;
  if(vals.warranty_until!==(a.warrantyUntil||'')) body.warranty_until=vals.warranty_until;
  if(costEl && costCents!==(a.costCents!=null?a.costCents:null)){
    if(costCents==null) body.clear_cost=true; else body.cost_cents=costCents;
  }
  if(vals.note!==a.note) body.note=vals.note;
  if(Object.keys(body).length===1){ toast('Nothing changed.'); return; }
  log('Asset updated', tag+' '+name, id);
  post('PATCH','/api/assets/'+id, body)
    .then(d=>{ if(d){ if(d.version) a.version=d.version; toast(`Asset ${tag} saved.`); } });
}
