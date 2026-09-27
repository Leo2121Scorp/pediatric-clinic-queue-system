import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  loginWithIdentifier,
  canParentSelfReactivate,
  reactivateSelfDeactivatedParent,
  getParentPostAuthPath,
} from "../../services/authService";
import { Mail, Lock, ArrowRight, Eye, EyeOff } from "lucide-react";
import { PqAuthShell, PqBrand, PqSpinner } from "../../components/parent/pqUi";
import toast from "react-hot-toast";
import { mapAuthError } from "../../utils/authErrors";
import { useAuth } from "../../hooks/useAuth";
import { auth } from "../../firebase/auth";
import { signOut } from "firebase/auth";
import { detectLoginIdentifier } from "../../utils/loginIdentifier";
import { APP_DOWNLOAD_PAGE_PATH, isNativeApp } from "../../utils/platform";

export default function Login() {
  const navigate = useNavigate();
  const { user, role, loading: authLoading } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const detected = detectLoginIdentifier(identifier);

  useEffect(() => {
    if (!authLoading && user) {
      if (role) {
        if (role === 'doctor' || role === 'admin') navigate('/doctor', { replace: true });
        else if (role === 'secretary') {
          if (user?.mustChangePassword) navigate('/secretary/change-password', { replace: true });
          else navigate('/secretary', { replace: true });
        } else {
          navigate(getParentPostAuthPath(user, auth.currentUser), { replace: true });
        }
      } else {
        const firebaseUser = auth.currentUser;
        if (firebaseUser && !firebaseUser.emailVerified) {
          navigate('/verify-email', { replace: true });
        } else if (firebaseUser && firebaseUser.emailVerified) {
          signOut(auth).then(() => {
            toast.error('Account profile not found. Please contact the clinic.');
          });
        }
      }
    }
  }, [user, role, authLoading, navigate]);

  const finishLogin = async (authUser) => {
    const { ref, get } = await import("firebase/database");
    const { getDb, setActiveDatabase } = await import("../../firebase/database");
    const tokenResult = await authUser.getIdTokenResult(true);
    setActiveDatabase(tokenResult?.claims?.isDemo === true);
    const userRef = ref(getDb(), `users/${authUser.uid}`);
    const snapshot = await get(userRef);

    if (snapshot.exists()) {
      let userData = snapshot.val();
      if (userData.isDeleted) {
        await signOut(auth);
        toast.error("This account has been deleted.");
        return;
      }

      if (userData.status === "inactive") {
        if (canParentSelfReactivate(userData)) {
          await reactivateSelfDeactivatedParent(authUser.uid);
          userData = { ...userData, status: "active", deactivationSource: null };
          toast.success("Welcome back. Your account has been reactivated.");
        } else {
          return;
        }
      } else {
        toast.success("Login Successfully");
      }

      if (userData.role === "parent" && !authUser.emailVerified) {
        toast("Please verify your email before continuing.", { icon: "ℹ️" });
        navigate("/verify-email", { replace: true });
        return;
      }

      if (userData.role === "parent") {
        if (userData.onboardingComplete === false) {
          navigate("/onboarding/child", { replace: true });
        }
        const { requestPushPermissionAfterLogin } = await import("../../services/pushService");
        await requestPushPermissionAfterLogin({
          uid: authUser.uid,
          role: "parent",
          devicePushEnabled: userData.devicePushEnabled,
        });
      } else if (userData.role === "doctor" || userData.role === "admin") {
        const { requestPushPermissionAfterLogin } = await import("../../services/pushService");
        await requestPushPermissionAfterLogin({
          uid: authUser.uid,
          role: userData.role,
          devicePushEnabled: userData.devicePushEnabled,
        });
      } else if (userData.role === "secretary" && userData.mustChangePassword) {
        navigate("/secretary/change-password", { replace: true });
        return;
      }
    } else {
      if (!authUser.emailVerified) {
        toast('Please verify your email before continuing.', { icon: 'ℹ️' });
        navigate('/verify-email', { replace: true });
        return;
      }
      await signOut(auth);
      toast.error('Account profile not found. Please contact the clinic.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (detected.type === "unknown" || (detected.type === "phone" && !detected.value)) {
      toast.error("Enter a valid email address or phone number.");
      return;
    }

    setLoading(true);
    try {
      const authUser = await loginWithIdentifier(identifier.trim(), password);
      await finishLogin(authUser);
    } catch (err) {
      console.error('Login failed:', err);
      toast.error(mapAuthError(err.code) || err.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || (user && role)) {
    return (
      <PqAuthShell>
        <PqSpinner />
      </PqAuthShell>
    );
  }

  return (
    <PqAuthShell>
      <div className="pq-glass-window overflow-hidden">
        <div className="pt-10 pb-6 px-8 text-center" style={{ borderBottom: "1px solid var(--pq-glass-line)" }}>
          <div className="flex justify-center mb-5">
            <PqBrand size={72} stacked />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">Sign in</h1>
        </div>

        <div className="p-8">
          <form onSubmit={handleSubmit} className="space-y-5" id="login-form">
            <div>
              <label htmlFor="identifier" className="pq-label">
                Email or Phone Number
              </label>
              <div className="relative">
                <div className="pq-field-icon">
                  <Mail className="h-5 w-5" />
                </div>
                <input
                  type="text"
                  id="identifier"
                  name="identifier"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="username"
                  className="pq-input pl-11"
                  placeholder="email@example.com or 9171234567"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="pq-label">Password</label>
              <div className="relative">
                <div className="pq-field-icon">
                  <Lock className="h-5 w-5" />
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  id="password"
                  name="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  className="pq-input pl-11 pr-11"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="pq-field-toggle"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
              <div className="flex justify-end mt-2">
                <Link to="/forgot-password" className="pq-link text-sm">
                  Forgot Password?
                </Link>
              </div>
            </div>

            <button
              type="submit"
              id="login-submit-btn"
              disabled={loading}
              className="pq-btn-primary w-full mt-2"
            >
              {loading ? 'Authenticating...' : 'Sign In'}
              {!loading && <ArrowRight className="w-5 h-5" />}
            </button>
          </form>

          <div className="mt-8 text-center">
            <p className="pq-muted text-sm">
              Don't have an account?{' '}
              <Link to="/register" className="pq-link">
                Create Account
              </Link>
            </p>
            {!isNativeApp() ? (
              <p className="pq-muted text-sm mt-3">
                <a href={APP_DOWNLOAD_PAGE_PATH} className="pq-link">
                  Download Android App
                </a>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </PqAuthShell>
  );
}
