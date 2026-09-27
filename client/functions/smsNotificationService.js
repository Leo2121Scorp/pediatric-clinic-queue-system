/**
 * Queue SMS copy + dispatch claims (Cloud Functions mirror).
 */

const { sendSms, normalizePhoneE164 } = require("./smsService");
const { getRtdb, isSmsSuppressed } = require("./rtdbRouter");

const SMS_NOTIFICATION_EVENTS = new Set([
  "SLOT_RESERVED",
  "QUEUE_STARTED",
  "NEARING_TURN",
  "PENALIZED",
  "FORFEITED",
  "RESERVATION_CANCELLED_BY_CLINIC",
]);

const MIN_NEARING_TURN_AHEAD = 1;
const MAX_NEARING_TURN_AHEAD = 10;
const DEFAULT_NEARING_TURN_AHEAD = 3;
const MAX_SMS_TEMPLATE_LENGTH = 320;

const ALLOWED_PLACEHOLDERS = new Set([
  "count",
  "queueNumber",
  "queuePosition",
  "minutes",
  "branch",
  "date",
  "timeRange",
  "doctor",
  "reason",
]);

/** Previous merged Queue Started template — migrate RTDB copies back to the simple default. */
const LEGACY_MERGED_QUEUE_STARTED_TEMPLATE =
  "Hello! The queue at {branch} for {date} has officially started. " +
  "Please monitor your place in line and be ready when we notify you that your turn is near. " +
  "Here's your Reservation details:\n" +
  "Date: {date}\n" +
  "Queue Number: {queueNumber}";

const LEGACY_CLINIC_CANCELLED_TEMPLATE =
  "The clinic at {branch} is closed on {date} ({reason}). Your reservation was cancelled. Please book another posted day.";

const DEFAULT_SMS_TEMPLATES = {
  templateSlotReserved:
    "Your clinic reservation is confirmed.\n" +
    "Date: {date}\n" +
    "Time: {timeRange}\n" +
    "Queue Number: {queueNumber}\n" +
    "Doctor: {doctor}\n" +
    "Branch: {branch}\n" +
    "Please keep this message for your visit. Thank you.",
  templateQueueStarted:
    "The queue at {branch} for {date} has started. " +
    "Please monitor your place in line and be ready when we notify you that your turn is near.",
  templateNearingTurn:
    "Only {count} patients ahead (Queue #{queueNumber}). Please head to the clinic now.",
  templateSlotReservedActiveQueue:
    "You reserved a slot on an active Queue. Queue Number: {queueNumber}. Queue Position: {queuePosition}. Please monitor your queue.",
  templatePenalized:
    "You were marked late and moved back in line (Queue #{queueNumber}, position {queuePosition}). Please validate your QR at {branch} within {minutes} minutes or this reservation will be forfeited.",
  templateForfeited:
    "Your reservation (Queue #{queueNumber}) at {branch} on {date} was forfeited because you did not check in on time. You may still book a new slot on the same schedule if slots are available.",
  templateClinicCancelled:
    "The clinic at {branch} is closed on {date} ({reason}). Your reservation was cancelled. It does not count as a no-show. Book another open day when you are ready.",
};

function db() {
  return getRtdb();
}

function sanitizeKey(value) {
  return String(value || "").replace(/[.#$\[\]]/g, "_");
}

function formatClinicDate(clinicDate) {
  if (!clinicDate) return "your clinic date";
  try {
    return new Date(`${clinicDate}T00:00:00`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return clinicDate;
  }
}

function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  const mins = Number.isNaN(m) ? "00" : String(m).padStart(2, "0");
  return `${hour12}:${mins} ${period}`;
}

function sanitizeTemplate(value, fallback) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.length > MAX_SMS_TEMPLATE_LENGTH) return fallback;
  const matches = trimmed.matchAll(/\{([a-zA-Z]+)\}/g);
  for (const match of matches) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) return fallback;
  }
  return trimmed;
}

function sanitizeAheadCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_NEARING_TURN_AHEAD;
  if (parsed < MIN_NEARING_TURN_AHEAD || parsed > MAX_NEARING_TURN_AHEAD) {
    return DEFAULT_NEARING_TURN_AHEAD;
  }
  return parsed;
}

