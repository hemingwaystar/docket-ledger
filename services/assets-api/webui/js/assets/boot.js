/* ==========================================================================
   Assets — boot.js
   Last script in the shell: paint the frame (nav + "Loading…" card), then
   fetch the bootstrap. Refocusing the window rehydrates at most once per
   30 s so stale tabs catch up without hammering the API.
   ========================================================================== */
render();
window.addEventListener('focus',()=>{ if(!window.__h||Date.now()-window.__h>30000){window.__h=Date.now();hydrate();} });
hydrate();

/* transport-failure net (audit): an optimistic mutation whose fetch REJECTED
   (network drop) used to keep its success toast and local state — no oops,
   no rehydrate. HTTP refusals are handled at each call site; this catches
   the transport layer. */
window.addEventListener('unhandledrejection', ev=>{ ev.preventDefault();
  console.error('server mirror failed', ev.reason);
  try{ oops(0); }catch(_e){} });
