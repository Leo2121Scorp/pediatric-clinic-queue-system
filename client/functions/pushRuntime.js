const webpush = require("web-push");
const {
  deliverSmsForNotification,
  deliverWalkInReservationSms,
  enrichSmsContext,
  computeAheadOfYouForSms,
  getSmsConfiguration,
  buildNearingTurnPushMessage,
  claimNearTurnSms,
  DEFAULT_NEARING_TURN_AHEAD,
} = require("./smsNotificationService");

const ACTIVE_RESERVATION_STATUSES = [
  "reserved",
  "checked_in",
  "waiting",
  "in_consultation",
  "with_doctor",
  "validation_open",
  "waiting_for_window",
];

const NOTIFICATION_CONFIG = {
  SCHEDULE_AVAILABLE: {
    type: "info",
    title: "Schedule Available",
    message: "There's a reservation schedule available. Open Reserve to book a slot.",
    url: "/parent/reserve",
  },
  SLOT_RESERVED: {
    type: "success",
    title: "Reservation Confirmed",
    message: "Your clinic slot has been reserved successfully.",
    url: "/parent/reservations",
  },
  QUEUE_STARTED: {
    type: "info",
    title: "Queue Started",
    message: "The clinic queue has started.",
    url: "/parent/notifications",
  },
  NEARING_TURN: {
    type: "warning",
    title: "Your Turn Is Near",
    message: buildNearingTurnPushMessage(DEFAULT_NEARING_TURN_AHEAD),
    url: "/parent/reservations",
  },
  QUEUE_PAUSED: {
    type: "warning",
    title: "Queue Paused",
    message: "The clinic queue has been paused.",
    url: "/parent/notifications",
  },
  QUEUE_RESUMED: {
    type: "info",
    title: "Queue Resumed",
    message: "The clinic queue has resumed.",
    url: "/parent/notifications",
  },
  QUEUE_CLOSED: {
    type: "warning",
    title: "Queue Closed",
    message: "Reservations are now closed for today's clinic.",
    url: "/parent/notifications",
  },
  CLINIC_SESSION_ENDED: {
    type: "warning",
    title: "Clinic Session Ended",
    message: "Today's clinic session has ended.",
    url: "/parent/notifications",
  },
  ALMOST_NEXT: {
    type: "warning",
    title: "Almost Next",
    message: "Your turn is approaching soon. Please be ready.",
    url: "/parent/reservations",
  },
  YOU_ARE_NEXT: {
    type: "warning",
    title: "You're Next",
    message: "You're next in line for consultation. Please prepare your QR code.",
    url: "/parent/reservations",
  },
  QR_VERIFIED: {
    type: "success",
    title: "Arrival Verified",
    message: "Your arrival has been verified.",
    url: "/parent/reservations",
  },
  CONSULTATION_STARTED: {
    type: "success",
    title: "With Doctor",
    message: "You are now with the doctor.",
    url: "/parent/reservations",
  },
  CONSULTATION_COMPLETED: {
    type: "success",
    title: "Consultation Completed",
    message: "Your consultation has been completed.",
    url: "/parent/notifications",
  },
  PENALIZED: {
    type: "error",
    title: "Queue Position Adjusted",
    message: "You were moved back in today's queue because you were unavailable.",
    url: "/parent/reservations",
  },
  FORFEITED: {
    type: "error",
    title: "Reservation Forfeited",
    message: "Your reservation has been forfeited because you did not check in on time.",
    url: "/parent/notifications",
  },
  RESERVATION_CANCELLED_BY_CLINIC: {
    type: "warning",
    title: "Reservation Cancelled",
    message: "The clinic closed this day and cancelled your reservation. It does not count as a no-show. Book another open day when you are ready.",
    url: "/parent/reserve",
  },
  CHECK_IN_REQUESTED: {
    type: "info",
    title: "Check-In Requested",
    message: "Please proceed to the clinic and have your QR Code validated by the secretary.",
    url: "/parent/reservations",
  },
};

const { getRtdb } = require("./rtdbRouter");

function db() {
  return getRtdb();
}

