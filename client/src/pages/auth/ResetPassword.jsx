import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { auth } from "../../firebase/auth";
import { verifyPasswordResetCode, confirmPasswordReset } from "firebase/auth";
import { Activity, Lock, ArrowRight, Eye, EyeOff, CheckCircle } from "lucide-react";
import toast from "react-hot-toast";
import { mapAuthError } from "../../utils/authErrors";
import { usePasswordValidation } from "../../utils/passwordUtils";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const oobCode = searchParams.get('oobCode');

  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');
  
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const { isValid: isPasswordValid, errors: passwordErrors, isChecking } = usePasswordValidation(newPassword);

  const passwordInvalid = newPassword.length > 0 && !isPasswordValid;
  const isConfirmValid = newPassword && newPassword === confirmPassword;
  const confirmInvalid = confirmPassword.length > 0 && !isConfirmValid;
  const isFormValid = isPasswordValid && isConfirmValid && !isChecking;

  useEffect(() => {
    if (!oobCode) {
      setError("This password reset link is invalid or has expired. Please request a new password reset email.");
      setValidating(false);
      return;
    }

    verifyPasswordResetCode(auth, oobCode)
      .then((userEmail) => {
        setEmail(userEmail);
        setValidating(false);
      })
      .catch((err) => {
        console.error("Code verification failed:", err);
        setError("This password reset link is invalid or has expired. Please request a new password reset email.");
        setValidating(false);
      });
  }, [oobCode]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (isChecking) return;

    if (!isPasswordValid) {
      toast.error('Password does not meet requirements.');
      return;
    }
    
    if (!isConfirmValid) {
      toast.error("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      await confirmPasswordReset(auth, oobCode, newPassword);
      setIsSuccess(true);
      toast.success("Password reset successfully.");
    } catch (err) {
      console.error('Password reset failed:', err);
      toast.error(mapAuthError(err.code));
    } finally {
      setLoading(false);
    }
  };

  if (validating) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4 font-sans">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        {/* Header Section */}
        <div className="pt-10 pb-6 px-8 text-center border-b border-gray-50">
          <div className="mx-auto w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-sm border border-blue-100">
            <Activity className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800 tracking-tight">Reset Password</h1>
          {!error && !isSuccess && (
            <p className="text-gray-500 font-medium mt-2 text-sm">Create a new password for {email}</p>
          )}
        </div>

        {/* Form Section */}
        <div className="p-8">
          {error ? (
            <div className="text-center">
              <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100">
                {error}
              </div>
              <Link
                to="/forgot-password"
                className="w-full flex items-center justify-center py-3.5 px-4 bg-blue-600 text-white font-bold rounded-xl shadow-sm transition-all hover:bg-blue-700 hover:shadow mt-4"
              >
                Request New Link
              </Link>
            </div>
          ) : isSuccess ? (
            <div className="text-center">
              <div className="mb-6 p-4 bg-green-50 text-green-700 rounded-xl text-sm font-medium border border-green-100">
                Password successfully reset. You can now sign in with your new password.
              </div>
              <Link
                to="/"
                className="w-full flex items-center justify-center py-3.5 px-4 bg-blue-600 text-white font-bold rounded-xl shadow-sm transition-all hover:bg-blue-700 hover:shadow mt-4"
              >
                Return to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="newPassword" className="block text-sm font-semibold text-gray-700 mb-1.5">New Password</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                      <Lock className="h-5 w-5 text-gray-400" />
                    </div>
                    <input
                      type={showPassword ? "text" : "password"}
                      id="newPassword"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      className={`w-full pl-10 pr-10 py-3 bg-gray-50 border text-gray-800 rounded-xl focus:outline-none transition-colors ${
                        passwordInvalid
                          ? 'border-red-300 focus:ring-2 focus:ring-red-500/20 focus:border-red-500'
                          : 'border-gray-200 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white'
                      }`}
                      placeholder="Enter new password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                      tabIndex="-1"
                    >
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                </div>

                {passwordInvalid && passwordErrors.length > 0 && (
                  <p className="text-xs text-red-500 font-semibold px-1 pt-1.5">
                    {passwordErrors[0]}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-semibold text-gray-700 mb-1.5">Confirm Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    id="confirmPassword"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className={`w-full pl-10 pr-10 py-3 bg-gray-50 border text-gray-800 rounded-xl focus:outline-none transition-colors ${
                      confirmInvalid
                        ? 'border-red-300 focus:ring-2 focus:ring-red-500/20 focus:border-red-500'
                        : 'border-gray-200 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white'
                    }`}
                    placeholder="Confirm new password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                    tabIndex="-1"
                  >
                    {showConfirmPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
                {confirmInvalid && (
                  <p className="text-xs text-red-500 font-semibold px-1 pt-1.5">
                    Passwords do not match.
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={loading || !isFormValid || isChecking}
                className={`w-full flex items-center justify-center py-3.5 px-4 font-bold rounded-xl shadow-sm transition-all mt-4 ${
                  loading || !isFormValid || isChecking ? "bg-blue-400 text-white cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700 hover:shadow"
                }`}
              >
                {loading ? 'Resetting...' : 'Reset Password'}
                {!loading && <ArrowRight className="w-5 h-5 ml-2" />}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
