/* ==========================================================================
   js/desk/views/schedule.js — the Schedule tab: a calendar of the tech time
   blocks that live on tickets (desk.ticket_schedules, build 16). Day / Week /
   Month views over the SAME per-ticket schedules the case-file "Schedules" bar
   writes — this view only READS them, aggregated across every visible ticket.
   Owns: state.sched (mode · anchor · tech filter) · sched()/setSchedMode/
   setSchedTech/schedToday/schedStep · schedEvents() (the ONE flattened,
   scope-respecting, tech-filtered event list every mode reads) · date helpers
   (schStartOfDay/Week/Month, schAddDays/Months) · tech color assignment ·
   the day/week time-grid + month-grid renderers · viewSchedule.
   Endpoints: NONE — pure computation over state hydrated by api.js. Blocks are
   added/removed from the ticket case file (props.js); clicking a block here
   just openTicket()s into that ticket.
   Invariants: events come ONLY from scoped() tickets, so a technician sees
   exactly the schedules on tickets they can already see. startsAt/endsAt ride
   as ISO strings OR epoch ms — schedMs() (props.js) normalizes either. HP (px
   per hour) is mirrored by the .sch-col hour-line gradient in desk.css; change
   one, change both.
   ========================================================================== */

const SCHED_MODES = [ {id:'day',label:'Day'}, {id:'week',label:'Week'}, {id:'month',label:'Month'} ];
const HP = 44;                    // px per hour in the day/week time grid (see desk.css .sch-col)
const SCH_MIN_SPAN = 6;           // the day/week window never shows fewer than this many hours

/* schedule view state: mode (day|week|month), anchor ms (any instant inside
   the focused period), and a tech multi-select (empty = all techs). Cloned on
   every read so the tech array is never shared by reference. */
function sched(){
  const s = state.sched = Object.assign({ mode:'week', anchor:null, tech:[] }, state.sched||{});
  if(!s.anchor) s.anchor = nowMs();
  s.tech = Array.isArray(s.tech) ? s.tech.slice() : [];
  if(!SCHED_MODES.some(m=>m.id===s.mode)) s.mode = 'week';
  return s;
}
function setSchedMode(m){ sched().mode = m; render(); }
function setSchedTech(vals){ sched().tech = vals; render(); }         /* multiCombo onchg target */
function schedToday(){ sched().anchor = nowMs(); render(); }
/* step the anchor one period in either direction — a day / a week / a calendar
   month, matching the active mode (month arithmetic via setMonth handles the
   uneven month lengths and the year roll on its own) */
function schedStep(dir){
  const s = sched(), d = new Date(s.anchor);
  if(s.mode==='day') d.setDate(d.getDate()+dir);
  else if(s.mode==='week') d.setDate(d.getDate()+7*dir);
  else { d.setDate(1); d.setMonth(d.getMonth()+dir); }  /* clamp first — on the
    29th-31st a raw setMonth overflowed into skipped/repeated months (audit) */
  s.anchor = d.getTime(); render();
}

