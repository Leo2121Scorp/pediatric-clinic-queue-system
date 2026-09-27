import { useState } from "react";
import { Outlet, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Home, Users, User, BarChart3, ArrowLeft, CalendarDays, MapPin, ScrollText, Plus, UserCog } from "lucide-react";
import { PqBrand } from "../parent/pqUi";
import { goBackOr } from "../../utils/navigationRoots";
import AddStaffModal from "../admin/AddStaffModal";
import LogoutButton from "../common/LogoutButton";
import DemoResetBar from "./DemoResetBar";

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [headerOverride, setHeaderOverride] = useState(null);

  const getHeaderInfo = () => {
    const path = location.pathname;
    if (path === "/doctor" || path === "/doctor/") {
      return { title: "Dashboard", showBack: false };
    }
    if (path.startsWith("/doctor/queue")) {
      return { title: "Queue", showBack: false };
    }
    if (path.startsWith("/doctor/schedules")) {
      return { title: "Schedules", showBack: false };
    }
    if (path.startsWith("/doctor/reports")) {
      return { title: "Reports & Analytics", showBack: true, backPath: "/doctor" };
    }
    if (path.startsWith("/doctor/users")) {
      return { title: "Users", showBack: true, backPath: "/doctor/profile", showAddStaff: true };
    }
    if (path.startsWith("/doctor/branches")) {
      return { title: "Branches", showBack: true, backPath: "/doctor/profile", showAddBranch: true };
    }
    if (path.startsWith("/doctor/audit-logs")) {
      return { title: "Audit Logs", showBack: true, backPath: "/doctor/profile" };
    }
    if (path.startsWith("/doctor/profile")) {
      const view = new URLSearchParams(location.search).get("view");
      if (view === "account") return { title: "Account Settings", showBack: true, backPath: "/doctor/profile" };
      return { title: "Profile", showBack: false };
    }
    return { title: "Dashboard", showBack: false };
  };

  const headerInfo = {
    ...getHeaderInfo(),
    ...(headerOverride || {}),
  };

  const primaryNav = [
    { name: "Dashboard", mobileName: "Home", path: "/doctor", icon: Home, replace: true, tour: "doctor-nav-dashboard" },
    { name: "Queue", path: "/doctor/queue", icon: Users, replace: true, tour: "doctor-nav-queue" },
    { name: "Schedules", path: "/doctor/schedules", icon: CalendarDays, replace: true, tour: "doctor-nav-schedules" },
    { name: "Reports", path: "/doctor/reports", icon: BarChart3, desktopOnly: true, tour: "doctor-nav-reports" },
    { name: "Profile", path: "/doctor/profile", icon: User, replace: true, tour: "doctor-nav-profile" },
  ];

  const clinicAdminNav = [
    { name: "Users", path: "/doctor/users", icon: UserCog, tour: "doctor-nav-users" },
    { name: "Branches", path: "/doctor/branches", icon: MapPin, tour: "doctor-nav-branches" },
    { name: "Audit Logs", path: "/doctor/audit-logs", icon: ScrollText, tour: "doctor-nav-audit" },
  ];

  const isActive = (path) => {
    if (path === "/doctor") {
      return location.pathname === "/doctor" || location.pathname === "/doctor/";
    }
    return location.pathname.startsWith(path);
  };

  const handleBack = () => {
    if (typeof headerInfo.onBack === "function") {
      headerInfo.onBack();
      return;
    }
    goBackOr(navigate, headerInfo.backPath || "/doctor");
  };

  const renderSideLink = (item) => (
    <NavLink
      key={item.name}
      to={item.path}
      replace={item.replace === true}
      aria-current={isActive(item.path) ? "page" : undefined}
      data-tour={item.tour}
      className={() =>
        `pq-side-link ${isActive(item.path) ? "pq-side-link-active" : ""}`
      }
    >
      <item.icon className="w-5 h-5 flex-shrink-0" />
      <span>{item.name}</span>
    </NavLink>
  );

  return (
    <div className="pq-shell flex h-screen md:flex-row flex-col overflow-hidden">
      <aside className="hidden md:flex flex-col w-64 pq-glass-nav z-20 flex-shrink-0 rounded-none border-y-0 border-l-0">
        <div className="p-6 flex items-center" style={{ borderBottom: "1px solid var(--pq-glass-line)" }}>
          <PqBrand size={36} />
        </div>
        <nav className="flex-1 flex flex-col min-h-0 py-4 px-4 overflow-y-auto pq-scroll-y" aria-label="Doctor">
          <div className="space-y-1.5">
            {primaryNav.map(renderSideLink)}
          </div>
          <div
            className="mt-4 pt-4 space-y-1.5"
            style={{ borderTop: "1px solid var(--pq-glass-line)" }}
          >
            <p className="px-3 mb-2 text-xs font-bold uppercase tracking-wide pq-faint">
              Clinic admin
            </p>
            {clinicAdminNav.map(renderSideLink)}
          </div>
        </nav>
        <div className="p-4 mt-auto" style={{ borderTop: "1px solid var(--pq-glass-line)" }}>
          <LogoutButton className="pq-btn-danger w-full" />
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto pq-scroll-y w-full md:pb-0 pb-[6.5rem] h-full relative flex flex-col bg-transparent">
        <div className="pq-header-wrap">
          <header className={`pq-header-pill ${headerInfo.subtitle ? "pq-header-pill-stacked" : ""}`}>
            <div className="flex items-center gap-3 min-w-0">
              {headerInfo.showBack ? (
                <button
                  type="button"
                  onClick={handleBack}
                  className="pq-icon-btn flex-shrink-0"
                  aria-label="Go back"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              ) : (
                <span className="md:hidden flex-shrink-0">
                  <PqBrand size={32} wordmark={false} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="text-lg sm:text-xl font-extrabold tracking-tight truncate">
                  {headerInfo.title}
                </h1>
                {headerInfo.subtitle ? (
                  <p className="text-xs pq-muted font-medium mt-0.5 truncate">
                    {headerInfo.subtitle}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {headerInfo.showAddStaff ? (
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(true)}
                  className="pq-btn-primary"
                  data-tour="doctor-users-add-staff"
                >
                  <Plus className="w-5 h-5" aria-hidden="true" />
                  <span className="hidden sm:inline">Add Staff</span>
                  <span className="sm:hidden">Add</span>
                </button>
              ) : null}
              {headerInfo.showAddBranch ? (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent("openAddBranchModal"))}
                  className="pq-btn-primary"
                >
                  <Plus className="w-5 h-5" aria-hidden="true" />
                  <span className="hidden sm:inline">Add Branch</span>
                  <span className="sm:hidden">Add</span>
                </button>
              ) : null}
            </div>
          </header>
        </div>

        <div className="p-4 sm:p-6 md:p-8 lg:p-10 max-w-5xl mx-auto w-full flex-1 min-w-0">
          <DemoResetBar />
          <Outlet context={{ setHeaderOverride }} />
        </div>

        <AddStaffModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onSuccess={() => setIsAddModalOpen(false)}
        />
      </main>

      <nav className="md:hidden pq-dock-wrap" aria-label="Main">
        <div className="pq-dock">
          {primaryNav.filter((item) => !item.desktopOnly).map((item) => {
            const active = isActive(item.path);
            const label = item.mobileName || item.name;
            return (
              <NavLink
                key={item.name}
                to={item.path}
                replace={item.replace === true}
                aria-label={item.name}
                aria-current={active ? "page" : undefined}
                data-tour={item.tour}
                className={`pq-dock-item ${active ? "pq-dock-item-active" : ""}`}
              >
                <item.icon
                  className="w-[22px] h-[22px] flex-shrink-0"
                  strokeWidth={active ? 2 : 1.85}
                  fill={active ? "currentColor" : "none"}
                  aria-hidden="true"
                />
                <span className="pq-dock-label">{label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
