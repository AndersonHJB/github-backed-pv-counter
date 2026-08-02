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

function normalizeDomainRecord(domain, value) {
  const record = emptyDomainRecord(domain);
  if (!value || typeof value !== "object" || Array.isArray(value)) return record;

  record.total = safeCount(value.total);
  record.last = safeTimestamp(value.last);

  if (value.projects && typeof value.projects === "object" && !Array.isArray(value.projects)) {
    record.projects = Object.fromEntries(
      Object.entries(value.projects).map(([project, item]) => [
        project,
        {
          total: safeCount(item && item.total),
          last: safeTimestamp(item && item.last),
          ips: {},
        },
      ])
    );
  }

  return record;
}

function applyHit(value, { domain, project, now, maxProjects = 100 }) {
  const record = normalizeDomainRecord(domain, value);
  record.total += 1;
  record.last = Math.max(record.last, now);

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
  }

  return record;
}

module.exports = {
  applyHit,
  emptyDomainRecord,
  normalizeDomainRecord,
};
