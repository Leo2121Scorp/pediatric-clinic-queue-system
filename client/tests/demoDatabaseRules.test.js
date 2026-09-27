import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const production = JSON.parse(fs.readFileSync(path.join(root, "database.rules.json"), "utf8"));
const demo = JSON.parse(fs.readFileSync(path.join(root, "database.demo.rules.json"), "utf8"));
const clientProduction = JSON.parse(fs.readFileSync(path.join(root, "client", "database.rules.json"), "utf8"));
const clientDemo = JSON.parse(fs.readFileSync(path.join(root, "client", "database.demo.rules.json"), "utf8"));

function collect(node, acc = [], prefix = "") {
  if (!node || typeof node !== "object" || Array.isArray(node)) return acc;
  for (const [key, value] of Object.entries(node)) {
    if (key === ".read" || key === ".write") {
      acc.push({ path: prefix || "/", key, value });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      collect(value, acc, `${prefix}/${key}`);
    }
  }
  return acc;
}

function unwrap(expr, guard) {
  if (typeof expr === "boolean") return expr;
  const prefix = `${guard} && (`;
  assert.equal(expr.startsWith(prefix), true, expr);
  assert.equal(expr.endsWith(")"), true, expr);
  return expr.slice(prefix.length, -1);
}

test("client and root rule files stay in sync", () => {
  assert.deepEqual(clientProduction, production);
  assert.deepEqual(clientDemo, demo);
});

test("production rules deny demo tokens and demo rules deny everyone else", () => {
  const live = collect(production.rules);
  const cloned = collect(demo.rules).filter((rule) => !rule.path.startsWith("/demoResetLogs"));
  assert.equal(live.length, cloned.length);

  for (let i = 0; i < live.length; i += 1) {
    const prod = live[i];
    const copy = cloned[i];
    assert.equal(prod.path, copy.path);
    assert.equal(prod.key, copy.key);
    if (typeof prod.value === "boolean") {
      assert.equal(prod.value, false);
      assert.equal(copy.value, false);
      continue;
    }
    assert.match(prod.value, /^auth\.token\.isDemo != true && \(/);
    assert.match(copy.value, /^auth\.token\.isDemo == true && \(/);
    assert.equal(
      unwrap(prod.value, "auth.token.isDemo != true"),
      unwrap(copy.value, "auth.token.isDemo == true")
    );
  }
});

test("demo reset logs are operator-read and not writable by clients", () => {
  assert.equal(production.rules.demoResetLogs, undefined);
  assert.equal(demo.rules.demoResetLogs[".write"], false);
  assert.match(demo.rules.demoResetLogs[".read"], /auth\.token\.demoOperator == true/);
  assert.match(demo.rules.demoResetLogs[".read"], /auth\.token\.isDemo == true/);
});
