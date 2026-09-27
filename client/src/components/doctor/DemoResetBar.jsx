import { useState } from "react";
import { getFunctions, httpsCallable } from "firebase/functions";
import toast from "react-hot-toast";
import app from "../../firebase/firebaseConfig";
import { useAuth } from "../../hooks/useAuth";
import { manilaDateString } from "../../utils/manilaDate";

export default function DemoResetBar() {
  const { demoOperator } = useAuth();
  const [clinicDate, setClinicDate] = useState(() => manilaDateString());
  const [busy, setBusy] = useState(false);

  if (!demoOperator) return null;

  const resetDay = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clinicDate)) {
      toast.error("Enter a clinic date as YYYY-MM-DD.");
      return;
    }
    setBusy(true);
    try {
      const functions = getFunctions(app, "asia-southeast1");
      const resetDemoClinicDay = httpsCallable(functions, "resetDemoClinicDay");
      const result = await resetDemoClinicDay({ clinicDate });
      toast.success(result.data?.message || "Demo day reset.");
    } catch (err) {
      toast.error(err?.message || "Could not reset the demo day.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-300/80 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="font-semibold">Demo database</p>
        <p className="mt-1 text-amber-900/80">
          Reset one clinic date in the demo database so that day can be rehearsed again.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="demo-reset-date">Clinic date</label>
        <input
          id="demo-reset-date"
          type="date"
          value={clinicDate}
          onChange={(event) => setClinicDate(event.target.value)}
          className="rounded-lg border border-amber-300 bg-white px-3 py-2"
        />
        <button type="button" className="pq-btn-secondary" onClick={resetDay} disabled={busy}>
          {busy ? "Resetting..." : "Reset demo day"}
        </button>
      </div>
    </div>
  );
}
