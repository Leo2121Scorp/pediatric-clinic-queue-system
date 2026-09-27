const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const { sendSms, normalizePhoneE164 } = require("./smsService");
const { findUserByPhoneFlexible } = require("./phoneLookup");

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 90 * 1000;
const PHONE_VERIFICATION_TTL_MS = 30 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 10;

const PURPOSE_LOGIN = "login";
const PURPOSE_REGISTER = "register";
const PURPOSE_UPDATE = "update";

const { getRtdb } = require("./rtdbRouter");

function getDb() {
  return getRtdb();
}

function phoneToKey(phoneE164) {
  return String(phoneE164 || "").replace(/[.#$\[\]]/g, "_");
}

function generateOtpCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function generateVerificationId() {
  return crypto.randomBytes(24).toString("hex");
}

async function findParentByPhone(phoneE164) {
  return findUserByPhoneFlexible(getDb(), phoneE164, { parentsOnly: true, requireActive: true });
}

async function findParentByPhoneIncludingInactive(phoneE164) {
  return findUserByPhoneFlexible(getDb(), phoneE164, { parentsOnly: true, requireActive: false });
}

async function findAnyUserByPhone(phoneE164, excludeUid = null) {
  return findUserByPhoneFlexible(getDb(), phoneE164, {
    parentsOnly: false,
    requireActive: false,
    excludeUid,
  });
}

async function enforceResendCooldown(otpRef) {
  const existing = await otpRef.once("value");
  if (!existing.exists()) return;
  const prev = existing.val() || {};
  const age = Date.now() - (prev.createdAt || 0);
  if (age < OTP_RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - age) / 1000);
    const err = new Error(`Please wait ${waitSec}s before requesting another code.`);
    err.code = "rate_limited";
    err.retryAfterSeconds = waitSec;
    throw err;
  }
}

async function deliverAndStoreOtp({ phone, purpose, uid = null }) {
  const key = phoneToKey(phone);
  const otpRef = getDb().ref(`smsOtps/${key}`);
  await enforceResendCooldown(otpRef);

  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const now = Date.now();

  await otpRef.set({
    phone,
    purpose,
    uid: uid || null,
    codeHash,
    expiresAt: now + OTP_TTL_MS,
    createdAt: now,
    attempts: 0,
  });

  const smsResult = await sendSms(
    phone,
    `Your verification code is: ${code}. It will expire in 5 minutes.`
  );

  if (!smsResult.success || smsResult.skipped) {
    await otpRef.remove();
    if (smsResult.skipped) {
      console.warn("[functions/otp] SMS not configured — OTP not delivered");
    }
    const err = new Error("Failed to send verification SMS. Please try again.");
    err.code = "sms_failed";
    throw err;
  }

  return {
    success: true,
    phone,
    purpose,
    cooldownSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
  };
}

async function sendLoginOtp(rawPhone) {
  const phone = normalizePhoneE164(rawPhone);
  if (!phone) {
    const err = new Error("Enter a valid mobile number.");
    err.code = "invalid_phone";
    throw err;
  }

  const parent = await findParentByPhone(phone);
  if (!parent) {
    const err = new Error("No active parent account is registered with this number.");
    err.code = "user_not_found";
    throw err;
  }

  return deliverAndStoreOtp({ phone, purpose: PURPOSE_LOGIN, uid: parent.uid });
}

async function sendRegistrationOtp(rawPhone) {
  const phone = normalizePhoneE164(rawPhone);
  if (!phone) {
    const err = new Error("Enter a valid mobile number.");
    err.code = "invalid_phone";
    throw err;
  }

  const existing = await findParentByPhoneIncludingInactive(phone);
  if (existing) {
    const err = new Error("This phone number is already registered. Please sign in instead.");
    err.code = "phone_in_use";
    throw err;
  }

  return deliverAndStoreOtp({ phone, purpose: PURPOSE_REGISTER, uid: null });
}

