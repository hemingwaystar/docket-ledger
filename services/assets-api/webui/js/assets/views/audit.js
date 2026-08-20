/* ==========================================================================
   views/audit.js — the Assets audit trail: audit.events rows (app assets +
   auth), actor pre-resolved to a display name server-side (the Docket JOIN
   pattern), plus this session's optimistic log() rows until the next
   hydrate. Server-written, read-only truth — nothing here edits it.
   CSV exports the FILTERED rows, gated a_export_csv.
   ========================================================================== */

function auditFilteredRows(){
  const f=state.auf, q=(f.q||'').toLowerCase();
  const from=f.from?new Date(f.from+'T00:00:00').getTime():-Infinity;
  const to=f.to?new Date(f.to+'T23:59:59').getTime():Infinity;
  return state.audit.filter(a=>
    a.ts>=from && a.ts<=to &&
    (!f.actor.length || f.actor.includes(a.actor)) &&
    (!q || ((a.action||'')+' '+(a.detail||'')+' '+(a.actor||'')+' '+(a.entityId||'')).toLowerCase().includes(q)));
}

function viewAudit(){
  const rows=auditFilteredRows();
  const pg=paginate('auditList', rows);
  return `
  <div class="notice lock" style="margin-bottom:14px">${icon(IC.audit)}
    <div>Every change is recorded here and can't be edited — the append-only system log (app <b>assets</b> + sign-ins). Each asset, licence and contract also carries its own attributed change feed on its detail page.</div></div>
  <div class="toolbar">
    <div class="search"><span>${icon(IC.search)}</span><input type="search" data-fkey="audit-q" placeholder="Search events…" value="${esc(state.auf.q)}" oninput="state.auf.q=this.value;render()"></div>
    <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('auft-actor', [...new Set(state.audit.map(a=>a.actor||''))].filter(Boolean).sort().map(x=>({v:x,label:x})), state.auf.actor, v=>mfToggle('auf','actor',v), 'All actors')}</span>
    <input type="date" data-fkey="auf-from" value="${esc(state.auf.from)}" onchange="state.auf.from=this.value;render()" title="From">
    <input type="date" data-fkey="auf-to" value="${esc(state.auf.to)}" onchange="state.auf.to=this.value;render()" title="To">
    ${state.auf.q||state.auf.actor.length||state.auf.from||state.auf.to?`<button class="btn sm ghost" onclick="state.auf={q:'',actor:[],from:'',to:''};render()">Clear</button>`:''}
    <div class="spacer"></div>
    ${can('a_export_csv')?`<button class="btn" onclick="exportAuditCSV()">Export CSV</button>`:''}
  </div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th style="width:130px">When</th><th>Event</th><th>Detail</th><th style="width:170px">Actor</th></tr></thead>
      <tbody>
      ${pg.slice.length?pg.slice.map(a=>`<tr>
        <td class="mono" style="font-size:12px">${fmtStamp(a.ts)}</td>
        <td class="cell-title">${esc(a.action)}</td>
        <td style="font-size:12.5px;color:var(--ink-2);overflow-wrap:anywhere">${esc(a.detail||'')}</td>
        <td class="mini" style="font-size:12px">${esc(a.actor||'')}</td></tr>`).join('')
      :'<tr><td colspan="4"><div class="empty">No events match.</div></td></tr>'}
      </tbody>
    </table>
    ${pagerBar(pg)}
  </div>`;
}

function exportAuditCSV(){
  if(!can('a_export_csv')) return;
  const rows=[['When','Actor','Action','Entity','Detail']];
  auditFilteredRows().forEach(a=>rows.push([new Date(a.ts).toISOString(),a.actor||'',a.action||'',a.entityId||'',a.detail||'']));
  csvDownload('assets-audit.csv', rows);
  toast(rows.length-1+' events exported.');
}
