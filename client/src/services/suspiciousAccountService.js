import { ref, get, update, query, orderByChild, equalTo, push, set } from "firebase/database";
import { getDb } from "../firebase/database";
import { auth } from "../firebase/auth";
import { manilaDateString } from "../utils/manilaDate";
import {
  SUSPICIOUS_FLAG_STATUS,
} from "../utils/suspiciousAccountConfig";
import {
  evaluateSuspiciousRules,
  buildSuspiciousRecommendation,
  canFlagAccount,
} from "../utils/suspiciousAccountRules";
import { logAuditEvent, AUDIT_ACTIONS, AUDIT_CATEGORIES } from "./auditService";
import { toggleUserStatus } from "./adminService";
import notificationService, { NOTIFICATION_EVENTS } from "./notificationService";

async function loadParentReservations(parentId) {
  const snap = await get(
    query(ref(getDb(), "reservations"), orderByChild("parentId"), equalTo(parentId))
  );
  if (!snap.exists()) return [];
  return Object.entries(snap.val()).map(([id, value]) => ({ id, ...value }));
}

async function loadSchedulesById(reservations) {
  const ids = [...new Set(reservations.map((r) => r.scheduleId).filter(Boolean))];
  const schedulesById = {};
  await Promise.all(
    ids.map(async (scheduleId) => {
      const snap = await get(ref(getDb(), `schedules/${scheduleId}`));
      if (snap.exists()) schedulesById[scheduleId] = snap.val();
    })
  );
  return schedulesById;
}

/**
 * Evaluate a parent against Rules A/B/C (read-only). Does not write a flag.
 */
export async function evaluateParentSuspicion(parentId, options = {}) {
  if (!parentId) return { triggered: false, rulesTriggered: [], evidence: [], summary: {} };
  const reservations = await loadParentReservations(parentId);
  const schedulesById = await loadSchedulesById(reservations);
  return evaluateSuspiciousRules(reservations, {
    todayManila: options.todayManila || manilaDateString(),
    schedulesById,
  });
}

/**
 * Doctor dismisses a false-positive suspicious flag.
 */
export async function dismissSuspiciousAccount(parentId, { auditLogId = null } = {}) {
  if (!auth.currentUser) throw new Error("Authentication required.");
  if (!parentId) throw new Error("Parent id is required.");

  const userSnap = await get(ref(getDb(), `users/${parentId}`));
  if (!userSnap.exists()) throw new Error("User not found.");
  const parent = userSnap.val();
  if (parent.role !== "parent") throw new Error("Only parent accounts can be marked reviewed.");

  const now = Date.now();
  await update(ref(getDb(), `users/${parentId}`), {
    suspiciousFlag: {
      ...(parent.suspiciousFlag || {}),
      isSuspicious: false,
      status: SUSPICIOUS_FLAG_STATUS.DISMISSED,
      reviewedAt: now,
      reviewedBy: auth.currentUser.uid,
      updatedAt: now,
    },
    updatedAt: now,
  });

  if (auditLogId) {
    await update(ref(getDb(), `auditLogs/${auditLogId}`), {
      reviewStatus: SUSPICIOUS_FLAG_STATUS.DISMISSED,
      reviewedAt: now,
      reviewedBy: auth.currentUser.uid,
    });
  }

  const parentName = parent.name || parent.email || parentId;
  await logAuditEvent({
    action: AUDIT_ACTIONS.SUSPICIOUS_ACCOUNT_DISMISSED,
    category: AUDIT_CATEGORIES.USER_MANAGEMENT,
    description: `Dismissed suspicious-account flag for ${parentName}`,
    targetType: "user",
    targetId: parentId,
    metadata: {
      relatedAuditLogId: auditLogId || null,
      parentName,
    },
  });

  return true;
}

/**
 * Doctor deactivates a flagged parent from the audit entry (with confirmation in UI).
 */
