const {
  manilaDateString,
  manilaNowMinutes,
  addManilaDays,
  BOOKING_HORIZON_DAYS,
  minutesFromTime,
} = require("./manilaDate");
const { claimParentDateCap, releaseParentDateCap } = require("./parentBookingCap");
const { databaseFor } = require("./rtdbRouter");

const CLOSED_MESSAGE = "The clinic is closed on this date.";
const WINDOW_MESSAGE = "This date is outside the booking window.";
const FULL_MESSAGE = "This schedule is already full.";
const MULTI_DATE_CAP = 2;
const MULTI_DATE_MESSAGE =
  "You already have 2 upcoming reservations. Cancel one or wait until a visit is finished before booking another.";

const ACTIVE_STATUSES = new Set([
  "reserved",
  "checked_in",
  "waiting",
  "in_consultation",
  "with_doctor",
  "validation_open",
  "waiting_for_window",
]);

const COMPLETED_STATUSES = new Set(["completed", "consultation_completed"]);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function generateReservationCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function namesMatch(left, right) {
  const clean = (value) => String(value || "").toLowerCase().replace(/\s*branch\s*$/i, "").trim();
  const a = clean(left);
  const b = clean(right);
  return Boolean(a) && a === b;
}

function staffCanUseSchedule(user, schedule) {
  if (user.role === "doctor" || user.role === "admin") return true;
  if (user.role !== "secretary") return false;
  if (user.assignedBranchId && schedule.branchId) return user.assignedBranchId === schedule.branchId;
  if (user.assignedBranch && schedule.branch) return namesMatch(user.assignedBranch, schedule.branch);
  return !user.assignedBranchId && !user.assignedBranch;
}

async function dateIsClosed(db, schedule) {
  if (schedule.dayClosed) return true;
  const snap = await db.ref("clinicClosures").once("value");
  if (!snap.exists()) return false;
  return Object.values(snap.val()).some((closure) => {
    if (!closure?.startDate || !closure?.endDate) return false;
    if (schedule.clinicDate < closure.startDate || schedule.clinicDate > closure.endDate) return false;
    if (schedule.branchId && closure.branchId) return schedule.branchId === closure.branchId;
    return namesMatch(schedule.branch, closure.branch);
  });
}

async function resolveReservationDate(db, reservation) {
  if (reservation.clinicDate) return reservation.clinicDate;
  if (!reservation.scheduleId) return null;
  const scheduleSnap = await db.ref(`schedules/${reservation.scheduleId}`).once("value");
  return scheduleSnap.exists() ? scheduleSnap.val().clinicDate || null : null;
}

async function parentBlockedOnDate(db, parentId, clinicDate, doctorId) {
  const snap = await db.ref("reservations").orderByChild("parentId").equalTo(parentId).once("value");
  if (!snap.exists()) return null;
  const rows = Object.values(snap.val());
  for (const reservation of rows) {
    let date = reservation.clinicDate;
    let scheduleDoctor = null;
    if (!date && reservation.scheduleId) {
      const scheduleSnap = await db.ref(`schedules/${reservation.scheduleId}`).once("value");
      if (scheduleSnap.exists()) {
        date = scheduleSnap.val().clinicDate;
        scheduleDoctor = scheduleSnap.val().doctorId;
      }
    }
    if (date !== clinicDate) continue;
    if (ACTIVE_STATUSES.has(reservation.status)) {
      return "You already have an active reservation for this date.";
    }
    if (COMPLETED_STATUSES.has(reservation.status)) {
      if (!doctorId || !scheduleDoctor || scheduleDoctor === doctorId) {
        return "You've already completed your consultation for this clinic date.";
      }
    }
  }
  return null;
}

async function parentOverMultiDateCap(db, parentId, clinicDate) {
  const snap = await db.ref("reservations").orderByChild("parentId").equalTo(parentId).once("value");
  if (!snap.exists()) return null;
  const rows = Object.values(snap.val());
  const activeDates = new Set();
  for (const reservation of rows) {
    if (!ACTIVE_STATUSES.has(reservation.status)) continue;
    const date = await resolveReservationDate(db, reservation);
    if (!date) continue;
    activeDates.add(date);
  }
  if (activeDates.has(clinicDate)) return null;
  if (activeDates.size >= MULTI_DATE_CAP) return MULTI_DATE_MESSAGE;
  return null;
}

