import { getDb } from "../firebase/database";
import { ref, push, set, get, update, remove } from "firebase/database";
import { subscribeOnValue } from "../firebase/rtdbSubscribe";
import { logAuditEvent, AUDIT_ACTIONS, AUDIT_CATEGORIES } from "./auditService";
import { getReservationsBySchedule } from "./reservationService";
import { branchesMatch, normalizeBranchName } from "../utils/stringUtils";
import { manilaDateString, manilaNowMinutes, manilaWeekdayIndex, WEEKDAY_KEYS } from "../utils/manilaDate";

const defaultSchedule = () => ({
  monday: { isOpen: false, openingTime: "", closingTime: "" },
  tuesday: { isOpen: false, openingTime: "", closingTime: "" },
  wednesday: { isOpen: false, openingTime: "", closingTime: "" },
  thursday: { isOpen: false, openingTime: "", closingTime: "" },
  friday: { isOpen: false, openingTime: "", closingTime: "" },
  saturday: { isOpen: false, openingTime: "", closingTime: "" },
  sunday: { isOpen: false, openingTime: "", closingTime: "" }
});

const DEFAULT_BRANCHES = [
  {
    name: "Angeles",
    clinicAddress: "McArthur Highway,\nSto. Domingo,\nAngeles City, Pampanga",
    schedule: {
      ...defaultSchedule(),
      monday: { isOpen: true, openingTime: "09:00", closingTime: "12:00" },
      tuesday: { isOpen: true, openingTime: "15:00", closingTime: "17:00" },
      wednesday: { isOpen: true, openingTime: "09:00", closingTime: "12:00" },
      thursday: { isOpen: true, openingTime: "15:00", closingTime: "17:00" },
      friday: { isOpen: true, openingTime: "09:00", closingTime: "12:00" }
    }
  },
  {
    name: "Magalang",
    clinicAddress: "Don Aniceto Gueco St,\nSan Nicolas 1st,\nMagalang, Pampanga",
    schedule: {
      ...defaultSchedule(),
      monday: { isOpen: true, openingTime: "14:00", closingTime: "17:00" },
      tuesday: { isOpen: true, openingTime: "09:00", closingTime: "12:00" },
      wednesday: { isOpen: true, openingTime: "14:00", closingTime: "17:00" },
      thursday: { isOpen: true, openingTime: "09:00", closingTime: "12:00" },
      friday: { isOpen: true, openingTime: "14:00", closingTime: "17:00" },
      saturday: { isOpen: true, openingTime: "09:00", closingTime: "12:00" }
    }
  }
];

const getPatternForDay = (schedulePatterns, dayIndex) => {
  const matchers = {
    "mwf": [1, 3, 5],
    "tth": [2, 4],
    "tths": [2, 4, 6],
    "weekdays": [1, 2, 3, 4, 5],
    "weekends": [0, 6],
    "everyday": [0, 1, 2, 3, 4, 5, 6],
    "monday": [1],
    "tuesday": [2],
    "wednesday": [3],
    "thursday": [4],
    "friday": [5],
    "saturday": [6],
    "sunday": [0]
  };

  if (!schedulePatterns) return null;

  for (const [pattern, hours] of Object.entries(schedulePatterns)) {
    const p = pattern.toLowerCase().trim();
    if (matchers[p] && matchers[p].includes(dayIndex)) {
      return hours;
    }
  }
  return null;
};

const migrateToV2 = async (branches) => {
  const updatedBranches = await Promise.all(branches.map(async (branch) => {
    if (branch.schedulePatterns && !branch.schedule) {
      const newSchedule = defaultSchedule();
      const daysMap = {
        0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday',
        4: 'thursday', 5: 'friday', 6: 'saturday'
      };
      
      for (let i = 0; i < 7; i++) {
        const patternHours = getPatternForDay(branch.schedulePatterns, i);
        if (patternHours) {
          newSchedule[daysMap[i]] = {
            isOpen: true,
            openingTime: patternHours.openingTime,
            closingTime: patternHours.closingTime
          };
        }
      }

      await update(ref(getDb(), `branchConfigurations/${branch.id}`), {
        schedule: newSchedule,
        schedulePatterns: null
      });

      return { ...branch, schedule: newSchedule, schedulePatterns: undefined };
    }
    return branch;
  }));

  return updatedBranches;
};

export const getBranchConfigurations = async () => {
  const snapshot = await get(ref(getDb(), "branchConfigurations"));
  if (snapshot.exists()) {
    const data = snapshot.val();
    const branches = Object.entries(data).map(([id, value]) => ({ id, ...value }));
    return await migrateToV2(branches);
  }
  return [];
};

export const subscribeToBranchConfigurations = (callback) => {
  if (typeof callback !== "function") return () => {};
  const branchesRef = ref(getDb(), "branchConfigurations");
  return subscribeOnValue(branchesRef, async (snapshot) => {
    if (!snapshot.exists()) {
      callback([]);
      return;
    }
    const data = snapshot.val();
    const branches = Object.entries(data).map(([id, value]) => ({ id, ...value }));
    const migratedBranches = await migrateToV2(branches);
    callback(migratedBranches);
  });
};

export const seedDefaultBranches = async () => {
  const existing = await getBranchConfigurations();
  if (existing.length === 0) {
    for (const branch of DEFAULT_BRANCHES) {
      const branchRef = push(ref(getDb(), "branchConfigurations"));
      await set(branchRef, {
        ...branch,
        createdAt: Date.now()
      });
    }
  }
};

