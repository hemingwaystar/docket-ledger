/* ==========================================================================
   views/settings.js — the lapse-scan configuration (app_config key 'assets',
   consumed by Build 30's worker pass) + where the rest of admin lives.
   Endpoints: PUT /api/config/assets.
   ========================================================================== */

function viewSettings(){
  const cfg=state.cfg, k=cfg.lapse_kinds||{};
  return `
  <div class="grid g-2" style="align-items:start">
    <div class="card">
      <div class="card-head"><h3>Coverage-lapse tickets</h3><span class="hint">runs from Build 30</span></div>
      <div class="card-pad">
        <div class="notice info" style="margin-bottom:14px">${icon(IC.warn)}
          <div>Before coverage runs out, a Docket ticket is raised automatically — <b>no owner, no contact, client set to the record's company</b> — and filed to the board below. Recurring terms renew themselves and never raise one.</div></div>
        <div class="field"><label>Lead time (days before lapse)</label>
          <input type="number" id="st-lead" min="1" max="365" step="1" value="${cfg.lapse_lead_days||60}" style="width:120px"></div>
        <div class="field"><label>Docket board (group) for lapse tickets</label>
          <input type="text" id="st-group" value="${esc(cfg.lapse_group||'Alerts')}" placeholder="Alerts">
          <div class="mini muted" style="margin-top:4px">Must match a group name in Docket's Directory — create the “${esc(cfg.lapse_group||'Alerts')}” board there if it doesn't exist yet.</div></div>
        <div class="field"><label>Raise tickets for</label>
          <label class="mini" style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;margin-bottom:6px"><input type="checkbox" id="st-kw" ${k.warranty!==false?'checked':''}> Asset warranties ending</label>
          <label class="mini" style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;margin-bottom:6px"><input type="checkbox" id="st-kl" ${k.license!==false?'checked':''}> Non-recurring licence terms ending</label>
          <label class="mini" style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0"><input type="checkbox" id="st-kc" ${k.contract!==false?'checked':''}> Non-recurring contract terms ending</label></div>
        ${can('a_manage_settings')?`<button class="btn primary" onclick="saveAssetsCfg()">Save settings</button>`
          :'<div class="mini muted">Read-only — needs “Manage Assets settings”.</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Access &amp; roadmap</h3></div>
      <div class="card-pad" style="font-size:13px;color:var(--ink-2);line-height:1.7">
        <b>Roles &amp; permissions</b> for Assets are managed in <b>Docket → Directory → Roles</b>, on the same matrix as Docket and Ledger (the a_* column). Changes apply at each person's next sign-in.<br>
        <span class="mini muted">Coming next: Build 28 links tickets to an affected CI · Build 29 posts asset/licence/contract charges to Ledger periods (up front, per term) · Build 30 turns on the lapse scan configured here.</span>
      </div>
    </div>
  </div>`;
}

function saveAssetsCfg(){
  if(!can('a_manage_settings')) return;
  const g=x=>document.getElementById(x);
  const lead=parseInt(g('st-lead').value,10);
  if(isNaN(lead)||lead<1||lead>365){ toast('Lead time must be 1–365 days.'); return; }
  const group=g('st-group').value.trim();
  if(!group){ toast('Name the Docket board lapse tickets should land on.'); return; }
  const next={ lapse_lead_days:lead, lapse_group:group,
    lapse_kinds:{warranty:g('st-kw').checked, license:g('st-kl').checked, contract:g('st-kc').checked} };
  /* key-order-stable compare (audit: stringify vs Postgres jsonb key order
     made the guard fail open after every hydrate) */
  const flat=o=>JSON.stringify(Object.keys(o||{}).sort().map(k=>[k, typeof o[k]==='object'&&o[k]&&!Array.isArray(o[k])?Object.keys(o[k]).sort().map(kk=>[kk,o[k][kk]]):o[k]]));
  if(flat(next)===flat(state.cfg)){ toast('Nothing changed.'); return; }  /* diff-guard */
  state.cfg=next;
  log('Settings changed', `lapse scan: ${lead}d lead → “${group}”`);
  render();
  post('PUT','/api/config/assets',{value:next}).then(d=>{ if(d) toast('Settings saved.'); });
}
