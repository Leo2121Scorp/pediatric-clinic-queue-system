import { getDb } from "../firebase/database";
import { ref, get, onValue, update } from "firebase/database";
import { logAuditEvent, AUDIT_ACTIONS, AUDIT_CATEGORIES } from "./auditService";
import { branchesMatch } from "../utils/stringUtils";
import { isPermissionDenied, noopUnsub, safeUnsub, subscribeOnValue } from "../firebase/rtdbSubscribe";

const MAX_PENALTY_MOVE_BACK = 10;
const MIN_PENALTY_MOVE_BACK = 0;
const DEFAULT_PENALTY_MOVE_BACK = 2;

export const MIN_PENALTY_TIMER_MINUTES = 5;
export const MAX_PENALTY_TIMER_MINUTES = 30;
export const DEFAULT_PENALTY_TIMER_MINUTES = 15;

export const MIN_PENALTY_GRACE_MINUTES = 0;
export const MAX_PENALTY_GRACE_MINUTES = 5;
export const DEFAULT_PENALTY_GRACE_MINUTES = 2;

export const DEFAULT_SLOT_CAPACITY = 30;
export const MIN_SLOT_CAPACITY = 1;
export const MAX_SLOT_CAPACITY = 200;

export const MIN_NEARING_TURN_AHEAD = 1;
export const MAX_NEARING_TURN_AHEAD = 10;
export const DEFAULT_NEARING_TURN_AHEAD = 3;
export const MAX_SMS_TEMPLATE_LENGTH = 320;

const LEGACY_GLOBAL_KEYS = new Set(["queue", "sms"]);

export const SMS_TEMPLATE_PLACEHOLDERS = [
  "count",
  "queueNumber",
  "queuePosition",
  "minutes",
  "branch",
  "date",
  "timeRange",
  "doctor",
  "reason",
];

