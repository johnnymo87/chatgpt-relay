/**
 * User-Agent normalization.
 *
 * Playwright's headless Chromium reports a UA containing the literal token
 * `HeadlessChrome/<full.build.number>`, while the headed browser used by
 * `ask-question-login` reports Chrome's reduced UA (`Chrome/<major>.0.0.0`).
 *
 * That mismatch matters because Cloudflare binds the `cf_clearance` cookie to
 * the User-Agent that earned it. A clearance minted during headed login is
 * therefore invalid when the headless daemon replays it, and Cloudflare
 * re-challenges with Turnstile. The `HeadlessChrome` token is additionally a
 * trivial bot signal in its own right.
 *
 * Both entry points resolve their UA through here so login and daemon present
 * one identical, non-headless User-Agent - and so the value tracks Chromium
 * version bumps instead of rotting in a hardcoded string.
 */

// Matches the Chrome/HeadlessChrome product token and its version, e.g.
// "HeadlessChrome/143.0.7499.4" or "Chrome/143.0.0.0".
const CHROME_TOKEN = /\b(?:Headless)?Chrome\/(\d+)(?:\.[\d.]+)?/;

/**
 * Rewrite a Chromium User-Agent into the reduced, non-headless form that a
 * headed Chrome reports: `Chrome/<major>.0.0.0`.
 *
 * @param {string|undefined|null} ua - Raw navigator.userAgent value.
 * @returns {string|null} Normalized UA, or null if `ua` has no Chrome token.
 */
export function normalizeUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return null;

  const match = ua.match(CHROME_TOKEN);
  if (!match) return null;

  return ua.replace(CHROME_TOKEN, `Chrome/${match[1]}.0.0.0`);
}

/**
 * Read the browser's own default User-Agent and normalize it.
 *
 * Deliberately derived from the live browser rather than hardcoded, so the
 * value stays correct across Playwright/Chromium upgrades and across
 * platforms (the platform token differs between macOS and Linux).
 *
 * Best-effort: returns null if the UA cannot be read or has no Chrome token,
 * in which case callers should fall back to Playwright's default.
 *
 * @param {import('playwright').Browser} browser
 * @returns {Promise<string|null>}
 */
export async function resolveUserAgent(browser) {
  let context = null;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    return normalizeUserAgent(ua);
  } catch {
    return null;
  } finally {
    try { await context?.close(); } catch { /* best effort */ }
  }
}