/* ---- local-time date helpers (all schedule times are local wall clock) ---- */
function schStartOfDay(ms){ const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function schStartOfWeek(ms){ const d=new Date(schStartOfDay(ms)); d.setDate(d.getDate()-d.getDay()); return d.getTime(); } /* weeks start Sunday */
function schStartOfMonth(ms){ const d=new Date(ms); d.setHours(0,0,0,0); d.setDate(1); return d.getTime(); }
function schAddDays(ms,n){ const d=new Date(ms); d.setDate(d.getDate()+n); return d.getTime(); }
const schIsToday = ms => msDate(ms)===msDate(nowMs());
const schHourFrac = ms => { const d=new Date(ms); return d.getHours()+d.getMinutes()/60; };

/* ---- the ONE event list: every schedule block on a visible ticket ----
   flattened from scoped() (respects the same visibility the queue uses),
   normalized to ms, blocks with no/invalid end default to a 1-hour span so
   they still draw, then filtered by the tech multi-select. */
function schedEvents(){
  const s = sched(), techSel = s.tech.map(String), out = [];
  scoped().forEach(t=>{
    (t.schedules||[]).forEach(b=>{
      const start = schedMs(b.startsAt);
      if(start==null || isNaN(start)) return;
      let end = schedMs(b.endsAt);
      if(end==null || isNaN(end) || end<=start) end = start + H;   /* draw a 1h block when open-ended */
      if(techSel.length && !techSel.includes(String(b.agentId))) return;
      out.push({ id:b.id, ticketId:t.id, agentId:b.agentId, start, end,
                 open:!(schedMs(b.endsAt)>start), note:b.note||'',
                 completed:b.completedAt!=null, completedBy:b.completedBy||null,
                 title:(TITLES[t.id]||firstLine(t)||''), clientId:t.clientId });
    });
  });
  return out;
}
/* events whose START day is a given day (month cells + counts key off start) */
const schedOnDay = (evts, dayStart) => evts.filter(e=>schStartOfDay(e.start)===dayStart)
                                          .sort((a,b)=>a.start-b.start || a.end-b.end);

/* ---- per-tech color: evenly-spaced hues by the agent's index in AGENTS, so
   distinct techs stay visually distinct. Soft wash fill + a saturated accent
   bar + dark ink, all one hue. ---- */
function schedHue(id){ const i=AGENTS.findIndex(a=>a.id===id), n=Math.max(1,AGENTS.length); return Math.round((i<0?0:i)*360/n); }
function schedEvStyle(id){ const h=schedHue(id); return `background:hsl(${h},58%,95%);border-left:3px solid hsl(${h},46%,44%);color:hsl(${h},44%,26%)`; }
function schedSwatch(id){ const h=schedHue(id); return `background:hsl(${h},46%,44%)`; }

/* ---- time-grid geometry (shared by day + week) ----
   Clip an event to one day, so a block that crosses midnight draws a segment on
   each day it touches. */
function schedDaySegs(dayStart, evts){
  const dayEnd = dayStart + 24*H, segs = [];
  evts.forEach(e=>{
    if(e.end<=dayStart || e.start>=dayEnd) return;
    segs.push(Object.assign({}, e, { segStart:Math.max(e.start,dayStart), segEnd:Math.min(e.end,dayEnd) }));
  });
  return segs;
}
/* greedy interval-graph column packing: overlapping segments in a day sit
   side by side; each gets a column index (_col) and its cluster's width (_cols) */
function schedPack(segs){
  const items = segs.slice().sort((a,b)=>a.segStart-b.segStart || a.segEnd-b.segEnd);
  let cluster=[], clusterEnd=-Infinity;
  const flush = () => {
    const colEnds=[];
    cluster.forEach(ev=>{
      let placed=false;
      for(let c=0;c<colEnds.length;c++){ if(ev.segStart>=colEnds[c]){ ev._col=c; colEnds[c]=ev.segEnd; placed=true; break; } }
      if(!placed){ ev._col=colEnds.length; colEnds.push(ev.segEnd); }
    });
    cluster.forEach(ev=>ev._cols=colEnds.length);
  };
  items.forEach(ev=>{
    if(cluster.length && ev.segStart>=clusterEnd){ flush(); cluster=[]; clusterEnd=-Infinity; }
    cluster.push(ev); clusterEnd=Math.max(clusterEnd, ev.segEnd);
  });
  if(cluster.length) flush();
  return items;
}
/* the [lo,hi] hour window the grid spans: tight to the day's events, widened to
   a sane default (7–19) and a floor span, clamped to 0–24. days = the visible
   day-starts (1 for day mode, 7 for week). */
function schedWindow(days, evts){
  let lo=null, hi=null;
  days.forEach(ds=>schedDaySegs(ds,evts).forEach(sg=>{
    const a=(sg.segStart-ds)/H, b=(sg.segEnd-ds)/H;
    lo = lo==null? a : Math.min(lo,a);
    hi = hi==null? b : Math.max(hi,b);
  }));
  if(lo==null){ lo=7; hi=19; }                       /* no events → business-ish default */
  lo=Math.floor(lo); hi=Math.ceil(hi);
  if(hi-lo < SCH_MIN_SPAN) hi = lo + SCH_MIN_SPAN;
  lo=Math.max(0,lo); hi=Math.min(24,Math.max(hi,lo+SCH_MIN_SPAN));
  return { lo, hi };
}
const schFmtHour = h => { const hr = h%24, am = hr<12; const hh = hr%12===0?12:hr%12; return hh+(am?' AM':' PM'); };

/* one day's column body: absolutely-positioned blocks + optional now-line */
function schedColBody(dayStart, evts, win){
  const packed = schedPack(schedDaySegs(dayStart, evts));
  const blocks = packed.map(sg=>{
    const top = ((sg.segStart-dayStart)/H - win.lo)*HP;
    const hgt = Math.max(20, ((sg.segEnd-sg.segStart)/H)*HP - 2);
    const w = 100/sg._cols, left = sg._col*w;
    const nm = agent(sg.agentId)?.name || 'Unassigned tech';
    const rng = msTime(sg.start) + (sg.open ? '' : '–'+msTime(sg.end));
    const tip = `${nm} · #${sg.ticketId} ${sg.title}\n${rng}${sg.completed?'\n✓ Completed'+(sg.completedBy?' by '+sg.completedBy:''):''}${sg.note? '\n'+sg.note : ''}`;
    return `<div class="sch-ev${sg.completed?' sch-done':''}" style="top:${top}px;height:${hgt}px;left:calc(${left}% + 1px);width:calc(${w}% - 3px);${schedEvStyle(sg.agentId)}"
        onclick="openTicket(${sg.ticketId})" title="${esc(tip)}">
      <div class="sch-ev-nm">${esc(nm)}</div>
      <div class="sch-ev-mt">${esc(rng)} · #${sg.ticketId}</div>
      <div class="sch-ev-ti">${esc(sg.title)}</div>
    </div>`;
  }).join('');
  let nowLine='';
  if(nowMs()>=dayStart && nowMs()<dayStart+24*H){
    const top=(schHourFrac(nowMs())-win.lo)*HP;
    if(top>=0 && top<=(win.hi-win.lo)*HP) nowLine=`<div class="sch-now" style="top:${top}px"></div>`;
  }
  return `<div class="sch-col" style="height:${(win.hi-win.lo)*HP}px">${blocks}${nowLine}</div>`;
}
/* the shared hour axis down the left of a day/week grid */
function schedAxis(win){
  let rows='';
  for(let h=win.lo; h<win.hi; h++) rows+=`<div class="sch-hr" style="height:${HP}px"><span>${schFmtHour(h)}</span></div>`;
  return `<div class="sch-axis" style="height:${(win.hi-win.lo)*HP}px">${rows}</div>`;
}

/* ---- Day / Week / Month renderers ---- */
function schedDayGrid(evts){
  const dayStart = schStartOfDay(sched().anchor);
  const win = schedWindow([dayStart], evts);
  return `<div class="sch-grid">
    ${schedAxis(win)}
    <div class="sch-cols">
      <div class="sch-daycol">
        <div class="sch-dayhead ${schIsToday(dayStart)?'is-today':''}">
          <span class="sch-dow">${new Date(dayStart).toLocaleDateString('en-US',{weekday:'long'})}</span>
          <span class="sch-dnum">${new Date(dayStart).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
        </div>
        ${schedColBody(dayStart, evts, win)}
      </div>
    </div>
  </div>`;
}
function schedWeekGrid(evts){
  const weekStart = schStartOfWeek(sched().anchor);
  const days = Array.from({length:7}, (_,i)=>schAddDays(weekStart,i));
  const win = schedWindow(days, evts);
  return `<div class="sch-grid">
    ${schedAxis(win)}
    <div class="sch-cols">
      ${days.map(ds=>`<div class="sch-daycol">
        <div class="sch-dayhead ${schIsToday(ds)?'is-today':''}">
          <span class="sch-dow">${new Date(ds).toLocaleDateString('en-US',{weekday:'short'})}</span>
          <span class="sch-dnum">${new Date(ds).getDate()}</span>
        </div>
        ${schedColBody(ds, evts, win)}
      </div>`).join('')}
    </div>
  </div>`;
}
function schedMonthGrid(evts){
  const mStart = schStartOfMonth(sched().anchor);
  const gridStart = schStartOfWeek(mStart);
  const daysInMonth = new Date(new Date(mStart).getFullYear(), new Date(mStart).getMonth()+1, 0).getDate();
  const weeks = Math.ceil((new Date(mStart).getDay() + daysInMonth)/7);   /* 4–6 rows, only what the month needs */
  const thisMonth = new Date(mStart).getMonth();
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let cells='';
  for(let i=0;i<weeks*7;i++){
    const ds = schAddDays(gridStart,i);
    const day = schedOnDay(evts, ds);
    const shown = day.slice(0,3);
    const chips = shown.map(e=>{
      const nm = (agent(e.agentId)?.name||'?').split(' ')[0];
      return `<div class="sch-chip${e.completed?' sch-done':''}" style="${schedEvStyle(e.agentId)}" onclick="openTicket(${e.ticketId})"
          title="${esc((agent(e.agentId)?.name||'?')+' · #'+e.ticketId+' '+e.title+(e.completed?' · ✓ Completed'+(e.completedBy?' by '+e.completedBy:''):''))}">
        <span class="sch-chip-t">${msTime(e.start)}</span> ${esc(nm)}</div>`;
    }).join('');
    const more = day.length>shown.length ? `<div class="sch-more">+${day.length-shown.length} more</div>` : '';
    cells += `<div class="sch-mcell ${new Date(ds).getMonth()===thisMonth?'':'off'} ${schIsToday(ds)?'is-today':''}">
      <div class="sch-mnum">${new Date(ds).getDate()}</div>${chips}${more}</div>`;
  }
  return `<div class="sch-month">
    <div class="sch-mdow">${dow.map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="sch-mgrid" style="grid-template-rows:repeat(${weeks},minmax(92px,1fr))">${cells}</div>
  </div>`;
}

/* ---- the period label in the toolbar ---- */
function schedLabel(){
  const s = sched();
  if(s.mode==='day') return new Date(schStartOfDay(s.anchor)).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  if(s.mode==='month') return new Date(schStartOfMonth(s.anchor)).toLocaleDateString('en-US',{month:'long',year:'numeric'});
  /* build the week range by hand — a partial {day,year} option combo formats
     unreliably across engines, so compose from whole fields instead */
  const sd=new Date(schStartOfWeek(s.anchor)), ed=new Date(schAddDays(schStartOfWeek(s.anchor),6));
  const mo = d => d.toLocaleDateString('en-US',{month:'short'});
  const sameMonth = sd.getMonth()===ed.getMonth() && sd.getFullYear()===ed.getFullYear();
  return `${mo(sd)} ${sd.getDate()} – ${sameMonth?'':mo(ed)+' '}${ed.getDate()}, ${ed.getFullYear()}`;
}

function viewSchedule(){
  const s = sched();
  const all = schedEvents();
  /* count only the events inside the focused period, so the pip matches what's drawn */
  let periodStart, periodEnd;
  if(s.mode==='day'){ periodStart=schStartOfDay(s.anchor); periodEnd=periodStart+24*H; }
  else if(s.mode==='week'){ periodStart=schStartOfWeek(s.anchor); periodEnd=schAddDays(periodStart,7); }
  else { periodStart=schStartOfWeek(schStartOfMonth(s.anchor)); const mS=schStartOfMonth(s.anchor);
         const dim=new Date(new Date(mS).getFullYear(), new Date(mS).getMonth()+1,0).getDate();
         periodEnd=schAddDays(periodStart, Math.ceil((new Date(mS).getDay()+dim)/7)*7); }
  const inPeriod = all.filter(e=>e.start<periodEnd && e.end>periodStart);

  /* tech filter options: active agents, plus any archived agent still carrying
     a block (so filtering by them stays possible — mirrors the row-37 rule) */
  const present = new Set(all.map(e=>String(e.agentId)));
  const techOpts = AGENTS.filter(a=>!isArch(a) || present.has(String(a.id)))
    .map(a=>({ v:String(a.id), label:a.name, archived:isArch(a) }));
  const techsHere = [...new Set(inPeriod.map(e=>String(e.agentId)))]
    .map(id=>AGENTS.find(a=>String(a.id)===id)).filter(Boolean);

  const grid = s.mode==='day' ? schedDayGrid(all)
             : s.mode==='week' ? schedWeekGrid(all)
             : schedMonthGrid(all);

  return `
  <div class="toolbar">
    <div class="seg">${SCHED_MODES.map(m=>`<button class="${s.mode===m.id?'on':''}" onclick="setSchedMode('${m.id}')">${m.label}</button>`).join('')}</div>
    <div class="sch-nav">
      <button class="rowbtn" onclick="schedStep(-1)" title="Previous">‹</button>
      <button class="rowbtn" onclick="schedToday()" title="Jump to today">Today</button>
      <button class="rowbtn" onclick="schedStep(1)" title="Next">›</button>
    </div>
    <div class="sch-title">${esc(schedLabel())}</div>
    <span class="sch-count">${inPeriod.length} scheduled block${inPeriod.length===1?'':'s'}</span>
    <div class="spacer"></div>
    <div style="min-width:200px">${multiCombo('schTech', techOpts, s.tech, 'setSchedTech', 'All techs')}</div>
  </div>
  ${techsHere.length? `<div class="sch-legend">${techsHere
      .sort((a,b)=>a.name.localeCompare(b.name))
      .map(a=>`<span class="sch-leg"><span class="sch-dot" style="${schedSwatch(a.id)}"></span>${esc(a.name)}</span>`).join('')}</div>` : ''}
  ${inPeriod.length===0
    ? `<div class="empty">${icon(IC.calendar)}<div>No techs scheduled ${s.mode==='day'?'this day':'this '+s.mode}.</div>
        <div class="mini muted" style="margin-top:4px">Schedule blocks are added on a ticket's case file — open a ticket and use the <b>Schedules</b> panel.</div></div>`
    : `<div class="card card-pad" style="overflow:auto">${grid}</div>`}
  `;
}
