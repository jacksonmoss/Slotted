import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuickAdd, matchCategory, buildModel, predictCategory, suggest, plan,
  estimateFactors, adjustedDuration, occurrences, addDays, explain,
} from './engine.js';

const TODAY = '2026-10-19'; // a Monday
const CATS = ['Work', 'School', 'Home', 'Errands', 'Fitness', 'Personal'];
const at = (day, hhmm) => {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
};
const WEEKDAYS = [1, 2, 3, 4, 5];
let n = 0;
const task = (o) => ({ id: `t${++n}`, importance: 2, createdAt: at(TODAY, '07:00').toISOString(), ...o });

test('quick add: duration, deadline, importance, tag', () => {
  const p = parseQuickAdd('Chapter 4 reading 45m by thu ! #school', TODAY);
  assert.equal(p.title, 'Chapter 4 reading');
  assert.equal(p.durationMin, 45);
  assert.equal(p.deadline, '2026-10-22');
  assert.equal(p.importance, 3);
  assert.equal(matchCategory(p.categoryTag, CATS), 'School');
});

test('quick add: recurrence and compound durations', () => {
  assert.deepEqual(parseQuickAdd('Long run 1h30 every sat', TODAY), { title: 'Long run', durationMin: 90, recur: { type: 'weekly', day: 6 } });
  assert.deepEqual(parseQuickAdd('Water plants daily 10m', TODAY).recur, { type: 'daily' });
  assert.deepEqual(parseQuickAdd('Gym weekdays 1h', TODAY).recur, { type: 'weekdays' });
  assert.deepEqual(parseQuickAdd('Meal prep weekly', TODAY).recur, { type: 'weekly', day: null });
  assert.equal(parseQuickAdd('Draft 1.5h', TODAY).durationMin, 90);
});

test('quick add: dates', () => {
  assert.equal(parseQuickAdd('Pay rent by 11/1', TODAY).deadline, '2026-11-01');
  assert.equal(parseQuickAdd('Taxes by mon', TODAY).deadline, '2026-10-26', 'same weekday means next week');
  assert.equal(parseQuickAdd('Laundry today', TODAY).deadline, TODAY);
  const p = parseQuickAdd('Prep slides after wed by fri 2h', TODAY);
  assert.equal(p.notBefore, '2026-10-21');
  assert.equal(p.deadline, '2026-10-23');
  assert.equal(p.title, 'Prep slides');
});

test('quick add: leaves ordinary numbers alone', () => {
  const p = parseQuickAdd('Read 2 chapters', TODAY);
  assert.equal(p.title, 'Read 2 chapters');
  assert.equal(p.durationMin, undefined);
  assert.equal(parseQuickAdd('Run 5 mi', TODAY).durationMin, undefined);
});

test('categorizer: seed vocabulary works on day one', () => {
  const m = buildModel([], CATS);
  assert.equal(predictCategory(m, 'Buy dog food').category, 'Errands');
  assert.equal(predictCategory(m, 'Finish homework set 3').category, 'School');
  assert.equal(predictCategory(m, 'Long run').category, 'Fitness');
  assert.equal(predictCategory(m, 'Mow the lawn').category, 'Home');
  assert.equal(predictCategory(m, 'Pick up dry cleaning').category, 'Errands');
  assert.equal(predictCategory(m, 'Zorblax quux').category, null, 'no guess when nothing is known');
});

test('categorizer: your corrections override the seeds', () => {
  const tasks = [
    task({ title: 'Ruck test prep', category: 'Work' }),
    task({ title: 'Ruck route planning', category: 'Work' }),
  ];
  const m = buildModel(tasks, CATS);
  assert.equal(predictCategory(m, 'Ruck gear check').category, 'Work');
});

test('categorizer: unreviewed guesses do not teach themselves', () => {
  const tasks = [task({ title: 'Ruck test prep', category: 'Work', guessed: { category: true } })];
  const m = buildModel(tasks, CATS);
  assert.equal(predictCategory(m, 'Ruck test prep').category, 'Fitness');
});

