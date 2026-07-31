/* ==========================================================================
   Ledger — views/directory.js
   Read-only mirror of the shared control plane: groups & membership, roles
   & permissions, agents, clients and activity types — the same rows
   Docket's Directory manages in the shared database. Nothing here writes;
   the one button hands off to Docket (openDirectoryInDocket).
   No server endpoints called.
   ========================================================================== */

function viewDirectory(){
  const gname = id => (state.zammadGroups.find(g=>g.id===id)||{}).name||id;
  return `
  <div class="notice info" style="margin-bottom:16px">${icon(IC.client)}<div><b>Read-only mirror of the shared control plane.</b> These are the same records Docket manages — one set of clients, groups, agents, activity types and role permissions in the shared database. Edits happen in <b>Docket → Directory</b> and land here instantly; this page is for looking things up without leaving Ledger.</div></div>
  <div class="grid g-2">
    <div class="card card-pad">
      <div class="card-head" style="padding:0 0 6px;border:0"><h3>Groups &amp; membership</h3><span class="hint">shared</span></div>
      ${state.zammadGroups.map(g=>`<div class="setting-row" ${g.archived?'style="opacity:.55"':''}><div class="sl"><b>${esc(g.name)}</b>${g.archived?' <span class="chip void slim"><span class="cdot"></span>archived</span>':''}<p>${state.techs.filter(t=>t.groups.includes(g.id)).map(t=>t.name.split(' ')[0]).join(', ')||'no members'}</p></div></div>`).join('')}
    </div>
    <div>
      <div class="card card-pad">
        <div class="card-head" style="padding:0 0 6px;border:0"><h3>Roles &amp; permissions</h3><span class="hint">managed in Docket's Directory</span></div>
        ${state.zammadRoles.map(r=>`<div class="setting-row" ${r.archived?'style="opacity:.55"':''}><div class="sl"><b>${esc(r.name)}</b>${r.archived?' <span class="chip void slim"><span class="cdot"></span>archived</span>':''}<p>${esc(r.note||'')}</p></div><span class="mini muted">${r.perms.length} Ledger permission${r.perms.length===1?'':'s'}</span></div>`).join('')}
      </div>
      <div class="section-gap"></div>
      <div class="card card-pad">
        <div class="card-head" style="padding:0 0 6px;border:0"><h3>Agents</h3><span class="hint">shared</span></div>
        ${state.techs.map(t=>`<div class="setting-row"><div class="sl"><b>${esc(t.name)}</b><p>${t.groups.map(gname).map(esc).join(' · ')}</p></div></div>`).join('')}
      </div>
    </div>
  </div>
  <div class="section-gap"></div>
  <div class="grid g-2">
    <div class="card card-pad">
      <div class="card-head" style="padding:0 0 6px;border:0"><h3>Clients</h3><span class="hint">shared directory</span></div>
      ${state.clients.map(c=>`<div class="setting-row" ${c.archivedInDocket?'style="opacity:.55"':''}><div class="sl"><b>${esc(c.name)}</b>${c.archivedInDocket?' <span class="chip void slim"><span class="cdot"></span>archived in Docket</span>':''}<p>org #${c.zorg} · ${c.cycle} cycle</p></div></div>`).join('')}
    </div>
    <div class="card card-pad">
      <div class="card-head" style="padding:0 0 6px;border:0"><h3>Activity types</h3><span class="hint">rates set on the Activity Types page</span></div>
      ${state.types.filter(t=>!t.sentinel && t.active!==false).map(t=>`<div class="setting-row"><div class="sl"><b>${esc(t.name)}</b><p>${t.billable?fmtMoney(t.rate)+'/h':'non-billable'}</p></div></div>`).join('')}
    </div>
  </div>
  <div style="margin-top:14px"><button class="btn" onclick="openDirectoryInDocket()">Edit in Docket's Directory ↗</button></div>`;
}
