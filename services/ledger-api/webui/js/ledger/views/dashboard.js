/* views/dashboard.js — Dashboard view.
   viewDashboard: admin landing — current-period figures (unbilled amount, billable/
   non-billable hours, pending entries, unclassified count) plus a per-client rollup
   of open work. viewDashboardTech: a technician's own view — hours this cycle,
   classify/submit prompts, returned-entry notice, recent time.
   Pure render over hydrated state — this file calls no server endpoints. */

function viewDashboard(){
  if(!isAdmin()) return viewDashboardTech();
  const live = state.entries.filter(e=>e.status!=='void');
  // current-period figures: entries whose period is still open
  const openEntries = live.filter(e=>!isLocked(e));
  /* same bucketing rules as Reports (audit: the two pages disagreed):
     unclassified hours count NEITHER billable nor non-billable */
  let billH=0, nonbillH=0, unclassH=0, amt=0, unclass=0;
  openEntries.forEach(e=>{ const p=priced(e);
    if(p.unclassified){ unclass++; unclassH+=p.h; }
    else if(p.billable) billH+=p.h;
    else nonbillH+=p.h;
    amt+=p.amount; });
  const totalH=billH+nonbillH+unclassH;

  // group current open work by client
  const byClient={};
  openEntries.forEach(e=>{ (byClient[e.clientId]=byClient[e.clientId]||[]).push(e); });
  const clientCards = Object.keys(byClient).map(cid=>{
    const c=client(cid), es=byClient[cid]; const per=entryPeriod(es[0]);
    const mixed = !es.every(e=>entryPeriod(e).key===per.key);   /* older open periods ride along */
    let h=0,a=0,u=0; es.forEach(e=>{const p=priced(e); h+=p.h; a+=p.amount; if(p.unclassified)u++;});
    return {c,per,mixed,h,a,u,n:es.length};
  }).sort((x,y)=>y.a-x.a);
  const pgD=paginate('dashClients',clientCards);

  return `
  <div class="grid g-4">
    <div class="card stat"><div class="lab">Unbilled — all open periods</div><div class="val money">${fmtMoney(amt)}</div><div class="sub">across ${clientCards.length} clients</div></div>
    <div class="card stat"><div class="lab">Billable hours</div><div class="val tape">${fmtHours(billH)}<span class="u">h</span></div><div class="sub">${fmtHours(nonbillH)} h non-billable${unclassH?` · ${fmtHours(unclassH)} h unclassified`:''}</div></div>
    <div class="card stat"><div class="lab">Entries pending</div><div class="val tape">${openEntries.length}</div><div class="sub">${totalH.toFixed(2)} h logged</div></div>
    <div class="card stat"><div class="lab">Needs classifying</div><div class="val tape" style="color:${unclass?'var(--warn)':'var(--ink)'}">${unclass}</div><div class="sub">${unclass?'blocks period close':'all classified'}</div></div>
  </div>

  ${unclass>0?`<div class="section-gap"></div><div class="notice warn">${icon(IC.warn)}<div><b>${unclass} ${unclass===1?'entry':'entries'} still Unclassified.</b> A billing period can’t be approved until every entry in it has an activity type. Classify them on the <a href="#" onclick="go('timesheets');return false" style="color:inherit;text-decoration:underline">Timesheets</a> page.</div></div>`:''}

  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Current period by client</h3><span class="hint">each client bills on its own cycle</span></div>
    <table class="tbl">
      <thead><tr><th>Client</th><th>Cycle · period</th><th>Entries</th><th class="num">Hours</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>
        ${pgD.slice.map(x=>`
          <tr>
            <td><div class="cell-title">${esc(x.c.name)}</div><div class="cell-meta">client #${x.c.zorg} · shared with Docket</div></td>
            <td><span class="chip nonbill" style="text-transform:capitalize">${x.c.cycle}</span> <span class="mini">${x.per.label}${x.mixed?' + older open periods':''}</span></td>
            <td>${x.n}${x.u?` · <span style="color:var(--warn)">${x.u} unclassified</span>`:''}</td>
            <td class="num">${fmtHours(x.h)}</td>
            <td class="num" style="font-weight:600">${fmtMoney(x.a)}</td>
            <td class="right"><button class="btn sm" onclick="go('periods')">Review</button></td>
          </tr>`).join('')}
      </tbody>
    </table>${pagerBar(pgD)}
  </div>`;
}

