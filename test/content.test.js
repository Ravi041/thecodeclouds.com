import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOffers, isPublished, validatePost, readingTime, plainText, json } from '../lib/content.js';

const now = new Date('2026-09-05T12:00:00Z');
const valid = { id: 'test-only', title: 'Test fixture', provider: 'Example', description: 'Not a published offer',
  url: 'https://example.com/course', offer: 'Test fixture only', verifiedAt: '2026-09-04T00:00:00Z',
  expiresAt: '2026-09-06T23:59:59Z', affiliate: false, sponsored: false };

test('draft and future posts stay unpublished', () => {
  assert.equal(isPublished({ draft: true }, now), false);
  assert.equal(isPublished({ draft: false, date: '2026-09-06' }, now), false);
  assert.equal(isPublished({ date: now.toISOString() }, now), true);
});
test('post metadata rejects incomplete dates, topics and ambiguous draft flags', () => {
  const post = { title: 'Title', description: 'Summary', date: '2026-09-05', category: 'Kubernetes' };
  assert.doesNotThrow(() => validatePost(post));
  for (const patch of [{ date: 'bad-date' }, { category: 'Unknown' }, { description: '' }, { draft: 'false' }, { updated: '2020-01-01' }]) {
    assert.throws(() => validatePost({ ...post, ...patch }));
  }
});
test('empty offers stay empty, not replaced with placeholder coupons', () => assert.deepEqual(activeOffers([], now), []));
test('only unexpired, non-draft offers are shown', () => {
  assert.deepEqual(activeOffers([valid], now), [valid]);
  assert.deepEqual(activeOffers([{ ...valid, expiresAt: now.toISOString() }], now), []);
  assert.deepEqual(activeOffers([{ ...valid, draft: true }], now), []);
});
test('offers require explicit disclosure flags and checked terms', () => {
  for (const key of ['title', 'url', 'provider', 'description', 'offer', 'verifiedAt', 'expiresAt', 'affiliate', 'sponsored']) {
    const offer = { ...valid }; delete offer[key];
    assert.throws(() => activeOffers([offer], now), key);
  }
});
test('duplicate offer IDs are rejected', () => assert.throws(() => activeOffers([valid, valid], now), /Duplicate/));
test('offer draft flags cannot accidentally publish a string value', () => assert.throws(() => activeOffers([{ ...valid, draft: 'true' }], now)));
test('offer links reject executable and insecure schemes', () => {
  for (const url of ['javascript:alert(1)', 'http://example.com', '/relative', 'data:text/html,example', 'https://user:password@example.com']) {
    assert.throws(() => activeOffers([{ ...valid, url }], now));
  }
});
test('article covers require descriptive alt text and safe local paths', () => {
  const post = { title: 'Title', description: 'Summary', date: '2026-09-05', category: 'Kubernetes' };
  assert.doesNotThrow(() => validatePost({ ...post, coverImage: '/assets/images/cover.webp', coverImageAlt: 'A described diagram' }));
  for (const coverImage of ['https://example.com/image.png', '/assets/images/../secret.png', 'javascript:alert(1)']) {
    assert.throws(() => validatePost({ ...post, coverImage, coverImageAlt: 'Description' }));
  }
  assert.throws(() => validatePost({ ...post, coverImage: '/assets/images/cover.png' }));
});
test('offer times reject ambiguity and future verification', () => {
  for (const patch of [{ expiresAt: 'invalid' }, { expiresAt: '2026-09-10' },
    { expiresAt: '2026-09-03T00:00:00Z' }, { verifiedAt: '2026-09-06T00:00:00Z' }]) {
    assert.throws(() => activeOffers([{ ...valid, ...patch }], now));
  }
});
test('reading time has a one-minute minimum and ignores tags', () => {
  assert.equal(readingTime(''), 1);
  assert.equal(readingTime('<p>' + 'word '.repeat(440) + '</p>'), 2);
  assert.equal(plainText('<p>Hello</p>\n<strong>cloud</strong>'), 'Hello cloud');
});
test('JSON serialization is safe to embed in a script element', () => {
  const input = { title: '</script><script>alert(1)</script>' };
  const encoded = json(input);
  assert.ok(!encoded.includes('</script>'));
  assert.deepEqual(JSON.parse(encoded), input);
});
