/* ==========================================================================
   Ledger — views/settings.js
   Settings view: global defaults, default billing rates (effective-dated;
   clients opt in per client on their client page), Docket connection, the
   RBAC pointer to Docket's Directory, and the Odoo export connector (an
   open stub — safe to leave blank; while disabled, exports produce a
   preview payload only).
   Endpoints called:
     PUT /api/config/ledger  — persistLedgerCfg() (debounced 600 ms)
     PUT /api/config/odoo    — persistLedgerCfg() (same debounce; API key
                               stripped — it travels the secrets path only)
     PUT /api/secrets/odoo   — saveOdooKey() (write-only, never read back)
     PUT /api/default-rates/{typeId} — defaultRatePut() (debounced 600 ms)
                               for setDefaultRate (global default rates)
   ========================================================================== */

function viewSettings(){
  const s=state.settings, o=s.odoo;
  const row=(t,d,ctrl)=>`<div class="setting-row"><div class="sl"><b>${t}</b><p>${d}</p></div><div>${ctrl}</div></div>`;
  /* build 14: label-above is the settings standard (same policy as Docket).
     Every labeled text/number/select field renders via field() — label +
     optional caption above, full-width control below (.field, shared with
     desk.css). Toggles/buttons/chips stay inline via row(); the default
     billing rates table keeps its table layout — a table IS a labeled grid. */
  const field=(t,d,ctrl)=>`<div class="field"><label>${t}</label>${d?`<p class="cap">${d}</p>`:''}${ctrl}</div>`;
  return `
  <div class="grid g-2" style="align-items:start">
    <div class="card">
      <div class="card-head"><h3>Global defaults</h3></div>
      <div class="card-pad" style="border-bottom:1px solid var(--line)">
        ${row('Retainers / block-hour agreements','Turn off if agreements are managed in Odoo — per-client configuration and burn-down disappear everywhere, but nothing is deleted.',
          `<button class="toggle ${state.settings.retainers.enabled?'on':''}" onclick="s_toggleRetainers()"></button>`)}
        ${row('New types billable by default','Saved, not applied yet — new types currently arrive non-billable until reviewed here. Wiring ships with a later build.',
          `<button class="toggle ${s.defaultBillable?'on':''}" onclick="s_toggle('defaultBillable')"></button>`)}
      </div>
      <div class="card-pad">
        ${field('Default billing cycle','Saved, not applied yet — new clients currently start monthly; override per client on the Clients page.',
          `<select onchange="state.settings.defaultCycle=this.value;persistLedgerCfg()" style="text-transform:capitalize"><option ${s.defaultCycle==='weekly'?'selected':''}>weekly</option><option ${s.defaultCycle==='monthly'?'selected':''}>monthly</option></select>`)}
        ${field('Hour display','Hours always show to two decimals (e.g. 1.00 h). Saved, not applied yet — pricing math is exact; rounding-at-pricing ships with a later build.',
          `<select onchange="state.settings.rounding=this.value;persistLedgerCfg()"><option value="none" ${s.rounding==='none'?'selected':''}>Exact (2 dp)</option><option value="6" ${s.rounding==='6'?'selected':''}>Nearest 6 min</option><option value="15" ${s.rounding==='15'?'selected':''}>Nearest 15 min</option></select>`)}
        ${field('Currency','Symbol used across the ledger; rides the export payload as its currency field.',
          `<select onchange="state.settings.currency=this.value;persistLedgerCfg()"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option></select>`)}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Docket connection</h3></div>
      <div class="card-pad">
        ${field('Docket','The helpdesk this app pairs with.',
          `<input type="text" class="ro in-mono" readonly value="${esc(s.host||location.host)}" title="Derived from this deployment — the suite shares one origin behind nginx">`)}
      </div>
    </div>
  </div>

  <div class="section-gap"></div>
  <div class="card">
    <div class="card-head"><h3>Default billing rates</h3><span class="hint">clients opt in per client — “use global default rates”</span></div>
    <div class="card-pad">
      <div class="notice info" style="margin-bottom:14px">${icon(IC.tag)}<div>These rates price any billable type for clients whose <b>use global default rates</b> switch is on (Clients → a client → Billing configuration), unless that type is toggled off there or the client has its own rate. Rates are <b>effective-dated</b> — a change today never re-prices earlier time, and locked periods never change.</div></div>
      <table class="tbl">
        <thead><tr><th>Activity type</th><th class="num">Rate ($/h)</th><th>Effective from</th></tr></thead>
        <tbody>${state.types.filter(t=>!t.sentinel&&t.active!==false).map(t=>{
          const d=state.defaultRates[t.id]||{rate:null,hist:[]};
          const last=d.hist.length?d.hist[d.hist.length-1].from:null;
          return `<tr>
            <td><div class="cell-title">${esc(t.name)}</div></td>
            <td class="num">${canSeeMoney()&&(can('manage_types')||can('manage_settings'))?`<input type="number" min="0" step="5" value="${d.rate!=null?d.rate:''}" placeholder="—" data-fkey="df-${t.id}" oninput="setDefaultRate('${t.id}',this.value)" style="width:110px;text-align:right">`:(canSeeMoney()&&d.rate!=null?`<span class="in-mono">${d.rate}</span>`:'<span class="muted">—</span>')}</td>
            <td class="mini muted">${last?(last==='1970-01-01'?'always':fmtDate(last)):'—'}</td>
          </tr>`;}).join('')}</tbody></table>
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
        ${field('Instance URL','',`<input type="text" class="in-mono" placeholder="https://mycompany.odoo.com" value="${esc(o.url)}" onchange="state.settings.odoo.url=this.value;persistLedgerCfg()">`)}
        ${field('Database','',`<input type="text" class="in-mono" placeholder="mycompany-prod" value="${esc(o.db)}" onchange="state.settings.odoo.db=this.value;persistLedgerCfg()">`)}
        ${field('API user','',`<input type="text" class="in-mono" placeholder="billing@mycompany.com" value="${esc(o.user)}" onchange="state.settings.odoo.user=this.value;persistLedgerCfg()">`)}
        ${field(`API key ${state.odooSecret?`<span class="mini muted" style="text-transform:none;letter-spacing:0;font-weight:500">rotated ${fmtStamp(state.odooSecret.at)}${state.odooSecret.by?' by '+esc(state.odooSecret.by):''}</span>`:`<span class="mini muted" style="text-transform:none;letter-spacing:0;font-weight:500">not set</span>`}`,'',
          `<div style="display:flex;gap:8px"><input type="password" id="odooKeyIn" class="in-mono" placeholder="write-only — sealed under the KEK, never shown again" style="flex:1" autocomplete="new-password"><button class="btn sm" onclick="saveOdooKey()">Save key</button></div>`)}
        ${field('Journal','',`<input type="text" value="${esc(o.journal)}" onchange="state.settings.odoo.journal=this.value;persistLedgerCfg()">`)}
        ${field('Post invoices as','',`<select onchange="state.settings.odoo.mode=this.value;persistLedgerCfg()"><option value="draft" ${o.mode==='draft'?'selected':''}>Draft (review in Odoo)</option><option value="posted" ${o.mode==='posted'?'selected':''}>Posted</option></select>`)}
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:16px">
        <button class="toggle ${o.enabled?'on':''}" onclick="s_toggleOdoo()"></button>
        <span class="mini">${o.enabled?'Connector enabled — exports are recorded server-side; posting to Odoo ships with the connector build':'Connector disabled — exports produce a preview payload only'}</span>
        <div class="spacer"></div>
        <button class="btn sm" onclick="toast('No live connector yet — exports are recorded server-side (ledger.odoo_exports); nothing is sent to Odoo')">Test connection</button>
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
    /* the Retainers module toggle was the ONE config doc this saver never
       sent — it reverted on every reload while looking saved (audit) */
    $fetch('/api/config/retainers',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({value:st.retainers||{enabled:false}})})
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
function s_toggleRetainers(){ state.settings.retainers.enabled=!state.settings.retainers.enabled;
  log('Retainers module '+(state.settings.retainers.enabled?'enabled':'disabled'),'suite-wide');
  render(); persistLedgerCfg(); }
function s_toggleOdoo(){ state.settings.odoo.enabled=!state.settings.odoo.enabled; render(); persistLedgerCfg(); }

/* ---- global default billing rates — one function per control, mirroring
   the clientRatePut pattern: optimistic local mutation + dated history row
   (histToday, views/clients.js — loads earlier in ledger.html), diff-guard,
   debounced PUT, oops() on refusal, focus carried by data-fkey. ---- */
const dfTimers={};
const defaultRatePut=(tid,rate)=>{
  clearTimeout(dfTimers[tid]);
  dfTimers[tid]=setTimeout(()=>
    $fetch('/api/default-rates/'+encodeURIComponent(tid),{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rate_cents:rate!=null?Math.round(rate*100):null})})
      .then(async r=>{ if(!r.ok) return oops(await jshort(r));
        setTimeout(()=>hydrate(),300); }),600);
};
function setDefaultRate(tid,v){
  const d=state.defaultRates[tid]||(state.defaultRates[tid]={rate:null,hist:[]});
  const nv=v===''?null:Number(v);
  if(nv===d.rate) return;                                  /* diff-guard */
  d.rate=nv;
  d.hist=histToday(d.hist,'rate',nv);
  log('Default rate changed (effective-dated)', `${esc(atype(tid).name)} → ${nv!=null?fmtMoney(nv)+'/h':'unset'} from today — earlier time keeps its price`, tid);
  defaultRatePut(tid,nv); render();
}