function parseSmsConfig(data) {
  const storedQueueStarted = String(data?.templateQueueStarted || "").trim();
  const queueStartedSource =
    !storedQueueStarted || storedQueueStarted === LEGACY_MERGED_QUEUE_STARTED_TEMPLATE
      ? DEFAULT_SMS_TEMPLATES.templateQueueStarted
      : storedQueueStarted;

  return {
    nearingTurnAheadCount: sanitizeAheadCount(
      data?.nearingTurnAheadCount ?? DEFAULT_NEARING_TURN_AHEAD
    ),
    templateSlotReserved: sanitizeTemplate(
      data?.templateSlotReserved,
      DEFAULT_SMS_TEMPLATES.templateSlotReserved
    ),
    templateQueueStarted: sanitizeTemplate(
      queueStartedSource,
      DEFAULT_SMS_TEMPLATES.templateQueueStarted
    ),
    templateNearingTurn: sanitizeTemplate(
      data?.templateNearingTurn,
      DEFAULT_SMS_TEMPLATES.templateNearingTurn
    ),
    templateSlotReservedActiveQueue: sanitizeTemplate(
      data?.templateSlotReservedActiveQueue,
      DEFAULT_SMS_TEMPLATES.templateSlotReservedActiveQueue
    ),
    templatePenalized: sanitizeTemplate(
      data?.templatePenalized,
      DEFAULT_SMS_TEMPLATES.templatePenalized
    ),
    templateForfeited: sanitizeTemplate(
      data?.templateForfeited,
      DEFAULT_SMS_TEMPLATES.templateForfeited
    ),
    templateClinicCancelled: sanitizeTemplate(
      String(data?.templateClinicCancelled || "").trim() === LEGACY_CLINIC_CANCELLED_TEMPLATE
        ? DEFAULT_SMS_TEMPLATES.templateClinicCancelled
        : data?.templateClinicCancelled,
      DEFAULT_SMS_TEMPLATES.templateClinicCancelled
    ),
  };
}

const LEGACY_GLOBAL_KEYS = new Set(["queue", "sms"]);

function normalizeBranchName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+branch$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function resolveConfigBranchId(branchIdOrName) {
  if (!branchIdOrName || LEGACY_GLOBAL_KEYS.has(branchIdOrName)) return null;
  try {
    const byId = await db().ref(`branchConfigurations/${branchIdOrName}`).once("value");
    if (byId.exists()) return branchIdOrName;
    const all = await db().ref("branchConfigurations").once("value");
    if (!all.exists()) return null;
    const needle = normalizeBranchName(branchIdOrName);
    for (const [id, value] of Object.entries(all.val() || {})) {
      if (id === branchIdOrName || normalizeBranchName(value?.name) === needle) {
        return id;
      }
    }
  } catch (err) {
    console.error("[functions/sms] failed to resolve branch id:", err.message);
  }
  return null;
}

async function getLegacySmsConfiguration() {
  const snap = await db().ref("systemConfiguration/sms").once("value");
  return parseSmsConfig(snap.exists() ? snap.val() : null);
}

async function getSmsConfiguration(branchIdOrName) {
  try {
    const branchId = await resolveConfigBranchId(branchIdOrName);
    if (!branchId) {
      return getLegacySmsConfiguration();
    }

    const snap = await db().ref(`systemConfiguration/${branchId}/sms`).once("value");
    if (snap.exists()) {
      return parseSmsConfig(snap.val());
    }

    const parsed = await getLegacySmsConfiguration();
    try {
      await db().ref(`systemConfiguration/${branchId}/sms`).update({
        ...parsed,
        updatedAt: Date.now(),
      });
    } catch (seedErr) {
      console.error("[functions/sms] failed to seed branch SMS config:", seedErr.message);
    }
    return parsed;
  } catch (err) {
    console.error("[functions/sms] failed to load SMS configuration:", err.message);
    return parseSmsConfig(null);
  }
}

function applySmsTemplate(template, vars = {}) {
  return String(template || "").replace(/\{([a-zA-Z]+)\}/g, (full, key) => {
    if (!ALLOWED_PLACEHOLDERS.has(key)) return full;
    const value = vars[key];
    if (value === null || value === undefined || value === "") return "";
    return String(value);
  });
}

function buildNearingTurnPushMessage(count = DEFAULT_NEARING_TURN_AHEAD) {
  const safeCount = sanitizeAheadCount(count);
  return `There are only ${safeCount} patients ahead of you. Please proceed to the clinic.`;
}

