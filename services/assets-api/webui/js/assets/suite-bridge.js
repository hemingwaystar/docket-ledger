/* ==========================================================================
   Assets — suite-bridge.js
   Live link to the suite shell. Bootstrap is the durable feed (shared
   Postgres); the bridge only supplements between hydrates: Directory
   client events arriving from Docket keep the client pickers fresh.
   All posts target location.origin explicitly — never '*'. Outbound
   openInDocket() is wired for Build 28's asset↔ticket links (the desk
   side starts accepting {src:'assets'} then).
   ========================================================================== */
/* the SHELL's origin, not ours — on direct-port access Assets runs at :8083
   while the shell is :8081; location.origin made the browser silently drop
   every message (audit). Behind nginx the two match. */
const PARENT_ORIGIN = (typeof ABASE!=='undefined'&&ABASE)? location.origin
  : location.protocol+'//'+location.hostname+':8081';
function notifyDocket(payload){ try{ if(window.parent!==window) window.parent.postMessage(Object.assign({src:'assets'}, payload), PARENT_ORIGIN); }catch(e){} }
function openInDocket(ticket){
  if(window.parent!==window){ window.parent.postMessage({src:'assets', type:'open-ticket', ticket}, PARENT_ORIGIN); }
  else toast('Open the suite (suite.html) to jump between the apps.');
}
window.addEventListener('message', ev=>{
  /* only accept relayed messages from our own suite shell */
  if(window.parent===window || ev.source!==window.parent) return;
  const d = ev.data || {};
  if(d.src!=='docket') return;
  const upsertClient = (cl)=>{
    let c = state.clients.find(x=>x.id===cl.id);
    if(!c){ state.clients.push({id:cl.id, name:cl.name, sentinel:false, archived:cl.active===false});
      log('Client received from Directory', cl.name); }
    else { if(c.name!==cl.name){ log('Client renamed via Directory', `${c.name} → ${cl.name}`); c.name=cl.name; }
      c.archived = cl.active===false; }
  };
  if(d.type==='dir-client-upsert' && d.client){ upsertClient(d.client); render(); }
  if(d.type==='dir-snapshot' && d.snapshot && d.snapshot.clients){
    d.snapshot.clients.forEach(upsertClient);
    log('Directory reconciled', `${d.snapshot.clients.length} clients — authoritative copy from the shared control plane`);
    render();
  }
});
