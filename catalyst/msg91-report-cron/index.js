// Catalyst Cron function adapter. IMPORTANT - read README.md "Catalyst
// deployment caveat" first: Catalyst serverless functions (this included)
// are documented as having short execution timeouts, which is a poor fit
// for hundreds-of-MB zip/CSV processing. This adapter is only safe to
// deploy as-is for small/moderate report volumes; for the general case,
// run bin/run-once.js on a schedule outside Catalyst (a VM/cron, or a
// Catalyst AppSail container, which is not timeout-limited the same way)
// instead of this function.
//
// Catalyst only bundles this function's own directory on deploy, so the
// shared ../../src modules must be copied in here first - run
// `npm run build:catalyst` from the zoho-script root before `catalyst deploy`.
'use strict';

const { checkForNewReports } = require('./src/processReports');

module.exports = async (req, res) => {
  try {
    const threadCount = await checkForNewReports();
    res.status(200).send('Processed ' + threadCount + ' thread(s).');
  } catch (err) {
    console.error('checkForNewReports failed:', err);
    res.status(500).send(String(err));
  }
};
