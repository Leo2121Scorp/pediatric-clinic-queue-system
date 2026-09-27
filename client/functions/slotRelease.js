const { databaseFor } = require("./rtdbRouter");

const ACTIVE_STATUSES = new Set([
  "reserved",
  "checked_in",
  "waiting",
  "in_consultation",
  "with_doctor",
  "validation_open",
  "waiting_for_window",
]);

const TERMINAL_STATUSES = new Set([
  "cancelled",
  "cancelled_by_clinic",
  "forfeited",
  "consultation_completed",
  "completed",
  "expired",
  "validation_expired",
  "penalized",
  "late_limit_reached",
]);

async function claimFlag(ref, flag) {
  const result = await ref.child(flag).transaction((current) => {
    if (current === true) return;
    return true;
  });
  return Boolean(result.committed && result.snapshot.val() === true);
}

async function decrementBooking(db, scheduleId) {
  const bookingRef = db.ref(`schedules/${scheduleId}/booking`);
  const snap = await bookingRef.once("value");
  if (!snap.exists()) return;
  await bookingRef.transaction((current) => {
    if (!current) return;
    return {
      ...current,
      activeSlotCount: Math.max(0, Number(current.activeSlotCount || 0) - 1),
      nextQueueNumber: current.nextQueueNumber || 1,
    };
  });
}

async function clearBookingLock(db, reservation) {
  if (!reservation?.parentId) return;
  let clinicDate = reservation.clinicDate;
  if (!clinicDate && reservation.scheduleId) {
    const snap = await db.ref(`schedules/${reservation.scheduleId}/clinicDate`).once("value");
    clinicDate = snap.val();
  }
  if (!clinicDate) return;
  const lockRef = db.ref(`bookingLocks/${reservation.parentId}/${clinicDate}`);
  const lock = await lockRef.once("value");
  if (lock.val() === reservation.scheduleId || lock.val()) {
    if (!reservation.scheduleId || lock.val() === reservation.scheduleId) {
      await lockRef.remove();
    }
  }
  try {
    const { releaseParentDateCap } = require("./parentBookingCap");
    await releaseParentDateCap(db, reservation.parentId, clinicDate);
  } catch (error) {
    console.error("clearBookingLock cap release failed:", error);
  }
}

async function releaseSlotIfTerminal(admin, before, after) {
  if (!before || !after?.scheduleId) return;
  if (!ACTIVE_STATUSES.has(before.status) || !TERMINAL_STATUSES.has(after.status)) return;
  if (before.status === after.status) return;

  const db = databaseFor(admin);
  const reservationRef = db.ref(`reservations/${after.id}`);
  const flag = after.slotHeld ? "slotReleased" : "legacySlotReleased";
  if (after[flag]) return;
  const won = await claimFlag(reservationRef, flag);
  if (!won) return;

  try {
    await decrementBooking(db, after.scheduleId);
    await clearBookingLock(db, after);
  } catch (error) {
    console.error("releaseSlotIfTerminal failed:", error);
  }
}

module.exports = { releaseSlotIfTerminal };
