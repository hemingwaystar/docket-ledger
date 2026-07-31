/* ==========================================================================
   Ledger — views/periods.js
   Billing Periods (viewPeriods) + Odoo Export (viewExport) and their
   actions: approve & lock a period, export a period, payload preview.
   Endpoints called here:
     POST /api/periods/{id}/approve        — approvePeriod (fires in the
                                             modal-confirm callback)
     POST /api/periods/{id}/mark-exported  — runExport (the export ref is
                                             issued by the server; local
                                             state flips from the response)
   previewPayload builds its preview locally from state — no server call.
   Invariants: period server ids come from PERIODS (api.js); no API call
   fires unless the local action actually changed state.
   ========================================================================== */

/* ===================== BILLING PERIODS ===================== */
function viewPeriods(){
  // build the set of (client, period) buckets that have entries
  const buckets={};
  state.entries.forEach(e=>{
    const per=entryPeriod(e); const k=e.clientId+'|'+per.key;
    if(!buckets[k]) buckets[k]={clientId:e.clientId,per,es:[]};
    buckets[k].es.push(e);
  });
  const list=Object.values(buckets).sort((a,b)=> b.per.start-a.per.start || client(a.clientId).name.localeCompare(client(b.clientId).name));
  const cards=list.map(b=>{
    const c=client(b.clientId), ps=periodState(b.clientId,b.per.key);
    let h=0,a=0,unclass=0,voided=0,submitted=0,approved=0;
    b.es.forEach(e=>{const p=priced(e); if(e.status==='void'){voided++;return;} h+=p.h; a+=p.amount; if(p.unclassified)unclass++; if(e.submitted||isLocked(e))submitted++; if(e.tsApproved||isLocked(e))approved++;});
    const flatFees = projFlatTotal(b.clientId, b.per.key); a += flatFees;
    const live=b.es.length-voided;
    const open=ps.status==='open';
    const status = ps.status==='exported'
      ? `<span class="chip exported"><span class="cdot"></span>Approved · exported</span>`
      : ps.status==='approved'
      ? `<span class="chip approved"><span class="cdot"></span>Approved · locked</span>`
      : `<span class="chip pending"><span class="cdot"></span>Open</span>`;
    let action;
    if(open){
      action = unclass>0
        ? `<button class="btn" disabled title="Classify all entries first">${icon(IC.lock)}Approve &amp; lock</button><div class="mini" style="color:var(--warn);margin-top:6px">${unclass} unclassified — classify first</div>`
        : `<button class="btn seal" onclick="approvePeriod('${b.clientId}','${b.per.key}')">${icon(IC.seal)}Approve &amp; lock</button>`;
    } else {
      action = `<div class="seal-stamp">${icon(IC.seal)}Approved ${ps.approvedAt?fmtDate(ps.approvedAt):''}</div>
        ${ps.status==='approved'?`<button class="btn primary sm" style="margin-top:8px" onclick="go('export')">${icon(IC.export)}Export to Odoo</button>`:`<div class="mini" style="margin-top:8px">Exported → <span class="tape">${ps.exportRef}</span></div>`}`;
    }
    return `<div class="card card-pad" style="${open?'':'background:linear-gradient(180deg,rgba(176,134,47,.04),transparent)'}">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:10px"><div class="cell-title" style="font-size:15px">${esc(c.name)}</div>${status}</div>
          <div class="cell-meta" style="margin-top:3px;text-transform:capitalize">${c.cycle} · ${b.per.label}</div>
        </div>
      </div>
      <div style="display:flex;gap:26px;margin:14px 0 4px" class="tape">
        <div><div class="mini muted">Entries</div><div style="font-size:17px;font-weight:600">${live}${voided?` <span class="mini" style="color:var(--void)">+${voided} void</span>`:''}</div></div>
        <div><div class="mini muted">Hours</div><div style="font-size:17px;font-weight:600">${fmtHours(h)}</div></div>
        <div><div class="mini muted">Amount</div><div style="font-size:17px;font-weight:600">${fmtMoney(a)}</div>${flatFees>0?`<div class="mini" style="color:var(--seal)">incl. ${fmtMoney(flatFees)} project flat fees</div>`:''}</div>
        ${open?`<div><div class="mini muted">Approved by manager</div><div style="font-size:17px;font-weight:600;color:${(live>0&&approved===live)?'var(--brand)':'var(--ink)'}">${approved}/${live}</div></div>`:''}
      </div>
      ${open&&live>0&&submitted<live&&unclass===0?`<div class="mini" style="color:var(--ink-3);margin-top:2px">${live-submitted} entr${live-submitted===1?'y':'ies'} not yet submitted by the technician — you can still approve &amp; lock, or wait for them.</div>`
      :open&&live>0&&approved<live&&submitted===live?`<div class="mini" style="color:var(--ink-3);margin-top:2px">${live-approved} submitted entr${live-approved===1?'y':'ies'} awaiting timesheet approval — review on the <a href="#" onclick="go('approvals');return false" style="color:inherit;text-decoration:underline">Approvals</a> page.</div>`:''}
      <div style="margin-top:12px">${action}</div>
    </div>`;
  }).join('');
  return `<div class="notice info" style="margin-bottom:16px">${icon(IC.period)}<div>Approving a period <b>locks every entry in it permanently</b> — they become immutable and can’t be edited or deleted, and the period is cleared for Odoo export. A period can’t be approved while any entry is Unclassified.</div></div>
  <div class="grid g-2">${cards}</div>`;
}

