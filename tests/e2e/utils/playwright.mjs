let playwrightTest;

try {
  playwrightTest = await import('@playwright/test');
} catch {
  playwrightTest = await import('../../../backend/node_modules/@playwright/test/index.mjs');
}

export const {
  defineConfig,
  test,
  expect,
  request,
} = playwrightTest;
