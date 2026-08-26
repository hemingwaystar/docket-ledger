/* ==========================================================================
   Ledger — views/types.js
   Activity-type list: billable toggle + effective-dated hourly rate.
   Types are created/renamed/archived in Docket (the shared control plane);
   billable status and rates live here.
   Endpoints called here:
     PATCH /api/types/{id}       — toggleTypeBillable (billable)
     PUT   /api/types/{id}/rate  — setTypeRate, and toggleTypeBillable's
                                   "billable needs a rate" default (rate_cents)
   Invariant: rate edits are effective-dated (rateHist) — entries before
   today keep their price; locked periods never re-price.
   ========================================================================== */

function viewTypes(){
  const list=state.types;
  const pg=paginate('types',list);
  const rows=pg.slice.map(a=>{
    const n=state.entries.filter(e=>e.typeId===a.id && e.status!=='void').length;
    if(a.sentinel) return `<tr>
      <td><div class="cell-title">${esc(a.name)} <span class="chip unclassified" style="margin-left:6px"><span class="cdot"></span>system</span></div>
          <div class="cell-meta">Where the ticket timer parks entries with no activity type. Blocks a period close until reclassified.</div></td>
      <td><span class="chip nonbill"><span class="cdot"></span>Never billable</span></td>
      <td class="num muted">—</td>
      <td class="num">${n}</td>
    </tr>`;
    const arch = a.active===false;
    if(arch) return `<tr style="opacity:.55">
      <td><div class="cell-title">${esc(a.name)} <span class="chip" style="margin-left:6px"><span class="cdot"></span>Archived</span></div><div class="cell-meta">hidden from pickers — existing entries keep it and keep pricing</div></td>
      <td><span class="chip ${a.billable?'billable':'nonbill'} slim"><span class="cdot"></span>${a.billable?'Billable':'Non-billable'}</span></td>
      <td class="num muted">${a.billable?fmtMoney(a.rate)+'/h':'—'}</td>
      <td class="num">${n}</td>
    </tr>`;
    return `<tr>
      <td><div class="cell-title">${esc(a.name)}</div><div class="cell-meta">${a.note?esc(a.note):'<span class="muted">— no note —</span>'}</div></td>
      <td><div style="display:flex;align-items:center;gap:9px"><button class="toggle ${a.billable?'on':''}" onclick="toggleTypeBillable('${a.id}')"></button><span class="mini">${a.billable?'Billable':'Non-billable'}</span></div></td>
      <td class="num"><input type="number" min="0" step="5" value="${a.rate}" onchange="setTypeRate('${a.id}',this.value,this)" ${a.billable?'':'disabled'} style="width:110px;text-align:right"></td>
      <td class="num">${n}</td>
    </tr>`;
  }).join('');
  return `
  <div class="notice info" style="margin-bottom:16px">${icon(IC.tag)}<div>These are the same activity types Docket’s ticket timer logs against. Turning a type <b>billable</b> and setting a rate re-prices every open (unlocked) entry that uses it. Locked entries never change.</div></div>
  <div class="card"><table class="tbl">
    <thead><tr><th>Activity type</th><th>Billable</th><th class="num">Rate ($/h)</th><th class="num">Entries</th></tr></thead>
    <tbody>${rows}</tbody></table>${pagerBar(pg)}
    <div class="mini muted" style="padding:10px 16px 12px">Create, rename or archive types in <b>Docket → Directory</b> (the shared control plane). Billable status and rates live here.</div></div>`;
}

function toggleTypeBillable(id){
  const a=atype(id); if(!a) return;
  const was={b:a.billable,r:a.rate};
  a.billable=!a.billable; if(a.billable&&!a.rate)a.rate=150;
  log('Activity type updated',`${esc(a.name)} → ${a.billable?'billable':'non-billable'}`,id); render();
  $fetch('/api/types/'+encodeURIComponent(id),{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({billable:a.billable})})
    .then(async r=>{ if(!r.ok) return oops(await jshort(r)); });
  if(a.rate!==was.r)                              /* "billable needs a rate" default */
    $fetch('/api/types/'+encodeURIComponent(id)+'/rate',{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rate_cents:Math.round(a.rate*100)})})
      .then(async r=>{ if(!r.ok) return oops(await jshort(r)); });
}
function setTypeRate(id,v,srcEl){
  const a = atype(id); const nv = Number(v)||0;
  if(nv === a.rate){ return; }
  const today = new Date(Date.now()).toISOString().slice(0,10);
  a.rateHist = a.rateHist||[];
  const was = a.rate;
  /* 'unpriced' mirrors the server: no history at all, OR only the 0-cent
     placeholder rows a billable flip writes (review catch: keying on
     length alone made the message claim the opposite of the repricing) */
  if(!a.rateHist.some(r=>r.rate>0)){
    /* FIRST-ever rate: the server anchors it at epoch on purpose (never
       price pre-existing time at $0) — so ALL open history reprices to
       this. The old message claimed the opposite (audit). Placeholder
       0-cent rows are repaired server-side; mirror that locally. */
    a.rateHist = [{ from:'1970-01-01', rate:nv }];
    a.rate = nv;
    log('Rate set (first ever)', `${a.name}: ${fmtMoney(nv)}/h across ALL history — the type was unpriced; every open entry reprices from $0`, id);
    toast(`${a.name}: ${fmtMoney(nv)}/h — applies to all existing open time (was unpriced).`);
  } else {
    const last = a.rateHist[a.rateHist.length-1];
    if(last.from===today) last.rate = nv;            /* same-day edits collapse into one row */
    else a.rateHist.push({ from:today, rate:nv });
    a.rate = nv;
    log('Rate changed (effective-dated)', `${a.name}: ${fmtMoney(was)}/h → ${fmtMoney(nv)}/h effective ${today} — entries before today keep ${fmtMoney(was)}/h`, id);
    toast(`${a.name}: ${fmtMoney(nv)}/h from today — history keeps its price.`);
  }
  commitRender(srcEl);
  $fetch('/api/types/'+encodeURIComponent(id)+'/rate',{method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({rate_cents:Math.round(a.rate*100)})})
    .then(async r=>{ if(!r.ok) return oops(await jshort(r)); });
}