function sanitizeKey(value) {
  return String(value || "").replace(/[.#$\[\]]/g, "_");
}

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:clinic@localhost";
  if (!publicKey || !privateKey) {
    console.warn("[functions/push] VAPID keys missing");
    return false;
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return true;
  } catch (err) {
    console.error("[functions/push] Failed to configure VAPID:", err.message);
    return false;
  }
}

function collectSubscriptions(pushSubscriptions) {
  if (!pushSubscriptions || typeof pushSubscriptions !== "object") return [];
  return Object.entries(pushSubscriptions)
    .map(([key, value]) => {
      if (!value?.endpoint || !value.keys?.p256dh || !value.keys?.auth) return null;
      return {
        key,
        subscription: {
          endpoint: value.endpoint,
          expirationTime: value.expirationTime || null,
          keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
        },
      };
    })
    .filter(Boolean);
}

async function sendPushToParent(parentId, notification, notificationId) {
  if (!configureVapid()) {
    console.warn("[functions/push] VAPID not configured");
    return { sent: 0, failed: 0, reason: "vapid_not_configured" };
  }

  const safeNotificationId = notificationId ? sanitizeKey(notificationId) : null;
  if (safeNotificationId) {
    const flagSnap = await db().ref(`notifications/${parentId}/${safeNotificationId}/pushDispatchedAt`).once("value");
    if (flagSnap.exists()) {
      return { sent: 0, failed: 0, reason: "already_dispatched" };
    }
  }

  const userSnap = await db().ref(`users/${parentId}`).once("value");
  const user = userSnap.val();
  if (!user || user.role !== "parent") {
    return { sent: 0, failed: 0, reason: "not_parent" };
  }
  if (user.status === "inactive" || user.isDeleted === true) {
    return { sent: 0, failed: 0, reason: "inactive_or_deleted" };
  }

  const entries = collectSubscriptions(user.pushSubscriptions);
  if (!entries.length) {
    console.warn(`[functions/push] no_subscriptions parentId=${parentId}`);
    return { sent: 0, failed: 0, reason: "no_subscriptions" };
  }

  const payload = {
    title: notification.title,
    body: notification.body || notification.message,
    type: notification.type,
    tag: notification.dedupeKey || notification.id || notification.type,
    url: notification.url || "/parent/notifications",
    icon: "/brand/plusqueue-logo.png",
    reservationId: notification.reservationId || null,
  };
  const urgency = ["YOU_ARE_NEXT", "ALMOST_NEXT", "NEARING_TURN", "CHECK_IN_REQUESTED", "PENALIZED", "FORFEITED"].includes(payload.type)
    ? "high"
    : "normal";

  let sent = 0;
  const gone = {};
  await Promise.all(
    entries.map(async ({ key, subscription }) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: 60 * 60,
          urgency,
        });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          gone[key] = null;
        } else {
          console.error(`[functions/push] send failed parentId=${parentId}:`, err.message);
        }
      }
    })
  );

  if (Object.keys(gone).length) {
    await db().ref(`users/${parentId}/pushSubscriptions`).update(gone);
  }

  if (sent > 0 && safeNotificationId) {
    await db().ref(`notifications/${parentId}/${safeNotificationId}/pushDispatchedAt`).set(Date.now());
    console.log(`[functions/push] sent=${sent} parentId=${parentId} type=${payload.type}`);
  } else if (sent === 0) {
    console.warn(`[functions/push] zero sends parentId=${parentId} type=${payload.type}`);
  }

  return { sent, pruned: Object.keys(gone).length };
}

/**
 * Narrow doctor/admin exception for abuse alerts (e.g. SUSPICIOUS_ACCOUNT).
 * Reuses the same VAPID + pushSubscriptions storage as parents.
 */
