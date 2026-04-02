import { resolveConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = await resolveConfig();
const app = await buildServer(config);

try {
  await app.listen({
    host: config.host,
    port: config.port,
  });
  app.log.info(
    `codex-auth-openai-proxy listening at http://${config.host}:${config.port}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