function approvePeriod(clientId,pk){
  const c=client(clientId), per=periodFor(c.cycle, findPeriodDate(clientId,pk));
  const es=state.entries.filter(e=>e.clientId===clientId && entryPeriod(e).key===pk && e.status!=='void');
  const unclass=es.filter(e=>atype(e.typeId).sentinel).length;
  if(unclass>0){ toast('Classify all entries first'); return; }
  confirmModal(`Approve & lock this period?`,
    `<b>${esc(c.name)} — ${per.label}</b><br>${es.length} entries · ${fmtHours(es.reduce((s,e)=>s+priced(e).h,0))} h · ${fmtMoney(es.reduce((s,e)=>s+priced(e).amount,0))}<br><br>Once approved, every entry in this period becomes <b>immutable</b> — it can’t be edited or deleted, even if the underlying time event is later removed in Docket. This can’t be undone.`,
    'Approve & lock','seal',()=>{
      const ps=periodState(clientId,pk);
      if(ps.status!=='open') return;   /* mirror only a real flip */
      ps.status='approved'; ps.approvedAt=Date.now(); ps.approvedBy=state.user.name;
      log('Period approved',`${esc(c.name)} · ${per.label} · ${es.length} entries locked`,clientId+'|'+pk);
      toast(`Period locked — ${es.length} entries are now immutable`); render();
      /* PERIODS rows carry server keys — translate ours (bug #22's boundary) */
      const srv=PERIODS.find(x=>x.clientId===clientId&&x.key===srvPeriodKey(pk));
      if(srv&&srvId(srv.id)) post('/api/periods/'+srv.id+'/approve',{approver_email:state.user.email});
      else { toast('⚠ No matching server period — approval was NOT saved'); setTimeout(hydrate,800); }
    });
}

