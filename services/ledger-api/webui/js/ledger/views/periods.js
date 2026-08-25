/* ==========================================================================
   Ledger — views/periods.js
   Billing Periods (viewPeriods) + Odoo Export (viewExport) and their
   actions: approve & lock a period, export a period, payload preview.
   viewPeriods is a searchable client list (state.pf={q,open,hq}): one row
   per non-sentinel client — archived clients only when they have period
   history, dimmed — showing the CURRENT period's status and billable
   total; a row expands to the current period's detail + actions and that
   client's historical periods (server PERIODS rows ∪ entry-derived spans,
   newest first, searched by state.pf.hq against label/status).
   Endpoints called here:
     POST /api/periods/{id}/approve        — approvePeriod (fires in the
                                             modal-confirm callback)
     POST /api/periods/{id}/mark-exported  — runExport (the export ref is
                                             issued by the server; local
                                             state flips from the response)
   previewPayload builds its preview locally from state — no server call.
   Invariants: period server ids come from PERIODS (api.js); no API call
   fires unless the local action actually changed state. Period keys stay
   UI-shaped (M/W prefixes) everywhere in this file — srvPeriodKey
   translates only at the fetch boundary inside the actions (rows 39/40).
   ========================================================================== */

/* ===================== BILLING PERIODS ===================== */
function pfState(){ return state.pf || (state.pf={q:'',open:{},hq:''}); }
function pfSetQ(v){ pfState().q=v; render(); }
function pfSetHq(v){ pfState().hq=v; render(); }
function pfToggle(cid){ const pf=pfState(); pf.open[cid]=!pf.open[cid]; render(); }

/* a period key carries its own cycle (M/W/B prefix) and date, so a history
   row can exist without entries — and a client's cycle change never
   relabels the periods that were cut under the old cycle */
const PF_CYCLE={M:'monthly',W:'weekly',B:'biweekly'};
function periodFromKey(pk){
  /* noon, not midnight: key dates come from toISOString() on local starts,
     so a midnight parse can drift a day east of UTC — noon can't */
  return periodFor(PF_CYCLE[pk[0]]||'monthly', (pk[0]==='M'?pk.slice(1)+'-01':pk.slice(1))+'T12:00:00');
}
/* every past period this client has had: the server's PERIODS rows arrive
   UI-keyed in state.periods (mapIn translates once, rows 39/40), and
   entry-derived spans cover periods the server never materialized. The
   ORIGINAL key rides along — lookups and actions use it; the derived
   period object is display-only (label/span). */
function pfHistory(c, curKey){
  const keys={};
  Object.keys(state.periods).forEach(k=>{ const [cid,pk]=k.split('|'); if(cid===c.id) keys[pk]=1; });
  /* void entries never resurrect a period (approvals.js skips them the same
     way, and the server hides void-only open periods from bootstrap) —
     anything legitimate still arrives via state.periods above */
  state.entries.forEach(e=>{ if(e.clientId===c.id && e.status!=='void') keys[entryPeriod(e).key]=1; });
  delete keys[curKey];
  /* era clamp: key shapes are M2026-07 / W2026-07-20 / B2026-01-05, so
     slice(1,5) is always the 4-digit year — string compare is correct */
  return Object.keys(keys).filter(pk=>pk.slice(1,5)>='2000').map(pk=>({pk,per:periodFromKey(pk)})).sort((a,b)=>b.per.start-a.per.start);
}
function perChip(ps){
  return ps.status==='exported'
    ? `<span class="chip exported"><span class="cdot"></span>Approved · exported</span>`
    : ps.status==='approved'
    ? `<span class="chip approved"><span class="cdot"></span>Approved · locked</span>`
    : `<span class="chip pending"><span class="cdot"></span>Open</span>`;
}
/* one period's entry math — the same tallies the per-period cards ran */
function pfTally(clientId, pk){
  const es=state.entries.filter(e=>e.clientId===clientId && entryPeriod(e).key===pk);
  let h=0,a=0,unclass=0,voided=0,submitted=0,approved=0;
  es.forEach(e=>{const p=priced(e); if(e.status==='void'){voided++;return;} h+=p.h; a+=p.amount; if(p.unclassified)unclass++; if(e.submitted||isLocked(e))submitted++; if(e.tsApproved||isLocked(e))approved++;});
  const flat=projFlatTotal(clientId,pk); a+=flat;
  return {h,a,unclass,voided,submitted,approved,flat,live:es.length-voided};
}
/* compact per-period actions for history rows — the SAME wired functions
   (approvePeriod / runExport / previewPayload); their guards decide */
