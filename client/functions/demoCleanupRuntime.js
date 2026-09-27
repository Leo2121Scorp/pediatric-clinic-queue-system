const { demoDatabase, demoDatabaseUrl } = require("./rtdbRouter");
const { addManilaDays, manilaDateString } = require("./manilaDate");

const RETENTION_DAYS = 14;
const LOG_RETENTION_DAYS = 30;

/**
 * Deletes demo schedules and reservations older than the retention window.
 * Does not touch users or the default database.
 */
async function purgeStaleDemoData({ retentionDays = RETENTION_DAYS } = {}) {
  if (!demoDatabaseUrl()) {
    console.log("purgeStaleDemoData skipped: demo database URL is not configured.");
    return { skipped: true };
  }

  const db = demoDatabase();
  const cutoff = addManilaDays(manilaDateString(), -Math.abs(retentionDays));
  const logCutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const schedulesSnap = await db.ref("schedules").once("value");
  const schedules = schedulesSnap.exists() ? schedulesSnap.val() : {};
  const staleScheduleIds = new Set(
    Object.entries(schedules)
      .filter(([, value]) => value?.clinicDate && value.clinicDate < cutoff)
      .map(([id]) => id)
  );

  const reservationsSnap = await db.ref("reservations").once("value");
  const updates = {};
  let removedReservations = 0;
  if (reservationsSnap.exists()) {
    for (const [id, reservation] of Object.entries(reservationsSnap.val() || {})) {
      if (!reservation) continue;
      const staleSchedule = reservation.scheduleId && staleScheduleIds.has(reservation.scheduleId);
      const staleDate = reservation.clinicDate && reservation.clinicDate < cutoff;
      if (!staleSchedule && !staleDate) continue;
      updates[`reservations/${id}`] = null;
      removedReservations += 1;
    }
  }

  for (const scheduleId of staleScheduleIds) {
    updates[`schedules/${scheduleId}`] = null;
  }

  const logsSnap = await db.ref("demoResetLogs").once("value");
  let removedLogs = 0;
  if (logsSnap.exists()) {
    for (const [id, log] of Object.entries(logsSnap.val() || {})) {
      if (log?.at && log.at < logCutoffMs) {
        updates[`demoResetLogs/${id}`] = null;
        removedLogs += 1;
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  return {
    cutoff,
    removedSchedules: staleScheduleIds.size,
    removedReservations,
    removedLogs,
  };
}

module.exports = {
  RETENTION_DAYS,
  purgeStaleDemoData,
};
