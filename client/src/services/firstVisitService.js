export const PARENT_TOUR_STEPS_KEY = "pq.parentTour.v2.completedSteps";
export const SECRETARY_TOUR_STEPS_KEY = "pq.secretaryTour.v2.completedSteps";
export const DOCTOR_TOUR_STEPS_KEY = "pq.doctorTour.v2.completedSteps";

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private mode should not break the tour.
  }
}

function removeSession(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export async function persistTourComplete(uid) {
  if (!uid) return;
  const { ref, update } = await import("firebase/database");
  const { getDb } = await import("../firebase/database");
  await update(ref(getDb(), `users/${uid}`), {
    hasCompletedTour: true,
    updatedAt: Date.now(),
  });
}

export const persistParentTourComplete = persistTourComplete;

export function getCompletedTourSteps(key = PARENT_TOUR_STEPS_KEY) {
  try {
    const raw = readSession(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function markTourStepComplete(stepId, key = PARENT_TOUR_STEPS_KEY) {
  if (!stepId) return getCompletedTourSteps(key);
  const steps = getCompletedTourSteps(key);
  if (steps.includes(stepId)) return steps;
  const next = [...steps, stepId];
  writeSession(key, JSON.stringify(next));
  return next;
}

export function clearTourStepProgress(key = PARENT_TOUR_STEPS_KEY) {
  removeSession(key);
}