function pfActions(clientId, pk, ps, t){
  const a = `'${jsq(clientId)}','${jsq(pk)}'`;
  if(ps.status==='open'){
    if(t.live===0) return '<span class="muted">—</span>';
    return t.unclass>0
      ? `<button class="btn sm" disabled title="Classify all entries first">${icon(IC.lock)}Approve &amp; lock</button> <span class="mini" style="color:var(--warn)">${t.unclass} unclassified</span>`
      : `<button class="btn sm seal" onclick="approvePeriod(${a})">${icon(IC.seal)}Approve &amp; lock</button>`;
  }
  if(ps.status==='approved')
    return `<button class="btn sm primary" onclick="runExport(${a})">${icon(IC.export)}Export to Odoo</button> <button class="btn sm" onclick="previewPayload(${a})">Preview payload</button>`;
  return `<button class="btn sm" onclick="previewPayload(${a})">View payload</button>`;
}

function viewPeriods(){
  const pf=pfState();
  const q=pf.q.trim().toLowerCase(), hq=pf.hq.trim().toLowerCase();
  let archHidden=0;
  const rows=[];
  state.clients.filter(c=>!c.sentinel).forEach(c=>{
    const cur=periodFor(c.cycle,NOW);
    const hist=pfHistory(c,cur.key);
    const archived=!!(c.archived||c.archivedInDocket);
    if(archived && hist.length===0){ archHidden++; return; }   /* archived clients earn a row only through history */
    if(q && !c.name.toLowerCase().includes(q)) return;
    rows.push({c,cur,hist,archived});
  });
  /* the sentinel intake bucket rides at the BOTTOM, dimmed, only when it
     actually holds time — its periods must stay approvable (they were
     reachable on the old per-card page), but the row reads as a to-do:
     reassign that time to a real client, don't bill the bucket */
  state.clients.filter(c=>c.sentinel).forEach(c=>{
    if(!state.entries.some(e=>e.clientId===c.id && e.status!=='void')) return;
    if(q && !c.name.toLowerCase().includes(q)) return;
    const cur=periodFor(c.cycle||'monthly',NOW);
    rows.push({c,cur,hist:pfHistory(c,cur.key),archived:false,sentinel:true});
  });
  const pg=paginate('periods',rows);
  const body=pg.slice.map(({c,cur,hist,archived,sentinel})=>{
    const ps=periodState(c.id,cur.key), t=pfTally(c.id,cur.key);
    const open=ps.status==='open', expanded=!!pf.open[c.id];
    const main=`<tr class="${archived||sentinel?'pf-dim':''}">
      <td><div class="cell-title">${esc(c.name)}${archived?' <span class="chip void slim"><span class="cdot"></span>archived in Docket</span>':''}${sentinel?' <span class="chip void slim" title="unassigned intake — reassign this time to a real client rather than billing the bucket"><span class="cdot"></span>intake bucket</span>':''}</div>
        <div class="cell-meta" style="text-transform:capitalize">${c.cycle} · ${cur.label}</div></td>
      <td>${perChip(ps)}</td>
      <td class="num">${t.live} · ${fmtHours(t.h)} h</td>
      <td class="num" style="font-weight:600">${fmtMoney(t.a)}</td>
      <td class="right"><button class="rowbtn" onclick="pfToggle('${jsq(c.id)}')">${expanded?'Hide':'Open'}</button></td>
    </tr>`;
    if(!expanded) return main;

    /* current-period actions — same guards and copy as always */
    let action;
    const ca = `'${jsq(c.id)}','${jsq(cur.key)}'`;
    if(open){
      action = t.unclass>0
        ? `<button class="btn" disabled title="Classify all entries first">${icon(IC.lock)}Approve &amp; lock</button><div class="mini" style="color:var(--warn);margin-top:6px">${t.unclass} unclassified — classify first</div>`
        : t.live>0
        ? `<button class="btn seal" onclick="approvePeriod(${ca})">${icon(IC.seal)}Approve &amp; lock</button>`
        : `<div class="mini muted">No entries this period yet.</div>`;
    } else {
      action = `<div class="seal-stamp">${icon(IC.seal)}Approved ${ps.approvedAt?fmtDate(ps.approvedAt):''}</div>
        ${ps.status==='approved'
          ? `<button class="btn primary sm" style="margin-left:10px" onclick="runExport(${ca})">${icon(IC.export)}Export to Odoo</button><button class="btn sm" style="margin-left:6px" onclick="previewPayload(${ca})">Preview payload</button>`
          : `<span class="mini" style="margin-left:10px">Exported → <span class="tape">${ps.exportRef}</span></span><button class="btn sm" style="margin-left:6px" onclick="previewPayload(${ca})">View payload</button>`}`;
    }
    const shown=hist.map(({pk,per})=>({pk,per,ps:periodState(c.id,pk),t:pfTally(c.id,pk)}))
      .filter(x=>!hq || (x.per.label+' '+x.ps.status).toLowerCase().includes(hq));
    const pgH=paginate('periodHist:'+c.id, shown);
    const histTable = hist.length===0
      ? `<div class="mini muted">No historical periods yet.</div>`
      : shown.length===0
      ? `<div class="mini muted">No historical periods match.</div>`
      : `<div class="pf-hist-tbl"><table class="tbl">
          <thead><tr><th>Period</th><th>Status</th><th class="num">Entries</th><th class="num">Hours</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${pgH.slice.map(x=>`<tr>
            <td><div class="cell-title">${x.per.label}</div><div class="cell-meta">${fmtDateShort(x.per.start)} – ${fmtDateShort(new Date(x.per.end-86400000))}</div></td>
            <td>${perChip(x.ps)}${x.ps.status==='exported'&&x.ps.exportRef?`<div class="cell-meta">ref <span class="tape">${x.ps.exportRef}</span></div>`:''}</td>
            <td class="num">${x.t.live}${x.t.voided?` <span class="mini" style="color:var(--void)">+${x.t.voided} void</span>`:''}</td>
            <td class="num">${fmtHours(x.t.h)}</td>
            <td class="num" style="font-weight:600">${fmtMoney(x.t.a)}${x.t.flat>0?`<div class="mini" style="color:var(--seal)">incl. ${fmtMoney(x.t.flat)} flat fees</div>`:''}</td>
            <td class="right" style="white-space:nowrap">${pfActions(c.id,x.pk,x.ps,x.t)}</td>
          </tr>`).join('')}</tbody></table></div>${pagerBar(pgH)}`;
    const panel=`<tr class="expand"><td colspan="5"><div class="expand-inner">
      <div style="display:flex;align-items:center;gap:10px"><div class="cell-title">Current period — ${cur.label}</div>${perChip(ps)}</div>
      <div class="pf-stats tape">
        <div><div class="mini muted">Entries</div><div class="n">${t.live}${t.voided?` <span class="mini" style="color:var(--void)">+${t.voided} void</span>`:''}</div></div>
        <div><div class="mini muted">Hours</div><div class="n">${fmtHours(t.h)}</div></div>
        <div><div class="mini muted">Amount</div><div class="n">${fmtMoney(t.a)}</div>${t.flat>0?`<div class="mini" style="color:var(--seal)">incl. ${fmtMoney(t.flat)} project flat fees</div>`:''}</div>
        ${open?`<div><div class="mini muted">Approved by manager</div><div class="n" style="color:${(t.live>0&&t.approved===t.live)?'var(--brand)':'var(--ink)'}">${t.approved}/${t.live}</div></div>`:''}
      </div>
      ${open&&t.live>0&&t.submitted<t.live&&t.unclass===0?`<div class="mini" style="color:var(--ink-3);margin-top:2px">${t.live-t.submitted} entr${t.live-t.submitted===1?'y':'ies'} not yet submitted by the technician — you can still approve &amp; lock, or wait for them.</div>`
      :open&&t.live>0&&t.approved<t.live&&t.submitted===t.live?`<div class="mini" style="color:var(--ink-3);margin-top:2px">${t.live-t.approved} submitted entr${t.live-t.approved===1?'y':'ies'} awaiting timesheet approval — review on the <a href="#" onclick="go('approvals');return false" style="color:inherit;text-decoration:underline">Approvals</a> page.</div>`:''}
      <div style="margin-top:12px;display:flex;align-items:center;flex-wrap:wrap">${action}</div>
      <div class="pf-hist-head">
        <h4>Historical periods</h4>
        <div class="search">${icon(IC.search)}<input type="text" placeholder="Search period, status…" value="${esc(pf.hq)}" data-fkey="pf-hq-${c.id}" oninput="pfSetHq(this.value)"></div>
        <span class="mini muted">${shown.length} of ${hist.length}</span>
      </div>
      ${histTable}
    </div></td></tr>`;
    return main+panel;
  }).join('');
  const toolbar=`<div class="toolbar">
    <div class="search">${icon(IC.search)}<input type="text" placeholder="Search clients…" value="${esc(pf.q)}" data-fkey="pf-q" oninput="pfSetQ(this.value)"></div>
    <div class="mini muted">${rows.length} client${rows.length===1?'':'s'}${archHidden?` · ${archHidden} archived without period history hidden`:''}</div>
  </div>`;
  return `${capBanner()}<div class="notice info" style="margin-bottom:16px">${icon(IC.period)}<div>Approving a period <b>locks every entry in it permanently</b> — they become immutable and can’t be edited or deleted, and the period is cleared for Odoo export. A period can’t be approved while any entry is Unclassified.</div></div>
  ${toolbar}
  <div class="card"><table class="tbl">
    <thead><tr><th>Client</th><th>Current period</th><th class="num">Entries</th><th class="num">Amount</th><th></th></tr></thead>
    <tbody>${body||`<tr><td colspan="5"><div class="empty">${icon(IC.period)}<div>${q?'No clients match.':'No clients yet.'}</div></div></td></tr>`}</tbody></table>${pagerBar(pg)}</div>`;
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
      /* honest wording (audit): mark-exported RECORDS the payload — no code
         posts to Odoo yet; claiming 'Posted' let an operator believe a
         draft invoice reached Odoo when nothing was ever sent */
      log('Export recorded',`${esc(c.name)} · ${periodFor(c.cycle,findPeriodDate(clientId,pk)).label} · payload stored server-side (${state.settings.odoo.enabled?state.settings.odoo.mode+' invoice, awaiting the connector build':'connector disabled'}) · ${ref}`,clientId+'|'+pk);
      toast(`Export recorded · ${ref}${state.settings.odoo.enabled?' — the connector build will post it to Odoo':' (connector disabled)'}`);
      render();
      setTimeout(hydrate,600);
    });
}

