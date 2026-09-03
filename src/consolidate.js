// Core sender-consolidation logic - same rules as ../../Consolidate.gs.
// CsvAggregator is a streaming, chunk-fed port of that file's hand-rolled
// aggregateCsvText_ parser: it never materializes a full parsed-rows array,
// so a chunk-at-a-time feed (as bytes come off an unzip stream) never holds
// more than one CSV row in memory at once - the same "why" as the Apps
// Script version, just adapted to Node's stream-of-buffers world instead of
// Apps Script's one-big-string world.
'use strict';

const { CLIENT_LOOKUP } = require('./clientLookup');

// Sender IDs that carry the actual client code inside the Message text
// instead of the Sender ID field itself. Compared case-insensitively.
const AUTONM_SENDER_IDS = ['automn', 'AUTOMN', 'autonm'].map((id) => id.toLowerCase());

function buildSenderNameLookup() {
  const lookup = {};
  CLIENT_LOOKUP.forEach((entry) => {
    lookup[entry.senderId.toLowerCase()] = entry.senderName;
  });
  return lookup;
}

function extractClientCode(message) {
  if (!message) return undefined;
  const firstSentence = String(message).split('.')[0].split(' ');
  return firstSentence[firstSentence.length - 1];
}

function coerce(value) {
  if (value !== '' && /^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (isFinite(num)) return num;
  }
  return value;
}

function addCount(counts, key, n) {
  if (!key) return;
  counts[key] = (counts[key] || 0) + (n || 1);
}

// Streaming CSV parser/aggregator. Call feed() with successive chunks
// (Buffer or string) as they arrive from a zip entry's read stream, then
// end() once the entry is exhausted. Folds rows straight into rawCounts as
// each one completes - the same one-row-at-a-time discipline as
// aggregateCsvText_ in Consolidate.gs.
class CsvAggregator {
  constructor(rawCounts) {
    this.rawCounts = rawCounts;
    this.headers = null;
    this.hasSmsCount = false;
    this.recordCount = 0;

    this.row = [];
    this.field = '';
    this.inQuotes = false;
  }

  _commitRow() {
    this.row.push(this.field);
    this.field = '';

    const isBlank = this.row.length === 1 && this.row[0] === '';
    if (!isBlank) {
      if (!this.headers) {
        this.headers = this.row;
        this.hasSmsCount = this.headers.indexOf('SMS Count') !== -1;
      } else {
        const record = {};
        for (let i = 0; i < this.headers.length; i++) {
          const value = this.row[i];
          if (value === undefined || value === '') continue;
          record[this.headers[i]] = coerce(value);
        }

        // Sender-ID-to-client extraction from Message only applies to
        // "SMS Count" reports, where Message is a decrypted, readable
        // sentence. Plain OTP/delivery logs carry an encrypted Message, so
        // those are always counted by Sender ID directly.
        const senderId = record['Sender ID'];
        const isAutonm =
          typeof senderId === 'string' && AUTONM_SENDER_IDS.indexOf(senderId.toLowerCase()) !== -1;
        const key = this.hasSmsCount && isAutonm ? extractClientCode(record['Message']) : senderId;
        addCount(this.rawCounts, key);
        this.recordCount++;
      }
    }

    this.row = [];
  }

  feed(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);

      if (this.inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') {
            this.field += '"';
            i++;
          } else {
            this.inQuotes = false;
          }
        } else {
          this.field += ch;
        }
        continue;
      }

      if (ch === '"') {
        this.inQuotes = true;
      } else if (ch === ',') {
        this.row.push(this.field);
        this.field = '';
      } else if (ch === '\r') {
        // part of a CRLF line ending, handled on the following "\n"
      } else if (ch === '\n') {
        this._commitRow();
      } else {
        this.field += ch;
      }
    }
  }

  end() {
    if (this.field !== '' || this.row.length > 0) {
      this._commitRow();
    }
    return this.recordCount;
  }
}

// Convenience one-shot wrapper for when the whole CSV text is already a
// single string/Buffer in hand (small files - no streaming needed).
function aggregateCsvText(text, rawCounts) {
  const aggregator = new CsvAggregator(rawCounts);
  aggregator.feed(text);
  return aggregator.end();
}

// Per-source result: splits one file's records out by customer. This is
// NOT the cross-file "consolidated" report - that only exists once
// buildConsolidatedReport below merges several of these together. Mirrors
// finalizeConsolidation_ in Consolidate.gs.
function finalizeConsolidation(rawCounts, totalRecords) {
  const senderNameLookup = buildSenderNameLookup();
  const customerSplit = {};
  const unresolvedKeys = [];
  const seenUnresolved = {};
  for (const key in rawCounts) {
    const name = senderNameLookup[key.toLowerCase()];
    if (!name && !seenUnresolved[key]) {
      unresolvedKeys.push(key);
      seenUnresolved[key] = true;
    }
    addCount(customerSplit, name || key, rawCounts[key]);
  }

  return {
    totalRecords,
    customerSplit,
    rawCounts,
    unresolvedKeys,
  };
}

// Merges several sources' customerSplit results into one true consolidated
// report - matching customer names from different files are summed
// together here, unlike each source's own customerSplit, which only
// reflects that one file. sourceResults is an array of
// { name, result: <finalizeConsolidation output> }.
function buildConsolidatedReport(sourceResults) {
  const consolidated = {};
  let totalRecords = 0;
  const unresolvedKeys = [];
  const seenUnresolved = {};

  sourceResults.forEach((entry) => {
    const result = entry.result;
    totalRecords += result.totalRecords;
    for (const name in result.customerSplit) {
      addCount(consolidated, name, result.customerSplit[name]);
    }
    result.unresolvedKeys.forEach((key) => {
      if (!seenUnresolved[key]) {
        unresolvedKeys.push(key);
        seenUnresolved[key] = true;
      }
    });
  });

  return { totalRecords, consolidated, unresolvedKeys };
}

module.exports = {
  CsvAggregator,
  aggregateCsvText,
  finalizeConsolidation,
  buildConsolidatedReport,
  addCount,
};
