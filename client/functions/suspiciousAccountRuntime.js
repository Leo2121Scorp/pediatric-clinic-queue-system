const { manilaDateString } = require("./manilaDate");
const { SUSPICIOUS_FLAG_STATUS } = require("./suspiciousAccountConfig");
const {
  evaluateSuspiciousRules,
  buildSuspiciousRecommendation,
  canFlagAccount,
} = require("./suspiciousAccountRules");

const { getRtdb } = require("./rtdbRouter");

function db() {
  return getRtdb();
}

async function loadParentReservations(parentId) {
  const snap = await db()
    .ref("reservations")
    .orderByChild("parentId")
    .equalTo(parentId)
    .once("value");
  if (!snap.exists()) return [];
  const list = [];
  snap.forEach((child) => {
    list.push({ id: child.key, ...child.val() });
  });
  return list;
}

async function loadSchedulesById(reservations) {
  const ids = [...new Set(reservations.map((r) => r.scheduleId).filter(Boolean))];
  const schedulesById = {};
  await Promise.all(
    ids.map(async (scheduleId) => {
      const snap = await db().ref(`schedules/${scheduleId}`).once("value");
      if (snap.exists()) schedulesById[scheduleId] = snap.val();
    })
  );
  return schedulesById;
}

async function listActiveDoctorIds() {
  const snap = await db().ref("users").once("value");
  if (!snap.exists()) return [];
  const ids = [];
  snap.forEach((child) => {
    const user = child.val() || {};
    if ((user.role === "doctor" || user.role === "admin") && user.status !== "inactive" && user.isDeleted !== true) {
      ids.push(child.key);
    }
  });
  return ids;
}

async function writeSystemAuditLog(entry) {
  const ref = db().ref("auditLogs").push();
  await ref.set({
    ...entry,
    timestamp: entry.timestamp || Date.now(),
  });
  return ref.key;
}

async function notifyDoctors({ parentName, parentId, auditLogId, recommendation }) {
  const { sendPushToDoctor } = require("./pushRuntime");
  const doctorIds = await listActiveDoctorIds();
  const title = "Suspicious account detected";
  const body = `Suspicious account detected: ${parentName}`;
  const url = auditLogId
    ? `/doctor/audit-logs?highlight=${encodeURIComponent(auditLogId)}`
    : "/doctor/audit-logs";
  const now = Date.now();
  const dedupeKey = `suspicious_${parentId}_${auditLogId || now}`;

  const results = [];
  for (const doctorId of doctorIds) {
    const alertRef = db().ref(`doctorAlerts/${doctorId}`).push();
    await alertRef.set({
      type: "SUSPICIOUS_ACCOUNT",
      title,
      body,
      message: body,
      url,
      parentId,
      auditLogId: auditLogId || null,
      recommendation: recommendation || null,
      createdAt: now,
      read: false,
    });

    const pushResult = await sendPushToDoctor(doctorId, {
      title,
      body,
      message: body,
      type: "SUSPICIOUS_ACCOUNT",
      url,
      dedupeKey,
      id: dedupeKey,
    }, dedupeKey);
    results.push({ doctorId, pushResult, alertId: alertRef.key });
  }
  return results;
}

/**
 * Evaluate one parent and flag + notify when rules fire and flag is not already open.
 */
async function evaluateAndFlagParent(parentId, options = {}) {
  if (!parentId) return { flagged: false, reason: "missing_parent" };

  const userSnap = await db().ref(`users/${parentId}`).once("value");
  if (!userSnap.exists()) return { flagged: false, reason: "user_not_found" };
  const parent = userSnap.val() || {};
  if (parent.role !== "parent" || parent.isDeleted === true) {
    return { flagged: false, reason: "not_parent" };
  }

  const reservations = await loadParentReservations(parentId);
  const schedulesById = await loadSchedulesById(reservations);
  const evaluation = evaluateSuspiciousRules(reservations, {
    todayManila: options.todayManila || manilaDateString(),
    schedulesById,
  });

  if (!canFlagAccount(evaluation, parent.suspiciousFlag)) {
    return {
      flagged: false,
      reason: evaluation.triggered ? "already_open_or_no_new_evidence" : "rules_not_met",
      evaluation,
    };
  }

  const now = Date.now();
  const parentName = parent.name || parent.email || "Parent";
  const recommendation = buildSuspiciousRecommendation(parentName, evaluation);

  const flagPayload = {
    isSuspicious: true,
    status: SUSPICIOUS_FLAG_STATUS.OPEN,
    rulesTriggered: evaluation.rulesTriggered,
    evidence: evaluation.evidence,
    recommendation,
    flaggedAt: now,
    updatedAt: now,
    reviewedAt: null,
    reviewedBy: null,
  };

  await db().ref(`users/${parentId}`).update({
    suspiciousFlag: flagPayload,
    updatedAt: now,
  });

  const auditLogId = await writeSystemAuditLog({
    action: "ACCOUNT_FLAGGED_SUSPICIOUS",
    category: "user_management",
    actorUid: "system",
    actorName: "System",
    actorRole: "system",
    description: `Suspicious account detected: ${parentName}`,
    targetType: "user",
    targetId: parentId,
    badge: "Suspicious",
    recommendation,
    reviewStatus: SUSPICIOUS_FLAG_STATUS.OPEN,
    metadata: {
      parentName,
      parentId,
      rulesTriggered: evaluation.rulesTriggered,
      evidence: evaluation.evidence,
      summary: evaluation.summary,
    },
    timestamp: now,
  });

  let notifyResults = [];
  try {
    notifyResults = await notifyDoctors({
      parentName,
      parentId,
      auditLogId,
      recommendation,
    });
  } catch (err) {
    console.error("evaluateAndFlagParent: notifyDoctors failed", err.message);
  }

  return {
    flagged: true,
    parentId,
    auditLogId,
    evaluation,
    recommendation,
    notifyResults,
  };
}

/**
 * Nightly / on-demand sweep: evaluate every parent who has at least one reservation.
 */
async function evaluateAllSuspiciousParents(options = {}) {
  const snap = await db().ref("reservations").once("value");
  if (!snap.exists()) return { evaluated: 0, flagged: 0, results: [] };

  const parentIds = new Set();
  snap.forEach((child) => {
    const val = child.val() || {};
    if (val.parentId && val.source !== "walk_in") parentIds.add(val.parentId);
  });

  const results = [];
  let flagged = 0;
  for (const parentId of parentIds) {
    try {
      const result = await evaluateAndFlagParent(parentId, options);
      results.push(result);
      if (result.flagged) flagged += 1;
    } catch (err) {
      console.error(`evaluateAllSuspiciousParents failed for ${parentId}:`, err.message);
      results.push({ flagged: false, parentId, reason: "error", error: err.message });
    }
  }

  return { evaluated: parentIds.size, flagged, results };
}

/**
 * Hook for reservation writes: when a reservation becomes a terminal no-show signal, re-evaluate parent.
 */
async function maybeEvaluateAfterReservationChange(before, after) {
  if (!after?.parentId || after.source === "walk_in") return null;
  const beforeStatus = before?.status;
  const afterStatus = after.status;
  const becameTerminalNoShow =
    afterStatus !== beforeStatus &&
    (afterStatus === "forfeited" ||
      afterStatus === "expired" ||
      afterStatus === "validation_expired");

  if (!becameTerminalNoShow) return null;
  return evaluateAndFlagParent(after.parentId);
}

module.exports = {
  evaluateAndFlagParent,
  evaluateAllSuspiciousParents,
  maybeEvaluateAfterReservationChange,
  notifyDoctors,
};
