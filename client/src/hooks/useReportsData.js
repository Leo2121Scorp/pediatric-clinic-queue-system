import { useState, useEffect, useMemo } from 'react';
import { getDb } from '../firebase/database';
import { ref, get } from 'firebase/database';
import { branchesMatch } from '../utils/stringUtils';
import { manilaDateString } from '../utils/manilaDate';

/** Parse YYYY-MM-DD as a local calendar date (avoids UTC shift from Date("YYYY-MM-DD")). */
const parseClinicDateLocal = (clinicDate) => {
  if (!clinicDate || typeof clinicDate !== 'string') return null;
  const parts = clinicDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [year, month, day] = parts;
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
};

export const useReportsData = () => {
  const [data, setData] = useState({
    schedules: [],
    reservations: [],
    processedDataset: []
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filter states — default This Year so current-year completed sessions are visible
  const [branchFilter, setBranchFilter] = useState("All Branches");
  const [dateRange, setDateRange] = useState("This Year"); // "Today", "This Week", "This Month", "This Year", "Custom Range"
  const [customDateRange, setCustomDateRange] = useState({ start: null, end: null });

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [schedulesSnap, reservationsSnap] = await Promise.all([
          get(ref(getDb(), "schedules")),
          get(ref(getDb(), "reservations"))
        ]);

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

        // Step 1: Filter only completed schedules
        // Reports should represent completed clinic sessions only
        const completedSchedules = rawSchedules.filter(s => 
          s.status === 'completed' || s.queueStatus === 'completed' || s.queueStatus === 'ended'
        );

        if (import.meta.env.DEV) {
          console.info("[useReportsData]", {
            totalSchedules: rawSchedules.length,
            completedSchedules: completedSchedules.length,
            totalReservations: rawReservations.length,
            walkInReservations: rawReservations.filter((r) => r.source === "walk_in").length,
          });
        }

        // Step 2 & 3: Link reservations and compute metrics
        const processed = completedSchedules.map(schedule => {
          // Link reservations exactly by scheduleId
          const scheduleReservations = rawReservations.filter(r => r.scheduleId === schedule.id);

          const totalReservations = scheduleReservations.length;
          
          // Reusing existing logic for Checked Up
          const checkedUp = scheduleReservations.filter(r => 
            ["completed", "consultation_completed"].includes(r.status)
          ).length;

          // Reusing existing logic for Cancelled
          const cancelled = scheduleReservations.filter(r => 
            r.status === 'cancelled'
          ).length;

          // Reusing existing logic for Forfeited
          const forfeited = scheduleReservations.filter(r => 
            ["forfeited", "penalized", "late_limit_reached"].includes(r.status)
          ).length;

          // Completion Rate Formula: Checked Up ÷ Total Reservations × 100
          // Return 0% if Total Reservations is zero
          const completionRate = totalReservations > 0 ? (checkedUp / totalReservations) * 100 : 0;

          return {
            ...schedule,
            metrics: {
              totalReservations,
              checkedUp,
              cancelled,
              forfeited,
              completionRate: parseFloat(completionRate.toFixed(2)) // 2 decimal precision
            }
          };
        });

        setData({
          schedules: completedSchedules,
          reservations: rawReservations,
          processedDataset: processed
        });

      } catch (err) {
        console.error("Error fetching reports data:", err);
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  // Step 4: Filters
  const filteredDataset = useMemo(() => {
    return data.processedDataset.filter(item => {
      // Branch filtering (normalized name match)
      if (branchFilter !== "All Branches" && !branchesMatch(item.branch, branchFilter)) {
        return false;
      }

      // Date Range filtering
      if (!item.clinicDate) return false;
      
      const itemDate = parseClinicDateLocal(item.clinicDate);
      if (!itemDate) return false;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const manilaToday = manilaDateString();

      if (dateRange === "Today") {
        if (item.clinicDate !== manilaToday) return false;
      } else if (dateRange === "This Week") {
        const dayOfWeek = today.getDay(); // 0 (Sun) to 6 (Sat)
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - dayOfWeek);
        startOfWeek.setHours(0, 0, 0, 0);
        
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        endOfWeek.setHours(23, 59, 59, 999);
        
        if (itemDate < startOfWeek || itemDate > endOfWeek) return false;
      } else if (dateRange === "This Month") {
        if (itemDate.getMonth() !== today.getMonth() || itemDate.getFullYear() !== today.getFullYear()) return false;
      } else if (dateRange === "This Year") {
        if (itemDate.getFullYear() !== today.getFullYear()) return false;
      } else if (dateRange === "Custom Range" && customDateRange.start && customDateRange.end) {
        const start = parseClinicDateLocal(customDateRange.start) || (() => {
          const d = new Date(customDateRange.start);
          d.setHours(0, 0, 0, 0);
          return d;
        })();
        const endParts = typeof customDateRange.end === 'string' ? customDateRange.end.split('-').map(Number) : null;
        let end;
        if (endParts && endParts.length === 3 && !endParts.some((n) => Number.isNaN(n))) {
          end = new Date(endParts[0], endParts[1] - 1, endParts[2]);
          end.setHours(23, 59, 59, 999);
        } else {
          end = new Date(customDateRange.end);
          end.setHours(23, 59, 59, 999);
        }
        if (itemDate < start || itemDate > end) return false;
      }

      return true;
    });
  }, [data.processedDataset, branchFilter, dateRange, customDateRange]);

  return {
    loading,
    error,
    dataset: filteredDataset,
    unfilteredDataset: data.processedDataset,
    filters: {
      branch: branchFilter,
      setBranch: setBranchFilter,
      dateRange: dateRange,
      setDateRange: setDateRange,
      customDateRange: customDateRange,
      setCustomDateRange: setCustomDateRange
    }
  };
};
