import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("readiness queries the database and reports the build version", async () => {
  let calls = 0;
  const app = buildApp(async () => {
    calls += 1;
  }, "test-sha");
  try {
    assert.equal((await app.inject("/health/ready")).statusCode, 200);
    assert.equal(calls, 1);
    assert.equal((await app.inject("/version")).json().version, "test-sha");
  } finally {
    await app.close();
  }
});
test("database outage fails readiness while the process stays alive", async () => {
  const app = buildApp(async () => {
    throw new Error("secret-database-url");
  }, "test-sha");
  try {
    const response = await app.inject("/health/ready");
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "database_unavailable");
    assert.equal(response.body.includes("secret-database-url"), false);
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    assert.equal((await app.inject("/api/v1/messages")).statusCode, 404);
  } finally {
    await app.close();
  }
});
