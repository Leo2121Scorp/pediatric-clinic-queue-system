import { CheckCircle2, Baby, Plus } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { subscribeToPublishedSchedules } from "../../services/scheduleService";
import { 
  subscribeToParentReservations,
  subscribeToScheduleReservations, 
  claimParentReservation, 
  checkExistingReservationOnDate, 
  checkCompletedConsultationOnDate,
  getReservationsBySchedule,
  updatePatientInfo,
  cancelReservation,
  ACTIVE_RESERVATION_STATUSES,
  wouldExceedMultiDateCap,
  MULTI_DATE_CAP_MESSAGE,
} from "../../services/reservationService";
import { addChild, subscribeToChildren } from "../../services/childProfileService";
import { buildPatientInfoPayload } from "../../utils/reservationPatients";
import { getBranchConfigurations } from "../../services/branchConfigurationService";
import { useAuth } from "../../hooks/useAuth";
import MessageModal from "../../components/common/MessageModal";
import QueueRulesAgreementModal from "../../components/parent/QueueRulesAgreementModal";
import ParentScheduleCalendar from "../../components/parent/ParentScheduleCalendar";
import ChildProfileForm, {
  emptyChildProfile,
  isChildProfileValid
} from "../../components/parent/ChildProfileForm";
import { useTourSample } from "../../hooks/useTourPreview";
import { TourSampleSchedulesBlock } from "../../components/onboarding/TourSampleViews";
import { useHistoryOverlay } from "../../hooks/useHistoryOverlay";