async function getParentPhone(parentId) {
  if (!parentId) return "";
  const snap = await db().ref(`users/${parentId}`).once("value");
  if (!snap.exists()) return "";
  const user = snap.val() || {};
  return normalizePhoneE164(user.phone || user.phoneNumber || "");
}

async function resolveDoctorName(doctorId) {
  if (!doctorId) return "your doctor";
  const snap = await db().ref(`users/${doctorId}`).once("value");
  if (!snap.exists()) return "your doctor";
  const doc = snap.val() || {};
  const title = doc.professionalTitle || "Dr.";
  const name = doc.name || "Doctor";
  if (String(name).toLowerCase().startsWith("dr")) return name;
  return `${title} ${name}`.replace(/\s+/g, " ").trim();
}

async function buildTemplateVars(eventId, context = {}, config) {
  const branch = context.branchName || context.branchId || "the clinic";
  const dateLabel = formatClinicDate(context.clinicDate);
  const open = formatTime(context.openingTime);
  const close = formatTime(context.closingTime);
  const timeRange = open && close ? `${open} – ${close}` : open || "clinic hours";
  const doctorName =
    context.doctorName || (await resolveDoctorName(context.doctorId)) || "your doctor";
  const queueNumber =
    context.queueNumber != null && context.queueNumber !== ""
      ? context.queueNumber
      : "—";
  const queuePosition =
    context.queuePosition != null && context.queuePosition !== ""
      ? context.queuePosition
      : queueNumber;
  const minutes =
    context.minutes != null && context.minutes !== "" ? context.minutes : "15";
  const count =
    context.nearingTurnAheadCount != null
      ? sanitizeAheadCount(context.nearingTurnAheadCount)
      : config.nearingTurnAheadCount;

  return {
    count,
    queueNumber,
    queuePosition,
    minutes,
    branch: eventId === "SLOT_RESERVED" ? branch.replace(/^the /, "") || "clinic" : branch,
    date: dateLabel,
    timeRange,
    doctor: doctorName,
    reason: context.reason || "Closed",
  };
}

async function buildSmsMessage(eventId, context = {}) {
  const config = await getSmsConfiguration(context.configBranchId || context.branchId);
  const vars = await buildTemplateVars(eventId, context, config);

  let template = null;
  const liveQueue = ["active", "paused", "closed"].includes(context.queueStatus);
  if (eventId === "QUEUE_STARTED") {
    template = config.templateQueueStarted;
  } else if (eventId === "NEARING_TURN") {
    template = config.templateNearingTurn;
  } else if (eventId === "SLOT_RESERVED") {
    template = liveQueue
      ? config.templateSlotReservedActiveQueue
      : config.templateSlotReserved;
  } else if (eventId === "PENALIZED") {
    template = config.templatePenalized;
  } else if (eventId === "FORFEITED") {
    template = config.templateForfeited;
  } else if (eventId === "RESERVATION_CANCELLED_BY_CLINIC") {
    template = config.templateClinicCancelled;
  } else {
    return context.customMessage || null;
  }

  const message = applySmsTemplate(template, vars).trim();
  return message || null;
}

async function claimTransactionValue(flagRef, value) {
  const result = await flagRef.transaction((current) => {
    if (current) return;
    return value;
  });
  return Boolean(result.committed && result.snapshot.val() === value);
}

async function claimSmsDispatch(parentId, notificationId) {
  if (!parentId || !notificationId) return false;
  const token = Date.now();
  const flagRef = db().ref(`notifications/${parentId}/${notificationId}/smsDispatchedAt`);
  const result = await flagRef.transaction((current) => {
    if (current) return;
    return token;
  });
  return Boolean(result.committed && Number(result.snapshot.val()) === token);
}

/**
 * Claim Near Turn SMS once per reservation ticket. Aborts if already set.
 * Returns true only when this caller won the write.
 */
async function claimNearTurnSms(reservationId) {
  if (!reservationId) return false;
  return claimTransactionValue(db().ref(`reservations/${reservationId}/nearTurnSmsSent`), true);
}

/** Confirmed-reservation SMS once per ticket. */
async function claimSlotReservedSms(reservationId) {
  if (!reservationId) return false;
  return claimTransactionValue(db().ref(`reservations/${reservationId}/slotReservedSmsSent`), true);
}

