/* ==========================================================================
   Assets — boot.js
   Last script in the shell: paint the frame (nav + "Loading…" card), then
   fetch the bootstrap. Refocusing the window rehydrates at most once per
   30 s so stale tabs catch up without hammering the API.
   ========================================================================== */
render();
window.addEventListener('focus',()=>{ if(!window.__h||Date.now()-window.__h>30000){window.__h=Date.now();hydrate();} });
hydrate();
