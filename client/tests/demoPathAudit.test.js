import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(clientRoot, "..");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

test("client reads and writes go through getDb()", () => {
  const offenders = [];
  for (const file of walk(path.join(clientRoot, "src"))) {
    if (file.endsWith(`${path.sep}firebase${path.sep}database.js`)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/import\s*\{[^}]*\bdatabase\b[^}]*\}\s*from/.test(source)) offenders.push(file);
    if (/\bref\(\s*database\b/.test(source)) offenders.push(file);
    if (/firebase\/getDb\(\)/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("login and auth select the database from the isDemo claim before reading users", () => {
  const auth = fs.readFileSync(path.join(clientRoot, "src", "context", "AuthContext.jsx"), "utf8");
  const login = fs.readFileSync(path.join(clientRoot, "src", "pages", "auth", "Login.jsx"), "utf8");
  assert.match(auth, /getIdTokenResult\(true\)/);
  assert.match(auth, /setActiveDatabase\(demoAccount\)/);
  const claimAt = auth.indexOf("getIdTokenResult(true)");
  const readAt = auth.indexOf("ref(getDb(), `users/");
  assert.ok(claimAt !== -1 && readAt !== -1 && claimAt < readAt);
  assert.match(login, /setActiveDatabase\(tokenResult\?\.claims\?\.isDemo === true\)/);
});

test("demo-reachable functions do not call the default database directly", () => {
  const functionsDir = path.join(clientRoot, "functions");
  const allowed = new Set([
    path.normalize(path.join(functionsDir, "rtdbRouter.js")),
  ]);
  const offenders = [];
  for (const file of walk(functionsDir)) {
    if (file.includes(`${path.sep}scripts${path.sep}`)) continue;
    if (allowed.has(path.normalize(file))) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/admin\.database\(\)/.test(source)) offenders.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(offenders, []);

  const index = fs.readFileSync(path.join(functionsDir, "index.js"), "utf8");
  assert.match(index, /runForToken\(context\?\.auth\?\.token/);
  assert.match(index, /suppressSms:\s*true/);
  assert.match(index, /isDemoOperator\(context\.auth\.token\)/);
  assert.match(index, /onDemoReservationWrite/);
  assert.match(index, /onDemoScheduleWrite/);
});
