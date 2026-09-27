/**
 * Creates demo Auth users and writes their profiles only to the demo Realtime Database.
 *
 * Required env:
 *   DEMO_ACCOUNT_PASSWORD
 *   DEMO_RTDB_URL   (or DEMO_RTDB_INSTANCE, which builds the asia-southeast1 URL)
 *   GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT or server/serviceAccountKey.json
 *
 * Usage (from client/functions):
 *   node scripts/seedDemo.js
 *   node scripts/seedDemo.js --reset 2026-09-28
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { demoDatabaseUrl } = require("../rtdbRouter");
const { resetDemoClinicDay } = require("../demoResetRuntime");
const {
  addManilaDays,
  manilaDateString,
  manilaWeekdayIndex,
  WEEKDAY_KEYS,
} = require("../manilaDate");
const {
  ANGELES_BRANCH_ID,
  DEMO_ACCOUNTS,
  DEMO_BRANCHES,
  buildStarterSchedule,
  defaultSystemConfiguration,
  scheduleIdForDate,
} = require("../demoSeedData");

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(__dirname, "..", "serviceAccountKey.json"),
    path.join(__dirname, "..", "..", "..", "server", "serviceAccountKey.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }
  }
  return null;
}

function upcomingAngelesDates(count = 3) {
  const dates = [];
  let cursor = manilaDateString();
  for (let step = 0; step < 21 && dates.length < count; step += 1) {
    const weekday = WEEKDAY_KEYS[manilaWeekdayIndex(cursor)];
    if (DEMO_BRANCHES[ANGELES_BRANCH_ID].schedule[weekday].isOpen) {
      dates.push(cursor);
    }
    cursor = addManilaDays(cursor, 1);
  }
  return dates;
}

async function ensureAuthUser(auth, account, password) {
  let user;
  try {
    user = await auth.getUserByEmail(account.email);
    await auth.updateUser(user.uid, {
      password,
      displayName: account.name,
      emailVerified: true,
      disabled: false,
    });
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    user = await auth.createUser({
      email: account.email,
      password,
      displayName: account.name,
      emailVerified: true,
    });
  }
  const fresh = await auth.getUser(user.uid);
  await auth.setCustomUserClaims(user.uid, {
    ...(fresh.customClaims || {}),
    ...account.claims,
  });
  return auth.getUser(user.uid);
}

function profileFor(account, uid, now) {
  const profile = {
    uid,
    name: account.name,
    email: account.email,
    phone: "",
    role: account.role,
    status: "active",
    createdAt: now,
    updatedAt: now,
    hasCompletedTour: true,
  };
  if (account.role === "secretary") {
    profile.assignedBranch = "Angeles";
    profile.assignedBranchId = ANGELES_BRANCH_ID;
    profile.mustChangePassword = false;
  }
  if (account.role === "parent") {
    profile.isPhoneVerified = true;
    profile.onboardingComplete = true;
    profile.inAppNotificationsEnabled = true;
    profile.devicePushEnabled = false;
  }
  return profile;
}

async function seedDemoDatabase(db, usersByKey) {
  const now = Date.now();
  for (const [branchId, branch] of Object.entries(DEMO_BRANCHES)) {
    const ref = db.ref(`branchConfigurations/${branchId}`);
    const existing = await ref.once("value");
    if (!existing.exists()) {
      await ref.set({ ...branch, createdAt: now });
    }
    const configRef = db.ref(`systemConfiguration/${branchId}`);
    const configSnap = await configRef.once("value");
    if (!configSnap.exists()) {
      await configRef.set(defaultSystemConfiguration(now));
    }
  }

  for (const account of DEMO_ACCOUNTS) {
    const user = usersByKey[account.key];
    const ref = db.ref(`users/${user.uid}`);
    const existing = await ref.once("value");
    const profile = profileFor(account, user.uid, now);
    if (existing.exists() && existing.val()?.createdAt) {
      delete profile.createdAt;
    }
    await ref.update(profile);
  }

  const parent = usersByKey.parent;
  const childRef = db.ref(`users/${parent.uid}/children/demo-child`);
  const childSnap = await childRef.once("value");
  if (!childSnap.exists()) {
    await childRef.set({
      childName: "Aria Santos",
      age: 4,
      sex: "Female",
      createdAt: now,
    });
  }

  const doctorId = usersByKey.doctor.uid;
  for (const clinicDate of upcomingAngelesDates(3)) {
    const scheduleId = scheduleIdForDate(clinicDate);
    const ref = db.ref(`schedules/${scheduleId}`);
    const existing = await ref.once("value");
    if (!existing.exists()) {
      await ref.set(buildStarterSchedule({ clinicDate, doctorId }));
    }
  }
}

async function main() {
  const password = process.env.DEMO_ACCOUNT_PASSWORD;
  if (!password || password.length < 6) {
    throw new Error("Set DEMO_ACCOUNT_PASSWORD to at least 6 characters.");
  }
  const databaseURL = demoDatabaseUrl();
  if (!databaseURL) {
    throw new Error("Set DEMO_RTDB_URL or DEMO_RTDB_INSTANCE.");
  }
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    throw new Error("Missing service account. Set GOOGLE_APPLICATION_CREDENTIALS.");
  }

  const app = admin.initializeApp(
    {
      credential: admin.credential.cert(serviceAccount),
      databaseURL,
    },
    "demo"
  );
  const db = app.database();
  const resetFlag = process.argv.indexOf("--reset");
  if (resetFlag !== -1) {
    const clinicDate = process.argv[resetFlag + 1];
    const result = await resetDemoClinicDay({
      clinicDate,
      callerUid: "seed-script",
      db,
    });
    console.log(result.message);
    return;
  }

  const usersByKey = {};
  for (const account of DEMO_ACCOUNTS) {
    usersByKey[account.key] = await ensureAuthUser(app.auth(), account, password);
    console.log(`demo auth ready: ${account.email} (${account.role})`);
  }
  await seedDemoDatabase(db, usersByKey);
  console.log(`Demo data written only to ${databaseURL}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