function previewPayload(clientId,pk){
  const c=client(clientId);
  const es=state.entries.filter(e=>e.clientId===clientId && entryPeriod(e).key===pk && e.status!=='void');
  const lines={}; es.forEach(e=>{const p=priced(e); if(!p.billable)return; const t=atype(e.typeId); const k=t.id; (lines[k]=lines[k]||{name:t.name,qty:0,price:p.rate}); lines[k].qty+=p.h;});
  const flatLines = projFlatLines(clientId, pk).map(fl=>({name:`${fl.project} — ${fl.label}`, quantity:1, price_unit:fl.amount, uom:'Fee'}));
  const payload={ partner:c.name, client_id:c.id, journal:state.settings.odoo.journal, move_type:'out_invoice', state:state.settings.odoo.mode,
    invoice_line_ids:Object.values(lines).map(l=>({name:l.name,quantity:Number(l.qty.toFixed(2)),price_unit:l.price,uom:'Hours'})).concat(flatLines) };
  openModal(`<div class="modal-head"><h3>Odoo export payload</h3><p>${esc(c.name)} — what the connector would send</p></div>
    <div class="modal-body"><div class="note-body tape" style="font-size:12px;max-height:340px;overflow:auto">${esc(JSON.stringify(payload,null,2))}</div>
    <div class="mini muted" style="margin-top:10px">This is the payload the export records server-side (<span class="tape">ledger.odoo_exports</span>). No connector posts to Odoo yet — that arrives with the connector build.</div></div>
    <div class="modal-foot"><button class="btn primary" onclick="closeModal()">Close</button></div>`);
}