/* ===================== ODOO EXPORT ===================== */
function viewExport(){
  const approved=[];
  Object.entries(state.periods).forEach(([k,ps])=>{
    if(ps.status==='open') return;
    const [clientId,pk]=k.split('|');
    const es=state.entries.filter(e=>e.clientId===clientId && entryPeriod(e).key===pk && e.status!=='void');
    if(es.length) approved.push({clientId,pk,ps,es});
  });
  approved.sort((a,b)=>b.ps.approvedAt-a.ps.approvedAt);

  const connector=`
    <div class="card">
      <div class="card-head"><h3>Odoo connector</h3><span class="hint">${state.settings.odoo.enabled?'configured':'not configured — export runs in preview mode'}</span></div>
      <div class="card-pad">
        <div class="notice ${state.settings.odoo.enabled?'info':'warn'}" style="margin-bottom:14px">${icon(state.settings.odoo.enabled?IC.check:IC.warn)}<div>${state.settings.odoo.enabled?'Connected. Approved periods post as invoices to the configured journal.':'This is an <b>open connector stub</b>. Fill in your Odoo details in Settings and wire the endpoint in the backend — until then, export produces a preview payload and a reference, without posting.'}</div></div>
        <div class="grid g-2">
          <div><div class="mini muted">Instance URL</div><div class="v tape">${state.settings.odoo.url||'—'}</div></div>
          <div><div class="mini muted">Database</div><div class="v tape">${state.settings.odoo.db||'—'}</div></div>
          <div><div class="mini muted">Journal</div><div class="v">${esc(state.settings.odoo.journal)}</div></div>
          <div><div class="mini muted">Post as</div><div class="v" style="text-transform:capitalize">${state.settings.odoo.mode} invoice</div></div>
        </div>
        <div style="margin-top:12px"><button class="btn sm" onclick="go('settings')">${icon(IC.settings)}Edit connector settings</button></div>
      </div>
    </div>`;

  if(approved.length===0) return connector+`<div class="section-gap"></div><div class="card"><div class="empty">${icon(IC.export)}<div>No approved periods yet.<br>Approve a period on the <a href="#" onclick="go('periods');return false">Billing Periods</a> page to make it exportable.</div></div></div>`;

  const cards=approved.map(x=>{
    const c=client(x.clientId), per=periodFor(c.cycle, x.es[0].startedAt);
    // group into invoice lines by activity type (billable only)
    const lines={};
    let total=0;
    x.es.forEach(e=>{const p=priced(e); if(!p.billable)return; const t=atype(e.typeId);
      const key=t.id; if(!lines[key])lines[key]={name:t.name,h:0,rate:p.rate,amt:0}; lines[key].h+=p.h; lines[key].amt+=p.amount; total+=p.amount;});
    const flatLines = projFlatLines(x.clientId, x.pk);
    flatLines.forEach(fl=>{ total += fl.amount; });
    const flatRows = flatLines.map(fl=>`<tr><td>${esc(fl.project)} — ${esc(fl.label)} <span class="mini muted">#${fl.ticket} · flat fee${fl.hours?` · ${fmtHours(fl.hours)} h worked`:''}</span></td><td class="num">—</td><td class="num">—</td><td class="num" style="font-weight:600">${fmtMoney(fl.amount)}</td></tr>`).join('');
    const lineRows=(Object.values(lines).map(l=>`<tr><td>${esc(l.name)}</td><td class="num">${fmtHours(l.h)}</td><td class="num">${fmtMoney(l.rate)}</td><td class="num" style="font-weight:600">${fmtMoney(l.amt)}</td></tr>`).join('') + flatRows)
      || `<tr><td colspan="4" class="muted">No billable lines (all non-billable this period)</td></tr>`;
    const done=x.ps.status==='exported';
    return `<div class="card">
      <div class="card-head"><h3>${esc(c.name)}</h3><span class="hint" style="text-transform:capitalize">${c.cycle} · ${per.label}${(()=>{const rm=retainerFor(c)?retainerMath(c.id,per.key):null; return rm?` · retainer ${rm.used.toFixed(1)}/${rm.included.toFixed(1)} h${rm.overageH>0?` · overage ${fmtMoney(rm.overageAmt)}`:''}`:'';})()}</span>
        <div style="margin-left:auto">${done?`<span class="chip exported"><span class="cdot"></span>Exported · ${x.ps.exportRef}</span>`:`<span class="chip approved"><span class="cdot"></span>Ready</span>`}</div></div>
      <table class="tbl"><thead><tr><th>Invoice line (by activity)</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${lineRows}<tr><td colspan="3" class="num" style="font-weight:600">Invoice total</td><td class="num" style="font-weight:700">${fmtMoney(total)}</td></tr></tbody></table>
      <div class="card-pad" style="border-top:1px solid var(--line);display:flex;align-items:center;gap:10px">
        ${done
          ? `<div class="mini muted">Exported ${fmtStamp(x.ps.exportedAt)} · ref <span class="tape">${x.ps.exportRef}</span></div><div class="spacer"></div><button class="btn sm" onclick="previewPayload('${x.clientId}','${x.pk}')">View payload</button>`
          : `<button class="btn primary" onclick="runExport('${x.clientId}','${x.pk}')">${icon(IC.export)}Export to Odoo</button><button class="btn sm" onclick="previewPayload('${x.clientId}','${x.pk}')">Preview payload</button><div class="spacer"></div><div class="mini muted">${x.es.length} entries · locked</div>`}
      </div>
    </div>`;
  }).join('<div class="section-gap"></div>');
  return connector+`<div class="section-gap"></div>`+cards;
}

