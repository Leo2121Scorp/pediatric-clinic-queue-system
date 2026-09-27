const ANGELES_BRANCH_ID = "angeles";
const MAGALANG_BRANCH_ID = "magalang";

const WEEKDAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function closedDay() {
  return { isOpen: false, openingTime: "", closingTime: "" };
}

function weekSchedule(openDays) {
  const schedule = {};
  WEEKDAY_KEYS.forEach((day) => {
    schedule[day] = openDays[day] ? { isOpen: true, ...openDays[day] } : closedDay();
  });
  return schedule;
}

const DEMO_BRANCHES = {
  [ANGELES_BRANCH_ID]: {
    name: "Angeles",
    clinicAddress: "McArthur Highway,\nSto. Domingo,\nAngeles City, Pampanga",
    schedule: weekSchedule({
      monday: { openingTime: "09:00", closingTime: "12:00" },
      tuesday: { openingTime: "15:00", closingTime: "17:00" },
      wednesday: { openingTime: "09:00", closingTime: "12:00" },
      thursday: { openingTime: "15:00", closingTime: "17:00" },
      friday: { openingTime: "09:00", closingTime: "12:00" },
    }),
  },
  [MAGALANG_BRANCH_ID]: {
    name: "Magalang",
    clinicAddress: "Don Aniceto Gueco St,\nSan Nicolas 1st,\nMagalang, Pampanga",
    schedule: weekSchedule({
      monday: { openingTime: "14:00", closingTime: "17:00" },
      tuesday: { openingTime: "09:00", closingTime: "12:00" },
      wednesday: { openingTime: "14:00", closingTime: "17:00" },
      thursday: { openingTime: "09:00", closingTime: "12:00" },
      friday: { openingTime: "14:00", closingTime: "17:00" },
      saturday: { openingTime: "09:00", closingTime: "12:00" },
    }),
  },
};

function scheduleIdForDate(clinicDate, branchId = ANGELES_BRANCH_ID) {
  return `${branchId}_${clinicDate}`;
}

function hoursForDate(clinicDate, branchId = ANGELES_BRANCH_ID) {
  const branch = DEMO_BRANCHES[branchId];
  const [year, month, day] = String(clinicDate).split("-").map(Number);
  const weekday = WEEKDAY_KEYS[new Date(Date.UTC(year, month - 1, day, 4, 0, 0)).getUTCDay()];
  const hours = branch?.schedule?.[weekday];
  if (hours?.isOpen) {
    return { openingTime: hours.openingTime, closingTime: hours.closingTime };
  }
  return { openingTime: "09:00", closingTime: "12:00" };
}

function buildStarterSchedule({ clinicDate, doctorId, branchId = ANGELES_BRANCH_ID }) {
  const branch = DEMO_BRANCHES[branchId];
  const hours = hoursForDate(clinicDate, branchId);
  const now = Date.now();
  return {
    branch: branch.name,
    branchId,
    clinicDate,
    openingTime: hours.openingTime,
    closingTime: hours.closingTime,
    slotCapacity: 30,
    status: "published",
    queueStatus: "not_started",
    queueStartedAt: null,
    publishedAt: now,
    completedAt: null,
    isReady: false,
    dayClosed: false,
    doctorId: doctorId || null,
    booking: { activeSlotCount: 0, nextQueueNumber: 1 },
  };
}

function defaultSystemConfiguration(now = Date.now()) {
  return {
    penaltyMoveBack: 2,
    defaultSlotCapacity: 30,
    penaltyGraceMinutes: 2,
    penaltyTimerMinutes: 15,
    sms: {
      nearingTurnAheadCount: 3,
      templateSlotReserved:
        "Your clinic reservation is confirmed.\nDate: {date}\nTime: {timeRange}\nQueue Number: {queueNumber}\nDoctor: {doctor}\nBranch: {branch}\nPlease keep this message for your visit. Thank you.",
      templateSlotReservedActiveQueue:
        "You reserved a slot on an active Queue. Queue Number: {queueNumber}. Queue Position: {queuePosition}. Please monitor your queue.",
      templateQueueStarted:
        "The queue at {branch} for {date} has started. Please monitor your place in line and be ready when we notify you that your turn is near.",
      templateNearingTurn:
        "Only {count} patients ahead (Queue #{queueNumber}). Please head to the clinic now.",
      templatePenalized:
        "You were marked late and moved back in line (Queue #{queueNumber}, position {queuePosition}). Please validate your QR at {branch} within {minutes} minutes or this reservation will be forfeited.",
      templateForfeited:
        "Your reservation (Queue #{queueNumber}) at {branch} on {date} was forfeited because you did not check in on time. You may still book a new slot on the same schedule if slots are available.",
      updatedAt: now,
    },
    updatedAt: now,
  };
}

const DEMO_ACCOUNTS = [
  {
    key: "doctor",
    email: "demo.doctor@plusqueue.demo",
    name: "Demo Doctor",
    role: "doctor",
    claims: { isDemo: true, demoOperator: true },
  },
  {
    key: "secretary",
    email: "demo.secretary@plusqueue.demo",
    name: "Demo Secretary",
    role: "secretary",
    claims: { isDemo: true },
  },
  {
    key: "parent",
    email: "demo.parent@plusqueue.demo",
    name: "Demo Parent",
    role: "parent",
    claims: { isDemo: true },
  },
];

module.exports = {
  ANGELES_BRANCH_ID,
  MAGALANG_BRANCH_ID,
  DEMO_BRANCHES,
  DEMO_ACCOUNTS,
  scheduleIdForDate,
  hoursForDate,
  buildStarterSchedule,
  defaultSystemConfiguration,
};