export const DEFAULT_SMS_TEMPLATES = {
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

/** Previous merged Queue Started template — migrate RTDB copies back to the simple default. */
const LEGACY_MERGED_QUEUE_STARTED_TEMPLATE =
  "Hello! The queue at {branch} for {date} has officially started. " +
  "Please monitor your place in line and be ready when we notify you that your turn is near. " +
  "Here's your Reservation details:\n" +
  "Date: {date}\n" +
  "Queue Number: {queueNumber}";

/** Previous clinic-cancelled SMS that told parents to book a "posted" day. */
const LEGACY_CLINIC_CANCELLED_TEMPLATE =
  "The clinic at {branch} is closed on {date} ({reason}). Your reservation was cancelled. Please book another posted day.";

export const isUsableBranchId = (branchId) =>
  typeof branchId === "string" && branchId.trim() !== "" && !LEGACY_GLOBAL_KEYS.has(branchId);

const branchConfigPath = (branchId) => `systemConfiguration/${branchId}`;

/**
 * Validates the penalty move back value.
 * @param {any} value
 * @returns {{ valid: boolean, value?: number, error?: string }}
 */
export const validatePenaltyMoveBack = (value) => {
  if (value === null || value === undefined || value === "") {
    return { valid: false, error: "Value cannot be empty" };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return { valid: false, error: "Value must be a whole number" };
  }

  if (parsed < MIN_PENALTY_MOVE_BACK) {
    return { valid: false, error: `Value must be at least ${MIN_PENALTY_MOVE_BACK}` };
  }

  if (parsed > MAX_PENALTY_MOVE_BACK) {
    return { valid: false, error: `Value cannot exceed ${MAX_PENALTY_MOVE_BACK}` };
  }

  return { valid: true, value: parsed };
};

const validateBoundedInteger = (value, { min, max, emptyLabel, noun }) => {
  if (value === null || value === undefined || value === "") {
    return { valid: false, error: `${emptyLabel} cannot be empty` };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return { valid: false, error: `${noun} must be a whole number` };
  }

  if (parsed < min) {
    return { valid: false, error: `${noun} must be at least ${min}` };
  }

  if (parsed > max) {
    return { valid: false, error: `${noun} cannot exceed ${max}` };
  }

  return { valid: true, value: parsed };
};

export const validatePenaltyTimerMinutes = (value) =>
  validateBoundedInteger(value, {
    min: MIN_PENALTY_TIMER_MINUTES,
    max: MAX_PENALTY_TIMER_MINUTES,
    emptyLabel: "Penalty timer",
    noun: "Penalty timer",
  });

export const validatePenaltyGraceMinutes = (value) =>
  validateBoundedInteger(value, {
    min: MIN_PENALTY_GRACE_MINUTES,
    max: MAX_PENALTY_GRACE_MINUTES,
    emptyLabel: "Penalty grace period",
    noun: "Penalty grace period",
  });

const parsePenaltyMoveBack = (value) => {
  const validation = validatePenaltyMoveBack(value);
  return validation.valid ? validation.value : DEFAULT_PENALTY_MOVE_BACK;
};

const parsePenaltyTimerMinutes = (value) => {
  const validation = validatePenaltyTimerMinutes(value);
  return validation.valid ? validation.value : DEFAULT_PENALTY_TIMER_MINUTES;
};

const parsePenaltyGraceMinutes = (value) => {
  const validation = validatePenaltyGraceMinutes(value);
  return validation.valid ? validation.value : DEFAULT_PENALTY_GRACE_MINUTES;
};

export const validateSlotCapacity = (value) => {
  if (value === null || value === undefined || value === "") {
    return { valid: false, error: "Slot capacity cannot be empty" };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return { valid: false, error: "Slot capacity must be a whole number" };
  }
  if (parsed < MIN_SLOT_CAPACITY) {
    return { valid: false, error: `Slot capacity must be at least ${MIN_SLOT_CAPACITY}` };
  }
  if (parsed > MAX_SLOT_CAPACITY) {
    return { valid: false, error: `Slot capacity cannot exceed ${MAX_SLOT_CAPACITY}` };
  }
  return { valid: true, value: parsed };
};

/**
 * Parses the configuration object to ensure safe fallbacks.
 */
const parseQueueConfig = (data) => ({
  penaltyMoveBack: parsePenaltyMoveBack(data?.penaltyMoveBack),
  penaltyTimerMinutes: parsePenaltyTimerMinutes(data?.penaltyTimerMinutes),
  penaltyGraceMinutes: parsePenaltyGraceMinutes(data?.penaltyGraceMinutes),
});

/**
 * Validates near-turn patients-ahead count.
 * @param {any} value
 * @returns {{ valid: boolean, value?: number, error?: string }}
 */
export const validateNearingTurnAheadCount = (value) => {
  if (value === null || value === undefined || value === "") {
    return { valid: false, error: "Patients-ahead value cannot be empty" };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return { valid: false, error: "Patients-ahead must be a whole number" };
  }

  if (parsed < MIN_NEARING_TURN_AHEAD) {
    return { valid: false, error: `Patients-ahead must be at least ${MIN_NEARING_TURN_AHEAD}` };
  }

  if (parsed > MAX_NEARING_TURN_AHEAD) {
    return { valid: false, error: `Patients-ahead cannot exceed ${MAX_NEARING_TURN_AHEAD}` };
  }

  return { valid: true, value: parsed };
};

const findUnknownPlaceholders = (template) => {
  const matches = String(template || "").matchAll(/\{([a-zA-Z]+)\}/g);
  const unknown = [];
  for (const match of matches) {
    if (!SMS_TEMPLATE_PLACEHOLDERS.includes(match[1]) && !unknown.includes(match[1])) {
      unknown.push(match[1]);
    }
  }
  return unknown;
};

/**
 * Validates one SMS template string.
 * @param {any} value
 * @param {string} label
 * @returns {{ valid: boolean, value?: string, error?: string }}
 */
export const validateSmsTemplate = (value, label = "Message") => {
  if (value === null || value === undefined) {
    return { valid: false, error: `${label} cannot be empty` };
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return { valid: false, error: `${label} cannot be empty` };
  }

  if (trimmed.length > MAX_SMS_TEMPLATE_LENGTH) {
    return {
      valid: false,
      error: `${label} cannot exceed ${MAX_SMS_TEMPLATE_LENGTH} characters`,
    };
  }

  const unknown = findUnknownPlaceholders(trimmed);
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `${label} has unknown placeholder(s): {${unknown.join("}, {")}}`,
    };
  }

  return { valid: true, value: trimmed };
};

