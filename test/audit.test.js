import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { advisories, auditResult, validateExceptions } from '../lib/audit.js';

const now = new Date('2026-10-11T12:00:00Z');
const advisory = (name, id, severity) => ({ name, severity, title: `${name} issue`, url: `https://github.com/advisories/${id}`, source: 1 });
const report = { vulnerabilities: {
  braces: { severity: 'high', via: [advisory('braces', 'GHSA-aaaa', 'high')] },
  chokidar: { severity: 'high', via: ['braces'] },
  lodash: { severity: 'critical', via: [advisory('lodash', 'GHSA-bbbb', 'critical')] },
  'sprintf-js': { severity: 'moderate', via: [advisory('sprintf-js', 'GHSA-cccc', 'moderate')] }
} };
const exception = { id: 'GHSA-aaaa', package: 'braces', reason: 'Test fixture', reviewedAt: '2026-10-01', expiresAt: '2026-12-31T00:00:00Z' };

test('only high and critical advisories are collected, once each', () => {
  assert.deepEqual(advisories(report).map(item => item.id).sort(), ['GHSA-aaaa', 'GHSA-bbbb']);
});

test('a reviewed exception accepts exactly its advisory and nothing else', () => {
  const result = auditResult(report, [exception], now);
  assert.deepEqual(result.accepted.map(item => item.id), ['GHSA-aaaa']);
  assert.deepEqual(result.blocking.map(item => item.id), ['GHSA-bbbb']);
  const otherPackage = auditResult(report, [{ ...exception, package: 'chokidar' }], now);
  assert.ok(otherPackage.blocking.some(item => item.id === 'GHSA-aaaa'));
});

test('expired exceptions block again and unused ones are reported', () => {
  const expired = auditResult(report, [{ ...exception, expiresAt: '2026-10-10T00:00:00Z' }], now);
  assert.ok(expired.blocking.some(item => item.id === 'GHSA-aaaa'));
  assert.equal(expired.expired.length, 1);
  const unused = auditResult({ vulnerabilities: {} }, [exception], now);
  assert.equal(unused.unused.length, 1);
  assert.equal(unused.blocking.length, 0);
});

test('exceptions need a reason, valid dates and an expiry after review', () => {
  assert.throws(() => validateExceptions([{ ...exception, reason: '' }]), /reason/);
  assert.throws(() => validateExceptions([{ ...exception, expiresAt: 'soon' }]), /invalid date/);
  assert.throws(() => validateExceptions([{ ...exception, expiresAt: '2026-09-01T00:00:00Z' }]), /expire after/);
});

test('the repository exception file is valid and time-boxed', async () => {
  const exceptions = JSON.parse(await readFile(new URL('../audit-exceptions.json', import.meta.url), 'utf8'));
  validateExceptions(exceptions);
  for (const item of exceptions) {
    const days = (new Date(item.expiresAt) - new Date(item.reviewedAt)) / 86400000;
    assert.ok(days <= 120, `${item.id} must be reviewed again within 120 days`);
  }
});
