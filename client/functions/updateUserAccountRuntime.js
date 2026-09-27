const { databaseFor } = require("./rtdbRouter");

function makeError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const PROFILE_ALLOWLIST = ["name", "phone", "assignedBranch", "assignedBranchId"];

/**
 * Doctor/admin updates another user's profile fields.
 * Parent profile edits are rejected with 403.
 */
async function updateUserAccount({ admin, callerUid, targetUid, updates }) {
  if (!callerUid) {
    throw makeError("Authentication required.", 401, "unauthenticated");
  }
  if (!targetUid || typeof targetUid !== "string") {
    throw makeError("A user id is required.", 400, "invalid-argument");
  }
  if (!updates || typeof updates !== "object") {
    throw makeError("Update payload is required.", 400, "invalid-argument");
  }

  const db = databaseFor(admin);
  const callerSnap = await db.ref(`users/${callerUid}`).once("value");
  const caller = callerSnap.exists() ? callerSnap.val() : null;
  const callerAllowed =
    caller &&
    caller.status === "active" &&
    (caller.role === "doctor" || caller.role === "admin");
  if (!callerAllowed) {
    throw makeError("Only an active doctor can update user profiles.", 403, "permission-denied");
  }

  const targetSnap = await db.ref(`users/${targetUid}`).once("value");
  const target = targetSnap.exists() ? targetSnap.val() : null;
  if (!target) {
    throw makeError("User not found.", 404, "not-found");
  }

  if (target.role === "parent") {
    throw makeError(
      "Doctors cannot edit parent profile information.",
      403,
      "permission-denied"
    );
  }

  const sanitized = {};
  for (const key of PROFILE_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      sanitized[key] = updates[key];
    }
  }

  if (Object.keys(sanitized).length === 0) {
    throw makeError("No allowed profile fields to update.", 400, "invalid-argument");
  }

  if (target.role !== "secretary") {
    delete sanitized.assignedBranch;
    delete sanitized.assignedBranchId;
  }

  await db.ref(`users/${targetUid}`).update({
    ...sanitized,
    updatedAt: Date.now(),
  });

  return { success: true, uid: targetUid };
}

module.exports = {
  updateUserAccount,
  PROFILE_ALLOWLIST,
};
