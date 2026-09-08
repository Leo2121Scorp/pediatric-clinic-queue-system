import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { auth } from "../../firebase/auth";
import { sendPasswordResetEmail } from "firebase/auth";
import { Activity, Mail, ArrowRight } from "lucide-react";
import toast from "react-hot-toast";

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const actionCodeSettings = {
        url: `${window.location.origin}/reset-password`,
        handleCodeInApp: true
      };
      await sendPasswordResetEmail(auth, email, actionCodeSettings);
      setIsSuccess(true);
      toast.success("Password reset email sent.");
    } catch (err) {
      console.error('Password reset failed:', err);
      if (err.code === 'auth/user-not-found') {
        toast.error("No user found with this email address.");
      } else if (err.code === 'auth/invalid-email') {
        toast.error("Please enter a valid email address.");
      } else {
        toast.error("Unable to send reset email. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        {/* Header Section */}
        <div className="pt-10 pb-6 px-8 text-center border-b border-gray-50">
          <div className="mx-auto w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-sm border border-blue-100">
            <Activity className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800 tracking-tight">Reset Password</h1>
          <p className="text-gray-500 font-medium mt-2 text-sm">Enter your email to receive a reset link</p>
        </div>

        {/* Form Section */}
        <div className="p-8">
          {isSuccess ? (
            <div className="text-center">
              <div className="mb-6 p-4 bg-green-50 text-green-700 rounded-xl text-sm font-medium border border-green-100">
                A password reset link has been sent to {email}. Please check your inbox.
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
              <div>
                <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-1.5">Email Address</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    type="email"
                    id="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 text-gray-800 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white transition-colors outline-none"
                    placeholder="Enter your email"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className={`w-full flex items-center justify-center py-3.5 px-4 bg-blue-600 text-white font-bold rounded-xl shadow-sm transition-all mt-2 ${
                  loading ? "opacity-70 cursor-not-allowed" : "hover:bg-blue-700 hover:shadow"
                }`}
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
                {!loading && <ArrowRight className="w-5 h-5 ml-2" />}
              </button>
            </form>
          )}

          {!isSuccess && (
            <div className="mt-8 text-center">
              <Link to="/" className="text-blue-600 font-semibold hover:underline transition-all text-sm">
                Back to Login
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
