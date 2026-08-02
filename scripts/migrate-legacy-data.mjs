import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function safeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeLegacyVisitor(value) {
  const visitor = String(value || "").trim();
  if (visitor.startsWith("::ffff:") && net.isIP(visitor.slice(7)) === 4) {
    return visitor.slice(7);
  }
  return visitor;
}

function hashVisitor(domain, visitor, secret) {
  return `h:${crypto
    .createHmac("sha256", secret)
    .update(`github-backed-pv-counter\0v1\0${domain}\0${visitor}`)
    .digest("base64url")}`;
}

function migrateIpMap(domain, value, secret) {
  if (!secret || !isObject(value)) return {};
  const migrated = {};

  for (const [legacyVisitor, item] of Object.entries(value)) {
    const visitor = normalizeLegacyVisitor(legacyVisitor);
    if (!visitor || !isObject(item)) continue;
    const key = hashVisitor(domain, visitor, secret);
    const previous = migrated[key];
    const first = safeNumber(item.first);
    const last = safeNumber(item.last);
    if (!previous) {
      migrated[key] = { count: safeNumber(item.count), first, last };
      continue;
    }
    previous.count += safeNumber(item.count);
    previous.first = previous.first > 0 && first > 0
      ? Math.min(previous.first, first)
      : Math.max(previous.first, first);
    previous.last = Math.max(previous.last, last);
  }

  return migrated;
}

export function splitLegacyData(value, { ipHashSecret = "" } = {}) {
  if (!isObject(value)) throw new Error("Legacy data must be a JSON object");
  const secret = String(ipHashSecret || "").trim();
  if (secret && Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("COUNTER_IP_HASH_SECRET must be at least 32 bytes");
  }
  const domains = isObject(value.domains) ? value.domains : value;
  const records = new Map();

  for (const [domainValue, item] of Object.entries(domains)) {
    const domain = String(domainValue).toLowerCase().trim();
    if (!/^[a-z0-9.-]{1,253}$/.test(domain) || !isObject(item)) continue;

    const projects = {};
    if (isObject(item.projects)) {
      for (const [projectValue, projectItem] of Object.entries(item.projects)) {
        const project = String(projectValue).toLowerCase().trim();
        if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(project) || !isObject(projectItem)) {
          continue;
        }
        projects[project] = {
          total: safeNumber(projectItem.total),
          last: safeNumber(projectItem.last),
          ips: migrateIpMap(domain, projectItem.ips, secret),
        };
      }
    }

    records.set(domain, {
      version: 2,
      domain,
      total: safeNumber(item.total),
      last: safeNumber(item.last),
      ips: migrateIpMap(domain, item.ips, secret),
      projects,
    });
  }

  return records;
}

function parseArgs(argv) {
  const args = { force: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (arg === "--input" || arg === "--output") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a path`);
      args[arg.slice(2)] = next;
      index += 1;
    }
  }
  if (!args.input || !args.output) {
    throw new Error("Usage: npm run migrate:legacy -- --input <data.json> --output <data/domains> [--force]");
  }
  return args;
}

export async function migrateLegacyFile({
  input,
  output,
  force = false,
  ipHashSecret = process.env.COUNTER_IP_HASH_SECRET || "",
  maxFileBytes = process.env.COUNTER_GITHUB_MAX_FILE_BYTES,
  maxVisitorKeys = process.env.COUNTER_MAX_VISITOR_KEYS_PER_DOMAIN,
}) {
  const inputPath = path.resolve(input);
  const outputDirectory = path.resolve(output);
  const secret = String(ipHashSecret || "").trim();
  const fileLimit = positiveInteger(maxFileBytes, 512 * 1024);
  const visitorLimit = nonNegativeInteger(maxVisitorKeys, 2_000);
  const raw = await fs.readFile(inputPath, "utf8");
  const records = splitLegacyData(JSON.parse(raw), { ipHashSecret: secret });
  if (records.size === 0) throw new Error("No valid domain records found in the legacy file");

  const entries = [...records.entries()].sort(([a], [b]) => a.localeCompare(b));
  const prepared = entries.map(([domain, record]) => {
    const visitorCount = Object.keys(record.ips).length
      + Object.values(record.projects).reduce(
        (total, project) => total + Object.keys(project.ips || {}).length,
        0
      );
    if (visitorLimit > 0 && visitorCount > visitorLimit) {
      throw new Error(
        `${domain} has ${visitorCount} visitor entries, exceeding the configured limit of ${visitorLimit}`
      );
    }
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > fileLimit) {
      throw new Error(
        `${domain}.json is ${bytes} bytes, exceeding the configured limit of ${fileLimit}`
      );
    }
    return { domain, serialized };
  });

  await fs.mkdir(outputDirectory, { recursive: true });
  if (!force) {
    for (const { domain } of prepared) {
      const destination = path.join(outputDirectory, `${domain}.json`);
      try {
        await fs.access(destination);
        throw new Error(`${destination} already exists; pass --force to replace it`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  for (const { domain, serialized } of prepared) {
    const destination = path.join(outputDirectory, `${domain}.json`);
    const temporary = `${destination}.tmp-${process.pid}`;
    await fs.writeFile(temporary, serialized, "utf8");
    await fs.rename(temporary, destination);
  }

  return {
    inputPath,
    outputDirectory,
    count: records.size,
    preservedVisitorStats: Buffer.byteLength(secret, "utf8") >= 32,
  };
}

async function main() {
  const result = await migrateLegacyFile(parseArgs(process.argv));
  console.log(`Migrated ${result.count} domains from ${result.inputPath} to ${result.outputDirectory}`);
  console.log(
    result.preservedVisitorStats
      ? "Legacy visitor maps were converted to domain-isolated HMAC identifiers."
      : "Raw legacy IP maps were excluded because COUNTER_IP_HASH_SECRET was not set."
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