/* server-first by design (fix L6): the export ref is the SERVER's record —
   no locally invented refs. The trade for optimistic feel is loud failure. */
function runExport(clientId,pk){
  const ps=periodState(clientId,pk);
  if(ps.status!=='approved') return;   /* only an approved, not-yet-exported period exports */
  const srv=PERIODS.find(x=>x.clientId===clientId&&x.key===srvPeriodKey(pk));
  if(!srv||!srvId(srv.id)){ toast('⚠ No matching server period — export unavailable'); return; }
  const c=client(clientId);
  toast('Exporting…');
  $fetch('/api/periods/'+srv.id+'/mark-exported',{method:'POST'})
    .then(async r=>{
      if(!r.ok) return oops(await jshort(r));
      const d=await jshort(r); const ref=(d&&d.export_ref)||'recorded';
      ps.status='exported'; ps.exportedAt=Date.now(); ps.exportRef=ref;
      log('Exported to Odoo',`${esc(c.name)} · ${periodFor(c.cycle,findPeriodDate(clientId,pk)).label} · ${state.settings.odoo.enabled?state.settings.odoo.mode+' invoice':'preview only'} · ${ref}`,clientId+'|'+pk);
      toast(state.settings.odoo.enabled?`Posted to Odoo · ${ref}`:`Preview generated · ${ref} (connector disabled)`);
      render();
      setTimeout(hydrate,600);
    });
}

function previewPayload(clientId,pk){
  const c=client(clientId);
  const es=state.entries.filter(e=>e.clientId===clientId && entryPeriod(e).key===pk && e.status!=='void');
  const lines={}; es.forEach(e=>{const p=priced(e); if(!p.billable)return; const t=atype(e.typeId); const k=t.id; (lines[k]=lines[k]||{name:t.name,qty:0,price:p.rate}); lines[k].qty+=p.h;});
  const flatLines = projFlatLines(clientId, pk).map(fl=>({name:`${fl.project} — ${fl.label}`, quantity:1, price_unit:fl.amount, uom:'Fee'}));
  const payload={ partner:c.name, zammad_org_id:c.zorg, journal:state.settings.odoo.journal, move_type:'out_invoice', state:state.settings.odoo.mode,
    invoice_line_ids:Object.values(lines).map(l=>({name:l.name,quantity:Number(l.qty.toFixed(2)),price_unit:l.price,uom:'Hours'})).concat(flatLines) };
  openModal(`<div class="modal-head"><h3>Odoo export payload</h3><p>${esc(c.name)} — what the connector would send</p></div>
    <div class="modal-body"><div class="note-body tape" style="font-size:12px;max-height:340px;overflow:auto">${esc(JSON.stringify(payload,null,2))}</div>
    <div class="mini muted" style="margin-top:10px">This is the open connector’s output. Map these fields to your Odoo model in the backend <span class="tape">odoo_connector.py</span>.</div></div>
    <div class="modal-foot"><button class="btn primary" onclick="closeModal()">Close</button></div>`);
}
