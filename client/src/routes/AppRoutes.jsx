import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import ProtectedRoute from "./ProtectedRoute";
import VerifiedRoute from "./VerifiedRoute";

import Login from "../pages/auth/Login";
import Register from "../pages/auth/Register";
import ForgotPassword from "../pages/auth/ForgotPassword";
import ResetPassword from "../pages/auth/ResetPassword";
import VerifyEmail from "../pages/auth/VerifyEmail";

// Parent Layout and Pages
import ParentLayout from "../components/parent/ParentLayout";
import ParentDashboard from "../pages/parent/Dashboard";
import ParentReserveQueue from "../pages/parent/ReserveQueue";
import ParentMyReservation from "../pages/parent/MyReservation";
import ParentQRTicket from "../pages/parent/QRTicket";
import ParentProfile from "../pages/parent/Profile";
import ParentReservationHistory from "../pages/parent/ReservationHistory";
import ParentPersonalInformation from "../pages/parent/PersonalInformation";
import ParentChildProfiles from "../pages/parent/ChildProfiles";
import ParentNotificationSettings from "../pages/parent/NotificationSettings";
import ParentNotifications from "../pages/parent/ParentNotifications";

import SecretaryLayout from "../components/secretary/SecretaryLayout";
import SecretaryDashboard from "../pages/secretary/Dashboard";
import SecretaryValidateReservation from "../pages/secretary/ValidateReservation";
import SecretaryManageQueue from "../pages/secretary/ManageQueue";
import SecretaryQueueMonitor from "../pages/secretary/QueueMonitor";

import SecretaryProfile from "../pages/secretary/Profile";
// Doctor Layout and Pages
import DoctorLayout from "../components/doctor/Layout";
import DoctorHome from "../pages/doctor/Home";
import DoctorSchedules from "../pages/doctor/Schedules";
import DoctorQueue from "../pages/doctor/Queue";
import DoctorReports from "../pages/doctor/Reports";
import DoctorProfile from "../pages/doctor/Profile";

// Admin Layout and Pages
import AdminLayout from "../components/admin/AdminLayout";
import AdminDashboard from "../pages/admin/Dashboard";
import AdminUserManagement from "../pages/admin/UserManagement";
import AdminBranchManagement from "../pages/admin/BranchManagement";
import AdminActivity from "../pages/admin/Activity";
import AdminSystemSettings from "../pages/admin/SystemSettings";
import AdminProfile from "../pages/admin/Profile";

import OnboardingRoute from "./OnboardingRoute";
import RoleRoute from "./RoleRoute";
import NativeNotificationBridge from "../components/common/NativeNotificationBridge";
import OnboardingChildProfile from "../pages/auth/OnboardingChildProfile";
import SmsTester from "../pages/dev/SmsTester";

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <NativeNotificationBridge />
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/sms-tester" element={<SmsTester />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<ProtectedRoute><VerifyEmail /></ProtectedRoute>} />
        <Route path="/onboarding/child" element={<ProtectedRoute><OnboardingChildProfile /></ProtectedRoute>} />
        
        {/* Parent Routes */}
        <Route path="/parent" element={<ProtectedRoute> <VerifiedRoute> <OnboardingRoute> <RoleRoute allowedRole="parent"><ParentLayout /></RoleRoute> </OnboardingRoute> </VerifiedRoute> </ProtectedRoute>}>
          <Route index element={<ParentDashboard />} />
          <Route path="reserve" element={<ParentReserveQueue />} />
          <Route path="reservations" element={<ParentMyReservation />} />
          <Route path="reservations/:id/qr" element={<ParentQRTicket />} />
          <Route path="profile" element={<ParentProfile />} />
          <Route path="profile/personal-info" element={<ParentPersonalInformation />} />
          <Route path="profile/children" element={<ParentChildProfiles />} />
          <Route path="profile/history" element={<ParentReservationHistory />} />
          <Route path="profile/notification-settings" element={<ParentNotificationSettings />} />
          <Route path="notifications" element={<ParentNotifications />} />
        </Route>

        {/* Secretary Routes */}
        <Route path="/secretary/monitor" element={<ProtectedRoute> <RoleRoute allowedRole="secretary"><SecretaryQueueMonitor /></RoleRoute> </ProtectedRoute>} />
        <Route path="/secretary" element={<ProtectedRoute> <RoleRoute allowedRole="secretary"><SecretaryLayout /></RoleRoute> </ProtectedRoute>}>
          <Route index element={<SecretaryDashboard />} />
          <Route path="validate" element={<SecretaryValidateReservation />} />
          <Route path="queue" element={<SecretaryManageQueue />} />

          <Route path="profile" element={<SecretaryProfile />} />
        </Route>
        
        {/* Doctor Routes */}
        <Route path="/doctor" element={<ProtectedRoute> <RoleRoute allowedRole="doctor"><DoctorLayout /></RoleRoute> </ProtectedRoute>}>
          <Route index element={<DoctorHome />} />
          <Route path="schedules" element={<DoctorSchedules />} />
          <Route path="queue" element={<DoctorQueue />} />
          <Route path="reports" element={<DoctorReports />} />

          <Route path="profile" element={<DoctorProfile />} />
        </Route>

        {/* Admin Routes */}
        <Route path="/admin" element={<ProtectedRoute> <RoleRoute allowedRole="admin"><AdminLayout /></RoleRoute> </ProtectedRoute>}>
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminUserManagement />} />
          <Route path="branches" element={<AdminBranchManagement />} />
          <Route path="activity" element={<AdminActivity />} />
          <Route path="settings" element={<AdminSystemSettings />} />
          <Route path="profile" element={<AdminProfile />} />
        </Route>

        {/* Fallback Catch-All Route */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}