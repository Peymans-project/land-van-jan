import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

function loadPureFunction(name, nextName) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`\nfunction ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} is aanwezig`);
  assert.notEqual(end, -1, `${nextName} volgt op ${name}`);
  const source = appSource.slice(start, end);
  return Function('ACTIVITY_TIME_ZONE', `${source}; return ${name};`)('Europe/Amsterdam');
}

test('activity dates are rendered as Europe/Amsterdam instants in winter and summer', () => {
  const toLocalInput = loadPureFunction('toLocalInput', 'AdminDashboard');
  assert.equal(toLocalInput('2026-01-15T09:00:00.000Z'), '2026-01-15T10:00');
  assert.equal(toLocalInput('2026-08-02T08:00:00.000Z'), '2026-08-02T10:00');

  const formatActivity = loadPureFunction('formatActivity', 'formatActivityDateTime');
  assert.deepEqual(formatActivity({
    startsAt: '2026-08-02T22:30:00.000Z',
    endsAt: '2026-08-02T23:30:00.000Z',
  }), { day: 'MA', date: '03', month: 'AUG', time: '00:30 – 01:30' });
});

test('admin submits the wall-clock values that were entered, without browser timezone conversion', () => {
  assert.match(appSource, /startsAt: data\.get\('startsAt'\), endsAt: data\.get\('endsAt'\)/);
  assert.doesNotMatch(appSource, /new Date\(data\.get\('startsAt'\)\)\.toISOString\(\)/);
  assert.match(appSource, /timeZone: ACTIVITY_TIME_ZONE/);
});

test('Stripe return handling is explicit, bounded and suppresses a duplicate checkout action', () => {
  assert.match(appSource, /value === 'geslaagd' \|\| value === 'geannuleerd'/);
  assert.match(appSource, /PAYMENT_RECONCILE_DELAYS_MS = \[[^\]]+\]/);
  assert.match(appSource, /window\.setTimeout\(\(\) => pollProfile/);
  assert.doesNotMatch(appSource, /setInterval\([^)]*pollProfile/);
  assert.match(appSource, /Start geen tweede betaling/);
  assert.match(appSource, /paymentNeedsReconciliation \? refreshPaymentStatus : manageMembership/);
});
