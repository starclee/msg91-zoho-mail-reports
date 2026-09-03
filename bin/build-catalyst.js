#!/usr/bin/env node
// Copies src/ into catalyst/msg91-report-cron/src/ before `catalyst deploy`.
// Catalyst zips and deploys only a function's own directory, so the shared
// modules under ../src (used by both bin/run-once.js and the Catalyst
// adapter) have to be duplicated in rather than required across directories.
'use strict';

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const destDir = path.join(__dirname, '..', 'catalyst', 'msg91-report-cron', 'src');

fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });

console.log('Copied ' + srcDir + ' -> ' + destDir);
