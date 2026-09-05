import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
test('actual build excludes drafts, future posts and expired offers everywhere', async () => {
  const cache = path.resolve(root, '.cache');
  await mkdir(cache, { recursive: true });
  const fixture = await mkdtemp(path.join(cache, 'publication-test-'));
  assert.equal(path.dirname(path.resolve(fixture)), cache);
  try {
    for (const item of ['src', 'lib', 'eleventy.config.js', 'CNAME']) await cp(path.join(root, item), path.join(fixture, item), { recursive: true });
    for (const [slug, extra] of [['draft-leak', 'draft: true'], ['future-leak', 'draft: false']]) {
      await writeFile(path.join(fixture, 'src/posts', slug + '.md'), `---\ntitle: "Never publish ${slug}"\ndescription: "Regression fixture"\ncategory: Kubernetes\ndate: ${slug === 'future-leak' ? '2999-01-01' : '2020-01-01'}\n${extra}\n---\nDo not expose this fixture.\n`);
    }
    await writeFile(path.join(fixture, 'src/posts/escape-title.md'), `---\ntitle: '<script>alert(1)</script>'\ndescription: 'Test "quotes" & entities'\ncategory: Terraform\ndate: 2020-01-01\n---\nA safely escaped title.\n`);
    const valid = { id: 'test-active', title: 'Synthetic fixture offer', provider: 'Test provider', description: 'Fixture only',
      offer: 'TEST ONLY', url: 'https://example.com/test', verifiedAt: '2020-01-01T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z', affiliate: true, sponsored: true };
    await writeFile(path.join(fixture, 'src/_data/offers.json'), JSON.stringify([valid, { ...valid, id: 'test-expired', title: 'EXPIRED-OFFER-LEAK', expiresAt: '2020-01-02T00:00:00Z' }]));
    await exec(process.execPath, [path.join(root, 'node_modules/@11ty/eleventy/cmd.cjs')], { cwd: fixture, timeout: 30_000 });
    for (const slug of ['draft-leak', 'future-leak']) {
      await assert.rejects(access(path.join(fixture, '_site/blog', slug)));
      for (const file of ['index.html', 'blog/index.html', 'topics/kubernetes/index.html', 'feed.xml', 'search-index.json', 'sitemap.xml']) {
        assert.ok(!(await readFile(path.join(fixture, '_site', file), 'utf8')).includes(slug), `${file} leaked ${slug}`);
      }
    }
    const article = await readFile(path.join(fixture, '_site/blog/escape-title/index.html'), 'utf8');
    assert.ok(!article.includes('<script>alert(1)</script>'));
    assert.ok(article.includes('&lt;script&gt;'));
    const learning = await readFile(path.join(fixture, '_site/learning/index.html'), 'utf8');
    assert.ok(!learning.includes('EXPIRED-OFFER-LEAK'));
    assert.ok(learning.includes('Affiliate link:'));
    assert.ok(learning.includes('Sponsored placement.'));
    assert.ok(learning.includes('rel="sponsored nofollow noopener noreferrer"'));
  } finally {
    // This is the unique test-owned directory checked above, never a source directory.
    if (path.dirname(path.resolve(fixture)) !== cache) throw new Error('Unsafe fixture cleanup target');
    await rm(fixture, { recursive: true, force: true });
  }
});
