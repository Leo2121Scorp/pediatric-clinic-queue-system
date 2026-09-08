import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { applyActionCode } from "firebase/auth";
import { CheckCircle, Mail } from "lucide-react";
import { auth } from "../../firebase/auth";
import { completeParentRegistration } from "../../services/authService";
import { mapAuthError } from "../../utils/authErrors";

export default function AuthAction() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const mode = searchParams.get("mode");
  const oobCode = searchParams.get("oobCode");

  const [status, setStatus] = useState("loading"); // loading | success | error
  const [errorMessage, setErrorMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");

  useEffect(() => {
    if (!mode || !oobCode) {
      setStatus("error");
      setErrorMessage("This link is invalid or incomplete. Please request a new email.");
      return;
    }

    if (mode === "resetPassword") {
      navigate(`/reset-password?oobCode=${encodeURIComponent(oobCode)}`, { replace: true });
      return;
    }

    if (mode === "verifyEmail") {
      let cancelled = false;

      (async () => {
        try {
          await applyActionCode(auth, oobCode);
          if (cancelled) return;

          const firebaseUser = auth.currentUser;
          if (firebaseUser) {
            await firebaseUser.reload();
            await completeParentRegistration(firebaseUser);
            if (cancelled) return;
            setStatus("success");
            navigate("/onboarding/child", { replace: true });
            return;
          }

          setStatus("success");
        } catch (err) {
          console.error("Email verification action failed:", err);
          if (cancelled) return;
          setErrorCode(err.code || "");
          setErrorMessage(mapAuthError(err.code));
          setStatus("error");
        }
      })();

      return () => {
        cancelled = true;
      };
    }

    setStatus("error");
    setErrorMessage("Unsupported action. Please use the link from your latest email.");
  }, [mode, oobCode, navigate]);

  if (status === "loading" || mode === "resetPassword") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4 font-sans">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  const isExpiredOrInvalid =
    errorCode === "auth/expired-action-code" || errorCode === "auth/invalid-action-code";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden text-center p-8">
        <div
          className={`mx-auto w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-sm border ${
            status === "success"
              ? "bg-green-50 text-green-600 border-green-100"
              : "bg-red-50 text-red-600 border-red-100"
          }`}
        >
          {status === "success" ? <CheckCircle className="w-8 h-8" /> : <Mail className="w-8 h-8" />}
        </div>

        {status === "success" ? (
          <>
            <h1 className="text-2xl font-bold text-gray-800 tracking-tight mb-2">Email Verified</h1>
            <p className="text-gray-500 text-sm mb-6">
              Your email has been verified successfully. You can now sign in to continue.
            </p>
            <Link
              to="/"
              className="w-full flex items-center justify-center py-3.5 px-4 bg-blue-600 text-white font-bold rounded-xl shadow-sm transition-all hover:bg-blue-700 hover:shadow"
            >
              Continue to Login
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-gray-800 tracking-tight mb-2">Link Problem</h1>
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100">
              {errorMessage}
            </div>
            <div className="space-y-3">
              {isExpiredOrInvalid && (
                <Link
                  to="/verify-email"
                  className="w-full flex items-center justify-center py-3.5 px-4 bg-blue-600 text-white font-bold rounded-xl shadow-sm transition-all hover:bg-blue-700 hover:shadow"
                >
                  Resend Verification Email
                </Link>
              )}
              <Link
                to="/"
                className="w-full flex items-center justify-center py-3.5 px-4 bg-white border border-gray-200 text-gray-700 font-bold rounded-xl transition-all hover:bg-gray-50"
              >
                Back to Login
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
