import { createUserWithEmailAndPassword, updateProfile, signInWithEmailAndPassword, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendEmailVerification, deleteUser } from "firebase/auth";
import { ref, set, update, get } from "firebase/database";

import { auth } from "../firebase/auth";
import { database } from "../firebase/database";
import { cleanupPushSubscriptionOnLogout } from "./pushService";
import { closeActiveReservationsForParent } from "./reservationService";

let accountLifecycleInProgress = false;

export const isAccountLifecycleInProgress = () => accountLifecycleInProgress;

export const canParentSelfReactivate = (userData) => (
  Boolean(userData)
  && userData.role === "parent"
  && userData.status === "inactive"
  && userData.deactivationSource === "self"
  && userData.isDeleted !== true
);

export const getParentPostAuthPath = (userData, firebaseUser) => {
  if (firebaseUser && !firebaseUser.emailVerified) return "/verify-email";
  if (userData?.onboardingComplete === false) return "/onboarding/child";
  return "/parent";
};

export const reactivateSelfDeactivatedParent = async (uid) => {
  if (!uid) return;
  await update(ref(database, `users/${uid}`), {
    status: "active",
    deactivationSource: null,
    updatedAt: Date.now()
  });
};

export const registerUser = async (
  name,
  email,
  phone,
  password,
  { phoneVerificationId, isPhoneVerified = false } = {}
) => {
  if (!isPhoneVerified || !phoneVerificationId) {
    throw { code: "auth/phone-not-verified" };
  }

  // Server-side gate: phone must have a valid registration OTP proof
  const { assertPhoneVerified } = await import("./smsAuthService");
  await assertPhoneVerified(phone, phoneVerificationId);

  const userCredential =
    await createUserWithEmailAndPassword(
        auth,
        email,
        password
    );

    const user = userCredential.user;
    if (name) {
      await updateProfile(user, { displayName: name }).catch(err => console.error("Could not update profile:", err));
    }

    console.log("User created:", user.uid);

    // Temporarily store phone + verification for profile creation after email verify
    if (phone) {
      localStorage.setItem(
        `pending_registration_${user.uid}`,
        JSON.stringify({
          phone,
          isPhoneVerified: true,
          phoneVerificationId,
        })
      );
    }

    try {
      await sendEmailVerification(user);
    } catch (err) {
      console.error("Could not send verification email:", err);
      throw { code: 'auth/verification-email-failed', originalError: err };
    }

  return user;
};

export const completeParentRegistration = async (user) => {
  const userRef = ref(database, `users/${user.uid}`);
  const snapshot = await get(userRef);
  if (snapshot.exists()) {
    return; // Profile already created
  }

  const pendingData = JSON.parse(localStorage.getItem(`pending_registration_${user.uid}`) || "{}");
  const now = Date.now();
  
  await set(userRef, {
    uid: user.uid,
    name: user.displayName || "Parent",
    email: user.email,
    phone: pendingData.phone || "",
    isPhoneVerified: pendingData.isPhoneVerified === true,
    role: "parent",
    status: "active",
    onboardingComplete: false,
    inAppNotificationsEnabled: true,
    createdAt: now,
    updatedAt: now
  });

  if (pendingData.phone && pendingData.phoneVerificationId) {
    try {
      const { consumePhoneVerification } = await import("./smsAuthService");
      await consumePhoneVerification(pendingData.phone, pendingData.phoneVerificationId);
    } catch (err) {
      console.warn("Could not consume phone verification proof:", err.message);
    }
  }
  
  localStorage.removeItem(`pending_registration_${user.uid}`);
};

export const loginUser = async (
  email,
  password
) => {

  const userCredential =
    await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

  return userCredential.user;
};

/**
 * Resolve email or phone → account email, then sign in with password.
 * @param {string} identifier - email address or PH mobile number
 * @param {string} password
 */
