// Slotted engine: quick-add parsing, learning suggestions, and the time-box scheduler.
// Pure functions with no DOM access, so the same file runs in the app and in Node tests.

/* ------------------------------------------------------------------ dates */

export const DAY_MS = 86400000;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
export function weekday(key) {
  return parseDay(key).getDay();
}
/** Monday of the week containing `key`. */
export function weekStart(key) {
  return addDays(key, -((weekday(key) + 6) % 7));
}
/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}
export function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}
export function clockLabel(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  return m ? `${h12}:${String(m).padStart(2, '0')}` : `${h12}`;
}
export function ampm(min) {
  return Math.floor(min / 60) % 24 < 12 ? 'am' : 'pm';
}
export function durLabel(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
export function snapDuration(min) {
  const steps = [5, 10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480];
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - min) < Math.abs(best - min)) best = s;
  return best;
}

/* ---------------------------------------------------------------- parsing */

const DAY_NAMES = [
  ['sun', 'sunday'], ['mon', 'monday'], ['tue', 'tues', 'tuesday'], ['wed', 'weds', 'wednesday'],
  ['thu', 'thur', 'thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday'],
];
function dayIndex(word) {
  const w = word.toLowerCase();
  return DAY_NAMES.findIndex((names) => names.includes(w));
}
const DAY_WORD = DAY_NAMES.flat().join('|');

/** Resolve a date word ("fri", "tomorrow", "10/24") relative to today. */
export function resolveDate(word, today) {
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tonight') return today;
  if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr') return addDays(today, 1);
  const di = dayIndex(w);
  if (di >= 0) {
    let delta = (di - weekday(today) + 7) % 7;
    if (delta === 0) delta = 7; // "by monday" said on a Monday means next Monday
    return addDays(today, delta);
  }
  const md = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (md) {
    const t = parseDay(today);
    let year = md[3] ? Number(md[3].length === 2 ? `20${md[3]}` : md[3]) : t.getFullYear();
    let d = new Date(year, Number(md[1]) - 1, Number(md[2]));
    if (!md[3] && (t - d) / DAY_MS > 30) d = new Date(year + 1, Number(md[1]) - 1, Number(md[2]));
    return dayKey(d);
  }
  return null;
}

const DATE_WORD = `(?:today|tonight|tomorrow|tmrw|tmr|${DAY_WORD}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)`;

/**
 * Parse quick-add text like "CS 650 reading 45m by thu ! #school".
 * Returns the cleaned title plus whatever fields were stated explicitly.
 */
