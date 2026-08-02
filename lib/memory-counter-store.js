"use strict";

const { applyHit, emptyDomainRecord, normalizeDomainRecord } = require("./counter-record");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class MemoryCounterStore {
  constructor(initialRecords = {}) {
    this.records = new Map(
      Object.entries(initialRecords).map(([domain, value]) => [
        domain,
        normalizeDomainRecord(domain, value),
      ])
    );
    this.locks = new Map();
  }

  async readDomain(domain) {
    return clone(this.records.get(domain) || emptyDomainRecord(domain));
  }

  async increment(input) {
    const previous = this.locks.get(input.domain) || Promise.resolve();
    const operation = previous.then(() => {
      const current = this.records.get(input.domain) || emptyDomainRecord(input.domain);
      const next = applyHit(current, input);
      this.records.set(input.domain, next);
      return clone(next);
    });

    this.locks.set(input.domain, operation.catch(() => {}));
    return operation;
  }
}

module.exports = { MemoryCounterStore };
