import { getDb } from "../firebase/database";
import { ref, push, update, get } from "firebase/database";
import { getAuth } from "firebase/auth";
import { subscribeOnValue } from "../firebase/rtdbSubscribe";

/**
 * Notification Center Service
 * Manages persistent storage and real-time synchronization of notifications
 * in Firebase Realtime Database at `notifications/${parentId}`.
 */

export const cleanupNonParentNotifications = async () => {
  try {
    const uid = getAuth().currentUser?.uid;
    if (!uid) return;

    const roleSnapshot = await get(ref(getDb(), `users/${uid}/role`));
    const role = roleSnapshot.exists() ? roleSnapshot.val() : null;
    // Doctor owns clinic-admin cleanup; admin kept during transition
    if (role !== "doctor" && role !== "admin") return;

    const snapshot = await get(ref(getDb(), "users"));
    if (!snapshot.exists()) return;

    const users = snapshot.val();
    const updates = {};

    Object.entries(users).forEach(([uid, userData]) => {
      if (userData && userData.role !== "parent") {
        if (userData.notifications) {
          updates[`users/${uid}/notifications`] = null;
        }
        updates[`notifications/${uid}`] = null;
      }
    });

    if (Object.keys(updates).length > 0) {
      await update(ref(getDb()), updates);
      console.log("[NotificationCenterService] Cleaned non-parent notifications:", Object.keys(updates));
    }
  } catch (error) {
    console.error("[NotificationCenterService] Failed to cleanup non-parent notifications:", error);
  }
};

/**
 * Safely migrates legacy notifications from users/{uid}/notifications to notifications/{uid}/
 * without losing notification history, then removes notifications from the User entity.
 */
export const migrateUserNotifications = async (parentId) => {
  if (!parentId) return;
  try {
    const oldSnap = await get(ref(getDb(), `users/${parentId}/notifications`));
    if (oldSnap.exists() && oldSnap.val()) {
      const oldNotifs = oldSnap.val();
      const updates = {};
      Object.entries(oldNotifs).forEach(([key, notif]) => {
        const type = notif.type || notif.eventId || "INFO";
        const body = notif.body || notif.message || "";
        updates[`notifications/${parentId}/${key}`] = {
          id: key,
          parentId,
          type,
          title: notif.title || "Notification",
          body,
          message: body,
          createdAt: notif.createdAt || Date.now(),
          read: notif.read || false,
          reservationId: notif.reservationId || notif.entityId || null,
          branchId: notif.branchId || null,
          metadata: notif.metadata || null,
        };
      });
      // Remove legacy notification storage from User entity
      updates[`users/${parentId}/notifications`] = null;
      await update(ref(getDb()), updates);
      console.log(`[NotificationCenterService] Migrated ${Object.keys(oldNotifs).length} notifications for user ${parentId} to notifications/${parentId}`);
    }
  } catch (err) {
    console.error("[NotificationCenterService] Migration failed:", err);
  }
};

export const saveNotification = async (parentId, notificationData) => {
  if (!parentId) return null;
  try {
    // Parent-Only Phase guard: verify user role is 'parent' before creating notification records
    const roleSnapshot = await get(ref(getDb(), `users/${parentId}/role`));
    if (roleSnapshot.exists() && roleSnapshot.val() !== "parent") {
      return null;
    }

    // Use dedupeKey for cross-device idempotency, falling back to push() if none exists
    const safeKey = notificationData.dedupeKey 
      ? notificationData.dedupeKey.replace(/[.#$\[\]]/g, '_')
      : push(ref(getDb(), `notifications/${parentId}`)).key;
      
    const notifRef = ref(getDb(), `notifications/${parentId}/${safeKey}`);

    const type = notificationData.type || notificationData.eventId || "INFO";
    const body = notificationData.body || notificationData.message || "";
    const newNotif = {
      id: safeKey,
      parentId,
      type,
      title: notificationData.title || "Notification",
      body,
      message: body,
      createdAt: Date.now(),
      read: false,
      reservationId: notificationData.reservationId || notificationData.entityId || null,
      branchId: notificationData.branchId || null,
      metadata: notificationData.metadata || null,
      ...notificationData,
    };
    await update(notifRef, newNotif);
    return notifRef.key;
  } catch (error) {
    console.error("[NotificationCenterService] Failed to save notification:", error);
    return null;
  }
};

export const subscribeToUserNotifications = (parentId, callback) => {
  if (typeof callback !== "function") return () => {};
  if (!parentId) {
    callback([]);
    return () => {};
  }

  // Automatically migrate legacy notifications from User entity if any exist
  migrateUserNotifications(parentId);

  const notifRef = ref(getDb(), `notifications/${parentId}`);
  return subscribeOnValue(notifRef, (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.val();
      const list = Object.values(data)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      callback(list);
    } else {
      callback([]);
    }
  }, (error) => {
    console.error("[NotificationCenterService] Subscription error:", error);
    callback([]);
  });
};

export const markNotificationsAsRead = async (parentId, notificationIds = []) => {
  if (!parentId || !notificationIds || notificationIds.length === 0) return;
  try {
    const updates = {};
    notificationIds.forEach((id) => {
      updates[`notifications/${parentId}/${id}/read`] = true;
    });
    await update(ref(getDb()), updates);
  } catch (error) {
    console.error("[NotificationCenterService] Failed to mark notifications as read:", error);
  }
};

export const markAllNotificationsAsRead = async (parentId, notifications = []) => {
  if (!parentId || !notifications || notifications.length === 0) return;
  const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
  if (unreadIds.length > 0) {
    await markNotificationsAsRead(parentId, unreadIds);
  }
};
