/**
 * HTTPS Express app for Hosting /api/** rewrites.
 * Mirrors server SMS auth, identifier resolve, and password-reset claim endpoints.
 */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const {
  sendLoginOtp,
  sendRegistrationOtp,
  sendUpdatePhoneOtp,
  verifyLoginOtp,
  verifyRegistrationOtp,
  verifyUpdatePhoneOtp,
  assertPhoneVerified,
  consumePhoneVerification,
} = require("./otpService");
const { resolveAccountByIdentifier } = require("./phoneLookup");
const { claimPasswordResetSlot } = require("./passwordResetLimitService");
const { claimReservationSlot } = require("./claimReservationRuntime");
const { notifyParentsScheduleAvailable } = require("./pushRuntime");
const { defaultDatabase, getRtdb, runForToken } = require("./rtdbRouter");

function mapOtpError(err) {
  const code = err.code || "internal";
  const statusByCode = {
    invalid_phone: 400,
    invalid_input: 400,
    invalid_email: 400,
    user_not_found: 404,
    phone_in_use: 409,
    phone_not_verified: 403,
    rate_limited: 429,
    sms_failed: 502,
    otp_missing: 400,
    otp_expired: 400,
    otp_locked: 429,
    otp_mismatch: 401,
    otp_purpose_mismatch: 400,
    auth_failed: 401,
    auth_denied: 403,
  };
  return {
    status: statusByCode[code] || 500,
    code,
    message: err.message || "SMS authentication failed.",
    retryAfterSeconds: err.retryAfterSeconds,
  };
}

function sendError(res, err) {
  console.error("[functions/api]", err.message);
  const mapped = mapOtpError(err);
  return res.status(mapped.status).json({
    success: false,
    error: mapped.code,
    message: mapped.message,
    ...(mapped.retryAfterSeconds != null
      ? { retryAfterSeconds: mapped.retryAfterSeconds }
      : {}),
  });
}

async function verifyIdToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (err) {
    console.error("[functions/api] ID token verification failed:", err.message);
    return null;
  }
}

async function requireAuth(req, res) {
  const decoded = await verifyIdToken(req.headers.authorization);
  if (!decoded?.uid) {
    res.status(401).json({
      success: false,
      error: "auth_denied",
      message: "You must be signed in.",
    });
    return null;
  }
  return decoded;
}

