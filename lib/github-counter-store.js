"use strict";

const { applyHit, emptyDomainRecord, normalizeDomainRecord } = require("./counter-record");

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_API_VERSION = "2022-11-28";

class GitHubStorageError extends Error {
  constructor(message, { code = "github_storage_error", status = 0 } = {}) {
    super(message);
    this.name = "GitHubStorageError";
    this.code = code;
    this.status = status;
  }
}

function validateRepository(repository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository || "");
  if (!match) {
    throw new GitHubStorageError(
      "COUNTER_GITHUB_REPOSITORY must use the owner/repository format",
      { code: "storage_not_configured" }
    );
  }
  return { owner: match[1], repo: match[2] };
}

function validateDirectory(directory) {
  const value = String(directory || "data/domains").replace(/^\/+|\/+$/g, "");
  if (!value || value.split("/").some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new GitHubStorageError("Invalid GitHub data directory", {
      code: "storage_not_configured",
    });
  }
  return value;
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function decodeContent(content) {
  return Buffer.from(String(content || "").replace(/\s/g, ""), "base64").toString("utf8");
}

function responseMessage(payload) {
  return payload && typeof payload.message === "string" ? payload.message : "";
}

function isRetryableConflict(status, payload) {
  if (status === 409) return true;
  if (status !== 422) return false;
  return /sha|already exists|does not match|update/i.test(responseMessage(payload));
}

class GitHubCounterStore {
  constructor({
    token,
    repository,
    branch = "main",
    directory = "data/domains",
    apiBase = DEFAULT_API_BASE,
    apiVersion = DEFAULT_API_VERSION,
    fetchImpl = globalThis.fetch,
    maxConflictRetries = 6,
    maxFileBytes = 512 * 1024,
    readCacheTtlMs = 10_000,
    requestTimeoutMs = 8_000,
    retryDelay = (attempt) =>
      new Promise((resolve) =>
        setTimeout(resolve, 50 * 2 ** attempt + Math.floor(Math.random() * 50))
      ),
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new GitHubStorageError("A Fetch API implementation is required", {
        code: "storage_not_configured",
      });
    }

    const { owner, repo } = validateRepository(repository);
    this.owner = owner;
    this.repo = repo;
    this.token = String(token || "").trim();
    this.branch = String(branch || "main").trim();
    this.directory = validateDirectory(directory);
    this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
    this.maxConflictRetries = maxConflictRetries;
    this.maxFileBytes = maxFileBytes;
    this.readCacheTtlMs = readCacheTtlMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryDelay = retryDelay;
    this.locks = new Map();
    this.readCache = new Map();
  }

  filePath(domain) {
    if (!/^[a-z0-9.-]{1,253}$/.test(domain || "")) {
      throw new GitHubStorageError("Invalid domain storage key", { code: "invalid_domain" });
    }
    return `${this.directory}/${domain}.json`;
  }

  contentUrl(domain) {
    const repository = `${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
    return `${this.apiBase}/repos/${repository}/contents/${encodePath(this.filePath(domain))}`;
  }

  branchUrl() {
    const repository = `${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
    return `${this.apiBase}/repos/${repository}/branches/${encodeURIComponent(this.branch)}`;
  }

  headers() {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "github-backed-pv-counter",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async parseJson(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GitHubStorageError("GitHub returned invalid JSON", {
        code: "github_invalid_response",
        status: response.status,
      });
    }
  }

  async requestJson(url, options) {
    const execute = async (requestOptions) => {
      const response = await this.fetchImpl(url, requestOptions);
      const payload = await this.parseJson(response);
      return { response, payload };
    };

    if (!(this.requestTimeoutMs > 0)) return execute(options);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await execute({ ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async readSnapshot(domain) {
    let response;
    let payload;
    try {
      const url = `${this.contentUrl(domain)}?ref=${encodeURIComponent(this.branch)}`;
      ({ response, payload } = await this.requestJson(url, {
        method: "GET",
        headers: this.headers(),
        cache: "no-store",
      }));
    } catch (error) {
      if (error instanceof GitHubStorageError) throw error;
      throw new GitHubStorageError(`Unable to reach GitHub: ${error.message}`, {
        code: "github_unreachable",
      });
    }

    if (response.status === 404) {
      await this.verifyTarget();
      return { record: emptyDomainRecord(domain), sha: null };
    }
    if (!response.ok) {
      throw new GitHubStorageError(`GitHub read failed with HTTP ${response.status}`, {
        code: response.status === 403 || response.status === 429 ? "github_rate_limited" : "github_read_failed",
        status: response.status,
      });
    }

    if (!payload || payload.type !== "file" || payload.encoding !== "base64") {
      throw new GitHubStorageError("Unexpected GitHub Contents API payload", {
        code: "github_invalid_response",
        status: response.status,
      });
    }

    let value;
    try {
      value = JSON.parse(decodeContent(payload.content));
    } catch {
      throw new GitHubStorageError("Stored counter file is not valid JSON", {
        code: "github_invalid_data",
        status: response.status,
      });
    }

    return { record: normalizeDomainRecord(domain, value), sha: payload.sha };
  }

  async verifyTarget() {
    let response;
    try {
      ({ response } = await this.requestJson(this.branchUrl(), {
        method: "GET",
        headers: this.headers(),
        cache: "no-store",
      }));
    } catch (error) {
      if (error instanceof GitHubStorageError) throw error;
      throw new GitHubStorageError(`Unable to reach GitHub: ${error.message}`, {
        code: "github_unreachable",
      });
    }

    if (response.ok) return;
    throw new GitHubStorageError(
      `GitHub repository or branch validation failed with HTTP ${response.status}`,
      {
        code: response.status === 403 || response.status === 429
          ? "github_rate_limited"
          : "storage_not_configured",
        status: response.status,
      }
    );
  }

  async readDomain(domain) {
    const cached = this.readCache.get(domain);
    if (cached && cached.expiresAt > Date.now()) {
      return normalizeDomainRecord(domain, cached.record);
    }
    const { record } = await this.readSnapshot(domain);
    this.cacheRecord(domain, record);
    return record;
  }

  cacheRecord(domain, record) {
    if (this.readCacheTtlMs <= 0) return;
    this.readCache.set(domain, {
      record: normalizeDomainRecord(domain, record),
      expiresAt: Date.now() + this.readCacheTtlMs,
    });
  }

  async writeSnapshot(domain, record, sha, message) {
    if (!this.token) {
      throw new GitHubStorageError("COUNTER_GITHUB_TOKEN is required for writes", {
        code: "storage_not_configured",
      });
    }

    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes) {
      throw new GitHubStorageError("Counter file exceeded the configured size limit", {
        code: "counter_capacity_reached",
      });
    }

    const body = {
      message,
      content: Buffer.from(serialized, "utf8").toString("base64"),
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    let response;
    let payload;
    try {
      ({ response, payload } = await this.requestJson(this.contentUrl(domain), {
        method: "PUT",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    } catch (error) {
      if (error instanceof GitHubStorageError) throw error;
      throw new GitHubStorageError(`Unable to reach GitHub: ${error.message}`, {
        code: "github_unreachable",
      });
    }

    if (response.ok) return { payload, conflict: false };
    if (isRetryableConflict(response.status, payload)) {
      return { payload, conflict: true, status: response.status };
    }

    throw new GitHubStorageError(`GitHub write failed with HTTP ${response.status}`, {
      code: response.status === 403 || response.status === 429 ? "github_rate_limited" : "github_write_failed",
      status: response.status,
    });
  }

  async incrementWithRetries(input) {
    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const { record, sha } = await this.readSnapshot(input.domain);
      const next = applyHit(record, input);
      const projectSuffix = input.project ? `/${input.project}` : "";
      const result = await this.writeSnapshot(
        input.domain,
        next,
        sha,
        `count: record visit for ${input.domain}${projectSuffix}`
      );

      if (!result.conflict) {
        this.cacheRecord(input.domain, next);
        return next;
      }
      if (attempt < this.maxConflictRetries) await this.retryDelay(attempt);
    }

    throw new GitHubStorageError("GitHub counter update exceeded the conflict retry limit", {
      code: "github_conflict",
      status: 409,
    });
  }

  async increment(input) {
    const previous = this.locks.get(input.domain) || Promise.resolve();
    const operation = previous.then(() => this.incrementWithRetries(input));
    const tail = operation.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(input.domain, tail);
    tail.then(() => {
      if (this.locks.get(input.domain) === tail) this.locks.delete(input.domain);
    });
    return operation;
  }
}

module.exports = {
  GitHubCounterStore,
  GitHubStorageError,
};