/** Late/moved SMS once per penalty increment. */
async function claimPenalizedSms(reservationId, penaltyCount) {
  const count = Number(penaltyCount);
  if (!reservationId || !Number.isInteger(count) || count < 1) return false;
  return claimTransactionValue(db().ref(`reservations/${reservationId}/penaltySmsSent/${count}`), true);
}

async function deliverSmsForNotification(eventId, context = {}, notificationId) {
  if (isSmsSuppressed()) {
    return { success: true, skipped: true, reason: "demo_database" };
  }
  if (!SMS_NOTIFICATION_EVENTS.has(eventId)) {
    return { success: false, skipped: true, reason: "not_sms_event" };
  }

  const phone = context.phone || (await getParentPhone(context.parentId));
  if (!phone) return { success: false, skipped: true, reason: "no_phone" };

  const message = await buildSmsMessage(eventId, context);
  if (!message) return { success: false, skipped: true, reason: "no_message" };

  if (eventId === "SLOT_RESERVED") {
    const claimed = await claimSlotReservedSms(context.reservationId);
    if (!claimed) return { success: true, skipped: true, reason: "already_dispatched" };
  } else if (eventId === "PENALIZED") {
    const claimed = await claimPenalizedSms(context.reservationId, context.penaltyCount);
    if (!claimed) return { success: true, skipped: true, reason: "already_dispatched" };
  }

  const safeId = notificationId ? sanitizeKey(notificationId) : null;
  if (safeId && context.parentId) {
    const claimed = await claimSmsDispatch(context.parentId, safeId);
    if (!claimed) return { success: true, skipped: true, reason: "already_dispatched" };
  }

  const sendResult = await sendSms(phone, message);
  if (!sendResult?.success) {
    console.error(
      `[functions/sms] ${eventId} send failed:`,
      sendResult?.reason || "unknown",
      sendResult?.status || "",
      sendResult?.data?.error || sendResult?.data?.code || ""
    );
    if (eventId === "SLOT_RESERVED" && context.reservationId) {
      try {
        await db().ref(`reservations/${context.reservationId}/slotReservedSmsSent`).remove();
        if (safeId && context.parentId) {
          await db().ref(`notifications/${context.parentId}/${safeId}/smsDispatchedAt`).remove();
        }
        console.error(`[functions/sms] SLOT_RESERVED claim released after send failure reservationId=${context.reservationId}`);
      } catch (releaseErr) {
        console.error("[functions/sms] failed to release SLOT_RESERVED claim:", releaseErr.message);
      }
    }
  } else {
    console.log(`[functions/sms] ${eventId} accepted by textbee`);
  }
  return sendResult;
}

async function enrichSmsContext(eventId, context = {}) {
  const enriched = { ...context };
  const scheduleId = context.scheduleId || context.entityId;
  if (!scheduleId && !context.reservationId) return enriched;

  if (scheduleId && (!enriched.clinicDate || !enriched.openingTime || !enriched.doctorId || !enriched.queueStatus)) {
    const snap = await db().ref(`schedules/${scheduleId}`).once("value");
    if (snap.exists()) {
      const schedule = snap.val() || {};
      enriched.clinicDate = enriched.clinicDate || schedule.clinicDate;
      enriched.openingTime = enriched.openingTime || schedule.openingTime;
      enriched.closingTime = enriched.closingTime || schedule.closingTime;
      enriched.doctorId = enriched.doctorId || schedule.doctorId;
      enriched.branchName = enriched.branchName || schedule.branch;
      enriched.configBranchId = enriched.configBranchId || schedule.branchId || null;
      enriched.branchId = schedule.branchId || enriched.branchId || schedule.branch;
      enriched.queueStatus = enriched.queueStatus || schedule.queueStatus;
    }
  }

  if (eventId === "SLOT_RESERVED" && !enriched.doctorName) {
    enriched.doctorName = await resolveDoctorName(enriched.doctorId);
  }

  if (context.reservationId) {
    const resSnap = await db().ref(`reservations/${context.reservationId}`).once("value");
    if (resSnap.exists()) {
      const reservation = resSnap.val() || {};
      if (enriched.queueNumber == null || enriched.queueNumber === "") {
        enriched.queueNumber =
          reservation.queueNumber ?? reservation.originalQueueNumber ?? reservation.queuePosition;
      }
      if (enriched.queuePosition == null || enriched.queuePosition === "") {
        enriched.queuePosition = reservation.queueOrder ?? reservation.queuePosition ?? enriched.queueNumber;
      }
      if (enriched.minutes == null && reservation.penaltyTimerExpiresAt) {
        const remainingMs = Number(reservation.penaltyTimerExpiresAt) - Date.now();
        enriched.minutes = Math.max(1, Math.ceil(remainingMs / 60000));
      }
      if (enriched.penaltyCount == null && reservation.penaltyCount != null) {
        enriched.penaltyCount = reservation.penaltyCount;
      }
    }
  }

  return enriched;
}

