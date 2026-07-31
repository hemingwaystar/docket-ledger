/* ==========================================================================
   js/desk/views/dashboard.js — the Dashboard view.
   Owns: viewDashboard() — stat tiles (queue / mine / unassigned / SLA), the
   needs-attention table, queue-by-state bars and the time-this-cycle card.
   Pure render over hydrated state; its controls route to newTicketModal()
   (newticket.js), openTicket() (render.js) and openLedger() (suite.js).
   Endpoints: none.
   ========================================================================== */

function viewDashboard(){
  const sc = scoped().filter(t=>!isDone(t));
  const mine = sc.filter(t=>t.ownerId===state.meId);
  const unassigned = sc.filter(t=>!t.ownerId);
  const breached = sc.filter(t=>{const s=slaInfo(t); return s&&s.breached;});
  const dueSoon = sc.filter(t=>{const s=slaInfo(t); return s&&!s.breached&&s.due-nowMs()<4*H;});
  const attention = [...breached, ...sc.filter(t=>t.prio===4&&!breached.includes(t)), ...dueSoon.filter(t=>t.prio<4)];

  const byState = STATES.map(s=>({s, n: scoped().filter(t=>t.st===s.id).length}));
  const maxN = Math.max(1,...byState.map(x=>x.n));

  const hrsToday = scoped().flatMap(t=>t.time).reduce((a,e)=>a+e.h,0); /* all logged time on tickets in scope */
  return `
  <div class="grid g-4">
    <div class="card stat"><div class="lab">${can('view_all')?'Open in queue':'Open · my scope'}</div><div class="val tape">${sc.length}</div><div class="sub">${sc.filter(t=>t.st==='new').length} awaiting first response</div></div>
    <div class="card stat"><div class="lab">Assigned to me</div><div class="val tape">${mine.length}</div><div class="sub">${mine.filter(t=>t.prio>=3).length} high or urgent</div></div>
    <div class="card stat"><div class="lab">Unassigned</div><div class="val tape" style="color:${unassigned.length?'var(--warn)':'var(--ink)'}">${unassigned.length}</div><div class="sub">${can('assign')?'pick up from the queue':'dispatcher will assign'}</div></div>
    <div class="card stat"><div class="lab">SLA</div><div class="val tape" style="color:${breached.length?'var(--void)':'var(--ink)'}">${breached.length}<span class="u">breached</span></div><div class="sub">${dueSoon.length} due within 4h</div></div>
  </div>
  <div class="section-gap"></div>
  <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
    <div class="card">
      <div class="card-head"><h3>Needs attention</h3><span class="hint">breached, urgent, or due soon</span>
        <span class="spacer"></span>${can('create')?`<button class="btn sm primary" onclick="newTicketModal()">${icon(IC.plus)}New ticket</button>`:''}</div>
      ${attention.length? `<table class="tbl"><tbody>${attention.slice(0,6).map(t=>`
        <tr class="clickable" onclick="openTicket(${t.id})">
          <td class="num" style="width:64px"><span class="tape muted">#${t.id}</span></td>
          <td><div class="cell-title">${esc(t.title||firstLine(t))}</div>
              <div class="cell-meta">${esc(client(t.clientId).name)} · ${esc(grp(t.groupId).name)} · ${t.ownerId?esc(agent(t.ownerId).name):'unassigned'}</div></td>
          <td style="width:110px">${prioTag(t.prio)}</td>
          <td style="width:160px">${slaCell(t)}</td>
        </tr>`).join('')}</tbody></table>`
      : `<div class="empty">${icon(IC.clock)}<div>Nothing on fire. The queue is inside its targets.</div></div>`}
    </div>
    <div>
      <div class="card card-pad">
        <div class="card-head" style="padding:0 0 12px;border:0"><h3>Queue by state</h3></div>
        ${byState.map(({s,n})=>`
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
            <span style="width:118px;flex:0 0 auto"><span class="chip ${s.cls}"><span class="cdot"></span>${s.label}</span></span>
            <div class="bar" style="flex:1"><i style="width:${(n/maxN*100).toFixed(0)}%"></i></div>
            <span class="tape mini" style="width:20px;text-align:right">${n}</span>
          </div>`).join('')}
      </div>
      ${can('see_billing')?`<div class="section-gap"></div>
      <div class="card card-pad">
        <div class="card-head" style="padding:0 0 8px;border:0"><h3>Time this cycle</h3><span class="hint">flows into Ledger</span></div>
        <div style="display:flex;align-items:baseline;gap:8px"><span class="tape" style="font-size:26px;font-weight:600">${fmtHours(hrsToday)}</span><span class="muted">hours logged from tickets</span></div>
        <div class="mini muted" style="margin-top:6px">Pricing, approval and invoicing happen in Ledger — Docket only records who, what and how long.</div>
        <button class="btn sm" style="margin-top:10px" onclick="openLedger()">Open in Ledger ${icon(IC.clock)}</button>
      </div>`:''}
    </div>
  </div>`;
}
