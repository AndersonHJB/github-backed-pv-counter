import assert from "node:assert/strict";
import test from "node:test";
import recordModule from "../lib/counter-record.js";

const { applyHit } = recordModule;

test("an older concurrent hit cannot move record timestamps backwards", () => {
  const result = applyHit(
    {
      version: 2,
      domain: "example.com",
      total: 4,
      last: 300,
      ips: {},
      projects: {
        blog: {
          total: 2,
          last: 400,
          ips: {},
        },
      },
    },
    {
      domain: "example.com",
      project: "blog",
      now: 200,
    }
  );

  assert.equal(result.last, 300);
  assert.deepEqual(result.ips, {});
  assert.equal(result.projects.blog.last, 400);
  assert.deepEqual(result.projects.blog.ips, {});
});

test("rejects new project keys after the per-domain limit", () => {
  assert.throws(
    () =>
      applyHit(
        {
          domain: "example.com",
          total: 1,
          projects: { existing: { total: 1, last: 1, ips: {} } },
        },
        { domain: "example.com", project: "new", now: 2, maxProjects: 1 }
      ),
    (error) => error.code === "project_limit_reached"
  );
});
