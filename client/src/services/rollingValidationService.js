// Deprecated: Rolling validation windows have been removed in the refactored workflow.
// Functions preserved as safe pass-throughs for backwards compatibility.

export const recalculateRollingValidation = async (scheduleId) => {
  // No-op: validation window logic removed
  return;
};

export const getEffectiveReservationStatus = (reservation, schedule, allScheduleReservations = []) => {
  if (!reservation) return null;
  return reservation.status;
};

export const getNumbersAheadForWindow = (reservation, schedule, allScheduleReservations = []) => {
  return null;
};