export function parseQuickAdd(text, today) {
  let s = ` ${text} `;
  const out = { title: '' };
  const take = (re, fn) => {
    s = s.replace(re, (...m) => {
      fn(m);
      return ' ';
    });
  };

  // Duration: 45m, 1h, 1.5h, 1h30, 1h30m, 90 min, 2 hrs
  take(/\s(\d+(?:\.\d+)?)\s?(h|hr|hrs|hour|hours)\s?(\d{1,2})\s?(?:m|min|mins)?(?=\s)/i, (m) => {
    out.durationMin = Math.round(Number(m[1]) * 60 + Number(m[3]));
  });
  if (out.durationMin == null) {
    take(/\s(\d+(?:\.\d+)?)\s?(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?=\s)/i, (m) => {
      const n = Number(m[1]);
      out.durationMin = Math.round(/^h/i.test(m[2]) ? n * 60 : n);
    });
  }

  // Recurrence
  take(/\s(?:every\s+day|everyday|daily)(?=\s)/i, () => (out.recur = { type: 'daily' }));
  take(/\s(?:every\s+weekday|weekdays)(?=\s)/i, () => (out.recur = { type: 'weekdays' }));
  take(new RegExp(`\\s(?:every|each)\\s+(${DAY_WORD})(?=\\s)`, 'i'), (m) => {
    out.recur = { type: 'weekly', day: dayIndex(m[1]) };
  });
  take(/\s(?:every\s+week|weekly)(?=\s)/i, () => (out.recur = { type: 'weekly', day: null }));

  // Deadline and earliest start
  take(new RegExp(`\\s(?:by|due|before)\\s+(${DATE_WORD})(?=\\s)`, 'i'), (m) => {
    out.deadline = resolveDate(m[1], today);
  });
  take(new RegExp(`\\s(?:after|from|starting)\\s+(${DATE_WORD})(?=\\s)`, 'i'), (m) => {
    out.notBefore = resolveDate(m[1], today);
  });
  if (!out.deadline) {
    take(/\s(today|tonight|tomorrow|tmrw)(?=\s)/i, (m) => (out.deadline = resolveDate(m[1], today)));
  }

  // Category tag and importance
  take(/\s#([\w&-]+)(?=\s)/, (m) => (out.categoryTag = m[1].replace(/[-_]/g, ' ')));
  take(/\s!low(?=\s)/i, () => (out.importance = 1));
  take(/\s!+(?=\s)/, () => (out.importance = 3));

  out.title = s.replace(/\s+/g, ' ').trim();
  return out;
}

/** Match a #tag against existing category names (prefix, case-insensitive). */
export function matchCategory(tag, categories) {
  if (!tag) return null;
  const t = tag.toLowerCase();
  return (
    categories.find((c) => c.toLowerCase() === t) ||
    categories.find((c) => c.toLowerCase().startsWith(t)) ||
    null
  );
}

/* --------------------------------------------------------------- learning */

const STOP = new Set(
  'a an the and or to for of on in at with my me i is be it this that some new about from into our your get do make go'.split(' ')
);

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Unigram tokens (stemmed, stop words removed). */
export function words(title) {
  return (title.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Unigrams plus adjacent bigrams (bigrams keep phrases like "pick up"). */
export function tokens(title) {
  const all = (title.toLowerCase().match(/[a-z0-9]+/g) || []).map(stem);
  const uni = all.filter((w) => w.length > 1 && !STOP.has(w));
  const bi = [];
  for (let i = 0; i < all.length - 1; i++) {
    if (!(STOP.has(all[i]) && STOP.has(all[i + 1]))) bi.push(`${all[i]}_${all[i + 1]}`);
  }
  return [...new Set([...uni, ...bi])];
}

/** Starter vocabulary so suggestions work on day one. Your own tasks outweigh it quickly. */
export const SEED_KEYWORDS = {
  Work: ['meeting', 'email', 'review', 'pr', 'deploy', 'report', 'slides', 'standup', 'ticket', 'sprint', 'demo', 'release', 'code', 'design doc', 'status', 'customer', 'proposal', 'requirements', 'pipeline', 'bug'],
  School: ['homework', 'assignment', 'exam', 'study', 'lecture', 'paper', 'essay', 'quiz', 'class', 'chapter', 'reading', 'midterm', 'final', 'project', 'professor', 'syllabus', 'discussion post'],
  Home: ['clean', 'laundry', 'dishes', 'yard', 'mow', 'fix', 'repair', 'vacuum', 'trash', 'organize', 'garage', 'gutters', 'paint', 'filter', 'kitchen', 'bathroom', 'cat litter'],
  Errands: ['buy', 'pick up', 'drop off', 'store', 'grocery', 'groceries', 'return', 'pharmacy', 'post office', 'bank', 'gas', 'oil change', 'costco', 'target', 'walmart', 'ship', 'errand'],
  Fitness: ['run', 'gym', 'workout', 'lift', 'hike', 'train', 'stretch', 'swim', 'bike', 'yoga', 'ruck', 'climb', 'miles', 'long run', 'intervals', 'mobility'],
  Personal: ['call', 'birthday', 'gift', 'book', 'journal', 'appointment', 'dentist', 'doctor', 'haircut', 'taxes', 'bills', 'budget', 'renew', 'insurance', 'text', 'trip', 'flight', 'travel'],
};

export const DEFAULT_DURATIONS = { Work: 60, School: 60, Home: 45, Errands: 30, Fitness: 60, Personal: 30 };

/**
 * Category model built from seed keywords plus your own categorized tasks.
 * For each token we keep counts per category; prediction averages P(category | token)
 * across the title's known tokens. Confirmed tasks count double the seeds' per-task weight.
 */
export function buildModel(tasks, categories) {
  const counts = new Map(); // token -> Map(category -> weight)
  const add = (tok, cat, w) => {
    if (!counts.has(tok)) counts.set(tok, new Map());
    const m = counts.get(tok);
    m.set(cat, (m.get(cat) || 0) + w);
  };
  for (const cat of categories) {
    for (const kw of SEED_KEYWORDS[cat] || []) for (const t of tokens(kw)) add(t, cat, 1.5);
  }
  for (const t of tasks) {
    if (!t.category || !categories.includes(t.category)) continue;
    const confirmed = !t.guessed?.category;
    if (!confirmed && !t.done) continue; // an unreviewed guess shouldn't teach itself
    const w = confirmed ? 3 : 1;
    for (const tok of tokens(t.title)) add(tok, t.category, w);
  }
  return { counts, categories };
}

export function predictCategory(model, title) {
  const { counts, categories } = model;
  const known = tokens(title).filter((t) => counts.has(t));
  if (!known.length || !categories.length) return { category: null, confidence: 0, ranked: [] };
  const beta = 0.1;
  const score = Object.fromEntries(categories.map((c) => [c, 0]));
  let wsum = 0;
  for (const t of known) {
    const m = counts.get(t);
    let total = 0;
    for (const v of m.values()) total += v;
    const w = (t.includes('_') ? 1.5 : 1) * Math.log(1 + total);
    for (const c of categories) score[c] += (w * ((m.get(c) || 0) + beta)) / (total + beta * categories.length);
    wsum += w;
  }
  const ranked = categories
    .map((c) => ({ category: c, p: score[c] / wsum }))
    .sort((a, b) => b.p - a.p);
  const [top, second] = ranked;
  const sure = top.p >= 0.5 && top.p - (second?.p || 0) >= 0.15;
  return { category: sure ? top.category : null, confidence: top.p, ranked };
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  let inter = 0;
  for (const x of new Set(b)) if (A.has(x)) inter++;
  return inter / (A.size + new Set(b).size - inter);
}

function weightedMedian(pairs) {
  // pairs: [value, weight]
  const sorted = [...pairs].sort((x, y) => x[0] - y[0]);
  const half = sorted.reduce((s, p) => s + p[1], 0) / 2;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= half) return v;
  }
  return sorted.at(-1)?.[0];
}

function similar(tasks, title, excludeId) {
  const me = words(title);
  return tasks
    .filter((t) => t.id !== excludeId)
    .map((t) => ({ t, sim: jaccard(me, words(t.title)) }))
    .filter((x) => x.sim >= 0.34)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 6);
}

