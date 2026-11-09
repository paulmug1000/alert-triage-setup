/**
 * AST Compiler for master-GAS-scripts/*.gs -> services/gasRuntime/compiledMasterGas.js
 *
 * Parses all 17 Google Apps Script (.gs) files in master-GAS-scripts/ as a single AST,
 * computes the exact transitive closure of functions that invoke asynchronous I/O primitives
 * (UrlFetchApp, SpreadsheetApp.openById/openByUrl/flush, Sheets.Spreadsheets.*, Utilities.sleep,
 * DriveApp, Drive, and dynamic routing via ALLOWED_ROUTING_FUNCTIONS_), and injects `async` and
 * `(await ...)` at exact AST node boundaries while preserving 100% of the source GAS logic verbatim.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const parser = require("../node_modules/@babel/parser");

const GAS_DIR = path.resolve(__dirname, "../../master-GAS-scripts");
const OUT_FILE = path.resolve(__dirname, "../services/gasRuntime/compiledMasterGas.js");

function walk(node, parent, fn) {
  if (!node || typeof node !== "object") return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "comments" || k === "leadingComments" || k === "trailingComments") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) walk(c, node, fn);
    } else if (v && typeof v === "object" && v.type) {
      walk(v, node, fn);
    }
  }
}

function buildBundle() {
  const files = fs
    .readdirSync(GAS_DIR)
    .filter((f) => f.endsWith(".gs"))
    .sort();

  const combined = files
    .map((f) => `// ============================================================================\n// SOURCE FILE: ${f}\n// ============================================================================\n` + fs.readFileSync(path.join(GAS_DIR, f), "utf8"))
    .join("\n\n");

  const ast = parser.parse(combined, {
    sourceType: "script",
  });

  // 1. Collect all top-level function names (for exporting from createMasterGasInstance)
  const topLevelFuncNames = [];
  for (const stmt of ast.program.body) {
    if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
      topLevelFuncNames.push(stmt.id.name);
    } else if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) {
        if (
          d.id?.type === "Identifier" &&
          d.init &&
          (d.init.type === "FunctionExpression" || d.init.type === "ArrowFunctionExpression")
        ) {
          topLevelFuncNames.push(d.id.name);
        }
      }
    }
  }

  // 2. Collect all named functions (both top-level and nested local helper functions)
  const allNamedFuncs = []; // { name, node }
  walk(ast.program, null, (n, parent) => {
    if (n.type === "FunctionDeclaration" && n.id?.name) {
      allNamedFuncs.push({ name: n.id.name, node: n });
    } else if (
      (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") &&
      parent?.type === "VariableDeclarator" &&
      parent.id?.type === "Identifier"
    ) {
      allNamedFuncs.push({ name: parent.id.name, node: n });
    }
  });

  const ASYNC_PRIMITIVE_RE =
    /^(UrlFetchApp\.(fetch|fetchAll)|SpreadsheetApp\.(openById|openByUrl|flush)|Sheets\.Spreadsheets\.|Utilities\.sleep|DriveApp\.|Drive\.)/;

  const isAsyncPrimitiveCall = (callNode) => {
    const calleeStr = combined.slice(callNode.callee.start, callNode.callee.end).replace(/\s+/g, "");
    if (ASYNC_PRIMITIVE_RE.test(calleeStr)) return true;
    // Dynamic router call in _executeDynamicFunction: fn(safeHeadless)
    if (callNode.callee.type === "Identifier" && callNode.callee.name === "fn") return true;
    return false;
  };

  // 3. Compute fixed-point transitive closure of async functions
  const asyncFuncNames = new Set();
  for (const { name, node } of allNamedFuncs) {
    walk(node.body, node, (n) => {
      if (n.type === "CallExpression" && isAsyncPrimitiveCall(n)) {
        asyncFuncNames.add(name);
      }
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, node } of allNamedFuncs) {
      if (asyncFuncNames.has(name)) continue;
      walk(node.body, node, (n) => {
        if (n.type === "CallExpression" && n.callee.type === "Identifier") {
          if (asyncFuncNames.has(n.callee.name)) {
            asyncFuncNames.add(name);
            changed = true;
          }
        }
      });
    }
  }

  // 4. Collect point insertions:
  //    - `async ` before each async function declaration/expression
  //    - `(await ` before and `)` after each async CallExpression
  //    Priority at the same character offset:
  //      closing `)` (priority 1) before `async ` (priority 2) before opening `(await ` (priority 3)
  const insertions = [];
  const markedFuncStarts = new Set();

  for (const { name, node } of allNamedFuncs) {
    if (!asyncFuncNames.has(name)) continue;
    if (!node.async && !markedFuncStarts.has(node.start)) {
      markedFuncStarts.add(node.start);
      insertions.push({ pos: node.start, text: "async ", order: 2 });
    }
  }

  const wrappedCallKeys = new Set();
  walk(ast.program, null, (n) => {
    if (n.type !== "CallExpression") return;
    const isAsyncCall =
      isAsyncPrimitiveCall(n) ||
      (n.callee.type === "Identifier" && asyncFuncNames.has(n.callee.name));
    if (!isAsyncCall) return;

    const key = `${n.start}:${n.end}`;
    if (wrappedCallKeys.has(key)) return;
    wrappedCallKeys.add(key);

    insertions.push({ pos: n.start, text: "(await ", order: 3 });
    insertions.push({ pos: n.end, text: ")", order: 1 });
  });

  // Sort insertions from end of file to start of file
  insertions.sort((a, b) => {
    if (b.pos !== a.pos) return b.pos - a.pos;
    return b.order - a.order;
  });

  let transformedBody = combined;
  for (const ins of insertions) {
    transformedBody =
      transformedBody.slice(0, ins.pos) + ins.text + transformedBody.slice(ins.pos);
  }

  const uniqueTopExports = [...new Set(topLevelFuncNames)];
  const outputCode = `/**
 * AUTO-GENERATED BY scripts/build-gas-bundle.mjs — DO NOT EDIT MANUALLY
 *
 * 100% Verbatim AST-Compiled Bundle of all 17 master-GAS-scripts/*.gs files.
 * Total Top-Level Functions: ${uniqueTopExports.length}
 * Async Functions: ${asyncFuncNames.size}
 */

/* eslint-disable */
export function createMasterGasInstance(env) {
  const {
    SpreadsheetApp,
    Sheets,
    UrlFetchApp,
    PropertiesService,
    Utilities,
    DriveApp,
    Drive,
    CacheService,
    LockService,
    Session,
    Logger,
    HtmlService,
    ScriptApp,
    ContentService,
    console = globalThis.console,
  } = env;

${transformedBody}

  return {
    ${uniqueTopExports.join(",\n    ")},
    _asyncFuncNames: new Set(${JSON.stringify([...asyncFuncNames])}),
  };
}
`;

  // Validate that the generated module parses cleanly with @babel/parser
  parser.parse(outputCode, {
    sourceType: "module",
  });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, outputCode, "utf8");
  console.log(
    `✅ Built ${OUT_FILE} (${(outputCode.length / 1024).toFixed(1)} KB, ${uniqueTopExports.length} exported functions, ${asyncFuncNames.size} async functions, ${wrappedCallKeys.size} awaited call sites)`
  );
}

buildBundle();

