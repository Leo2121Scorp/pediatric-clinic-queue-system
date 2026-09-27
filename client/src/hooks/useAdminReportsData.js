import { useState, useEffect, useMemo } from 'react';
import { getDb } from '../firebase/database';
import { ref, get } from 'firebase/database';

export const useAdminReportsData = () => {
  const [data, setData] = useState({
    users: [],
    schedules: [],
    reservations: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [dateRange, setDateRange] = useState("This Month"); // "This Month", "Last 3 Months", "This Year", "All Time"

  // Fetch only once on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [usersSnap, schedulesSnap, reservationsSnap] = await Promise.all([
          get(ref(getDb(), "users")),
          get(ref(getDb(), "schedules")),
          get(ref(getDb(), "reservations"))
        ]);

        let rawUsers = [];
        if (usersSnap.exists()) {
          const uVals = usersSnap.val();
          rawUsers = Object.entries(uVals).map(([id, val]) => ({ id, ...val }));
        }

        let rawSchedules = [];
        if (schedulesSnap.exists()) {
          const sVals = schedulesSnap.val();
          rawSchedules = Object.entries(sVals).map(([id, val]) => ({ id, ...val }));
        }

        let rawReservations = [];
        if (reservationsSnap.exists()) {
          const rVals = reservationsSnap.val();
          rawReservations = Object.entries(rVals).map(([id, val]) => ({ id, ...val }));
        }

        setData({
          users: rawUsers,
          schedules: rawSchedules,
          reservations: rawReservations
        });
      } catch (err) {
        console.error("Error fetching admin reports data:", err);
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  // Compute metrics based on dateRange
  const metrics = useMemo(() => {
    if (!data.users.length && !data.schedules.length && !data.reservations.length) {
      return { kpis: null, adoptionData: [], branchData: [], outcomeData: [], hasData: false };
    }

    const now = new Date();
    let startDate = new Date(0); // All time

    if (dateRange === "This Month") {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (dateRange === "Last 3 Months") {
      startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    } else if (dateRange === "This Year") {
      startDate = new Date(now.getFullYear(), 0, 1);
    }

    // 1. Filter Data by Date
    // Users
    const filteredUsers = data.users.filter(u => {
      const createdAt = u.createdAt ? new Date(u.createdAt) : new Date(0);
      return createdAt >= startDate;
    });

    // Schedules
    const filteredSchedules = data.schedules.filter(s => {
      const clinicDate = s.clinicDate ? new Date(s.clinicDate) : new Date(0);
      // We only want completed sessions for utilization/outcomes
      const isCompleted = s.status === 'completed' || s.queueStatus === 'completed' || s.queueStatus === 'ended';
      return clinicDate >= startDate && isCompleted;
    });

    const validScheduleIds = new Set(filteredSchedules.map(s => s.id));

    // Reservations (linked to completed filtered schedules)
    const filteredReservations = data.reservations.filter(r => validScheduleIds.has(r.scheduleId));

    // 2. Compute KPIs
    const totalParents = data.users.filter(u => u.role === "parent").length;
    const totalSessions = filteredSchedules.length;
    const totalReservations = filteredReservations.length;

    // 3. Parent Adoption Trend
    const adoptionMap = {};
    const parents = filteredUsers.filter(u => u.role === "parent");
    
    parents.forEach(p => {
      const d = p.createdAt ? new Date(p.createdAt) : new Date(0);
      // Format by month/year for macro view (e.g., "Aug 2026")
      // If date range is "This Month" or "Last 3 Months", we format by day (e.g., "Aug 1")
      let key = "";
      if (dateRange === "This Month" || dateRange === "Last 3 Months") {
        key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } else {
        key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      }
      
      if (!adoptionMap[key]) adoptionMap[key] = { dateKey: d.getTime(), label: key, users: 0 };
      adoptionMap[key].users += 1;
    });

    const adoptionData = Object.values(adoptionMap)
      .sort((a, b) => a.dateKey - b.dateKey)
      .map(item => ({ date: item.label, users: item.users }));

    // 4. Branch Utilization
    const branchMap = {};
    filteredSchedules.forEach(s => {
      const branch = s.branch || "Unknown";
      if (!branchMap[branch]) branchMap[branch] = { branch, schedules: 0, reservations: 0 };
      branchMap[branch].schedules += 1;
    });
    
    filteredReservations.forEach(r => {
      const schedule = filteredSchedules.find(s => s.id === r.scheduleId);
      if (schedule) {
        const branch = schedule.branch || "Unknown";
        if (branchMap[branch]) {
          branchMap[branch].reservations += 1;
        }
      }
    });

    const branchData = Object.values(branchMap).sort((a, b) => b.reservations - a.reservations);

    // 5. Global Outcomes
    let checkedUp = 0;
    let cancelled = 0;
    let forfeited = 0;

    filteredReservations.forEach(r => {
      // Checked Up statuses
      if (["completed", "consultation_completed"].includes(r.status)) {
        checkedUp++;
      } 
      // Cancelled status
      else if (r.status === "cancelled") {
        cancelled++;
      } 
      // Forfeited statuses (expired, validation_expired, or forfeited by exceeding penalty limit)
      // Note: 'penalized' is NOT a status, it's just a metadata state
      else if (["forfeited", "expired", "validation_expired"].includes(r.status)) {
        forfeited++;
      }
    });

    const outcomeData = [
      { name: 'Checked Up', value: checkedUp, color: '#16a34a' },
      { name: 'Cancelled', value: cancelled, color: '#dc2626' },
      { name: 'Forfeited', value: forfeited, color: '#ea580c' },
    ].filter(item => item.value > 0);

    const hasData = totalParents > 0 || totalSessions > 0 || totalReservations > 0;

    return {
      kpis: {
        totalParents,
        totalSessions,
        totalReservations
      },
      adoptionData,
      branchData,
      outcomeData,
      hasData
    };
  }, [data, dateRange]);

  return {
    loading,
    error,
    metrics,
    filters: {
      dateRange,
      setDateRange
    }
  };
};
