const { databaseFor } = require("./rtdbRouter");

const ACTIVE_RESERVATION_STATUSES = [
  "reserved",
  "checked_in",
  "waiting",
  "in_consultation",
  "with_doctor",
  "validation_open",
  "waiting_for_window",
];

function makeError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function recalculateQueue(db, scheduleId) {
  if (!scheduleId) return;

  const snap = await db.ref("reservations").orderByChild("scheduleId").equalTo(scheduleId).once("value");
  if (!snap.exists()) return;

  const scheduleReservations = [];
  snap.forEach((child) => {
    scheduleReservations.push({ id: child.key, ...child.val() });
  });

  const activeQueue = scheduleReservations
    .filter((r) => ACTIVE_RESERVATION_STATUSES.includes(r.status))
    .sort((a, b) => {
      const timeA = a.sortTimestamp || a.createdAt || 0;
      const timeB = b.sortTimestamp || b.createdAt || 0;
      return timeA - timeB;
    });

  const updates = {};
  activeQueue.forEach((r, idx) => {
    const queueOrder = idx + 1;
    const aheadOfYou = ["with_doctor", "in_consultation"].includes(r.status) ? 0 : idx;
    updates[`reservations/${r.id}/queueOrder`] = queueOrder;
    updates[`reservations/${r.id}/queuePosition`] = queueOrder;
    updates[`reservations/${r.id}/aheadOfYou`] = aheadOfYou;
  });

  scheduleReservations
    .filter((r) => !ACTIVE_RESERVATION_STATUSES.includes(r.status))
    .forEach((r) => {
      if (r.status === "forfeited") {
        updates[`reservations/${r.id}/queueState`] = "FORFEITED";
      }
    });

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }
}

async function forfeitActiveReservations(db, parentId) {
  const snap = await db.ref("reservations").orderByChild("parentId").equalTo(parentId).once("value");
  if (!snap.exists()) return;

  const now = Date.now();
  const updates = {};
  const scheduleIds = new Set();

  snap.forEach((child) => {
    const val = child.val() || {};
    if (!ACTIVE_RESERVATION_STATUSES.includes(val.status)) return;
    updates[`reservations/${child.key}/status`] = "forfeited";
    updates[`reservations/${child.key}/forfeitureReason`] = "Parent account was deleted.";
    updates[`reservations/${child.key}/forfeitedAt`] = now;
    updates[`reservations/${child.key}/queueState`] = "FORFEITED";
    if (val.scheduleId) scheduleIds.add(val.scheduleId);
  });

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  for (const scheduleId of scheduleIds) {
    await recalculateQueue(db, scheduleId);
  }
}

/**
 * Permanently deletes a user: Firebase Auth record, RTDB profile, and notifications.
 * Reservations and audit logs are never deleted.
 */
async function deleteUserAccount({ admin, callerUid, targetUid }) {
  if (!callerUid) {
    throw makeError("Authentication required.", 401, "unauthenticated");
  }
  if (!targetUid || typeof targetUid !== "string") {
    throw makeError("A user id is required.", 400, "invalid-argument");
  }
  if (callerUid === targetUid) {
    throw makeError("You cannot delete your own account.", 400, "failed-precondition");
  }

  const db = databaseFor(admin);
  const callerSnap = await db.ref(`users/${callerUid}`).once("value");
  const caller = callerSnap.exists() ? callerSnap.val() : null;
  const callerCanDelete =
    caller &&
    caller.status === "active" &&
    (caller.role === "doctor" || caller.role === "admin");
  if (!callerCanDelete) {
    throw makeError("Only an active doctor can delete accounts.", 403, "permission-denied");
  }

  const targetSnap = await db.ref(`users/${targetUid}`).once("value");
  const target = targetSnap.exists() ? targetSnap.val() : null;
  // Transition: leftover admin accounts stay undeletable until cleanup.
  if (target?.role === "admin") {
    throw makeError("Admin accounts cannot be deleted.", 400, "failed-precondition");
  }

  // Doctor accounts are never deleted in-app; replacement uses Admin SDK / break-glass.
  if (target?.role === "doctor") {
    throw makeError(
      "Doctor accounts cannot be deleted in the app. Use break-glass recovery if a doctor must be replaced.",
      400,
      "failed-precondition"
    );
  }

  await forfeitActiveReservations(db, targetUid);

  try {
    await admin.auth().deleteUser(targetUid);
  } catch (err) {
    if (err?.code !== "auth/user-not-found") {
      throw err;
    }
  }

  await db.ref().update({
    [`users/${targetUid}`]: null,
    [`notifications/${targetUid}`]: null,
  });

  return { success: true, uid: targetUid };
}

module.exports = {
  deleteUserAccount,
};
