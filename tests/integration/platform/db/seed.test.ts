import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { transactionFixture } from '../../../helpers/transactions.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const pool = databaseFixture();
const transaction = transactionFixture(pool);
const clock = { now: () => new Date('2026-10-10T04:01:00Z') };

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed(clock));
}, 120000);

test('pointStarSeed loads and yields 4 role holders, 3 active channels, 8 rules, 7 open review items and 5 decisions', async () => {
  const result = await transaction().query(`SELECT
    (SELECT count(DISTINCT person_id)::int FROM role_members WHERE kind = 'member') AS holders,
    (SELECT count(*)::int FROM channels WHERE connection_status = 'active' AND monitored) AS channels,
    (SELECT count(*)::int FROM rules) AS rules,
    (SELECT count(*)::int FROM review_items WHERE resolved_at IS NULL) AS reviews,
    (SELECT count(*)::int FROM decisions) AS decisions`);
  expect(result.rows).toEqual([{ holders: 4, channels: 3, rules: 8, reviews: 7, decisions: 5 }]);
});

test('Point Star has 124 work items touched this week, 12 completed today, and the eight sample rule match counts', async () => {
  const result = await transaction().query(
    `SELECT
    (SELECT count(*)::int FROM threads WHERE last_activity_at >= $1::timestamptz - interval '7 days') AS touched,
    (SELECT count(*)::int FROM threads WHERE status = 'completed' AND closed_at >= date_trunc('day', $1::timestamptz, 'Asia/Jakarta')) AS completed`,
    [clock.now()],
  );
  expect(result.rows).toEqual([{ touched: 124, completed: 12 }]);
  const matches = await transaction().query(`SELECT count(match.label_id)::int AS count
    FROM rules AS rule LEFT JOIN label_rule_matches AS match ON match.rule_id = rule.id
    GROUP BY rule.id, rule.name ORDER BY rule.name`);
  expect(
    matches.rows.map((row: { count: number }) => row.count).sort((left, right) => left - right),
  ).toEqual([3, 4, 6, 8, 10, 22, 48, 64]);
});

test('The Point Star seed fixes ORD-0091 at 19 silent hours against a 12-hour stage threshold', async () => {
  const result = await transaction().query(
    `SELECT extract(epoch FROM ($1::timestamptz - thread.last_activity_at)) / 3600 AS hours,
    threshold.value, thread.status FROM threads AS thread JOIN thresholds AS threshold ON threshold.scope_id = thread.domain_id
    WHERE thread.display_id = 'ORD-0091' AND threshold.key = 'stalled_after_hours'`,
    [clock.now()],
  );
  expect(result.rows).toEqual([
    { hours: '19.0000000000000000', value: '12.0000', status: 'active' },
  ]);
});

test('Point Star aggregates render 1284 messages and 156 deliveries today, 8426 and 984 over seven days, and 48 active work items', async () => {
  const result = await transaction().query(
    `SELECT
    (SELECT count(*)::int FROM units WHERE triage_class <> 'NOISE' AND ts_last >= date_trunc('day', $1::timestamptz, 'Asia/Jakarta')) AS messages_today,
    (SELECT count(*)::int FROM units WHERE triage_class <> 'NOISE' AND ts_last >= $1::timestamptz - interval '7 days') AS messages_week,
    (SELECT count(*)::int FROM notifications WHERE sent_at >= date_trunc('day', $1::timestamptz, 'Asia/Jakarta')) AS sent_today,
    (SELECT count(*)::int FROM notifications WHERE sent_at >= $1::timestamptz - interval '7 days') AS sent_week,
    (SELECT count(*)::int FROM threads WHERE status = 'active') AS active_work`,
    [clock.now()],
  );
  expect(result.rows).toEqual([
    { messages_today: 1284, messages_week: 8426, sent_today: 156, sent_week: 984, active_work: 48 },
  ]);
});