const SKIP_WALK_IN_SMS_QUEUE_STATUSES = ["closed", "completed", "ended"];

/**
 * One-shot confirmed-reservation SMS for phone-in walk-ins.
 * Walk-in `parentPhone` is used only at creation. Never used for Queue Started,
 * Near Turn, Penalized, or Forfeited broadcasts (those require parentId).
 * Upcoming queues use templateSlotReserved; active/paused reuse the parent
 * live-queue template via buildSmsMessage (templateSlotReservedActiveQueue).
 */
async function deliverWalkInReservationSms(reservation) {
  if (isSmsSuppressed()) {
    return { success: true, skipped: true, reason: "demo_database" };
  }
  if (!reservation || reservation.source !== "walk_in" || reservation.parentId) {
    return { success: false, skipped: true, reason: "not_walk_in" };
  }
  const phone = normalizePhoneE164(reservation.parentPhone || "");
  if (!phone) {
    return { success: false, skipped: true, reason: "no_phone" };
  }
  if (!reservation.scheduleId) {
    return { success: false, skipped: true, reason: "no_schedule" };
  }

  const snap = await db().ref(`schedules/${reservation.scheduleId}`).once("value");
  if (!snap.exists()) {
    return { success: false, skipped: true, reason: "schedule_missing" };
  }
  const schedule = snap.val() || {};
  const queueStatus = schedule.queueStatus || "not_started";
  if (SKIP_WALK_IN_SMS_QUEUE_STATUSES.includes(queueStatus)) {
    return { success: false, skipped: true, reason: "queue_closed" };
  }

  const smsContext = await enrichSmsContext("SLOT_RESERVED", {
    phone,
    reservationId: reservation.id,
    scheduleId: reservation.scheduleId,
    queueNumber: reservation.queueNumber ?? reservation.originalQueueNumber ?? reservation.queuePosition,
    queuePosition: reservation.queueOrder ?? reservation.queuePosition,
    branchId: reservation.branchId || reservation.branch || schedule.branchId || schedule.branch,
    queueStatus,
  });
  smsContext.phone = phone;
  smsContext.queueStatus = queueStatus;

  return deliverSmsForNotification("SLOT_RESERVED", smsContext);
}

function computeAheadOfYouForSms(reservation, allReservations = []) {
  if (!reservation) return 0;
  if (
    ["with_doctor", "in_consultation", "completed", "consultation_completed", "cancelled", "forfeited"].includes(
      reservation.status
    )
  ) {
    return 0;
  }
  const activePipeline = allReservations
    .filter(
      (item) =>
        item.scheduleId === reservation.scheduleId &&
        [
          "reserved",
          "waiting",
          "validation_open",
          "waiting_for_window",
          "checked_in",
          "with_doctor",
          "in_consultation",
        ].includes(item.status)
    )
    .sort((a, b) => (a.sortTimestamp || a.createdAt || 0) - (b.sortTimestamp || b.createdAt || 0));
  const index = activePipeline.findIndex((item) => item.id === reservation.id);
  return index > 0 ? index : 0;
}

module.exports = {
  SMS_NOTIFICATION_EVENTS,
  DEFAULT_NEARING_TURN_AHEAD,
  deliverSmsForNotification,
  deliverWalkInReservationSms,
  enrichSmsContext,
  buildSmsMessage,
  getSmsConfiguration,
  buildNearingTurnPushMessage,
  computeAheadOfYouForSms,
  claimNearTurnSms,
  claimSlotReservedSms,
  claimPenalizedSms,
};
