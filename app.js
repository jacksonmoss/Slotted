import * as E from './engine.js';

/* ================================================================ setup */

const STORE_KEY = 'slotted:v1';
const HORIZON = 14;
const MAX_COLORED = 7;

const ICON = {
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.9v.2"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = document) => root.querySelector(sel);

function defaultState() {
  return {
    version: 1,
    tasks: [],
    categories: ['Work', 'School', 'Home', 'Errands', 'Fitness', 'Personal'].map((name, i) => ({ name, slot: i + 1 })),
    boxes: [
      { id: uid(), name: 'Weeknights', days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00', categories: [] },
      { id: uid(), name: 'Weekend mornings', days: [0, 6], start: '08:00', end: '12:00', categories: [] },
    ],
    skips: {},
  };
}

function migrate(s) {
  const d = defaultState();
  return {
    ...d,
    ...s,
    tasks: Array.isArray(s.tasks) ? s.tasks : [],
    categories: Array.isArray(s.categories) ? s.categories : d.categories,
    boxes: Array.isArray(s.boxes) ? s.boxes : d.boxes,
    skips: s.skips || {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {
    /* fall through to a fresh state */
  }
  return defaultState();
}

let state = load();
let P = null; // current plan
let undoSnapshot = null;
const ui = { view: 'plan', filter: 'next', sheet: null, toast: null, toastTimer: null };

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    showToast("Couldn't save to this device. Export a backup from Setup.");
  }
}

function commit(mutate, { undo = false } = {}) {
  if (undo) undoSnapshot = JSON.stringify(state);
  mutate(state);
  save();
  replan();
  render();
}

function undo() {
  if (!undoSnapshot) return;
  state = migrate(JSON.parse(undoSnapshot));
  undoSnapshot = null;
  save();
  replan();
  render();
  hideToast();
}

function replan() {
  const now = new Date();
  const today = E.dayKey(now);
  for (const k of Object.keys(state.skips)) if (k < today) delete state.skips[k];
  const factors = E.estimateFactors(state.tasks);
  P = { ...E.plan({ tasks: state.tasks, boxes: state.boxes, skips: state.skips, now, horizon: HORIZON, factors }), factors, now };
}

/* ================================================================ helpers */

const catNames = () => state.categories.map((c) => c.name);
function catSlot(name) {
  const c = state.categories.find((x) => x.name === name);
  return c ? c.slot || 0 : 0;
}
const catStyle = (name) => `--cat: var(--c${catSlot(name)})`;
const findTask = (id) => state.tasks.find((t) => t.id === id);
const today = () => P.today;
const nowMin = () => P.now.getHours() * 60 + P.now.getMinutes();

function longDay(key) {
  return E.parseDay(key).toLocaleDateString('en-US', { weekday: 'long' });
}
function monthDay(key) {
  return E.parseDay(key).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}
function shortDate(key) {
  return E.parseDay(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function timeLabel(min) {
  return `${E.clockLabel(min)} ${E.ampm(min)}`;
}
function rangeLabel(start, end) {
  const a = E.ampm(start);
  const b = E.ampm(end % 1440);
  const s = E.clockLabel(start);
  const e = end % 1440 === 0 ? '12' : E.clockLabel(end);
  return a === b ? `${s}–${e} ${b}` : `${s} ${a}–${e} ${b}`;
}
function recurLabel(r) {
  if (!r) return '';
  if (r.type === 'daily') return 'Every day';
  if (r.type === 'weekdays') return 'Weekdays';
  if (r.type === 'weekly') return r.day == null || r.day === '' ? 'Once a week' : `Every ${E.WEEKDAYS[r.day]}`;
  return '';
}
const phrase = (key) => E.dayPhrase(key, today());
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function boxSummary() {
  if (!state.boxes.length) return 'none yet';
  return state.boxes
    .map((b) => `${b.name} (${rangeLabel(E.toMin(b.start), b.end === '00:00' ? 1440 : E.toMin(b.end))})`)
    .join(' and ');
}

/** Summary of the next occurrence of a task in the plan (for one-offs, the task itself). */
function nextSummary(task) {
  if (!task.recur) return P.byTask[task.id] || null;
  return (
    P.items
      .filter((s) => s.taskId === task.id && s.startDay)
      .sort((a, b) => a.startDay.localeCompare(b.startDay) || a.startMin - b.startMin)[0] || null
  );
}

function doneTodayKey(task) {
  const occ = E.currentOccurrence(task, today());
  return occ && task.history?.[occ.key] ? occ.key : null;
}

/* ================================================================ render */

function render() {
  document.body.classList.toggle('no-qa', !['plan', 'tasks'].includes(ui.view));
  for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
    if (b.dataset.tab === ui.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const views = { plan: renderPlan, tasks: renderTasks, progress: renderProgress, setup: renderSetup };
  $('#view').innerHTML = views[ui.view]();
  renderSheet();
}

/* ---------------------------------------------------------------- plan */

function renderPlan() {
  const t = today();
  let h = `<header class="dayhead"><h1 class="dayname">${longDay(t)}</h1><p class="daydate">${monthDay(t)}</p>`;
  if (P.atRisk.length) h += `<a class="riskchip" href="#risk">${ICON.warn}${P.atRisk.length} at risk</a>`;
  h += '</header>';

  if (!state.tasks.length) h += renderWelcome();

  const day0 = P.days[0];
  const firstSlot = day0.slots.find((s) => s.blocks.length);
  const nextItemId = firstSlot?.blocks[0]?.itemId;
  if (day0.slots.length) h += day0.slots.map((s) => renderBox(s, nextItemId)).join('');
  else h += `<div class="box emptybox">${emptyToday()}</div>`;

  const skipped = (state.skips[t] || []).map((id) => state.boxes.find((b) => b.id === id)).filter(Boolean);
  if (skipped.length) {
    h += `<div class="skipped">${skipped
      .map((b) => `<span>Skipping ${esc(b.name)} today</span><button class="textbtn accent" data-action="unskip" data-box="${b.id}">Restore</button>`)
      .join('')}</div>`;
  }

  h += renderDoneToday();

  if (P.atRisk.length) {
    h += `<h2 class="section" id="risk">At risk <span class="count">${P.atRisk.length}</span></h2><div class="risklist">`;
    h += P.atRisk
      .map(
        (s) => `<button class="riskitem" data-action="open" data-task="${s.taskId}">${ICON.warn}<strong>${esc(s.title)}</strong><span>${esc(
          E.explain(s, t)
        )}</span></button>`
      )
      .join('');
    h += '</div>';
  }

  if (P.unscheduled.length) {
    h += `<h2 class="section">Doesn't fit yet <span class="count">${P.unscheduled.length}</span></h2><div class="tlist">`;
    h += P.unscheduled
      .map(
        (s) => `<button class="trow" style="${catStyle(s.category)}" data-action="open" data-task="${s.taskId}">
          <span class="ttl">${esc(s.title)}</span><span class="meta"><span>${esc(E.explain(s, t))}</span></span></button>`
      )
      .join('');
    h += '</div>';
  }

  h += renderUpcoming();
  return h;
}

function renderWelcome() {
  return `<section class="welcome">
    <h2>Add what's on your plate</h2>
    <p>Slotted fits your tasks into your time boxes, most urgent first. Your boxes are ${esc(boxSummary())}. Change them in Setup.</p>
    <p>Type in the bar below. You can add a length, a due date or a repeat right in the text:</p>
    <div class="chips">
      <button class="example" data-action="example" data-text="Read chapter 4 45m by thu">Read chapter 4 45m by thu</button>
      <button class="example" data-action="example" data-text="Long run 1h30 every sat">Long run 1h30 every sat</button>
      <button class="example" data-action="example" data-text="Pick up prescription tomorrow">Pick up prescription tomorrow</button>
    </div>
  </section>`;
}

function emptyToday() {
  if (!state.boxes.length) {
    return `<p style="margin:0">You don't have any time boxes yet. Tasks are planned only inside them.</p>
      <div class="boxtools" style="justify-content:flex-start"><button class="btn" data-action="tab" data-tab="setup">Set up time boxes</button></div>`;
  }
  const next = P.days.slice(1).find((d) => d.slots.length);
  const nextText = next
    ? ` Next up: ${esc(next.slots[0].boxName)}, ${esc(phrase(next.day))} ${esc(rangeLabel(next.slots[0].start, next.slots[0].end))}.`
    : '';
  return `<p style="margin:0">No more time boxes today.${nextText}</p>`;
}

function renderBox(slot, nextItemId) {
  const past = slot.start - slot.fullStart;
  const open = slot.end - slot.start - slot.used;
  const segs = [];
  if (past > 0) segs.push(`<i class="past" style="flex:${past}"></i>`);
  for (const b of slot.blocks) segs.push(`<i class="seg" style="flex:${b.end - b.start};${catStyle(b.category)}"></i>`);
  if (open > 0) segs.push(`<i class="open" style="flex:${open}"></i>`);
  const label = `${E.durLabel(slot.used)} planned, ${E.durLabel(open)} open`;

  return `<section class="box" aria-label="${esc(slot.boxName)}, ${esc(rangeLabel(slot.fullStart, slot.end))}">
    <div class="boxhead">
      <h2 class="boxname">${esc(slot.boxName)}</h2>
      <span class="boxtime">${esc(rangeLabel(slot.fullStart, slot.end))}</span>
      <span class="boxfree ${open ? '' : 'full'}">${open ? `${E.durLabel(open)} open` : 'Full'}</span>
    </div>
    <div class="gauge" role="img" aria-label="${esc(label)}">${segs.join('')}</div>
    ${
      slot.blocks.length
        ? `<div class="slabs">${slot.blocks.map((b) => renderSlab(b, b.itemId === nextItemId)).join('')}</div>`
        : '<p class="emptybox" style="padding:4px 4px 2px;margin:0">Nothing planned here.</p>'
    }
    <div class="boxtools"><button class="textbtn" data-action="skip" data-box="${slot.boxId}">Skip today</button></div>
  </section>`;
}

function renderSlab(b, isNext) {
  const task = findTask(b.taskId);
  const s = P.byTask[b.taskId];
  const meta = [`<span class="num">${E.durLabel(b.end - b.start)}</span>`];
  if (b.parts > 1) meta.push(`<span>Part ${b.part} of ${b.parts}</span>`);
  if (b.recurring) meta.push(`<span>${recurLabel(task?.recur)}</span>`);
  else if (task?.deadline) {
    meta.push(
      s?.late
        ? `<span class="risk">Due ${esc(phrase(task.deadline))}, at risk</span>`
        : `<span class="due">Due ${esc(phrase(task.deadline))}</span>`
    );
  }
  if (b.category) meta.push(`<span class="catlabel">${esc(b.category)}</span>`);
  const key = b.key ? ` data-key="${esc(b.key)}"` : '';
  return `<div class="slab ${isNext ? 'is-next' : ''}" style="--mins:${b.end - b.start};${catStyle(b.category)}">
    <div class="slab-time" aria-hidden="true"><span class="t">${E.clockLabel(b.start)}</span><span class="ap">${E.ampm(b.start)}</span></div>
    <button class="slab-main" data-action="open" data-task="${b.taskId}" aria-label="${esc(b.title)} at ${timeLabel(b.start)}, ${E.durLabel(b.end - b.start)}">
      ${isNext ? '<span class="upnext">Up next</span>' : ''}
      <span class="slab-title">${esc(b.title)}</span>
      <span class="slab-meta">${meta.join('')}</span>
    </button>
    <button class="check" data-action="complete" data-task="${b.taskId}"${key} aria-label="Mark ${esc(b.title)} done"></button>
  </div>`;
}

function renderDoneToday() {
  const t = today();
  const rows = [];
  for (const task of state.tasks) {
    if (!task.recur && task.done && task.doneAt && E.dayKey(new Date(task.doneAt)) === t) {
      rows.push({ task, key: '', min: task.actualMin });
    }
    if (task.recur) {
      for (const [key, h] of Object.entries(task.history || {})) {
        if (h.doneAt && E.dayKey(new Date(h.doneAt)) === t) rows.push({ task, key, min: h.actualMin });
      }
    }
  }
  if (!rows.length) return '';
  return `<h2 class="section">Done today <span class="count">${rows.length}</span></h2><div class="tlist">${rows
    .map(
      ({ task, key, min }) => `<div class="trow done" style="${catStyle(task.category)}">
        <span class="ttl">${esc(task.title)}</span>
        <span class="meta">${min ? `<span>Took ${E.durLabel(min)}</span>` : ''}${task.category ? `<span class="catlabel">${esc(task.category)}</span>` : ''}</span>
        <span class="plan"><button class="textbtn accent" data-action="undone" data-task="${task.id}" data-key="${esc(key)}">Restore</button></span>
      </div>`
    )
    .join('')}</div>`;
}

function renderUpcoming() {
  const days = P.days.slice(1, 7);
  if (!days.some((d) => d.slots.some((s) => s.blocks.length))) return '';
  let h = '<h2 class="section">Coming up</h2><div class="upcoming">';
  for (const d of days) {
    const used = d.slots.reduce((s, x) => s + x.used, 0);
    const cap = d.slots.reduce((s, x) => s + (x.end - x.start), 0);
    h += `<div class="uday"><div class="udayhead"><span class="udayname">${esc(capitalize(phrase(d.day)) === 'Tomorrow' ? 'Tomorrow' : longDay(d.day))}</span>
      <span class="udaydate">${esc(shortDate(d.day))}</span>
      <span class="udayload">${cap ? `${E.durLabel(used)} of ${E.durLabel(cap)}` : 'No boxes'}</span></div>`;
    const withBlocks = d.slots.filter((s) => s.blocks.length);
    if (!withBlocks.length && cap) h += '<p class="note small" style="margin:0">Nothing planned yet.</p>';
    for (const s of withBlocks) {
      if (d.slots.length > 1) h += `<div class="ubox">${esc(s.boxName)}</div>`;
      h += s.blocks
        .map(
          (b) => `<button class="urow" style="${catStyle(b.category)}" data-action="open" data-task="${b.taskId}">
            <span class="t">${timeLabel(b.start)}</span><span class="ttl"><span>${esc(b.title)}</span></span><span class="d">${E.durLabel(b.end - b.start)}</span></button>`
        )
        .join('');
    }
    h += '</div>';
  }
  return `${h}</div>`;
}

/* ---------------------------------------------------------------- tasks */

function renderTasks() {
  const open = state.tasks.filter((t) => !t.recur && !t.done && !t.archived);
  const recurring = state.tasks.filter((t) => t.recur && !t.archived);
  const done = state.tasks.filter((t) => !t.recur && t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  const seg = (v, label, n) => `<button data-action="filter" data-value="${v}" aria-pressed="${ui.filter === v}">${label}${n != null ? ` <span class="muted">${n}</span>` : ''}</button>`;
  let h = `<h1 class="viewtitle">Tasks</h1><div class="segmented" role="group" aria-label="Show">${seg('next', 'Up next', open.length)}${seg(
    'repeat',
    'Repeating',
    recurring.length
  )}${seg('done', 'Done', null)}</div>`;

  const guessed = state.tasks.some((x) => !x.done && (x.guessed?.category || x.guessed?.duration));
  if (guessed && ui.filter !== 'done') h += '<p class="legend-note">Dotted underlines are guesses. Open a task to confirm or change them.</p>';
  if (ui.filter === 'next') {
    const order = (t) => {
      const s = P.byTask[t.id];
      if (!s || !s.startDay) return `z${t.deadline || '9999'}`;
      return `${s.startDay}${String(s.startMin).padStart(4, '0')}`;
    };
    const rows = open.sort((a, b) => order(a).localeCompare(order(b)));
    h += rows.length
      ? `<div class="tlist">${rows.map(renderTaskRow).join('')}</div>`
      : '<div class="tlist"><p class="empty">No open tasks. Add one below.</p></div>';
  } else if (ui.filter === 'repeat') {
    h += recurring.length
      ? `<div class="tlist">${recurring.map(renderRepeatRow).join('')}</div>`
      : '<div class="tlist"><p class="empty">No repeating tasks. Type something like "Stretch 15m daily" below.</p></div>';
  } else {
    h += done.length
      ? `<div class="tlist">${done.slice(0, 50).map(renderDoneRow).join('')}</div>`
      : '<div class="tlist"><p class="empty">Nothing finished yet.</p></div>';
  }
  return h;
}

function categoryMeta(t) {
  if (!t.category) return '<span class="muted">No category</span>';
  const guess = t.guessed?.category ? ' guess' : '';
  return `<span class="catlabel"><span class="${guess.trim()}">${esc(t.category)}</span></span>`;
}

function renderTaskRow(t) {
  const s = P.byTask[t.id];
  const meta = [categoryMeta(t), `<span class="num ${t.guessed?.duration ? 'guess' : ''}">${E.durLabel(E.adjustedDuration(t, P.factors) - (t.progressMin || 0))}</span>`];
  if (t.deadline) meta.push(`<span>Due ${esc(phrase(t.deadline))}</span>`);
  if (t.importance === 3) meta.push('<span>High priority</span>');
  let plan = '';
  if (!s) plan = '';
  else if (s.noBox) plan = '<span class="plan risk">No box<small>Fix category</small></span>';
  else if (s.late || s.impossible) plan = `<span class="plan risk">At risk<small>${esc(s.targetDay ? `Done ${phrase(s.targetDay)}` : 'Not planned')}</small></span>`;
  else if (s.targetDay) {
    const small = s.startDay !== s.targetDay ? `Starts ${phrase(s.startDay)}` : timeLabel(s.startMin);
    plan = `<span class="plan">${esc(capitalize(phrase(s.targetDay)))}<small>${esc(small)}</small></span>`;
  } else plan = '<span class="plan muted">Not planned<small>No room</small></span>';
  return `<button class="trow" style="${catStyle(t.category)}" data-action="open" data-task="${t.id}">
    <span class="ttl">${esc(t.title)}</span><span class="meta">${meta.join('')}</span>${plan}</button>`;
}

function renderRepeatRow(t) {
  const doneKey = doneTodayKey(t);
  const next = nextSummary(t);
  let plan;
  if (doneKey) plan = '<span class="plan">Done<small>today</small></span>';
  else if (next) plan = `<span class="plan">${esc(capitalize(phrase(next.startDay)))}<small>${esc(timeLabel(next.startMin))}</small></span>`;
  else plan = '<span class="plan muted">Not planned<small>No room</small></span>';
  return `<button class="trow" style="${catStyle(t.category)}" data-action="open" data-task="${t.id}">
    <span class="ttl">${esc(t.title)}</span>
    <span class="meta">${categoryMeta(t)}<span>${recurLabel(t.recur)}</span><span class="num">${E.durLabel(t.durationMin)}</span></span>${plan}</button>`;
}

function renderDoneRow(t) {
  const d = t.doneAt ? E.dayKey(new Date(t.doneAt)) : null;
  return `<button class="trow done" style="${catStyle(t.category)}" data-action="open" data-task="${t.id}">
    <span class="ttl">${esc(t.title)}</span>
    <span class="meta">${categoryMeta(t)}${t.actualMin ? `<span>Took ${E.durLabel(t.actualMin)}</span>` : ''}${
      t.estimateAtDone ? `<span>Planned ${E.durLabel(t.estimateAtDone)}</span>` : ''
    }</span>
    <span class="plan">${d ? esc(capitalize(phrase(d))) : ''}</span></button>`;
}

/* ---------------------------------------------------------------- progress */

function renderProgress() {
  const t = today();
  const ws = E.weekStart(t);
  const we = E.addDays(ws, 6);
  const inWeek = (iso) => {
    if (!iso) return false;
    const k = E.dayKey(new Date(iso));
    return k >= ws && k <= we;
  };
  const byCat = {};
  let count = 0;
  let minutes = 0;
  for (const task of state.tasks) {
    const add = (min) => {
      const c = task.category || 'Uncategorized';
      byCat[c] = (byCat[c] || 0) + (min || 0);
      count++;
      minutes += min || 0;
    };
    if (!task.recur && task.done && inWeek(task.doneAt)) add(task.actualMin);
    for (const h of Object.values(task.history || {})) if (inWeek(h.doneAt)) add(h.actualMin);
  }

  let h = `<h1 class="viewtitle">Progress</h1>
    <div class="stats">
      <div class="stat"><b>${count}</b><span>done this week</span></div>
      <div class="stat"><b>${E.durLabel(minutes) || '0m'}</b><span>time logged</span></div>
    </div>`;

  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  h += `<h2 class="section">Time by category <span class="count">${esc(shortDate(ws))}–${esc(shortDate(we))}</span></h2>`;
  if (cats.length && minutes) {
    const max = Math.max(...cats.map((c) => c[1]));
    h += `<div class="bars" role="table" aria-label="Time logged by category this week">${cats
      .map(
        ([c, m]) => `<div class="bar" role="row" style="${catStyle(c)}" title="${esc(c)}: ${E.durLabel(m)}">
          <span class="lbl" role="cell">${esc(c)}</span>
          <span class="track" role="presentation"><span class="fill" style="display:block;width:${(m / max) * 100}%"></span></span>
          <span class="val" role="cell">${E.durLabel(m)}</span></div>`
      )
      .join('')}</div>`;
  } else {
    h += '<div class="panel"><p class="note" style="margin:0">Finish a task and log how long it took to see where your time goes.</p></div>';
  }

  const factors = Object.entries(P.factors).filter(([, f]) => f.n > 0).sort((a, b) => b[1].n - a[1].n);
  h += '<h2 class="section">How long things really take</h2>';
  if (factors.length) {
    h += `<div class="accuracy">${factors
      .map(([c, f]) => {
        const ratio = f.raw;
        let why;
        if (f.n < 3) why = `${f.n} logged. After ${3 - f.n} more, planning adjusts to match.`;
        else if (Math.abs(f.factor - 1) < 0.08) why = `Your estimates are about right (${f.n} logged).`;
        else if (f.factor > 1) why = `Takes longer than you estimate. Planning adds ${Math.round((f.factor - 1) * 100)}% (${f.n} logged).`;
        else why = `Takes less time than you estimate. Planning trims ${Math.round((1 - f.factor) * 100)}% (${f.n} logged).`;
        return `<div class="accrow" style="${catStyle(c)}"><span class="lbl catlabel">${esc(c)}</span><span class="ratio">${ratio.toFixed(1)}×</span><span class="why">${esc(why)}</span></div>`;
      })
      .join('')}</div>`;
  } else {
    h += '<div class="panel"><p class="note" style="margin:0">When you check off a task, say how long it took. After three in a category, planning corrects for how you estimate.</p></div>';
  }

  const habits = state.tasks.filter((x) => x.recur && !x.archived);
  if (habits.length) {
    h += '<h2 class="section">Repeating tasks <span class="count">last 14 days</span></h2>';
    h += habits.map((task) => renderHabit(task, t)).join('');
    h += `<div class="dotkey"><span><i style="background:var(--ink-2)"></i>Done</span><span><i style="box-shadow:inset 0 0 0 1.5px var(--ink-3)"></i>Missed</span><span><i style="background:linear-gradient(var(--ink-3),var(--ink-3)) center/60% 1.5px no-repeat"></i>Skipped</span><span><i style="box-shadow:inset 0 0 0 1.5px var(--accent)"></i>Today</span></div>`;
  }
  return h;
}

function renderHabit(task, t) {
  const created = task.createdAt ? E.dayKey(new Date(task.createdAt)) : '0000';
  const cells = [];
  let done = 0;
  let due = 0;
  const weeklyAny = task.recur.type === 'weekly' && (task.recur.day == null || task.recur.day === '');
  if (weeklyAny) {
    for (let i = 3; i >= 0; i--) {
      const ws = E.weekStart(E.addDays(t, -7 * i));
      const key = `W:${ws}`;
      const we = E.addDays(ws, 6);
      let cls = 'none';
      if (we >= created) {
        if (task.history?.[key]) cls = 'done';
        else if (task.skipped?.[key]) cls = 'skip';
        else if (i === 0) cls = 'today';
        else cls = 'miss';
      }
      if (cls !== 'none' && cls !== 'today') due++;
      if (cls === 'done') done++;
      cells.push(`<i class="${cls}" title="Week of ${esc(shortDate(ws))}"></i>`);
    }
  } else {
    for (let i = 13; i >= 0; i--) {
      const d = E.addDays(t, -i);
      const occ = E.occurrences(task, d, d)[0];
      let cls = 'none';
      if (occ && d >= created) {
        if (task.history?.[occ.key]) cls = 'done';
        else if (task.skipped?.[occ.key]) cls = 'skip';
        else if (i === 0) cls = 'today';
        else cls = 'miss';
      }
      if (cls !== 'none' && cls !== 'today') due++;
      if (cls === 'done') done++;
      cells.push(`<i class="${cls}" title="${esc(shortDate(d))}"></i>`);
    }
  }
  const tally = due ? `${done} of ${due}` : 'Not due yet';
  return `<div class="habit" style="${catStyle(task.category)}"><div class="habithead"><b>${esc(task.title)}</b><span>${tally}</span></div>
    <div class="dots" aria-label="${done} of ${due} done">${cells.join('')}</div></div>`;
}

/* ---------------------------------------------------------------- setup */

function renderSetup() {
  let h = '<h1 class="viewtitle">Setup</h1>';
  h += '<h2 class="section" style="margin-top:8px">Time boxes</h2><p class="note" style="margin:0 0 10px">Tasks are planned only inside these. A box can be limited to certain categories.</p>';
  h += state.boxes.map(renderBoxEditor).join('');
  h += '<button class="btn secondary block" data-action="box-add">Add a time box</button>';

  h += '<h2 class="section">Categories</h2><div class="panel">';
  h += state.categories
    .map(
      (c) => `<div class="catrow" style="--cat: var(--c${c.slot || 0})"><span class="swatch" aria-hidden="true"></span>
        <label class="visually-hidden" for="cat-${esc(c.name)}">Category name</label>
        <input class="input" id="cat-${esc(c.name)}" data-catname="${esc(c.name)}" value="${esc(c.name)}">
        <button class="textbtn danger" data-action="cat-delete" data-value="${esc(c.name)}">Delete</button></div>`
    )
    .join('');
  h += `<form class="catrow" data-form="cat-add" style="--cat: var(--c0)"><span class="swatch" aria-hidden="true" style="opacity:.35"></span>
      <label class="visually-hidden" for="cat-new">New category</label>
      <input class="input" id="cat-new" name="name" placeholder="New category">
      <button class="textbtn accent" type="submit">Add</button></form></div>`;

  h += `<h2 class="section">Backup</h2><div class="panel">
    <p class="note" style="margin:0 0 12px">Your tasks are stored only on this device. Export a backup now and then, and import it to move to a new phone.</p>
    <div class="btnrow"><button class="btn secondary" data-action="export">Export backup</button><button class="btn secondary" data-action="import">Import backup</button></div>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
  </div>`;

  if (!(navigator.standalone || matchMedia('(display-mode: standalone)').matches)) {
    h += `<h2 class="section">Put it on your Home Screen</h2><div class="panel"><p class="note" style="margin:0">In Safari, tap the Share button, then Add to Home Screen. It opens full screen and works offline.</p></div>`;
  }

  h += `<h2 class="section">Erase</h2><div class="panel"><p class="note" style="margin:0 0 12px">Deletes every task, box and category on this device.</p>
    <button class="btn danger block" data-action="erase">Erase all data</button></div>`;
  return h;
}

function renderBoxEditor(b) {
  const days = [0, 1, 2, 3, 4, 5, 6]
    .map(
      (d) => `<button data-action="box-day" data-box="${b.id}" data-day="${d}" aria-pressed="${b.days.includes(d)}" aria-label="${
        ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]
      }">${'SMTWTFS'[d]}</button>`
    )
    .join('');
  const any = !b.categories?.length;
  const cats = state.categories
    .map(
      (c) => `<button class="chip cat" style="--cat: var(--c${c.slot || 0})" data-action="box-cat" data-box="${b.id}" data-value="${esc(c.name)}" aria-pressed="${
        !any && b.categories.includes(c.name)
      }">${esc(c.name)}</button>`
    )
    .join('');
  return `<div class="panel" data-boxid="${b.id}">
    <div class="field"><label class="visually-hidden" for="bn-${b.id}">Box name</label>
      <input class="input boxnameinput" id="bn-${b.id}" data-box="${b.id}" data-bf="name" value="${esc(b.name)}"></div>
    <div class="field"><span class="lbl">Days</span><div class="daypick" role="group" aria-label="Days">${days}</div></div>
    <div class="field"><span class="lbl">Time</span><div class="row">
      <label class="visually-hidden" for="bs-${b.id}">Starts</label><input class="input" type="time" id="bs-${b.id}" data-box="${b.id}" data-bf="start" value="${b.start}">
      <span class="muted">to</span>
      <label class="visually-hidden" for="be-${b.id}">Ends</label><input class="input" type="time" id="be-${b.id}" data-box="${b.id}" data-bf="end" value="${b.end}"></div></div>
    <div class="field"><span class="lbl">Accepts</span><div class="chips">
      <button class="chip" data-action="box-cat" data-box="${b.id}" data-value="" aria-pressed="${any}">Any category</button>${cats}</div></div>
    <div class="boxtools"><button class="textbtn danger" data-action="box-delete" data-box="${b.id}">Delete box</button></div>
  </div>`;
}

/* ================================================================ sheets */

function openSheet(sheet) {
  hideToast();
  ui.sheet = sheet;
  renderSheet();
  requestAnimationFrame(() => {
    const target = $('#sheet-root [data-autofocus]') || $('#sheet-root .sheet');
    target?.focus({ preventScroll: true });
  });
}
function closeSheet() {
  ui.sheet = null;
  renderSheet();
}

function renderSheet() {
  const root = $('#sheet-root');
  const sh = ui.sheet;
  document.body.classList.toggle('sheet-open', !!sh);
  if (!sh) {
    root.innerHTML = '';
    return;
  }
  const body = sh.type === 'task' ? taskSheet(sh) : completeSheet(sh);
  const existing = $('.sheet', root);
  if (existing && existing.dataset.type === sh.type) {
    // Update in place so the slide-up animation doesn't replay and scroll position holds.
    const scroll = $('.sheetbody', existing)?.scrollTop || 0;
    existing.innerHTML = body;
    const sb = $('.sheetbody', existing);
    if (sb) sb.scrollTop = scroll;
    return;
  }
  root.innerHTML = `<div class="backdrop" data-action="sheet-close"></div><div class="sheet" data-type="${sh.type}" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">${body}</div>`;
}

/* ---------------------------------------------------------------- task sheet */

function draftFromTask(t) {
  return {
    title: t.title,
    category: t.category || null,
    durationMin: t.durationMin || 30,
    importance: t.importance || 2,
    deadline: t.deadline || '',
    notBefore: t.notBefore || '',
    recur: t.recur ? { ...t.recur } : null,
    splittable: t.splittable !== false,
    notes: t.notes || '',
  };
}

function draftFromText(text) {
  const p = E.parseQuickAdd(text || '', today());
  const draft = {
    title: p.title,
    category: E.matchCategory(p.categoryTag, catNames()),
    durationMin: p.durationMin || null,
    importance: p.importance || 2,
    deadline: p.deadline || '',
    notBefore: p.notBefore || '',
    recur: p.recur || null,
    splittable: true,
    notes: '',
  };
  const touched = { category: !!draft.category, duration: !!p.durationMin, importance: !!p.importance };
  return { draft, touched, newCategory: p.categoryTag && !draft.category ? capitalize(p.categoryTag) : null };
}

function applySuggestions(sh) {
  const d = sh.draft;
  if (!d.title.trim()) {
    sh.suggestion = null;
    return;
  }
  const s = E.suggest({ title: d.title, tasks: state.tasks, categories: catNames(), excludeId: sh.id });
  sh.suggestion = s;
  if (!sh.touched.category && !sh.newCategory) d.category = s.category;
  if (!sh.touched.duration) d.durationMin = s.durationMin;
  if (!sh.touched.importance) d.importance = s.importance;
}

function openTaskSheet(id) {
  const t = findTask(id);
  if (!t) return;
  openSheet({ type: 'task', id, isNew: false, draft: draftFromTask(t), touched: { category: true, duration: true, importance: true } });
}

function openNewTaskSheet(text) {
  const { draft, touched, newCategory } = draftFromText(text);
  const sh = { type: 'task', id: null, isNew: true, draft, touched, newCategory };
  applySuggestions(sh);
  openSheet(sh);
}

const REGIONS = {
  suggest: (sh) => {
    const s = sh.suggestion;
    if (!sh.isNew || !s) return '';
    const parts = [];
    if (!sh.touched.category && s.category) parts.push(`${s.category} from the title`);
    if (!sh.touched.duration) {
      parts.push(
        s.durationFrom === 'similar' ? `${E.durLabel(s.durationMin)} from similar tasks` : s.durationFrom === 'category' ? `${E.durLabel(s.durationMin)} typical for ${s.category}` : `${E.durLabel(s.durationMin)} default`
      );
    }
    return parts.length ? `<p class="suggested">Suggested: ${esc(parts.join(', '))}. Change anything that's off.</p>` : '';
  },
  category: (sh) => {
    const d = sh.draft;
    const names = [...catNames()];
    if (sh.newCategory && !names.includes(sh.newCategory)) names.push(sh.newCategory);
    return (
      names
        .map(
          (c) => `<button type="button" class="chip cat" style="${catStyle(c)}" data-action="d-cat" data-value="${esc(c)}" aria-pressed="${d.category === c}">${esc(c)}</button>`
        )
        .join('') + `<button type="button" class="chip" data-action="d-cat" data-value="" aria-pressed="${!d.category}">None</button>`
    );
  },
  duration: (sh) => {
    const d = sh.draft;
    const opts = [15, 30, 45, 60, 90, 120, 180];
    const chips = opts
      .map((m) => `<button type="button" class="chip" data-action="d-dur" data-value="${m}" aria-pressed="${d.durationMin === m}">${E.durLabel(m)}</button>`)
      .join('');
    const factor = P.factors[d.category || 'Uncategorized']?.factor || 1;
    const adj = Math.abs(factor - 1) >= 0.08 ? `<p class="suggested">Plans as ${E.durLabel(E.adjustedDuration({ durationMin: d.durationMin, category: d.category }, P.factors))}, based on how long ${esc(d.category || 'uncategorized')} tasks really take.</p>` : '';
    return `<div class="chips">${chips}</div><div class="row" style="margin-top:8px"><div class="stepper">
      <button type="button" data-action="d-step" data-value="-5" aria-label="5 minutes less">−</button>
      <output aria-live="polite">${E.durLabel(d.durationMin)}</output>
      <button type="button" data-action="d-step" data-value="5" aria-label="5 minutes more">+</button></div></div>${adj}`;
  },
  importance: (sh) => {
    const d = sh.draft;
    return [
      [1, 'Low'],
      [2, 'Normal'],
      [3, 'High'],
    ]
      .map(([v, l]) => `<button type="button" data-action="d-imp" data-value="${v}" aria-pressed="${d.importance === v}">${l}</button>`)
      .join('');
  },
};

function region(name, sh, tag = 'div', cls = '') {
  return `<${tag} data-region="${name}" class="${cls}">${REGIONS[name](sh)}</${tag}>`;
}

function refreshRegions(...names) {
  const sh = ui.sheet;
  if (!sh) return;
  const active = document.activeElement;
  const focusSig = active?.dataset?.action ? `[data-action="${active.dataset.action}"][data-value="${active.dataset.value}"]` : null;
  for (const n of names) {
    const el = $(`#sheet-root [data-region="${n}"]`);
    if (el) el.innerHTML = REGIONS[n](sh);
  }
  if (focusSig && !document.activeElement?.isConnected) $(`#sheet-root ${focusSig}`)?.focus({ preventScroll: true });
}

function recurValue(r) {
  if (!r) return '';
  if (r.type === 'weekly') return r.day == null || r.day === '' ? 'weekly' : `weekly-${r.day}`;
  return r.type;
}

function taskSheet(sh) {
  const d = sh.draft;
  const task = sh.id ? findTask(sh.id) : null;
  let explain = '';
  if (task && !task.done) {
    const s = nextSummary(task);
    if (task.recur) {
      const doneKey = doneTodayKey(task);
      explain = doneKey
        ? `<p class="explain">Done for ${task.recur.type === 'weekly' && !task.recur.day && task.recur.day !== 0 ? 'this week' : 'today'}.</p>`
        : s
          ? `<p class="explain">Next: ${esc(phrase(s.startDay))} at ${esc(timeLabel(s.startMin))}.</p>`
          : '<p class="explain risk">No room for the next one in your time boxes.</p>';
    } else if (s) {
      const txt = E.explain(s, today());
      if (txt) explain = `<p class="explain ${s.late || s.noBox || s.impossible ? 'risk' : ''}">${esc(txt)}</p>`;
    }
  } else if (task?.done) {
    explain = `<p class="explain">Done ${esc(phrase(E.dayKey(new Date(task.doneAt))))}${task.actualMin ? `, took ${E.durLabel(task.actualMin)}` : ''}.</p>`;
  }

  const repeatOpts = [
    ['', "Doesn't repeat"],
    ['daily', 'Every day'],
    ['weekdays', 'Weekdays'],
    ['weekly', 'Once a week, any day'],
    ...[1, 2, 3, 4, 5, 6, 0].map((i) => [`weekly-${i}`, `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}`]),
  ];
  const rv = recurValue(d.recur);

  const foot = [];
  if (!sh.isNew) foot.push(`<button type="button" class="btn danger" data-action="sheet-delete">Delete</button>`);
  if (task?.done) foot.push(`<button type="button" class="btn secondary" data-action="undone" data-task="${task.id}" data-key="">Mark not done</button>`);
  foot.push(`<button type="button" class="btn" data-action="sheet-save">${sh.isNew ? 'Add task' : 'Save'}</button>`);

  return `<div class="sheethead"><h2 id="sheet-title">${sh.isNew ? 'New task' : 'Edit task'}</h2>
      <button type="button" class="textbtn" data-action="sheet-close">Cancel</button></div>
    <div class="sheetbody">
      <label class="visually-hidden" for="d-title">Title</label>
      <input id="d-title" class="titleinput" data-df="title" value="${esc(d.title)}" placeholder="What needs doing?" ${sh.isNew ? 'data-autofocus' : ''} autocapitalize="sentences" enterkeyhint="done">
      ${region('suggest', sh)}
      ${explain}
      <div class="field" style="margin-top:16px"><span class="lbl">Category</span>${region('category', sh, 'div', 'chips')}</div>
      <div class="field"><span class="lbl">How long</span>${region('duration', sh)}</div>
      <div class="field"><span class="lbl">Priority</span>${region('importance', sh, 'div', 'segmented')}</div>
      <div class="field"><label for="d-deadline">Due</label><div class="dateline">
        <input id="d-deadline" class="input" type="date" data-df="deadline" value="${esc(d.deadline)}">
        ${d.deadline ? '<button type="button" class="textbtn" data-action="d-clear" data-value="deadline">Clear</button>' : ''}</div></div>
      <div class="field"><label for="d-notbefore">Don't start before</label><div class="dateline">
        <input id="d-notbefore" class="input" type="date" data-df="notBefore" value="${esc(d.notBefore)}">
        ${d.notBefore ? '<button type="button" class="textbtn" data-action="d-clear" data-value="notBefore">Clear</button>' : ''}</div></div>
      <div class="field"><label for="d-recur">Repeat</label>
        <select id="d-recur" class="input select" data-df="recur">${repeatOpts.map(([v, l]) => `<option value="${v}" ${v === rv ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label class="toggle" for="d-split"><span>Can be split across boxes</span>
        <input id="d-split" type="checkbox" data-df="splittable" ${d.splittable ? 'checked' : ''}></label></div>
      <div class="field"><label for="d-notes">Notes</label><textarea id="d-notes" class="input" data-df="notes">${esc(d.notes)}</textarea></div>
    </div>
    <div class="sheetfoot">${foot.join('')}</div>`;
}

function saveTaskSheet() {
  const sh = ui.sheet;
  const d = sh.draft;
  const title = d.title.trim();
  if (!title) {
    $('#d-title')?.focus();
    showToast('Add a title first.');
    return;
  }
  const fields = {
    title,
    category: d.category || null,
    durationMin: d.durationMin || 30,
    importance: d.importance || 2,
    deadline: d.deadline || null,
    notBefore: d.notBefore || null,
    recur: d.recur,
    splittable: d.splittable,
    notes: d.notes || '',
    guessed: { category: false, duration: false, importance: false },
  };
  let id = sh.id;
  commit((s) => {
    if (fields.category && !s.categories.some((c) => c.name === fields.category)) addCategoryTo(s, fields.category);
    if (sh.isNew) {
      id = uid();
      s.tasks.push({ id, createdAt: new Date().toISOString(), done: false, progressMin: 0, history: {}, skipped: {}, ...fields });
    } else {
      const t = s.tasks.find((x) => x.id === id);
      const wasRecurring = !!t.recur;
      Object.assign(t, fields);
      if (!wasRecurring && t.recur) {
        t.history ||= {};
        t.skipped ||= {};
      }
    }
  });
  closeSheet();
  showToast(placementMessage(id, sh.isNew ? 'Added' : 'Saved'));
}

function placementMessage(id, verb) {
  const t = findTask(id);
  if (!t) return verb;
  if (t.recur) {
    const s = nextSummary(t);
    return s ? `${verb}. ${recurLabel(t.recur)}, next ${phrase(s.startDay)} at ${timeLabel(s.startMin)}.` : `${verb}. No room for it in your boxes yet.`;
  }
  const s = P.byTask[id];
  if (!s) return verb;
  if (s.noBox) return `${verb}. No time box accepts ${t.category || 'uncategorized'} tasks.`;
  if (s.late || s.impossible) return `${verb}. At risk: it won't finish before it's due.`;
  if (s.startDay) return `${verb}. Planned for ${phrase(s.startDay)} at ${timeLabel(s.startMin)}.`;
  return `${verb}. It doesn't fit in the next two weeks.`;
}

/* ---------------------------------------------------------------- complete sheet */

const CHOICES = [
  ['faster', 'Faster', 0.5],
  ['right', 'About right', 1],
  ['longer', 'Longer', 1.5],
  ['muchlonger', 'Much longer', 2],
];

function planned(sh) {
  const t = findTask(sh.taskId);
  const est = t.durationMin || 30;
  return sh.key ? est : Math.max(5, est - (t.progressMin || 0));
}

function chosenMinutes(sh) {
  if (sh.custom) return Math.max(1, Math.round(Number(sh.custom)));
  const r = CHOICES.find((c) => c[0] === sh.choice)?.[2] || 1;
  return Math.max(5, Math.round((planned(sh) * r) / 5) * 5);
}

function completeSheet(sh) {
  const t = findTask(sh.taskId);
  const base = planned(sh);
  const choices = CHOICES.map(
    ([v, l, r]) => `<button type="button" class="choice" data-action="c-choice" data-value="${v}" aria-pressed="${!sh.custom && sh.choice === v}">
      <b>${l}</b><span>${E.durLabel(Math.max(5, Math.round((base * r) / 5) * 5))}</span></button>`
  ).join('');
  const canProgress = !sh.key;
  return `<div class="sheethead"><h2 id="sheet-title">${sh.progress ? 'Log time worked' : 'How long did it take?'}</h2>
      <button type="button" class="textbtn" data-action="sheet-close">Cancel</button></div>
    <div class="sheetbody">
      <p class="note" style="margin:0 0 12px"><b>${esc(t.title)}</b>, planned for ${E.durLabel(base)}. This teaches Slotted how long your ${esc(t.category || 'uncategorized')} tasks really take.</p>
      <div class="choices" role="group" aria-label="Time taken">${choices}</div>
      <div class="field"><label for="c-custom">Or enter minutes</label>
        <input id="c-custom" class="input" type="number" inputmode="numeric" min="1" max="1440" data-cf="custom" value="${esc(sh.custom || '')}" placeholder="${base}"></div>
      ${
        canProgress
          ? `<div class="field"><label class="toggle" for="c-progress"><span>Not finished, just log the time</span>
              <input id="c-progress" type="checkbox" data-cf="progress" ${sh.progress ? 'checked' : ''}></label></div>`
          : ''
      }
      ${sh.key ? `<div class="boxtools" style="justify-content:flex-start"><button type="button" class="textbtn" data-action="c-skip">Skip this one instead</button></div>` : ''}
    </div>
    <div class="sheetfoot"><button type="button" class="btn" data-action="c-confirm">${sh.progress ? 'Log time' : 'Mark done'}</button></div>`;
}

function confirmComplete() {
  const sh = ui.sheet;
  const minutes = chosenMinutes(sh);
  const t0 = findTask(sh.taskId);
  const title = t0.title;
  commit(
    (s) => {
      const t = s.tasks.find((x) => x.id === sh.taskId);
      const est = t.durationMin || 30;
      const now = new Date().toISOString();
      if (sh.key) {
        t.history ||= {};
        t.history[sh.key] = { doneAt: now, actualMin: minutes, estimateMin: est };
      } else if (sh.progress) {
        t.progressMin = (t.progressMin || 0) + minutes;
      } else {
        t.done = true;
        t.doneAt = now;
        t.actualMin = (t.progressMin || 0) + minutes;
        t.estimateAtDone = est;
      }
    },
    { undo: true }
  );
  closeSheet();
  showToast(sh.progress ? `Logged ${E.durLabel(minutes)} on ${title}.` : `Done: ${title}.`, { label: 'Undo', fn: undo });
}

function openComplete(taskId, key) {
  const t = findTask(taskId);
  if (!t) return;
  let k = key || null;
  if (t.recur && !k) k = E.currentOccurrence(t, today())?.key || null;
  openSheet({ type: 'complete', taskId, key: k, choice: 'right', custom: '', progress: false });
}

/* ================================================================ quick add */

const qaInput = $('#qa-input');
const qaPreview = $('#qa-preview');

function updatePreview() {
  const text = qaInput.value;
  if (!text.trim()) {
    qaPreview.innerHTML =
      document.activeElement === qaInput
        ? '<p class="hint" style="margin:0">Add details as you type: <b>45m</b> or <b>1h30</b>, <b>by fri</b>, <b>daily</b> or <b>every sat</b>, <b>#work</b>, <b>!</b> for high priority.</p>'
        : '';
    return;
  }
  const { draft, touched, newCategory } = draftFromText(text);
  const sh = { draft, touched, newCategory };
  applySuggestions(sh);
  const chips = [];
  const cat = draft.category || newCategory;
  if (cat) chips.push(`<span class="pv cat ${touched.category || newCategory ? '' : 'sug'}" style="${catStyle(cat)}">${esc(cat)}</span>`);
  else chips.push('<span class="pv sug">No category</span>');
  if (draft.durationMin) chips.push(`<span class="pv ${touched.duration ? '' : 'sug'}">${E.durLabel(draft.durationMin)}</span>`);
  if (draft.deadline) chips.push(`<span class="pv">Due ${esc(phrase(draft.deadline))}</span>`);
  if (draft.notBefore) chips.push(`<span class="pv">From ${esc(phrase(draft.notBefore))}</span>`);
  if (draft.recur) chips.push(`<span class="pv">${recurLabel(draft.recur)}</span>`);
  if (draft.importance === 3) chips.push(`<span class="pv ${touched.importance ? '' : 'sug'}">High priority</span>`);
  if (draft.importance === 1) chips.push(`<span class="pv ${touched.importance ? '' : 'sug'}">Low priority</span>`);
  qaPreview.innerHTML = chips.join('');
}

function quickAdd() {
  const text = qaInput.value.trim();
  if (!text) return;
  const { draft, touched, newCategory } = draftFromText(text);
  if (!draft.title) {
    showToast('Add a title, like "Pay rent by fri".');
    return;
  }
  const sh = { draft, touched, newCategory };
  applySuggestions(sh);
  const id = uid();
  commit((s) => {
    if (newCategory && !s.categories.some((c) => c.name === newCategory)) addCategoryTo(s, newCategory);
    s.tasks.push({
      id,
      title: draft.title,
      category: newCategory || draft.category || null,
      durationMin: draft.durationMin || 30,
      importance: draft.importance || 2,
      deadline: draft.deadline || null,
      notBefore: draft.notBefore || null,
      recur: draft.recur,
      splittable: true,
      notes: '',
      createdAt: new Date().toISOString(),
      done: false,
      progressMin: 0,
      history: {},
      skipped: {},
      guessed: { category: !touched.category && !newCategory && !!draft.category, duration: !touched.duration, importance: !touched.importance },
    });
  });
  qaInput.value = '';
  updatePreview();
  showToast(placementMessage(id, 'Added'), { label: 'Edit', fn: () => openTaskSheet(id) });
}

/* ================================================================ toast */

function showToast(msg, action) {
  clearTimeout(ui.toastTimer);
  const root = $('#toast-root');
  root.innerHTML = `<div class="toast" role="status"><p>${esc(msg)}</p>${action ? `<button data-action="toast-action">${esc(action.label)}</button>` : ''}</div>`;
  ui.toast = action || null;
  ui.toastTimer = setTimeout(hideToast, action ? 6000 : 3500);
}
function hideToast() {
  $('#toast-root').innerHTML = '';
  ui.toast = null;
}

/* ================================================================ data ops */

function addCategoryTo(s, name) {
  const used = new Set(s.categories.map((c) => c.slot));
  let slot = 0;
  for (let i = 1; i <= MAX_COLORED; i++) {
    if (!used.has(i)) {
      slot = i;
      break;
    }
  }
  s.categories.push({ name, slot });
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'slotted', exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `slotted-backup-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tasks) || !Array.isArray(data.boxes)) throw new Error('shape');
    undoSnapshot = JSON.stringify(state);
    state = migrate(data);
    delete state.app;
    delete state.exportedAt;
    save();
    replan();
    render();
    showToast(`Imported ${state.tasks.length} tasks.`, { label: 'Undo', fn: undo });
  } catch {
    showToast("That file isn't a Slotted backup. Choose a file you exported from Setup.");
  }
}

/* ================================================================ events */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action], [data-tab]');
  if (!el) return;
  const a = el.dataset.action || 'tab';
  const sh = ui.sheet;
  switch (a) {
    case 'tab':
      ui.view = el.dataset.tab;
      closeSheet();
      render();
      window.scrollTo(0, 0);
      break;
    case 'open':
      openTaskSheet(el.dataset.task);
      break;
    case 'complete':
      openComplete(el.dataset.task, el.dataset.key);
      break;
    case 'example':
      qaInput.value = el.dataset.text;
      qaInput.focus();
      updatePreview();
      break;
    case 'qa-more':
      openNewTaskSheet(qaInput.value);
      qaInput.value = '';
      updatePreview();
      break;
    case 'sheet-close':
      closeSheet();
      break;
    case 'sheet-save':
      saveTaskSheet();
      break;
    case 'sheet-delete': {
      const t = findTask(sh.id);
      commit((s) => (s.tasks = s.tasks.filter((x) => x.id !== sh.id)), { undo: true });
      closeSheet();
      showToast(`Deleted ${t?.title || 'task'}.`, { label: 'Undo', fn: undo });
      break;
    }
    case 'undone': {
      const { task: id, key } = el.dataset;
      commit(
        (s) => {
          const t = s.tasks.find((x) => x.id === id);
          if (!t) return;
          if (key) delete t.history?.[key];
          else {
            t.done = false;
            delete t.doneAt;
            delete t.actualMin;
            delete t.estimateAtDone;
          }
        },
        { undo: true }
      );
      if (ui.sheet) closeSheet();
      showToast('Restored to your plan.', { label: 'Undo', fn: undo });
      break;
    }
    case 'd-cat':
      sh.draft.category = el.dataset.value || null;
      sh.touched.category = true;
      refreshRegions('category', 'suggest', 'duration');
      break;
    case 'd-dur':
      sh.draft.durationMin = Number(el.dataset.value);
      sh.touched.duration = true;
      refreshRegions('duration', 'suggest');
      break;
    case 'd-step':
      sh.draft.durationMin = Math.min(720, Math.max(5, (sh.draft.durationMin || 30) + Number(el.dataset.value)));
      sh.touched.duration = true;
      refreshRegions('duration', 'suggest');
      break;
    case 'd-imp':
      sh.draft.importance = Number(el.dataset.value);
      sh.touched.importance = true;
      refreshRegions('importance');
      break;
    case 'd-clear':
      sh.draft[el.dataset.value] = '';
      renderSheet();
      break;
    case 'c-choice':
      sh.choice = el.dataset.value;
      sh.custom = '';
      renderSheet();
      break;
    case 'c-confirm':
      confirmComplete();
      break;
    case 'c-skip': {
      const title = findTask(sh.taskId)?.title;
      commit(
        (s) => {
          const t = s.tasks.find((x) => x.id === sh.taskId);
          t.skipped ||= {};
          t.skipped[sh.key] = true;
        },
        { undo: true }
      );
      closeSheet();
      showToast(`Skipped ${title} this time.`, { label: 'Undo', fn: undo });
      break;
    }
    case 'skip': {
      const box = el.dataset.box;
      commit((s) => {
        (s.skips[today()] ||= []).push(box);
      });
      break;
    }
    case 'unskip':
      commit((s) => {
        s.skips[today()] = (s.skips[today()] || []).filter((b) => b !== el.dataset.box);
      });
      break;
    case 'filter':
      ui.filter = el.dataset.value;
      render();
      break;
    case 'box-add':
      commit((s) => s.boxes.push({ id: uid(), name: 'New box', days: [1, 2, 3, 4, 5], start: '12:00', end: '13:00', categories: [] }));
      requestAnimationFrame(() => {
        const inputs = document.querySelectorAll('.boxnameinput');
        inputs[inputs.length - 1]?.focus();
        inputs[inputs.length - 1]?.select();
      });
      break;
    case 'box-day':
      commit((s) => {
        const b = s.boxes.find((x) => x.id === el.dataset.box);
        const d = Number(el.dataset.day);
        b.days = b.days.includes(d) ? b.days.filter((x) => x !== d) : [...b.days, d].sort();
      });
      break;
    case 'box-cat':
      commit((s) => {
        const b = s.boxes.find((x) => x.id === el.dataset.box);
        const c = el.dataset.value;
        if (!c) b.categories = [];
        else b.categories = b.categories.includes(c) ? b.categories.filter((x) => x !== c) : [...b.categories, c];
      });
      break;
    case 'box-delete': {
      const b = state.boxes.find((x) => x.id === el.dataset.box);
      commit((s) => (s.boxes = s.boxes.filter((x) => x.id !== el.dataset.box)), { undo: true });
      showToast(`Deleted ${b?.name || 'box'}.`, { label: 'Undo', fn: undo });
      break;
    }
    case 'cat-delete': {
      const name = el.dataset.value;
      commit(
        (s) => {
          s.categories = s.categories.filter((c) => c.name !== name);
          for (const t of s.tasks) if (t.category === name) t.category = null;
          for (const b of s.boxes) b.categories = (b.categories || []).filter((c) => c !== name);
        },
        { undo: true }
      );
      showToast(`Deleted ${name}. Its tasks are now uncategorized.`, { label: 'Undo', fn: undo });
      break;
    }
    case 'export':
      exportBackup();
      break;
    case 'import':
      $('#import-file')?.click();
      break;
    case 'erase':
      if (confirm('Erase every task, box and category on this device? Export a backup first if you might want them back.')) {
        state = defaultState();
        save();
        replan();
        render();
        showToast('Erased. Starting fresh.');
      }
      break;
    case 'toast-action': {
      const fn = ui.toast?.fn;
      hideToast();
      fn?.();
      break;
    }
    default:
      break;
  }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'quickadd') quickAdd();
  if (e.target.dataset.form === 'cat-add') {
    const name = e.target.elements.name.value.trim();
    if (!name) return;
    if (state.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      showToast(`${name} already exists.`);
      return;
    }
    commit((s) => addCategoryTo(s, name));
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el === qaInput) return updatePreview();
  const sh = ui.sheet;
  if (sh && el.dataset.df) {
    const f = el.dataset.df;
    if (f === 'splittable') sh.draft.splittable = el.checked;
    else if (f === 'recur') {
      const v = el.value;
      sh.draft.recur = !v ? null : v.startsWith('weekly-') ? { type: 'weekly', day: Number(v.slice(7)) } : v === 'weekly' ? { type: 'weekly', day: null } : { type: v };
    } else sh.draft[f] = el.value;
    if (f === 'title' && sh.isNew) {
      applySuggestions(sh);
      refreshRegions('suggest', 'category', 'duration', 'importance');
    }
  }
  if (sh && el.dataset.cf) {
    if (el.dataset.cf === 'progress') {
      sh.progress = el.checked;
      renderSheet();
    } else {
      sh.custom = el.value;
      for (const b of document.querySelectorAll('#sheet-root .choice')) b.setAttribute('aria-pressed', 'false');
    }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'import-file' && el.files?.[0]) {
    importBackup(el.files[0]);
    el.value = '';
    return;
  }
  if (el.dataset.bf) {
    const v = el.value;
    if ((el.dataset.bf === 'start' || el.dataset.bf === 'end') && !v) return;
    commit((s) => {
      const b = s.boxes.find((x) => x.id === el.dataset.box);
      b[el.dataset.bf] = el.dataset.bf === 'name' ? v.trim() || 'Untitled box' : v;
    });
    const b = state.boxes.find((x) => x.id === el.dataset.box);
    if (b && E.toMin(b.end === '00:00' ? '24:00' : b.end) <= E.toMin(b.start)) showToast(`${b.name} ends before it starts, so nothing will be planned in it.`);
    return;
  }
  if (el.dataset.catname !== undefined) {
    const old = el.dataset.catname;
    const name = el.value.trim();
    if (!name || name === old) {
      el.value = old;
      return;
    }
    if (state.categories.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.name !== old)) {
      el.value = old;
      showToast(`${name} already exists.`);
      return;
    }
    commit((s) => {
      s.categories.find((c) => c.name === old).name = name;
      for (const t of s.tasks) if (t.category === old) t.category = name;
      for (const b of s.boxes) b.categories = (b.categories || []).map((c) => (c === old ? name : c));
    });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.sheet) closeSheet();
  if (e.key === 'Enter' && e.target.id === 'd-title') {
    e.preventDefault();
    saveTaskSheet();
  }
});

qaInput.addEventListener('focus', () => {
  document.body.classList.add('typing');
  updatePreview();
});
qaInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement !== qaInput) {
      document.body.classList.remove('typing');
      updatePreview();
    }
  }, 150);
});

// Keep the quick-add bar above the iPhone keyboard.
function updateKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
}
window.visualViewport?.addEventListener('resize', updateKeyboardInset);
window.visualViewport?.addEventListener('scroll', updateKeyboardInset);

// Keep "now" current: re-plan every minute and when the app comes back to the foreground.
function refresh() {
  const busy = ui.sheet || (document.activeElement && document.activeElement.closest('main') && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName));
  replan();
  if (!busy) render();
}
setInterval(refresh, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

/* ================================================================ boot */

replan();
render();
updatePreview();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});