/* technician's personal dashboard — their own time, no billing figures */
function viewDashboardTech(){
  const mine = scopedEntries().filter(e=>e.status!=='void');
  const open = mine.filter(e=>!isLocked(e));
  let totalH=0, unclass=0, unsub=0, submitted=0, lockedH=0;
  mine.forEach(e=>{ if(!isLocked(e)) totalH+=e.hours; else lockedH+=e.hours; });
  open.forEach(e=>{ if(atype(e.typeId).sentinel) unclass++; if(e.submitted) submitted++; else if(!atype(e.typeId).sentinel) unsub++; });
  const toClassify = open.filter(e=>atype(e.typeId).sentinel);
  const toSubmit   = open.filter(e=>!e.submitted && !atype(e.typeId).sentinel);
  const money = canSeeMoney();

  const recent = mine.slice().sort((a,b)=>b.startedAt-a.startedAt).slice(0,8);
  return `
  <div class="grid g-4">
    <div class="card stat"><div class="lab">My hours this cycle</div><div class="val tape">${fmtHours(totalH)}<span class="u">h</span></div><div class="sub">${fmtHours(lockedH)} h already locked</div></div>
    <div class="card stat"><div class="lab">Needs a type</div><div class="val tape" style="color:${unclass?'var(--warn)':'var(--ink)'}">${unclass}</div><div class="sub">${unclass?'classify before submitting':'all classified'}</div></div>
    <div class="card stat"><div class="lab">Ready to submit</div><div class="val tape" style="color:${unsub?'var(--brand)':'var(--ink)'}">${unsub}</div><div class="sub">classified, not yet sent</div></div>
    <div class="card stat"><div class="lab">Submitted</div><div class="val tape">${submitted}</div><div class="sub">awaiting review</div></div>
  </div>

  ${(()=>{ const ret=open.filter(e=>!e.submitted&&e.returnedBy);
    if(!ret.length) return '';
    const why=[...new Set(ret.map(e=>e.returnReason).filter(Boolean))];
    return `<div class="section-gap"></div><div class="notice warn">${icon(IC.warn)}<div><b>${ret.length} ${ret.length===1?'entry was':'entries were'} returned by ${esc(ret[0].returnedBy)}</b>${why.length?` — “${esc(why[0])}”`:''}. Review ${ret.length===1?'it':'them'} on <a href="#" onclick="go('timesheets');return false" style="color:inherit;text-decoration:underline">My Timesheets</a> (marked <b>returned</b>), fix, and resubmit.</div></div>`; })()}
  ${unclass>0?`<div class="section-gap"></div><div class="notice warn">${icon(IC.warn)}<div><b>${unclass} ${unclass===1?'entry needs':'entries need'} an activity type</b> before ${unclass===1?'it':'they'} can be submitted. Set ${unclass===1?'it':'them'} on <a href="#" onclick="go('timesheets');return false" style="color:inherit;text-decoration:underline">My Timesheets</a>.</div></div>`:''}
  ${(unclass===0&&unsub>0)?`<div class="section-gap"></div><div class="notice info">${icon(IC.check)}<div><b>${unsub} ${unsub===1?'entry is':'entries are'} classified and ready to submit.</b> Open <a href="#" onclick="go('timesheets');return false" style="color:inherit;text-decoration:underline">My Timesheets</a>, tick them, and choose <b>Submit for review</b>.</div></div>`:''}

  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>My recent time</h3><span class="hint">newest first</span></div>
    <table class="tbl">
      <thead><tr><th>Ticket / client</th><th>Activity</th><th class="num">Hours</th><th>Status</th></tr></thead>
      <tbody>
        ${recent.map(e=>`<tr>
          <td><div class="cell-title">${esc(e.ticketTitle)}</div><div class="cell-meta">${esc(client(e.clientId).name)} · #${e.zTicket} · ${fmtDate(e.startedAt)}</div></td>
          <td>${atype(e.typeId).sentinel?'<span class="chip unclassified slim"><span class="cdot"></span>Unclassified</span>':esc(atype(e.typeId).name)}</td>
          <td class="num" style="font-weight:600">${fmtHours(e.hours)}</td>
          <td>${statusChip(e)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}