async function sendPushToDoctor(doctorId, notification, notificationId) {
  if (!configureVapid()) {
    console.warn("[functions/push] VAPID not configured");
    return { sent: 0, failed: 0, reason: "vapid_not_configured" };
  }

  const safeNotificationId = notificationId ? sanitizeKey(notificationId) : null;
  if (safeNotificationId) {
    const flagSnap = await db()
      .ref(`users/${doctorId}/pushDispatchClaims/${safeNotificationId}`)
      .once("value");
    if (flagSnap.exists()) {
      return { sent: 0, failed: 0, reason: "already_dispatched" };
    }
  }

  const userSnap = await db().ref(`users/${doctorId}`).once("value");
  const user = userSnap.val();
  if (!user || (user.role !== "doctor" && user.role !== "admin")) {
    return { sent: 0, failed: 0, reason: "not_doctor" };
  }
  if (user.status === "inactive" || user.isDeleted === true) {
    return { sent: 0, failed: 0, reason: "inactive_or_deleted" };
  }

  const entries = collectSubscriptions(user.pushSubscriptions);
  if (!entries.length) {
    console.warn(`[functions/push] no_subscriptions doctorId=${doctorId}`);
    return { sent: 0, failed: 0, reason: "no_subscriptions" };
  }

  const payload = {
    title: notification.title,
    body: notification.body || notification.message,
    type: notification.type || "SUSPICIOUS_ACCOUNT",
    tag: notification.dedupeKey || notification.id || notification.type || "SUSPICIOUS_ACCOUNT",
    url: notification.url || "/doctor/audit-logs",
    icon: "/brand/plusqueue-logo.png",
    reservationId: notification.reservationId || null,
  };

  let sent = 0;
  const gone = {};
  await Promise.all(
    entries.map(async ({ key, subscription }) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: 60 * 60,
          urgency: "high",
        });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          gone[key] = null;
        } else {
          console.error(`[functions/push] send failed doctorId=${doctorId}:`, err.message);
        }
      }
    })
  );

  if (Object.keys(gone).length) {
    await db().ref(`users/${doctorId}/pushSubscriptions`).update(gone);
  }

  if (sent > 0 && safeNotificationId) {
    await db().ref(`users/${doctorId}/pushDispatchClaims/${safeNotificationId}`).set(Date.now());
    console.log(`[functions/push] sent=${sent} doctorId=${doctorId} type=${payload.type}`);
  } else if (sent === 0) {
    console.warn(`[functions/push] zero sends doctorId=${doctorId} type=${payload.type}`);
  }

  return { sent, pruned: Object.keys(gone).length };
}

function computeReservationState(reservation, allReservations = []) {
  if (!reservation) return null;
  if (reservation.status === "cancelled") return "CANCELLED";
  if (["forfeited", "penalized", "late_limit_reached"].includes(reservation.status)) return "FORFEITED";
  if (["completed", "consultation_completed"].includes(reservation.status)) return "COMPLETED";
  if (["with_doctor", "in_consultation"].includes(reservation.status)) return "WITH_DOCTOR";

  const hasConsultationStarted = allReservations.some(
    (item) =>
      item.scheduleId === reservation.scheduleId &&
      (["with_doctor", "in_consultation", "completed", "consultation_completed"].includes(item.status) ||
        item.sentToDoctorAt)
  );
  if (!hasConsultationStarted) {
    return reservation.status === "checked_in" ? "CHECKED_IN" : "WAITING";
  }

  const activeWaiting = allReservations
    .filter(
      (item) =>
        item.scheduleId === reservation.scheduleId &&
        ["reserved", "waiting", "validation_open", "waiting_for_window", "checked_in"].includes(item.status)
    )
    .sort((a, b) => (a.sortTimestamp || a.createdAt || 0) - (b.sortTimestamp || b.createdAt || 0));
  const index = activeWaiting.findIndex((item) => item.id === reservation.id);
  if (index === 0) return "YOU_ARE_NEXT";
  if (index === 1) return "ALMOST_NEXT";
  return reservation.status === "checked_in" ? "CHECKED_IN" : "WAITING";
}

async function isParent(uid) {
  const snap = await db().ref(`users/${uid}`).once("value");
  if (!snap.exists()) return false;
  const user = snap.val() || {};
  return user.role === "parent" && user.status !== "inactive" && user.isDeleted !== true;
}

async function deliverNotification(eventId, context = {}) {
  const config = NOTIFICATION_CONFIG[eventId];
  if (!config || !context.parentId) return false;
  if (!(await isParent(context.parentId))) return false;

  const key = sanitizeKey(context.dedupeKey || `${eventId}_${Date.now()}`);
  const body = context.customMessage || config.message;
  const notification = {
    id: key,
    parentId: context.parentId,
    type: eventId,
    title: config.title,
    body,
    message: body,
    severity: config.type,
    createdAt: Date.now(),
    read: false,
    reservationId: context.reservationId || context.entityId || null,
    branchId: context.branchId || null,
    metadata: context.metadata || null,
    dedupeKey: context.dedupeKey || key,
    url: config.url,
  };

  const notifRef = db().ref(`notifications/${context.parentId}/${key}`);
  const existing = await notifRef.once("value");
  if (!existing.exists()) {
    await notifRef.update(notification);
  }
  await sendPushToParent(context.parentId, existing.exists() ? existing.val() : notification, key);

  try {
    const smsContext = await enrichSmsContext(eventId, context);
    const smsResult = await deliverSmsForNotification(eventId, smsContext, key);
    if (smsResult && !smsResult.success && !smsResult.skipped) {
      console.error(`[functions/push] SMS delivery failed for ${eventId}:`, smsResult.reason, smsResult.status || "");
    }
  } catch (err) {
    console.error(`[functions/push] SMS delivery failed for ${eventId}:`, err.message);
  }

  return true;
}

