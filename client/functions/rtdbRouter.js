const { AsyncLocalStorage } = require("async_hooks");
const admin = require("firebase-admin");

const DEMO_APP = "demo";
const contextStore = new AsyncLocalStorage();

function demoInstanceName() {
  if (process.env.DEMO_RTDB_INSTANCE) return process.env.DEMO_RTDB_INSTANCE;
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  if (!project) return "";
  return `${project}-demo`;
}

function demoDatabaseUrl() {
  if (process.env.DEMO_RTDB_URL) return process.env.DEMO_RTDB_URL;
  const instance = demoInstanceName();
  if (!instance) return "";
  return `https://${instance}.asia-southeast1.firebasedatabase.app`;
}

function defaultDatabase() {
  return admin.database();
}

function demoDatabase() {
  const url = demoDatabaseUrl();
  if (!url) {
    const err = new Error("DEMO_RTDB_URL is not configured.");
    err.code = "failed-precondition";
    throw err;
  }
  const existing = admin.apps.find((app) => app && app.name === DEMO_APP);
  const app = existing || admin.initializeApp({ databaseURL: url }, DEMO_APP);
  return app.database();
}

function tokenRecord(token) {
  if (!token || typeof token !== "object") return {};
  if (token.token && typeof token.token === "object") return token.token;
  return token;
}

function isDemoToken(token) {
  return tokenRecord(token).isDemo === true;
}

function isDemoOperator(token) {
  return tokenRecord(token).demoOperator === true;
}

function getRtdb() {
  const current = contextStore.getStore();
  if (current?.db) return current.db;
  return defaultDatabase();
}

function databaseFor(adminSdk) {
  const current = contextStore.getStore();
  if (current?.db) return current.db;
  if (adminSdk && typeof adminSdk.database === "function") return adminSdk.database();
  return defaultDatabase();
}

function isSmsSuppressed() {
  return contextStore.getStore()?.suppressSms === true;
}

function runWithDatabase(db, fn, { suppressSms = false } = {}) {
  return contextStore.run({ db, suppressSms }, fn);
}

function runForToken(token, fn) {
  if (!isDemoToken(token)) return fn();
  return runWithDatabase(demoDatabase(), fn, { suppressSms: true });
}

module.exports = {
  demoInstanceName,
  demoDatabaseUrl,
  defaultDatabase,
  demoDatabase,
  isDemoToken,
  isDemoOperator,
  getRtdb,
  databaseFor,
  isSmsSuppressed,
  runWithDatabase,
  runForToken,
};