/** Minutes a past task really took (or its estimate if it never got logged). */
function knownDuration(t) {
  if (t.actualMin) return t.actualMin;
  const logged = Object.values(t.history || {}).filter((h) => h.actualMin).map((h) => h.actualMin);
  if (logged.length) return weightedMedian(logged.map((v) => [v, 1]));
  return t.guessed?.duration ? null : t.durationMin;
}

/** Suggest category, duration and importance for a new title. */
export function suggest({ title, tasks, categories, model, excludeId }) {
  const m = model || buildModel(tasks, categories);
  const cat = predictCategory(m, title);
  const near = similar(tasks, title, excludeId);

  let durationMin = null;
  let durationFrom = null;
  const durPairs = near.map(({ t, sim }) => [knownDuration(t), sim]).filter(([v]) => v);
  if (durPairs.length) {
    durationMin = snapDuration(weightedMedian(durPairs));
    durationFrom = 'similar';
  } else {
    const c = cat.category;
    const inCat = tasks.filter((t) => c && t.category === c).map(knownDuration).filter(Boolean);
    if (inCat.length >= 3) {
      durationMin = snapDuration(weightedMedian(inCat.map((v) => [v, 1])));
      durationFrom = 'category';
    } else {
      durationMin = DEFAULT_DURATIONS[c] || 30;
      durationFrom = 'default';
    }
  }

  let importance = 2;
  const impVotes = near.filter(({ t }) => !t.guessed?.importance && t.importance);
  if (impVotes.length) {
    const tally = { 1: 0, 2: 0, 3: 0 };
    for (const { t, sim } of impVotes) tally[t.importance] += sim;
    importance = Number(Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]);
  }

  return { category: cat.category, confidence: cat.confidence, ranked: cat.ranked, durationMin, durationFrom, importance };
}

/**
 * Per-category ratio of actual to estimated time, from your last 20 logged completions.
 * Needs 3 logs before it moves off 1.0; clamped to 0.5–2.5.
 */
