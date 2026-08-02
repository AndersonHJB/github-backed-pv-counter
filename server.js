"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { GitHubCounterStore, GitHubStorageError } = require("./lib/github-counter-store");
const { MemoryCounterStore } = require("./lib/memory-counter-store");

const PORT = process.env.PORT || 8787;
const CONFIG_FILE = path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function envBoolean(name, fallback) {
  const value = process.env[name] && process.env[name].trim().toLowerCase();
  if (value == null || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function envNonNegativeInteger(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function domainList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item).toLowerCase().trim())
        .filter((item) => /^[a-z0-9.-]{1,253}$/.test(item))
    : [];
}

const IP_MODES = new Set(["none", "hash", "anonymized", "raw"]);

function normalizeIpMode(value, fallback = "none") {
  const mode = String(value || "").toLowerCase().trim();
  return IP_MODES.has(mode) ? mode : fallback;
}

function normalizeConfig(value = {}) {
  const legacyIpMode = typeof value.anonymizeIp === "boolean"
    ? value.anonymizeIp
      ? "anonymized"
      : "none"
    : "none";

  return {
    allowAll: !!value.allowAll,
    allowGetHits: value.allowGetHits !== false,
    allowedDomains: domainList(value.allowedDomains),
    allowedRootDomains: domainList(value.allowedRootDomains),
    ipMode: normalizeIpMode(value.ipMode, legacyIpMode),
    ipHashSecret: String(value.ipHashSecret || "").trim(),
    allowRawIps: value.allowRawIps === true,
    ipStatsToken: String(value.ipStatsToken || "").trim(),
    rateLimitMax: Number.isSafeInteger(value.rateLimitMax) && value.rateLimitMax >= 0
      ? value.rateLimitMax
      : 5,
    rateLimitWindowMs:
      Number.isSafeInteger(value.rateLimitWindowMs) && value.rateLimitWindowMs > 0
        ? value.rateLimitWindowMs
        : 60_000,
    statsRateLimitMax:
      Number.isSafeInteger(value.statsRateLimitMax) && value.statsRateLimitMax >= 0
        ? value.statsRateLimitMax
        : 60,
    statsCacheTtlMs:
      Number.isSafeInteger(value.statsCacheTtlMs) && value.statsCacheTtlMs >= 0
        ? value.statsCacheTtlMs
        : 0,
    maxProjectsPerDomain:
      Number.isSafeInteger(value.maxProjectsPerDomain) && value.maxProjectsPerDomain >= 0
        ? value.maxProjectsPerDomain
        : 100,
    maxVisitorKeysPerDomain:
      Number.isSafeInteger(value.maxVisitorKeysPerDomain)
        && value.maxVisitorKeysPerDomain >= 0
        ? value.maxVisitorKeysPerDomain
        : 2_000,
  };
}

function loadConfig() {
  const fileConfig = normalizeConfig(
    readJsonSafe(CONFIG_FILE, {
      allowAll: false,
      allowGetHits: true,
      allowedDomains: [
        "bornforthis.cn",
        "ai.bornforthis.cn",
        "counter.bornforthis.cn",
        "aistudio.google.com",
        "gemini.google.com",
      ],
      allowedRootDomains: [],
      ipMode: "hash",
      rateLimitMax: 5,
      rateLimitWindowMs: 60_000,
      statsRateLimitMax: 60,
      statsCacheTtlMs: 0,
      maxProjectsPerDomain: 100,
      maxVisitorKeysPerDomain: 2_000,
    })
  );

  return {
    ...fileConfig,
    allowAll: envBoolean("COUNTER_ALLOW_ALL", fileConfig.allowAll),
    allowGetHits: envBoolean("COUNTER_ALLOW_GET_HITS", fileConfig.allowGetHits),
    ipMode: normalizeIpMode(process.env.COUNTER_IP_MODE, fileConfig.ipMode),
    ipHashSecret: String(process.env.COUNTER_IP_HASH_SECRET || "").trim(),
    allowRawIps: envBoolean("COUNTER_ALLOW_RAW_IPS", false),
    ipStatsToken: String(process.env.COUNTER_IP_STATS_TOKEN || "").trim(),
    rateLimitMax: envNonNegativeInteger("COUNTER_RATE_LIMIT_MAX", fileConfig.rateLimitMax),
    rateLimitWindowMs: envPositiveInteger(
      "COUNTER_RATE_LIMIT_WINDOW_MS",
      fileConfig.rateLimitWindowMs
    ),
    statsRateLimitMax: envNonNegativeInteger(
      "COUNTER_STATS_RATE_LIMIT_MAX",
      fileConfig.statsRateLimitMax
    ),
    statsCacheTtlMs: envNonNegativeInteger(
      "COUNTER_STATS_CACHE_TTL_MS",
      fileConfig.statsCacheTtlMs
    ),
    maxProjectsPerDomain: envNonNegativeInteger(
      "COUNTER_MAX_PROJECTS_PER_DOMAIN",
      fileConfig.maxProjectsPerDomain
    ),
    maxVisitorKeysPerDomain: envNonNegativeInteger(
      "COUNTER_MAX_VISITOR_KEYS_PER_DOMAIN",
      fileConfig.maxVisitorKeysPerDomain
    ),
  };
}

