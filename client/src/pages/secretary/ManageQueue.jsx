import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Users, UserCheck, UserPlus, Clock, CheckCircle, Activity, PlayCircle, AlertTriangle, Monitor } from "lucide-react";
import { subscribeToScheduleReservations, startConsultation, sendToDoctor, penalizeReservation, requestCheckInReminder, cancelReservation, forfeitReservationIfTimerExpired, ACTIVE_RESERVATION_STATUSES } from "../../services/reservationService";
import { subscribeToPublishedSchedules } from "../../services/scheduleService";
import { subscribeToQueueConfiguration } from "../../services/systemConfigurationService";
import { computeReservationState, QUEUE_STATES, sortActiveQueue, recalculateEntireQueue } from "../../services/queueEngine";
import { useAuth } from "../../hooks/useAuth";
import { get, ref } from "firebase/database";
import { getDb } from "../../firebase/database";
import toast from "react-hot-toast";
import { getReservationChildDisplayName } from "../../utils/reservationPatients";
import ReservationPatientNames from "../../components/common/ReservationPatientNames";
import QueueSessionControls from "../../components/common/QueueSessionControls";
import StartTodayQueue from "../../components/common/StartTodayQueue";
import ConfirmationModal from "../../components/common/ConfirmationModal";
import ModalScrim from "../../components/common/ModalScrim";
import WalkInPatientModal from "../../components/secretary/WalkInPatientModal";
import { scheduleMatchesAssignedBranch } from "../../utils/stringUtils";
import { PqSpinner } from "../../components/parent/pqUi";
import { useHistoryOverlay } from "../../hooks/useHistoryOverlay";
import { useTourSample } from "../../hooks/useTourPreview";
import { TourSampleManageQueue, TourSampleWalkInModal } from "../../components/onboarding/SecretaryTourSampleViews";
import { getServerTime, formatRemainingTime } from "../../services/timeService";
import {
  getPenaltyTimerRemainingMs,
  getPenaltyGraceRemainingMs,
  isPenaltyGraceElapsed,
  isLiveQueueStatus,
  isWalkInReservation as isWalkInReservationUtil,
} from "../../utils/penaltyTimer";

const isWalkInReservation = (res) => isWalkInReservationUtil(res);

function QueuePageIntro({ branchName }) {
  return (
    <div className="@container">
      <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-start @3xl:justify-between">
        <p className="text-sm pq-muted min-w-0 flex-1 leading-relaxed">
          Control patient flow and consultations for your assigned branch:{" "}
          <span className="font-extrabold" style={{ color: "var(--pq-ink)" }}>{branchName}</span>.
        </p>
        <a
          href="/secretary/monitor"
          target="_blank"
          rel="noopener noreferrer"
          data-tour="queue-monitor"
          className="pq-btn-secondary shrink-0 self-start"
          aria-label="Live Queue Monitor (opens in a new tab)"
        >
          <Monitor className="w-4 h-4" aria-hidden="true" />
          <span>Live Queue Monitor</span>
        </a>
      </div>
    </div>
  );
}

function formatElapsedHms(startedAt, nowTs) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return "00:00:00";
  const totalSec = Math.max(0, Math.floor((nowTs - start) / 1000));
  const hours = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSec % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function SessionDurationMeter({ startedAt, nowTs, className = "" }) {
  return (
    <div className={`pq-row min-h-11 ${className}`.trim()}>
      <span className="text-sm font-semibold pq-muted">Session Duration</span>
      <span className="pq-num text-[0.95rem] font-extrabold tracking-tight">
        {formatElapsedHms(startedAt, nowTs)}
      </span>
    </div>
  );
}

