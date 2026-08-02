import assert from "node:assert/strict";
import test from "node:test";
import githubStoreModule from "../lib/github-counter-store.js";

const { GitHubCounterStore, GitHubStorageError } = githubStoreModule;

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function encodedRecord(record) {
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64");
}

function queueFetch(entries) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = entries.shift();
    assert.ok(next, `Unexpected fetch call: ${options.method || "GET"} ${url}`);
    return typeof next === "function" ? next(String(url), options) : next;
  };
  return { calls, fetchImpl };
}

function createStore(fetchImpl, overrides = {}) {
  return new GitHubCounterStore({
    token: "test-token",
    repository: "owner/counter-data",
    branch: "main",
    fetchImpl,
    retryDelay: async () => {},
    ...overrides,
  });
}

test("creates a new per-domain file without a sha", async () => {
  const queue = queueFetch([
    jsonResponse(404, { message: "Not Found" }),
    jsonResponse(200, { name: "main" }),
    (url, options) => {
      assert.equal(options.method, "PUT");
      const body = JSON.parse(options.body);
      assert.equal(body.branch, "main");
      assert.equal(Object.hasOwn(body, "sha"), false);

      const stored = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      assert.equal(stored.domain, "example.com");
      assert.equal(stored.total, 1);
      assert.equal(stored.projects.blog.total, 1);
      return jsonResponse(201, { content: { sha: "created" } });
    },
  ]);

  const store = createStore(queue.fetchImpl);
  const result = await store.increment({
    domain: "example.com",
    project: "blog",
    now: 123,
  });

  assert.equal(result.total, 1);
  assert.match(queue.calls[0].url, /data\/domains\/example\.com\.json\?ref=main$/);
  assert.equal(queue.calls[0].options.headers.Authorization, "Bearer test-token");
  assert.match(queue.calls[1].url, /\/branches\/main$/);
  assert.equal(queue.calls.length, 3);
});

test("updates an existing file with its current sha", async () => {
  const current = { version: 2, domain: "example.com", total: 7, last: 100, ips: {}, projects: {} };
  const queue = queueFetch([
    jsonResponse(200, { type: "file", encoding: "base64", sha: "sha-a", content: encodedRecord(current) }),
    (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, "sha-a");
      const stored = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      assert.equal(stored.total, 8);
      return jsonResponse(200, { content: { sha: "sha-b" } });
    },
  ]);

  const result = await createStore(queue.fetchImpl).increment({
    domain: "example.com",
    project: "",
    now: 200,
  });

  assert.equal(result.total, 8);
  assert.equal(result.last, 200);
});

test("re-reads and reapplies an older increment after a sha conflict without moving last backwards", async () => {
  const recordA = { version: 2, domain: "example.com", total: 10, last: 100, ips: {}, projects: {} };
  const recordB = { version: 2, domain: "example.com", total: 12, last: 300, ips: {}, projects: {} };
  const queue = queueFetch([
    jsonResponse(200, { type: "file", encoding: "base64", sha: "sha-a", content: encodedRecord(recordA) }),
    jsonResponse(409, { message: "sha does not match" }),
    jsonResponse(200, { type: "file", encoding: "base64", sha: "sha-b", content: encodedRecord(recordB) }),
    (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, "sha-b");
      const stored = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      assert.equal(stored.total, 13);
      assert.equal(stored.last, 300);
      return jsonResponse(200, { content: { sha: "sha-c" } });
    },
  ]);

  const result = await createStore(queue.fetchImpl).increment({
    domain: "example.com",
    project: "",
    now: 200,
  });

  assert.equal(result.total, 13);
  assert.equal(result.last, 300);
  assert.equal(queue.calls.length, 4);
});

test("does not retry authentication failures", async () => {
  const queue = queueFetch([
    jsonResponse(200, {
      type: "file",
      encoding: "base64",
      sha: "sha-a",
      content: encodedRecord({ total: 1 }),
    }),
    jsonResponse(401, { message: "Bad credentials" }),
  ]);

  await assert.rejects(
    createStore(queue.fetchImpl).increment({
      domain: "example.com",
      project: "",
      now: 200,
    }),
    (error) => error instanceof GitHubStorageError && error.code === "github_write_failed"
  );
  assert.equal(queue.calls.length, 2);
});

test("returns zero data for a missing file and rejects corrupt JSON", async () => {
  const missingQueue = queueFetch([
    jsonResponse(404, { message: "Not Found" }),
    jsonResponse(200, { name: "main" }),
  ]);
  const missing = await createStore(missingQueue.fetchImpl).readDomain("missing.example.com");
  assert.equal(missing.total, 0);

  const corruptQueue = queueFetch([
    jsonResponse(200, {
      type: "file",
      encoding: "base64",
      sha: "sha-a",
      content: Buffer.from("not-json").toString("base64"),
    }),
  ]);
  await assert.rejects(
    createStore(corruptQueue.fetchImpl).readDomain("example.com"),
    (error) => error instanceof GitHubStorageError && error.code === "github_invalid_data"
  );
});

test("serves repeated stats reads from the short in-memory cache", async () => {
  const queue = queueFetch([
    jsonResponse(200, {
      type: "file",
      encoding: "base64",
      sha: "sha-a",
      content: encodedRecord({ total: 9, last: 10, projects: {} }),
    }),
  ]);
  const store = createStore(queue.fetchImpl);

  assert.equal((await store.readDomain("example.com")).total, 9);
  assert.equal((await store.readDomain("example.com")).total, 9);
  assert.equal(queue.calls.length, 1);
});

test("does not hide a missing repository or branch as an empty counter", async () => {
  const queue = queueFetch([
    jsonResponse(404, { message: "Not Found" }),
    jsonResponse(404, { message: "Branch not found" }),
  ]);

  await assert.rejects(
    createStore(queue.fetchImpl).readDomain("example.com"),
    (error) => error instanceof GitHubStorageError && error.code === "storage_not_configured"
  );
});

test("rejects a counter file before it reaches the configured size ceiling", async () => {
  const queue = queueFetch([
    jsonResponse(200, {
      type: "file",
      encoding: "base64",
      sha: "sha-a",
      content: encodedRecord({ total: 1, projects: {} }),
    }),
  ]);

  await assert.rejects(
    createStore(queue.fetchImpl, { maxFileBytes: 10 }).increment({
      domain: "example.com",
      project: "",
      now: 200,
    }),
    (error) => error instanceof GitHubStorageError && error.code === "counter_capacity_reached"
  );
  assert.equal(queue.calls.length, 1);
});

test("serializes same-domain increments within one function instance", async () => {
  let record = null;
  let shaNumber = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/branches/")) return jsonResponse(200, { name: "main" });
    if ((options.method || "GET") === "GET") {
      if (!record) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, {
        type: "file",
        encoding: "base64",
        sha: `sha-${shaNumber}`,
        content: encodedRecord(record),
      });
    }

    const body = JSON.parse(options.body);
    if (record) assert.equal(body.sha, `sha-${shaNumber}`);
    record = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
    shaNumber += 1;
    return jsonResponse(record.total === 1 ? 201 : 200, {
      content: { sha: `sha-${shaNumber}` },
    });
  };
  const store = createStore(fetchImpl);

  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      store.increment({ domain: "example.com", project: "", now: index + 1 })
    )
  );

  assert.equal(record.total, 6);
  assert.equal(record.last, 6);
});
