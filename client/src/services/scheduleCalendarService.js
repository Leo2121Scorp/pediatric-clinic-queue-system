import { getDb } from "../firebase/database";
import { ref, push, set, get, update, remove } from "firebase/database";
import { subscribeOnValue } from "../firebase/rtdbSubscribe";
import { getBranchConfigurations } from "./branchConfigurationService";
import { getReservationsBySchedule, ACTIVE_RESERVATION_STATUSES } from "./reservationService";
import { createSchedule, publishSchedule, deleteSchedule } from "./scheduleService";
import { logAuditEvent, AUDIT_ACTIONS, AUDIT_CATEGORIES } from "./auditService";
import { recalculateEntireQueue } from "./queueEngine";
import { recalculateRollingValidation } from "./rollingValidationService";
import { branchesMatch } from "../utils/stringUtils";
import { closureReasonLabel } from "../utils/closureReasons";
import {
  manilaDateString,
  manilaNowMinutes,
  manilaWeekdayIndex,
  WEEKDAY_KEYS,
  eachDateInclusive,
  addManilaDays,
  bookingHorizonEnd,
} from "../utils/manilaDate";
import {
  IN_CLINIC_STATUSES,
  CLINIC_CANCELLABLE_STATUSES,
  closureForDate,
  sameBranch,
} from "../utils/scheduleCalendar";

const closuresRef = () => ref(getDb(), "clinicClosures");

// SCHEDULE_AVAILABLE parent broadcast removed (audit M1). Publish stays quiet for parents.

export const subscribeToClinicClosures = (callback) => {
  if (typeof callback !== "function") return () => {};
  return subscribeOnValue(closuresRef(), (snapshot) => {
    if (!snapshot.exists()) {
      callback([]);
      return;
    }
    const data = snapshot.val();
    callback(Object.entries(data).map(([id, value]) => ({ id, ...value })));
  });
};

const loadSchedules = async () => {
  const snapshot = await get(ref(getDb(), "schedules"));
  if (!snapshot.exists()) return [];
  return Object.entries(snapshot.val()).map(([id, value]) => ({ id, ...value }));
};

const branchRecord = (branches, branchId, branchName) =>
  branches.find((branch) => branch.id === branchId || branchesMatch(branch.name, branchName));

const hoursForDate = (branch, dateStr) => {
  const day = branch?.schedule?.[WEEKDAY_KEYS[manilaWeekdayIndex(dateStr)]];
  if (!day?.isOpen || !day.openingTime || !day.closingTime) return null;
  return { openingTime: day.openingTime, closingTime: day.closingTime };
};

const minutesFromTime = (value) => {
  const [hour, minute] = String(value || "").split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
};

export function explainDateSkip({
  dateStr,
  branch,
  branchId,
  branchName,
  schedules,
  closures,
  today = manilaDateString(),
}) {
  const horizon = bookingHorizonEnd(today);
  if (dateStr < today) return "past";
  if (dateStr > horizon) return "beyond the 60-day booking window";
  if (closureForDate(closures, dateStr, branchId, branchName)) return "clinic closed";
  const existing = schedules.find(
    (schedule) => schedule.clinicDate === dateStr && sameBranch(schedule, branchId, branchName)
  );
    if (existing) return "a schedule already exists";
  const hours = hoursForDate(branch, dateStr);
  if (!hours) return "branch closed that weekday";
  if (dateStr === today) {
    const closing = minutesFromTime(hours.closingTime);
    if (closing != null && manilaNowMinutes() >= closing) return "past closing time";
  }
  return null;
}

async function contextForBranch(branchId, branchName) {
  const branches = await getBranchConfigurations();
  const branch = branchRecord(branches, branchId, branchName);
  const schedules = await loadSchedules();
  const closureSnap = await get(closuresRef());
  const closures = closureSnap.exists()
    ? Object.entries(closureSnap.val()).map(([id, value]) => ({ id, ...value }))
    : [];
  return { branch, schedules, closures, branches };
}

