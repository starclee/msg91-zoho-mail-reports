#!/usr/bin/env node
// Runs one poll cycle and exits. Point any scheduler at this: OS cron,
// `pm2`/systemd timer, a Catalyst AppSail container's own internal
// setInterval loop, etc. See ../README.md for why this - not a Catalyst
// serverless Function - is the recommended way to run the actual
// zip/CSV-heavy work.
'use strict';

require('dotenv').config();
const { checkForNewReports } = require('../src/processReports');

checkForNewReports()
  .then((threadCount) => {
    console.log('Processed ' + threadCount + ' thread(s).');
  })
  .catch((err) => {
    console.error('checkForNewReports failed:', err);
    process.exitCode = 1;
  });