export const createBranch = async (branchData) => {
  const branchRef = push(ref(getDb(), "branchConfigurations"));
  await set(branchRef, {
    ...branchData,
    createdAt: Date.now()
  });
  
  logAuditEvent({
    action: AUDIT_ACTIONS.BRANCH_CREATED,
    category: AUDIT_CATEGORIES.BRANCH_MANAGEMENT,
    description: `Created a new branch: ${branchData.name}`,
    targetType: "branch",
    targetId: branchRef.key,
    branchId: branchRef.key
  });
  
  return branchRef.key;
};

export const updateBranch = async (branchId, branchData) => {
  const existingSnap = await get(ref(getDb(), `branchConfigurations/${branchId}`));
  const oldName = existingSnap.exists() ? existingSnap.val().name : null;
  const newName = branchData.name;

  await update(ref(getDb(), `branchConfigurations/${branchId}`), branchData);

  // Keep schedule.branch and secretary assignedBranch in sync when the display name changes.
  // Without this, Start Queue works for the doctor but secretaries filter on a stale name.
  if (oldName && newName && oldName !== newName) {
    const cascadeUpdates = {};
    const oldNormalized = normalizeBranchName(oldName);

    const schedulesSnap = await get(ref(getDb(), "schedules"));
    if (schedulesSnap.exists()) {
      for (const [id, schedule] of Object.entries(schedulesSnap.val())) {
        const matchesId = schedule.branchId === branchId;
        const matchesName =
          schedule.branch === oldName ||
          normalizeBranchName(schedule.branch) === oldNormalized;
        if (matchesId || matchesName) {
          cascadeUpdates[`schedules/${id}/branch`] = newName;
          cascadeUpdates[`schedules/${id}/branchId`] = branchId;
        }
      }
    }

    const usersSnap = await get(ref(getDb(), "users"));
    if (usersSnap.exists()) {
      for (const [id, user] of Object.entries(usersSnap.val())) {
        if (user.role !== "secretary") continue;
        const matchesId = user.assignedBranchId === branchId;
        const matchesName =
          user.assignedBranch === oldName ||
          normalizeBranchName(user.assignedBranch) === oldNormalized;
        if (matchesId || matchesName) {
          cascadeUpdates[`users/${id}/assignedBranch`] = newName;
          cascadeUpdates[`users/${id}/assignedBranchId`] = branchId;
        }
      }
    }

    if (Object.keys(cascadeUpdates).length > 0) {
      await update(ref(getDb()), cascadeUpdates);
    }
  }
  
  logAuditEvent({
    action: AUDIT_ACTIONS.BRANCH_EDITED,
    category: AUDIT_CATEGORIES.BRANCH_MANAGEMENT,
    description: `Updated branch configuration: ${branchData.name || branchId}`,
    targetType: "branch",
    targetId: branchId,
    branchId: branchId
  });
};

export const deleteBranch = async (branchId) => {
  await remove(ref(getDb(), `branchConfigurations/${branchId}`));
  
  logAuditEvent({
    action: AUDIT_ACTIONS.BRANCH_DELETED,
    category: AUDIT_CATEGORIES.BRANCH_MANAGEMENT,
    description: `Deleted branch`,
    targetType: "branch",
    targetId: branchId,
    branchId: branchId
  });
};

export const getClinicHours = async (branchName, clinicDate) => {
  const branches = await getBranchConfigurations();
  const branch = branches.find(b => branchesMatch(b.name, branchName) || b.id === branchName);
  
  if (!branch || !branch.schedule) return null;

  const daySchedule = branch.schedule[WEEKDAY_KEYS[manilaWeekdayIndex(clinicDate)]];
  if (daySchedule && daySchedule.isOpen) {
    return {
      openingTime: daySchedule.openingTime,
      closingTime: daySchedule.closingTime
    };
  }

  return null;
};

// check kung tapos na yung closing time ng branch for today's schedule
export const validateScheduleClosingTime = async (branchName, clinicDate) => {
  if (!branchName || !clinicDate) {
    return { valid: true };
  }

  const todayStr = manilaDateString();

  if (clinicDate !== todayStr) {
    return { valid: true };
  }

  // retrieve closing time from the currently selected branch configuration
  const hours = await getClinicHours(branchName, clinicDate);
  if (!hours || !hours.closingTime) {
    return {
      valid: false,
      message: "This branch is closed on the selected date."
    };
  }

  const currentMinutes = manilaNowMinutes();
  const [closeH, closeM] = hours.closingTime.split(":").map(Number);
  const closingMinutes = closeH * 60 + closeM;

  if (currentMinutes >= closingMinutes) {
    return {
      valid: false,
      message: "You can no longer create or update today's schedule because the selected branch has already reached its closing time. Please choose another date."
    };
  }

  return { valid: true };
};

export const checkBranchInUse = async (branchName) => {
  const schedulesSnapshot = await get(ref(getDb(), "schedules"));
  let hasPublishedSchedules = false;
  let scheduleIds = [];
  
  if (schedulesSnapshot.exists()) {
    const schedules = schedulesSnapshot.val();
    for (const [id, schedule] of Object.entries(schedules)) {
      if (branchesMatch(schedule.branch, branchName)) {
        scheduleIds.push(id);
        if (schedule.status === "published") {
          hasPublishedSchedules = true;
        }
      }
    }
  }

  let hasActiveReservations = false;
  if (scheduleIds.length > 0) {
    const inactiveStatuses = ["cancelled", "cancelled_by_clinic", "completed", "consultation_completed", "forfeited", "penalized", "late_limit_reached", "expired", "validation_expired"];
    
    const reservationsArrays = await Promise.all(
      scheduleIds.map(id => getReservationsBySchedule(id))
    );
    
    const allRelevantReservations = reservationsArrays.flat();
    hasActiveReservations = allRelevantReservations.some(res => !inactiveStatuses.includes(res.status));
  }

  return {
    inUse: hasPublishedSchedules || hasActiveReservations,
    hasPublishedSchedules,
    hasActiveReservations
  };
};