export function estimateFactors(tasks) {
  const byCat = {};
  const push = (cat, est, act, at) => {
    if (!est || !act) return;
    (byCat[cat || 'Uncategorized'] ||= []).push({ r: act / est, at });
  };
  for (const t of tasks) {
    if (t.done) push(t.category, t.estimateAtDone, t.actualMin, t.doneAt);
    for (const h of Object.values(t.history || {})) push(t.category, h.estimateMin, h.actualMin, h.doneAt);
  }
  const out = {};
  for (const [cat, list] of Object.entries(byCat)) {
    const recent = list.sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 20);
    const med = weightedMedian(recent.map((x) => [x.r, 1]));
    out[cat] = { factor: recent.length >= 3 ? Math.min(2.5, Math.max(0.5, med)) : 1, n: recent.length, raw: med };
  }
  return out;
}

export function adjustedDuration(task, factors) {
  const base = task.durationMin || 30;
  const f = factors?.[task.category || 'Uncategorized']?.factor || 1;
  return Math.max(5, Math.round((base * f) / 5) * 5);
}

/* ------------------------------------------------------------- recurrence */

/** Occurrence keys for a recurring task within [from, to]. Weekly-any uses "W:<monday>". */
export function occurrences(task, from, to) {
  const r = task.recur;
  if (!r) return [];
  const out = [];
  if (r.type === 'weekly' && (r.day == null || r.day === '')) {
    for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
      const start = ws < from ? from : ws;
      const end = addDays(ws, 6);
      out.push({ key: `W:${ws}`, start, end });
    }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const wd = weekday(d);
      if (r.type === 'daily' || (r.type === 'weekdays' && wd >= 1 && wd <= 5) || (r.type === 'weekly' && wd === Number(r.day))) {
        out.push({ key: d, start: d, end: d });
      }
    }
  }
  return out.filter((o) => !task.notBefore || o.end >= task.notBefore);
}

/** The occurrence that is current today (for "done today" checks), if any. */
export function currentOccurrence(task, today) {
  return occurrences(task, today, addDays(today, 6)).find((o) => o.start <= today && o.end >= today) || null;
}

/* ---------------------------------------------------------------- planner */

const IMPORTANCE_WEIGHT = { 1: 1, 2: 2, 3: 3.5 };

function buildSlots(boxes, today, horizon, nowMin, skips) {
  const slots = [];
  for (let i = 0; i < horizon; i++) {
    const day = addDays(today, i);
    const wd = weekday(day);
    for (const box of boxes) {
      if (!box.days?.includes(wd)) continue;
      if (skips?.[day]?.includes(box.id)) continue;
      let start = toMin(box.start);
      const end = box.end === '00:00' ? 1440 : toMin(box.end);
      if (end <= start) continue;
      if (i === 0) start = Math.max(start, Math.ceil(nowMin / 5) * 5);
      if (end - start < 10) continue;
      slots.push({
        id: `${day}|${box.id}`,
        day,
        boxId: box.id,
        boxName: box.name,
        categories: box.categories || [],
        start,
        end,
        fullStart: toMin(box.start),
        cursor: start,
        order: i * 1440 + start,
        blocks: [],
      });
    }
  }
  return slots.sort((a, b) => a.order - b.order);
}

function eligible(item, slot) {
  if (slot.day < item.windowStart) return false;
  if (item.windowEnd && slot.day > item.windowEnd) return false;
  if (slot.categories.length && !slot.categories.includes(item.category)) return false;
  return true;
}

/** Smallest piece a task is split into: 15m for short tasks, up to 30m for long ones. */
export function defaultMinChunk(duration) {
  return Math.min(30, Math.max(15, Math.round(duration / 4 / 5) * 5));
}

