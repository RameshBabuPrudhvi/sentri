import { request } from './playwright.mjs';

/**
 * Check whether an HTTP endpoint is reachable.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function isReachable(url) {
  try {
    const ctx = await request.newContext();
    const res = await ctx.get(url, { timeout: 5000 });
    await ctx.dispose();
    return res.status() < 500;
  } catch {
    return false;
  }
}
