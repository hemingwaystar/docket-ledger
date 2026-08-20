/* ==========================================================================
   views/licenses.js — software & licence pools and their action functions.
   Endpoints: POST /api/licenses · PATCH /api/licenses/{id} (version-locked).
   Terms are TYPED (number + months/years unit + recurring checkbox — the
   user's 2026-08-20 decision); cost is per SEAT per term — the pool pays
   unit × seats_total (licPoolCents), billed up front. Seat
   quick-adjust (+/−) rides the same PATCH. Over-allocation (used > total)
   renders as a true-up flag, never an input error.
   ========================================================================== */

function licenseRows(){
  const f=state.lf, q=(f.q||'').toLowerCase();
  let rows=liveLicenses();
  if(f.client.length) rows=rows.filter(l=>f.client.includes(l.clientId||''));   /* '' = the MSP-wide option */
  if(f.rec!=='all')   rows=rows.filter(l=> f.rec==='rec' ? l.recurring : !l.recurring);
  if(f.cap!=='all')   rows=rows.filter(l=> f.cap==='full' ? l.seatsUsed>=l.seatsTotal
                                          : l.seatsUsed<l.seatsTotal && l.seatsUsed/l.seatsTotal>=0.9);
  if(f.from||f.to)    rows=rows.filter(l=>inDateRange(l.endsOn, f.from, f.to));
  if(q) rows=rows.filter(l=>(l.product+' '+l.vendor+' '+clientName(l.clientId)).toLowerCase().includes(q));
  return rows;
}

function lfClear(){ state.lf={q:state.lf.q, client:[], rec:'all', cap:'all', from:'', to:''}; render(); }