test('suggest: duration from similar past tasks', () => {
  const tasks = [
    task({ title: 'Weekly status report', category: 'Work', durationMin: 30, actualMin: 40, done: true }),
    task({ title: 'Status report for IPT', category: 'Work', durationMin: 30, actualMin: 45, done: true }),
  ];
  const s = suggest({ title: 'Write status report', tasks, categories: CATS });
  assert.equal(s.category, 'Work');
  assert.equal(s.durationMin, 45);
  assert.equal(s.durationFrom, 'similar');
});

test('suggest: importance follows what you set on similar tasks', () => {
  const tasks = [task({ title: 'Pay credit card bill', importance: 3 }), task({ title: 'Pay water bill', importance: 3 })];
  assert.equal(suggest({ title: 'Pay power bill', tasks, categories: CATS }).importance, 3);
});

test('estimate factors learn from logged actuals', () => {
  const done = (est, act, i) => task({ title: `w${i}`, category: 'Work', done: true, estimateAtDone: est, actualMin: act, doneAt: `2026-10-1${i}T20:00:00Z` });
  const tasks = [done(60, 90, 1), done(40, 60, 2), done(30, 45, 3)];
  const f = estimateFactors(tasks);
  assert.equal(f.Work.factor, 1.5);
  assert.equal(adjustedDuration({ durationMin: 60, category: 'Work' }, f), 90);
  assert.equal(adjustedDuration({ durationMin: 60, category: 'Home' }, f), 60);
});

const evenings = { id: 'b1', name: 'Weeknights', days: WEEKDAYS, start: '19:00', end: '21:00', categories: [] };

test('plan: most urgent first, target dates reported', () => {
  const A = task({ title: 'A', durationMin: 60, deadline: '2026-10-20' });
  const B = task({ title: 'B', durationMin: 90, importance: 3 });
  const C = task({ title: 'C', durationMin: 60, deadline: TODAY });
  const p = plan({ tasks: [A, B, C], boxes: [evenings], now: at(TODAY, '08:00') });
  const todayBlocks = p.days[0].slots[0].blocks.map((b) => b.title);
  assert.deepEqual(todayBlocks, ['C', 'B']);
  assert.equal(p.byTask[C.id].targetDay, TODAY);
  assert.equal(p.byTask[A.id].targetDay, '2026-10-20');
  assert.equal(p.byTask[B.id].targetDay, '2026-10-20', 'B splits across Mon and Tue');
  assert.equal(p.atRisk.length, 0);
});

test('plan: repair pass rescues a deadline the greedy order would miss', () => {
  const box = { ...evenings, end: '20:00' };
  const X = task({ title: 'X', durationMin: 60, deadline: '2026-10-20', importance: 1 });
  const Y = task({ title: 'Y', durationMin: 120, importance: 3 });
  const p = plan({ tasks: [X, Y], boxes: [box], now: at(TODAY, '08:00') });
  assert.equal(p.byTask[X.id].late, false);
  assert.ok(p.byTask[X.id].targetDay <= '2026-10-20');
  assert.equal(p.atRisk.length, 0);
});

test('plan: impossible deadlines are flagged with the shortfall', () => {
  const T = task({ title: 'Big', durationMin: 300, deadline: '2026-10-20' });
  const p = plan({ tasks: [T], boxes: [evenings], now: at(TODAY, '08:00') });
  assert.equal(p.byTask[T.id].impossible, true);
  assert.equal(p.atRisk[0].taskId, T.id);
  assert.match(explain(p.byTask[T.id], TODAY), /Needs 5h but only 4h/);
});