function sanitizeDomain(value) {
  const domain = String(value || "").toLowerCase().trim();
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : "";
}

function sanitizeProject(value) {
  if (!value) return "";
  const project = String(value)
    .trim()
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(project) ? project : "";
}

function isAllowedDomain(domain, config) {
  if (config.allowAll) return true;
  if (config.allowedDomains.includes(domain)) return true;
  return config.allowedRootDomains.some(
    (root) => domain === root || domain.endsWith(`.${root}`)
  );
}

function normalizeClientIp(value) {
  let ip = String(value || "").trim();
  if (ip.startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return net.isIP(ip) ? ip : "";
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = String(forwarded).split(",")[0];
    const ip = normalizeClientIp(first);
    if (ip) return ip;
  }

  const realIp = normalizeClientIp(req.headers["x-real-ip"]);
  if (realIp) return realIp;
  return normalizeClientIp(req.socket && req.socket.remoteAddress);
}

function anonymizeIp(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (net.isIP(ip) === 6) {
    const halves = ip.split("::");
    const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
    const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
    const missing = Math.max(0, 8 - left.length - right.length);
    const parts = halves.length === 2
      ? [...left, ...Array(missing).fill("0"), ...right]
      : left;
    return `${parts.slice(0, 4).map((part) => part || "0").join(":")}::/64`;
  }
  return "";
}

function visitorKeyForRequest(req, config, domain) {
  if (config.ipMode === "none") return "";
  const ip = getClientIp(req);
  if (!ip) return "";
  if (config.ipMode === "raw") return config.allowRawIps ? ip : "";
  if (config.ipMode === "anonymized") return anonymizeIp(ip);
  if (
    config.ipMode === "hash"
    && Buffer.byteLength(config.ipHashSecret || "", "utf8") >= 32
  ) {
    const digest = crypto
      .createHmac("sha256", config.ipHashSecret)
      .update(`github-backed-pv-counter\0v1\0${domain}\0${ip}`)
      .digest("base64url");
    return `h:${digest}`;
  }
  return "";
}

function safeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length > 0
    && leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasIpStatsToken(req, config) {
  if (Buffer.byteLength(config.ipStatsToken || "", "utf8") < 32) return false;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const headerToken = String(req.headers["x-counter-stats-token"] || "").trim();
  return safeTokenEqual(bearer || headerToken, config.ipStatsToken);
}

function containsRawIpKeys(ips) {
  return !!ips
    && typeof ips === "object"
    && !Array.isArray(ips)
    && Object.keys(ips).some((key) => !!normalizeClientIp(key));
}

function canReadIpStats(req, config, ips) {
  if (config.ipMode === "raw" && !config.allowRawIps) return false;
  const requiresAuthentication = config.ipMode === "raw" || containsRawIpKeys(ips);
  return !requiresAuthentication || hasIpStatsToken(req, config);
}

