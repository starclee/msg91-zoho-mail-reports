// Main orchestration - the Node/Zoho Mail equivalent of checkForNewReports/
// processThread_/collectReportSourcesFromMessage_ in ../../Code.gs.
//
// Known gap vs. the Gmail version: this only reads .zip/.csv *attachments*.
// The Gmail version also scans the message body for Google Drive links and
// resolves those via DriveApp. There's no Zoho WorkDrive equivalent wired
// up here - the Mail API research for this port didn't cover WorkDrive's
// API shape, and attachments are the common case. See README "Known gaps"
// for how you'd add WorkDrive shared-link support if you need it.
'use strict';

const zohoMail = require('./zohoMail');
const { notifyCliq } = require('./cliq');
const { finalizeConsolidation, buildConsolidatedReport, CsvAggregator } = require('./consolidate');
const { aggregateZipBufferIntoCounts, isCsvName } = require('./zip');
const { CONFIG } = require('./config');

function isZipName(name) {
  return /\.zip$/i.test(name);
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

// Fetches every zip/csv attachment on one message and aggregates each into
// its own { name, rawCounts, totalRecords } source - same one-source-per-
// file rule as the Gmail version, and the same "fetch, decompress, fold,
// discard" discipline before moving to the next attachment.
async function collectReportSourcesFromMessage(folderId, messageId) {
  const attachments = await zohoMail.listAttachments(folderId, messageId);
  const sources = [];

  for (const attachment of attachments) {
    const name = attachment.attachmentName;
    if (!isZipName(name) && !isCsvName(name)) continue;

    const buffer = await zohoMail.downloadAttachment(folderId, messageId, attachment.attachmentId);
    const rawCounts = {};
    let totalRecords = 0;

    if (isZipName(name)) {
      totalRecords = await aggregateZipBufferIntoCounts(buffer, rawCounts);
    } else {
      const aggregator = new CsvAggregator(rawCounts);
      aggregator.feed(buffer);
      totalRecords = aggregator.end();
    }

    sources.push({ name: stripExtension(name), rawCounts, totalRecords });
  }

  return sources;
}

// Plain-text summary for one source's own customer-wise split - sent both
// as the per-file email body and (bulleted) to Cliq.
function sourceEmailBody(sourceName, result) {
  return (
    'Report extracted: ' + sourceName + '\n\n' +
    'Total records: ' + result.totalRecords + '\n\n' +
    'Customer-wise split:\n' + JSON.stringify(result.customerSplit, null, 2) +
    (result.unresolvedKeys.length
      ? '\n\nUnresolved Sender IDs (add these to src/clientLookup.js): ' + result.unresolvedKeys.join(', ')
      : '')
  );
}

function sourceCliqText(sourceName, result) {
  const lines = ['*Report extracted: ' + sourceName + '*', 'Total records: ' + result.totalRecords, ''];
  for (const key in result.customerSplit) {
    lines.push('• ' + key + ': ' + result.customerSplit[key]);
  }
  if (result.unresolvedKeys.length) {
    lines.push('');
    lines.push('_Unresolved Sender IDs (add to src/clientLookup.js): ' + result.unresolvedKeys.join(', ') + '_');
  }
  return lines.join('\n');
}

function consolidatedEmailBody(sourceNames, merged) {
  return (
    'Consolidated report across ' + sourceNames.length + ' file(s): ' + sourceNames.join(', ') + '\n\n' +
    'Total records: ' + merged.totalRecords + '\n\n' +
    'Consolidated (all files merged):\n' + JSON.stringify(merged.consolidated, null, 2) +
    (merged.unresolvedKeys.length
      ? '\n\nUnresolved Sender IDs (add these to src/clientLookup.js): ' + merged.unresolvedKeys.join(', ')
      : '')
  );
}

function consolidatedCliqText(sourceNames, merged) {
  const lines = [
    '*Consolidated report across ' + sourceNames.length + ' file(s): ' + sourceNames.join(', ') + '*',
    'Total records: ' + merged.totalRecords,
    '',
  ];
  for (const key in merged.consolidated) {
    lines.push('• ' + key + ': ' + merged.consolidated[key]);
  }
  if (merged.unresolvedKeys.length) {
    lines.push('');
    lines.push('_Unresolved Sender IDs (add to src/clientLookup.js): ' + merged.unresolvedKeys.join(', ') + '_');
  }
  return lines.join('\n');
}

// Processes every message in one Zoho Mail thread (grouped by threadId by
// the caller). Sends one email per source (customer-wise split) plus, once
// all of the thread's sources are processed, one further email merging
// them into the true consolidated report - so a thread with N sources
// produces N+1 emails, same as processThread_ in Code.gs.
async function processThread(messages) {
  const processedNames = [];
  const sourceResults = [];
  // Reply against the thread's newest message, mirroring Code.gs's use of
  // thread.replyAll() for the final consolidated email (Zoho Mail's API has
  // no thread-level object - it operates message-by-message).
  const newestMessage = messages.reduce((a, b) => (a.receivedTime > b.receivedTime ? a : b));

  for (const message of messages) {
    const sources = await collectReportSourcesFromMessage(message.folderId, message.messageId);
    for (const source of sources) {
      if (source.totalRecords === 0) continue;
      const result = finalizeConsolidation(source.rawCounts, source.totalRecords);

      await zohoMail.replyAll(message.folderId, message.messageId, {
        subject: 'Report extracted: ' + source.name,
        content: sourceEmailBody(source.name, result),
      });
      await notifyCliq(sourceCliqText(source.name, result));

      processedNames.push(source.name);
      sourceResults.push({ name: source.name, result });
    }
  }

  if (sourceResults.length > 0) {
    const merged = buildConsolidatedReport(sourceResults);
    const sourceNames = sourceResults.map((entry) => entry.name);
    await zohoMail.replyAll(newestMessage.folderId, newestMessage.messageId, {
      subject: 'Consolidated report',
      content: consolidatedEmailBody(sourceNames, merged),
    });
    await notifyCliq(consolidatedCliqText(sourceNames, merged));
  }

  return processedNames;
}

function groupByThread(messages) {
  const groups = new Map();
  messages.forEach((msg) => {
    const key = msg.threadId || msg.messageId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(msg);
  });
  return [...groups.values()];
}

async function checkForNewReports() {
  const [triggerLabelId, processedLabelId, errorLabelId] = await Promise.all([
    zohoMail.getOrCreateLabelId(CONFIG.triggerLabel),
    zohoMail.getOrCreateLabelId(CONFIG.processedLabel),
    zohoMail.getOrCreateLabelId(CONFIG.errorLabel),
  ]);

  const messages = await zohoMail.findUnprocessedMessages(
    triggerLabelId,
    [processedLabelId, errorLabelId],
    CONFIG.pollBatchSize
  );

  const threads = groupByThread(messages);

  for (const threadMessages of threads) {
    const messageIds = threadMessages.map((m) => m.messageId);
    try {
      const processed = await processThread(threadMessages);
      if (processed.length > 0) {
        await Promise.all(messageIds.map((id) => zohoMail.applyLabel(id, processedLabelId)));
      } else {
        await Promise.all(messageIds.map((id) => zohoMail.applyLabel(id, errorLabelId)));
        await alertOnError(
          'No zip/CSV report found in email',
          'A thread with ' + threadMessages.length + ' message(s) matched the ' + CONFIG.triggerLabel +
            ' tag but no .zip/.csv attachment was found on any of them.'
        );
      }
    } catch (err) {
      await Promise.all(messageIds.map((id) => zohoMail.applyLabel(id, errorLabelId)));
      await alertOnError('Report extraction failed', String(err));
    }
  }

  return threads.length;
}

// Alerts on a per-thread failure both ways, mirroring notify_() (email) and
// notifyCliq_() (Cliq) in the Gmail version's Code.gs - unlike those, a
// failure to send the alert itself is only logged, not thrown, so one bad
// notification never masks the underlying error or aborts the rest of the
// poll cycle.
async function alertOnError(subject, body) {
  console.error(subject + ': ' + body);
  await notifyCliq('*' + subject + '*\n' + body).catch((err) =>
    console.error('Cliq alert failed:', err)
  );
  await zohoMail
    .sendMail({ toAddress: CONFIG.notifyEmail, subject, content: body })
    .catch((err) => console.error('Error-notification email failed:', err));
}

module.exports = { checkForNewReports };
