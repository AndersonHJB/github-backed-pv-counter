import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateLegacyFile, splitLegacyData } from "../scripts/migrate-legacy-data.mjs";

test("splits legacy monolithic data and removes public IP history", () => {
  const records = splitLegacyData({
    version: 2,
    domains: {
      "Example.COM": {
        total: 9,
        last: 123,
        ips: { "203.0.113.7": { count: 9, first: 1, last: 123 } },
        projects: {
          Blog: {
            total: 4,
            last: 120,
            ips: { "203.0.113.7": { count: 4, first: 1, last: 120 } },
          },
        },
      },
    },
  });

  assert.equal(records.size, 1);
  assert.deepEqual(records.get("example.com"), {
    version: 2,
    domain: "example.com",
    total: 9,
    last: 123,
    ips: {},
    projects: {
      blog: { total: 4, last: 120, ips: {} },
    },
  });
});

test("preserves legacy visitor frequency as domain-isolated HMAC identifiers", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const records = splitLegacyData({
    domains: {
      "example.com": {
        total: 2,
        last: 20,
        ips: { "::ffff:203.0.113.7": { count: 2, first: 10, last: 20 } },
        projects: {
          blog: {
            total: 1,
            last: 20,
            ips: { "203.0.113.7": { count: 1, first: 20, last: 20 } },
          },
        },
      },
      "other.example.com": {
        total: 1,
        last: 20,
        ips: { "203.0.113.7": { count: 1, first: 20, last: 20 } },
      },
    },
  }, { ipHashSecret: secret });

  const domainKey = Object.keys(records.get("example.com").ips)[0];
  const projectKey = Object.keys(records.get("example.com").projects.blog.ips)[0];
  const otherDomainKey = Object.keys(records.get("other.example.com").ips)[0];
  assert.match(domainKey, /^h:/);
  assert.equal(domainKey.includes("203.0.113.7"), false);
  assert.equal(projectKey, domainKey);
  assert.notEqual(otherDomainKey, domainKey);
  assert.deepEqual(records.get("example.com").ips[domainKey], {
    count: 2,
    first: 10,
    last: 20,
  });
  assert.throws(
    () => splitLegacyData({ domains: {} }, { ipHashSecret: "too-short" }),
    /at least 32 bytes/
  );
});

test("writes per-domain files and refuses accidental replacement", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "counter-migrate-test-"));
  const input = path.join(temporaryRoot, "data.json");
  const output = path.join(temporaryRoot, "domains");
  try {
    await fs.writeFile(
      input,
      JSON.stringify({ domains: { "example.com": { total: 3, last: 10 } } }),
      "utf8"
    );
    const result = await migrateLegacyFile({ input, output });
    assert.equal(result.count, 1);
    const stored = JSON.parse(await fs.readFile(path.join(output, "example.com.json"), "utf8"));
    assert.equal(stored.total, 3);
    await assert.rejects(
      migrateLegacyFile({ input, output }),
      /already exists/
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects migrated snapshots that exceed runtime visitor or file limits", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "counter-migrate-limit-test-"));
  const input = path.join(temporaryRoot, "data.json");
  const output = path.join(temporaryRoot, "domains");
  const secret = "0123456789abcdef0123456789abcdef";
  try {
    await fs.writeFile(
      input,
      JSON.stringify({
        domains: {
          "example.com": {
            total: 1,
            ips: { "203.0.113.7": { count: 1, first: 1, last: 1 } },
            projects: {
              blog: {
                total: 1,
                ips: { "203.0.113.7": { count: 1, first: 1, last: 1 } },
              },
            },
          },
        },
      }),
      "utf8"
    );

    await assert.rejects(
      migrateLegacyFile({
        input,
        output,
        ipHashSecret: secret,
        maxVisitorKeys: 1,
      }),
      /2 visitor entries/
    );
    await assert.rejects(
      migrateLegacyFile({
        input,
        output,
        ipHashSecret: secret,
        maxVisitorKeys: 0,
        maxFileBytes: 64,
      }),
      /exceeding the configured limit of 64/
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