function normalizeChildren(children) {
  const list = (children || []).map((child) => ({
    childName: String(child.childName || "").trim(),
    age: String(child.age ?? "").trim(),
    sex: child.sex === "Male" || child.sex === "Female" ? child.sex : "",
    childId: null,
  }));
  if (list.length === 0) throw coded("invalid-argument", "At least one child is required.");
  if (list.length > 10) throw coded("invalid-argument", "A maximum of 10 children is allowed.");
  if (list.some((child) => !child.childName)) throw coded("invalid-argument", "Each child must have a name.");
  if (list.some((child) => {
    if (!/^\d+$/.test(child.age)) return true;
    const age = parseInt(child.age, 10);
    return age < 1 || age > 25;
  })) {
    throw coded("invalid-argument", "Each child must have a valid age (1–25).");
  }
  if (list.some((child) => !child.sex)) throw coded("invalid-argument", "Each child must have a sex selected.");
  return list;
}

async function rollbackSlot(bookingRef) {
  await bookingRef.transaction((current) => {
    if (!current) return { activeSlotCount: 0, nextQueueNumber: 1 };
    return {
      activeSlotCount: Math.max(0, Number(current.activeSlotCount || 0) - 1),
      nextQueueNumber: current.nextQueueNumber || 1,
    };
  });
}

