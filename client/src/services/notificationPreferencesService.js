import { ref, update } from "firebase/database";
import { getDb } from "../firebase/database";

let cachedInAppEnabled = true;

export function isInAppNotificationsEnabled(user) {
  if (user && typeof user.inAppNotificationsEnabled === "boolean") {
    return user.inAppNotificationsEnabled;
  }
  return cachedInAppEnabled;
}

export function isDevicePushEnabled(user) {
  return user?.devicePushEnabled === true;
}

export function cacheNotificationPreferences(user) {
  if (!user || user.role !== "parent") {
    cachedInAppEnabled = true;
    return;
  }
  cachedInAppEnabled = user.inAppNotificationsEnabled !== false;
}

export async function persistNotificationPreferences(uid, fields) {
  if (!uid || !fields) return;
  const updates = { updatedAt: Date.now() };
  if (typeof fields.inAppNotificationsEnabled === "boolean") {
    updates.inAppNotificationsEnabled = fields.inAppNotificationsEnabled;
    cachedInAppEnabled = fields.inAppNotificationsEnabled;
  }
  if (typeof fields.devicePushEnabled === "boolean") {
    updates.devicePushEnabled = fields.devicePushEnabled;
  }
  if (fields.notificationPermission !== undefined) {
    updates.notificationPermission = fields.notificationPermission;
  }
  if (fields.notificationTokenUpdatedAt !== undefined) {
    updates.notificationTokenUpdatedAt = fields.notificationTokenUpdatedAt;
  }
  await update(ref(getDb(), `users/${uid}`), updates);
}

export async function setInAppNotificationsEnabled(uid, enabled) {
  await persistNotificationPreferences(uid, {
    inAppNotificationsEnabled: Boolean(enabled),
  });
}