function eventsFromReservationChange(before, after) {
  const events = [];
  if (!after?.parentId) return events;
  const id = after.id;
  const prevStatus = before?.status;
  const currStatus = after.status;
  const prevPenalty = before?.penaltyCount || 0;
  const currPenalty = after.penaltyCount || 0;
  const prevCheckInReq = before?.checkInRequestedAt || 0;
  const currCheckInReq = after.checkInRequestedAt || 0;
  const branchId = after.branchId || after.branch || null;

  // Reservation confirmed — when parent finalizes patient info (Save Information)
  if (!before?.patientInfoCompleted && after.patientInfoCompleted) {
    events.push({
      eventId: "SLOT_RESERVED",
      parentId: after.parentId,
      reservationId: id,
      scheduleId: after.scheduleId || null,
      branchId,
      queueNumber: after.queueNumber ?? after.originalQueueNumber ?? after.queuePosition,
      queuePosition: after.queueOrder ?? after.queuePosition,
      dedupeKey: `slot_reserved_${id}`,
    });
  }

  if (currCheckInReq > prevCheckInReq) {
    events.push({
      eventId: "CHECK_IN_REQUESTED",
      parentId: after.parentId,
      reservationId: id,
      branchId,
      dedupeKey: `check_in_req_${id}_${currCheckInReq}`,
    });
  }
  if (currPenalty > prevPenalty && currStatus !== "forfeited") {
    events.push({
      eventId: "PENALIZED",
      parentId: after.parentId,
      reservationId: id,
      scheduleId: after.scheduleId || null,
      branchId,
      queueNumber: after.queueNumber ?? after.originalQueueNumber ?? after.queuePosition,
      queuePosition: after.queueOrder ?? after.queuePosition,
      penaltyCount: currPenalty,
      dedupeKey: `penalized_${id}_${currPenalty}`,
    });
  }
  if (prevStatus !== currStatus) {
    if (currStatus === "checked_in") {
      events.push({
        eventId: "QR_VERIFIED",
        parentId: after.parentId,
        reservationId: id,
        branchId,
        dedupeKey: `checked_in_${id}`,
      });
    } else if (currStatus === "in_consultation" || currStatus === "with_doctor") {
      events.push({
        eventId: "CONSULTATION_STARTED",
        parentId: after.parentId,
        reservationId: id,
        branchId,
        dedupeKey: `consult_start_${id}`,
      });
    } else if (currStatus === "completed" || currStatus === "consultation_completed") {
      events.push({
        eventId: "CONSULTATION_COMPLETED",
        parentId: after.parentId,
        reservationId: id,
        branchId,
        dedupeKey: `consult_complete_${id}`,
      });
    } else if (currStatus === "forfeited") {
      events.push({
        eventId: "FORFEITED",
        parentId: after.parentId,
        reservationId: id,
        scheduleId: after.scheduleId || null,
        branchId,
        queueNumber: after.queueNumber ?? after.originalQueueNumber ?? after.queuePosition,
        dedupeKey: `forfeited_${id}`,
      });
    } else if (currStatus === "cancelled_by_clinic") {
      const reason = after.cancellationReason || "Closed";
      events.push({
        eventId: "RESERVATION_CANCELLED_BY_CLINIC",
        parentId: after.parentId,
        reservationId: id,
        scheduleId: after.scheduleId || null,
        branchId,
        clinicDate: after.clinicDate || null,
        reason,
        queueNumber: after.queueNumber ?? after.originalQueueNumber ?? after.queuePosition,
        customMessage: `The clinic is closed (${reason}). Your reservation was cancelled. It does not count as a no-show. Book another open day when you are ready.`,
        dedupeKey: `clinic_cancel_${id}`,
      });
    }
  }
  return events;
}

async function getReservationsBySchedule(scheduleId) {
  const snap = await db().ref("reservations").orderByChild("scheduleId").equalTo(scheduleId).once("value");
  if (!snap.exists()) return [];
  return Object.entries(snap.val()).map(([id, value]) => ({ id, ...value }));
}

