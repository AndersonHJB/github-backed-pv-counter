/**
 * Counter Service Full Regression Test (single file)
 * Requirements: Node.js >= 18 (has global fetch)
 *
 * Usage examples:
 * 1) Local:
 *    node test-counter.mjs --base http://127.0.0.1:8787 --domain localhost
 *
 * 2) Production:
 *    node test-counter.mjs --base https://counter.bornforthis.cn --domain bornforthis.cn
 *
 * Notes:
 * - Script uses a unique test domain like: test-<ts>.bornforthis.cn
 *   to avoid interfering with real counters and avoid concurrent noise.
 */

import process from "node:process";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT_FAIL: ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, { expectOk = true, expectStatus, method = "GET" } = {}) {
  const r = await fetch(url, { cache: "no-store", method });
  if (typeof expectStatus === "number") {
    assert(r.status === expectStatus, `Expected HTTP ${expectStatus} but got ${r.status} for ${url}`);
  }
  const text = await r.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // keep null
    }
  }
  if (expectOk) {
    assert(r.ok, `HTTP not ok: ${r.status} for ${url}`);
    assert(json && json.ok === true, `JSON ok!=true for ${url}, got: ${text || "<empty>"}`);
  }
  return { r, text, json };
}

async function fetchNoBody(url, { expectStatus, method = "GET" } = {}) {
  const r = await fetch(url, { cache: "no-store", method });
  if (typeof expectStatus === "number") {
    assert(r.status === expectStatus, `Expected HTTP ${expectStatus} but got ${r.status} for ${url}`);
  }
  return r;
}

