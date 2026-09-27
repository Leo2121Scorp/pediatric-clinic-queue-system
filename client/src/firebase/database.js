import app from "./firebaseConfig";
import { getDatabase } from "firebase/database";

const defaultDb = getDatabase(app);

let demoDb = null;
let activeDb = defaultDb;
let activeIsDemo = false;
const listeners = new Set();

export function demoDatabaseUrl() {
  const explicit = import.meta.env.VITE_FIREBASE_DEMO_DATABASE_URL;
  if (explicit) return String(explicit).trim();
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) return "";
  return `https://${projectId}-demo.asia-southeast1.firebasedatabase.app`;
}

/**
 * Selects the live database or the demo clone.
 * A missing or false claim stays on the default database.
 */
export function setActiveDatabase(isDemo) {
  const nextIsDemo = isDemo === true;
  if (nextIsDemo === activeIsDemo) return activeDb;

  if (nextIsDemo) {
    const url = demoDatabaseUrl();
    if (!url) {
      throw new Error(
        "This demo account cannot open a database. Set VITE_FIREBASE_DEMO_DATABASE_URL."
      );
    }
    if (!demoDb) {
      demoDb = getDatabase(app, url);
    }
    activeDb = demoDb;
  } else {
    activeDb = defaultDb;
  }

  activeIsDemo = nextIsDemo;
  listeners.forEach((listener) => {
    try {
      listener(activeDb, activeIsDemo);
    } catch (err) {
      console.error("Database switch listener failed:", err);
    }
  });
  return activeDb;
}

export function getDb() {
  return activeDb;
}

export function isDemoDatabase() {
  return activeIsDemo;
}

export function onDatabaseChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
