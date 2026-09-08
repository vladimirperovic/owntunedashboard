const { defineConfig } = require('@playwright/test');
const port = Number(process.env.OWNTONE_TEST_PORT || 4185);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/static-server.js',
    env: { PORT: String(port) },
    url: baseURL,
    // A different project may already occupy a development port. Never run
    // this suite against an arbitrary server simply because it returns 200.
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
