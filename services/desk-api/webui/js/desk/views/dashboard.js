/* ==========================================================================
   js/desk/views/dashboard.js — the Dashboard view.
   Owns: viewDashboard() — stat tiles (queue / mine / unassigned / SLA), the
   needs-attention table, queue-by-state bars (visibility filtered through
   shownDashboardStates(), state.js) with the ⚙ per-user show/hide popover
   (toggleDashGear/toggleDashState/resetDashStates), and the time-this-cycle
   card. Controls route to newTicketModal() (newticket.js), openTicket()
   (render.js) and openLedger() (suite.js).
   Endpoints: PUT /auth/me/prefs — via savePrefs({dashboardStates}) from the
   ⚙ popover's checkboxes; lists carry SHOWN labels, an ABSENT personal key
   means "follow the admin desk_ui default" (design §Storage).
   ========================================================================== */

/* ⚙ popover open/shut — pure local UI state, survives render() rebuilds */
function toggleDashGear(){ state.dashGear = !state.dashGear; render(); }
/* flip one state's visibility for THIS user: start from the effective shown
   list (personal pref if set, else admin default, else all), toggle, persist.
   savePrefs (state.js) mutates state.prefs locally, re-renders, PUTs
   /auth/me/prefs and oops()es on failure — one code path per control. */
function toggleDashState(label){
  const shown = shownDashboardStates().map(s=>s.label);
  const i = shown.indexOf(label);
  if(i>=0) shown.splice(i,1); else shown.push(label);
  savePrefs({ dashboardStates: shown });
}
/* drop the personal key entirely — back to following the admin default */
function resetDashStates(){ savePrefs({ dashboardStates: null }); }

function viewDashboard(){
  const sc = scoped().filter(t=>!isDone(t));
  const mine = sc.filter(t=>t.ownerId===state.meId);
  const unassigned = sc.filter(t=>!t.ownerId);
  const breached = sc.filter(t=>{const s=slaInfo(t); return s&&s.breached;});
  const dueSoon = sc.filter(t=>{const s=slaInfo(t); return s&&!s.breached&&s.due-nowMs()<4*H;});
  const attention = [...breached, ...sc.filter(t=>t.prio===4&&!breached.includes(t)), ...dueSoon.filter(t=>t.prio<4)];

  /* queue-by-state respects per-user visibility: shownDashboardStates()
     (state.js) resolves me.prefs.dashboardStates → admin desk_ui default →
     all active states, keeping STATES position order */
  const shownStates = shownDashboardStates();
  const byState = shownStates.map(s=>({s, n: scoped().filter(t=>t.st===s.id).length}));
  const maxN = Math.max(1,...byState.map(x=>x.n));
  const personalStates = Array.isArray((state.prefs||{}).dashboardStates);

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
      <div class="card card-pad" style="position:relative">
        <div class="card-head" style="padding:0 0 12px;border:0"><h3>Queue by state</h3>
          ${personalStates?'':`<span class="hint">(admin default)</span>`}
          <span class="spacer"></span>
          <button class="btn sm ghost" onclick="toggleDashGear()" title="Choose which states this card shows">⚙</button>
        </div>
        ${state.dashGear?`<div style="position:absolute;right:14px;top:44px;z-index:60;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 24px rgba(21,32,41,.14);padding:10px 12px;min-width:180px">
          <div class="mini muted" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;font-weight:600">Show states</div>
          ${aSTATES().map(s=>`<label class="mini" style="display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer">
            <input type="checkbox" ${shownStates.some(x=>x.id===s.id)?'checked':''} onchange="toggleDashState('${jsq(s.label)}')"> ${esc(s.label)}</label>`).join('')}
          <div class="mini muted" style="margin-top:7px;padding-top:7px;border-top:1px solid var(--line)">${personalStates?`<a href="#" onclick="resetDashStates();return false">Use admin default</a>`:'(admin default)'}</div>
        </div>`:''}
        ${byState.map(({s,n})=>`
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
            <span style="width:118px;flex:0 0 auto"><span class="chip ${s.cls}"><span class="cdot"></span>${s.label}</span></span>
            <div class="bar" style="flex:1"><i style="width:${(n/maxN*100).toFixed(0)}%"></i></div>
            <span class="tape mini" style="width:20px;text-align:right">${n}</span>
          </div>`).join('') || `<div class="mini muted" style="padding:6px 0">Every state is hidden — use ⚙ to pick which queues appear.</div>`}
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
