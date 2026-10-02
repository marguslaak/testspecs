import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4310);

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node --import tsx src/main.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATABASE_PATH: ":memory:", DEV_LOGIN: "1", AI_ESTIMATION_PROVIDER: "heuristic" },
  },
});