/**
 * Validates a full SMS configuration payload.
 */
export const validateSmsConfiguration = (input = {}) => {
  const ahead = validateNearingTurnAheadCount(input.nearingTurnAheadCount);
  if (!ahead.valid) return ahead;

  const slot = validateSmsTemplate(input.templateSlotReserved, "Reservation Confirmed message");
  if (!slot.valid) return slot;

  const started = validateSmsTemplate(input.templateQueueStarted, "Queue Started message");
  if (!started.valid) return started;

  const near = validateSmsTemplate(input.templateNearingTurn, "Near Turn message");
  if (!near.valid) return near;

  const activeSlot = validateSmsTemplate(
    input.templateSlotReservedActiveQueue,
    "Active Queue Reservation message"
  );
  if (!activeSlot.valid) return activeSlot;

  const penalized = validateSmsTemplate(input.templatePenalized, "Penalty message");
  if (!penalized.valid) return penalized;

  const forfeited = validateSmsTemplate(input.templateForfeited, "Forfeiture message");
  if (!forfeited.valid) return forfeited;

  const clinicCancelled = validateSmsTemplate(input.templateClinicCancelled, "Clinic closed message");
  if (!clinicCancelled.valid) return clinicCancelled;

  return {
    valid: true,
    value: {
      nearingTurnAheadCount: ahead.value,
      templateSlotReserved: slot.value,
      templateQueueStarted: started.value,
      templateNearingTurn: near.value,
      templateSlotReservedActiveQueue: activeSlot.value,
      templatePenalized: penalized.value,
      templateForfeited: forfeited.value,
      templateClinicCancelled: clinicCancelled.value,
    },
  };
};

const parseSmsConfig = (data) => {
  const aheadValidation = validateNearingTurnAheadCount(
    data?.nearingTurnAheadCount ?? DEFAULT_NEARING_TURN_AHEAD
  );

  const storedQueueStarted = String(
    data?.templateQueueStarted ?? DEFAULT_SMS_TEMPLATES.templateQueueStarted
  ).trim();
  const queueStartedSource =
    storedQueueStarted === LEGACY_MERGED_QUEUE_STARTED_TEMPLATE
      ? DEFAULT_SMS_TEMPLATES.templateQueueStarted
      : storedQueueStarted;

  const slot = validateSmsTemplate(
    data?.templateSlotReserved ?? DEFAULT_SMS_TEMPLATES.templateSlotReserved,
    "Reservation Confirmed message"
  );
  const started = validateSmsTemplate(queueStartedSource, "Queue Started message");
  const near = validateSmsTemplate(
    data?.templateNearingTurn ?? DEFAULT_SMS_TEMPLATES.templateNearingTurn,
    "Near Turn message"
  );
  const activeSlot = validateSmsTemplate(
    data?.templateSlotReservedActiveQueue ?? DEFAULT_SMS_TEMPLATES.templateSlotReservedActiveQueue,
    "Active Queue Reservation message"
  );
  const penalized = validateSmsTemplate(
    data?.templatePenalized ?? DEFAULT_SMS_TEMPLATES.templatePenalized,
    "Penalty message"
  );
  const forfeited = validateSmsTemplate(
    data?.templateForfeited ?? DEFAULT_SMS_TEMPLATES.templateForfeited,
    "Forfeiture message"
  );
  const clinicCancelledSource =
    String(data?.templateClinicCancelled || "").trim() === LEGACY_CLINIC_CANCELLED_TEMPLATE
      ? DEFAULT_SMS_TEMPLATES.templateClinicCancelled
      : (data?.templateClinicCancelled ?? DEFAULT_SMS_TEMPLATES.templateClinicCancelled);
  const clinicCancelled = validateSmsTemplate(
    clinicCancelledSource,
    "Clinic closed message"
  );

  return {
    nearingTurnAheadCount: aheadValidation.valid
      ? aheadValidation.value
      : DEFAULT_NEARING_TURN_AHEAD,
    templateSlotReserved: slot.valid
      ? slot.value
      : DEFAULT_SMS_TEMPLATES.templateSlotReserved,
    templateQueueStarted: started.valid
      ? started.value
      : DEFAULT_SMS_TEMPLATES.templateQueueStarted,
    templateNearingTurn: near.valid
      ? near.value
      : DEFAULT_SMS_TEMPLATES.templateNearingTurn,
    templateSlotReservedActiveQueue: activeSlot.valid
      ? activeSlot.value
      : DEFAULT_SMS_TEMPLATES.templateSlotReservedActiveQueue,
    templatePenalized: penalized.valid
      ? penalized.value
      : DEFAULT_SMS_TEMPLATES.templatePenalized,
    templateForfeited: forfeited.valid
      ? forfeited.value
      : DEFAULT_SMS_TEMPLATES.templateForfeited,
    templateClinicCancelled: clinicCancelled.valid
      ? clinicCancelled.value
      : DEFAULT_SMS_TEMPLATES.templateClinicCancelled,
  };
};

