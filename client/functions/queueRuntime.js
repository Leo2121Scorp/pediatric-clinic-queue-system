const ACTIVE_RESERVATION_STATUSES = [
  "reserved",
  "checked_in",
  "waiting",
  "in_consultation",
  "with_doctor",
  "validation_open",
  "waiting_for_window",
];

const UNCHECKED_WAITING_STATUSES = [
  "reserved",
  "waiting",
  "validation_open",
  "waiting_for_window",
];

const LIVE_QUEUE_STATUSES = ["active", "paused", "closed"];

const WAITING_FOR_TURN_STATUSES = [
  "reserved",
  "waiting",
  "validation_open",
  "waiting_for_window",
  "checked_in",
];

const WALK_IN_PENALIZE_STATUSES = ["checked_in", "reserved", "waiting"];

function canExpirePenaltyTimer(reservation) {
  if (!reservation) return false;
  if (UNCHECKED_WAITING_STATUSES.includes(reservation.status)) return true;
  return reservation.source === "walk_in" && WALK_IN_PENALIZE_STATUSES.includes(reservation.status);
}

function firstPenalizeTargetInQueue(activeQueue) {
  const firstWaiting = activeQueue.find((r) => WAITING_FOR_TURN_STATUSES.includes(r.status));
  if (firstWaiting?.source === "walk_in") return firstWaiting;
  return activeQueue.find((r) => UNCHECKED_WAITING_STATUSES.includes(r.status)) || null;
}

const { getRtdb } = require("./rtdbRouter");

function db() {
  return getRtdb();
}

function computeReservationState(reservation, allReservations = [], options = {}) {
  if (!reservation) return null;
  if (reservation.status === "cancelled") return "CANCELLED";
  if (["forfeited", "penalized", "late_limit_reached"].includes(reservation.status)) return "FORFEITED";
  if (["completed", "consultation_completed"].includes(reservation.status)) return "COMPLETED";
  if (["with_doctor", "in_consultation"].includes(reservation.status)) return "WITH_DOCTOR";

  const hasConsultationStarted =
    options.consultationActive === true ||
    allReservations.some(
      (item) =>
        item.scheduleId === reservation.scheduleId &&
        (["with_doctor", "in_consultation", "completed", "consultation_completed"].includes(item.status) ||
          item.sentToDoctorAt)
    );

  if (!hasConsultationStarted) {
    if (reservation.status === "checked_in") return "CHECKED_IN";
    return "WAITING";
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
  if (reservation.status === "checked_in") return "CHECKED_IN";
  return "WAITING";
}

async function recalculateEntireQueueAdmin(scheduleId) {
  if (!scheduleId) return;

  const snapshot = await db().ref("reservations").orderByChild("scheduleId").equalTo(scheduleId).once("value");
  if (!snapshot.exists()) return;

  const scheduleReservations = [];
  snapshot.forEach((child) => {
    scheduleReservations.push({ id: child.key, ...child.val() });
  });
  if (scheduleReservations.length === 0) return;

  const activeQueue = scheduleReservations
    .filter((r) => ACTIVE_RESERVATION_STATUSES.includes(r.status))
    .sort((a, b) => (a.sortTimestamp || a.createdAt || 0) - (b.sortTimestamp || b.createdAt || 0));

  const updates = {};
  activeQueue.forEach((r, idx) => {
    const queueOrder = idx + 1;
    const aheadOfYou = ["with_doctor", "in_consultation"].includes(r.status) ? 0 : idx;
    updates[`reservations/${r.id}/queueOrder`] = queueOrder;
    updates[`reservations/${r.id}/queuePosition`] = queueOrder;
    updates[`reservations/${r.id}/aheadOfYou`] = aheadOfYou;
    const queueState = computeReservationState(r, scheduleReservations, { consultationActive: false });
    if (queueState && !["YOU_ARE_NEXT", "ALMOST_NEXT"].includes(queueState)) {
      updates[`reservations/${r.id}/queueState`] = queueState;
    }
  });

  scheduleReservations
    .filter((r) => !ACTIVE_RESERVATION_STATUSES.includes(r.status))
    .forEach((r) => {
      const queueState = computeReservationState(r, scheduleReservations, { consultationActive: false });
      if (queueState) updates[`reservations/${r.id}/queueState`] = queueState;
      if (r.becameCurrentTurnAt) updates[`reservations/${r.id}/becameCurrentTurnAt`] = null;
    });

  let queueIsLive = false;
  try {
    const scheduleSnap = await db().ref(`schedules/${scheduleId}`).once("value");
    queueIsLive = LIVE_QUEUE_STATUSES.includes(scheduleSnap.exists() ? scheduleSnap.val()?.queueStatus : null);
  } catch (error) {
    console.warn("expirePenaltyTimers: could not read schedule status", error.message);
  }

  const firstPenalizeTarget = queueIsLive ? firstPenalizeTargetInQueue(activeQueue) : null;

  scheduleReservations.forEach((r) => {
    if (!ACTIVE_RESERVATION_STATUSES.includes(r.status)) return;
    const isCurrentTurn = Boolean(firstPenalizeTarget && firstPenalizeTarget.id === r.id);
    if (isCurrentTurn) {
      if (!r.becameCurrentTurnAt) {
        updates[`reservations/${r.id}/becameCurrentTurnAt`] = Date.now();
      }
    } else if (r.becameCurrentTurnAt) {
      updates[`reservations/${r.id}/becameCurrentTurnAt`] = null;
    }
  });

  if (Object.keys(updates).length > 0) {
    await db().ref().update(updates);
  }
}

module.exports = {
  ACTIVE_RESERVATION_STATUSES,
  UNCHECKED_WAITING_STATUSES,
  canExpirePenaltyTimer,
  recalculateEntireQueueAdmin,
};