function makeItems(tasks, today, lastDay, factors, now) {
  const items = [];
  for (const t of tasks) {
    if (t.archived) continue;
    const dur = adjustedDuration(t, factors);
    const ageDays = t.createdAt ? Math.max(0, (now - new Date(t.createdAt)) / DAY_MS) : 0;
    if (t.recur) {
      for (const o of occurrences(t, today, lastDay)) {
        if (t.history?.[o.key] || t.skipped?.[o.key]) continue;
        items.push({
          id: `${t.id}@${o.key}`,
          taskId: t.id,
          key: o.key,
          title: t.title,
          category: t.category,
          importance: t.importance || 2,
          remaining: dur,
          splittable: t.splittable !== false,
          minChunk: t.minChunk || defaultMinChunk(dur),
          due: o.end,
          windowStart: o.start,
          windowEnd: o.end,
          recurring: true,
          ageDays: 0,
        });
      }
    } else if (!t.done) {
      const remaining = Math.max(5, dur - (t.progressMin || 0));
      items.push({
        id: t.id,
        taskId: t.id,
        key: null,
        title: t.title,
        category: t.category,
        importance: t.importance || 2,
        remaining,
        splittable: t.splittable !== false,
        minChunk: t.minChunk || defaultMinChunk(dur),
        due: t.deadline || null,
        windowStart: t.notBefore && t.notBefore > today ? t.notBefore : today,
        windowEnd: null,
        recurring: false,
        ageDays,
      });
    }
  }
  return items;
}

function scoreItem(item, dailyCap) {
  const w = IMPORTANCE_WEIGHT[item.importance] || 2;
  let urgency = 1;
  if (item.due) {
    const slack = item.cap - item.remaining;
    urgency = 1 + 4 * Math.exp(-Math.max(0, slack) / dailyCap) + (slack < 0 ? 2 : 0);
  }
  const aging = Math.min(item.ageDays / 21, 1) * 0.75;
  return w * urgency + aging;
}

function placeOne(item, slots) {
  let remaining = item.remaining;
  const chunks = [];
  const minChunk = Math.min(item.minChunk, remaining);
  for (const slot of slots) {
    if (remaining <= 0) break;
    if (!eligible(item, slot)) continue;
    const free = slot.end - slot.cursor;
    if (free <= 0) continue;
    if (!item.splittable || item.forceWhole) {
      if (free < remaining) continue;
    } else if (free < minChunk && free < remaining) {
      continue;
    }
    let take = Math.min(free, remaining);
    // Don't leave a sliver smaller than the minimum chunk for later.
    const tail = remaining - take;
    if (tail > 0 && tail < minChunk && take - (minChunk - tail) >= minChunk) take -= minChunk - tail;
    chunks.push({ slot, start: slot.cursor, end: slot.cursor + take });
    slot.cursor += take;
    remaining -= take;
  }
  return { chunks, unplaced: remaining };
}

function placeAll(items, slots) {
  for (const s of slots) {
    s.cursor = s.start;
    s.blocks = [];
  }
  const order = [...items].sort(
    (a, b) =>
      b.boost - a.boost ||
      // Among rescued tasks: earliest deadline first; when deadlines tie and both can't fit, priority wins.
      (a.boost && b.boost ? (a.due || '9999').localeCompare(b.due || '9999') || b.importance - a.importance : 0) ||
      b.score - a.score ||
      a.id.localeCompare(b.id)
  );
  for (const item of order) {
    let res = placeOne(item, slots);
    // A task that won't fit whole in any box gets split rather than dropped.
    if (res.unplaced > 0 && !item.splittable && res.chunks.length === 0) {
      item.splittable = true;
      item.forcedSplit = true;
      res = placeOne(item, slots);
    }
    item.chunks = res.chunks;
    item.unplaced = res.unplaced;
  }
}

function isLate(item) {
  if (!item.due) return false;
  if (item.unplaced > 0) return true;
  return item.chunks.length > 0 && item.chunks.at(-1).slot.day > item.due;
}

/**
 * Fit tasks into time boxes.
 * - Score = importance weight × urgency + aging. Urgency rises as slack (matching box time
 *   before the deadline minus work remaining) shrinks, scaled by your average daily capacity.
 * - Greedy: highest score first, into the earliest box that accepts its category.
 * - Repair: anything that lands past its deadline gets bumped ahead (earliest deadline first)
 *   and the plan is rebuilt, up to four passes. What's still late is reported at risk.
 */
