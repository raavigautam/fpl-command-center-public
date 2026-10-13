#!/usr/bin/env node
/*
 * Runs every suite in this folder. `node test/run.cjs`
 *
 * These files are .cjs, not .js, deliberately: `.clasp.json` sets
 * scriptExtensions to [".js", ".gs"] with skipSubdirectories false, so the
 * deploy workflow's `clasp push -f` would upload any .js anywhere in the repo
 * into the Apps Script project. A .cjs is invisible to clasp and still runs as
 * CommonJS under Node without a package.json, so the tests can live beside the
 * source without touching the deploy pipeline.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname)
  .filter(f => f.startsWith('test_') && f.endsWith('.cjs'))
  .sort();

let failed = 0;
suites.forEach(function (s) {
  process.stdout.write('\n=== ' + s + ' ===\n');
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, s)], { encoding: 'utf8' }));
  } catch (err) {
    failed++;
    process.stdout.write((err.stdout || '') + (err.stderr || ''));
  }
});

process.stdout.write('\n' + (failed
  ? failed + ' of ' + suites.length + ' suite(s) FAILED\n'
  : 'all ' + suites.length + ' suite(s) passed\n'));
process.exit(failed ? 1 : 0);