export async function deactivateSuspiciousAccount(parentId, { auditLogId = null } = {}) {
  if (!auth.currentUser) throw new Error("Authentication required.");
  if (!parentId) throw new Error("Parent id is required.");

  const userSnap = await get(ref(getDb(), `users/${parentId}`));
  if (!userSnap.exists()) throw new Error("User not found.");
  const parent = userSnap.val();
  if (parent.role !== "parent") throw new Error("Only parent accounts can be deactivated here.");

  const currentStatus = parent.status || "active";
  if (currentStatus === "active") {
    await toggleUserStatus(parentId, currentStatus);
  }

  const now = Date.now();
  await update(ref(getDb(), `users/${parentId}`), {
    suspiciousFlag: {
      ...(parent.suspiciousFlag || {}),
      isSuspicious: true,
      status: SUSPICIOUS_FLAG_STATUS.DEACTIVATED,
      reviewedAt: now,
      reviewedBy: auth.currentUser.uid,
      updatedAt: now,
    },
    updatedAt: now,
  });

  if (auditLogId) {
    await update(ref(getDb(), `auditLogs/${auditLogId}`), {
      reviewStatus: SUSPICIOUS_FLAG_STATUS.DEACTIVATED,
      reviewedAt: now,
      reviewedBy: auth.currentUser.uid,
    });
  }

  return true;
}

/**
 * Client-side flag helper (dev / manual). Production flagging is owned by Cloud Functions.
 * Still useful for local testing when CF is not running.
 */
export async function flagSuspiciousAccountIfNeeded(parentId, options = {}) {
  if (!parentId) return { flagged: false, reason: "missing_parent" };

  const userSnap = await get(ref(getDb(), `users/${parentId}`));
  if (!userSnap.exists()) return { flagged: false, reason: "user_not_found" };
  const parent = userSnap.val();
  if (parent.role !== "parent" || parent.isDeleted) {
    return { flagged: false, reason: "not_parent" };
  }

  const evaluation = await evaluateParentSuspicion(parentId, options);
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
  const rulesTriggered = evaluation.rulesTriggered;

  const flagPayload = {
    isSuspicious: true,
    status: SUSPICIOUS_FLAG_STATUS.OPEN,
    rulesTriggered,
    evidence: evaluation.evidence,
    recommendation,
    flaggedAt: now,
    updatedAt: now,
    reviewedAt: null,
    reviewedBy: null,
  };

  await update(ref(getDb(), `users/${parentId}`), {
    suspiciousFlag: flagPayload,
    updatedAt: now,
  });

  const logId = await logAuditEvent({
    action: AUDIT_ACTIONS.ACCOUNT_FLAGGED_SUSPICIOUS,
    category: AUDIT_CATEGORIES.USER_MANAGEMENT,
    description: `Suspicious account detected: ${parentName}`,
    targetType: "user",
    targetId: parentId,
    actorRole: options.actorRole || "system",
    badge: "Suspicious",
    recommendation,
    metadata: {
      parentName,
      parentId,
      rulesTriggered,
      evidence: evaluation.evidence,
      summary: evaluation.summary,
    },
  });

  // In-app toast for the signed-in doctor (fallback when push is denied).
  try {
    notificationService.notify(NOTIFICATION_EVENTS.SUSPICIOUS_ACCOUNT, {
      dedupeKey: `suspicious_${parentId}_${now}`,
      customMessage: `Suspicious account detected: ${parentName}`,
      metadata: { parentId, auditLogId: logId || null },
      showToast: true,
    });
  } catch (_err) {
    // Non-fatal
  }

  return { flagged: true, evaluation, auditLogId: logId, recommendation };
}

/**
 * Mark a doctor in-app alert as read.
 */
export async function markDoctorAlertRead(doctorId, alertId) {
  if (!doctorId || !alertId) return;
  await update(ref(getDb(), `doctorAlerts/${doctorId}/${alertId}`), {
    read: true,
    readAt: Date.now(),
  });
}

export async function subscribeDoctorAlerts(doctorId, callback) {
  const { subscribeOnValue } = await import("../firebase/rtdbSubscribe");
  const alertsRef = ref(getDb(), `doctorAlerts/${doctorId}`);
  return subscribeOnValue(alertsRef, (snap) => {
    if (!snap.exists()) {
      callback([]);
      return;
    }
    const list = Object.entries(snap.val()).map(([id, value]) => ({ id, ...value }));
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    callback(list);
  });
}

/** @deprecated Prefer Cloud Function; kept for local scripts. */
export async function writeDoctorAlert(doctorId, alert) {
  if (!doctorId) return null;
  const alertsRef = ref(getDb(), `doctorAlerts/${doctorId}`);
  const newRef = push(alertsRef);
  await set(newRef, {
    ...alert,
    createdAt: alert.createdAt || Date.now(),
    read: false,
  });
  return newRef.key;
}
