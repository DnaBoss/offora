import pg from "pg";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少 DATABASE_URL 設定");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 必須介於 1 到 65535");
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
  statement_timeout: 2000,
});
const app = buildApp(async () => {
  await pool.query("SELECT 1");
}, process.env.APP_VERSION ?? "development");
pool.on("error", () =>
  app.log.error({ code: "database_connection_error" }, "資料庫背景連線中斷"),
);
app.addHook("onClose", async () => {
  await pool.end();
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    app.close().catch(() => {
      app.log.error({ code: "shutdown_failed" }, "服務關閉失敗");
      process.exitCode = 1;
    });
  });
}
try {
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
} catch {
  app.log.error({ code: "startup_failed" }, "服務啟動失敗");
  await app.close();
  process.exitCode = 1;
}
