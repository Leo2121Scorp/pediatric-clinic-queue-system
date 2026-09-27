import { getDb } from "../firebase/database";
import { ref, push, set, get, update, remove, serverTimestamp, query, orderByChild, equalTo } from "firebase/database";
import { subscribeOnValue } from "../firebase/rtdbSubscribe";
import { getReservationsBySchedule } from "./reservationService";
import { recalculateRollingValidation } from "./rollingValidationService";
import { recalculateEntireQueue } from "./queueEngine";
import { validateScheduleClosingTime } from "./branchConfigurationService";
import { logAuditEvent, AUDIT_ACTIONS, AUDIT_CATEGORIES } from "./auditService";
import { branchesMatch } from "../utils/stringUtils";
import { isLiveQueueStatus } from "../utils/penaltyTimer";

export { validateScheduleClosingTime };

// check muna if hindi pa past closing time ng branch for today before creating
export const createSchedule = async ( scheduleData ) => {
  const timeValidation = await validateScheduleClosingTime(scheduleData.branch, scheduleData.clinicDate);
  if (!timeValidation.valid) {
    throw new Error(timeValidation.message);
  }

  const scheduleRef = push(ref(getDb(), "schedules"));
  const payload = { ...scheduleData };
  delete payload.lateLimit;

  await set(scheduleRef, payload);

  return scheduleRef.key;
};

export const getSchedules = async () => {
  const snapshot = await get(
    ref(getDb(), "schedules")
  );

  if (snapshot.exists()) {
    return snapshot.val();
  }

  return {};
};

export const getScheduleById = async (scheduleId) => {
  const snapshot = await get(ref(getDb(), `schedules/${scheduleId}`));
  if (snapshot.exists()) {
    return { id: snapshot.key, ...snapshot.val() };
  }
  return null;
};

export const scheduleExists = async ( branch, clinicDate ) => {
  const snapshot = await get( ref(getDb(), "schedules") );

  if (!snapshot.exists()) { return false; }

  const schedules = snapshot.val();

  return Object.values(schedules).some( (schedule) => branchesMatch(schedule.branch, branch) && schedule.clinicDate === clinicDate);
};

// check closing time before updating draft schedule or publishing
export const updateSchedule = async ( scheduleId, updatedData ) => {
  const snapshot = await get(ref(getDb(), `schedules/${scheduleId}`));
  if (snapshot.exists()) {
    const currentSchedule = snapshot.val();
    if (currentSchedule.status === "published") {
      delete updatedData.branch;
      delete updatedData.branchId;
      delete updatedData.clinicDate;
    } else {
      const branch = updatedData.branch || currentSchedule.branch;
      const clinicDate = updatedData.clinicDate || currentSchedule.clinicDate;
      const timeValidation = await validateScheduleClosingTime(branch, clinicDate);
      if (!timeValidation.valid) {
        throw new Error(timeValidation.message);
      }
    }
  }
  const payload = { ...updatedData };
  delete payload.lateLimit;
  await update(ref(getDb(),`schedules/${scheduleId}`), payload);
};

export const deleteSchedule = async (scheduleId) => {
  const snapshot = await get(ref(getDb(), `schedules/${scheduleId}`));
  if (snapshot.exists()) {
    const schedule = snapshot.val();
    if (schedule.dayClosed) {
      throw new Error("A closed clinic day is kept on record.");
    }
    if (schedule.status === "published" || schedule.status === "completed") {
      const reservations = await getReservationsBySchedule(scheduleId);
      if (reservations.length > 0) {
        throw new Error("This schedule has reservations and cannot be deleted.");
      }
    }
  }
  await remove(ref(getDb(), `schedules/${scheduleId}`));
};

export const publishSchedule = async (scheduleId, options = {}) => {
  let currentSchedule = null;
  const snapshot = await get(ref(getDb(), `schedules/${scheduleId}`));
  if (snapshot.exists()) {
    currentSchedule = snapshot.val();
    const timeValidation = await validateScheduleClosingTime(currentSchedule.branch, currentSchedule.clinicDate);
    if (!timeValidation.valid) {
      throw new Error(timeValidation.message);
    }
  }
  await update( ref(getDb(), `schedules/${scheduleId}`), {
    status: "published", 
    queueStatus: "not_started", // Default queue status when published
    queueStartedAt: null,
    isReady: false,
    publishedAt: Date.now(),
  });

  if (currentSchedule && options.audit !== false) {
    logAuditEvent({
      action: AUDIT_ACTIONS.SCHEDULE_PUBLISHED,
      category: AUDIT_CATEGORIES.SCHEDULE_MANAGEMENT,
      description: `Published schedule for ${currentSchedule.branch} on ${currentSchedule.clinicDate}`,
      targetType: "schedule",
      targetId: scheduleId,
      branchId: currentSchedule.branch
    });
  }
};

