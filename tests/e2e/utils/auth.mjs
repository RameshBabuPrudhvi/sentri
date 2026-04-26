/**
 * Register a fresh user account via API.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<{email: string, password: string}>}
 */
export async function registerUser(request) {
  const stamp = Date.now();
  const email = `e2e-${stamp}@example.test`;
  const password = 'Password123!';
  const name = `E2E ${stamp}`;

  const res = await request.post('/api/v1/auth/register', {
    data: { name, email, password },
  });

  if (![200, 201, 409].includes(res.status())) {
    const body = await safeJson(res);
    throw new Error(`register failed (${res.status()}): ${JSON.stringify(body)}`);
  }

  return { email, password };
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
