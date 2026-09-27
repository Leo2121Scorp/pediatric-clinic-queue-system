import { Capacitor } from "@capacitor/core";
import { auth } from "../firebase/auth";
import { ref, update } from "firebase/database";
import { getDb } from "../firebase/database";
import { getNativeNotificationPermissionStatus, requestNativeNotificationPermission } from "./nativeNotificationService";
import { persistNotificationPreferences } from "./notificationPreferencesService";
const SW_PATH = "/sw.js";
const LEGACY_SW_PATH = "firebase-messaging-sw.js";
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

const debugLog = (message, ...args) => {
  if (import.meta.env.DEV || Capacitor.isNativePlatform()) {
    console.log(`[Push] ${message}`, ...args);
  }
};

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

export function getPushApiBase() {
  const explicit = import.meta.env.VITE_API_URL;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.replace(/\/$/, "");
  }
  // The installed app is served from the WebView origin, which has no /api rewrite.
  if (Capacitor.isNativePlatform()) {
    return "https://plus-queue.web.app";
  }
  return "";
}

export function isSecurePushContext() {
  if (typeof window === "undefined") return false;
  return window.isSecureContext || window.location.hostname === "localhost";
}

export function checkPushSupport() {
  if (typeof window === "undefined") return false;
  if (Capacitor.isNativePlatform()) return true;
  if (!isSecurePushContext()) return false;
  if (!("serviceWorker" in navigator)) return false;
  if (!("PushManager" in window)) return false;
  if (!("Notification" in window)) return false;
  return true;
}

export async function getOsNotificationPermissionStatus() {
  if (Capacitor.isNativePlatform()) {
    return getNativeNotificationPermissionStatus();
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export function isOsPermissionPromptable(status) {
  return status === "default" || status === "prompt";
}

export async function hasActivePushSubscription(uid) {
  if (Capacitor.isNativePlatform()) {
    const status = await getNativeNotificationPermissionStatus();
    return status === "granted";
  }
  if (!uid || !checkPushSupport()) return false;
  if (localStorage.getItem(localSubKeyName(uid))) return true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return Boolean(subscription);
  } catch (_err) {
    return false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function localSubKeyName(uid) {
  return `push_sub_key_${uid}`;
}

async function unregisterLegacyMessagingWorker() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.map(async (registration) => {
      const scriptUrl = registration.active?.scriptURL || registration.installing?.scriptURL || registration.waiting?.scriptURL || "";
      if (scriptUrl.includes(LEGACY_SW_PATH)) {
        debugLog("Unregistering legacy Firebase messaging SW");
        await registration.unregister();
      }
    })
  );
}

export async function registerPushServiceWorker() {
  if (!checkPushSupport()) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  await unregisterLegacyMessagingWorker();

  const registration = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  await navigator.serviceWorker.ready;
  debugLog("Service worker registered", registration.scope);
  return registration;
}

async function getAuthHeaders() {
  const currentUser = auth.currentUser;
  if (!currentUser) return {};
  try {
    const token = await currentUser.getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch (err) {
    debugLog("Failed to get ID token", err);
    return {};
  }
}

async function postSubscriptionToBackend(userId, subscription, action = "save") {
  const path = action === "delete" ? "/api/delete-subscription" : "/api/save-subscription";
  const url = `${getPushApiBase()}${path}`;
  const headers = {
    "Content-Type": "application/json",
    ...(await getAuthHeaders()),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId,
        subscription,
      }),
    });
    if (!response.ok) {
      debugLog(`Backend ${action} subscription failed`, response.status);
      return false;
    }
    return true;
  } catch (err) {
    debugLog(`Backend ${action} subscription unreachable`, err);
    return false;
  }
}

async function persistSubscriptionToDatabase(uid, subscriptionJson, extra = {}) {
  const key = await sha256Hex(subscriptionJson.endpoint);
  if (localStorage.getItem(localSubKeyName(uid)) === key) {
    await persistNotificationPreferences(uid, {
      notificationPermission: "granted",
      devicePushEnabled: true,
      notificationTokenUpdatedAt: Date.now(),
    });
    return key;
  }
  await update(ref(getDb(), `users/${uid}/pushSubscriptions/${key}`), {
    endpoint: subscriptionJson.endpoint,
    expirationTime: subscriptionJson.expirationTime || null,
    keys: subscriptionJson.keys || null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    updatedAt: Date.now(),
    createdAt: extra.createdAt || Date.now(),
  });
  await persistNotificationPreferences(uid, {
    notificationPermission: "granted",
    devicePushEnabled: true,
    notificationTokenUpdatedAt: Date.now(),
  });
  localStorage.setItem(localSubKeyName(uid), key);
  return key;
}

async function removeSubscriptionFromDatabase(uid, subscriptionJson) {
  const storedKey = localStorage.getItem(localSubKeyName(uid));
  const key = storedKey || (subscriptionJson?.endpoint ? await sha256Hex(subscriptionJson.endpoint) : null);
  if (!key) return;
  await update(ref(getDb(), `users/${uid}/pushSubscriptions`), {
    [key]: null,
  });
  localStorage.removeItem(localSubKeyName(uid));
  localStorage.removeItem(`fcm_token_key_${uid}`);
}

function isPushEligibleRole(role) {
  return role === "parent" || role === "doctor" || role === "admin";
}

