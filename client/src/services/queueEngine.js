import { getDb } from "../firebase/database";
import { ref, get, update, query, orderByChild, equalTo } from "firebase/database";
import { ACTIVE_RESERVATION_STATUSES } from "./reservationService";
import {
  UNCHECKED_WAITING_STATUSES,
  isLiveQueueStatus,
} from "../utils/penaltyTimer";

const WAITING_FOR_TURN_STATUSES = [
  "reserved",
  "waiting",
  "validation_open",
  "waiting_for_window",
  "checked_in",
];

const firstPenalizeTargetInQueue = (activeQueue) => {
  const firstWaiting = activeQueue.find((r) => WAITING_FOR_TURN_STATUSES.includes(r.status));
  if (firstWaiting?.source === "walk_in") return firstWaiting;
  return activeQueue.find((r) => UNCHECKED_WAITING_STATUSES.includes(r.status)) || null;
};

/**
 * Queue Engine
 * Single Source of Truth for live queue state and relative queue positions across the system.
 * Every module (Notification Service, Real-Time Monitoring, Secretary Request Check-In, Status Badges)
 * consumes queue state from this engine.
 */

export const QUEUE_STATES = {
  YOU_ARE_NEXT: 'YOU_ARE_NEXT',
  ALMOST_NEXT: 'ALMOST_NEXT',
  WAITING: 'WAITING',
  CHECKED_IN: 'CHECKED_IN',
  WITH_DOCTOR: 'WITH_DOCTOR',
  COMPLETED: 'COMPLETED',
  FORFEITED: 'FORFEITED',
  CANCELLED: 'CANCELLED',
};

/**
 * Standard sorting logic for active waiting queues.
 * Sorts primarily by dynamically calculated queueOrder, falling back to sortTimestamp or createdAt.
 */
export const sortActiveQueue = (reservations) => {
  return [...reservations].sort((a, b) => {
    if (a.queueOrder !== undefined && b.queueOrder !== undefined) {
      return a.queueOrder - b.queueOrder;
    }
    // fallback if queueOrder is missing
    const timeA = a.sortTimestamp || a.createdAt || 0;
    const timeB = b.sortTimestamp || b.createdAt || 0;
    return timeA - timeB;
  });
};

/**
 * Computes the live Queue State for a single reservation relative to all reservations in its schedule.
 */
export const computeReservationState = (reservation, allReservations = [], options = {}) => {
  if (!reservation) return null;

  // Terminal / absolute states
  if (reservation.status === 'cancelled') {
    return QUEUE_STATES.CANCELLED;
  }
  if (['forfeited', 'penalized', 'late_limit_reached'].includes(reservation.status)) {
    return QUEUE_STATES.FORFEITED;
  }
  if (['completed', 'consultation_completed'].includes(reservation.status)) {
    return QUEUE_STATES.COMPLETED;
  }
  if (['with_doctor', 'in_consultation'].includes(reservation.status)) {
    return QUEUE_STATES.WITH_DOCTOR;
  }
  // Check if consultation progression has officially advanced
  // (Either options.consultationActive is true OR any reservation in this schedule is with_doctor / in_consultation / completed / has sentToDoctorAt)
  const hasConsultationStarted =
    options.consultationActive === true ||
    allReservations.some(
      (item) =>
        item.scheduleId === reservation.scheduleId &&
        (['with_doctor', 'in_consultation', 'completed', 'consultation_completed'].includes(item.status) || item.sentToDoctorAt)
    );

  if (!hasConsultationStarted) {
    if (reservation.status === 'checked_in') {
      return QUEUE_STATES.CHECKED_IN;
    }
    return QUEUE_STATES.WAITING;
  }

  // Active waiting reservations sorted by sortTimestamp / createdAt
  const activeWaiting = allReservations
    .filter(
      (item) =>
        item.scheduleId === reservation.scheduleId &&
        ['reserved', 'waiting', 'validation_open', 'waiting_for_window', 'checked_in'].includes(item.status)
    )
    .sort((a, b) => {
      const timeA = a.sortTimestamp || a.createdAt || 0;
      const timeB = b.sortTimestamp || b.createdAt || 0;
      return timeA - timeB;
    });

  const index = activeWaiting.findIndex((item) => item.id === reservation.id);
  if (index === 0) return QUEUE_STATES.YOU_ARE_NEXT;
  if (index === 1) return QUEUE_STATES.ALMOST_NEXT;
  if (reservation.status === 'checked_in') return QUEUE_STATES.CHECKED_IN;
  return QUEUE_STATES.WAITING;
};

/**
 * Computes Ahead Of You count for a reservation relative to active reservations in its schedule.
 */