export default function ManageQueue({ hideHeader = false }) {
  const { user } = useAuth();
  const showQueueSample = useTourSample([
    "queue-start",
    "queue-list",
    "queue-penalize",
    "queue-control",
    "queue-request-checkin",
    "queue-send-to-doctor",
    "walkin-open",
    "walkin-form",
  ]);
  const showWalkInFormSample = useTourSample(["walkin-form"]);
  const [reservations, setReservations] = useState([]);
  const [schedules, setSchedules] = useState({});
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [reservationsLoaded, setReservationsLoaded] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [requestingCheckIn, setRequestingCheckIn] = useState(false);
  const [penaltyMoveBack, setPenaltyMoveBack] = useState(2);
  const [penaltyGraceMinutes, setPenaltyGraceMinutes] = useState(2);
  const [nowTs, setNowTs] = useState(Date.now());
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [parentContactInfo, setParentContactInfo] = useState(null);
  const [loadingContactInfo, setLoadingContactInfo] = useState(false);
  const [contactIsWalkIn, setContactIsWalkIn] = useState(false);
  const [contactReservation, setContactReservation] = useState(null);
  const [isCancelConfirmOpen, setIsCancelConfirmOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isWalkInOpen, setIsWalkInOpen] = useState(false);
  const forfeitingRef = useRef(new Set());
  const penalizeLockRef = useRef(false);
  const currentTurnStampRef = useRef(null);

  const closeContactModal = () => {
    if (isCancelling) return;
    setIsContactModalOpen(false);
    setContactReservation(null);
    setParentContactInfo(null);
    setContactIsWalkIn(false);
    setIsCancelConfirmOpen(false);
  };
  useHistoryOverlay(isContactModalOpen, closeContactModal);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isContactModalOpen && !isCancelConfirmOpen && !isCancelling) {
        closeContactModal();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isContactModalOpen, isCancelConfirmOpen, isCancelling]);

  useEffect(() => {
    const timer = setInterval(() => setNowTs(getServerTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubSchedules = subscribeToPublishedSchedules((data) => {
      const schedulesMap = {};
      data.forEach(s => schedulesMap[s.id] = s);
      setSchedules(schedulesMap);
      setSchedulesLoaded(true);
    });

    const unsubConfig = subscribeToQueueConfiguration(user?.assignedBranchId, (config) => {
      setPenaltyMoveBack(config.penaltyMoveBack);
      setPenaltyGraceMinutes(config.penaltyGraceMinutes);
    });

    return () => {
      unsubSchedules();
      unsubConfig();
    };
  }, [user?.assignedBranchId]);

  // Find active schedule started by the Doctor for the secretary's assigned branch
  const activeStartedSchedule = Object.values(schedules).find(s =>
    s.status === "published" && 
    ["active", "paused", "closed"].includes(s.queueStatus) &&
    scheduleMatchesAssignedBranch(s, user)
  );

  useEffect(() => {
    if (!activeStartedSchedule) {
      setReservations([]);
      setReservationsLoaded(false);
      currentTurnStampRef.current = null;
      return;
    }

    setReservationsLoaded(false);
    currentTurnStampRef.current = null;
    const unsubReservations = subscribeToScheduleReservations(activeStartedSchedule.id, (data) => {
      setReservations(data);
      setReservationsLoaded(true);
    });

    return () => unsubReservations();
  }, [activeStartedSchedule?.id]);

  // Heal queues that went live before becameCurrentTurnAt stamping existed / ran.
  useEffect(() => {
    if (!activeStartedSchedule?.id || !reservationsLoaded) return;
    if (!isLiveQueueStatus(activeStartedSchedule.queueStatus)) return;

    const waiting = sortActiveQueue(
      reservations.filter((r) => ["checked_in", "reserved", "waiting"].includes(r.status))
    );
    const firstUncheckedIdx = waiting.findIndex(
      (r) => r.status === "reserved" || r.status === "waiting"
    );
    const firstWaitingIsWalkIn = waiting[0]?.source === "walk_in";
    const targetIdx = firstWaitingIsWalkIn ? 0 : firstUncheckedIdx;
    const target = targetIdx >= 0 ? waiting[targetIdx] : null;

    if (!target) {
      currentTurnStampRef.current = null;
      return;
    }
    if (target.becameCurrentTurnAt) {
      currentTurnStampRef.current = target.id;
      return;
    }
    if (currentTurnStampRef.current === target.id) return;

    const targetId = target.id;
    currentTurnStampRef.current = targetId;
    recalculateEntireQueue(activeStartedSchedule.id).catch((err) => {
      if (currentTurnStampRef.current === targetId) {
        currentTurnStampRef.current = null;
      }
      console.error("Failed to stamp current-turn grace timer", err);
    });
  }, [activeStartedSchedule?.id, activeStartedSchedule?.queueStatus, reservations, reservationsLoaded]);

  useEffect(() => {
    reservations.forEach((r) => {
      const expiresAt = Number(r.penaltyTimerExpiresAt) || 0;
      if (!expiresAt || expiresAt > nowTs) return;
      if (forfeitingRef.current.has(r.id)) return;
      forfeitingRef.current.add(r.id);
      forfeitReservationIfTimerExpired(r.id)
        .catch((err) => console.error("Failed to forfeit expired penalty timer", err))
        .finally(() => forfeitingRef.current.delete(r.id));
    });
  }, [reservations, nowTs]);

  const loading = !schedulesLoaded || (!!activeStartedSchedule && !reservationsLoaded);

  if (showQueueSample) {
    return (
      <div className="space-y-6 pb-8">
        {!hideHeader && <QueuePageIntro branchName={user.assignedBranch} />}
        <TourSampleManageQueue />
        {showWalkInFormSample ? <TourSampleWalkInModal /> : null}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="pq-glass p-10">
        <PqSpinner label="Loading queue" />
      </div>
    );
  }

  if (!activeStartedSchedule) {
    return (
      <div className="space-y-6 pb-8">
        {!hideHeader && <QueuePageIntro branchName={user.assignedBranch} />}

        <div className="pq-glass p-12 text-center max-w-xl mx-auto">
          <Clock className="w-12 h-12 pq-faint mx-auto mb-4" aria-hidden="true" />
          <h2 className="text-xl font-extrabold tracking-tight mb-2">No Active Queue For {user.assignedBranch}</h2>
          <p className="pq-muted text-sm leading-relaxed max-w-md mx-auto mb-6">
            No queue is running for {user.assignedBranch}. Start today's published schedule here, or open the calendar to publish or close a day.
          </p>
          <StartTodayQueue schedules={schedules} user={user} limitToAssignedBranch />
          <Link to="/secretary/schedules" className="pq-btn-secondary">Open schedule calendar</Link>
        </div>
      </div>
    );
  }

  // Active queue for today's started schedule
  const activeReservations = reservations.filter(r => r.scheduleId === activeStartedSchedule.id);
  
  // Region 1 data: Current active consultation(s) / with doctor
  const inConsultationPatients = activeReservations.filter(r => r.status === "in_consultation" || r.status === "with_doctor");

  // Region 2 data: Remaining patients waiting in line sorted by current queue order (turn in line)
  const waitingQueue = sortActiveQueue(
    activeReservations.filter(r => ["checked_in", "reserved", "waiting"].includes(r.status))
  );

  const firstUncheckedIdx = waitingQueue.findIndex(
    (r) => r.status === "reserved" || r.status === "waiting"
  );
  const firstWaitingIsWalkIn = waitingQueue[0]?.source === "walk_in";
  const penalizeTargetIdx = firstWaitingIsWalkIn ? 0 : firstUncheckedIdx;

  const formatTime = (timestamp) => {
    if (!timestamp) return "N/A";
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderStatusBadge = (status) => {
    switch (status) {
      case "with_doctor":
        return (
          <span className="pq-chip pq-chip-live shrink-0">
            <span className="pq-pip" style={{ width: 6, height: 6 }} />
            With Doctor
          </span>
        );
      case "in_consultation":
        return (
          <span className="pq-chip pq-chip-info shrink-0">
            <span className="pq-pip" style={{ width: 6, height: 6 }} />
            In Consultation
          </span>
        );
      case "checked_in":
        return (
          <span className="pq-chip pq-chip-live shrink-0">
            <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
            Checked In
          </span>
        );
      case "reserved":
      case "waiting":
        return (
          <span className="pq-chip pq-chip-wait shrink-0">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            Not Checked In
          </span>
        );
      default:
        return null;
    }
  };

  const handleSendToDoctor = async (res) => {
    try {
      setActionLoading(res.id);
      await sendToDoctor(res.id);
      toast.success(`Sent ${getReservationChildDisplayName(res, "patient")} to Doctor room`);
    } catch (err) {
      toast.error("Failed to send patient to Doctor");
    } finally {
      setActionLoading(null);
    }
  };

  const handlePenalize = async (res) => {
    if (!res?.id || penalizeLockRef.current || actionLoading) return;
    penalizeLockRef.current = true;
    try {
      setActionLoading(res.id);
      const schedule = schedules[res.scheduleId] || {};
      await penalizeReservation(res.id, schedule, reservations, penaltyMoveBack);
      if (penaltyMoveBack === 0) {
        toast.error(`${getReservationChildDisplayName(res, "Patient")} was forfeited because Penalty Move-Back is 0.`);
      } else {
        toast.success(`Penalty applied to ${getReservationChildDisplayName(res, "Patient")}. Moved back in queue and late timer started.`);
      }
    } catch (err) {
      toast.error("Failed to apply penalty");
    } finally {
      penalizeLockRef.current = false;
      setActionLoading(null);
    }
  };

  const getNextEligibleCheckIn = () => {
    const awaitingPatients = activeReservations
      .filter((r) =>
        !["checked_in", "with_doctor", "in_consultation", "completed", "consultation_completed", "cancelled", "forfeited", "penalized", "late_limit_reached"].includes(r.status)
      )
      .sort((a, b) => {
        const timeA = a.sortTimestamp || a.createdAt || 0;
        const timeB = b.sortTimestamp || b.createdAt || 0;
        return timeA - timeB;
      });
    return awaitingPatients[0];
  };

  const nextEligibleRes = getNextEligibleCheckIn();
  const nextEligibleElapsed = nextEligibleRes
    ? nowTs - (nextEligibleRes.checkInRequestedAt || 0)
    : 999999;
  const nextEligibleCooldownSec =
    nextEligibleElapsed < 30000
      ? Math.ceil((30000 - nextEligibleElapsed) / 1000)
      : 0;

  const activeSlotCount = activeReservations.filter((r) =>
    ACTIVE_RESERVATION_STATUSES.includes(r.status)
  ).length;
  const slotCapacity = Number(activeStartedSchedule.slotCapacity || 0);
  const walkInQueueOpen = ["active", "paused"].includes(activeStartedSchedule.queueStatus);
  const walkInDayClosed = Boolean(activeStartedSchedule.dayClosed);
  const walkInFull = slotCapacity > 0 && activeSlotCount >= slotCapacity;
  const canAddWalkIn = walkInQueueOpen && !walkInDayClosed && !walkInFull;
  const walkInDisabledReason = walkInDayClosed
    ? "This clinic day is closed."
    : !walkInQueueOpen
      ? "Walk-ins are only available while the queue is active or paused."
      : walkInFull
        ? "This day is full. A slot opens when someone cancels or finishes."
        : "";

  const handleRequestCheckIn = async () => {
    if (!nextEligibleRes) {
      toast.error("All patients in queue are already checked in or processed.");
      return;
    }

    if (nextEligibleCooldownSec > 0) {
      toast.error("Check-in request already sent. Please wait before sending another reminder.");
      return;
    }

    try {
      setRequestingCheckIn(true);
      await requestCheckInReminder(nextEligibleRes.id);
      toast.success(
        `Check-in reminder sent to Queue #${nextEligibleRes.queueNumber || "?"} (${getReservationChildDisplayName(nextEligibleRes, "Patient")})`
      );
    } catch (err) {
      toast.error("Failed to send check-in reminder.");
    } finally {
      setRequestingCheckIn(false);
    }
  };

  const handleCardClick = async (res, e) => {
    // Prevent triggering if clicking a button inside the card
    if (e.target.closest('button')) return;

    setIsContactModalOpen(true);
    setParentContactInfo(null);
    setContactReservation(res);
    setIsCancelConfirmOpen(false);

    const isWalkIn = isWalkInReservation(res) || !res.parentId;
    setContactIsWalkIn(isWalkIn);

    if (isWalkIn) {
      setLoadingContactInfo(false);
      return;
    }

    setLoadingContactInfo(true);

    try {
      const parentRef = ref(getDb(), `users/${res.parentId}`);
      const snapshot = await get(parentRef);
      if (snapshot.exists()) {
        setParentContactInfo(snapshot.val());
      }
    } catch (err) {
      console.error("Failed to fetch parent info", err);
    } finally {
      setLoadingContactInfo(false);
    }
  };

  const handleCancelWalkIn = async () => {
    if (!contactReservation?.id || isCancelling) return;
    if (!isWalkInReservation(contactReservation)) return;

    setIsCancelling(true);
    try {
      await cancelReservation(contactReservation.id);
      toast.success(
        `Walk-in reservation for ${getReservationChildDisplayName(contactReservation, "Patient")} cancelled.`
      );
      setIsCancelConfirmOpen(false);
      setIsContactModalOpen(false);
      setContactReservation(null);
      setParentContactInfo(null);
      setContactIsWalkIn(false);
    } catch (err) {
      console.error(err);
      toast.error("Failed to cancel walk-in reservation.");
    } finally {
      setIsCancelling(false);
    }
  };

  const renderWalkInBadge = () => (
    <span className="pq-chip pq-chip-wait self-start shrink-0">Walk-in</span>
  );


  return (
    <div className="space-y-6 pb-8 max-w-4xl mx-auto">
      {!hideHeader && <QueuePageIntro branchName={user.assignedBranch} />}

      <section className="@container pq-glass p-5 sm:p-6" aria-label="Queue session">
        <div className="flex flex-col gap-3">
          <QueueSessionControls
            layout="cluster"
            schedule={activeStartedSchedule}
            canEndSession={waitingQueue.length === 0 && inConsultationPatients.length === 0}
          />
          <SessionDurationMeter
            startedAt={activeStartedSchedule.queueStartedAt}
            nowTs={nowTs}
          />
          <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-center">
            <button
              type="button"
              data-tour="walkin-open"
              onClick={() => setIsWalkInOpen(true)}
              disabled={!canAddWalkIn}
              className="pq-btn-primary pq-btn-pill w-full @2xl:flex-1"
              title={walkInDisabledReason || "Add a walk-in patient to this queue"}
            >
              <UserPlus className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">Add Walk-in</span>
            </button>
            <button
              type="button"
              data-tour="queue-request-checkin"
              onClick={handleRequestCheckIn}
              disabled={requestingCheckIn || nextEligibleCooldownSec > 0}
              className="pq-btn-secondary pq-btn-pill w-full @2xl:flex-1"
              title={
                nextEligibleCooldownSec > 0
                  ? "Check-in request already sent. Please wait before sending another reminder."
                  : "Remind the next awaiting patient to proceed to the clinic for QR validation"
              }
            >
              <UserCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">
                {nextEligibleCooldownSec > 0
                  ? `Request Check-In (${nextEligibleCooldownSec}s)`
                  : "Request Check-In"}
              </span>
            </button>
            <div
              className="pq-session-count @2xl:flex-1"
              role="status"
              aria-live="polite"
            >
              <Users className="w-4 h-4" aria-hidden="true" />
              {inConsultationPatients.length + waitingQueue.length} Total Active
            </div>
          </div>
          {walkInDisabledReason ? (
            <p className="text-xs pq-muted">{walkInDisabledReason}</p>
          ) : null}
        </div>
      </section>

      <section className="pq-glass overflow-hidden">
        <div className="pq-now mx-0 rounded-none" style={{ borderRadius: 0, border: "none", borderBottom: "1px solid color-mix(in srgb, var(--pq-live) 18%, white)" }}>
          <h2 className="font-extrabold flex items-center" style={{ color: "var(--pq-live)" }}>
            {inConsultationPatients.length > 0 ? <span className="pq-pip mr-2" /> : <Activity className="w-4 h-4 mr-2" aria-hidden="true" />}
            Current Consultation
          </h2>
        </div>

        {inConsultationPatients.length > 0 ? (
          inConsultationPatients.map((res) => (
            <div
              key={res.id}
              role="button"
              tabIndex={0}
              onClick={(e) => handleCardClick(res, e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleCardClick(res, e);
                }
              }}
              className="p-4 sm:p-5 cursor-pointer"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <div className="pq-queue-plate pq-queue-plate-live flex-col w-12 h-12">
                    <span className="text-[9px] uppercase font-extrabold leading-none opacity-80 mb-0.5">
                      Queue
                    </span>
                    <span>#{res.queueNumber || res.queuePosition}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-2 min-w-0">
                      <h3 className="min-w-0 flex-1">
                        <ReservationPatientNames
                          reservation={res}
                          fallback="Unnamed Patient"
                          nameClassName="font-extrabold tracking-tight text-base"
                        />
                      </h3>
                      {isWalkInReservation(res) && renderWalkInBadge()}
                    </div>
                    <div className="text-xs font-semibold mt-1" style={{ color: "var(--pq-live)" }}>
                      <span>Inside Doctor Room</span>
                      {res.consultationStartedAt && (
                        <span> • Started at {formatTime(res.consultationStartedAt)}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between sm:justify-end gap-3 pt-2 sm:pt-0 shrink-0" style={{ borderTop: "1px solid transparent" }}>
                  {renderStatusBadge(res.status)}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="p-8 text-center">
            <p className="text-sm font-extrabold">No active consultation</p>
            <p className="text-xs pq-muted mt-0.5">The consultation room is currently empty.</p>
          </div>
        )}
      </section>

      <section className="pq-glass p-5">
        <h2 className="font-extrabold tracking-tight mb-4 flex items-center gap-2">
          <Clock className="w-4 h-4" style={{ color: "var(--pq-wait)" }} aria-hidden="true" />
          Waiting Queue <span className="pq-chip pq-chip-info">{waitingQueue.length}</span>
        </h2>

        {waitingQueue.length > 0 ? (
          <div className="space-y-2">
            {waitingQueue.map((res, idx) => {
              const isFirstWaiting = idx === 0;
              const canSendToDoctor =
                isFirstWaiting &&
                res.status === "checked_in" &&
                inConsultationPatients.length === 0;
              const isPenalizeTarget = idx === penalizeTargetIdx && penalizeTargetIdx !== -1;
              const graceElapsed = isPenaltyGraceElapsed(res, penaltyGraceMinutes, nowTs);
              const graceRemainingMs = getPenaltyGraceRemainingMs(res, penaltyGraceMinutes, nowTs);
              const canPenalize = isPenalizeTarget && graceElapsed;
              const hasRowActions = canSendToDoctor || isPenalizeTarget;
              const timerRemainingMs = getPenaltyTimerRemainingMs(res, nowTs);

              return (
                <div
                  key={res.id}
                  onClick={(e) => handleCardClick(res, e)}
                  className={`pq-row cursor-pointer ${isFirstWaiting ? "pq-row-you" : ""}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "3rem minmax(0, 1fr) auto",
                    alignItems: "center",
                    columnGap: "0.85rem",
                    rowGap: "0.55rem",
                  }}
                >
                  <div
                    className={`pq-queue-plate ${isFirstWaiting ? "pq-queue-plate-next" : ""}`}
                    style={hasRowActions ? { gridRow: "1 / span 2" } : undefined}
                  >
                    {res.queueNumber || res.queuePosition}
                  </div>

                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <h3 className="min-w-0 truncate">
                      <ReservationPatientNames
                        reservation={res}
                        fallback="Unnamed Patient"
                      />
                    </h3>
                    {isWalkInReservation(res) && renderWalkInBadge()}
                    {timerRemainingMs > 0 && (
                      <span className="pq-chip pq-chip-alert shrink-0">
                        Validation Countdown: {formatRemainingTime(timerRemainingMs)}
                      </span>
                    )}
                  </div>

                  <div className="justify-self-end">
                    {renderStatusBadge(res.status)}
                  </div>

                  {hasRowActions && (
                    <div className="flex items-center gap-2" style={{ gridColumn: "2 / -1" }}>
                      {canSendToDoctor && (
                        <button
                          type="button"
                          data-tour="queue-send-to-doctor"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSendToDoctor(res);
                          }}
                          disabled={actionLoading === res.id}
                          className="pq-btn-primary flex-1"
                          title="Send patient to Doctor room"
                        >
                          <PlayCircle className="w-4 h-4" aria-hidden="true" />
                          Send to Doctor
                        </button>
                      )}

                      {isPenalizeTarget && (
                        <button
                          type="button"
                          data-tour="queue-penalize"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePenalize(res);
                          }}
                          disabled={actionLoading === res.id || !canPenalize}
                          className="pq-btn-warn flex-1"
                          title={
                            canPenalize
                              ? "Penalize absent patient (#1 waiting patient)"
                              : graceRemainingMs == null
                                ? "Preparing grace timer…"
                                : "Wait for the grace period after this parent became next in line"
                          }
                        >
                          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                          {canPenalize
                            ? "Penalize"
                            : graceRemainingMs == null
                              ? "Preparing…"
                              : `Penalize (${formatRemainingTime(graceRemainingMs)})`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center">
            <CheckCircle className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--pq-live)" }} aria-hidden="true" />
            <p className="text-sm font-extrabold">No patients waiting in the queue.</p>
          </div>
        )}
      </section>

      {isContactModalOpen && (
        <ModalScrim
          className="z-[60]"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isCancelling) closeContactModal();
          }}
        >
          <div
            className="pq-modal w-full max-w-sm overflow-hidden flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-modal-title"
          >
            <div className="p-6">
              <h2 id="contact-modal-title" className="text-xl font-extrabold tracking-tight mb-1">
                {contactIsWalkIn ? "Walk-in Patient" : "Parent / Guardian"}
              </h2>
              {loadingContactInfo ? (
                <PqSpinner label="Loading contact" />
              ) : contactIsWalkIn ? (
                <div className="mt-4 space-y-4">
                  <div className="py-1 text-center pq-muted space-y-1">
                    <p className="text-base font-extrabold" style={{ color: "var(--pq-ink)" }}>
                      {getReservationChildDisplayName(contactReservation, "Walk-in patient")}
                    </p>
                    <p>Walk-in patient (no parent account).</p>
                  </div>
                  {(contactReservation?.parentName || contactReservation?.parentPhone) && (
                    <>
                      <div className="pq-row block min-h-0">
                        <p className="pq-stat-label">Parent's Name</p>
                        <p className="text-base font-semibold mt-0.5">
                          {contactReservation.parentName || "Not provided"}
                        </p>
                      </div>
                      <div className="pq-row block min-h-0">
                        <p className="pq-stat-label">Parent's Phone</p>
                        {contactReservation.parentPhone ? (
                          <a href={`tel:${contactReservation.parentPhone}`} className="pq-link mt-0.5 block">
                            {contactReservation.parentPhone}
                          </a>
                        ) : (
                          <p className="mt-0.5">Not provided</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : parentContactInfo ? (
                <div className="mt-4 space-y-4">
                  <div className="pq-row block min-h-0">
                    <p className="pq-stat-label">Name</p>
                    <p className="text-base font-semibold mt-0.5">{parentContactInfo.name || "Not available"}</p>
                  </div>
                  <div className="pq-row block min-h-0">
                    <p className="pq-stat-label">Email</p>
                    {parentContactInfo.email ? (
                      <a href={`mailto:${parentContactInfo.email}`} className="pq-link mt-0.5 block break-all">{parentContactInfo.email}</a>
                    ) : (
                      <p className="mt-0.5">Not available</p>
                    )}
                  </div>
                  <div className="pq-row block min-h-0">
                    <p className="pq-stat-label">Phone</p>
                    {parentContactInfo.phone ? (
                      <a href={`tel:${parentContactInfo.phone}`} className="pq-link mt-0.5 block">{parentContactInfo.phone}</a>
                    ) : (
                      <p className="mt-0.5">Not available</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center pq-muted">
                  <p>Could not retrieve contact information.</p>
                </div>
              )}
            </div>
            <div className="p-4 flex flex-col-reverse sm:flex-row justify-end gap-2" style={{ borderTop: "1px solid var(--pq-glass-line)" }}>
              {isWalkInReservation(contactReservation) && (
                <button
                  type="button"
                  onClick={() => setIsCancelConfirmOpen(true)}
                  disabled={isCancelling}
                  className="pq-btn-danger"
                >
                  Cancel Reservation
                </button>
              )}
              <button
                type="button"
                onClick={closeContactModal}
                disabled={isCancelling}
                className="pq-btn-secondary"
              >
                Close
              </button>
            </div>
          </div>
        </ModalScrim>
      )}

      <ConfirmationModal
        isOpen={isCancelConfirmOpen}
        title="Cancel Walk-in Reservation?"
        message={`Are you sure you want to cancel this walk-in reservation for ${getReservationChildDisplayName(contactReservation, "this patient")}? The slot will be released and the queue will update.`}
        confirmText="Cancel Reservation"
        cancelText="Keep Reservation"
        isDestructive
        isLoading={isCancelling}
        onConfirm={handleCancelWalkIn}
        onClose={() => {
          if (!isCancelling) setIsCancelConfirmOpen(false);
        }}
      />

      {isWalkInOpen ? (
        <WalkInPatientModal
          isOpen
          onClose={() => setIsWalkInOpen(false)}
          schedule={activeStartedSchedule}
        />
      ) : null}
    </div>
  );
}