/**
 * Request permission (must be called from a user gesture), subscribe with VAPID,
 * and persist the subscription to RTDB + the Express backend.
 * Parents: clinic workflow pushes. Doctors: suspicious-account abuse alerts only.
 */
export async function registerPushSubscription(user) {
  try {
    if (!user?.uid) return null;
    if (user.role && !isPushEligibleRole(user.role)) {
      debugLog("Skipping push registration for role:", user.role);
      return null;
    }

    if (Capacitor.isNativePlatform()) {
      const granted = await requestNativeNotificationPermission();
      if (granted) {
        try {
          await persistNotificationPreferences(user.uid, {
            notificationPermission: "granted",
            devicePushEnabled: true,
            notificationTokenUpdatedAt: Date.now(),
          });
        } catch (_err) {
          // Non-fatal.
        }
        debugLog("Native notification permission granted");
        return { native: true };
      }
      try {
        await persistNotificationPreferences(user.uid, {
          notificationPermission: "denied",
          devicePushEnabled: false,
        });
      } catch (_err) {
        // Non-fatal.
      }
      return null;
    }

    if (!checkPushSupport()) {
      debugLog("Browser does not support Web Push");
      return null;
    }
    if (!VAPID_PUBLIC_KEY) {
      debugLog("VITE_VAPID_PUBLIC_KEY is not configured");
      return null;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      try {
        await persistNotificationPreferences(user.uid, {
          notificationPermission: permission,
          devicePushEnabled: false,
        });
      } catch (_err) {
        // Non-fatal: in-app notifications still work.
      }
      return null;
    }

    const registration = await registerPushServiceWorker();
    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

    let subscription = await registration.pushManager.getSubscription();
    const expiringSoon =
      subscription?.expirationTime &&
      subscription.expirationTime < Date.now() + 24 * 60 * 60 * 1000;

    if (subscription && expiringSoon) {
      try {
        await subscription.unsubscribe();
      } catch (_err) {
        // Continue and try a fresh subscribe.
      }
      subscription = null;
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    const subscriptionJson = subscription.toJSON();
    if (!subscriptionJson?.endpoint || !subscriptionJson?.keys?.p256dh || !subscriptionJson?.keys?.auth) {
      debugLog("Subscription payload incomplete");
      return null;
    }

    await persistSubscriptionToDatabase(user.uid, subscriptionJson);
    postSubscriptionToBackend(user.uid, subscriptionJson, "save").catch(() => {});

    debugLog("Push subscription saved");
    return subscriptionJson;
  } catch (error) {
    debugLog("registerPushSubscription failed", error);
    return null;
  }
}

export async function disableDevicePush(user) {
  if (!user?.uid || (user.role && !isPushEligibleRole(user.role))) return;
  try {
    await persistNotificationPreferences(user.uid, {
      devicePushEnabled: false,
    });
    if (!Capacitor.isNativePlatform()) {
      await cleanupPushSubscriptionOnLogout(user);
    }
  } catch (error) {
    debugLog("disableDevicePush failed", error);
  }
}

/**
 * After parent login (or native cold start while permission is still undecided),
 * invoke the OS permission dialog and persist Allowed/Denied onto the user record.
 */
export async function requestPushPermissionAfterLogin(user) {
  try {
    if (!user?.uid || (user.role && !isPushEligibleRole(user.role))) return null;

    const status = await getOsNotificationPermissionStatus();
    if (status === "unsupported") return null;

    if (status === "denied") {
      await persistNotificationPreferences(user.uid, {
        notificationPermission: "denied",
        devicePushEnabled: false,
      });
      return null;
    }

    if (status === "granted") {
      await persistNotificationPreferences(user.uid, {
        notificationPermission: "granted",
      });
      if (user.devicePushEnabled === false) return null;
      return registerPushSubscription(user);
    }

    return registerPushSubscription(user);
  } catch (error) {
    debugLog("requestPushPermissionAfterLogin failed", error);
    return null;
  }
}

export async function cleanupPushSubscriptionOnLogout(user) {
  try {
    if (!user?.uid || (user.role && !isPushEligibleRole(user.role))) return;
    if (Capacitor.isNativePlatform()) return;
    if (!checkPushSupport()) {
      localStorage.removeItem(localSubKeyName(user.uid));
      return;
    }

    const registrations = await navigator.serviceWorker.getRegistrations();
    const registration = registrations.find((reg) => {
      const scriptUrl = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || "";
      return scriptUrl.includes(SW_PATH);
    }) || registrations[0];
    const subscription = await registration?.pushManager?.getSubscription();
    const subscriptionJson = subscription ? subscription.toJSON() : null;

    if (subscription) {
      try {
        await subscription.unsubscribe();
      } catch (err) {
        debugLog("Unsubscribe failed", err);
      }
    }

    await removeSubscriptionFromDatabase(user.uid, subscriptionJson);
    if (subscriptionJson) {
      postSubscriptionToBackend(user.uid, subscriptionJson, "delete").catch(() => {});
    }
  } catch (error) {
    debugLog("cleanupPushSubscriptionOnLogout failed", error);
  }
}

/** @deprecated Use registerPushSubscription. Kept so existing imports keep working. */
export const registerFcmTokenForParent = registerPushSubscription;
/** @deprecated Use cleanupPushSubscriptionOnLogout. */
export const cleanupFcmTokenOnLogout = cleanupPushSubscriptionOnLogout;