function createDefaultStore() {
  if (String(process.env.COUNTER_STORAGE || "github").toLowerCase() === "memory") {
    return new MemoryCounterStore();
  }

  const runtimeConfig = loadConfig();
  return new GitHubCounterStore({
    token: process.env.COUNTER_GITHUB_TOKEN,
    repository: process.env.COUNTER_GITHUB_REPOSITORY,
    branch: process.env.COUNTER_GITHUB_BRANCH || "main",
    directory: process.env.COUNTER_GITHUB_DATA_DIRECTORY || "data/domains",
    apiVersion: process.env.COUNTER_GITHUB_API_VERSION || "2022-11-28",
    readCacheTtlMs: runtimeConfig.statsCacheTtlMs,
    requestTimeoutMs: envNonNegativeInteger("COUNTER_GITHUB_TIMEOUT_MS", 8_000),
    maxFileBytes: envPositiveInteger("COUNTER_GITHUB_MAX_FILE_BYTES", 512 * 1024),
  });
}

function publicStorageError(error) {
  if (error && ["project_limit_reached", "counter_capacity_reached"].includes(error.code)) {
    return { status: 422, error: "counter_capacity_reached" };
  }
  if (error instanceof GitHubStorageError && error.code === "storage_not_configured") {
    return { status: 503, error: "storage_not_configured" };
  }
  if (error instanceof GitHubStorageError && error.code === "github_rate_limited") {
    return { status: 503, error: "storage_rate_limited" };
  }
  return { status: 503, error: "storage_unavailable" };
}