const parseBranchConfig = (data) => ({
  ...parseQueueConfig(data),
  sms: parseSmsConfig(data?.sms),
});

const isBranchConfigSeeded = (data) =>
  Boolean(
    data &&
      (data.penaltyMoveBack !== undefined ||
        data.penaltyTimerMinutes !== undefined ||
        data.penaltyGraceMinutes !== undefined ||
        data.lateLimit !== undefined ||
        (data.sms && typeof data.sms === "object"))
  );

const readLegacyNode = async (path) => {
  try {
    const snap = await get(ref(getDb(), path));
    return snap.exists() ? snap.val() : null;
  } catch (error) {
    if (!isPermissionDenied(error)) {
      console.warn("Could not read legacy global systemConfiguration:", error);
    }
    return null;
  }
};

const readLegacyGlobal = async () => {
  const [queue, sms] = await Promise.all([
    readLegacyNode("systemConfiguration/queue"),
    readLegacyNode("systemConfiguration/sms"),
  ]);
  return { queue, sms };
};

const readBranchSmsOnly = async (branchId) => {
  try {
    const snap = await get(ref(getDb(), `${branchConfigPath(branchId)}/sms`));
    return parseBranchConfig({ sms: snap.exists() ? snap.val() : null });
  } catch (error) {
    if (!isPermissionDenied(error)) {
      console.error("Failed to read branch SMS configuration:", error);
    }
    return parseBranchConfig(null);
  }
};

const lookupBranchIdByName = async (name) => {
  if (!name) return null;
  try {
    const snap = await get(ref(getDb(), "branchConfigurations"));
    if (!snap.exists()) return null;
    const match = Object.entries(snap.val()).find(
      ([id, value]) => id === name || branchesMatch(value?.name, name)
    );
    return match ? match[0] : null;
  } catch (error) {
    console.error("Failed to resolve branch id by name:", error);
    return null;
  }
};

/**
 * Stable branchConfigurations key for a schedule (prefers schedule.branchId).
 */
export const resolveScheduleBranchId = async (schedule) => {
  if (!schedule) return null;
  if (isUsableBranchId(schedule.branchId)) {
    try {
      const snap = await get(ref(getDb(), `branchConfigurations/${schedule.branchId}`));
      if (snap.exists()) return schedule.branchId;
    } catch (error) {
      console.warn("Could not verify schedule.branchId:", error);
    }
  }
  return lookupBranchIdByName(schedule.branch);
};

/**
 * Seed a branch node from legacy global config (or defaults) when missing.
 */
