import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const functionsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../functions");
const requireFromFunctions = createRequire(path.join(functionsDir, "package.json"));
const { resetDemoClinicDay } = requireFromFunctions("./demoResetRuntime.js");

function createMemoryDb(initial = {}) {
  const root = structuredClone(initial);

  const get = (nodePath) => {
    if (!nodePath) return root;
    return String(nodePath).split("/").filter(Boolean).reduce((node, key) => {
      if (node == null || typeof node !== "object") return undefined;
      return node[key];
    }, root);
  };

  const set = (nodePath, value) => {
    const parts = String(nodePath).split("/").filter(Boolean);
    if (!parts.length) return;
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (value == null) delete node[last];
    else node[last] = value;
  };

  let pushCount = 0;
  const ref = (nodePath = "") => ({
    once: async () => {
      const value = get(nodePath);
      return {
        exists: () => value != null,
        val: () => (value == null ? null : value),
      };
    },
    set: async (value) => set(nodePath, value),
    update: async (updates) => {
      for (const [key, value] of Object.entries(updates || {})) set(key, value);
    },
    push() {
      pushCount += 1;
      const id = `log${pushCount}`;
      const childPath = nodePath ? `${nodePath}/${id}` : id;
      return { key: id, set: async (value) => set(childPath, value) };
    },
    transaction: async (updater) => {
      const current = get(nodePath) ?? null;
      const next = updater(current);
      if (next === undefined) return { committed: false };
      set(nodePath, next);
      return { committed: true };
    },
  });

  return { ref, snapshot: () => structuredClone(root) };
}

const clinicDate = "2026-09-28";

function seedState() {
  return {
    users: {
      doctor1: { role: "doctor", status: "active" },
      parent1: { role: "parent", status: "active" },
    },
    schedules: {
      "angeles_2026-09-28": {
        clinicDate,
        status: "completed",
        queueStatus: "completed",
        branchId: "angeles",
        doctorId: "doctor1",
        booking: { activeSlotCount: 1, nextQueueNumber: 2 },
      },
      extra: { clinicDate, status: "published", queueStatus: "active", branchId: "angeles" },
    },
    reservations: {
      res1: {
        scheduleId: "angeles_2026-09-28",
        parentId: "parent1",
        clinicDate,
        status: "consultation_completed",
      },
    },
    bookingLocks: { parent1: { [clinicDate]: true } },
    parentBookingCaps: { parent1: { dates: { [clinicDate]: "angeles_2026-09-28" }, updatedAt: 1 } },
    notifications: { parent1: { n1: { reservationId: "res1", title: "Done" } } },
    clinicClosures: {
      c1: { startDate: clinicDate, endDate: clinicDate, branchId: "angeles" },
    },
  };
}

test("resetDemoClinicDay is idempotent and leaves the starter schedule open", async () => {
  const db = createMemoryDb(seedState());
  const first = await resetDemoClinicDay({ clinicDate, callerUid: "doctor1", db });
  const second = await resetDemoClinicDay({ clinicDate, callerUid: "doctor1", db });
  const data = db.snapshot();

  assert.equal(first.removedReservations, 1);
  assert.equal(second.removedReservations, 0);
  assert.deepEqual(data.reservations?.res1, undefined);
  assert.equal(Object.keys(data.reservations || {}).length, 0);
  assert.equal(data.schedules.extra, undefined);
  assert.equal(data.schedules["angeles_2026-09-28"].status, "published");
  assert.equal(data.schedules["angeles_2026-09-28"].queueStatus, "not_started");
  assert.equal(data.schedules["angeles_2026-09-28"].booking.activeSlotCount, 0);
  assert.equal(data.bookingLocks.parent1[clinicDate], undefined);
  assert.equal(data.parentBookingCaps?.parent1, undefined);
  assert.equal(data.notifications.parent1.n1, undefined);
  assert.equal(data.clinicClosures.c1, undefined);
  assert.equal(data.users.doctor1.role, "doctor");
  assert.equal(Object.keys(data.demoResetLogs).length, 2);
});