function createApiApp() {
  const app = express();
  const corsOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  app.use(
    cors(
      corsOrigins.length
        ? {
            origin(origin, callback) {
              if (!origin || corsOrigins.includes(origin)) callback(null, true);
              else callback(new Error("Not allowed by CORS"));
            },
          }
        : { origin: true }
    )
  );
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "functions-api" });
  });

  app.post("/api/auth/resolve-identifier", async (req, res) => {
    try {
      const resolved = await resolveAccountByIdentifier(
        defaultDatabase(),
        req.body?.identifier
      );
      return res.json({
        success: true,
        type: resolved.type,
        email: resolved.email,
      });
    } catch (err) {
      console.error("[functions/api] resolve-identifier:", err.message);
      const statusByCode = {
        invalid_input: 400,
        user_not_found: 404,
      };
      return res.status(statusByCode[err.code] || 500).json({
        success: false,
        error: err.code || "internal",
        message: err.message || "Unable to resolve login identifier.",
      });
    }
  });

  app.post("/api/auth/password-reset/claim", async (req, res) => {
    try {
      const result = await claimPasswordResetSlot(req.body?.email);
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post("/api/auth/sms/send-otp", async (req, res) => {
    try {
      const purpose = ["register", "update"].includes(req.body?.purpose)
        ? req.body.purpose
        : "login";

      if (purpose === "update") {
        const decoded = await requireAuth(req, res);
        if (!decoded) return;
        const result = await sendUpdatePhoneOtp(req.body?.phone, decoded.uid);
        return res.json(result);
      }

      const result =
        purpose === "register"
          ? await sendRegistrationOtp(req.body?.phone)
          : await sendLoginOtp(req.body?.phone);
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post("/api/auth/sms/verify-otp", async (req, res) => {
    try {
      const purpose = ["register", "update"].includes(req.body?.purpose)
        ? req.body.purpose
        : "login";

      if (purpose === "update") {
        const decoded = await requireAuth(req, res);
        if (!decoded) return;
        const result = await verifyUpdatePhoneOtp(
          req.body?.phone,
          req.body?.code,
          decoded.uid
        );
        return res.json(result);
      }

      const result =
        purpose === "register"
          ? await verifyRegistrationOtp(req.body?.phone, req.body?.code)
          : await verifyLoginOtp(req.body?.phone, req.body?.code);
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post("/api/auth/sms/assert-phone-verified", async (req, res) => {
    try {
      const purpose = req.body?.purpose || null;
      const options = {};
      if (purpose) options.purpose = purpose;
      if (purpose === "update") {
        const decoded = await requireAuth(req, res);
        if (!decoded) return;
        options.uid = decoded.uid;
      }
      const result = await assertPhoneVerified(
        req.body?.phone,
        req.body?.verificationId,
        options
      );
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post("/api/reservations/claim", async (req, res) => {
    try {
      const decoded = await requireAuth(req, res);
      if (!decoded) return;
      const result = await runForToken(decoded, () =>
        claimReservationSlot({
          admin,
          callerUid: decoded.uid,
          payload: req.body,
        })
      );
      return res.json({ success: true, ...result });
    } catch (err) {
      const statusByCode = {
        unauthenticated: 401,
        "permission-denied": 403,
        "invalid-argument": 400,
        "failed-precondition": 409,
        "not-found": 404,
      };
      const code = statusByCode[err.code] ? err.code : "internal";
      console.error("[functions/api] reservations/claim:", err.message);
      return res.status(statusByCode[code] || 500).json({
        success: false,
        error: code,
        message: err.message || "Could not reserve a slot.",
      });
    }
  });

  app.post("/api/schedules/notify-available", async (req, res) => {
    try {
      const decoded = await requireAuth(req, res);
      if (!decoded) return;
      return await runForToken(decoded, async () => {
      const roleSnap = await getRtdb().ref(`users/${decoded.uid}/role`).once("value");
      const role = roleSnap.exists() ? roleSnap.val() : null;
      if (!["doctor", "secretary", "admin"].includes(role)) {
        return res.status(403).json({
          success: false,
          error: "permission-denied",
          message: "Only clinic staff can notify parents.",
        });
      }
      const batchId = String(req.body?.batchId || "").trim();
      if (!batchId) {
        return res.status(400).json({
          success: false,
          error: "invalid-argument",
          message: "batchId is required.",
        });
      }
      const result = await notifyParentsScheduleAvailable({
        batchId,
        branchId: req.body?.branchId || null,
        branchName: req.body?.branchName || "",
        postedCount: Number(req.body?.postedCount || 0),
        startDate: req.body?.startDate || null,
        endDate: req.body?.endDate || null,
      });
      return res.json({ success: true, ...result });
      });
    } catch (err) {
      console.error("[functions/api] schedules/notify-available:", err.message);
      return res.status(500).json({
        success: false,
        error: "internal",
        message: err.message || "Could not notify parents.",
      });
    }
  });

  app.post("/api/auth/sms/consume-phone-verification", async (req, res) => {
    try {
      const purpose = req.body?.purpose || null;
      const options = {};
      if (purpose) options.purpose = purpose;
      if (purpose === "update") {
        const decoded = await requireAuth(req, res);
        if (!decoded) return;
        options.uid = decoded.uid;
      }
      const result = await consumePhoneVerification(
        req.body?.phone,
        req.body?.verificationId,
        options
      );
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  return app;
}

module.exports = { createApiApp };
