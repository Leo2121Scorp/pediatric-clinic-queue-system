import { initializeApp, getApps, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, updateProfile, signOut, sendPasswordResetEmail } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { ref, set, get } from "firebase/database";
import app, { firebaseConfig } from "../firebase/firebaseConfig";
import { database } from "../firebase/database";
import { auth } from "../firebase/auth";
import { logAuditEvent, AUDIT_ACTIONS, AUDIT_CATEGORIES } from "./auditService";

export const getActiveDoctor = async () => {
  const snapshot = await get(ref(database, "users"));
  if (!snapshot.exists()) return null;
  const users = Object.values(snapshot.val());
  return users.find(u => u.role === "doctor" && u.status === "active");
};

export const createStaffAccount = async (staffData) => {
  // staffData: { role, name, email, phone, password, assignedBranch (optional for doctor) }
  
  if (staffData.role === "doctor") {
    const activeDoctor = await getActiveDoctor();
    if (activeDoctor) {
      throw new Error("Only one active Doctor account is allowed. Please deactivate the current Doctor before creating a new one.");
    }
  }

  // Create a secondary app to avoid logging out the current Admin
  const secondaryAppName = "SecondaryAppInstance";
  let secondaryApp;
  
  const existingApps = getApps();
  const existingSecondary = existingApps.find(app => app.name === secondaryAppName);
  
  if (existingSecondary) {
    secondaryApp = existingSecondary;
  } else {
    secondaryApp = initializeApp(firebaseConfig, secondaryAppName);
  }

  const secondaryAuth = getAuth(secondaryApp);
  
  try {
    // Create user in Firebase Auth
    const userCredential = await createUserWithEmailAndPassword(
      secondaryAuth,
      staffData.email,
      staffData.password
    );

    const user = userCredential.user;

    // Update Auth Profile
    if (staffData.name) {
      await updateProfile(user, { displayName: staffData.name }).catch(err => console.error("Could not update profile:", err));
    }

    // Save user details to Realtime Database
    const now = Date.now();
    const dbPayload = {
      uid: user.uid,
      name: staffData.name,
      email: staffData.email,
      phone: staffData.phone || "",
      role: staffData.role,
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    if (staffData.role === "secretary") {
      dbPayload.assignedBranch = staffData.assignedBranch;
    }

    await set(ref(database, `users/${user.uid}`), dbPayload);

    // Sign out from the secondary app instance
    await signOut(secondaryAuth);
    
    // Delete the secondary app instance to clean up
    await deleteApp(secondaryApp);

    // Audit Log
    logAuditEvent({
      action: AUDIT_ACTIONS.USER_CREATED,
      category: AUDIT_CATEGORIES.USER_MANAGEMENT,
      description: `Created a new ${staffData.role} account for ${staffData.name}`,
      targetType: "user",
      targetId: user.uid
    });

    return user;
  } catch (error) {
    // Clean up on error as well
    if (secondaryAuth.currentUser) {
      await signOut(secondaryAuth).catch(() => {});
    }
    await deleteApp(secondaryApp).catch(() => {});
    throw error;
  }
};

export const updateUser = async (uid, updates) => {
  const userRef = ref(database, `users/${uid}`);
  const payload = {
    ...updates,
    updatedAt: Date.now()
  };
  
  const { update } = await import("firebase/database");
  await update(userRef, payload);

  logAuditEvent({
    action: AUDIT_ACTIONS.USER_EDITED,
    category: AUDIT_CATEGORIES.USER_MANAGEMENT,
    description: `Updated user profile details`,
    targetType: "user",
    targetId: uid
  });
};

export const toggleUserStatus = async (uid, currentStatus) => {
  const userRef = ref(database, `users/${uid}`);
  const newStatus = currentStatus === "active" ? "inactive" : "active";
  
  const { update } = await import("firebase/database");
  await update(userRef, {
    status: newStatus,
    deactivationSource: newStatus === "inactive" ? "admin" : null,
    updatedAt: Date.now()
  });
  
  logAuditEvent({
    action: newStatus === "active" ? AUDIT_ACTIONS.USER_ACTIVATED : AUDIT_ACTIONS.USER_DEACTIVATED,
    category: AUDIT_CATEGORIES.USER_MANAGEMENT,
    description: `User account status changed to ${newStatus}`,
    targetType: "user",
    targetId: uid
  });

  return newStatus;
};

export const sendAdminPasswordResetEmail = async (email) => {
  const actionCodeSettings = {
    url: `${window.location.origin}/reset-password`,
    handleCodeInApp: false
  };
  return sendPasswordResetEmail(auth, email, actionCodeSettings);
};

export const deleteUserAccount = async (uid) => {
  if (!uid) throw new Error("A user id is required.");
  if (!auth.currentUser) throw new Error("Authentication required.");
  if (auth.currentUser.uid === uid) {
    throw new Error("You cannot delete your own account.");
  }

  const snapshot = await get(ref(database, `users/${uid}`));
  const target = snapshot.exists() ? snapshot.val() : null;
  if (target?.role === "admin") {
    throw new Error("Admin accounts cannot be deleted.");
  }
  if (target?.role === "doctor" && target.status === "active") {
    const activeDoctor = await getActiveDoctor();
    if (activeDoctor && (activeDoctor.uid === uid || !activeDoctor.uid)) {
      const usersSnap = await get(ref(database, "users"));
      const users = usersSnap.exists() ? usersSnap.val() : {};
      const otherActiveDoctor = Object.entries(users).some(
        ([id, user]) => id !== uid && user?.role === "doctor" && user?.status === "active"
      );
      if (!otherActiveDoctor) {
        throw new Error("Cannot delete the only active Doctor account. Deactivate or create another Doctor first.");
      }
    }
  }

  let completed = false;
  const token = await auth.currentUser.getIdToken();
  const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

  try {
    const res = await fetch(`${apiBase}/api/admin/delete-user`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid }),
    });

    if (res.ok) {
      completed = true;
    } else {
      const body = await res.json().catch(() => ({}));
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new Error(body.error || "Failed to delete user.");
      }
    }
  } catch (err) {
    if (err instanceof TypeError) {
      completed = false;
    } else {
      throw err;
    }
  }

  if (!completed) {
    const functions = getFunctions(app, "asia-southeast1");
    const callDelete = httpsCallable(functions, "deleteUserAccount");
    await callDelete({ uid });
  }

  logAuditEvent({
    action: AUDIT_ACTIONS.USER_DELETED,
    category: AUDIT_CATEGORIES.USER_MANAGEMENT,
    description: `Deleted user account${target?.name ? ` for ${target.name}` : ""}`,
    targetType: "user",
    targetId: uid,
  });
};