export const loginWithIdentifier = async (identifier, password) => {
  const { detectLoginIdentifier } = await import("../utils/loginIdentifier");
  const { getPushApiBase } = await import("./pushService");

  const trimmed = String(identifier || "").trim();
  const detected = detectLoginIdentifier(trimmed);
  if (detected.type === "unknown" || (detected.type === "phone" && !detected.value)) {
    throw { code: "auth/invalid-email" };
  }

  // Always resolve via server so phone legacy formats (+63 / 09 / 9…) match RTDB
  const apiBase = (getPushApiBase() || "").replace(/\/$/, "");
  const res = await fetch(`${apiBase}/api/auth/resolve-identifier`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: trimmed }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.email) {
    const err = new Error(data.message || "No account was found with this email or phone number.");
    err.code = data.error === "user_not_found" ? "auth/user-not-found" : (data.error || "auth/user-not-found");
    throw err;
  }

  return loginUser(data.email, password);
};

const PUSH_CLEANUP_TIMEOUT_MS = 4000;

export const logoutUser = async (user) => {
  try {
    if (user && user.role === "parent") {
      await Promise.race([
        cleanupPushSubscriptionOnLogout(user),
        new Promise((resolve) => setTimeout(resolve, PUSH_CLEANUP_TIMEOUT_MS)),
      ]);
    }
  } catch (error) {
    console.error("Push cleanup on logout failed:", error);
  }
  await signOut(auth);
};

export const updateUserProfile = async (uid, data) => {
  if (!uid || !data) return;
  const updates = { updatedAt: Date.now() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.phone !== undefined) updates.phone = data.phone;
  if (data.isPhoneVerified !== undefined) updates.isPhoneVerified = data.isPhoneVerified;
  if (data.contactNumber !== undefined) updates.contactNumber = data.contactNumber;
  if (data.professionalTitle !== undefined) updates.professionalTitle = data.professionalTitle;
  if (data.clinicName !== undefined) updates.clinicName = data.clinicName;

  // Update Realtime Database
  await update(ref(database, `users/${uid}`), updates);

  // Update Auth Profile
  const currentUser = auth.currentUser;
  if (currentUser && currentUser.uid === uid && data.name) {
    await updateProfile(currentUser, { displayName: data.name });
  }
};

export const changeUserPassword = async (currentPassword, newPassword) => {
  const user = auth.currentUser;
  if (!user || !user.email) throw new Error("User not authenticated.");

  // Re-authenticate
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);

  // Update password
  await updatePassword(user, newPassword);
};

export const completeParentOnboarding = async (uid) => {
  if (!uid) return;
  await update(ref(database, `users/${uid}`), {
    onboardingComplete: true,
    updatedAt: Date.now()
  });
};

export const deactivateOwnAccount = async (user) => {
  const uid = user?.uid || auth.currentUser?.uid;
  if (!uid) throw new Error("User not authenticated.");

  accountLifecycleInProgress = true;
  try {
    await closeActiveReservationsForParent(uid, {
      terminalStatus: "cancelled",
      reason: "Parent deactivated their account."
    });
    await update(ref(database, `users/${uid}`), {
      status: "inactive",
      deactivationSource: "self",
      updatedAt: Date.now()
    });
    await logoutUser(user || { uid, role: "parent" });
  } finally {
    accountLifecycleInProgress = false;
  }
};

export const softDeleteOwnAccount = async (password, user) => {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.email) throw new Error("User not authenticated.");
  if (!password) throw new Error("Password is required.");

  accountLifecycleInProgress = true;
  try {
    const credential = EmailAuthProvider.credential(currentUser.email, password);
    await reauthenticateWithCredential(currentUser, credential);

    await closeActiveReservationsForParent(currentUser.uid, {
      terminalStatus: "forfeited",
      reason: "Parent account was deleted."
    });

    await update(ref(database, `users/${currentUser.uid}`), {
      isDeleted: true,
      deletedAt: Date.now(),
      status: "inactive",
      deactivationSource: "self",
      updatedAt: Date.now()
    });

    try {
      await cleanupPushSubscriptionOnLogout(user || { uid: currentUser.uid, role: "parent" });
    } catch (error) {
      console.error("Push cleanup on account delete failed:", error);
    }

    await deleteUser(currentUser);
    try {
      await signOut(auth);
    } catch {
      // Session is already invalid after deleteUser.
    }
  } finally {
    accountLifecycleInProgress = false;
  }
};