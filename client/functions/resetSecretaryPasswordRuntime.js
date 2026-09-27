const crypto = require("crypto");
const { databaseFor } = require("./rtdbRouter");

function makeError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Strong temporary password: 16 chars, mixed case, digits, and symbols.
 * Never log the return value.
 */
function generateTemporaryPassword(length = 16) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*?";
  const all = upper + lower + digits + symbols;

  const pick = (charset) => charset[crypto.randomInt(0, charset.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];

  for (let i = chars.length; i < length; i += 1) {
    chars.push(pick(all));
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

/**
 * Doctor (or leftover admin) resets a secretary password directly.
 * Returns a one-time temporary password; never write it to logs or audit.
 */
async function resetSecretaryPassword({ admin, callerUid, targetUid }) {
  if (!callerUid) {
    throw makeError("Authentication required.", 401, "unauthenticated");
  }
  if (!targetUid || typeof targetUid !== "string") {
    throw makeError("A user id is required.", 400, "invalid-argument");
  }
  if (callerUid === targetUid) {
    throw makeError("You cannot reset your own password through this action.", 400, "failed-precondition");
  }

  const db = databaseFor(admin);
  const callerSnap = await db.ref(`users/${callerUid}`).once("value");
  const caller = callerSnap.exists() ? callerSnap.val() : null;
  const callerAllowed =
    caller &&
    caller.status === "active" &&
    (caller.role === "doctor" || caller.role === "admin");
  if (!callerAllowed) {
    throw makeError(
      "Only an active doctor can reset a secretary password directly.",
      403,
      "permission-denied"
    );
  }

  const targetSnap = await db.ref(`users/${targetUid}`).once("value");
  const target = targetSnap.exists() ? targetSnap.val() : null;
  if (!target) {
    throw makeError("User not found.", 404, "not-found");
  }
  if (target.role !== "secretary") {
    throw makeError(
      "Direct password reset is only allowed for secretary accounts.",
      403,
      "permission-denied"
    );
  }

  const temporaryPassword = generateTemporaryPassword();

  await admin.auth().updateUser(targetUid, { password: temporaryPassword });
  await admin.auth().revokeRefreshTokens(targetUid);

  await db.ref(`users/${targetUid}`).update({
    mustChangePassword: true,
    updatedAt: Date.now(),
  });

  return {
    success: true,
    uid: targetUid,
    temporaryPassword,
    secretaryName: target.name || null,
  };
}

module.exports = {
  resetSecretaryPassword,
  generateTemporaryPassword,
};
