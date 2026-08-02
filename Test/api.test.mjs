import assert from "node:assert/strict";
import test from "node:test";
import serverModule from "../server.js";
import memoryStoreModule from "../lib/memory-counter-store.js";

const { createApp } = serverModule;
const { MemoryCounterStore } = memoryStoreModule;

const openConfig = {
  allowAll: true,
  allowGetHits: false,
  allowedDomains: [],
  allowedRootDomains: [],
  rateLimitMax: 100,
};

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(base);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

test("keeps the domain and project counter API compatible", async () => {
  const store = new MemoryCounterStore();
  const app = createApp({ store, configProvider: () => openConfig, now: () => 12345 });

  await withServer(app, async (base) => {
    const initial = await json(`${base}/stats?d=example.com`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.total, 0);

    const debug = await json(`${base}/hit?d=example.com&debug=1`, { method: "POST" });
    assert.equal(debug.body.ok, true);
    assert.equal(debug.body.ts, 12345);
    assert.equal(debug.body.total, 1);

    const normalDomain = await fetch(`${base}/hit?d=example.com`, { method: "POST" });
    assert.equal(normalDomain.status, 204);
    const debugProject = await json(`${base}/hit?d=example.com&p=blog&debug=1`, {
      method: "POST",
    });
    assert.equal(debugProject.body.project, "blog");
    const normalProject = await fetch(`${base}/hit?d=example.com&p=blog`, { method: "POST" });
    assert.equal(normalProject.status, 204);

    const domain = await json(`${base}/stats?d=example.com&includeProjects=1`);
    assert.equal(domain.body.total, 4);
    assert.equal(domain.body.projects.blog.total, 2);
    assert.match(domain.response.headers.get("cache-control"), /s-maxage=10/);

    const project = await json(`${base}/stats?d=example.com&p=blog`);
    assert.equal(project.body.total, 2);
    assert.equal(project.body.project, "blog");
  });
});

test("supports project names that overlap object prototype properties", async () => {
  const store = new MemoryCounterStore();
  const app = createApp({ store, configProvider: () => openConfig });

  await withServer(app, async (base) => {
    const hit = await fetch(`${base}/hit?d=example.com&p=constructor`, { method: "POST" });
    assert.equal(hit.status, 204);
    const stats = await json(`${base}/stats?d=example.com&p=constructor`);
    assert.equal(stats.body.total, 1);
  });
});

test("enforces validation and the root-domain allowlist before storage", async () => {
  let storageCalls = 0;
  const store = {
    async readDomain() {
      storageCalls += 1;
      throw new Error("should not run");
    },
    async increment() {
      storageCalls += 1;
      throw new Error("should not run");
    },
  };
  const app = createApp({
    store,
    configProvider: () => ({
      allowAll: false,
      allowedDomains: [],
      allowedRootDomains: ["example.com"],
      rateLimitMax: 100,
    }),
  });

  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/stats?d=bad!!domain`)).status, 400);
    assert.equal((await fetch(`${base}/stats?d=other.com`)).status, 403);
    assert.equal(
      (await fetch(`${base}/hit?d=example.com&p=bad/slash`, { method: "POST" })).status,
      400
    );
    assert.equal(storageCalls, 0);
  });
});

test("waits for storage before returning success", async () => {
  let committed = false;
  const store = {
    async increment() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      committed = true;
    },
    async readDomain() {
      return { total: 0, last: 0, ips: {}, projects: {} };
    },
  };
  const app = createApp({ store, configProvider: () => openConfig });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/hit?d=example.com`, { method: "POST" });
    assert.equal(response.status, 204);
    assert.equal(committed, true);
  });
});

test("maps storage failures to a stable 503 response", async () => {
  const store = {
    async increment() {
      throw new Error("secret internal failure");
    },
    async readDomain() {
      throw new Error("secret internal failure");
    },
  };
  const app = createApp({ store, configProvider: () => openConfig });

  await withServer(app, async (base) => {
    const hit = await json(`${base}/hit?d=example.com&debug=1`, { method: "POST" });
    assert.equal(hit.response.status, 503);
    assert.deepEqual(hit.body, {
      ok: false,
      error: "storage_unavailable",
      msg: "storage_unavailable",
    });
    assert.equal(JSON.stringify(hit.body).includes("secret"), false);
  });
});

test("serves counter.js with CORS and cache headers", async () => {
  const app = createApp({ store: new MemoryCounterStore(), configProvider: () => openConfig });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/counter.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(await response.text(), /window\.BFTCounter/);
  });
});

test("rejects legacy GET writes by default", async () => {
  const app = createApp({ store: new MemoryCounterStore(), configProvider: () => openConfig });
  await withServer(app, async (base) => {
    const response = await json(`${base}/hit?d=example.com`);
    assert.equal(response.response.status, 405);
    assert.equal(response.response.headers.get("allow"), "POST");
    assert.equal(response.body.error, "method_not_allowed");
  });
});

test("rate limits writes before they reach storage", async () => {
  let calls = 0;
  const store = {
    async increment() {
      calls += 1;
    },
    async readDomain() {
      return { total: 0, last: 0, ips: {}, projects: {} };
    },
  };
  const app = createApp({
    store,
    now: () => 1000,
    configProvider: () => ({ ...openConfig, rateLimitMax: 1, rateLimitWindowMs: 60_000 }),
  });

  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/hit?d=example.com`, { method: "POST" })).status, 204);
    const limited = await json(`${base}/hit?d=example.com`, { method: "POST" });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get("retry-after"), "60");
    assert.equal(calls, 1);
  });
});

test("rate limits stats before they reach storage", async () => {
  let reads = 0;
  const store = {
    async increment() {},
    async readDomain() {
      reads += 1;
      return { total: 1, last: 1, ips: {}, projects: {} };
    },
  };
  const app = createApp({
    store,
    now: () => 1000,
    configProvider: () => ({
      ...openConfig,
      statsRateLimitMax: 1,
      rateLimitWindowMs: 60_000,
    }),
  });

  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/stats?d=example.com`)).status, 200);
    const limited = await json(`${base}/stats?d=example.com`);
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get("cache-control"), "no-store");
    assert.equal(reads, 1);
  });
});