export async function previewPublishDates({ branchId, branchName, dates }) {
  const { branch, schedules, closures } = await contextForBranch(branchId, branchName);
  return dates.map((dateStr) => ({
    dateStr,
    skip: explainDateSkip({
      dateStr,
      branch,
      branchId,
      branchName: branch?.name || branchName,
      schedules,
      closures,
    }),
  }));
}

async function resolveDoctor(user) {
  if (user?.role === "doctor") {
    return { doctorId: user.uid, doctorEmail: user.email || "" };
  }
  try {
    const { getActiveDoctor } = await import("./adminService");
    const activeDoctor = await getActiveDoctor();
    if (activeDoctor) {
      return {
        doctorId: activeDoctor.id || activeDoctor.uid,
        doctorEmail: activeDoctor.email || user?.email || "",
      };
    }
  } catch (error) {
    console.warn("Could not resolve active doctor for schedule.", error);
  }
  return { doctorId: user?.uid || null, doctorEmail: user?.email || "" };
}

async function createPublishedDay({ branch, branchId, branchName, dateStr, slotCapacity, user, audit = true }) {
  const hours = hoursForDate(branch, dateStr);
  if (!hours) throw new Error("This branch is closed on that weekday.");
  const doctor = await resolveDoctor(user);
  const scheduleId = await createSchedule({
    ...doctor,
    createdBy: user.uid,
    createdByRole: user.role || "secretary",
    branch: branch?.name || branchName,
    branchId: branch?.id || branchId || null,
    clinicDate: dateStr,
    openingTime: hours.openingTime,
    closingTime: hours.closingTime,
    slotCapacity: Number(slotCapacity),
    status: "draft",
  });
  await publishSchedule(scheduleId, { audit });
  return scheduleId;
}

export async function publishSingleDay({ branchId, branchName, dateStr, slotCapacity, user }) {
  const preview = await previewPublishDates({ branchId, branchName, dates: [dateStr] });
  if (preview[0]?.skip) {
    throw new Error(`Cannot post ${dateStr}: ${preview[0].skip}.`);
  }
  const { branch } = await contextForBranch(branchId, branchName);
  const scheduleId = await createPublishedDay({
    branch,
    branchId,
    branchName,
    dateStr,
    slotCapacity,
    user,
    audit: true,
  });
  return scheduleId;
}

export async function publishDateRange({ branchId, branchName, startDate, endDate, slotCapacity, user }) {
  const dates = eachDateInclusive(startDate, endDate);
  const preview = await previewPublishDates({ branchId, branchName, dates });
  const posting = preview.filter((item) => !item.skip);
  if (posting.length === 0) {
    throw new Error("No days in that range can be posted.");
  }
  const { branch } = await contextForBranch(branchId, branchName);
  for (const item of posting) {
    await createPublishedDay({
      branch,
      branchId,
      branchName,
      dateStr: item.dateStr,
      slotCapacity,
      user,
      audit: false,
    });
  }
  logAuditEvent({
    action: AUDIT_ACTIONS.SCHEDULE_RANGE_PUBLISHED,
    category: AUDIT_CATEGORIES.SCHEDULE_MANAGEMENT,
    description: `Published ${posting.length} day(s) for ${branch?.name || branchName} from ${startDate} to ${endDate}`,
    targetType: "schedule",
    branchId: branch?.id || branchId,
  });
  const posted = posting.map((item) => item.dateStr);
  return { posted, skipped: preview.filter((item) => item.skip) };
}

