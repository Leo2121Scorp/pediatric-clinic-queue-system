import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { ref, update, get } from "firebase/database";

import { auth } from "../firebase/auth";
import { getDb, setActiveDatabase } from "../firebase/database";
import { isPermissionDenied, safeUnsub, subscribeOnValue } from "../firebase/rtdbSubscribe";
import { cleanupPushSubscriptionOnLogout, registerPushSubscription } from "../services/pushService";
import { cacheNotificationPreferences } from "../services/notificationPreferencesService";
import {
    canParentSelfReactivate,
    isAccountLifecycleInProgress,
    reactivateSelfDeactivatedParent,
} from "../services/authService";
import { branchesMatch } from "../utils/stringUtils";

export const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [role, setRole] = useState(null);
    const [isDemo, setIsDemo] = useState(false);
    const [demoOperator, setDemoOperator] = useState(false);
    const [loading, setLoading] = useState(true);
    const profileRef = useRef(null);

    useEffect(() => {
        let unsubscribeDB = null;
        let activeTicket = 0;

        const unsubscribeAuth = onAuthStateChanged(
            auth,
            (currentUser) => {
                const ticket = ++activeTicket;
                if (unsubscribeDB) {
                    safeUnsub(unsubscribeDB);
                    unsubscribeDB = null;
                }

                if (currentUser) {
                    setLoading(true);
                    setUser(currentUser);

                    currentUser.getIdTokenResult(true).then((tokenResult) => {
                        const claims = tokenResult?.claims || {};
                        const demoAccount = claims.isDemo === true;
                        setActiveDatabase(demoAccount);
                        setIsDemo(demoAccount);
                        setDemoOperator(claims.demoOperator === true);
                    }).catch((err) => {
                        console.error("Failed to read auth claims:", err);
                        setActiveDatabase(false);
                        setIsDemo(false);
                        setDemoOperator(false);
                    }).finally(() => {
                    if (ticket !== activeTicket) return;
                    const userRef = ref(getDb(), `users/${currentUser.uid}`);
                    unsubscribeDB = subscribeOnValue(userRef, (snapshot) => {
                        if (snapshot.exists()) {
                            let userData = snapshot.val();
                            
                            // Phase 1 Schema Standardization: Auto-initialize missing fields safely
                            let needsUpdate = false;
                            const updates = {};
                            const now = Date.now();
                            
                            if (!userData.status) {
                                userData.status = "active";
                                updates.status = "active";
                                needsUpdate = true;
                            }
                            if (!userData.createdAt) {
                                userData.createdAt = now;
                                updates.createdAt = now;
                                needsUpdate = true;
                            }
                            if (!userData.updatedAt) {
                                userData.updatedAt = now;
                                updates.updatedAt = now;
                                needsUpdate = true;
                            }
                            if (userData.role === "secretary" && !userData.assignedBranch) {
                                userData.assignedBranch = "Angeles"; // Default mandatory branch for existing secretaries
                                updates.assignedBranch = "Angeles";
                                needsUpdate = true;
                            }

                            // Backfill assignedBranchId and sync display name after admin renames
                            if (userData.role === "secretary" && userData.assignedBranch) {
                                get(ref(getDb(), "branchConfigurations")).then((branchSnap) => {
                                    if (!branchSnap.exists()) return;
                                    const branches = Object.entries(branchSnap.val()).map(([id, value]) => ({ id, ...value }));
                                    const match = branches.find((b) =>
                                        (userData.assignedBranchId && b.id === userData.assignedBranchId) ||
                                        branchesMatch(b.name, userData.assignedBranch)
                                    );
                                    if (!match) return;
                                    const syncUpdates = {};
                                    if (userData.assignedBranchId !== match.id) {
                                        syncUpdates.assignedBranchId = match.id;
                                    }
                                    if (userData.assignedBranch !== match.name) {
                                        syncUpdates.assignedBranch = match.name;
                                    }
                                    if (Object.keys(syncUpdates).length > 0) {
                                        update(ref(getDb(), `users/${currentUser.uid}`), syncUpdates).catch(console.error);
                                    }
                                }).catch(console.error);
                            }
                            if (userData.role === "parent" && typeof userData.inAppNotificationsEnabled !== "boolean") {
                                userData.inAppNotificationsEnabled = true;
                                updates.inAppNotificationsEnabled = true;
                                needsUpdate = true;
                            }
                            
                            if (userData.role === "parent" && typeof userData.onboardingComplete !== "boolean") {
                                userData.onboardingComplete = true;
                                updates.onboardingComplete = true;
                                needsUpdate = true;
                            }
                            if (userData.role === "parent" && typeof userData.hasCompletedTour !== "boolean") {
                                userData.hasCompletedTour = userData.onboardingComplete !== false;
                                updates.hasCompletedTour = userData.hasCompletedTour;
                                needsUpdate = true;
                            }
                            if (
                                (userData.role === "secretary" || userData.role === "doctor") &&
                                typeof userData.hasCompletedTour !== "boolean"
                            ) {
                                userData.hasCompletedTour = true;
                                updates.hasCompletedTour = true;
                                needsUpdate = true;
                            }
                            
                            if (needsUpdate) {
                                // Background save, no need to await so it doesn't block login
                                update(ref(getDb(), `users/${currentUser.uid}`), updates).catch(console.error);
                            }

                            if (userData.isDeleted) {
                                if (!isAccountLifecycleInProgress()) {
                                    signOut(auth);
                                    import("react-hot-toast").then(({ toast }) => {
                                        toast.error("This account has been deleted.");
                                    });
                                }
                                setLoading(false);
                                return;
                            }

                            if (userData.status === "inactive") {
                                if (isAccountLifecycleInProgress()) {
                                    setLoading(false);
                                    return;
                                }
                                if (canParentSelfReactivate(userData)) {
                                    reactivateSelfDeactivatedParent(currentUser.uid).catch(console.error);
                                    userData = {
                                        ...userData,
                                        status: "active",
                                        deactivationSource: null,
                                    };
                                } else {
                                    signOut(auth);
                                    import("react-hot-toast").then(({ toast }) => {
                                        toast.error("This account has been deactivated. Please contact the clinic administrator.");
                                    });
                                    setLoading(false);
                                    return;
                                }
                            }

                            const enrichedUser = {
                                ...currentUser,
                                ...userData,
                                uid: currentUser.uid,
                                displayName: userData.name || currentUser?.displayName || userData.fullName,
                                fullName: userData.name || currentUser?.displayName || userData.fullName,
                                name: userData.name || currentUser?.displayName || userData.fullName,
                            };

                            setRole(userData.role);
                            profileRef.current = enrichedUser;
                            setUser(enrichedUser);
                            cacheNotificationPreferences(enrichedUser);

                            console.log("Role:", userData.role);
                        }
                        setLoading(false);
                    }, (error) => {
                        if (!isPermissionDenied(error)) {
                            console.error("Database read error in AuthContext:", error);
                        }
                        setLoading(false);
                    });
                    });
                } else {
                    const previous = profileRef.current;
                    profileRef.current = null;
                    setUser(null);
                    setRole(null);
                    setIsDemo(false);
                    setDemoOperator(false);
                    cacheNotificationPreferences(null);
                    const releaseDatabase = () => setActiveDatabase(false);
                    if (previous && previous.role === "parent") {
                        cleanupPushSubscriptionOnLogout(previous).catch(() => {}).finally(releaseDatabase);
                    } else {
                        releaseDatabase();
                    }
                    setLoading(false);
                }
            }
        );

        return () => {
            activeTicket += 1;
            if (unsubscribeDB) {
                safeUnsub(unsubscribeDB);
            }
            safeUnsub(unsubscribeAuth);
        };
    }, []);

    useEffect(() => {
        if (
            !user?.uid ||
            (user.role !== "parent" && user.role !== "doctor" && user.role !== "admin") ||
            typeof navigator === "undefined" ||
            !("serviceWorker" in navigator)
        ) {
            return undefined;
        }

        const onMessage = (event) => {
            if (event.data?.type === "PUSH_SUBSCRIPTION_CHANGED") {
                registerPushSubscription(user).catch(() => {});
            }
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    }, [user?.uid, user?.role]);

    const updateContextUser = useCallback((updates) => {
        setUser((prev) => {
            const next = { ...prev, ...updates };
            cacheNotificationPreferences(next);
            return next;
        });
    }, []);

    return (
        <AuthContext.Provider
            value={{
                user,
                role,
                isDemo,
                demoOperator,
                loading,
                updateContextUser
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}