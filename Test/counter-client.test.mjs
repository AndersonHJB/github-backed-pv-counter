import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("counter.js uses the committed hit response and ignores older stats", async () => {
  const source = fs.readFileSync(new URL("../public/counter.js", import.meta.url), "utf8");
  const calls = [];
  const updates = [];
  let resolveHit;

  const context = {
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options && options.detail;
      }
    },
    document: {
      currentScript: {
        src: "https://counter.example/counter.js",
        dataset: { domain: "example.com" },
      },
      querySelector: () => null,
    },
    location: { hostname: "example.com", pathname: "/" },
    navigator: { sendBeacon: () => true },
    window: { dispatchEvent: (event) => updates.push(event.detail.total) },
    setInterval: () => {
      throw new Error("polling should be disabled");
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (String(url).includes("/hit?")) {
        return new Promise((resolve) => {
          resolveHit = resolve;
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, total: 1, last: 123 }),
      };
    },
  };

  vm.runInNewContext(source, context, { filename: "counter.js" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/hit\?/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.keepalive, true);

  resolveHit({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, domain: "example.com", total: 2, last: 124 }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /debug=1/);
  assert.equal(context.window.BFTCounter.peek().total, 2);
  assert.deepEqual(updates, [2]);

  const stats = await context.window.BFTCounter.get();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/stats\?/);
  assert.equal(stats.total, 2);
  assert.equal(context.window.BFTCounter.peek().total, 2);
  assert.deepEqual(updates, [2]);
});
