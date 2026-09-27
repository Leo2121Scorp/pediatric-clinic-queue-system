import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Filter, Shield, Stethoscope, UserCog, User, MapPin, Mail, Phone, Trash2, AlertCircle } from "lucide-react";
import { ref } from "firebase/database";
import { getDb } from "../../firebase/database";
import { subscribeOnValue } from "../../firebase/rtdbSubscribe";
import UserDetailsModal from "../../components/admin/UserDetailsModal";
import ConfirmationModal from "../../components/common/ConfirmationModal";
import { deleteUserAccount } from "../../services/adminService";
import { useAuth } from "../../hooks/useAuth";
import { PqSpinner } from "../../components/parent/pqUi";
import toast from "react-hot-toast";
import { useTourSample } from "../../hooks/useTourPreview";
import { TourSampleDoctorUsers } from "../../components/onboarding/DoctorTourSampleViews";

const roleChip = (role) => {
  if (role === "doctor") return "pq-chip pq-chip-info";
  if (role === "secretary") return "pq-chip pq-chip-wait";
  if (role === "admin") return "pq-chip pq-chip-info";
  return "pq-chip";
};

const statusChip = (status) => (
  status === "active" ? "pq-chip pq-chip-live" : "pq-chip pq-chip-alert"
);

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const showUsersSample = useTourSample([
    "doctor-users-list",
    "doctor-users-secretary",
    "doctor-users-parent",
  ]);
  const [searchParams] = useSearchParams();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState(() => {
    const role = searchParams.get("role");
    return role === "parent" || role === "doctor" || role === "secretary" || role === "staff" ? role : "all";
  });
  const [statusFilter, setStatusFilter] = useState("all");

  const [selectedUser, setSelectedUser] = useState(null);
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const USERS_PER_PAGE = 10;

  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [userToDelete, setUserToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const usersRef = ref(getDb(), "users");
    const unsubscribe = subscribeOnValue(usersRef, (snapshot) => {
      if (snapshot.exists()) {
        const usersData = snapshot.val();
        const usersList = Object.keys(usersData).map((key) => ({
          id: key,
          ...usersData[key]
        })).filter((user) => user.role !== "admin" && user.id !== "admin" && user.isDeleted !== true);

        setUsers(usersList);
      } else {
        setUsers([]);
      }
      setLoading(false);
      setIsInitialLoadComplete(true);
      setError(null);
    }, (err) => {
      console.error("Firebase Read Error:", err);
      setError("Failed to load users. You may not have permission, or there is a network issue.");
      setLoading(false);
      setIsInitialLoadComplete(true);
    });

    return () => unsubscribe();
  }, [reloadKey]);

  useEffect(() => {
    if (isDetailsModalOpen) {
      setSelectedUser((prevSelected) => {
        if (!prevSelected) return prevSelected;
        const updatedSelectedUser = users.find((u) => u.id === prevSelected.id);
        if (updatedSelectedUser && JSON.stringify(updatedSelectedUser) !== JSON.stringify(prevSelected)) {
          return updatedSelectedUser;
        }
        return prevSelected;
      });
    }
  }, [users, isDetailsModalOpen]);

  const getRoleIcon = (role) => {
    switch (role) {
      case "doctor": return <Stethoscope className="w-4 h-4" aria-hidden="true" />;
      case "secretary": return <UserCog className="w-4 h-4" aria-hidden="true" />;
      case "admin": return <Shield className="w-4 h-4" aria-hidden="true" />;
      default: return <User className="w-4 h-4" aria-hidden="true" />;
    }
  };

  const filteredUsers = users.filter((user) => {
    const term = searchQuery.toLowerCase();
    const matchesSearch = (user.name && user.name.toLowerCase().includes(term)) ||
                          (user.email && user.email.toLowerCase().includes(term));

    const matchesRole = roleFilter === "all"
      || (roleFilter === "staff" && (user.role === "doctor" || user.role === "secretary"))
      || user.role === roleFilter;
    const matchesStatus = statusFilter === "all" || user.status === statusFilter;

    return matchesSearch && matchesRole && matchesStatus;
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, roleFilter, statusFilter]);

  useEffect(() => {
    const role = searchParams.get("role");
    if (role === "parent" || role === "doctor" || role === "secretary" || role === "staff") {
      setRoleFilter(role);
    }
  }, [searchParams]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredUsers.length / USERS_PER_PAGE));
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [filteredUsers.length, currentPage, USERS_PER_PAGE]);

  const totalPages = Math.ceil(filteredUsers.length / USERS_PER_PAGE);
  const displayedUsers = filteredUsers.slice((currentPage - 1) * USERS_PER_PAGE, currentPage * USERS_PER_PAGE);

  const openUserDetails = (user) => {
    if (!isInitialLoadComplete) return;
    if (!user || !user.id) return;
    setSelectedUser(user);
    setIsDetailsModalOpen(true);
  };

  const requestDeleteUser = (e, user) => {
    e.stopPropagation();
    if (!user?.id) return;
    if (user.role === "admin") {
      toast.error("Admin accounts cannot be deleted.");
      return;
    }
    if (user.role === "doctor") {
      toast.error("Doctor accounts cannot be deleted in the app.");
      return;
    }
    if (currentUser?.uid && user.id === currentUser.uid) {
      toast.error("You cannot delete your own account.");
      return;
    }
    setUserToDelete(user);
  };

  const canDeleteUser = (user) =>
    user?.id &&
    user.role !== "admin" &&
    user.role !== "doctor" &&
    !(currentUser?.uid && user.id === currentUser.uid);

  const confirmDeleteUser = async () => {
    if (!userToDelete?.id) return;
    setIsDeleting(true);
    try {
      await deleteUserAccount(userToDelete.id);
      toast.success(`Deleted ${userToDelete.name || "user"} and revoked their login.`);
      setUserToDelete(null);
      if (selectedUser?.id === userToDelete.id) {
        setIsDetailsModalOpen(false);
        setSelectedUser(null);
      }
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Failed to delete user.");
    } finally {
      setIsDeleting(false);
    }
  };

  if (showUsersSample) {
    return (
      <div className="space-y-4 pb-4 md:pb-8">
        <TourSampleDoctorUsers />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4 md:pb-8 md:h-[calc(100vh-140px)] md:flex md:flex-col">
      <div className="pq-filter-bar p-3 sm:p-4 flex flex-col md:flex-row gap-3" data-tour="doctor-users-list">
        <div className="relative flex-1">
          <div className="pq-field-icon">
            <Search className="w-5 h-5" aria-hidden="true" />
          </div>
          <label htmlFor="user-search" className="sr-only">Search by name or email</label>
          <input
            id="user-search"
            type="text"
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pq-input pl-10"
          />
        </div>

        <div className="flex gap-3">
          <div className="relative flex-1 md:flex-none">
            <div className="pq-field-icon">
              <Filter className="w-5 h-5" aria-hidden="true" />
            </div>
            <label htmlFor="user-role-filter" className="sr-only">Filter by role</label>
            <select
              id="user-role-filter"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="pq-input pl-10 appearance-none cursor-pointer min-w-[10rem]"
            >
              <option value="all">All Roles</option>
              <option value="staff">Staff</option>
              <option value="doctor">Doctor</option>
              <option value="secretary">Secretary</option>
              <option value="parent">Parent</option>
            </select>
          </div>

          <div className="relative flex-1 md:flex-none">
            <label htmlFor="user-status-filter" className="sr-only">Filter by status</label>
            <select
              id="user-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="pq-input appearance-none cursor-pointer min-w-[9rem]"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
      </div>

      <div className="pq-glass overflow-hidden min-h-[300px] md:flex-1 md:flex md:flex-col md:min-h-0">
        {loading ? (
          <PqSpinner label="Loading users" />
        ) : error ? (
          <div className="flex flex-col justify-center items-center h-48 md:flex-1 text-center p-6">
            <div
              className="p-4 rounded-full mb-4"
              style={{ background: "var(--pq-alert-wash)", color: "var(--pq-alert)" }}
            >
              <AlertCircle className="w-8 h-8" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-extrabold tracking-tight mb-2">Couldn't load users</h3>
            <p className="pq-muted mb-4">{error}</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setError(null);
                setReloadKey((k) => k + 1);
              }}
              className="pq-btn-primary"
            >
              Try again
            </button>
          </div>
        ) : filteredUsers.length > 0 ? (
          <>
            <div className="block md:hidden overflow-y-auto pq-scroll-y">
              {displayedUsers.map((user) => (
                <div
                  key={user.id}
                  className="p-5"
                  style={{ borderTop: "1px solid var(--pq-glass-line)" }}
                >
                  <div className="flex justify-between items-start gap-2">
                  <button
                    type="button"
                    onClick={() => openUserDetails(user)}
                    aria-label={`View details for ${user.name || "user"}`}
                    className="min-w-0 text-left flex-1"
                  >
                      <h3 className="font-extrabold tracking-tight text-base">{user.name || "Unnamed"}</h3>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className={`${roleChip(user.role)} capitalize`}>
                          {getRoleIcon(user.role)}
                          {user.role}
                        </span>
                        <span className={`${statusChip(user.status)} capitalize`}>
                          {user.status || "unknown"}
                        </span>
                      </div>
                      <div className="pq-row mt-3" style={{ display: "grid", gap: "0.5rem", minHeight: 0 }}>
                        <div className="flex items-center gap-2 leading-none pq-muted truncate">
                          <Mail className="w-4 h-4 shrink-0 pq-faint" aria-hidden="true" />
                          <span className="truncate">{user.email}</span>
                        </div>
                        <div className="flex items-center gap-2 leading-none pq-muted">
                          <Phone className="w-4 h-4 shrink-0 pq-faint" aria-hidden="true" />
                          <span>{user.phone || "No phone"}</span>
                        </div>
                      </div>
                    </button>
                    {user.role === "secretary" && user.assignedBranch && (
                      <span className="pq-chip shrink-0">
                        <MapPin className="w-3 h-3" aria-hidden="true" />
                        {user.assignedBranch}
                      </span>
                    )}
                  </div>

                  {canDeleteUser(user) && (
                    <button
                      type="button"
                      onClick={(e) => requestDeleteUser(e, user)}
                      className="pq-btn-ghost mt-3 ml-auto text-sm"
                      style={{ color: "var(--pq-alert)" }}
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                      Delete
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto md:flex-1 md:overflow-y-auto relative pq-scroll">
              <table className="pq-table">
                <thead className="pq-table-head-sticky">
                  <tr>
                    <th className="pl-6">Name & Email</th>
                    <th>Role</th>
                    <th>Branch</th>
                    <th>Status</th>
                    <th className="pr-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedUsers.map((user) => (
                    <tr
                      key={user.id}
                      onClick={() => openUserDetails(user)}
                      className="cursor-pointer"
                    >
                      <td className="pl-6 min-w-[200px]">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openUserDetails(user);
                          }}
                          aria-label={`View details for ${user.name || "user"}`}
                          className="text-left min-h-11"
                        >
                          <div className="font-extrabold tracking-tight">{user.name || "Unnamed"}</div>
                          <div className="text-sm pq-muted mt-0.5 font-medium">{user.email}</div>
                        </button>
                      </td>
                      <td className="min-w-[120px]">
                        <span className={`${roleChip(user.role)} capitalize`}>
                          {getRoleIcon(user.role)}
                          {user.role}
                        </span>
                      </td>
                      <td className="min-w-[120px]">
                        {user.role === "secretary" && user.assignedBranch ? (
                          <span className="pq-chip">
                            <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
                            {user.assignedBranch}
                          </span>
                        ) : (
                          <span className="pq-faint text-sm italic font-medium">--</span>
                        )}
                      </td>
                      <td className="min-w-[100px]">
                        <span className={`${statusChip(user.status)} capitalize`}>
                          {user.status || "unknown"}
                        </span>
                      </td>
                      <td className="pr-6 text-right">
                        {canDeleteUser(user) && (
                          <button
                            type="button"
                            onClick={(e) => requestDeleteUser(e, user)}
                            className="pq-btn-ghost text-sm"
                            style={{ color: "var(--pq-alert)" }}
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {filteredUsers.length > USERS_PER_PAGE && (
              <div
                className="flex flex-col sm:flex-row sm:items-center justify-between px-5 py-3 sm:py-4 gap-3 sm:gap-4 md:flex-none z-10"
                style={{ borderTop: "1px solid var(--pq-glass-line)" }}
              >
                <div className="text-sm pq-muted font-medium text-center sm:text-left">
                  Showing {(currentPage - 1) * USERS_PER_PAGE + 1}–{Math.min(currentPage * USERS_PER_PAGE, filteredUsers.length)} of {filteredUsers.length} users
                </div>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="pq-btn-secondary"
                  >
                    Previous
                  </button>

                  <div className="hidden sm:flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                      <button
                        key={page}
                        type="button"
                        onClick={() => setCurrentPage(page)}
                        className={currentPage === page ? "pq-btn-primary min-w-11 px-0" : "pq-btn-secondary min-w-11 px-0"}
                        aria-label={`Page ${page}`}
                        aria-current={currentPage === page ? "page" : undefined}
                      >
                        {page}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="pq-btn-secondary"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-12 text-center md:flex-1">
            <User className="w-12 h-12 pq-faint mb-3" aria-hidden="true" />
            <p className="font-extrabold tracking-tight">No users found matching your filters.</p>
            <button
              type="button"
              onClick={() => { setSearchQuery(""); setRoleFilter("all"); setStatusFilter("all"); }}
              className="pq-btn-ghost mt-4"
            >
              Clear Filters
            </button>
          </div>
        )}
      </div>

      <UserDetailsModal
        isOpen={isDetailsModalOpen}
        onClose={() => setIsDetailsModalOpen(false)}
        user={selectedUser}
        onUpdate={() => {}}
      />

      <ConfirmationModal
        isOpen={Boolean(userToDelete)}
        onClose={() => {
          if (!isDeleting) setUserToDelete(null);
        }}
        onConfirm={confirmDeleteUser}
        title="Delete user account"
        message={`This will permanently remove ${userToDelete?.name || "this user"} (${userToDelete?.email || "no email"}) and revoke their login. Historical reservations will be kept. This cannot be undone.`}
        confirmText="Delete"
        isDestructive
        isLoading={isDeleting}
      />
    </div>
  );
}
