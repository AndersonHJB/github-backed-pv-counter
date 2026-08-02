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

test("preserves and increments legacy IP statistics at both levels", () => {
  const result = applyHit(
    {
      domain: "example.com",
      total: 2,
      last: 100,
      ips: {
        visitor: { count: 2, first: 50, last: 100 },
      },
      projects: {
        blog: {
          total: 1,
          last: 100,
          ips: { visitor: { count: 1, first: 80, last: 100 } },
        },
      },
    },
    {
      domain: "example.com",
      project: "blog",
      visitorKey: "visitor",
      now: 120,
    }
  );

  assert.deepEqual(result.ips.visitor, { count: 3, first: 50, last: 120 });
  assert.deepEqual(result.projects.blog.ips.visitor, {
    count: 2,
    first: 80,
    last: 120,
  });
});

test("stops allocating visitor keys without stopping PV updates", () => {
  const full = {
    domain: "example.com",
    total: 5,
    last: 10,
    ips: { existing: { count: 1, first: 1, last: 10 } },
    projects: {},
  };

  const newVisitor = applyHit(full, {
    domain: "example.com",
    project: "blog",
    visitorKey: "new-visitor",
    now: 20,
    maxVisitorKeys: 1,
  });
  assert.equal(newVisitor.total, 6);
  assert.equal(newVisitor.projects.blog.total, 1);
  assert.deepEqual(Object.keys(newVisitor.ips), ["existing"]);
  assert.deepEqual(newVisitor.projects.blog.ips, {});

  const existingVisitor = applyHit(newVisitor, {
    domain: "example.com",
    visitorKey: "existing",
    now: 30,
    maxVisitorKeys: 1,
  });
  assert.equal(existingVisitor.total, 7);
  assert.equal(existingVisitor.ips.existing.count, 2);
});