async function getActiveParentIdsForSchedule(scheduleId) {
  const reservations = await getReservationsBySchedule(scheduleId);
  const ids = new Set();
  reservations.forEach((r) => {
    // parentId only — walk-in parentPhone is never a Queue Started recipient.
    if (r.parentId && ACTIVE_RESERVATION_STATUSES.includes(r.status)) ids.add(r.parentId);
  });
  return { parentIds: [...ids], reservations };
}

async function evaluatePositionEvents(schedule, reservations, options = {}) {
  if (!schedule || !["active", "paused", "closed"].includes(schedule.queueStatus)) return;

  const smsConfig = await getSmsConfiguration(schedule.branchId || schedule.branch);
  const nearingTurnAheadCount = smsConfig.nearingTurnAheadCount;
  const sendNearTurnSms = options.sendNearTurnSms === true;

  // Near Turn / position events use parentId only. Walk-in parentPhone is never a recipient.
  const candidates = reservations.filter(
    (r) =>
      r.parentId &&
      !["in_consultation", "with_doctor", "completed", "consultation_completed", "cancelled", "forfeited"].includes(
        r.status
      )
  );
  for (const reservation of candidates) {
    const queueState = computeReservationState(reservation, reservations);
    const aheadOfYou =
      reservation.aheadOfYou != null
        ? Number(reservation.aheadOfYou)
        : computeAheadOfYouForSms(reservation, reservations);

    if (queueState === "YOU_ARE_NEXT") {
      await deliverNotification("YOU_ARE_NEXT", {
        parentId: reservation.parentId,
        reservationId: reservation.id,
        branchId: reservation.branchId || schedule.branch || null,
        dedupeKey: `you_are_next_${reservation.id}`,
      });
    } else if (queueState === "ALMOST_NEXT") {
      await deliverNotification("ALMOST_NEXT", {
        parentId: reservation.parentId,
        reservationId: reservation.id,
        branchId: reservation.branchId || schedule.branch || null,
        dedupeKey: `almost_next_${reservation.id}`,
      });
    }

    // Near Turn SMS only at queue start, and only for parents still approaching (not already first).
    if (
      sendNearTurnSms &&
      Number.isFinite(aheadOfYou) &&
      aheadOfYou > 0 &&
      aheadOfYou <= nearingTurnAheadCount &&
      !reservation.nearTurnSmsSent
    ) {
      const claimed = await claimNearTurnSms(reservation.id);
      if (claimed) {
        await deliverNotification("NEARING_TURN", {
          parentId: reservation.parentId,
          reservationId: reservation.id,
          scheduleId: schedule.id,
          branchId: reservation.branchId || schedule.branch || null,
          queueNumber: reservation.queueNumber ?? reservation.originalQueueNumber,
          clinicDate: schedule.clinicDate,
          nearingTurnAheadCount,
          customMessage: buildNearingTurnPushMessage(nearingTurnAheadCount),
          dedupeKey: `nearing_turn_${reservation.id}`,
        });
      }
    }
  }
}

async function handleReservationChange(before, after) {
  if (!after) return;

  // Walk-in parentPhone is creation-time only (confirmed-reservation SMS).
  // Do not wire it into Queue Started / Near Turn / parent notification events.
  if (!before) {
    try {
      await deliverWalkInReservationSms(after);
    } catch (err) {
      console.error("[functions/push] Walk-in reservation SMS failed:", err.message);
    }
  }

  for (const event of eventsFromReservationChange(before, after)) {
    await deliverNotification(event.eventId, event);
  }
  if (!after.scheduleId) return;
  const scheduleSnap = await db().ref(`schedules/${after.scheduleId}`).once("value");
  if (!scheduleSnap.exists()) return;
  const schedule = { id: after.scheduleId, ...scheduleSnap.val() };
  const reservations = await getReservationsBySchedule(after.scheduleId);
  await evaluatePositionEvents(schedule, reservations);
}