function createApp({ store, configProvider = loadConfig, now = () => Date.now() } = {}) {
  const app = express();
  let resolvedStore = store;
  const hitTimestamps = [];
  const statsTimestamps = [];

  function getStore() {
    if (!resolvedStore) resolvedStore = createDefaultStore();
    return resolvedStore;
  }

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,X-Counter-Stats-Token"
    );
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const serveCounterScript = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(path.join(PUBLIC_DIR, "counter.js"));
  };
  app.get(["/counter.js", "/public/counter.js"], serveCounterScript);
  app.use("/public", express.static(PUBLIC_DIR, { maxAge: "1h" }));

  app.get("/", (req, res) => {
    res.json({
      ok: true,
      name: "github-backed-pv-counter",
      storage: String(process.env.COUNTER_STORAGE || "github").toLowerCase(),
      endpoints: ["/hit", "/stats", "/counter.js"],
    });
  });

  function parseRequest(req, res, providedConfig) {
    const config = providedConfig || normalizeConfig(configProvider());
    const domain = sanitizeDomain(req.query.d);
    if (!domain) {
      res.status(400).json({ ok: false, error: "invalid_domain", msg: "invalid_domain" });
      return null;
    }
    if (!isAllowedDomain(domain, config)) {
      res.status(403).json({
        ok: false,
        error: "domain_not_allowed",
        msg: "domain_not_allowed",
      });
      return null;
    }

    const rawProject = req.query.p;
    const project = sanitizeProject(rawProject);
    if (rawProject != null && rawProject !== "" && !project) {
      res.status(400).json({ ok: false, error: "invalid_project", msg: "invalid_project" });
      return null;
    }

    return { config, domain, project };
  }

  function reserveRequest(timestamps, timestamp, max, windowMs) {
    if (max <= 0) return 0;
    const cutoff = timestamp - windowMs;
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
    if (timestamps.length >= max) {
      const retryAt = timestamps[0] + windowMs;
      return Math.max(1, Math.ceil((retryAt - timestamp) / 1000));
    }
    timestamps.push(timestamp);
    return 0;
  }

  async function hitHandler(req, res, providedConfig) {
    const parsed = parseRequest(req, res, providedConfig);
    if (!parsed) return;

    const { config, domain, project } = parsed;
    const timestamp = now();
    const retryAfter = reserveRequest(
      hitTimestamps,
      timestamp,
      config.rateLimitMax,
      config.rateLimitWindowMs
    );
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, error: "rate_limited", msg: "rate_limited" });
    }

    let updated;
    try {
      updated = await getStore().increment({
        domain,
        project,
        now: timestamp,
        visitorKey: visitorKeyForRequest(req, config, domain),
        maxProjects: config.maxProjectsPerDomain || Number.MAX_SAFE_INTEGER,
        maxVisitorKeys: config.maxVisitorKeysPerDomain || Number.MAX_SAFE_INTEGER,
      });
    } catch (error) {
      const result = publicStorageError(error);
      console.error("Counter storage write failed", {
        code: error && error.code ? error.code : "unknown",
        status: error && error.status ? error.status : 0,
      });
      return res.status(result.status).json({ ok: false, error: result.error, msg: result.error });
    }

    if (String(req.query.debug || "") === "1") {
      const selected = project ? updated.projects[project] : updated;
      return res.json({
        ok: true,
        domain,
        project: project || null,
        total: selected.total || 0,
        last: selected.last || timestamp,
        ts: timestamp,
      });
    }
    return res.status(204).end();
  }

  app.get("/hit", (req, res) => {
    const config = normalizeConfig(configProvider());
    if (!config.allowGetHits) {
      res.setHeader("Allow", "POST");
      return res.status(405).json({
        ok: false,
        error: "method_not_allowed",
        msg: "method_not_allowed",
      });
    }
    return hitHandler(req, res, config);
  });
  app.post("/hit", (req, res) => hitHandler(req, res));

  app.get("/stats", async (req, res) => {
    const parsed = parseRequest(req, res);
    if (!parsed) return;

    const { domain, project } = parsed;
    const includeIps = String(req.query.includeIps || "") === "1";
    const includeProjects = String(req.query.includeProjects || "") === "1";
    if (includeIps && parsed.config.ipMode === "raw" && !canReadIpStats(req, parsed.config)) {
      return res.status(403).json({
        ok: false,
        error: "ip_stats_forbidden",
        msg: "ip_stats_forbidden",
      });
    }
    const timestamp = now();
    const retryAfter = reserveRequest(
      statsTimestamps,
      timestamp,
      parsed.config.statsRateLimitMax,
      parsed.config.rateLimitWindowMs
    );
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, error: "rate_limited", msg: "rate_limited" });
    }
    let domainRecord;
    try {
      domainRecord = await getStore().readDomain(domain);
    } catch (error) {
      const result = publicStorageError(error);
      console.error("Counter storage read failed", {
        code: error && error.code ? error.code : "unknown",
        status: error && error.status ? error.status : 0,
      });
      return res.status(result.status).json({ ok: false, error: result.error, msg: result.error });
    }

    if (includeIps) {
      res.setHeader("Cache-Control", "private, no-store");
    } else if (parsed.config.statsCacheTtlMs > 0) {
      const cacheSeconds = Math.max(1, Math.floor(parsed.config.statsCacheTtlMs / 1000));
      res.setHeader(
        "Cache-Control",
        `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 3}`
      );
    }

    if (project) {
      const projectRecord = domainRecord.projects[project] || { total: 0, last: 0, ips: {} };
      if (includeIps && !canReadIpStats(req, parsed.config, projectRecord.ips)) {
        return res.status(403).json({
          ok: false,
          error: "ip_stats_forbidden",
          msg: "ip_stats_forbidden",
        });
      }
      const payload = {
        ok: true,
        domain,
        project,
        total: projectRecord.total || 0,
        last: projectRecord.last || 0,
      };
      if (includeIps) payload.ips = projectRecord.ips || {};
      return res.json(payload);
    }

    const payload = {
      ok: true,
      domain,
      total: domainRecord.total || 0,
      last: domainRecord.last || 0,
    };
    if (includeIps) {
      if (!canReadIpStats(req, parsed.config, domainRecord.ips)) {
        return res.status(403).json({
          ok: false,
          error: "ip_stats_forbidden",
          msg: "ip_stats_forbidden",
        });
      }
      payload.ips = domainRecord.ips || {};
    }
    if (includeProjects) {
      payload.projects = Object.fromEntries(
        Object.entries(domainRecord.projects || {}).map(([key, value]) => [
          key,
          { total: value.total || 0, last: value.last || 0 },
        ])
      );
    }
    return res.json(payload);
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Counter server running: http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
module.exports.createApp = createApp;
module.exports.loadConfig = loadConfig;
module.exports.normalizeConfig = normalizeConfig;
module.exports.visitorKeyForRequest = visitorKeyForRequest;
