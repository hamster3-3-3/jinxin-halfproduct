#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const XLSX = require("xlsx");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT_DIR = path.join(ROOT, "data-json");
const SOURCE_MANIFEST = path.join(DATA_DIR, "manifest.json");
const JSON_MANIFEST = path.join(DATA_DIR, "json-manifest.json");
const INDEX_HTML = path.join(ROOT, "index.html");
const CONVERTER_SCHEMA_VERSION = 2;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch (_) { return fallback; }
}

function safePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error(`Unsafe path: ${relativePath}`);
  return normalized;
}

function scanExcelFiles(directory, relativeDirectory = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanExcelFiles(absolutePath, relativePath));
    } else if (entry.isFile() && /\.(xlsx|xlsm|xls)$/i.test(entry.name) && !/^~\$/.test(entry.name)) {
      files.push(safePath(relativePath));
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
}

function writeSourceManifest(files) {
  const previous = readJson(SOURCE_MANIFEST, {});
  const manifest = {
    version: Number(previous.version) || 1,
    basePath: typeof previous.basePath === "string" ? previous.basePath : "",
    files
  };
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  const current = fs.existsSync(SOURCE_MANIFEST)
    ? fs.readFileSync(SOURCE_MANIFEST, "utf8").replace(/^\uFEFF/, "")
    : "";
  if (current !== next) {
    fs.writeFileSync(SOURCE_MANIFEST, next);
    console.log(`Updated data/manifest.json (${files.length} Excel files).`);
  }
  return manifest;
}

function createDomStub() {
  const classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
  const element = () => ({
    classList,
    style: {},
    dataset: {},
    options: [],
    value: "",
    textContent: "",
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getContext() { return null; },
    setAttribute() {},
    removeAttribute() {},
    scrollIntoView() {},
    closest() { return null; }
  });
  return {
    body: element(),
    head: element(),
    documentElement: element(),
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: element
  };
}

function loadDashboardParsers() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  if (!scripts.some(source => source.includes("function parseSummaryFromWB"))) {
    throw new Error("Unable to locate the dashboard parser script in index.html");
  }

  // The dashboard keeps shared helpers (for example normKey) in an earlier inline script.
  // Evaluate every inline script together, but remove the browser-only startup call.
  const source = scripts.join("\n").replace(/\n\s*init\(\);\s*$/m, "\n");
  // Include the converter schema so pipeline-only changes also invalidate cached JSON.
  const parserHash = sha256(`${CONVERTER_SCHEMA_VERSION}\n${source}`);
  const document = createDomStub();
  const sandbox = {
    XLSX,
    console,
    document,
    navigator: {},
    location: { href: "", search: "", hash: "" },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    Chart: function Chart() {},
    fetch: async () => { throw new Error("Network access is disabled while converting data"); },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Blob,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    Intl
  };
  sandbox.window = Object.assign(sandbox, {
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
    open() {}
  });
  vm.createContext(sandbox);
  vm.runInContext(`${source}
;globalThis.__dashboardParsers = {
  parseSummaryFromWB,
  parseDetailsFromWB,
  parseReasonFromWB,
  parseTop20FromWB,
  isWasteFile,
  isJfmFile,
  dedupePayload(payload) {
    const saved = {
      summary: state.summary,
      details: state.details,
      reasonWeeks: state.reasonWeeks,
      top20Entries: state.top20Entries
    };
    state.summary = payload.summary || [];
    state.details = payload.details || [];
    state.reasonWeeks = payload.reasonWeeks || [];
    state.top20Entries = payload.top20Entries || [];
    dedupeLoadedData();
    const result = {
      summary: state.summary,
      details: state.details,
      reasonWeeks: state.reasonWeeks,
      top20Entries: state.top20Entries
    };
    Object.assign(state, saved);
    return result;
  }
};`, sandbox, {
    filename: "index.html",
    timeout: 15000
  });
  return { parserHash, parsers: sandbox.__dashboardParsers };
}