export default function ReserveQueue() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const showSampleSchedules = useTourSample(["reserve-schedule", "reserve-form"]);
  const showSampleForm = useTourSample("reserve-form");
  
  const [schedules, setSchedules] = useState([]);
  const [parentReservationsList, setParentReservationsList] = useState([]);
  const [scheduleCapacities, setScheduleCapacities] = useState({});
  const activeScheduleListenersRef = useRef({});
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);

  // Modal States
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [isAgreementModalOpen, setIsAgreementModalOpen] = useState(false);
  const [isPatientInfoModalOpen, setIsPatientInfoModalOpen] = useState(false);
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  const [generatedQueuePosition, setGeneratedQueuePosition] = useState(null);
  const [activeReservationId, setActiveReservationId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const [savedChildren, setSavedChildren] = useState([]);
  const [selectedChildIds, setSelectedChildIds] = useState([]);
  const [concern, setConcern] = useState("");
  const [isAddChildOpen, setIsAddChildOpen] = useState(false);
  const [newChildForm, setNewChildForm] = useState(emptyChildProfile());
  const [isSavingChild, setIsSavingChild] = useState(false);

  const [messageModalState, setMessageModalState] = useState({
    isOpen: false,
    type: 'info',
    title: '',
    message: ''
  });
  useHistoryOverlay(isPatientInfoModalOpen, () => setIsPatientInfoModalOpen(false));
  useHistoryOverlay(isAddChildOpen, () => setIsAddChildOpen(false));
  useHistoryOverlay(isSuccessModalOpen, () => {
    setIsSuccessModalOpen(false);
    setSelectedSchedule(null);
    setGeneratedQueuePosition(null);
    setActiveReservationId(null);
  });

  useEffect(() => {
    let unsubParent = () => {};
    let unsubChildren = () => {};
    if (user) {
      unsubParent = subscribeToParentReservations(user.uid, (data) => {
        setParentReservationsList(data);
      });
      unsubChildren = subscribeToChildren(user.uid, setSavedChildren);
    }

    const unsubSchedules = subscribeToPublishedSchedules((data) => {
      const sorted = data.sort((a, b) => {
        const dateDiff = new Date(a.clinicDate) - new Date(b.clinicDate);
        if (dateDiff !== 0) return dateDiff;
        const timeA = a.openingTime || "";
        const timeB = b.openingTime || "";
        return timeA.localeCompare(timeB);
      });
      setSchedules(sorted);
      setLoading(false);
    });

    getBranchConfigurations().then(setBranches);

    return () => {
      unsubSchedules();
      unsubParent();
      unsubChildren();
    };
  }, [user]);

  // Dynamic schedule listener lifecycle
  useEffect(() => {
    const currentScheduleIds = schedules.map(s => s.id);
    const existingIds = Object.keys(activeScheduleListenersRef.current);

    // 1. Add new listeners
    currentScheduleIds.forEach(scheduleId => {
      if (!activeScheduleListenersRef.current[scheduleId]) {
        activeScheduleListenersRef.current[scheduleId] = subscribeToScheduleReservations(scheduleId, (data) => {
          const count = data.filter(r => ACTIVE_RESERVATION_STATUSES.includes(r.status)).length;
          setScheduleCapacities(prev => ({
            ...prev,
            [scheduleId]: count
          }));
        });
      }
    });

    // 2. Remove obsolete listeners
    existingIds.forEach(id => {
      if (!currentScheduleIds.includes(id)) {
        activeScheduleListenersRef.current[id]();
        delete activeScheduleListenersRef.current[id];
        setScheduleCapacities(prev => {
          const newState = { ...prev };
          delete newState[id];
          return newState;
        });
      }
    });
  }, [schedules]);

  // Cleanup all schedule listeners on unmount
  useEffect(() => {
    return () => {
      Object.values(activeScheduleListenersRef.current).forEach(unsub => unsub());
      activeScheduleListenersRef.current = {};
    };
  }, []);

  const getReservationCount = (scheduleId) => {
    return scheduleCapacities[scheduleId];
  };

  const handleReserveClick = async (schedule) => {
    if (isAgreementModalOpen || isPatientInfoModalOpen || isSubmitting) return;

    if (schedule.dayClosed) {
      setMessageModalState({
        isOpen: true,
        type: "warning",
        title: "Clinic Closed",
        message: "The clinic is closed on this date."
      });
      return;
    }

    // Check Capacity
    const currentCount = getReservationCount(schedule.id);
    if (currentCount >= schedule.slotCapacity) {
      setMessageModalState({
        isOpen: true,
        type: 'error',
        title: 'Schedule Full',
        message: 'This schedule is already full.'
      });
      return;
    }

    // Check if Queue Ended
    if (schedule.queueStatus === 'closed' || schedule.queueStatus === 'ended' || schedule.queueStatus === 'completed') {
      setMessageModalState({
        isOpen: true,
        type: 'error',
        title: 'Queue Closed',
        message: 'This clinic queue has closed to new reservations. Reservations are no longer accepted.'
      });
      return;
    }

    // Check Duplicate on Clinic Date
    const hasExistingOnDate = await checkExistingReservationOnDate(user.uid, schedule.clinicDate);
    if (hasExistingOnDate) {
      setMessageModalState({
        isOpen: true,
        type: 'warning',
        title: 'Active Reservation Exists',
        message: 'You already have an active reservation for this date. You may only reserve one clinic schedule per day.'
      });
      return;
    }

    const schedulesById = Object.fromEntries(schedules.map((item) => [item.id, item]));
    if (wouldExceedMultiDateCap(parentReservationsList, schedulesById, schedule.clinicDate)) {
      setMessageModalState({
        isOpen: true,
        type: "warning",
        title: "Upcoming reservation limit",
        message: MULTI_DATE_CAP_MESSAGE,
      });
      return;
    }

    // Check if parent already completed a consultation with this doctor on this calendar day
    const hasCompletedToday = await checkCompletedConsultationOnDate(user.uid, schedule.clinicDate, schedule.doctorId);
    if (hasCompletedToday) {
      setMessageModalState({
        isOpen: true,
        type: 'warning',
        title: 'Consultation Completed Today',
        message: "You've already completed your consultation for today's clinic.\n\nYou can reserve another slot on the doctor's next available clinic schedule."
      });
      return;
    }

    setSelectedSchedule(schedule);
    setSelectedChildIds([]);
    setConcern("");
    setIsAddChildOpen(false);
    setNewChildForm(emptyChildProfile());
    setIsAgreementModalOpen(true);
  };

  const handleCancelAgreement = () => {
    if (isSubmitting) return;
    setIsAgreementModalOpen(false);
    setSelectedSchedule(null);
  };

  const handleAgreeToQueueRules = async () => {
    if (!selectedSchedule || isSubmitting || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const { reservationId, queueNumber } = await claimParentReservation(selectedSchedule.id);

      let displayPosition = queueNumber;
      if (displayPosition == null || Number.isNaN(displayPosition)) {
        try {
          const updatedReservations = await getReservationsBySchedule(selectedSchedule.id);
          const newRes = updatedReservations.find((r) => r.id === reservationId);
          displayPosition = newRes?.queuePosition ?? newRes?.queueNumber;
        } catch (readError) {
          console.warn("Could not refresh queue position after claim:", readError);
        }
      }

      setGeneratedQueuePosition(displayPosition || "Assigned");
      setActiveReservationId(reservationId);
      setIsAgreementModalOpen(false);
      setIsPatientInfoModalOpen(true);
    } catch (error) {
      console.error("Failed to create reservation", error);
      const detail =
        typeof error?.message === "string" && error.message.trim()
          ? error.message.trim()
          : "There was an error processing your reservation. Please try again.";
      setMessageModalState({
        isOpen: true,
        type: 'error',
        title: 'Reservation Failed',
        message: detail
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleCancelReservation = async () => {
    if (!activeReservationId) return;
    setIsSubmitting(true);
    try {
      await cancelReservation(activeReservationId);
      setActiveReservationId(null);
      setGeneratedQueuePosition(null);
      setSelectedSchedule(null);
      setSelectedChildIds([]);
      setConcern("");
      setIsAddChildOpen(false);
      setIsPatientInfoModalOpen(false);
    } catch (error) {
      console.error("Failed to cancel reservation", error);
      setMessageModalState({
        isOpen: true,
        type: 'error',
        title: 'Cancellation Failed',
        message: 'There was an error cancelling your reservation. Please try again.'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleChildSelection = (childId) => {
    setSelectedChildIds((prev) =>
      prev.includes(childId) ? prev.filter((id) => id !== childId) : [...prev, childId]
    );
  };

  const handleAddChildFromReserve = async () => {
    if (!user?.uid || !isChildProfileValid(newChildForm)) return;
    setIsSavingChild(true);
    try {
      const childId = await addChild(user.uid, newChildForm);
      if (childId) {
        setSelectedChildIds((prev) => prev.includes(childId) ? prev : [...prev, childId]);
      }
      setNewChildForm(emptyChildProfile());
      setIsAddChildOpen(false);
    } catch (err) {
      console.error(err);
      setMessageModalState({
        isOpen: true,
        type: "error",
        title: "Could Not Add Child",
        message: "There was an error saving this child profile. Please try again."
      });
    } finally {
      setIsSavingChild(false);
    }
  };

  const handleSubmitPatientInfo = async () => {
    // #region agent log
    fetch('http://127.0.0.1:7708/ingest/a0da62a0-b5bc-4cd3-91aa-e6028c550e99',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'98046d'},body:JSON.stringify({sessionId:'98046d',runId:'post-fix',hypothesisId:'A',location:'ReserveQueue.jsx:handleSubmitPatientInfo',message:'save clicked',data:{hasReservationId:Boolean(activeReservationId),submitting:Boolean(submittingRef.current),selectedCount:selectedChildIds.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!activeReservationId || submittingRef.current) {
      if (!activeReservationId) {
        setMessageModalState({
          isOpen: true,
          type: "error",
          title: "Reservation Not Saved",
          message: "This slot was not saved on the clinic server. Close this screen and reserve again."
        });
      }
      return;
    }
    const selected = savedChildren.filter((child) => selectedChildIds.includes(child.id));
    if (selected.length === 0) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await updatePatientInfo(activeReservationId, buildPatientInfoPayload(selected, concern));
      // #region agent log
      fetch('http://127.0.0.1:7708/ingest/a0da62a0-b5bc-4cd3-91aa-e6028c550e99',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'98046d'},body:JSON.stringify({sessionId:'98046d',runId:'post-fix',hypothesisId:'C',location:'ReserveQueue.jsx:handleSubmitPatientInfo',message:'patient info saved',data:{selectedCount:selected.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      setIsPatientInfoModalOpen(false);
      setIsSuccessModalOpen(true);
    } catch (err) {
      // #region agent log
      fetch('http://127.0.0.1:7708/ingest/a0da62a0-b5bc-4cd3-91aa-e6028c550e99',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'98046d'},body:JSON.stringify({sessionId:'98046d',runId:'post-fix',hypothesisId:'C',location:'ReserveQueue.jsx:handleSubmitPatientInfo',message:'patient info save failed',data:{error:String(err&&err.message||err).slice(0,180)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      console.error(err);
      setMessageModalState({
        isOpen: true,
        type: 'error',
        title: 'Update Failed',
        message: 'Could not save patient information. Please try again.'
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const closeSuccessModal = () => {
    setIsSuccessModalOpen(false);
    setSelectedSchedule(null);
    setGeneratedQueuePosition(null);
    setActiveReservationId(null);
  };

  if (showSampleSchedules) {
    return (
      <div className="space-y-6 pb-6 relative">
        <TourSampleSchedulesBlock showForm={showSampleForm} />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-6 relative">

      {loading ? (
        <div className="flex justify-center items-center py-20">
          <span className="pq-spinner" />
        </div>
      ) : (
        <ParentScheduleCalendar
          branches={branches}
          schedules={schedules}
          reservations={parentReservationsList}
          capacityMap={scheduleCapacities}
          onReserve={handleReserveClick}
          onMessage={(state) => setMessageModalState({ isOpen: true, ...state })}
        />
      )}


      <QueueRulesAgreementModal
        key={selectedSchedule?.id || "queue-rules"}
        isOpen={isAgreementModalOpen}
        schedule={selectedSchedule}
        isSubmitting={isSubmitting}
        onCancel={handleCancelAgreement}
        onAgree={handleAgreeToQueueRules}
      />

      {/* Complete Patient Info Modal */}
      {isPatientInfoModalOpen && selectedSchedule && (
        <div className="pq-modal-scrim">
          <div className="pq-modal w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-5" style={{ borderBottom: "1px solid var(--pq-glass-line)" }}>
              <h2 className="text-lg font-bold">Select Patients</h2>
            </div>
            
            <div className="p-6 overflow-y-auto pq-scroll-y">
              <div className="flex items-start pq-note pq-note-info mb-6">
                <CheckCircle2 className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0" />
                <p className="text-sm font-medium">Your slot is reserved. Choose one or more children this visit is for, then add the reason for the visit.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium">Who is this reservation for? *</label>
                    <button
                      type="button"
                      onClick={() => {
                        setNewChildForm(emptyChildProfile());
                        setIsAddChildOpen(true);
                      }}
                      className="pq-link text-xs inline-flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add a Child
                    </button>
                  </div>

                  {savedChildren.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-5 text-center" style={{ borderColor: "var(--pq-glass-line)", background: "color-mix(in srgb, #ffffff 45%, transparent)" }}>
                      <Baby className="w-8 h-8 pq-faint mx-auto mb-2" />
                      <p className="text-sm font-medium mb-3">No child profiles yet. Add a child to continue.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setNewChildForm(emptyChildProfile());
                          setIsAddChildOpen(true);
                        }}
                        className="pq-btn-primary text-sm inline-flex"
                      >
                        <Plus className="w-4 h-4" />
                        Add a Child
                      </button>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {savedChildren.map((child) => {
                        const checked = selectedChildIds.includes(child.id);
                        return (
                          <li key={child.id}>
                            <label className={`pq-row pq-row-start w-full cursor-pointer text-left ${
                              checked ? "pq-row-you" : ""
                            }`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleChildSelection(child.id)}
                                className="w-4 h-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                              <span className="min-w-0 flex-1 text-left">
                                <span className="block text-sm font-bold truncate">{child.childName}</span>
                                <span className="block text-xs pq-muted">{child.age} • {child.sex}</span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div>
                  <label className="pq-label">Concern / Reason for Visit</label>
                  <textarea 
                    value={concern}
                    onChange={e => setConcern(e.target.value)}
                    placeholder="Optional: briefly describe the symptoms or reason for visit"
                    rows={3}
                    className="pq-input resize-none"
                  ></textarea>
                </div>
              </div>
            </div>

            <div className="p-5 flex gap-3 justify-end" style={{ borderTop: "1px solid var(--pq-glass-line)" }}>
              <button 
                onClick={handleCancelReservation}
                disabled={isSubmitting}
                className="pq-btn-secondary w-full sm:w-auto text-sm"
              >
                Cancel Reservation
              </button>
              <button 
                onClick={handleSubmitPatientInfo}
                disabled={isSubmitting || selectedChildIds.length === 0}
                className="pq-btn-primary w-full text-sm"
              >
                {isSubmitting ? (
                  <>
                    <span className="pq-spinner" />
                    Saving...
                  </>
                ) : "Save Information"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isAddChildOpen && (
        <div className="pq-modal-scrim" style={{ zIndex: 60 }}>
          <div className="pq-modal w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-5" style={{ borderBottom: "1px solid var(--pq-glass-line)" }}>
              <h2 className="text-lg font-bold">Add a Child</h2>
            </div>
            <div className="p-6 overflow-y-auto pq-scroll-y">
              <ChildProfileForm value={newChildForm} onChange={setNewChildForm} idPrefix="reserve-child" />
            </div>
            <div className="p-5 flex gap-3 justify-end" style={{ borderTop: "1px solid var(--pq-glass-line)" }}>
              <button
                type="button"
                onClick={() => !isSavingChild && setIsAddChildOpen(false)}
                disabled={isSavingChild}
                className="pq-btn-secondary text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddChildFromReserve}
                disabled={isSavingChild || !isChildProfileValid(newChildForm)}
                className="pq-btn-primary text-sm"
              >
                {isSavingChild ? "Saving..." : "Save Child"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success Modal */}
      {isSuccessModalOpen && selectedSchedule && (
        <div className="pq-modal-scrim">
          <div className="pq-modal w-full max-w-sm overflow-hidden flex flex-col text-center">
            <div className="p-8">
              <div className="mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ background: "var(--pq-live-wash)", color: "var(--pq-live)" }}>
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold mb-2">Reservation Successful</h2>
              <p className="pq-muted text-sm mb-6">You have successfully reserved a slot.</p>
              
              <div className="pq-row flex-col items-stretch text-left p-5 mb-6">
                <div className="text-sm pq-muted mb-1 text-center">Queue Position</div>
                <div className="pq-num text-4xl text-center mb-4" style={{ color: "var(--pq-mark-blue-deep)" }}>{generatedQueuePosition}</div>
                
                <div className="flex flex-col space-y-2 text-sm text-left">
                  <div className="flex justify-between items-start pt-3" style={{ borderTop: "1px solid var(--pq-glass-line)" }}>
                    <span className="pq-muted shrink-0 mr-4">Branch:</span>
                    <div className="flex flex-col text-right">
                      <span className="font-semibold">{selectedSchedule.branch}</span>
                      <span className="text-xs pq-muted whitespace-pre-line mt-0.5">
                        {branches.find(b => b.name === selectedSchedule.branch)?.clinicAddress || "No clinic address provided."}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between">
                    <span className="pq-muted">Date:</span>
                    <span className="font-semibold">{new Date(selectedSchedule.clinicDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <button 
                  onClick={() => { closeSuccessModal(); navigate('/parent/reservations'); }}
                  className="pq-btn-primary w-full"
                >
                  View My Reservation
                </button>
                <button 
                  onClick={closeSuccessModal}
                  className="pq-btn-secondary w-full"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* Global Message Modal */}
      <MessageModal
        isOpen={messageModalState.isOpen}
        type={messageModalState.type}
        title={messageModalState.title}
        message={messageModalState.message}
        onClose={() => setMessageModalState(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
