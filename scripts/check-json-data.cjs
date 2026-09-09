#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const root = path.resolve(__dirname, "..");
const dataManifest = JSON.parse(fs.readFileSync(path.join(root, "data", "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
const jsonManifest = JSON.parse(fs.readFileSync(path.join(root, "data", "json-manifest.json"), "utf8"));
let errors = 0;
let checked = 0;

for (const source of dataManifest.files || []) {
  if (!/\.(xlsx|xlsm|xls)$/i.test(source) || /^~\$/.test(path.basename(source))) continue;
  const entry = jsonManifest.files && jsonManifest.files[source];
  if (!entry) continue;
  const jsonFile = path.join(root, "data", entry.json);
  if (!fs.existsSync(jsonFile)) {
    console.error(`Missing JSON: ${entry.json}`);
    errors += 1;
    continue;
  }
  const payload = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  for (const key of ["summary", "details", "reasonWeeks", "top20Entries"]) {
    if (!Array.isArray(payload[key])) {
      console.error(`${entry.json}: ${key} is not an array`);
      errors += 1;
    }
  }
  if (payload.source !== source || payload.sourceSha256 !== entry.sourceSha256) {
    console.error(`${entry.json}: source metadata mismatch`);
    errors += 1;
  }
  const sourceFile = path.join(root, "data", source);
  if (!fs.existsSync(sourceFile) || sha256(fs.readFileSync(sourceFile)) !== entry.sourceSha256) {
    console.error(`${source}: source file hash mismatch; rerun npm run convert:data`);
    errors += 1;
  }
  const rowCounts = {
    summaryRows: payload.summary.length,
    detailRows: payload.details.length,
    reasonRows: payload.reasonWeeks.length,
    top20Rows: payload.top20Entries.length
  };
  for (const [key, value] of Object.entries(rowCounts)) {
    if (entry[key] !== value) {
      console.error(`${entry.json}: ${key} mismatch (${value} != ${entry[key]})`);
      errors += 1;
    }
  }
  if (entry.jsonBytes !== fs.statSync(jsonFile).size) {
    console.error(`${entry.json}: byte size mismatch`);
    errors += 1;
  }
  checked += 1;
}

if (!checked) {
  console.error("No generated JSON files were checked.");
  process.exit(1);
}
console.log(`Checked ${checked} JSON files; ${errors} error(s).`);
if (errors) process.exit(1);