export const ensureBranchSystemConfiguration = async (branchId) => {
  if (!isUsableBranchId(branchId)) {
    return parseBranchConfig(null);
  }

  const path = branchConfigPath(branchId);
  let existing = null;
  try {
    const snap = await get(ref(getDb(), path));
    existing = snap.exists() ? snap.val() : null;
  } catch (error) {
    if (isPermissionDenied(error)) {
      // Legacy fallback if branch-node read is still denied; parents may still read /sms.
      return readBranchSmsOnly(branchId);
    }
    console.error("Failed to read branch system configuration:", error);
    return parseBranchConfig(null);
  }

  if (isBranchConfigSeeded(existing)) {
    return parseBranchConfig(existing);
  }

  const legacy = await readLegacyGlobal();
  const parsed = parseBranchConfig({
    penaltyMoveBack: existing?.penaltyMoveBack ?? legacy.queue?.penaltyMoveBack,
    penaltyTimerMinutes: existing?.penaltyTimerMinutes,
    penaltyGraceMinutes: existing?.penaltyGraceMinutes,
    sms: existing?.sms ?? legacy.sms,
  });

  try {
    await update(ref(getDb(), path), {
      penaltyMoveBack: parsed.penaltyMoveBack,
      penaltyTimerMinutes: parsed.penaltyTimerMinutes,
      penaltyGraceMinutes: parsed.penaltyGraceMinutes,
      sms: {
        ...parsed.sms,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
  } catch (error) {
    if (!isPermissionDenied(error)) {
      console.error("Failed to seed branch system configuration:", error);
    }
  }

  return parsed;
};

export const getBranchSystemConfiguration = async (branchId) => {
  if (!isUsableBranchId(branchId)) {
    return parseBranchConfig(null);
  }
  return ensureBranchSystemConfiguration(branchId);
};

/**
 * Fetches queue configuration for a branch.
 */
export const getQueueConfiguration = async (branchId) => {
  const config = await getBranchSystemConfiguration(branchId);
  return {
    penaltyMoveBack: config.penaltyMoveBack,
    penaltyTimerMinutes: config.penaltyTimerMinutes,
    penaltyGraceMinutes: config.penaltyGraceMinutes,
  };
};

/**
 * Live queue rules for the schedule's branch. Throws on missing branch or read failure
 * so the parent agreement never proceeds on silent defaults.
 */
export const queueRulesValuesEqual = (a, b) =>
  Boolean(
    a &&
      b &&
      a.penaltyMoveBack === b.penaltyMoveBack &&
      a.penaltyTimerMinutes === b.penaltyTimerMinutes &&
      a.penaltyGraceMinutes === b.penaltyGraceMinutes
  );

/**
 * Live queue rules for the schedule's branch. Calls onError instead of silent defaults
 * so the parent agreement never proceeds on stale or guessed numbers.
 */
export const subscribeToQueueRulesForSchedule = (schedule, onRules, onError) => {
  let cancelled = false;
  let unsub = noopUnsub;

  resolveScheduleBranchId(schedule)
    .then((branchId) => {
      if (cancelled) return;
      if (!isUsableBranchId(branchId)) {
        onError?.(new Error("Could not determine this clinic's queue rules."));
        return;
      }

      unsub = onValue(
        ref(getDb(), branchConfigPath(branchId)),
        (snapshot) => {
          onRules(parseQueueConfig(snapshot.exists() ? snapshot.val() : null));
        },
        (error) => {
          console.error("Queue rules subscription error:", error);
          onError?.(error);
        }
      );
    })
    .catch((error) => {
      if (!cancelled) onError?.(error);
    });

  return () => {
    cancelled = true;
    safeUnsub(unsub);
  };
};

/**
 * Helper to fetch just the penalty move back value.
 */
export const getPenaltyMoveBack = async (branchId) => {
  const config = await getQueueConfiguration(branchId);
  return config.penaltyMoveBack;
};

/**
 * Subscribes to the queue configuration for real-time updates.
 */
export const subscribeToQueueConfiguration = (branchId, callback) => {
  if (typeof callback !== "function") return noopUnsub;
  if (!isUsableBranchId(branchId)) {
    callback(parseQueueConfig(null));
    return noopUnsub;
  }

  ensureBranchSystemConfiguration(branchId).catch(() => {});

  return subscribeOnValue(
    ref(getDb(), branchConfigPath(branchId)),
    (snapshot) => {
      callback(parseQueueConfig(snapshot.val()));
    },
    (error) => {
      console.error("Queue config subscription error:", error);
      callback(parseQueueConfig(null));
    }
  );
};

/**
 * Updates the penalty move back value and logs an audit event.
 */
export const updatePenaltyMoveBack = async (branchId, newValue) => {
  if (!isUsableBranchId(branchId)) {
    throw new Error("Branch is required to update Penalty Move-Back");
  }

  const validation = validatePenaltyMoveBack(newValue);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const newSafeValue = validation.value;
  await ensureBranchSystemConfiguration(branchId);
  const currentConfig = await getQueueConfiguration(branchId);
  const currentValue = currentConfig.penaltyMoveBack;

  if (currentValue === newSafeValue) {
    return;
  }

  await update(ref(getDb(), branchConfigPath(branchId)), {
    penaltyMoveBack: newSafeValue,
    updatedAt: Date.now(),
  });

  logAuditEvent({
    action: AUDIT_ACTIONS.SYSTEM_CONFIGURATION_CHANGED,
    category: AUDIT_CATEGORIES.SYSTEM_MANAGEMENT,
    description: `Changed Queue Penalty Move-Back from ${currentValue} to ${newSafeValue}`,
    targetType: "systemConfiguration",
    targetId: branchId,
    branchId,
  });
};

export const updatePenaltyTimerMinutes = async (branchId, newValue) => {
  if (!isUsableBranchId(branchId)) {
    throw new Error("Branch is required to update Penalty Timer");
  }

  const validation = validatePenaltyTimerMinutes(newValue);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const newSafeValue = validation.value;
  await ensureBranchSystemConfiguration(branchId);
  const currentConfig = await getQueueConfiguration(branchId);
  const currentValue = currentConfig.penaltyTimerMinutes;

  if (currentValue === newSafeValue) {
    return;
  }

  await update(ref(getDb(), branchConfigPath(branchId)), {
    penaltyTimerMinutes: newSafeValue,
    updatedAt: Date.now(),
  });

  logAuditEvent({
    action: AUDIT_ACTIONS.SYSTEM_CONFIGURATION_CHANGED,
    category: AUDIT_CATEGORIES.SYSTEM_MANAGEMENT,
    description: `Changed Penalty Timer from ${currentValue} to ${newSafeValue} minutes`,
    targetType: "systemConfiguration",
    targetId: branchId,
    branchId,
  });
};

export const updatePenaltyGraceMinutes = async (branchId, newValue) => {
  if (!isUsableBranchId(branchId)) {
    throw new Error("Branch is required to update Penalty Grace Period");
  }

  const validation = validatePenaltyGraceMinutes(newValue);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const newSafeValue = validation.value;
  await ensureBranchSystemConfiguration(branchId);
  const currentConfig = await getQueueConfiguration(branchId);
  const currentValue = currentConfig.penaltyGraceMinutes;

  if (currentValue === newSafeValue) {
    return;
  }

  await update(ref(getDb(), branchConfigPath(branchId)), {
    penaltyGraceMinutes: newSafeValue,
    updatedAt: Date.now(),
  });

  logAuditEvent({
    action: AUDIT_ACTIONS.SYSTEM_CONFIGURATION_CHANGED,
    category: AUDIT_CATEGORIES.SYSTEM_MANAGEMENT,
    description: `Changed Penalty Grace Period from ${currentValue} to ${newSafeValue} minutes`,
    targetType: "systemConfiguration",
    targetId: branchId,
    branchId,
  });
};

/**
 * Fetches SMS notification configuration for a branch.
 */
export const getSmsConfiguration = async (branchId) => {
  const config = await getBranchSystemConfiguration(branchId);
  return config.sms;
};

/**
 * Subscribes to SMS configuration for real-time updates.
 */
export const subscribeToSmsConfiguration = (branchId, callback) => {
  if (typeof callback !== "function") return noopUnsub;
  if (!isUsableBranchId(branchId)) {
    callback(parseSmsConfig(null));
    return noopUnsub;
  }

  return subscribeOnValue(
    ref(getDb(), `${branchConfigPath(branchId)}/sms`),
    (snapshot) => {
      callback(parseSmsConfig(snapshot.val()));
    },
    (error) => {
      console.error("SMS config subscription error:", error);
      callback(parseSmsConfig(null));
    }
  );
};

/**
 * Updates SMS notification configuration and logs an audit event.
 */
export const updateSmsConfiguration = async (branchId, input) => {
  if (!isUsableBranchId(branchId)) {
    throw new Error("Branch is required to update SMS configuration");
  }

  const validation = validateSmsConfiguration(input);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const next = validation.value;
  await ensureBranchSystemConfiguration(branchId);
  const current = await getSmsConfiguration(branchId);

  const unchanged =
    current.nearingTurnAheadCount === next.nearingTurnAheadCount &&
    current.templateSlotReserved === next.templateSlotReserved &&
    current.templateQueueStarted === next.templateQueueStarted &&
    current.templateNearingTurn === next.templateNearingTurn &&
    current.templateSlotReservedActiveQueue === next.templateSlotReservedActiveQueue &&
    current.templatePenalized === next.templatePenalized &&
    current.templateForfeited === next.templateForfeited &&
    current.templateClinicCancelled === next.templateClinicCancelled;

  if (unchanged) {
    return current;
  }

  const payload = {
    ...next,
    updatedAt: Date.now(),
  };

  await update(ref(getDb(), `${branchConfigPath(branchId)}/sms`), payload);
  await update(ref(getDb(), branchConfigPath(branchId)), { updatedAt: Date.now() });

  const changes = [];
  if (current.nearingTurnAheadCount !== next.nearingTurnAheadCount) {
    changes.push(
      `near-turn ahead ${current.nearingTurnAheadCount} → ${next.nearingTurnAheadCount}`
    );
  }
  if (current.templateSlotReserved !== next.templateSlotReserved) {
    changes.push("reservation SMS template");
  }
  if (current.templateQueueStarted !== next.templateQueueStarted) {
    changes.push("queue-started SMS template");
  }
  if (current.templateNearingTurn !== next.templateNearingTurn) {
    changes.push("near-turn SMS template");
  }
  if (current.templateSlotReservedActiveQueue !== next.templateSlotReservedActiveQueue) {
    changes.push("active-queue reservation SMS template");
  }
  if (current.templatePenalized !== next.templatePenalized) {
    changes.push("penalty SMS template");
  }
  if (current.templateForfeited !== next.templateForfeited) {
    changes.push("forfeiture SMS template");
  }
  if (current.templateClinicCancelled !== next.templateClinicCancelled) {
    changes.push("clinic-closed SMS template");
  }

  logAuditEvent({
    action: AUDIT_ACTIONS.SYSTEM_CONFIGURATION_CHANGED,
    category: AUDIT_CATEGORIES.SYSTEM_MANAGEMENT,
    description: `Changed SMS configuration (${changes.join(", ")})`,
    targetType: "systemConfiguration",
    targetId: branchId,
    branchId,
  });

  return next;
};

/**
 * Push/toast copy for NEARING_TURN — count-synced, not admin-editable.
 */
export const getDefaultSlotCapacity = async (branchId) => {
  if (!isUsableBranchId(branchId)) return DEFAULT_SLOT_CAPACITY;
  try {
    const snap = await get(ref(getDb(), `${branchConfigPath(branchId)}/defaultSlotCapacity`));
    const parsed = validateSlotCapacity(snap.val());
    return parsed.valid ? parsed.value : DEFAULT_SLOT_CAPACITY;
  } catch (error) {
    if (!isPermissionDenied(error)) {
      console.error("Failed to read default slot capacity:", error);
    }
    return DEFAULT_SLOT_CAPACITY;
  }
};

export const updateDefaultSlotCapacity = async (branchId, newValue) => {
  if (!isUsableBranchId(branchId)) {
    throw new Error("Branch is required to update the default slot capacity");
  }
  const validation = validateSlotCapacity(newValue);
  if (!validation.valid) throw new Error(validation.error);
  await ensureBranchSystemConfiguration(branchId);
  const current = await getDefaultSlotCapacity(branchId);
  if (current === validation.value) return validation.value;
  await update(ref(getDb(), branchConfigPath(branchId)), {
    defaultSlotCapacity: validation.value,
    updatedAt: Date.now(),
  });
  logAuditEvent({
    action: AUDIT_ACTIONS.SYSTEM_CONFIGURATION_CHANGED,
    category: AUDIT_CATEGORIES.SYSTEM_MANAGEMENT,
    description: `Changed default slot capacity from ${current} to ${validation.value}`,
    targetType: "systemConfiguration",
    targetId: branchId,
    branchId,
  });
  return validation.value;
};

export const buildNearingTurnPushMessage = (count = DEFAULT_NEARING_TURN_AHEAD) => {
  const safeCount = Number.isInteger(count) ? count : DEFAULT_NEARING_TURN_AHEAD;
  return `There are only ${safeCount} patients ahead of you. Please proceed to the clinic.`;
};
