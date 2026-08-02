"use strict";

function emptyDomainRecord(domain) {
  return {
    version: 2,
    domain,
    total: 0,
    last: 0,
    ips: {},
    projects: {},
  };
}

function safeCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safeTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeIpMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.length > 0 && key.length <= 256)
      .map(([key, item]) => [
        key,
        {
          count: safeCount(item && item.count),
          first: safeTimestamp(item && item.first),
          last: safeTimestamp(item && item.last),
        },
      ])
  );
}

function normalizeDomainRecord(domain, value) {
  const record = emptyDomainRecord(domain);
  if (!value || typeof value !== "object" || Array.isArray(value)) return record;

  record.total = safeCount(value.total);
  record.last = safeTimestamp(value.last);
  record.ips = normalizeIpMap(value.ips);

  if (value.projects && typeof value.projects === "object" && !Array.isArray(value.projects)) {
    record.projects = Object.fromEntries(
      Object.entries(value.projects).map(([project, item]) => [
        project,
        {
          total: safeCount(item && item.total),
          last: safeTimestamp(item && item.last),
          ips: normalizeIpMap(item && item.ips),
        },
      ])
    );
  }

  return record;
}

function bumpIp(ips, visitorKey, now) {
  const key = String(visitorKey || "").trim();
  if (!key || key.length > 256) return false;

  const created = !Object.hasOwn(ips, key) || !ips[key] || typeof ips[key] !== "object";
  if (created) {
    ips[key] = { count: 0, first: now, last: now };
  }

  const item = ips[key];
  const previousFirst = safeTimestamp(item.first);
  item.count = safeCount(item.count) + 1;
  item.first = previousFirst > 0 ? Math.min(previousFirst, now) : now;
  item.last = Math.max(safeTimestamp(item.last), now);
  return created;
}

function countVisitorKeys(record) {
  return Object.keys(record.ips).length
    + Object.values(record.projects).reduce(
      (total, project) => total + Object.keys(project.ips || {}).length,
      0
    );
}

function applyHit(
  value,
  {
    domain,
    project,
    now,
    visitorKey = "",
    maxProjects = 100,
    maxVisitorKeys = 2_000,
  }
) {
  const record = normalizeDomainRecord(domain, value);
  const visitorLimit = maxVisitorKeys > 0 ? maxVisitorKeys : Number.MAX_SAFE_INTEGER;
  let visitorKeyCount = countVisitorKeys(record);
  const bumpIpWithinLimit = (ips) => {
    const key = String(visitorKey || "").trim();
    const exists = key && Object.hasOwn(ips, key);
    if (!exists && visitorKeyCount >= visitorLimit) return;
    if (bumpIp(ips, key, now)) visitorKeyCount += 1;
  };

  record.total += 1;
  record.last = Math.max(record.last, now);
  bumpIpWithinLimit(record.ips);

  if (project) {
    if (!Object.hasOwn(record.projects, project)) {
      if (Object.keys(record.projects).length >= maxProjects) {
        const error = new Error(`Domain project limit (${maxProjects}) reached`);
        error.code = "project_limit_reached";
        throw error;
      }
      record.projects[project] = { total: 0, last: 0, ips: {} };
    }
    const projectRecord = record.projects[project];
    projectRecord.total += 1;
    projectRecord.last = Math.max(projectRecord.last, now);
    bumpIpWithinLimit(projectRecord.ips);
  }

  return record;
}

module.exports = {
  applyHit,
  bumpIp,
  countVisitorKeys,
  emptyDomainRecord,
  normalizeIpMap,
  normalizeDomainRecord,
};
