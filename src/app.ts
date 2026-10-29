import Fastify from "fastify";

export function buildApp(checkDatabase: () => Promise<void>, version: string) {
  const app = Fastify({ logger: true, disableRequestLogging: true });
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await checkDatabase();
      return { status: "ready" };
    } catch {
      app.log.error({ code: "database_unavailable" }, "資料庫暫時無法連線");
      return reply.code(503).send({
        error: {
          code: "database_unavailable",
          message: "資料庫暫時無法連線",
        },
      });
    }
  });
  app.get("/version", async () => ({
    service: "pixel-office",
    version,
    stage: "infrastructure",
  }));
  return app;
}
