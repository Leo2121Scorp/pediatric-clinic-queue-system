const { demoDatabase } = require("./rtdbRouter");
const { releaseParentDateCap } = require("./parentBookingCap");
const {
  ANGELES_BRANCH_ID,
  scheduleIdForDate,
  buildStarterSchedule,
} = require("./demoSeedData");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function findDemoDoctorId(db) {
  const snap = await db.ref("users").once("value");
  if (!snap.exists()) return null;
  for (const [uid, user] of Object.entries(snap.val() || {})) {
    if (user && user.role === "doctor" && user.status !== "inactive" && user.isDeleted !== true) {
      return uid;
    }
  }
  return null;
}

/**
 * Clears one clinic date inside the demo database and writes the starter schedule back.
 * Safe to run twice: a second run finds no dependent rows and rewrites the same schedule.
 */
async function resetDemoClinicDay({ clinicDate, callerUid, db }) {
  if (!DATE_RE.test(String(clinicDate || ""))) {
    throw coded("invalid-argument", "clinicDate must be YYYY-MM-DD.");
  }

  const database = db || demoDatabase();
  const schedulesSnap = await database.ref("schedules").once("value");
  const schedules = schedulesSnap.exists() ? schedulesSnap.val() : {};
  const scheduleIds = Object.entries(schedules)
    .filter(([, value]) => value && value.clinicDate === clinicDate)
    .map(([id]) => id);
  const scheduleIdSet = new Set(scheduleIds);

  const reservationsSnap = await database.ref("reservations").once("value");
  const reservations = reservationsSnap.exists() ? reservationsSnap.val() : {};
  const removedReservationIds = [];
  const parentIds = new Set();
  const updates = {};

  for (const [id, reservation] of Object.entries(reservations || {})) {
    if (!reservation) continue;
    const matchesSchedule = reservation.scheduleId && scheduleIdSet.has(reservation.scheduleId);
    const matchesDate = reservation.clinicDate === clinicDate;
    if (!matchesSchedule && !matchesDate) continue;
    updates[`reservations/${id}`] = null;
    removedReservationIds.push(id);
    if (reservation.parentId) parentIds.add(reservation.parentId);
  }

  const starterId = scheduleIdForDate(clinicDate, ANGELES_BRANCH_ID);
  for (const scheduleId of scheduleIds) {
    if (scheduleId !== starterId) updates[`schedules/${scheduleId}`] = null;
  }

  const locksSnap = await database.ref("bookingLocks").once("value");
  if (locksSnap.exists()) {
    for (const uid of Object.keys(locksSnap.val() || {})) {
      if (locksSnap.val()?.[uid]?.[clinicDate] != null) {
        updates[`bookingLocks/${uid}/${clinicDate}`] = null;
        parentIds.add(uid);
      }
    }
  }

  const removedSet = new Set(removedReservationIds);
  const notifSnap = await database.ref("notifications").once("value");
  if (notifSnap.exists()) {
    for (const [parentId, notes] of Object.entries(notifSnap.val() || {})) {
      if (!notes || typeof notes !== "object") continue;
      for (const [noteId, note] of Object.entries(notes)) {
        if (!note || typeof note !== "object") continue;
        const tiedToReservation = note.reservationId && removedSet.has(note.reservationId);
        const tiedToSchedule = note.scheduleId && scheduleIdSet.has(note.scheduleId);
        if (tiedToReservation || tiedToSchedule) {
          updates[`notifications/${parentId}/${noteId}`] = null;
        }
      }
    }
  }

  const closuresSnap = await database.ref("clinicClosures").once("value");
  if (closuresSnap.exists()) {
    for (const [id, closure] of Object.entries(closuresSnap.val() || {})) {
      if (!closure?.startDate || !closure?.endDate) continue;
      if (closure.startDate <= clinicDate && clinicDate <= closure.endDate) {
        updates[`clinicClosures/${id}`] = null;
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await database.ref().update(updates);
  }

  for (const parentId of parentIds) {
    await releaseParentDateCap(database, parentId, clinicDate);
  }

  const doctorId = await findDemoDoctorId(database);
  await database.ref(`schedules/${starterId}`).set(
    buildStarterSchedule({ clinicDate, doctorId, branchId: ANGELES_BRANCH_ID })
  );

  const logRef = database.ref("demoResetLogs").push();
  await logRef.set({
    callerUid: callerUid || null,
    clinicDate,
    at: Date.now(),
    scheduleId: starterId,
    removedReservations: removedReservationIds.length,
    clearedSchedules: scheduleIds.length,
  });

  return {
    clinicDate,
    scheduleId: starterId,
    removedReservations: removedReservationIds.length,
    message: `Demo clinic day ${clinicDate} is ready to run again.`,
  };
}

module.exports = {
  resetDemoClinicDay,
};
