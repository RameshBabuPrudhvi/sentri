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
  runSingleTest: (testId) => req("POST", `/tests/${testId}/run`),

  // Tests
  getTests: (id) => req("GET", `/projects/${id}/tests`),
  getTest: (testId) => req("GET", `/tests/${testId}`),
  createTest: (projectId, data) => req("POST", `/projects/${projectId}/tests`, data),
  generateTest: (projectId, data) => req("POST", `/projects/${projectId}/tests/generate`, data),
  deleteTest: (projectId, testId) => req("DELETE", `/projects/${projectId}/tests/${testId}`),

  // Test review actions (draft → approved / rejected)
  approveTest: (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/approve`),
  rejectTest: (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/reject`),
  restoreTest: (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/restore`),
  bulkUpdateTests: (projectId, testIds, action) =>
    req("POST", `/projects/${projectId}/tests/bulk`, { testIds, action }),

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