export async function copyPreviousWeek({ branchId, branchName, weekStart, user }) {
  const sourceStart = addManilaDays(weekStart, -7);
  const { branch, schedules, closures } = await contextForBranch(branchId, branchName);
  const name = branch?.name || branchName;
  const copies = [];
  const skipped = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const sourceDate = addManilaDays(sourceStart, offset);
    const targetDate = addManilaDays(weekStart, offset);
    const source = schedules.find(
      (schedule) =>
        schedule.clinicDate === sourceDate &&
        schedule.status === "published" &&
        sameBranch(schedule, branchId, name)
    );
    if (!source) continue;
    const skip = explainDateSkip({
      dateStr: targetDate,
      branch,
      branchId,
      branchName: name,
      schedules,
      closures,
    });
    if (skip) {
      skipped.push({ dateStr: targetDate, skip });
      continue;
    }
    copies.push({ dateStr: targetDate, slotCapacity: Number(source.slotCapacity || 0) });
  }
  if (copies.length === 0) {
    throw new Error("Nothing from the previous week can be copied onto this week.");
  }
  for (const copy of copies) {
    await createPublishedDay({
      branch,
      branchId,
      branchName: name,
      dateStr: copy.dateStr,
      slotCapacity: copy.slotCapacity,
      user,
      audit: false,
    });
    schedules.push({ clinicDate: copy.dateStr, branchId, branch: name, status: "published" });
  }
  logAuditEvent({
    action: AUDIT_ACTIONS.SCHEDULE_RANGE_PUBLISHED,
    category: AUDIT_CATEGORIES.SCHEDULE_MANAGEMENT,
    description: `Copied ${copies.length} posted day(s) into the week of ${weekStart} for ${name}`,
    targetType: "schedule",
    branchId: branch?.id || branchId,
  });
  return { posted: copies, skipped };
}

const reservationsForSchedule = async (scheduleId) => {
  try {
    return await getReservationsBySchedule(scheduleId);
  } catch (error) {
    console.error(error);
    return [];
  }
};

export async function previewClosure({ branchId, branchName, startDate, endDate, allBranches = false }) {
  const branches = await getBranchConfigurations();
  const targets = allBranches
    ? branches
    : [branchRecord(branches, branchId, branchName)].filter(Boolean);
  const schedules = await loadSchedules();
  const closureSnap = await get(closuresRef());
  const closures = closureSnap.exists()
    ? Object.entries(closureSnap.val()).map(([id, value]) => ({ id, ...value }))
    : [];
  const dates = eachDateInclusive(startDate, endDate);
  const blocking = [];
  const cancellable = [];
  const overlaps = [];

  for (const branch of targets) {
    for (const dateStr of dates) {
      const overlap = closureForDate(closures, dateStr, branch.id, branch.name);
      if (overlap) overlaps.push({ dateStr, branch: branch.name });
      const schedule = schedules.find(
        (item) => item.clinicDate === dateStr && sameBranch(item, branch.id, branch.name)
      );
      if (!schedule) continue;
      const reservations = await reservationsForSchedule(schedule.id);
      reservations.forEach((reservation) => {
        if (IN_CLINIC_STATUSES.includes(reservation.status)) {
          blocking.push(reservation);
        } else if (CLINIC_CANCELLABLE_STATUSES.includes(reservation.status) || ACTIVE_RESERVATION_STATUSES.includes(reservation.status) && !IN_CLINIC_STATUSES.includes(reservation.status)) {
          if (CLINIC_CANCELLABLE_STATUSES.includes(reservation.status)) cancellable.push(reservation);
        }
      });
    }
  }

  return {
    targets,
    dates,
    blocking,
    cancellable,
    overlaps,
  };
}

async function cancelWaitingReservations(schedule, closureId, reasonLabel) {
  const reservations = await reservationsForSchedule(schedule.id);
  const waiting = reservations.filter((reservation) =>
    CLINIC_CANCELLABLE_STATUSES.includes(reservation.status)
  );
  const updates = {};
  waiting.forEach((reservation) => {
    updates[`reservations/${reservation.id}/status`] = "cancelled_by_clinic";
    updates[`reservations/${reservation.id}/cancelledAt`] = Date.now();
    updates[`reservations/${reservation.id}/cancellationReason`] = reasonLabel;
    updates[`reservations/${reservation.id}/closureId`] = closureId;
    if (schedule.clinicDate) {
      updates[`reservations/${reservation.id}/clinicDate`] = schedule.clinicDate;
    }
  });
  if (Object.keys(updates).length > 0) {
    await update(ref(getDb()), updates);
    await recalculateRollingValidation(schedule.id);
    await recalculateEntireQueue(schedule.id);
  }
  return waiting.length;
}

