import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeOffers } from '../lib/content.js';

const output = fileURLToPath(new URL('../_site/', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const decode = value => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(filename));
    else if (entry.name.endsWith('.html')) files.push(filename);
  }
  return files;
}

test('all generated local links, images, scripts and anchors resolve', async () => {
  const files = await htmlFiles(output);
  assert.ok(files.length >= 18, 'expected the complete publication');
  for (const file of files) {
    const html = (await readFile(file, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
    const relative = path.relative(output, file).replaceAll(path.sep, '/');
    const pageUrl = new URL(relative.replace(/index\.html$/, ''), 'https://thecodeclouds.com/');
    for (const [, attribute] of html.matchAll(/(?:href|src|action)="([^"]+)"/g)) {
      const link = new URL(decode(attribute), pageUrl);
      assert.ok(!['javascript:', 'data:'].includes(link.protocol), `${relative}: unsafe link`);
      if (link.origin !== pageUrl.origin) continue;
      let target = path.join(output, decodeURIComponent(link.pathname));
      const info = await stat(target).catch(() => null);
      assert.ok(info, `${relative}: missing ${attribute}`);
      if (info.isDirectory()) target = path.join(target, 'index.html');
      await access(target);
      if (link.hash && target.endsWith('.html')) {
        const targetHTML = await readFile(target, 'utf8');
        assert.ok(targetHTML.includes(`id="${decodeURIComponent(link.hash.slice(1))}"`), `${relative}: missing anchor ${attribute}`);
      }
    }
  }
});
test('canonical domain and Pages marker are preserved', async () => {
  assert.equal((await readFile(path.join(output, 'CNAME'), 'utf8')).trim(), 'thecodeclouds.com');
  await access(path.join(output, '.nojekyll'));
  assert.match(await readFile(path.join(output, 'robots.txt'), 'utf8'), /https:\/\/thecodeclouds.com\/sitemap.xml/);
});
test('article metadata and search index refer to the actual articles', async () => {
  const index = JSON.parse(await readFile(path.join(output, 'search-index.json'), 'utf8'));
  assert.ok(index.length >= 1);
  for (const record of index) {
    const html = await readFile(path.join(output, record.url, 'index.html'), 'utf8');
    assert.ok(decode(html).includes(`<meta property="og:title" content="${record.title}">`));
    assert.match(html, /<meta property="og:type" content="article">/);
    assert.ok(html.includes(`https://thecodeclouds.com${record.url}`));
    assert.ok(record.text.length > 200);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
  }
});
test('feed and sitemap include all published starter articles', async () => {
  const index = JSON.parse(await readFile(path.join(output, 'search-index.json'), 'utf8'));
  const feed = await readFile(path.join(output, 'feed.xml'), 'utf8');
  const sitemap = await readFile(path.join(output, 'sitemap.xml'), 'utf8');
  assert.ok(feed.startsWith('<?xml'));
  assert.ok(sitemap.startsWith('<?xml'));
  for (const record of index.slice(0, 30)) assert.ok(feed.includes(`https://thecodeclouds.com${record.url}`));
  for (const record of index) {
    assert.ok(sitemap.includes(`https://thecodeclouds.com${record.url}`));
  }
  assert.ok(!sitemap.includes('/404.html'));
  assert.ok(!sitemap.includes('/search/'));
});
test('no invented discounts, templates or source are shipped', async () => {
  const page = await readFile(path.join(output, 'learning/index.html'), 'utf8');
  const offers = activeOffers(JSON.parse(await readFile(path.join(root, 'src/_data/offers.json'), 'utf8')));
  if (!offers.length) assert.match(page, /No active discount codes right now/);
  assert.equal((page.match(/class="offer-card"/g) || []).length, offers.length);
  assert.ok(!page.includes('REPLACE-WITH-REAL-CODE'));
  for (const filename of ['templates', 'package.json', 'lib', '.github', 'README.md']) {
    await assert.rejects(access(path.join(output, filename)));
  }
});
test('ordinary publication pages do not load third-party scripts or fonts', async () => {
  for (const file of await htmlFiles(output)) {
    if (file.includes(`${path.sep}portfolio${path.sep}`)) continue;
    const html = await readFile(file, 'utf8');
    assert.ok(!/<script[^>]+src="https?:/.test(html));
    assert.ok(!html.includes('fonts.googleapis.com'));
  }
});
test('theme bootstrap precedes styles and article covers have social metadata and bounded weight', async () => {
  const homepage = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.ok(homepage.indexOf('/assets/js/theme.js') < homepage.indexOf('/assets/css/site.css'));
  assert.match(homepage, /class="theme-toggle"[^>]+aria-label="Dark mode"[^>]+aria-pressed="false"/);
  for (const [slug, image] of [['kubernetes-pod-troubleshooting', 'kubernetes-troubleshooting'], ['choose-a-course-with-a-project', 'project-learning']]) {
    const html = await readFile(path.join(output, 'blog', slug, 'index.html'), 'utf8');
    assert.ok(html.includes(`<meta property="og:image" content="https://thecodeclouds.com/assets/images/${image}.jpg">`));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.match(html, /class="post-cover"[^>]+alt="[^"]+"/);
    assert.match(html, /AI-generated editorial/);
    assert.ok((await stat(path.join(output, 'assets/images', image + '.jpg'))).size < 200_000);
  }
});
