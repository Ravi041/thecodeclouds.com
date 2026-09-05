import { chromium, devices } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../_site/', import.meta.url));
const screenshots = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filename = path.resolve(root, '.' + pathname);
    if (filename !== path.resolve(root) && !filename.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403).end(); return; }
    if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
    res.writeHead(200, { 'content-type': (types[path.extname(filename)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(await readFile(filename));
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(path.join(root, '404.html')));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const [viewportName, options] of [['desktop', { viewport: { width: 1440, height: 1050 } }], ['mobile', devices['iPhone 13']]]) {
  for (const colorScheme of ['light', 'dark']) {
    const name = `${viewportName}-${colorScheme}`;
    const context = await browser.newContext({ ...options, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    const theme = page.getByRole('button', { name: 'Dark mode', exact: true });
    assert.equal(await theme.getAttribute('aria-pressed'), String(colorScheme === 'dark'));
    await theme.focus();
    await page.keyboard.press('Space');
    assert.equal(await theme.getAttribute('aria-pressed'), String(colorScheme !== 'dark'));
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await theme.getAttribute('aria-pressed'), String(colorScheme !== 'dark'), 'preference persists on reload');
    await theme.click();
    await theme.blur();
    await page.screenshot({ path: path.join(screenshots, `${name}-home.png`), fullPage: true });
    await page.screenshot({ path: path.join(screenshots, `${name}-preview.png`), fullPage: false, scale: 'css' });
    assert.match(await page.title(), /The Code Clouds/);
    assert.equal(await page.locator('h1').count(), 1);
    if (viewportName === 'mobile') {
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Articles', exact: true }).click();
      await page.waitForURL('**/blog/');
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Articles', exact: true }).focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded'), 'false');
    }
    for (const route of ['/', '/blog/', '/topics/', '/topics/terraform/', '/learning/', '/about/', '/blog/kubernetes-pod-troubleshooting/', '/search/', '/privacy/', '/disclosure/', '/404.html']) {
      await page.goto(base + route, { waitUntil: 'networkidle' });
      assert.equal(await theme.getAttribute('aria-pressed'), String(colorScheme === 'dark'), 'preference persists across routes');
      assert.equal(await page.evaluate(() => [...document.images].some(img => img.complete && img.naturalWidth === 0)), false, `${name} broken image: ${route}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${name} horizontal overflow: ${route}`);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(audit.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })), [], `${name} accessibility: ${route}`);
    }
    await page.goto(base + '/search/?q=Terraform');
    await page.getByRole('status').filter({ hasText: 'found for' }).waitFor();
    assert.ok(await page.locator('.search-result').count() >= 1);
    await page.getByRole('searchbox', { name: 'Search articles' }).fill('zzzz-no-such-article');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'No articles found' }).waitFor();
    await page.getByRole('searchbox', { name: 'Search articles' }).fill('<img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'No articles found' }).waitFor();
    assert.equal(await page.locator('#search-results img').count(), 0);
    await page.clock.install();
    await page.goto(base + '/learning/');
    await page.locator('#offers-empty').waitFor({ state: 'visible' });
    // Synthetic expired fixture verifies expiry logic without publishing a fake deal.
    await page.evaluate(() => {
      const card = document.createElement('article');
      card.dataset.expires = '2000-01-01T00:00:00Z';
      card.id = 'expired-test-offer';
      document.querySelector('#offers-heading').after(card);
    });
    await page.clock.fastForward(60_001);
    await page.waitForFunction(() => document.querySelector('#expired-test-offer').hidden);
    await page.screenshot({ path: path.join(screenshots, `${name}-learning.png`), fullPage: true });
    await page.goto(base + '/blog/kubernetes-pod-troubleshooting/');
    await page.screenshot({ path: path.join(screenshots, `${name}-article.png`), fullPage: true });
    assert.deepEqual(errors, [], `${name} JavaScript errors`);
    await context.close();
    console.log(`${name}: navigation, search, overflow, expiry and 11 accessibility checks passed`);
  }
  }
  for (const colorScheme of ['light', 'dark']) {
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(base);
  assert.equal(await page.locator('.theme-toggle').isVisible(), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), colorScheme);
  assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).isVisible(), true);
  await page.goto(base + '/blog/kubernetes-pod-troubleshooting/');
  assert.match(await page.locator('.prose').innerText(), /kubectl/);
  await page.goto(base + '/search/');
  assert.equal(await page.locator('#search-fallback').isVisible(), true);
  assert.equal(await page.locator('#search-form').isVisible(), false);
  await context.close();
  console.log(`No-JavaScript ${colorScheme}: system theme, reading, navigation and search fallback passed`);
  }
  const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 320, height: 740 } });
  const page = await context.newPage();
  await page.goto(base);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px overflow');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'explicit preference wins over system changes');
  await context.close();
  const blocked = await browser.newContext({ colorScheme: 'dark' });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Disabled', 'SecurityError'); } }));
  const blockedPage = await blocked.newPage();
  const blockedErrors = [];
  blockedPage.on('pageerror', error => blockedErrors.push(error.message));
  await blockedPage.goto(base);
  await blockedPage.getByRole('button', { name: 'Dark mode', exact: true }).click();
  assert.equal(await blockedPage.locator('html').getAttribute('data-theme'), 'light');
  assert.deepEqual(blockedErrors, []);
  await blocked.close();
  console.log('System preference, explicit override, narrow viewport and blocked-storage fallback passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