async function claimReservationSlot({ admin, callerUid, payload }) {
  if (!callerUid) throw coded("unauthenticated", "You must be signed in.");
  const db = databaseFor(admin);
  const userSnap = await db.ref(`users/${callerUid}`).once("value");
  if (!userSnap.exists()) throw coded("permission-denied", "Account not found.");
  const user = userSnap.val() || {};
  if (user.status && user.status !== "active") throw coded("permission-denied", "Account is not active.");
  if (user.isDeleted === true) throw coded("permission-denied", "Account is not active.");

  const mode = payload?.mode === "walk_in" ? "walk_in" : "parent";
  const scheduleId = payload?.scheduleId;
  if (!scheduleId) throw coded("invalid-argument", "Schedule is required.");
  if (mode === "walk_in" && user.role !== "secretary" && user.role !== "doctor") {
    throw coded("permission-denied", "Only clinic staff can add a walk-in.");
  }
  if (mode === "parent" && user.role !== "parent") {
    throw coded("permission-denied", "Only a parent can reserve a slot.");
  }

  const scheduleSnap = await db.ref(`schedules/${scheduleId}`).once("value");
  if (!scheduleSnap.exists()) throw coded("not-found", "Schedule not found.");
  const schedule = scheduleSnap.val();
  if (schedule.status !== "published") throw coded("failed-precondition", "Schedule is not available for booking.");
  if (await dateIsClosed(db, schedule)) throw coded("failed-precondition", CLOSED_MESSAGE);
  if (["closed", "ended", "completed"].includes(schedule.queueStatus) || schedule.status === "completed") {
    throw coded("failed-precondition", "This clinic queue has closed to new reservations.");
  }
  if (mode === "walk_in" && !staffCanUseSchedule(user, schedule)) {
    throw coded("permission-denied", "This schedule is outside your branch.");
  }

  let walkInChildren = null;
  let walkInConcern = "";
  if (mode === "walk_in") {
    walkInChildren = normalizeChildren(payload.children);
    walkInConcern = String(payload.concern || "").trim();
    if (!walkInConcern) throw coded("invalid-argument", "A visit concern is required.");
  }

  const today = manilaDateString();
  const horizon = addManilaDays(today, BOOKING_HORIZON_DAYS);
  if (!schedule.clinicDate || schedule.clinicDate < today) {
    throw coded("failed-precondition", "This date has passed.");
  }
  if (schedule.clinicDate > horizon) {
    throw coded("failed-precondition", WINDOW_MESSAGE);
  }
  if (schedule.clinicDate === today) {
    const closing = minutesFromTime(schedule.closingTime);
    if (closing != null && manilaNowMinutes() >= closing) {
      throw coded("failed-precondition", "Reservations are closed for today.");
    }
  }

  const capacity = Number(schedule.slotCapacity || 0);
  if (capacity < 1) throw coded("failed-precondition", "This schedule has no slots.");

  let lockRef = null;
  let capRef = null;
  if (mode === "parent") {
    const blocked = await parentBlockedOnDate(db, callerUid, schedule.clinicDate, schedule.doctorId);
    if (blocked) throw coded("failed-precondition", blocked);
    // Fast-fail advisory check (atomic guarantee is claimParentDateCap).
    const overCap = await parentOverMultiDateCap(db, callerUid, schedule.clinicDate);
    if (overCap) throw coded("failed-precondition", overCap);
    capRef = await claimParentDateCap(db, callerUid, schedule.clinicDate, scheduleId, {
      cap: MULTI_DATE_CAP,
      onOverCap: () => {
        throw coded("failed-precondition", MULTI_DATE_MESSAGE);
      },
    });
    if (!capRef) {
      throw coded("failed-precondition", MULTI_DATE_MESSAGE);
    }
    lockRef = db.ref(`bookingLocks/${callerUid}/${schedule.clinicDate}`);
    const lock = await lockRef.transaction((current) => {
      if (current) return;
      return scheduleId;
    });
    if (!lock.committed) {
      try {
        await releaseParentDateCap(db, callerUid, schedule.clinicDate);
      } catch (capError) {
        console.error("claimReservationSlot cap cleanup failed:", capError);
      }
      throw coded("failed-precondition", "You already have an active reservation for this date.");
    }
  }

  const existingSnap = await db.ref("reservations").orderByChild("scheduleId").equalTo(scheduleId).once("value");
  const existing = existingSnap.exists() ? Object.values(existingSnap.val()) : [];
  const baseline = existing.filter((reservation) => ACTIVE_STATUSES.has(reservation.status)).length;
  const maxQueue = existing.reduce(
    (max, reservation) => Math.max(max, Number(reservation.queueNumber || reservation.originalQueueNumber || 0)),
    0
  );

  const bookingRef = db.ref(`schedules/${scheduleId}/booking`);
  let slotTaken = false;
  try {
    const claimed = await bookingRef.transaction((current) => {
      if (!current) {
        if (baseline >= capacity) return;
        const next = Math.max(maxQueue, baseline) + 1;
        return { activeSlotCount: baseline + 1, nextQueueNumber: next + 1 };
      }
      const count = Number(current.activeSlotCount || 0);
      if (count >= capacity) return;
      const next = Number(current.nextQueueNumber || count + 1);
      return { activeSlotCount: count + 1, nextQueueNumber: next + 1 };
    });
    if (!claimed.committed) {
      throw coded("failed-precondition", FULL_MESSAGE);
    }
    slotTaken = true;
    const queueNumber = Number(claimed.snapshot.val().nextQueueNumber) - 1;
    const now = Date.now();
    const reservationRef = db.ref("reservations").push();

    if (mode === "walk_in") {
      const children = walkInChildren;
      const concern = walkInConcern;
      const parentName = String(payload.parentName || "").trim();
      const parentPhone = String(payload.parentPhone || "").trim();
      await reservationRef.set({
        scheduleId,
        clinicDate: schedule.clinicDate,
        branchId: schedule.branchId || null,
        status: "checked_in",
        source: "walk_in",
        createdBy: callerUid,
        slotHeld: true,
        reservationCode: generateReservationCode(),
        queueNumber,
        originalQueueNumber: queueNumber,
        queuePosition: queueNumber,
        childName: children[0].childName,
        age: children[0].age,
        sex: children[0].sex,
        concern,
        children,
        ...(parentName ? { parentName } : {}),
        ...(parentPhone ? { parentPhone } : {}),
        patientInfoCompleted: true,
        checkedIn: true,
        checkedInAt: now,
        checkedInBy: callerUid,
        createdAt: now,
        reservationCreatedAt: now,
      });
    } else {
      await reservationRef.set({
        scheduleId,
        clinicDate: schedule.clinicDate,
        branchId: schedule.branchId || null,
        parentId: callerUid,
        parentEmail: user.email || "",
        status: "reserved",
        slotHeld: true,
        reservationCode: generateReservationCode(),
        queueNumber,
        originalQueueNumber: queueNumber,
        queuePosition: queueNumber,
        checkedIn: false,
        createdAt: now,
        reservationCreatedAt: now,
      });
    }

    return { reservationId: reservationRef.key, queueNumber };
  } catch (error) {
    if (slotTaken) {
      try {
        await rollbackSlot(bookingRef);
      } catch (rollbackError) {
        console.error("claimReservationSlot rollback failed:", rollbackError);
      }
    }
    if (lockRef) {
      try {
        await lockRef.remove();
      } catch (lockError) {
        console.error("claimReservationSlot lock cleanup failed:", lockError);
      }
    }
    if (capRef && mode === "parent") {
      try {
        await releaseParentDateCap(db, callerUid, schedule.clinicDate);
      } catch (capError) {
        console.error("claimReservationSlot cap cleanup failed:", capError);
      }
    }
    throw error;
  }
}

module.exports = { claimReservationSlot, MULTI_DATE_CAP };