export function plan({ tasks, boxes, skips = {}, now = new Date(), horizon = 14, factors = {} }) {
  const today = dayKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const lastDay = addDays(today, horizon - 1);
  const slots = buildSlots(boxes, today, horizon, nowMin, skips);
  const totalCap = slots.reduce((s, x) => s + (x.end - x.start), 0);
  const dailyCap = Math.max(60, totalCap / horizon);
  const items = makeItems(tasks, today, lastDay, factors, now);

  for (const it of items) {
    const elig = slots.filter((s) => eligible(it, s));
    it.eligibleCap = elig.reduce((s, x) => s + (x.end - x.start), 0);
    it.cap = it.due ? elig.filter((s) => s.day <= it.due).reduce((s, x) => s + (x.end - x.start), 0) : Infinity;
    it.score = scoreItem(it, dailyCap);
    it.boost = 0;
  }

  for (let pass = 0; pass < 4; pass++) {
    placeAll(items, slots);
    const newlyLate = items.filter((it) => isLate(it) && !it.boost && it.cap >= it.remaining);
    if (!newlyLate.length) break;
    for (const it of newlyLate) it.boost = 1;
  }

  const byTask = {};
  const all = [];
  const atRisk = [];
  const unscheduled = [];
  for (const it of items) {
    it.chunks.forEach((c, i) => {
      c.slot.blocks.push({
        itemId: it.id,
        taskId: it.taskId,
        key: it.key,
        title: it.title,
        category: it.category,
        importance: it.importance,
        recurring: it.recurring,
        start: c.start,
        end: c.end,
        part: i + 1,
        parts: it.chunks.length,
      });
    });
    const first = it.chunks[0];
    const last = it.chunks.at(-1);
    const summary = {
      id: it.id,
      taskId: it.taskId,
      key: it.key,
      title: it.title,
      category: it.category,
      due: it.due,
      remaining: it.remaining,
      score: Math.round(it.score * 100) / 100,
      slack: it.due ? it.cap - it.remaining : null,
      startDay: first?.slot.day || null,
      startMin: first?.start ?? null,
      targetDay: it.unplaced > 0 ? null : last?.slot.day || null,
      unplaced: it.unplaced,
      late: isLate(it),
      impossible: !!it.due && it.cap < it.remaining,
      noBox: it.eligibleCap === 0,
      forcedSplit: !!it.forcedSplit,
      recurring: it.recurring,
    };
    all.push(summary);
    if (!it.recurring) byTask[it.taskId] = summary;
    if (summary.late && !(it.recurring && it.windowStart > addDays(today, 1))) atRisk.push(summary);
    else if (summary.unplaced > 0 && !it.recurring) unscheduled.push(summary);
  }

  for (const s of slots) s.blocks.sort((a, b) => a.start - b.start);
  const days = [];
  for (let i = 0; i < horizon; i++) {
    const day = addDays(today, i);
    const daySlots = slots.filter((s) => s.day === day);
    days.push({
      day,
      slots: daySlots.map(({ id, boxId, boxName, categories, start, end, fullStart, blocks }) => ({
        id,
        boxId,
        boxName,
        categories,
        start,
        end,
        fullStart,
        blocks,
        used: blocks.reduce((s, b) => s + (b.end - b.start), 0),
      })),
    });
  }
  atRisk.sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  return { today, days, byTask, items: all, atRisk, unscheduled, dailyCap: Math.round(dailyCap) };
}

/** Plain-language reason for a task's place in the plan. */
export function explain(summary, today) {
  if (!summary) return '';
  if (summary.noBox) return 'No time box accepts this category. Add one in Setup or change the category.';
  if (summary.impossible) {
    return `Needs ${durLabel(summary.remaining)} but only ${durLabel(Math.max(0, summary.remaining + summary.slack))} of matching box time is left before it's due.`;
  }
  if (summary.late) return `Projected to finish ${dayPhrase(summary.targetDay, today) || 'after the planning window'}, after it's due ${dayPhrase(summary.due, today)}.`;
  if (summary.unplaced > 0) return `${durLabel(summary.unplaced)} doesn't fit in the next two weeks of boxes.`;
  if (!summary.targetDay) return '';
  const parts = [`On track to finish ${dayPhrase(summary.targetDay, today)}`];
  if (summary.due) parts.push(`${summary.slack >= 0 ? durLabel(summary.slack) : 'no'} of slack before it's due ${dayPhrase(summary.due, today)}`);
  return `${parts.join(', with ')}.`;
}

export function dayPhrase(key, today) {
  if (!key) return '';
  const n = diffDays(today, key);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 7) return WEEKDAYS[weekday(key)];
  const d = parseDay(key);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}