function main() {
  const previous = readJson(JSON_MANIFEST, { files: {} });
  const { parserHash, parsers } = loadDashboardParsers();
  const discoveredFiles = scanExcelFiles(DATA_DIR);
  const supportedFiles = discoveredFiles.filter(file => parsers.isWasteFile(file) || parsers.isJfmFile(file));
  const unsupportedFiles = discoveredFiles.filter(file => !parsers.isWasteFile(file) && !parsers.isJfmFile(file));
  const manifest = writeSourceManifest(supportedFiles);
  const generatedAt = new Date().toISOString();
  const outputFiles = {};
  let converted = 0;
  let reused = 0;
  let failed = 0;

  for (const sourcePath of unsupportedFiles) {
    console.error(`Unsupported Excel filename: ${sourcePath}`);
    failed += 1;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const item of manifest.files) {
    const sourcePath = safePath(item);
    const base = path.basename(sourcePath);
    if (/^~\$/.test(base) || !/\.(xlsx|xlsm|xls)$/i.test(base)) continue;
    if (!parsers.isWasteFile(sourcePath) && !parsers.isJfmFile(sourcePath)) continue;

    const absoluteSource = path.join(DATA_DIR, sourcePath);
    if (!fs.existsSync(absoluteSource)) {
      console.warn(`Missing source file: ${sourcePath}`);
      failed += 1;
      continue;
    }

    const sourceBytes = fs.readFileSync(absoluteSource);
    const sourceSha256 = sha256(sourceBytes);
    const jsonPath = safePath(sourcePath.replace(/\.(xlsx|xlsm|xls)$/i, ".json"));
    const absoluteJson = path.join(OUTPUT_DIR, jsonPath);
    const old = previous.files && previous.files[sourcePath];

    if (old && old.sourceSha256 === sourceSha256 && previous.parserHash === parserHash && fs.existsSync(absoluteJson)) {
      outputFiles[sourcePath] = old;
      reused += 1;
      continue;
    }

    try {
      const wb = XLSX.read(sourceBytes, { type: "buffer", cellDates: true });
      const isWaste = parsers.isWasteFile(sourcePath);
      const parsed = parsers.dedupePayload({
        summary: isWaste ? parsers.parseSummaryFromWB(wb, sourcePath) : [],
        details: isWaste ? parsers.parseDetailsFromWB(wb, sourcePath) : [],
        reasonWeeks: isWaste ? [] : parsers.parseReasonFromWB(wb, sourcePath),
        top20Entries: isWaste ? [] : parsers.parseTop20FromWB(wb, sourcePath)
      });
      const payload = {
        schemaVersion: CONVERTER_SCHEMA_VERSION,
        source: sourcePath,
        sourceSha256,
        parserHash,
        generatedAt,
        kind: isWaste ? "waste" : "jfm",
        ...parsed
      };
      fs.mkdirSync(path.dirname(absoluteJson), { recursive: true });
      const jsonBytes = Buffer.from(JSON.stringify(payload));
      fs.writeFileSync(absoluteJson, jsonBytes);
      outputFiles[sourcePath] = {
        json: `../data-json/${jsonPath}`,
        kind: payload.kind,
        sourceSha256,
        sourceBytes: sourceBytes.length,
        jsonBytes: jsonBytes.length,
        summaryRows: payload.summary.length,
        detailRows: payload.details.length,
        reasonRows: payload.reasonWeeks.length,
        top20Rows: payload.top20Entries.length
      };
      converted += 1;
      console.log(`Converted ${sourcePath} -> ${jsonPath}`);
    } catch (error) {
      failed += 1;
      console.error(`Failed ${sourcePath}: ${error.message}`);
    }
  }

  const previousCount = previous.files ? Object.keys(previous.files).length : 0;
  const outputCount = Object.keys(outputFiles).length;
  const manifestGeneratedAt = converted === 0 && failed === 0 && outputCount === previousCount
    ? (previous.generatedAt || generatedAt)
    : generatedAt;
  const jsonManifest = {
    schemaVersion: CONVERTER_SCHEMA_VERSION,
    generatedAt: manifestGeneratedAt,
    parserHash,
    files: outputFiles
  };
  fs.writeFileSync(JSON_MANIFEST, `${JSON.stringify(jsonManifest, null, 2)}\n`);
  console.log(`Done: ${converted} converted, ${reused} unchanged, ${failed} failed, ${Object.keys(outputFiles).length} available.`);
  if (failed) process.exitCode = 1;
}

main();