function urlWith(base, path, params = {}) {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function safeProjectKey(s) {
  if (!s) return "";
  s = String(s).trim().replace(/^\//, "").replace(/\/$/, "").toLowerCase();
  // match server sanitizeProject
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(s)) return "";
  return s;
}

(async () => {
  if (typeof fetch !== "function") {
    console.error("❌ Node.js version too old: global fetch not found. Use Node >= 18.");
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const base = args.base || "http://127.0.0.1:8787";

  // domain suffix used to create a unique test domain
  const domainSuffix = (args.domain || "localhost").toLowerCase();

  const ts = Date.now();
  const testDomain =
    domainSuffix === "localhost"
      ? `test-${ts}.localhost`
      : `test-${ts}.${domainSuffix.replace(/^\./, "")}`;

  const testProject = safeProjectKey(args.project || `proj-${ts}`) || `proj-${ts}`;
  const badProject = "bad/slash"; // should 400

  console.log("===============================================");
  console.log("Counter Service Regression Test");
  console.log("Base:", base);
  console.log("Test Domain:", testDomain);
  console.log("Test Project:", testProject);
  console.log("===============================================\n");

  // ---------- 0) stats should start at 0 ----------
  {
    const statsDomainUrl = urlWith(base, "/stats", { d: testDomain });
    const { json } = await fetchJson(statsDomainUrl, { expectOk: true });
    assert(json.total === 0, `Initial domain total should be 0, got ${json.total}`);
    assert(json.last === 0, `Initial domain last should be 0, got ${json.last}`);
    console.log("✅ [0] Initial /stats?d=.. returns 0 total OK");
  }

  {
    const statsProjUrl = urlWith(base, "/stats", { d: testDomain, p: testProject });
    const { json } = await fetchJson(statsProjUrl, { expectOk: true });
    assert(json.total === 0, `Initial project total should be 0, got ${json.total}`);
    assert(json.last === 0, `Initial project last should be 0, got ${json.last}`);
    assert(json.project === testProject, "Project key mismatch in stats");
    console.log("✅ [0b] Initial /stats?d=..&p=.. returns 0 total OK");
  }

  // ---------- 1) hit without project: debug=1 returns JSON, normal returns 204 ----------
  {
    const hitDebugUrl = urlWith(base, "/hit", { d: testDomain, debug: 1 });
    const { json } = await fetchJson(hitDebugUrl, { expectOk: true });
    assert(json.domain === testDomain, "hit debug domain mismatch");
    console.log("✅ [1] /hit?d=..&debug=1 returns JSON OK");
  }

  {
    const hit204Url = urlWith(base, "/hit", { d: testDomain });
    const r = await fetchNoBody(hit204Url, { expectStatus: 204 });
    assert(r.status === 204, "hit should be 204");
    console.log("✅ [1b] /hit?d=.. returns 204 OK");
  }

  // ---------- 2) hit with project: debug + 204 ----------
  {
    const hitProjDebugUrl = urlWith(base, "/hit", { d: testDomain, p: testProject, debug: 1 });
    const { json } = await fetchJson(hitProjDebugUrl, { expectOk: true });
    assert(json.domain === testDomain, "hit debug domain mismatch (project)");
    assert(json.project === testProject, "hit debug project mismatch");
    console.log("✅ [2] /hit?d=..&p=..&debug=1 returns JSON OK");
  }

  {
    const hitProj204Url = urlWith(base, "/hit", { d: testDomain, p: testProject });
    const r = await fetchNoBody(hitProj204Url, { expectStatus: 204 });
    assert(r.status === 204, "hit(project) should be 204");
    console.log("✅ [2b] /hit?d=..&p=.. returns 204 OK");
  }

  // We have sent:
  // - 2 domain hits (1 debug + 1 normal)
  // - 2 project hits (1 debug + 1 normal)
  // Expected:
  // - domain total = 4 (because project hits are INCLUDED)
  // - project total = 2
  await sleep(50);

  // ---------- 3) stats domain total includes project ----------
  {
    const statsDomainUrl = urlWith(base, "/stats", { d: testDomain });
    const { json } = await fetchJson(statsDomainUrl, { expectOk: true });
    assert(json.total === 4, `Domain total should be 4 (includes project), got ${json.total}`);
    assert(json.last > 0, "Domain last should be > 0");
    console.log("✅ [3] Domain total includes project hits OK");
  }

  // ---------- 4) stats project total ----------
  {
    const statsProjUrl = urlWith(base, "/stats", { d: testDomain, p: testProject });
    const { json } = await fetchJson(statsProjUrl, { expectOk: true });
    assert(json.total === 2, `Project total should be 2, got ${json.total}`);
    assert(json.last > 0, "Project last should be > 0");
    console.log("✅ [4] Project total OK");
  }

  // ---------- 5) includeProjects=1 returns lightweight project map ----------
  {
    const statsProjectsUrl = urlWith(base, "/stats", { d: testDomain, includeProjects: 1 });
    const { json } = await fetchJson(statsProjectsUrl, { expectOk: true });
    assert(json.projects && typeof json.projects === "object", "projects should exist as object");
    assert(json.projects[testProject], "projects map should include testProject");
    assert(json.projects[testProject].total === 2, `projects[testProject].total should be 2, got ${json.projects[testProject].total}`);
    console.log("✅ [5] includeProjects=1 OK");
  }

  // ---------- 6) includeIps=1 should return ips object (may be empty depending on proxy headers) ----------
  {
    const statsIpsUrl = urlWith(base, "/stats", { d: testDomain, includeIps: 1 });
    const { json } = await fetchJson(statsIpsUrl, { expectOk: true });
    assert(json.ips && typeof json.ips === "object", "ips should be an object when includeIps=1");
    console.log("✅ [6] includeIps=1 OK (ips object present)");
  }

  // ---------- 7) invalid domain -> 400 ----------
  {
    const badDomainUrl = urlWith(base, "/stats", { d: "bad!!domain" });
    const { r, text } = await fetchJson(badDomainUrl, { expectOk: false, expectStatus: 400 });
    assert(r.status === 400, "invalid domain should be 400");
    assert(text.includes("invalid_domain"), "invalid domain msg should contain invalid_domain");
    console.log("✅ [7] invalid domain -> 400 OK");
  }

  // ---------- 8) invalid project -> 400 (stats) ----------
  {
    const badProjUrl = urlWith(base, "/stats", { d: testDomain, p: badProject });
    const { r, text } = await fetchJson(badProjUrl, { expectOk: false, expectStatus: 400 });
    assert(r.status === 400, "invalid project should be 400");
    assert(text.includes("invalid_project"), "invalid project msg should contain invalid_project");
    console.log("✅ [8] invalid project (stats) -> 400 OK");
  }

  // ---------- 9) invalid project -> 400 (hit) ----------
  {
    const badProjHitUrl = urlWith(base, "/hit", { d: testDomain, p: badProject, debug: 1 });
    const { r, text } = await fetchJson(badProjHitUrl, {
      expectOk: false,
      expectStatus: 400,
    });
    assert(r.status === 400, "invalid project hit should be 400");
    assert(text.includes("invalid_project"), "invalid project hit msg should contain invalid_project");
    console.log("✅ [9] invalid project (hit) -> 400 OK");
  }

  console.log("\n===============================================");
  console.log("✅ ALL TESTS PASSED");
  console.log("Your original features are preserved, and same-domain multi-project counting works.");
  console.log("===============================================");
})().catch((e) => {
  console.error("\n❌ TEST FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