async function handleScheduleChange(before, after) {
  if (!after) return;
  const prevPublished = before?.status === "published";
  const currPublished = after.status === "published";
  if (!prevPublished && currPublished) return;

  const active = await getActiveParentIdsForSchedule(after.id);
  const forSchedule = active.parentIds;
  const reservations = active.reservations;

  const events = [];
  const schedId = after.id;
  const clinicDate = after.clinicDate || "unknown";
  const base = { entityId: schedId, branchId: after.branch || null };
  const prevStatus = before?.queueStatus;
    const currStatus = after.queueStatus;
    if (prevStatus !== currStatus && forSchedule.length) {
      const reservationByParent = new Map();
      reservations.forEach((reservation) => {
        if (
          reservation.parentId &&
          ACTIVE_RESERVATION_STATUSES.includes(reservation.status)
        ) {
          reservationByParent.set(reservation.parentId, reservation);
        }
      });

      if ((prevStatus === "not_started" || !prevStatus) && currStatus === "active") {
        forSchedule.forEach((parentId) => {
          const reservation = reservationByParent.get(parentId);
          events.push({
            ...base,
            eventId: "QUEUE_STARTED",
            parentId,
            scheduleId: schedId,
            clinicDate,
            branchName: after.branch || null,
            reservationId: reservation?.id || null,
            queueNumber:
              reservation?.queueNumber ??
              reservation?.originalQueueNumber ??
              reservation?.queuePosition ??
              null,
            dedupeKey: `queue_start_${schedId}_${clinicDate}`,
          });
        });
      } else if (prevStatus === "active" && currStatus === "paused") {
        const ts = after.queueStatusUpdatedAt || after.updatedAt || 0;
        forSchedule.forEach((parentId) =>
          events.push({ ...base, eventId: "QUEUE_PAUSED", parentId, dedupeKey: `queue_paused_${schedId}_${clinicDate}_${ts}` })
        );
      } else if (prevStatus === "paused" && currStatus === "active") {
        const ts = after.queueStatusUpdatedAt || after.updatedAt || 0;
        forSchedule.forEach((parentId) =>
          events.push({ ...base, eventId: "QUEUE_RESUMED", parentId, dedupeKey: `queue_resumed_${schedId}_${clinicDate}_${ts}` })
        );
      } else if (currStatus === "closed" && prevStatus !== "closed") {
        forSchedule.forEach((parentId) =>
          events.push({ ...base, eventId: "QUEUE_CLOSED", parentId, dedupeKey: `queue_closed_${schedId}_${clinicDate}` })
        );
      } else if (
        (currStatus === "ended" || currStatus === "completed" || after.status === "completed") &&
        prevStatus !== "ended" &&
        prevStatus !== "completed" &&
        before?.status !== "completed"
      ) {
        forSchedule.forEach((parentId) =>
          events.push({ ...base, eventId: "CLINIC_SESSION_ENDED", parentId, dedupeKey: `clinic_ended_${schedId}_${clinicDate}` })
        );
      }
    }

  for (const event of events) {
    await deliverNotification(event.eventId, event);
  }
  const queueJustStarted =
    (before?.queueStatus === "not_started" || !before?.queueStatus) && after.queueStatus === "active";
  if (reservations.length) {
    await evaluatePositionEvents(after, reservations, { sendNearTurnSms: queueJustStarted });
  }
}

async function getAllParentIds() {
  const snap = await db().ref("users").once("value");
  if (!snap.exists()) return [];
  return Object.entries(snap.val())
    .filter(([, user]) => user && user.role === "parent" && user.status !== "inactive" && user.isDeleted !== true)
    .map(([uid]) => uid);
}

async function notifyParentsScheduleAvailable({
  batchId,
  branchId = null,
  branchName = "",
  postedCount = 0,
  startDate = null,
  endDate = null,
} = {}) {
  if (!batchId) throw new Error("batchId is required.");
  const parents = await getAllParentIds();
  if (parents.length === 0) return { notified: 0 };

  const branchLabel = String(branchName || "")
    .replace(/\s*branch\s*$/i, "")
    .trim();
  const customMessage = branchLabel
    ? `There's a reservation schedule available at ${branchLabel}. Open Reserve to book a slot.`
    : NOTIFICATION_CONFIG.SCHEDULE_AVAILABLE.message;

  const dedupeKey = `sched_avail_batch_${batchId}`;
  let notified = 0;
  for (const parentId of parents) {
    const ok = await deliverNotification("SCHEDULE_AVAILABLE", {
      parentId,
      entityId: batchId,
      branchId,
      dedupeKey,
      customMessage,
      metadata: {
        batchId,
        postedCount,
        startDate,
        endDate,
        branchName: branchLabel || null,
      },
    });
    if (ok) notified += 1;
  }
  return { notified, parentCount: parents.length };
}

module.exports = {
  handleReservationChange,
  handleScheduleChange,
  sendPushToParent,
  sendPushToDoctor,
  configureVapid,
  notifyParentsScheduleAvailable,
};
