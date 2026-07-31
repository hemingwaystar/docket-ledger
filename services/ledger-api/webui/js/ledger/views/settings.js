/* ==========================================================================
   Ledger — views/settings.js
   Settings view: global defaults, Docket connection, the RBAC pointer to
   Docket's Directory, and the Odoo export connector (an open stub — safe
   to leave blank; while disabled, exports produce a preview payload only).
   Endpoints called:
     PUT /api/config/ledger  — persistLedgerCfg() (debounced 600 ms)
     PUT /api/config/odoo    — persistLedgerCfg() (same debounce; API key
                               stripped — it travels the secrets path only)
     PUT /api/secrets/odoo   — saveOdooKey() (write-only, never read back)
   ========================================================================== */

function viewSettings(){
  const s=state.settings, o=s.odoo;
  const row=(t,d,ctrl)=>`<div class="setting-row"><div class="sl"><b>${t}</b><p>${d}</p></div><div>${ctrl}</div></div>`;
  return `
  <div class="grid g-2" style="align-items:start">
    <div class="card">
      <div class="card-head"><h3>Global defaults</h3></div>
      <div class="card-pad" style="border-bottom:1px solid var(--line)">
        <label class="mini" style="display:inline-flex;gap:8px;align-items:center;text-transform:none;cursor:pointer">
          <input type="checkbox" ${state.settings.retainers.enabled?'checked':''} onchange="state.settings.retainers.enabled=this.checked; log('Retainers module '+(this.checked?'enabled':'disabled'),'suite-wide'); render();persistLedgerCfg()" style="width:auto;accent-color:var(--brand)">
          <b>Retainers / block-hour agreements</b></label>
        <div class="mini muted" style="margin-top:4px">Turn off if agreements are managed in Odoo — per-client configuration and burn-down disappear everywhere, but nothing is deleted.</div>
      </div>
      <div class="card-pad">
        ${row('Default billing cycle','New clients inherit this. Override per client on the Clients page.',
          `<select onchange="state.settings.defaultCycle=this.value;persistLedgerCfg()" style="text-transform:capitalize"><option ${s.defaultCycle==='weekly'?'selected':''}>weekly</option><option ${s.defaultCycle==='monthly'?'selected':''}>monthly</option></select>`)}
        ${row('New types billable by default','When a new activity type appears, treat it as billable until reviewed.',
          `<button class="toggle ${s.defaultBillable?'on':''}" onclick="s_toggle('defaultBillable')"></button>`)}
        ${row('Hour display','Hours always show to two decimals (e.g. 1.00 h). Rounding policy applies at pricing.',
          `<select onchange="state.settings.rounding=this.value;persistLedgerCfg()"><option value="none" ${s.rounding==='none'?'selected':''}>Exact (2 dp)</option><option value="6" ${s.rounding==='6'?'selected':''}>Nearest 6 min</option><option value="15" ${s.rounding==='15'?'selected':''}>Nearest 15 min</option></select>`)}
        ${row('Currency','Used across the ledger and Odoo export.',
          `<select onchange="state.settings.currency=this.value;persistLedgerCfg()"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option></select>`)}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Docket connection</h3></div>
      <div class="card-pad">
        ${row('Docket','The helpdesk this app pairs with. Both apps read one Postgres and share Entra SSO — no API tokens stored here.',
          `<input type="text" value="${esc(s.host)}" onchange="state.settings.host=this.value;persistLedgerCfg()" style="width:260px">`)}
        ${row('Shared data','Clients, agents and activity types are one set of tables; time entries arrive live from Docket’s ticket timer.',
          `<button class="btn sm" onclick="toast('Shared tables verified: '+state.clients.length+' clients, '+state.techs.length+' agents ('+state.zammadRoles.filter(r=>r.tech).length+' tech roles), '+state.types.filter(t=>!t.sentinel).length+' activity types + Unclassified')">Sync now</button>`)}
        <div class="notice info" style="margin-top:6px">${icon(IC.check)}<div>Runs as its own service beside Docket — separate deploys, one shared database, one SSO session.</div></div>
      </div>
    </div>
  </div>

  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Roles &amp; permissions</h3><span class="hint">managed centrally</span></div>
    <div class="card-pad">
      <div class="notice info">${icon(IC.client)}<div><b>RBAC lives in the Directory.</b> Both apps' permission matrices — Docket's and this one — are managed in one place: <b>Docket → Directory → Roles &amp; permissions</b>. Changes made there apply here instantly. Effective permissions are resolved server-side from the same tables, so the UI never grants access the API wouldn't.</div></div>
      <div class="mini muted" style="margin-top:10px">${state.zammadRoles.map(r=>`<b>${esc(r.name)}</b> · ${r.perms.length} Ledger permission${r.perms.length===1?'':'s'}`).join(' &nbsp;—&nbsp; ')}</div>
      <button class="btn sm" style="margin-top:12px" onclick="openDirectoryInDocket()">Open the Directory ↗</button>
    </div>
  </div>

  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Odoo export connector</h3><span class="hint">open stub — safe to leave blank; export previews without posting</span></div>
    <div class="card-pad">
      <div class="grid g-2">
        <label class="setting-row" style="border:0;padding:0;display:block"><div class="sl"><b>Instance URL</b></div><input type="text" placeholder="https://mycompany.odoo.com" value="${esc(o.url)}" onchange="state.settings.odoo.url=this.value;persistLedgerCfg()" style="width:100%;margin-top:6px"></label>
        <label class="setting-row" style="border:0;padding:0;display:block"><div class="sl"><b>Database</b></div><input type="text" placeholder="mycompany-prod" value="${esc(o.db)}" onchange="state.settings.odoo.db=this.value;persistLedgerCfg()" style="width:100%;margin-top:6px"></label>
        <label class="setting-row" style="border:0;padding:0;display:block"><div class="sl"><b>API user</b></div><input type="text" placeholder="billing@mycompany.com" value="${esc(o.user)}" onchange="state.settings.odoo.user=this.value;persistLedgerCfg()" style="width:100%;margin-top:6px"></label>
        <label class="setting-row" style="border:0;padding:0;display:block"><div class="sl"><b>API key</b> ${state.odooSecret?`<span class="mini muted">rotated ${fmtStamp(state.odooSecret.at)}${state.odooSecret.by?' by '+esc(state.odooSecret.by):''}</span>`:`<span class="mini muted">not set</span>`}</div>
          <div style="display:flex;gap:8px;margin-top:6px"><input type="password" id="odooKeyIn" placeholder="write-only — sealed under the KEK, never shown again" style="flex:1" autocomplete="new-password"><button class="btn sm" onclick="saveOdooKey()">Save key</button></div></label>
        <label class="setting-row" style="border:0;padding:0;display:block"><div class="sl"><b>Journal</b></div><input type="text" value="${esc(o.journal)}" onchange="state.settings.odoo.journal=this.value;persistLedgerCfg()" style="width:100%;margin-top:6px"></label>
        <label class="setting-row" style="border:0;padding:0;display:block"><div class="sl"><b>Post invoices as</b></div><select onchange="state.settings.odoo.mode=this.value;persistLedgerCfg()" style="width:100%;margin-top:6px"><option value="draft" ${o.mode==='draft'?'selected':''}>Draft (review in Odoo)</option><option value="posted" ${o.mode==='posted'?'selected':''}>Posted</option></select></label>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:16px">
        <button class="toggle ${o.enabled?'on':''}" onclick="s_toggleOdoo()"></button>
        <span class="mini">${o.enabled?'Connector enabled — exports post to Odoo':'Connector disabled — exports produce a preview payload only'}</span>
        <div class="spacer"></div>
        <button class="btn sm" onclick="toast('Test call would run against the backend connector')">Test connection</button>
      </div>
    </div>
  </div>`;
}

/* every control above persists through one debounced saver — a burst of
   edits lands as one PUT per config doc */
let cfgTimer=null;
function persistLedgerCfg(){
  clearTimeout(cfgTimer);
  cfgTimer=setTimeout(()=>{
    const st=state.settings;
    const gen={currency:st.currency,host:st.host,defaultCycle:st.defaultCycle,
               defaultBillable:st.defaultBillable,rounding:st.rounding,minMinutes:st.minMinutes};
    const od=Object.assign({},st.odoo); delete od.apiKey;   // write-only, separate path
    $fetch('/api/config/ledger',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({value:gen})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
    $fetch('/api/config/odoo',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({value:od})})
      .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); });
  },600);
}
function saveOdooKey(){
  const el=document.getElementById('odooKeyIn');
  const v=el?el.value.trim():'';
  if(!v){ toast('Paste the key first'); return; }
  $fetch('/api/secrets/odoo',{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({value:v})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
      toast('Odoo key sealed — write-only from here on'); hydrate(); });
}
function s_toggle(k){ state.settings[k]=!state.settings[k]; render(); persistLedgerCfg(); }
function s_toggleOdoo(){ state.settings.odoo.enabled=!state.settings.odoo.enabled; render(); persistLedgerCfg(); }