async function loadValidOtpRecord(phone, purpose) {
  const key = phoneToKey(phone);
  const otpRef = getDb().ref(`smsOtps/${key}`);
  const snap = await otpRef.once("value");

  if (!snap.exists()) {
    const err = new Error("No verification code found. Please request a new one.");
    err.code = "otp_missing";
    throw err;
  }

  const record = snap.val() || {};
  if (record.purpose && record.purpose !== purpose) {
    const err = new Error("Verification code does not match this action. Please request a new one.");
    err.code = "otp_purpose_mismatch";
    throw err;
  }

  if (Date.now() > (record.expiresAt || 0)) {
    await otpRef.remove();
    const err = new Error("Verification code has expired. Please request a new one.");
    err.code = "otp_expired";
    throw err;
  }

  if ((record.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await otpRef.remove();
    const err = new Error("Too many incorrect attempts. Please request a new code.");
    err.code = "otp_locked";
    throw err;
  }

  return { otpRef, record };
}

async function verifyLoginOtp(rawPhone, rawCode) {
  const phone = normalizePhoneE164(rawPhone);
  const code = String(rawCode || "").replace(/\D/g, "");

  if (!phone || code.length !== 6) {
    const err = new Error("Invalid phone number or verification code.");
    err.code = "invalid_input";
    throw err;
  }

  const { otpRef, record } = await loadValidOtpRecord(phone, PURPOSE_LOGIN);
  const matches = await bcrypt.compare(code, record.codeHash || "");
  if (!matches) {
    await otpRef.update({ attempts: (record.attempts || 0) + 1 });
    const err = new Error("Incorrect verification code.");
    err.code = "otp_mismatch";
    throw err;
  }

  const uid = record.uid;
  if (!uid) {
    await otpRef.remove();
    const err = new Error("Unable to authenticate this number.");
    err.code = "auth_failed";
    throw err;
  }

  const userSnap = await getDb().ref(`users/${uid}`).once("value");
  if (!userSnap.exists()) {
    await otpRef.remove();
    const err = new Error("Account not found.");
    err.code = "user_not_found";
    throw err;
  }

  const user = userSnap.val() || {};
  if (user.role !== "parent" || user.status === "inactive" || user.isDeleted === true) {
    await otpRef.remove();
    const err = new Error("This account cannot sign in with SMS.");
    err.code = "auth_denied";
    throw err;
  }

  await otpRef.remove();

  const customToken = await admin.auth().createCustomToken(uid, {
    role: "parent",
    authProvider: "sms_otp",
  });

  return { success: true, customToken, uid };
}

async function verifyRegistrationOtp(rawPhone, rawCode) {
  const phone = normalizePhoneE164(rawPhone);
  const code = String(rawCode || "").replace(/\D/g, "");

  if (!phone || code.length !== 6) {
    const err = new Error("Invalid phone number or verification code.");
    err.code = "invalid_input";
    throw err;
  }

  const existing = await findParentByPhoneIncludingInactive(phone);
  if (existing) {
    const err = new Error("This phone number is already registered. Please sign in instead.");
    err.code = "phone_in_use";
    throw err;
  }

  const { otpRef, record } = await loadValidOtpRecord(phone, PURPOSE_REGISTER);
  const matches = await bcrypt.compare(code, record.codeHash || "");
  if (!matches) {
    await otpRef.update({ attempts: (record.attempts || 0) + 1 });
    const err = new Error("Incorrect verification code.");
    err.code = "otp_mismatch";
    throw err;
  }

  await otpRef.remove();

  const verificationId = generateVerificationId();
  const now = Date.now();
  const key = phoneToKey(phone);
  await getDb().ref(`phoneVerifications/${key}`).set({
    phone,
    verificationId,
    purpose: PURPOSE_REGISTER,
    verifiedAt: now,
    expiresAt: now + PHONE_VERIFICATION_TTL_MS,
  });

  return {
    success: true,
    verified: true,
    phone,
    verificationId,
    expiresInSeconds: Math.floor(PHONE_VERIFICATION_TTL_MS / 1000),
  };
}

async function sendUpdatePhoneOtp(rawPhone, uid) {
  const phone = normalizePhoneE164(rawPhone);
  if (!phone) {
    const err = new Error("Enter a valid mobile number.");
    err.code = "invalid_phone";
    throw err;
  }
  if (!uid) {
    const err = new Error("You must be signed in to update your phone number.");
    err.code = "auth_denied";
    throw err;
  }

  const conflict = await findAnyUserByPhone(phone, uid);
  if (conflict) {
    const err = new Error("This phone number is already used by another account.");
    err.code = "phone_in_use";
    throw err;
  }

  return deliverAndStoreOtp({ phone, purpose: PURPOSE_UPDATE, uid });
}

async function verifyUpdatePhoneOtp(rawPhone, rawCode, uid) {
  const phone = normalizePhoneE164(rawPhone);
  const code = String(rawCode || "").replace(/\D/g, "");

  if (!phone || code.length !== 6) {
    const err = new Error("Invalid phone number or verification code.");
    err.code = "invalid_input";
    throw err;
  }
  if (!uid) {
    const err = new Error("You must be signed in to update your phone number.");
    err.code = "auth_denied";
    throw err;
  }

  const conflict = await findAnyUserByPhone(phone, uid);
  if (conflict) {
    const err = new Error("This phone number is already used by another account.");
    err.code = "phone_in_use";
    throw err;
  }

  const { otpRef, record } = await loadValidOtpRecord(phone, PURPOSE_UPDATE);
  if (record.uid && record.uid !== uid) {
    const err = new Error("Verification code does not match this account.");
    err.code = "auth_denied";
    throw err;
  }

  const matches = await bcrypt.compare(code, record.codeHash || "");
  if (!matches) {
    await otpRef.update({ attempts: (record.attempts || 0) + 1 });
    const err = new Error("Incorrect verification code.");
    err.code = "otp_mismatch";
    throw err;
  }

  await otpRef.remove();

  const verificationId = generateVerificationId();
  const now = Date.now();
  const key = phoneToKey(phone);
  await getDb().ref(`phoneVerifications/${key}`).set({
    phone,
    verificationId,
    purpose: PURPOSE_UPDATE,
    uid,
    verifiedAt: now,
    expiresAt: now + PHONE_VERIFICATION_TTL_MS,
  });

  return {
    success: true,
    verified: true,
    phone,
    verificationId,
    expiresInSeconds: Math.floor(PHONE_VERIFICATION_TTL_MS / 1000),
  };
}

async function assertPhoneVerified(rawPhone, verificationId, options = {}) {
  const phone = normalizePhoneE164(rawPhone);
  if (!phone || !verificationId) {
    const err = new Error("Phone verification is required.");
    err.code = "phone_not_verified";
    throw err;
  }

  const key = phoneToKey(phone);
  const snap = await getDb().ref(`phoneVerifications/${key}`).once("value");
  if (!snap.exists()) {
    const err = new Error("Phone is not verified. Please verify your number first.");
    err.code = "phone_not_verified";
    throw err;
  }

  const record = snap.val() || {};
  if (record.verificationId !== verificationId) {
    const err = new Error("Phone verification is invalid. Please verify again.");
    err.code = "phone_not_verified";
    throw err;
  }

  if (options.purpose && record.purpose && record.purpose !== options.purpose) {
    const err = new Error("Phone verification is invalid for this action.");
    err.code = "phone_not_verified";
    throw err;
  }

  if (options.uid && record.uid && record.uid !== options.uid) {
    const err = new Error("Phone verification does not belong to this account.");
    err.code = "phone_not_verified";
    throw err;
  }

  if (Date.now() > (record.expiresAt || 0)) {
    await getDb().ref(`phoneVerifications/${key}`).remove();
    const err = new Error("Phone verification expired. Please verify again.");
    err.code = "phone_not_verified";
    throw err;
  }

  return { success: true, phone, verified: true, purpose: record.purpose || null };
}

async function consumePhoneVerification(rawPhone, verificationId, options = {}) {
  await assertPhoneVerified(rawPhone, verificationId, options);
  const phone = normalizePhoneE164(rawPhone);
  await getDb().ref(`phoneVerifications/${phoneToKey(phone)}`).remove();
  return { success: true };
}

module.exports = {
  generateOtpCode,
  sendLoginOtp,
  sendRegistrationOtp,
  sendUpdatePhoneOtp,
  verifyLoginOtp,
  verifyRegistrationOtp,
  verifyUpdatePhoneOtp,
  assertPhoneVerified,
  consumePhoneVerification,
  normalizePhoneE164,
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  PURPOSE_LOGIN,
  PURPOSE_REGISTER,
  PURPOSE_UPDATE,
};