export const computeAheadOfYou = (reservation, allReservations = [], options = {}) => {
  if (!reservation) return 0;
  if (['with_doctor', 'in_consultation', 'completed', 'consultation_completed', 'cancelled', 'forfeited'].includes(reservation.status)) {
    return 0;
  }

  const activePipeline = allReservations
    .filter(
      (item) =>
        item.scheduleId === reservation.scheduleId &&
        ['reserved', 'waiting', 'validation_open', 'waiting_for_window', 'checked_in', 'with_doctor', 'in_consultation'].includes(item.status)
    )
    .sort((a, b) => {
      const timeA = a.sortTimestamp || a.createdAt || 0;
      const timeB = b.sortTimestamp || b.createdAt || 0;
      return timeA - timeB;
    });

  const index = activePipeline.findIndex((item) => item.id === reservation.id);
  return index > 0 ? index : 0;
};

/**
 * Returns an enriched list of reservations where each reservation has accurate `.queueState`, `.aheadOfYou`, and `.queueOrder` properties.
 */
export const enrichReservationsWithState = (allReservations = []) => {
  return allReservations.map((r) => ({
    ...r,
    queueState: computeReservationState(r, allReservations),
    aheadOfYou: computeAheadOfYou(r, allReservations),
  }));
};

/**
 * Full Queue Recalculation Engine
 * Whenever any queue movement occurs (Penalty, Cancellation, Forfeiture, Consultation transition, etc.),
 * recalculates all derived queue data (Queue Order, Ahead Of You, Queue State) and writes back to Firebase.
 */
export const recalculateEntireQueue = async (scheduleId, options = {}) => {
  if (!scheduleId) return;

  const q = query(
    ref(getDb(), "reservations"),
    orderByChild("scheduleId"),
    equalTo(scheduleId)
  );

  const snapshot = await get(q);
  if (!snapshot.exists()) return;

  const scheduleReservations = Object.entries(snapshot.val()).map(([id, val]) => ({
    id,
    ...val,
  }));

  if (scheduleReservations.length === 0) return;

  const activeStatuses = ACTIVE_RESERVATION_STATUSES;

  // Step 1: Sort the active queue by actual sortTimestamp / createdAt
  const activeQueue = scheduleReservations
    .filter((r) => activeStatuses.includes(r.status))
    .sort((a, b) => {
      const timeA = a.sortTimestamp || a.createdAt || 0;
      const timeB = b.sortTimestamp || b.createdAt || 0;
      return timeA - timeB;
    });

  // Step 2-4: Assign Queue Numbers, Ahead Of You, and Queue State
  const updates = {};
  const advanceConsultation = options.advanceConsultation === true;

  activeQueue.forEach((r, idx) => {
    const queueOrder = idx + 1;
    const aheadOfYou = ["with_doctor", "in_consultation"].includes(r.status) ? 0 : idx;

    updates[`reservations/${r.id}/queueOrder`] = queueOrder;
    updates[`reservations/${r.id}/queuePosition`] = queueOrder;
    updates[`reservations/${r.id}/aheadOfYou`] = aheadOfYou;

    // Only allow YOU_ARE_NEXT / ALMOST_NEXT queue states when consultation officially advances
    if (advanceConsultation) {
      const queueState = computeReservationState(r, scheduleReservations, { consultationActive: true });
      if (queueState) {
        updates[`reservations/${r.id}/queueState`] = queueState;
      }
    } else {
      const queueState = computeReservationState(r, scheduleReservations, { consultationActive: false });
      if (queueState && !['YOU_ARE_NEXT', 'ALMOST_NEXT'].includes(queueState)) {
        updates[`reservations/${r.id}/queueState`] = queueState;
      }
    }
  });

  // Ensure inactive reservations have their terminal state recorded
  scheduleReservations
    .filter((r) => !activeStatuses.includes(r.status))
    .forEach((r) => {
      const queueState = computeReservationState(r, scheduleReservations, { consultationActive: false });
      if (queueState) {
        updates[`reservations/${r.id}/queueState`] = queueState;
      }
      if (r.becameCurrentTurnAt) {
        updates[`reservations/${r.id}/becameCurrentTurnAt`] = null;
      }
    });

  let queueIsLive = false;
  try {
    const scheduleSnap = await get(ref(getDb(), `schedules/${scheduleId}`));
    queueIsLive = isLiveQueueStatus(scheduleSnap.exists() ? scheduleSnap.val()?.queueStatus : null);
  } catch (error) {
    console.warn("Could not read schedule queue status for current-turn stamp:", error);
  }

  const firstPenalizeTarget = queueIsLive ? firstPenalizeTargetInQueue(activeQueue) : null;

  scheduleReservations.forEach((r) => {
    if (!activeStatuses.includes(r.status)) return;
    const isCurrentTurn = Boolean(firstPenalizeTarget && firstPenalizeTarget.id === r.id);
    if (isCurrentTurn) {
      if (!r.becameCurrentTurnAt) {
        updates[`reservations/${r.id}/becameCurrentTurnAt`] = Date.now();
      }
    } else if (r.becameCurrentTurnAt) {
      updates[`reservations/${r.id}/becameCurrentTurnAt`] = null;
    }
  });

  // Step 7: Write ALL updated queue data back to Firebase
  if (Object.keys(updates).length > 0) {
    await update(ref(getDb()), updates);
  }
};
