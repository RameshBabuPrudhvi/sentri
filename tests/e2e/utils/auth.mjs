/**
 * Register a fresh user account via API.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<{email: string, password: string}>}
 */
export async function registerUser(request) {
  const password = 'Password123!';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const stamp = Date.now();
    const email = `e2e-${stamp}-${attempt}@example.test`;
    const name = `E2E ${stamp}`;
    const res = await request.post('/api/v1/auth/register', {
      data: { name, email, password },
    });

    if ([200, 201, 409].includes(res.status())) {
      return { email, password };
    }

    if (res.status() === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      continue;
    }

    const body = await safeJson(res);
    throw new Error(`register failed (${res.status()}): ${JSON.stringify(body)}`);
  }
  throw new Error('register retries exhausted');
}

/**
 * Safely parse json from API response.
 *
 * @param {import('@playwright/test').APIResponse} response
 * @returns {Promise<any>}
 */
export async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return { raw: await response.text() };
  }
}

/**
 * Login with basic retry when rate-limited.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('@playwright/test').APIResponse>}
 */
export async function loginWithRetry(request, email, password) {
  let lastRes = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await request.post('/api/v1/auth/login', {
      data: { email, password },
    });
    lastRes = res;
    if (res.status() !== 429) return res;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt));
  }
  return lastRes;
}