export const moveToReady = async ( scheduleId ) => {
  await update( ref(getDb(), `schedules/${scheduleId}`), {
    isReady: true,
    movedToReadyAt: Date.now(),
  });
};

export const updateQueueStatus = async (scheduleId, queueStatus) => {
  const updates = {
    queueStatus,
    [`queueStatusUpdatedAt`]: Date.now()
  };
  
  const snap = await get(ref(getDb(), `schedules/${scheduleId}`));
  let isFirstStart = false;
  let scheduleData = null;

  if (snap.exists()) {
    scheduleData = snap.val();
    if (scheduleData.dayClosed) {
      throw new Error("Cannot change queue status on a closed clinic day.");
    }
    if (queueStatus === "active" && !scheduleData.queueStartedAt) {
      updates.queueStartedAt = serverTimestamp();
      isFirstStart = true;
    }
  } else {
    throw new Error("Schedule not found.");
  }

  await update(ref(getDb(), `schedules/${scheduleId}`), updates);

  if (queueStatus === "active") {
    await recalculateRollingValidation(scheduleId);
  }

  // Stamp becameCurrentTurnAt on the first penalize target once the queue is live.
  // Without this, Penalize stays disabled forever for patients already waiting at start.
  if (isLiveQueueStatus(queueStatus)) {
    await recalculateEntireQueue(scheduleId);
  }

  // Audit Logs
  if (scheduleData) {
    let action = null;
    let description = "";

    if (queueStatus === "active") {
      action = isFirstStart ? AUDIT_ACTIONS.QUEUE_STARTED : AUDIT_ACTIONS.QUEUE_RESUMED;
      description = isFirstStart ? "Started the clinic queue" : "Resumed the clinic queue";
    } else if (queueStatus === "paused") {
      action = AUDIT_ACTIONS.QUEUE_PAUSED;
      description = "Paused the clinic queue";
    } else if (queueStatus === "closed") {
      action = AUDIT_ACTIONS.QUEUE_CLOSED;
      description = "Closed the clinic queue";
    }

    if (action) {
      logAuditEvent({
        action,
        category: AUDIT_CATEGORIES.QUEUE_OPERATIONS,
        description,
        targetType: "schedule",
        targetId: scheduleId,
        branchId: scheduleData.branch
      });
    }
  }
};

export const completeSchedule = async ( scheduleId ) => {
  const now = Date.now();
  await update( ref(getDb(), `schedules/${scheduleId}`), {
    status: "completed", 
    queueStatus: "completed",
    completedAt: now,
    scheduleCompletedAt: now
  });

  const reservations = await getReservationsBySchedule(scheduleId);
  const updates = {};
  const finalStatuses = ["cancelled", "cancelled_by_clinic", "completed", "consultation_completed", "forfeited", "penalized", "late_limit_reached", "expired", "validation_expired"];
  reservations.forEach(res => {
    if (!finalStatuses.includes(res.status)) {
      updates[`reservations/${res.id}/status`] = "completed";
      updates[`reservations/${res.id}/completedAt`] = now;
    }
  });

  if (Object.keys(updates).length > 0) {
    await update(ref(getDb()), updates);
  }

  // Audit Log
  const snap = await get(ref(getDb(), `schedules/${scheduleId}`));
  const branch = snap.exists() ? snap.val().branch : null;

  logAuditEvent({
    action: AUDIT_ACTIONS.SCHEDULE_COMPLETED,
    category: AUDIT_CATEGORIES.SCHEDULE_MANAGEMENT,
    description: `Completed schedule`,
    targetType: "schedule",
    targetId: scheduleId,
    branchId: branch
  });
};

export const subscribeToPublishedSchedules = ( callback ) => {
  if (typeof callback !== "function") return () => {};
  const q = query(
    ref(getDb(), "schedules"),
    orderByChild("status"),
    equalTo("published")
  );
  return subscribeOnValue(q, (snapshot) => {
      if (!snapshot.exists()) {
        callback([]);
        return;
      }

      const data = snapshot.val();

      const schedules = Object.entries(data).map(([id, value]) => ({ id, ...value,}));
      callback(schedules);
    }
  );
};

export const subscribeToAllSchedules = (callback) => {
  if (typeof callback !== "function") return () => {};
  const schedulesRef = ref(getDb(), "schedules");
  return subscribeOnValue(schedulesRef, (snapshot) => {
    if (!snapshot.exists()) {
      callback({});
      return;
    }
    callback(snapshot.val());
  });
};