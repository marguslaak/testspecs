import { configFromEnv, createApp } from "./app/bootstrap.js";

const config = configFromEnv();
const { server, service, store } = createApp(config);
const port = Number(process.env.PORT ?? 3000);

server.listen(port, () => {
  console.log(`Offer Management Platform listening on http://localhost:${port}`);
  console.log(`  internal workspace: http://localhost:${port}/`);
  console.log(`  vendor portal:      http://localhost:${port}/portal`);
  console.log(`  AI estimation:      ${config.estimationProvider.name}`);
  if (config.devLogin) console.log("  development login is ENABLED (demo identities)");
});

const shutdown = async () => {
  server.close();
  await service.ai.idle();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
