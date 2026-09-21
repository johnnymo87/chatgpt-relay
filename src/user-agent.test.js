import { test } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright';
import { normalizeUserAgent, resolveUserAgent } from './user-agent.js';

const HEADLESS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/143.0.7499.4 Safari/537.36';
const HEADED_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

test('normalizeUserAgent rewrites HeadlessChrome to the reduced headed Chrome UA', () => {
  assert.strictEqual(normalizeUserAgent(HEADLESS_UA), HEADED_UA);
});

test('normalizeUserAgent leaves an already-headed UA unchanged', () => {
  assert.strictEqual(normalizeUserAgent(HEADED_UA), HEADED_UA);
});

test('normalizeUserAgent reduces a headed UA that carries a full build number', () => {
  const full =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.4 Safari/537.36';
  const reduced =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
  assert.strictEqual(normalizeUserAgent(full), reduced);
});

test('normalizeUserAgent preserves the platform token on Linux', () => {
  const linuxHeadless =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/143.0.7499.4 Safari/537.36';
  assert.match(normalizeUserAgent(linuxHeadless), /\(X11; Linux x86_64\)/);
  assert.doesNotMatch(normalizeUserAgent(linuxHeadless), /Headless/);
});

test('normalizeUserAgent returns null for a UA with no Chrome token', () => {
  const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0';
  assert.strictEqual(normalizeUserAgent(firefox), null);
});

test('normalizeUserAgent returns null for empty or missing input', () => {
  assert.strictEqual(normalizeUserAgent(''), null);
  assert.strictEqual(normalizeUserAgent(undefined), null);
});

test('resolveUserAgent strips the Headless token from a real headless browser', async (t) => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());

  const ua = await resolveUserAgent(browser);

  assert.ok(ua, 'expected a resolved user agent');
  assert.doesNotMatch(ua, /Headless/);
  assert.match(ua, /Chrome\/\d+\.0\.0\.0 /);
});

test('resolveUserAgent output is actually applied to a context created with it', async (t) => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());

  const ua = await resolveUserAgent(browser);
  const context = await browser.newContext({ userAgent: ua });
  const page = await context.newPage();
  const seen = await page.evaluate(() => navigator.userAgent);
  await context.close();

  assert.strictEqual(seen, ua);
  assert.doesNotMatch(seen, /Headless/);
});
