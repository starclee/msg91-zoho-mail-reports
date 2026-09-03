// Zip handling. Node has native zlib (unlike Apps Script, which had to
// hand-roll a DEFLATE decoder in ../../Inflate.gs / ../../LargeZip.gs
// because it has no zip/inflate primitives at all) - yauzl on top of that
// gives streaming, entry-by-entry access to a zip's contents.
//
// Each CSV entry is read and fed into the aggregator chunk-by-chunk, then
// discarded before the next entry is opened - never holding more than one
// entry's decompressed content in memory at once, the same discipline the
// Apps Script version's comments describe as the fix for its "Out of
// memory" failures.
'use strict';

const yauzl = require('yauzl');
const { CsvAggregator } = require('./consolidate');

function isCsvName(name) {
  return /\.csv$/i.test(name);
}

// Aggregates every .csv entry inside a zip Buffer into rawCounts. Returns
// how many records it contributed.
function aggregateZipBufferIntoCounts(zipBuffer, rawCounts) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      let total = 0;

      zipfile.on('error', reject);
      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name) || !isCsvName(name)) {
          // directory entry, or not a CSV we care about
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) return reject(streamErr);

          const aggregator = new CsvAggregator(rawCounts);
          readStream.on('data', (chunk) => aggregator.feed(chunk));
          readStream.on('error', reject);
          readStream.on('end', () => {
            total += aggregator.end();
            zipfile.readEntry(); // move on only once this entry is fully drained
          });
        });
      });

      zipfile.on('end', () => resolve(total));
    });
  });
}

module.exports = { aggregateZipBufferIntoCounts, isCsvName };
