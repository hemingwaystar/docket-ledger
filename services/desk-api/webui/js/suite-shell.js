/* suite-shell.js — suite.html chrome: tab switching between the Docket,
   Ledger and Assets panes, the postMessage relay between the frames, and
   frame src resolution (nginx front vs direct service port).
   Endpoints: none — this file never calls the API.
   Invariants: the relay only accepts messages whose source is one of our own
   frames, and posts with an explicit location.origin target. Split view stays
   the Docket + Ledger pair (the CSS keys split panes to .show). */
/* All iframes stay mounted the whole time, so each app keeps its state while
   hidden — switching tabs never resets an app. */
const FRAMES = { docket:'fr-docket', ledger:'fr-ledger', assets:'fr-assets' };
let view = 'docket';
function show(v){
  view = v;
  const stage = document.getElementById('stage');
  stage.classList.toggle('split', v==='split');
  document.getElementById('pane-docket').classList.toggle('show', v==='docket'||v==='split');
  document.getElementById('pane-ledger').classList.toggle('show', v==='ledger'||v==='split');
  document.getElementById('pane-assets').classList.toggle('show', v==='assets');
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on', b.dataset.v===v));
}
/* Message relay — broadcast each app's events to every OTHER frame; each
   app's bridge filters by d.src itself (Ledger and Assets both accept only
   'docket' events today; Docket accepts 'ledger' and, from Build 28, 'assets'). */
const fr = id => document.getElementById(id).contentWindow;
window.addEventListener('message', ev=>{
  const srcId = Object.keys(FRAMES).find(k=>ev.source===fr(FRAMES[k]));
  if(!srcId) return;                       /* nothing else gets a voice */
  const d = ev.data || {};
  if(d.src!==srcId) return;                /* the envelope must match the frame */
  if(d.type==='suite-nav'){ show(FRAMES[d.app]?d.app:'docket'); return; }
  Object.keys(FRAMES).forEach(k=>{ if(k!==srcId) fr(FRAMES[k]).postMessage(d, location.origin); });
  if(d.type==='open-ticket' && srcId!=='docket'){ show(view==='split'?'split':'docket'); }
});

/* live: on the nginx front (standard https port) Ledger/Assets are proxied
   under /ledger/ and /assets/; on direct NetBird access each stays on its
   own service port */
const stdPort = location.port===''||location.port==='443'||location.port==='80';
document.getElementById('fr-ledger').src = stdPort
  ? '/ledger/ui/ledger.html'
  : location.protocol + '//' + location.hostname + ':8082/ui/ledger.html';
document.getElementById('fr-assets').src = stdPort
  ? '/assets/ui/assets.html'
  : location.protocol + '//' + location.hostname + ':8083/ui/assets.html';
