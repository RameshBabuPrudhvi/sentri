/**
 * Minimal stateful API client for Sentri auth+CSRF flows.
 */
export class SessionClient {
  /**
   * @param {import('@playwright/test').APIRequestContext} request
   */
  constructor(request) {
    this.request = request;
    this.csrfToken = '';
  }

  /**
   * @param {'get'|'post'|'patch'|'delete'} method
   * @param {string} url
   * @param {{ data?: any, params?: Record<string,string> }} [opts]
   */
  async call(method, url, opts = {}) {
    if (!this.csrfToken && method !== 'get') {
      const state = await this.request.storageState();
      const csrfCookie = (state.cookies || []).find((c) => c.name === '_csrf');
      if (csrfCookie?.value) this.csrfToken = csrfCookie.value;
    }
    const headers = {};
    if (this.csrfToken && method !== 'get') headers['X-CSRF-Token'] = this.csrfToken;

    const response = await this.request[method](url, {
      ...opts,
      headers,
    });

    const next = response.headers()['x-csrf-token'];
    if (next) this.csrfToken = next;
    return response;
  }
}
