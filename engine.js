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
const DAY_FULL = DAY_NAMES.map((n) => n.at(-1)).join('|');

/** Resolve a date word ("fri", "next fri", "tomorrow", "10/24") relative to today. */
export function resolveDate(word, today) {
  const w = word.toLowerCase().replace(/\s+/g, ' ').trim();
  if (w === 'today' || w === 'tonight') return today;
  if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr') return addDays(today, 1);
  const rel = w.match(/^(next|this) (\w+)$/);
  if (rel) {
    const di = dayIndex(rel[2]);
    if (di < 0) return null;
    const delta = (di - weekday(today) + 7) % 7;
    if (rel[1] === 'this') return addDays(today, delta);
    // "next fri" is the Friday of next week: a week after the coming one if that's still this week.
    const upcoming = addDays(today, delta || 7);
    return upcoming < addDays(weekStart(today), 7) ? addDays(upcoming, 7) : upcoming;
  }
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

const DATE_WORD = `(?:(?:next|this)\\s+(?:${DAY_WORD})|today|tonight|tomorrow|tmrw|tmr|${DAY_WORD}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)`;

/* Spoken input: number words, filler, and phrases like "an hour and a half". */

const NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};
const NUM_WORD = `(?:(?:twenty|thirty|forty|fifty)[\\s-](?:one|two|three|four|five|six|seven|eight|nine)|${Object.keys(NUM)
  .filter((k) => k.length > 2)
  .join('|')})`;
function toNumber(w) {
  if (/^\d/.test(w)) return Number(w);
  return w
    .toLowerCase()
    .split(/[\s-]+/)
    .reduce((sum, x) => sum + (NUM[x] || 0), 0);
}

const FILLER =
  /^\s*(?:(?:ok(?:ay)?|hey|so|um+|uh+)[,\s]+)*(?:please\s+)?(?:remind me to|remind me|i need to|i have to|i've got to|i got to|i gotta|i should|i want to|need to|have to|don't forget to|do not forget to|remember to|make sure to|make sure i|add a task to|add task to|add a task|add task|new task)\b[:,]?/i;

/** Rewrite how people say durations into the short forms the parser reads. */
function normalizeSpoken(s) {
  return s
    .replace(/([,.;:?]+)(?=\s)/g, ' $1 ')
    .replace(/\s(?:an?|one)\s+hour\s+and\s+a\s+half(?=\s)/gi, ' 90m')
    .replace(new RegExp(`\\s(${NUM_WORD}|\\d+)\\s+and\\s+a\\s+half\\s+hours?(?=\\s)`, 'gi'), (_, n) => ` ${toNumber(n) + 0.5}h`)
    .replace(/\s(?:a\s+)?half\s+(?:an\s+)?hour(?=\s)/gi, ' 30m')
    .replace(/\s(?:a\s+)?quarter\s+(?:of\s+an\s+)?hour(?=\s)/gi, ' 15m')
    .replace(/\s(?:a\s+)?couple(?:\s+of)?\s+hours(?=\s)/gi, ' 2h')
    .replace(/\s(?:a\s+)?few\s+hours(?=\s)/gi, ' 3h')
    .replace(/\s(?:an?|one)\s+hour(?=\s)/gi, ' 1h')
    .replace(new RegExp(`\\s(${NUM_WORD})\\s+(minutes?|mins?|hours?|hrs?)(?=\\s)`, 'gi'), (_, n, u) => ` ${toNumber(n)} ${u}`);
}

function cleanTitle(s) {
  let t = s.replace(/\s+([,.;:?]+)/g, '$1').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/^[,.;:?!\-–—\s]+/, '')
      .replace(/[,.;:?!\-–—\s]+$/, '')
      .replace(/([,;:])(?:\s*[,.;:])+/g, '$1')
      .replace(/^(?:to|and|then|so)\s+/i, '')
      .replace(/\s+(?:and|but|so|then|which|that)$/i, '');
  }
  return /^[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t;
}