function viewLicenses(){
  const money=canSeeCosts();
  const rows=licenseRows();
  const pg=paginate('licList', rows);
  const total=rows.reduce((s,l)=>s+annualizedCents(licPoolCents(l),l.termMonths),0);
  return `
  <div class="toolbar">
    <div class="search"><span>${icon(IC.search)}</span><input type="search" data-fkey="lic-q" placeholder="Search licences…" value="${esc(state.lf.q)}" oninput="state.lf.q=this.value;render()"></div>
    <div class="spacer"></div>
    ${can('a_export_csv')?`<button class="btn" onclick="exportLicensesCSV()">Export CSV</button>`:''}
    ${can('a_manage_licenses')?`<button class="btn primary" onclick="licenseModal('')">${icon(IC.plus)} Add licence</button>`:''}
  </div>
  <div class="toolbar" style="margin-top:-4px">
    <span style="display:inline-block;min-width:190px;vertical-align:middle">${multiCombo('lft-client', [{v:'',label:'All clients (MSP-wide)'},...state.clients.filter(c=>!c.sentinel).map(c=>({v:c.id,label:c.name+(c.archived?' (archived)':'')}))], state.lf.client, v=>mfToggle('lf','client',v), 'All clients')}</span>
    <select data-fkey="lf-rec" onchange="state.lf.rec=this.value;render()" title="Renewal">
      <option value="all" ${state.lf.rec==='all'?'selected':''}>Any renewal</option>
      <option value="rec" ${state.lf.rec==='rec'?'selected':''}>&#8635; Recurring</option>
      <option value="once" ${state.lf.rec==='once'?'selected':''}>One-off term</option>
    </select>
    <select data-fkey="lf-cap" onchange="state.lf.cap=this.value;render()" title="Seat pressure">
      <option value="all" ${state.lf.cap==='all'?'selected':''}>Any utilisation</option>
      <option value="full" ${state.lf.cap==='full'?'selected':''}>At capacity</option>
      <option value="warn" ${state.lf.cap==='warn'?'selected':''}>&#8805; 90% used</option>
    </select>
    <span class="mini muted">term ends</span>
    <input type="date" data-fkey="lf-from" value="${esc(state.lf.from)}" onchange="state.lf.from=this.value;render()" title="Term ends from">
    <span class="mini muted">&#8211;</span>
    <input type="date" data-fkey="lf-to" value="${esc(state.lf.to)}" onchange="state.lf.to=this.value;render()" title="Term ends to">
    ${state.lf.client.length||state.lf.rec!=='all'||state.lf.cap!=='all'||state.lf.from||state.lf.to?`<button class="btn sm ghost" onclick="lfClear()">&#10005; Clear filters</button>`:''}
    <span class="mini muted" style="margin-left:auto">${pg.total} match${pg.total===1?'':'es'}</span>
  </div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Product</th><th>Client</th><th>Seats</th><th style="width:150px">Utilisation</th><th>Term</th><th>Term ends</th>${money?'<th class="num">Cost / term</th><th class="num">Annualised</th>':''}</tr></thead>
      <tbody>
      ${pg.slice.length?pg.slice.map(l=>{
        const pct=Math.min(100,Math.round(l.seatsUsed/l.seatsTotal*100));
        const cls=l.seatsUsed>=l.seatsTotal?'full':(pct>=90?'warn':'');
        return `<tr class="clickable" onclick="openLicense('${l.id}')">
        <td><div class="cell-title">${esc(l.product)}</div><div class="cell-meta">${esc(l.vendor||'—')}</div></td>
        <td>${esc(clientName(l.clientId))}</td>
        <td class="mono">${l.seatsUsed}/${l.seatsTotal}
          ${can('a_manage_licenses')?`<span style="white-space:nowrap"><button class="rowbtn" onclick="event.stopPropagation();seatAdj('${l.id}',-1)">−</button><button class="rowbtn" onclick="event.stopPropagation();seatAdj('${l.id}',1)">+</button></span>`:''}</td>
        <td><div class="bar" title="${pct}%"><i class="${cls}" style="width:${pct}%"></i></div><div class="mini" style="margin-top:3px">${l.seatsUsed>=l.seatsTotal?'<span style="color:var(--void)">at capacity</span>':pct+'% used'}</div></td>
        <td>${termLabel(l.termMonths,l.recurring)}</td>
        <td>${endCell(l.endsOn,l.recurring)}</td>
        ${money?`<td class="num money">${fmtMoney(licPoolCents(l))}${l.seatsTotal>1?`<div class="mini muted">${l.seatsTotal} &#215; ${fmtMoney(l.costCents)}/seat</div>`:''}</td>
        <td class="num money">${fmtMoney(annualizedCents(licPoolCents(l),l.termMonths))}<span class="muted">/yr</span></td>`:''}</tr>`;}).join('')
      :`<tr><td colspan="${money?8:6}"><div class="empty">${icon(IC.license)}<div>No licences match.</div></div></td></tr>`}
      ${money&&rows.length?`<tr style="border-top:2px solid var(--ink-3)"><td colspan="6" style="font-weight:600">Annualised licence spend</td><td></td><td class="num money" style="font-weight:600">${fmtMoney(total)}<span class="muted">/yr</span></td></tr>`:''}
      </tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function exportLicensesCSV(){
  if(!can('a_export_csv')) return;
  const rows=[['Product','Vendor','Client','Seats used','Seats total','Term (months)','Recurring','Term started','Term ends','Cost/seat/term','Pool cost/term','Note']];
  licenseRows().forEach(l=>rows.push([l.product,l.vendor,clientName(l.clientId),l.seatsUsed,l.seatsTotal,
    l.termMonths,l.recurring?'yes':'no',l.termStartedOn||'',l.endsOn||'',
    canSeeCosts()?(l.costCents/100).toFixed(2):'',canSeeCosts()?(licPoolCents(l)/100).toFixed(2):'',l.note]));
  csvDownload('licenses.csv', rows);
  toast(rows.length-1+' licences exported.');
}

function seatAdj(id,delta){
  const l=state.licenses.find(x=>x.id===id); if(!l||!can('a_manage_licenses')) return;
  const next=l.seatsUsed+delta;
  if(next<0) return;                                   /* diff-guard */
  l.seatsUsed=next; log('Licence seats adjusted', `${l.product}: in use → ${next}`, id); render();
  /* sync the bumped version back or the SECOND click inside the 600ms
     rehydrate window carries a stale token and 409s (F1 lesson; desk
     props.js does the same) */
  post('PATCH','/api/licenses/'+id,{version:l.version, seats_used:next})
    .then(d=>{ if(d&&d.version) l.version=d.version; });
}

function openLicense(id){
  const l=state.licenses.find(x=>x.id===id); if(!l) return;
  openModal(`
    <div class="modal-head"><div><h3>${esc(l.product)}</h3><p>${esc(l.vendor||'—')} · ${esc(clientName(l.clientId))}</p></div>
      <button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="detail-grid">
        <div><div class="k">Seats</div><div class="v mono">${l.seatsUsed}/${l.seatsTotal}${l.seatsUsed>=l.seatsTotal?' <span class="chip red slim"><span class="cdot"></span>true-up</span>':''}</div></div>
        <div><div class="k">Term</div><div class="v">${termLabel(l.termMonths,l.recurring)}</div></div>
        <div><div class="k">Term started</div><div class="v">${l.termStartedOn?fmtDate(l.termStartedOn):'—'}</div></div>
        <div><div class="k">Term ends</div><div class="v">${endCell(l.endsOn,l.recurring)}</div></div>
        ${canSeeCosts()?`<div><div class="k">Cost / term</div><div class="v money">${fmtMoney(licPoolCents(l))} <span class="mini muted">(${l.seatsTotal} &#215; ${fmtMoney(l.costCents)}/seat)</span></div></div>
        <div><div class="k">Annualised</div><div class="v money">${fmtMoney(annualizedCents(licPoolCents(l),l.termMonths))}/yr</div></div>`:''}
      </div>
      ${l.note?`<div class="line-sep"></div><div class="k" style="margin-bottom:4px">Note</div><div style="font-size:13px;color:var(--ink-2)">${esc(l.note)}</div>`:''}
      <div class="line-sep"></div>
      <div class="k" style="margin-bottom:8px">Changes</div>
      ${eventFeed('license', id)}
    </div>
    <div class="modal-foot">
      ${can('a_manage_licenses')?`<button class="btn danger" onclick="archiveLicense('${l.id}')">Archive</button>`:''}
      <button class="btn" onclick="closeModal()">Close</button>
      ${can('a_manage_licenses')?`<button class="btn primary" onclick="licenseModal('${l.id}')">Edit licence</button>`:''}
    </div>`, true);
}

function archiveLicense(id){
  const l=state.licenses.find(x=>x.id===id); if(!l||!can('a_manage_licenses')) return;
  closeModal();
  l.archived=true; log('Licence archived', l.product, id); render();
  post('PATCH','/api/licenses/'+id,{version:l.version, archived:true})
    .then(d=>{ if(d){ if(d.version) l.version=d.version; toast(`${l.product} archived.`); } });
}

/* ---- add / edit ---- */
function termFields(prefix, months, recurring){
  /* typed term: a number + unit that round-trips term_months */
  const yrs = months%12===0;
  return `
    <div class="field"><label>Term</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="number" id="${prefix}-tn" min="1" step="1" value="${yrs?months/12:months}" style="width:90px">
        <select id="${prefix}-tu" style="width:110px">
          <option value="months" ${yrs?'':'selected'}>month${months===1?'':'s'}</option>
          <option value="years" ${yrs?'selected':''}>years</option>
        </select>
        <label class="mini" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;text-transform:none;letter-spacing:0">
          <input type="checkbox" id="${prefix}-rec" ${recurring?'checked':''}> ↻ recurring (auto-renews)
        </label>
      </div>
      <div class="mini muted" style="margin-top:4px">Billed up front at each term start — monthly items are a 1-month recurring term.</div>
    </div>`;
}
function readTerm(prefix){
  const n=parseInt(document.getElementById(prefix+'-tn').value,10);
  const unit=document.getElementById(prefix+'-tu').value;
  if(isNaN(n)||n<1) return null;
  const months=unit==='years'?n*12:n;
  return months>=1&&months<=120?{months, recurring:document.getElementById(prefix+'-rec').checked}:null;
}

function licenseModal(id, presetClient){
  if(!can('a_manage_licenses')) return;
  const l=id?state.licenses.find(x=>x.id===id):null;
  const cOpts=[{v:'',label:'All clients (MSP-wide)'},...pickableClients().map(c=>({v:c.id,label:c.name}))];
  if(l && l.clientId && !cOpts.some(o=>o.v===l.clientId)) cOpts.push({v:l.clientId, label:clientName(l.clientId)+' (archived)'});
  openModal(`
    <div class="modal-head"><div><h3>${l?'Edit licence — '+esc(l.product):'Add licence'}</h3>
      <p>Type the term as it was sold — monthly, 1 year, 3 years… — and tick recurring if it auto-renews.</p></div>
      <button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="field"><label>Product</label><input type="text" id="lf-prod" value="${esc(l?l.product:'')}" placeholder="Microsoft 365 Business Premium"></div>
      <div class="detail-grid">
        <div class="field"><label>Vendor</label><input type="text" id="lf-vendor" value="${esc(l?l.vendor:'')}"></div>
        <div class="field"><label>Client</label>${combo('lf-client', cOpts, l?(l.clientId||''):(presetClient||''), null, 'Pick a client…')}</div>
        <div class="field"><label>Seats (total)</label><input type="number" id="lf-total" min="1" step="1" value="${l?l.seatsTotal:1}"></div>
        <div class="field"><label>Seats in use</label><input type="number" id="lf-used" min="0" step="1" value="${l?l.seatsUsed:0}"></div>
      </div>
      ${termFields('lf', l?l.termMonths:12, l?l.recurring:false)}
      <div class="detail-grid">
        <div class="field"><label>Term started</label><input type="date" id="lf-start" value="${l&&l.termStartedOn?l.termStartedOn:localISODate()}"></div>
        ${canSeeCosts()?`<div class="field"><label>Cost per seat / term ($)</label><input type="number" id="lf-cost" min="0" step="0.01" value="${l?(l.costCents/100):''}" placeholder="0.00"><div class="mini muted" style="margin-top:4px">Pool cost = this &#215; total seats. Lump-priced licence? Use 1 seat.</div></div>`:''}
      </div>
      <div class="field"><label>Note</label><textarea id="lf-note" rows="2">${esc(l?l.note:'')}</textarea></div>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="saveLicense('${l?l.id:''}')">${l?'Save licence':'Add licence'}</button></div>`, true);
  document.getElementById('lf-prod').focus();
}

function saveLicense(id){
  const g=x=>document.getElementById(x);
  const product=g('lf-prod').value.trim();
  if(!product){ toast('The licence needs a product name.'); return; }
  const term=readTerm('lf');
  if(!term){ toast('The term must be 1–120 months (1–10 years).'); return; }
  const total=parseInt(g('lf-total').value,10), used=parseInt(g('lf-used').value,10);
  if(isNaN(total)||total<1||isNaN(used)||used<0){ toast('Seats must be sensible numbers.'); return; }
  const costEl=g('lf-cost');
  const costCents=costEl?Math.round(parseFloat(costEl.value||'0')*100):null;
  if(costEl&&(isNaN(costCents)||costCents<0)){ toast('Cost must be a positive amount.'); return; }
  const clientId=g('lf-client').value||'';
  const start=g('lf-start').value;
  if(!start){ toast('The term needs a start date.'); return; }
  closeModal();
  if(!id){
    const body={ product, vendor:g('lf-vendor').value.trim(), client_id:clientId||null,
      seats_total:total, seats_used:used, term_months:term.months, recurring:term.recurring,
      term_started_on:start, note:g('lf-note').value.trim() };
    if(costEl) body.cost_cents=costCents;
    log('Licence added', product);
    post('POST','/api/licenses',body).then(d=>{ if(d) toast(`Licence ${product} added.`); });
    return;
  }
  const l=state.licenses.find(x=>x.id===id); if(!l) return;
  const body={version:l.version};
  if(product!==l.product) body.product=product;
  if(g('lf-vendor').value.trim()!==l.vendor) body.vendor=g('lf-vendor').value.trim();
  if(clientId!==(l.clientId||'')) body.client_id=clientId;      /* '' = MSP-wide */
  if(total!==l.seatsTotal) body.seats_total=total;
  if(used!==l.seatsUsed) body.seats_used=used;
  if(term.months!==l.termMonths) body.term_months=term.months;
  if(term.recurring!==l.recurring) body.recurring=term.recurring;
  if(start!==l.termStartedOn) body.term_started_on=start;
  if(costEl&&costCents!==l.costCents) body.cost_cents=costCents;
  if(g('lf-note').value.trim()!==l.note) body.note=g('lf-note').value.trim();
  if(Object.keys(body).length===1){ toast('Nothing changed.'); return; }
  log('Licence updated', product, id);
  post('PATCH','/api/licenses/'+id, body)
    .then(d=>{ if(d){ if(d.version) l.version=d.version; toast(`Licence ${product} saved.`); } });
}
