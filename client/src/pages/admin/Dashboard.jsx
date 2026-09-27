import React, { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import { CalendarDays, MapPin, Users, User, Activity, Clock } from "lucide-react";
import { ref, query, limitToLast } from "firebase/database";
import { getDb } from "../../firebase/database";
import { subscribeOnValue } from "../../firebase/rtdbSubscribe";
import { PqSpinner } from "../../components/parent/pqUi";
import { manilaDateString } from "../../utils/manilaDate";

const PREVIEW_LOG_COUNT = 8;
const PREVIEW_BRANCH_COUNT = 4;

const formatTime = (timeStr) => {
  if (!timeStr) return "";
  const [hours, minutes] = timeStr.split(":");
  const h = parseInt(hours, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const formattedHours = h % 12 || 12;
  return `${formattedHours}:${minutes} ${ampm}`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
};

const formatFeedTime = (timestamp) => {
  if (!timestamp) return "Unknown";
  const d = new Date(timestamp);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(d);
};

const getTodayStr = () => manilaDateString();

const pickRelevantSchedule = (publishedList, todayStr) => {
  const currentlyOperating = publishedList.filter((s) =>
    ["active", "paused", "closed"].includes(s.queueStatus)
  );

  if (currentlyOperating.length > 0) {
    currentlyOperating.sort((a, b) => {
      const statePriority = { active: 1, paused: 2, closed: 3 };
      const pA = statePriority[a.queueStatus] || 99;
      const pB = statePriority[b.queueStatus] || 99;
      if (pA !== pB) return pA - pB;
      const dateA = new Date(a.clinicDate).getTime();
      const dateB = new Date(b.clinicDate).getTime();
      if (dateA !== dateB) return dateA - dateB;
      return (a.openingTime || "").localeCompare(b.openingTime || "");
    });
    return currentlyOperating[0];
  }

  const todaySchedules = publishedList.filter((s) => s.clinicDate === todayStr);
  if (todaySchedules.length > 0) {
    todaySchedules.sort((a, b) => (a.openingTime || "").localeCompare(b.openingTime || ""));
    return todaySchedules[0];
  }

  const upcomingSchedules = publishedList.filter((s) => s.clinicDate > todayStr);
  if (upcomingSchedules.length > 0) {
    upcomingSchedules.sort((a, b) => {
      const dateA = new Date(a.clinicDate).getTime();
      const dateB = new Date(b.clinicDate).getTime();
      if (dateA !== dateB) return dateA - dateB;
      return (a.openingTime || "").localeCompare(b.openingTime || "");
    });
    return upcomingSchedules[0];
  }

  return null;
};

const operationLabel = (schedule) => {
  if (!schedule) return null;
  if (schedule.queueStatus === "active") return "Queue Active";
  if (schedule.queueStatus === "paused") return "Queue Paused";
  if (schedule.queueStatus === "closed") return "Queue Closed";
  return "Schedule Published";
};

const formatOperation = (schedule, branchName) => {
  if (!schedule) {
    return { branchName, state: null, date: "", timeStr: "" };
  }
  return {
    branchName: branchName || schedule.branch || "Unknown Branch",
    state: operationLabel(schedule),
    date: formatDate(schedule.clinicDate),
    timeStr: `${formatTime(schedule.openingTime)} – ${formatTime(schedule.closingTime)}`,
  };
};

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({
    registeredParents: 0,
    activeStaff: 0,
    branches: 0,
  });
  const [branchList, setBranchList] = useState([]);
  const [branchOperations, setBranchOperations] = useState([]);

  const [recentLogs, setRecentLogs] = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState(null);

  useEffect(() => {
    const usersRef = ref(getDb(), "users");
    const schedulesRef = ref(getDb(), "schedules");
    const branchesRef = ref(getDb(), "branchConfigurations");

    let usersData = {};
    let schedulesData = {};
    let branchesData = {};

    let usersLoaded = false;
    let schedulesLoaded = false;
    let branchesLoaded = false;

    const computeStats = () => {
      if (!usersLoaded || !schedulesLoaded || !branchesLoaded) return;

      const usersList = Object.values(usersData || {});
      const schedulesList = Object.values(schedulesData || {});

      const registeredParents = usersList.filter((u) => u.role === "parent").length;

      const activeStaff = usersList.filter((u) =>
        (u.role === "doctor" || u.role === "secretary") && u.status === "active"
      ).length;

      const mappedBranches = Object.entries(branchesData || {}).map(([id, value]) => ({
        id,
        ...(value || {}),
      }));
      mappedBranches.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      setBranchList(mappedBranches);
      setStats({
        registeredParents,
        activeStaff,
        branches: mappedBranches.length,
      });

      const todayStr = getTodayStr();
      const publishedList = schedulesList.filter((s) => s.status === "published");

      setBranchOperations(
        mappedBranches.map((branch) => {
          const forBranch = publishedList.filter((s) => s.branch === branch.name);
          return formatOperation(pickRelevantSchedule(forBranch, todayStr), branch.name);
        })
      );

      setLoading(false);
    };

    const handleError = (err) => {
      console.error("Firebase Read Error:", err);
      setError("Failed to load dashboard data. You may not have permission.");
      setLoading(false);
    };

    const unsubUsers = subscribeOnValue(usersRef, (snapshot) => {
      usersData = snapshot.val();
      usersLoaded = true;
      setError(null);
      computeStats();
    }, handleError);

    const unsubSchedules = subscribeOnValue(schedulesRef, (snapshot) => {
      schedulesData = snapshot.val();
      schedulesLoaded = true;
      computeStats();
    }, handleError);

    const unsubBranches = subscribeOnValue(branchesRef, (snapshot) => {
      branchesData = snapshot.val();
      branchesLoaded = true;
      computeStats();
    }, handleError);

    return () => {
      unsubUsers();
      unsubSchedules();
      unsubBranches();
    };
  }, []);

  useEffect(() => {
    const auditRef = query(ref(getDb(), "auditLogs"), limitToLast(PREVIEW_LOG_COUNT));
    const unsubscribe = subscribeOnValue(auditRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const logsList = Object.keys(data).map((key) => ({
          id: key,
          ...data[key]
        }));
        logsList.sort((a, b) => b.timestamp - a.timestamp);
        setRecentLogs(logsList.slice(0, PREVIEW_LOG_COUNT));
      } else {
        setRecentLogs([]);
      }
      setActivityError(null);
      setActivityLoading(false);
    }, (err) => {
      console.error("Failed to load recent activity", err);
      setActivityError("Couldn't load recent audit logs.");
      setActivityLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const statCards = [
    { title: "Registered Parents", value: stats.registeredParents, icon: User, tone: "info" },
    { title: "Active Staff", value: stats.activeStaff, icon: Users, tone: "default" },
    { title: "Clinic Branches", value: stats.branches, icon: MapPin, tone: "default" },
  ];

  const statClass = (tone) => {
    if (tone === "live") return "pq-stat pq-stat-live";
    if (tone === "info") return "pq-stat pq-stat-info";
    return "pq-stat";
  };

  const previewBranches = branchList.slice(0, PREVIEW_BRANCH_COUNT);
  const extraBranchCount = Math.max(0, branchList.length - previewBranches.length);

  if (loading && !error) {
    return (
      <div className="pq-glass p-10">
        <PqSpinner label="Loading dashboard" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      {error && (
        <div className="pq-note pq-note-alert flex items-center gap-3">
          <Activity className="w-5 h-5 shrink-0" aria-hidden="true" />
          <p className="font-medium text-sm leading-snug">{error}</p>
        </div>
      )}

      <section className="pq-glass p-5">
        <h2 className="text-lg font-extrabold tracking-tight mb-4">System Overview</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {statCards.map((stat) => (
            <div key={stat.title} className={statClass(stat.tone)}>
              <span className="pq-stat-label flex items-center gap-1">
                <stat.icon className="w-3.5 h-3.5" aria-hidden="true" />
                {stat.title}
              </span>
              <span className="pq-stat-value">{stat.value}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="pq-glass p-6 lg:p-8">
          <h2 className="text-lg font-extrabold tracking-tight mb-5">Current Clinic Operation</h2>
          {branchOperations.length === 0 ? (
            <div className="text-center py-8">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                style={{ background: "color-mix(in srgb, #ffffff 55%, transparent)", color: "var(--pq-ink-faint)" }}
              >
                <Activity className="w-8 h-8" aria-hidden="true" />
              </div>
              <h3 className="text-xl font-extrabold tracking-tight mb-2">No branches yet</h3>
              <p className="pq-muted max-w-md mx-auto">
                Add a branch to see clinic sessions here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {branchOperations.map((operation) => (
                <div
                  key={operation.branchName}
                  className="pq-row items-start sm:items-center flex-col sm:flex-row"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 leading-none">
                      {operation.state === "Queue Active" ? (
                        <span className="pq-pip" aria-hidden="true" />
                      ) : (
                        <MapPin className="w-4 h-4 pq-faint shrink-0" aria-hidden="true" />
                      )}
                      <p className="font-extrabold tracking-tight truncate">{operation.branchName}</p>
                    </div>
                    <p className="text-sm font-semibold mt-1">
                      {operation.state || "No published session"}
                    </p>
                  </div>
                  {operation.state ? (
                    <div className="text-sm font-medium pq-muted shrink-0">
                      <div className="flex items-center gap-2 leading-none">
                        <CalendarDays className="w-4 h-4" style={{ color: "var(--pq-mark-blue)" }} aria-hidden="true" />
                        {operation.date}
                      </div>
                      <div className="flex items-center gap-2 leading-none mt-1.5">
                        <Clock className="w-4 h-4" style={{ color: "var(--pq-live)" }} aria-hidden="true" />
                        {operation.timeStr}
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="pq-glass p-6 lg:p-8 flex flex-col">
          <div className="flex items-center justify-between gap-3 mb-5">
            <h2 className="text-lg font-extrabold tracking-tight">Clinic Branches</h2>
            <NavLink to="/admin/branches" className="pq-btn-ghost shrink-0" aria-label="Manage clinic branches">
              Manage
            </NavLink>
          </div>

          {previewBranches.length === 0 ? (
            <div className="pq-row flex-col items-center text-center min-h-0 py-8 flex-1 justify-center">
              <MapPin className="w-8 h-8 pq-faint mb-3" aria-hidden="true" />
              <p className="font-extrabold tracking-tight">No branches yet</p>
              <p className="text-sm pq-muted mt-1">Add a branch to start clinic operations.</p>
            </div>
          ) : (
            <div className="space-y-2 flex-1">
              {previewBranches.map((branch) => (
                <div key={branch.id} className="pq-row">
                  <div className="min-w-0">
                    <p className="font-extrabold tracking-tight truncate">{branch.name || "Unnamed branch"}</p>
                    <p className="text-sm pq-muted truncate">
                      {branch.clinicAddress || "No clinic address provided."}
                    </p>
                  </div>
                </div>
              ))}
              {extraBranchCount > 0 ? (
                <p className="text-sm pq-muted font-medium pt-1">
                  +{extraBranchCount} more {extraBranchCount === 1 ? "branch" : "branches"}
                </p>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <section className="pq-glass p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-extrabold tracking-tight">Recent Audit Logs</h2>
          <NavLink to="/admin/audit-logs" className="pq-btn-secondary shrink-0" aria-label="View all audit logs">
            View all
          </NavLink>
        </div>

        {activityError ? (
          <div className="pq-note pq-note-alert">
            <p className="font-medium text-sm">{activityError}</p>
          </div>
        ) : activityLoading ? (
          <PqSpinner label="Loading recent audit logs" />
        ) : recentLogs.length === 0 ? (
          <div className="pq-row flex-col items-center text-center min-h-0 py-10">
            <Activity className="w-8 h-8 pq-faint mb-3" aria-hidden="true" />
            <p className="font-extrabold tracking-tight">No audit logs yet</p>
            <p className="text-sm pq-muted mt-1 max-w-sm">
              Staff and admin actions will appear here as they happen.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {recentLogs.map((log) => (
              <li key={log.id} className="pq-row items-start">
                <div className="min-w-0">
                  <p className="text-xs font-extrabold pq-muted uppercase tracking-wider mb-0.5">
                    {formatFeedTime(log.timestamp)}
                  </p>
                  <p className="text-sm font-medium break-words">{log.description}</p>
                  <p className="text-xs pq-muted mt-1 font-medium truncate">
                    {log.actorName}
                    {log.actorRole ? ` · ${log.actorRole}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