/**
 * Parse one entry, typed ("Chapter 4 reading 45m by thu ! #school") or dictated
 * ("Remind me to pay rent by Friday, it takes about ten minutes.").
 * Returns the cleaned title plus whatever fields were stated.
 */
export function parseQuickAdd(text, today) {
  let s = normalizeSpoken(` ${String(text).replace(/[‘’]/g, "'").replace(FILLER, '')} `);
  const out = { title: '' };
  const take = (re, fn) => {
    s = s.replace(re, (...m) => {
      fn(m);
      return ' ';
    });
  };
  const weekStartDay = weekStart(today);
  const latest = (a, b) => (a > b ? a : b);

  // Duration: 45m, 1h, 1.5h, 1h30, 90 min, 2 hrs, "takes about 20 minutes", "for 2 hours"
  const LEAD = "(?:(?:it(?:'ll|\\s+will|\\s+should)?\\s+)?(?:takes?|taking|for|about|around|roughly|approximately|approx|maybe|like|~)\\s+)*";
  take(new RegExp(`\\s${LEAD}(\\d+(?:\\.\\d+)?)\\s?(?:h|hr|hrs|hour|hours)\\s?(?:and\\s+)?(\\d{1,2})\\s?(?:m|min|mins|minutes?)?(?=\\s)`, 'i'), (m) => {
    out.durationMin = Math.round(Number(m[1]) * 60 + Number(m[2]));
  });
  if (out.durationMin == null) {
    take(new RegExp(`\\s${LEAD}(\\d+(?:\\.\\d+)?)\\s?(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?=\\s)`, 'i'), (m) => {
      const n = Number(m[1]);
      out.durationMin = Math.round(/^h/i.test(m[2]) ? n * 60 : n);
    });
  }

  // Recurrence
  take(/\s(?:every\s+(?:single\s+)?day|everyday|daily|nightly|once\s+a\s+day|(?:every|each)\s+(?:day|morning|evening|night))(?=\s)/i, () => (out.recur = { type: 'daily' }));
  take(/\s(?:on\s+)?(?:every\s+weekday|weekdays)(?=\s)/i, () => (out.recur = { type: 'weekdays' }));
  take(new RegExp(`\\s(?:(?:every|each)\\s+(${DAY_WORD})|on\\s+(${DAY_FULL})s)(?=\\s)`, 'i'), (m) => {
    out.recur = { type: 'weekly', day: dayIndex(m[1] || m[2]) };
  });
  take(/\s(?:every\s+week|each\s+week|weekly|once\s+a\s+week)(?=\s)/i, () => (out.recur = { type: 'weekly', day: null }));

  // Priority, said or typed
  take(/\s(?:it'?s\s+|it\s+is\s+)?(?:low\s+priority|no\s+rush|not\s+urgent|whenever|someday|sometime)(?=\s)/i, () => (out.importance = 1));
  take(/\s(?:it'?s\s+|it\s+is\s+)?(?:high|top)\s+priority(?=\s)/i, () => (out.importance = 3));
  take(/\s(?:it'?s\s+|it\s+is\s+)?(?:very\s+|really\s+)?(?:urgent|asap)(?=\s)/i, () => (out.importance = 3));
  take(/\s(?:it'?s\s+|it\s+is\s+)(?:very\s+|really\s+)?important(?=\s)/i, () => (out.importance = 3));
  take(/\s!low(?=\s)/i, () => (out.importance = 1));
  take(/\s!+(?=\s)/, () => (out.importance = 3));

  // Date ranges: this/next week, this/next weekend, end of the week, in N days
  const sat = addDays(weekStartDay, 5);
  const sun = addDays(weekStartDay, 6);
  const fri = addDays(weekStartDay, 4);
  take(/\s(?:by|before)\s+next\s+week(?=\s)/i, () => (out.deadline = sun));
  take(/\s(?:by\s+|before\s+)?(?:the\s+)?end\s+of\s+(?:the|this)\s+week(?=\s)/i, () => (out.deadline = latest(fri, today)));
  take(/\s(?:by|before)\s+the\s+weekend(?=\s)/i, () => (out.deadline = latest(fri, today)));
  take(/\snext\s+weekend(?=\s)/i, () => {
    out.notBefore = addDays(sat, 7);
    out.deadline = addDays(sun, 7);
  });
  take(/\s(?:this|on\s+the|over\s+the|during\s+the)\s+weekend(?=\s)/i, () => {
    out.notBefore = latest(sat, today);
    out.deadline = sun;
  });
  take(/\snext\s+week(?=\s)/i, () => {
    out.notBefore = addDays(weekStartDay, 7);
    out.deadline = addDays(sun, 7);
  });
  take(/\s(?:sometime\s+)?this\s+week(?=\s)/i, () => (out.deadline = sun));
  take(new RegExp(`\\s(?:in|within)\\s+(\\d+|a|an|${NUM_WORD})\\s+(days?|weeks?)(?=\\s)`, 'i'), (m) => {
    out.deadline = addDays(today, toNumber(m[1]) * (/^w/i.test(m[2]) ? 7 : 1));
  });

  // Deadline, earliest start, and "on <day>" (both)
  take(new RegExp(`\\s(?:by|due|before)\\s+(${DATE_WORD})(?=\\s)`, 'i'), (m) => {
    out.deadline = resolveDate(m[1], today);
  });
  take(new RegExp(`\\s(?:after|from|starting)\\s+(${DATE_WORD})(?=\\s)`, 'i'), (m) => {
    out.notBefore = resolveDate(m[1], today);
  });
  take(new RegExp(`\\son\\s+(${DATE_WORD})(?=\\s)`, 'i'), (m) => {
    out.notBefore = out.deadline = resolveDate(m[1], today);
  });
  if (!out.deadline) {
    take(/\s(today|tonight|tomorrow|tmrw|this\s+(?:morning|afternoon|evening))(?=\s)/i, (m) => {
      out.deadline = /^this/i.test(m[1]) ? today : resolveDate(m[1], today);
    });
  }
  if (!out.deadline && !out.recur) {
    // A weekday said at the very end ("call mom sunday") means that day.
    take(new RegExp(`\\s((?:next|this)\\s+(?:${DAY_WORD})|${DAY_FULL})(?=(?:\\s*[,.;:?!])*\\s*$)`, 'i'), (m) => {
      out.notBefore = out.deadline = resolveDate(m[1], today);
    });
  }

  // Category: #tag, or "hashtag work" / "category work" when spoken
  take(/\s(?:#|(?:hashtag|category)\s+)([\w&-]+)(?=\s)/i, (m) => (out.categoryTag = m[1].replace(/[-_]/g, ' ')));

  out.title = cleanTitle(s);
  return out;
}

const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'jr', 'sr', 'vs', 'etc', 'prof', 'mt', 'ft', 'no', 'approx', 'appt', 'dept', 'inc', 'co', 'apt']);

/**
 * Split a dictated or typed brain dump into separate entries: one per line or sentence.
 * "Pay rent by Friday. Call Dr. Smith tomorrow." gives two entries.
 */
export function splitEntries(text) {
  const parts = [];
  for (const line of String(text).replace(/[‘’]/g, "'").split(/\n+|;\s+/)) {
    let start = 0;
    const re = /[.?!]+\s+(?=[A-Za-z(])/g;
    let m;
    while ((m = re.exec(line))) {
      const before = line.slice(start, m.index);
      const lastWord = ((before.match(/([A-Za-z]+)$/) || [])[1] || '').toLowerCase();
      if (m[0][0] === '.' && (ABBREVIATIONS.has(lastWord) || lastWord.length === 1)) continue;
      if (m[0][0] === '!' && /\s$/.test(before)) continue; // " ! " is the priority marker
      parts.push(line.slice(start, m.index + m[0].trimEnd().length));
      start = m.index + m[0].length;
    }
    parts.push(line.slice(start));
  }
  return parts.map((p) => p.trim()).filter((p) => /[A-Za-z0-9]/.test(p));
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

/* --------------------------------------------------------------- task type */

const FOCUS_WORDS = new Set(
  (
    'write draft study design plan research code build review analyze analyse prepare read learn practice outline edit ' +
    'solve develop debug refactor implement document revise brainstorm homework essay paper report thesis presentation ' +
    'slides proposal spec taxes budget lesson course'
  ).split(' ')
);
const LIGHT_WORDS = new Set(
  (
    'call email text message pay buy order book schedule reply respond send pick drop return renew cancel sign print ' +
    'submit confirm check clean tidy laundry dishes vacuum mow water trash mail ship remind ask rsvp register refill ' +
    'charge wash fold sweep feed grocery groceries errand haircut appointment'
  ).split(' ')
);
const CATEGORY_LEAN = { Work: 0.5, School: 0.5, Home: -0.5, Errands: -1, Fitness: -1 };

function wordForms(w) {
  return [w, w.replace(/ing$/, ''), w.replace(/ing$/, 'e'), w.replace(/ies$/, 'y'), w.replace(/es$/, ''), w.replace(/s$/, ''), w.replace(/ed$/, ''), w.replace(/ed$/, 'e')];
}

/** +1 if the first telling word reads like deep work, -1 if it reads like a quick or physical task. */
function verbLean(title) {
  for (const w of String(title).toLowerCase().match(/[a-z]+/g) || []) {
    const forms = wordForms(w);
    if (forms.some((f) => FOCUS_WORDS.has(f))) return 1;
    if (forms.some((f) => LIGHT_WORDS.has(f))) return -1;
  }
  return 0;
}

/** Guess whether a task needs focus or is light work, from its title, length and category. */
export function inferTaskType({ title = '', durationMin, category }) {
  const d = durationMin || 30;
  let s = 2 * verbLean(title);
  if (d >= 60) s += 1;
  else if (d >= 45) s += 0.5;
  else if (d <= 20) s -= 1;
  s += CATEGORY_LEAN[category] || 0;
  return s >= 1 ? 'focus' : s <= -1 ? 'light' : 'either';
}

/** The type you set on a task, or the guess when you haven't. */
export function taskType(task) {
  return task.type || inferTaskType(task);
}

/* ---------------------------------------------------------------- planner */

const IMPORTANCE_WEIGHT = { 1: 1, 2: 2, 3: 3.5 };
/** An undated task is aimed at this many days after it's added, by priority. */
export const SOFT_DUE_DAYS = { 1: 14, 2: 7, 3: 3 };
/** A piece of a bigger task shorter than this gives way to a whole small task that fits the gap. */
const SLIVER_MIN = 30;
/** Ordering penalty that makes a mismatched box (focus work in a Light box, or the reverse) a last resort. */
const LAST_RESORT = 1e6;

/** The implied target date for a task with no due date. */
export function softDueFor(task) {
  if (task.recur || task.deadline || !task.createdAt) return null;
  let from = dayKey(new Date(task.createdAt));
  if (task.notBefore && task.notBefore > from) from = task.notBefore;
  return addDays(from, SOFT_DUE_DAYS[task.importance || 2] || 7);
}

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
        kind: box.kind || 'any',
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

function makeItems(tasks, today, lastDay, factors) {
  const items = [];
  for (const t of tasks) {
    if (t.archived) continue;
    const dur = adjustedDuration(t, factors);
    const common = {
          taskId: t.id,
          title: t.title,
          category: t.category,
          importance: t.importance || 2,
          type: taskType(t),
          splittable: t.splittable !== false,
          minChunk: t.minChunk || defaultMinChunk(dur),
          createdAt: t.createdAt || '',
    };
    if (t.recur) {
      for (const o of occurrences(t, today, lastDay)) {
        if (t.history?.[o.key] || t.skipped?.[o.key]) continue;
        items.push({ ...common, id: `${t.id}@${o.key}`, key: o.key, remaining: dur, due: o.end, softDue: null, windowStart: o.start, windowEnd: o.end, recurring: true });
      }
    } else if (!t.done) {
      items.push({
        ...common,
        id: t.id,
        key: null,
        remaining: Math.max(5, dur - (t.progressMin || 0)),
        due: t.deadline || null,
        softDue: softDueFor(t),
        windowStart: t.notBefore && t.notBefore > today ? t.notBefore : today,
        windowEnd: null,
        recurring: false,
      });
    }
  }
  return items;
}

/**
 * Score = priority weight × urgency × size nudge.
 * - Urgency rises as slack (matching box time before the date, minus work left) shrinks,
 *   scaled by your average box time per day. Due dates go up to 5× (7× when already short);
 *   implied dates for undated tasks go up to 4×, so a real due date always outranks them.
 * - Size nudge: shorter tasks get up to 1.35×, longer ones down to 0.75× (value ÷ size, like WSJF).
 *   It fades out as a due date closes in, so it never delays something that's about to be late.
 */
function scoreItem(item, dailyCap) {
  const w = IMPORTANCE_WEIGHT[item.importance] || 2;
  let urgency = 1;
  let pressure = 0;
  if (item.due) {
    const slack = item.cap - item.remaining;
    const near = Math.exp(-Math.max(0, slack) / dailyCap);
    urgency = 1 + 4 * near + (slack < 0 ? 2 : 0);
    pressure = slack < 0 ? 1 : near;
  } else if (item.softDue) {
    const slack = item.softCap - item.remaining;
    urgency = 1 + 3 * Math.exp(-Math.max(0, slack) / dailyCap);
  }
  const size = Math.min(1.35, Math.max(0.75, (60 / item.remaining) ** 0.2));
  item.pressure = pressure;
  return w * urgency * (1 + (size - 1) * (1 - pressure));
}

function boxPenalty(item, slot) {
  if (slot.kind === 'any' || item.type === 'either' || slot.kind === item.type) return 0;
  if (item.boost || item.pressure >= 0.5) return 0; // a due date overrides the box preference
  return LAST_RESORT;
}

function slotsFor(item, slots) {
  if (slots.every((s) => boxPenalty(item, s) === 0)) return slots;
  return slots
    .map((s) => ({ s, k: s.order + boxPenalty(item, s) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s);
}

function placeOne(item, slots, later) {
  let remaining = item.remaining;
  const chunks = [];
  const minChunk = Math.min(item.minChunk, remaining);
  const mayYield = !item.boost && item.pressure < 0.5 && !item.noYield;
  item.yielded = [];
  for (const slot of slotsFor(item, slots)) {
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
    // Leave a small gap to a whole small task instead of filling it with a sliver of this one.
    if (
      mayYield &&
      take < remaining &&
      take < SLIVER_MIN &&
      later.some((c) => c.remaining <= free && eligible(c, slot) && boxPenalty(c, slot) === 0)
    ) {
      item.yielded.push({ slot, free });
      continue;
    }
    chunks.push({ slot, start: slot.cursor, end: slot.cursor + take });
    slot.cursor += take;
    remaining -= take;
  }
  chunks.sort((a, b) => a.slot.order - b.slot.order);
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
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  );
  order.forEach((item, i) => {
    const later = order.slice(i + 1);
    let res = placeOne(item, slots, later);
    // A task that won't fit whole in any box gets split rather than dropped.
    if (res.unplaced > 0 && !item.splittable && res.chunks.length === 0) {
      item.splittable = true;
      item.forcedSplit = true;
      res = placeOne(item, slots, later);
    }
    item.chunks = res.chunks;
    item.unplaced = res.unplaced;
  });
}

function isLate(item) {
  if (!item.due) return false;
  if (item.unplaced > 0) return true;
  return item.chunks.length > 0 && item.chunks.at(-1).slot.day > item.due;
}

/**
 * Fit tasks into time boxes.
 * - Each task gets a score (see scoreItem). Undated tasks get an implied date from their priority.
 * - Greedy: highest score first, into the earliest box that accepts its category. Focus work avoids
 *   Light boxes and the reverse, unless nothing else has room or a due date forces it.
 * - Gaps: a big task won't fill a gap under 30m with a sliver if a whole later task fits there.
 * - Repair: anything that lands past its due date is moved to the front (earliest due first) and the
 *   plan is rebuilt; a gap left for a small task that never came is handed back. What's still late
 *   is reported at risk.
 */
export function plan({ tasks, boxes, skips = {}, now = new Date(), horizon = 14, factors = {} }) {
  const today = dayKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const lastDay = addDays(today, horizon - 1);
  const slots = buildSlots(boxes, today, horizon, nowMin, skips);
  const totalCap = slots.reduce((s, x) => s + (x.end - x.start), 0);
  const dailyCap = Math.max(60, totalCap / horizon);
  const items = makeItems(tasks, today, lastDay, factors);

  for (const it of items) {
    const elig = slots.filter((s) => eligible(it, s));
    const capTo = (day) => elig.filter((s) => s.day <= day).reduce((s, x) => s + (x.end - x.start), 0);
    it.eligibleCap = elig.reduce((s, x) => s + (x.end - x.start), 0);
    it.cap = it.due ? capTo(it.due) : Infinity;
    it.softCap = it.softDue ? capTo(it.softDue) : Infinity;
    it.boost = 0;
    it.score = scoreItem(it, dailyCap);
  }

  for (let pass = 0; pass < 6; pass++) {
    placeAll(items, slots);
    let changed = false;
    for (const it of items) {
      if (!it.boost && isLate(it) && it.cap >= it.remaining) {
        it.boost = 1;
        changed = true;
      }
      if (!it.noYield && it.yielded.some((y) => y.slot.end - y.slot.cursor >= y.free)) {
        it.noYield = true;
        changed = true;
      }
    }
    if (!changed) break;
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
        type: it.type,
        recurring: it.recurring,
        start: c.start,
        end: c.end,
        part: i + 1,
        parts: it.chunks.length,
      });
    });
    const first = it.chunks[0];
    const last = it.chunks.at(-1);
    const mismatch = it.chunks.find((c) => c.slot.kind !== 'any' && it.type !== 'either' && c.slot.kind !== it.type);
    const summary = {
      id: it.id,
      taskId: it.taskId,
      key: it.key,
      title: it.title,
      category: it.category,
      type: it.type,
      due: it.due,
      softDue: it.softDue,
      softDays: SOFT_DUE_DAYS[it.importance] || 7,
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
      mismatchKind: mismatch ? mismatch.slot.kind : null,
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
      slots: daySlots.map(({ id, boxId, boxName, kind, categories, start, end, fullStart, blocks }) => ({
        id,
        boxId,
        boxName,
        kind,
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

const SOFT_PHRASE = { 3: '3 days', 7: 'a week', 14: 'two weeks' };

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
  let s = `On track to finish ${dayPhrase(summary.targetDay, today)}`;
  if (summary.due) {
    s += `, with ${summary.slack >= 0 ? durLabel(summary.slack) : 'no'} of slack before it's due ${dayPhrase(summary.due, today)}.`;
  } else if (summary.softDue) {
    const after = `${SOFT_PHRASE[summary.softDays] || `${summary.softDays} days`} after you added it`;
    if (summary.softDue < today) {
      s += `. No due date. It was aimed at ${dayPhrase(summary.softDue, today)}, ${after}, so it now ranks above newer undated tasks.`;
    } else {
      s += `. No due date, so it's aimed at ${dayPhrase(summary.softDue, today)}, ${after}.`;
      if (summary.targetDay > summary.softDue) s += ' Other tasks rank higher, so it finishes later than that.';
    }
  } else {
    s += '.';
  }
  if (summary.mismatchKind) {
    s += ` Part of it is in a ${summary.mismatchKind === 'focus' ? 'Focus' : 'Light'} box because no other box had room in time.`;
  }
  return s;
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
