const BASE = "/api";

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

export const api = {
  // Projects
  createProject: (data) => req("POST", "/projects", data),
  getProjects: () => req("GET", "/projects"),
  getProject: (id) => req("GET", `/projects/${id}`),
  deleteProject: (id) => req("DELETE", `/projects/${id}`),

  // Crawl & Run
  crawl: (id) => req("POST", `/projects/${id}/crawl`),
  runTests: (id) => req("POST", `/projects/${id}/run`),

  // Tests
  getTests: (id) => req("GET", `/projects/${id}/tests`),
  deleteTest: (projectId, testId) => req("DELETE", `/projects/${projectId}/tests/${testId}`),

  // Runs
  getRuns: (id) => req("GET", `/projects/${id}/runs`),
  getRun: (runId) => req("GET", `/runs/${runId}`),

  // Dashboard
  getDashboard: () => req("GET", "/dashboard"),

  // Config & Settings
  getConfig: () => req("GET", "/config"),
  getSettings: () => req("GET", "/settings"),
  saveApiKey: (provider, apiKey) => req("POST", "/settings", { provider, apiKey }),
  deleteApiKey: (provider) => req("DELETE", `/settings/${provider}`),
};