test('plan: categories route tasks to the boxes that accept them', () => {
  const work = { id: 'w', name: 'Work block', days: WEEKDAYS, start: '13:00', end: '15:00', categories: ['Work'] };
  const W = task({ title: 'Review PR', durationMin: 60, category: 'Work' });
  const E = task({ title: 'Buy groceries', durationMin: 60, category: 'Errands' });
  const H = task({ title: 'Clean garage', durationMin: 60, category: 'Home' });
  const p = plan({ tasks: [W, E, H], boxes: [work, evenings], now: at(TODAY, '08:00') });
  const slots = p.days[0].slots;
  assert.deepEqual(slots.find((s) => s.boxId === 'w').blocks.map((b) => b.title), ['Review PR']);
  assert.deepEqual(new Set(slots.find((s) => s.boxId === 'b1').blocks.map((b) => b.title)), new Set(['Buy groceries', 'Clean garage']));

  const onlyWork = plan({ tasks: [H], boxes: [work], now: at(TODAY, '08:00') });
  assert.equal(onlyWork.byTask[H.id].noBox, true);
  assert.equal(onlyWork.unscheduled.length, 1);
});

test('plan: today starts from now', () => {
  const T = task({ title: 'T', durationMin: 30 });
  const p = plan({ tasks: [T], boxes: [evenings], now: at(TODAY, '19:32') });
  assert.equal(p.days[0].slots[0].start, 19 * 60 + 35);
  assert.equal(p.days[0].slots[0].blocks[0].start, 19 * 60 + 35);
});

test('plan: daily task stays on its day and skips when done', () => {
  const morning = { id: 'm', name: 'Morning', days: [0, 1, 2, 3, 4, 5, 6], start: '06:00', end: '07:00', categories: [] };
  const D = task({ title: 'Stretch', durationMin: 15, recur: { type: 'daily' } });
  const p = plan({ tasks: [D], boxes: [morning], now: at(TODAY, '05:00'), horizon: 3 });
  assert.deepEqual(p.days.map((d) => d.slots[0].blocks.length), [1, 1, 1]);
  D.history = { [TODAY]: { doneAt: 'x', actualMin: 15 } };
  const p2 = plan({ tasks: [D], boxes: [morning], now: at(TODAY, '05:00'), horizon: 3 });
  assert.deepEqual(p2.days.map((d) => d.slots[0].blocks.length), [0, 1, 1]);
});

test('occurrences: weekly-any uses a Monday-to-Sunday window', () => {
  const W = { recur: { type: 'weekly', day: null } };
  const occ = occurrences(W, '2026-10-21', addDays('2026-10-21', 9));
  assert.deepEqual(occ[0], { key: 'W:2026-10-19', start: '2026-10-21', end: '2026-10-25' });
  assert.equal(occ[1].key, 'W:2026-10-26');
});

test('plan: a non-splittable task bigger than any box gets split instead of dropped', () => {
  const T = task({ title: 'Long', durationMin: 180, splittable: false });
  const p = plan({ tasks: [T], boxes: [evenings], now: at(TODAY, '08:00') });
  assert.equal(p.byTask[T.id].forcedSplit, true);
  assert.equal(p.byTask[T.id].targetDay, '2026-10-20');
});

test('plan: progress shortens the remaining work', () => {
  const T = task({ title: 'Essay', durationMin: 120, progressMin: 90 });
  const p = plan({ tasks: [T], boxes: [evenings], now: at(TODAY, '08:00') });
  assert.equal(p.byTask[T.id].remaining, 30);
});

test('plan: when two deadlines collide, the higher priority task keeps its date', () => {
  const report = task({ title: 'Status report', durationMin: 60, deadline: '2026-10-21', importance: 3 });
  const paper = task({ title: 'Final paper', durationMin: 330, deadline: '2026-10-21' }); // 6h of boxes before Wed, 6h30 of work
  const p = plan({ tasks: [paper, report], boxes: [evenings], now: at(TODAY, '18:30') });
  assert.equal(p.byTask[report.id].late, false);
  assert.equal(p.byTask[paper.id].late, true);
  assert.deepEqual(p.atRisk.map((s) => s.taskId), [paper.id]);
});
