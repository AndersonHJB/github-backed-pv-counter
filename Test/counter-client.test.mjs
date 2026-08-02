import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/counter.js", import.meta.url), "utf8");

class TestCustomEvent {
  constructor(type, options) {
    this.type = type;
    this.detail = options && options.detail;
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("counter.js preserves legacy data attributes, API, events, and fire-and-forget hit", async () => {
  const calls = [];
  const updates = [];
  const intervals = [];
  const beacons = [];
  const target = { textContent: "-" };
  let hitCount = 0;
  let concurrentStats = false;
  let concurrentStatsCount = 0;
  let resolveOlderStats;

  const statsResponse = (total, last) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        domain: "example.com",
        project: "readygoduel",
        total,
        last,
      }),
  });

  const context = {
    URL,
    URLSearchParams,
    CustomEvent: TestCustomEvent,
    document: {
      currentScript: {
        src: "https://counter.example/counter.js",
        dataset: {
          domain: "Example.COM",
          project: "auto",
          target: "#pv",
          prefix: "PV: ",
          poll: "5000",
        },
      },
      querySelector: (selector) => (selector === "#pv" ? target : null),
    },
    location: { hostname: "ignored.example", pathname: "/ReadyGoDuel/play" },
    navigator: {
      sendBeacon: (url) => {
        beacons.push(String(url));
        return true;
      },
    },
    window: { dispatchEvent: (event) => updates.push(event.detail.total) },
    setInterval: (fn, delay) => {
      intervals.push({ fn, delay });
      return intervals.length;
    },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/hit?")) {
        hitCount += 1;
        if (hitCount === 4) {
          return { ok: false, status: 503, text: async () => "" };
        }
        const total = hitCount === 1 ? 2 : 3;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              domain: "example.com",
              project: "readygoduel",
              total,
              last: 100 + total,
              ts: 100 + total,
            }),
        };
      }
      if (concurrentStats) {
        concurrentStatsCount += 1;
        if (concurrentStatsCount === 1) {
          return new Promise((resolve) => {
            resolveOlderStats = resolve;
          });
        }
        return statsResponse(4, 104);
      }
      return statsResponse(2, 102);
    },
  };

  vm.runInNewContext(source, context, { filename: "counter.js" });
  await flush();

  const counter = context.window.BFTCounter;
  assert.equal(counter.domain, "example.com");
  assert.equal(counter.project, "readygoduel");
  assert.equal(counter.serverOrigin, "https://counter.example");
  assert.equal(counter.peek().total, 2);
  assert.equal(target.textContent, "PV: 2");
  assert.deepEqual(updates, [2]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 5000);

  assert.equal(calls.filter((call) => call.url.includes("/hit?")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("/stats?")).length, 1);
  assert.match(calls[0].url, /d=example.com/);
  assert.match(calls[0].url, /p=readygoduel/);
  assert.match(calls[0].url, /debug=1/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.keepalive, true);

  // Old pages call hit() without awaiting it. It still returns undefined and a
  // failed write is swallowed instead of becoming an unhandled rejection.
  assert.equal(counter.hit(), undefined);
  await flush();
  assert.equal(beacons.length, 1);
  assert.match(beacons[0], /\/hit\?d=example.com&p=readygoduel$/);
  assert.equal(counter.peek().total, 2);
  assert.deepEqual(updates, [2]);

  context.navigator.sendBeacon = null;
  assert.equal(counter.hit(), undefined);
  await flush();
  const fallbackCall = calls.filter((call) => call.url.includes("/hit?")).at(-1);
  assert.equal(fallbackCall.options.method, undefined);
  assert.equal(fallbackCall.url.includes("debug=1"), false);
  assert.equal(counter.peek().total, 2);
  assert.deepEqual(updates, [2]);

  const listenerTotals = [];
  const off = counter.on((data) => listenerTotals.push(data.total));
  const committed = await counter.hitAsync();
  assert.equal(committed.total, 3);
  assert.equal(counter.peek().total, 3);
  assert.equal(target.textContent, "PV: 3");
  assert.deepEqual(listenerTotals, [2, 3]);
  assert.deepEqual(updates, [2, 3]);

  await assert.rejects(counter.hitAsync(), /hit_http_503/);
  assert.equal(counter.peek().total, 3);
  assert.deepEqual(updates, [2, 3]);

  off();
  const stale = await counter.get();
  assert.equal(stale.total, 3);
  assert.equal(counter.peek().total, 3);
  assert.deepEqual(listenerTotals, [2, 3]);

  concurrentStats = true;
  const olderRequest = counter.get();
  const newerRequest = counter.get();
  assert.equal((await newerRequest).total, 4);
  resolveOlderStats(statsResponse(3, 103));
  assert.equal((await olderRequest).total, 4);
  assert.equal(counter.peek().total, 4);
  assert.equal(target.textContent, "PV: 4");
  assert.deepEqual(updates, [2, 3, 4]);
  concurrentStats = false;

  intervals[0].fn();
  await flush();
  assert.equal(counter.peek().total, 4);
});

test("counter.js keeps the legacy sendBeacon fallback when fetch is unavailable", async () => {
  const beacons = [];
  const context = {
    URL,
    URLSearchParams,
    CustomEvent: TestCustomEvent,
    document: {
      currentScript: {
        src: "https://counter.example/counter.js",
        dataset: { domain: "example.com" },
      },
      querySelector: () => null,
    },
    location: { hostname: "example.com", pathname: "/" },
    navigator: {
      sendBeacon: (url) => {
        beacons.push(String(url));
        return true;
      },
    },
    window: { dispatchEvent: () => {} },
    setInterval: () => {
      throw new Error("polling should be disabled");
    },
  };

  vm.runInNewContext(source, context, { filename: "counter.js" });
  await flush();
  assert.equal(beacons.length, 1);
  assert.match(beacons[0], /\/hit\?d=example.com$/);
  assert.equal(context.window.BFTCounter.hit(), undefined);
  await flush();
  assert.equal(beacons.length, 2);
  await assert.rejects(
    context.window.BFTCounter.hitAsync(),
    /hit_async_requires_fetch/
  );
  assert.equal(beacons.length, 2);
});

test("counter.js emits the legacy domain stats shape when the hit finishes first", async () => {
  const details = [];
  let resolveStats;
  const context = {
    URL,
    URLSearchParams,
    CustomEvent: TestCustomEvent,
    document: {
      currentScript: {
        src: "https://counter.example/counter.js",
        dataset: { domain: "example.com" },
      },
      querySelector: () => null,
    },
    location: { hostname: "example.com", pathname: "/" },
    navigator: { sendBeacon: () => true },
    window: { dispatchEvent: (event) => details.push(event.detail) },
    setInterval: () => {
      throw new Error("polling should be disabled");
    },
    fetch: async (url) => {
      if (String(url).includes("/stats?")) {
        return new Promise((resolve) => {
          resolveStats = resolve;
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            domain: "example.com",
            project: null,
            total: 2,
            last: 102,
            ts: 102,
          }),
      };
    },
  };

  vm.runInNewContext(source, context, { filename: "counter.js" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(details)), [
    { ok: true, domain: "example.com", total: 2, last: 102 },
  ]);

  resolveStats({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ ok: true, domain: "example.com", total: 1, last: 101 }),
  });
  await flush();
  assert.equal(context.window.BFTCounter.peek().total, 2);
  assert.equal(details.length, 1);
});