export async function applyClosure({
  branchId,
  branchName,
  startDate,
  endDate,
  reason,
  note,
  user,
  allBranches = false,
}) {
  const preview = await previewClosure({ branchId, branchName, startDate, endDate, allBranches });
  if (preview.targets.length === 0) throw new Error("Branch not found.");
  if (preview.overlaps.length > 0) {
    throw new Error("That range overlaps a closure that is already posted. Remove it first.");
  }
  if (preview.blocking.length > 0) {
    throw new Error("Finish or forfeit patients who are already in the clinic before closing these days.");
  }

  const reasonLabel = closureReasonLabel(reason);
  const schedules = await loadSchedules();
  let cancelled = 0;

  for (const branch of preview.targets) {
    const closureRef = push(closuresRef());
    await set(closureRef, {
      branch: branch.name,
      branchId: branch.id,
      startDate,
      endDate,
      reason,
      note: String(note || "").trim(),
      createdBy: user?.uid || null,
      createdAt: Date.now(),
    });

    let cancelledHere = 0;
    for (const dateStr of preview.dates) {
      const schedule = schedules.find(
        (item) => item.clinicDate === dateStr && sameBranch(item, branch.id, branch.name)
      );
      if (!schedule) continue;
      const reservations = await reservationsForSchedule(schedule.id);
      const hasReservations = reservations.length > 0;
      if (schedule.status === "draft" && !hasReservations) {
        await deleteSchedule(schedule.id);
        continue;
      }
      await update(ref(getDb(), `schedules/${schedule.id}`), {
        dayClosed: true,
        closureId: closureRef.key,
        closureReason: reason,
        closureNote: String(note || "").trim(),
      });
      cancelledHere += await cancelWaitingReservations(
        { ...schedule, clinicDate: dateStr },
        closureRef.key,
        reasonLabel
      );
    }
    cancelled += cancelledHere;

    logAuditEvent({
      action: AUDIT_ACTIONS.CLINIC_DAY_CLOSED,
      category: AUDIT_CATEGORIES.SCHEDULE_MANAGEMENT,
      description: `Closed ${branch.name} from ${startDate} to ${endDate} (${reasonLabel}). Cancelled ${cancelledHere} reservation(s).`,
      targetType: "clinicClosure",
      targetId: closureRef.key,
      branchId: branch.id,
    });
  }

  return { cancelled, branches: preview.targets.length };
}

export async function removeClosure(closureId) {
  const snapshot = await get(ref(getDb(), `clinicClosures/${closureId}`));
  if (!snapshot.exists()) throw new Error("Closure not found.");
  const closure = snapshot.val();
  const today = manilaDateString();
  if (closure.startDate <= today) {
    throw new Error("Only a future closure can be removed.");
  }

  const reservationSnap = await get(ref(getDb(), "reservations"));
  if (reservationSnap.exists()) {
    const cancelled = Object.values(reservationSnap.val()).some(
      (reservation) => reservation.closureId === closureId && reservation.status === "cancelled_by_clinic"
    );
    if (cancelled) {
      throw new Error("This closure already cancelled reservations, so it stays on record.");
    }
  }

  const schedules = await loadSchedules();
  const updates = {};
  schedules.forEach((schedule) => {
    if (schedule.closureId === closureId) {
      updates[`schedules/${schedule.id}/dayClosed`] = false;
      updates[`schedules/${schedule.id}/closureId`] = null;
      updates[`schedules/${schedule.id}/closureReason`] = null;
      updates[`schedules/${schedule.id}/closureNote`] = null;
    }
  });
  if (Object.keys(updates).length > 0) {
    await update(ref(getDb()), updates);
  }
  await remove(ref(getDb(), `clinicClosures/${closureId}`));
  logAuditEvent({
    action: AUDIT_ACTIONS.CLINIC_CLOSURE_REMOVED,
    category: AUDIT_CATEGORIES.SCHEDULE_MANAGEMENT,
    description: `Removed a future closure for ${closure.branch} (${closure.startDate} to ${closure.endDate})`,
    targetType: "clinicClosure",
    targetId: closureId,
    branchId: closure.branchId,
  });
}
