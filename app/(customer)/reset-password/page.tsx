'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { motion } from 'framer-motion';
import { Lock, ArrowRight, AlertCircle, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Maps common raw Supabase auth error strings to friendly, human copy.
function friendlyAuthError(message?: string): string {
  const msg = (message || '').toLowerCase();
  if (!msg) return 'Something went wrong. Please try again.';
  if (msg.includes('invalid login credentials')) return 'The email or password you entered is incorrect.';
  if (msg.includes('email not confirmed')) return 'Please confirm your email address before signing in. Check your inbox for the verification link.';
  if (msg.includes('user already registered') || msg.includes('already been registered') || msg.includes('already registered')) return 'An account with this email already exists. Try signing in instead.';
  if (msg.includes('new password should be different')) return 'Your new password must be different from your current one.';
  if (msg.includes('password should be at least') || msg.includes('password is too short')) return 'Please choose a password with at least 8 characters.';
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('for security purposes')) return 'Too many attempts. Please wait a moment and try again.';
  if (msg.includes('token has expired') || msg.includes('expired or is invalid') || msg.includes('invalid or has expired') || msg.includes('otp') || msg.includes('expired')) return 'This link has expired or is no longer valid. Please request a new one.';
  if (msg.includes('unable to validate email') || msg.includes('invalid format') || (msg.includes('email') && msg.includes('invalid'))) return 'Please enter a valid email address.';
  if (msg.includes('signups not allowed') || msg.includes('signup is disabled') || msg.includes('signups are disabled')) return 'Account creation is currently unavailable. Please try again later.';
  if (msg.includes('network') || msg.includes('failed to fetch')) return 'Network error. Please check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

// A recovery token_hash is single-use. Share one verification per token so a
// re-run effect (React Strict Mode, a remount) can't spend it twice and then
// report the link as expired.
const recoveryVerifications = new Map<string, ReturnType<typeof supabase.auth.verifyOtp>>();
function verifyRecoveryToken(tokenHash: string) {
  let pending = recoveryVerifications.get(tokenHash);
  if (!pending) {
    pending = supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
    recoveryVerifications.set(tokenHash, pending);
  }
  return pending;
}

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState('');

  useEffect(() => {
    // Supabase redirects back with tokens in the URL hash or as query params (PKCE flow).
    // onAuthStateChange fires with SIGNED_IN / PASSWORD_RECOVERY event once tokens are exchanged.
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const markReady = () => {
      if (settled) return;
      settled = true;
      setSessionReady(true);
      clearTimeout(timer);
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setSessionError('This password reset link is invalid or has expired. Please request a new one.');
    };

    // The email template links here directly with `?token_hash=…&type=recovery`
    // (see supabase/email-templates/README.md). Verifying it on this page means
    // the link never passes through GoTrue's redirect allow-list, so it cannot
    // fall back to the homepage. Wait for it before trusting any session: one
    // already in storage may belong to a different account than the link's.
    const tokenHash = searchParams.get('token_hash');
    if (tokenHash && searchParams.get('type') === 'recovery') {
      verifyRecoveryToken(tokenHash).then(({ error }) => {
        if (error) {
          console.error('[Auth] reset-password: verifyOtp error', error.message);
          fail();
          return;
        }
        // Drop the single-use token from the address bar.
        window.history.replaceState(null, '', '/reset-password');
        markReady();
      });
      timer = setTimeout(fail, 15000);
      return () => clearTimeout(timer);
    }

    // GoTrue reports a spent/expired link in the hash, e.g. #error_code=otp_expired.
    if (/(^#|&)error(_code)?=/.test(window.location.hash)) {
      fail();
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        markReady();
      }
    });

    // Also check if there's already an active session (e.g. page reload, or
    // the recovery session forwarded from the homepage by lib/supabase.ts)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) markReady();
    });

    // If no valid recovery session arrives within a few seconds, the link is
    // expired/invalid — surface the recovery UI instead of hanging forever.
    timer = setTimeout(() => {
      if (!settled) {
        setSessionError('This password reset link is invalid or has expired. Please request a new one.');
      }
    }, 5000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    console.log('[Auth] reset-password: calling updateUser');

    try {
      const updatePromise = supabase.auth.updateUser({ password });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 10000)
      );
      const { error: updateError } = await Promise.race([updatePromise, timeout]);
      console.log('[Auth] reset-password: updateUser done', updateError ? `error: ${updateError.message}` : 'success');

      if (updateError) {
        setError(friendlyAuthError(updateError.message));
        return;
      }

      setSuccess(true);
      setTimeout(() => router.push('/'), 2500);
    } catch (err) {
      console.error('[Auth] reset-password: error', err);
      setError(err instanceof Error && err.message === 'Timeout' ? 'Password update timed out — please try again' : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const passwordsMatch = confirmPassword && password === confirmPassword;

  if (!sessionReady && !sessionError) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-ink-muted text-sm">Verifying reset link...</p>
        </div>
      </main>
    );
  }

  if (sessionError) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
        <div className="w-full max-w-md text-center">
          <div className="bg-white rounded-xl p-6 sm:p-8 border border-line shadow-sm">
            <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <h2 className="text-xl font-bold text-ink mb-2">Invalid Reset Link</h2>
            <p className="text-ink-muted text-sm mb-5">{sessionError}</p>
            <Link href="/forgot-password" className="inline-flex items-center gap-2 text-teal-dark hover:text-teal-dark font-semibold text-sm">
              Request a new link
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (success) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <Link href="/login" className="inline-flex flex-col items-center gap-2">
              <img src="/images/vyta-mark.png" alt="" aria-hidden="true" className="w-12 h-12 object-contain" />
              <span className="text-lg font-bold text-ink tracking-tight">VYTA</span>
            </Link>
          </div>
          <div className="bg-white rounded-xl p-6 sm:p-8 border border-line text-center shadow-sm">
            <div className="w-12 sm:w-14 h-12 sm:h-14 bg-emerald-50 rounded-xl flex items-center justify-center mx-auto mb-4 border border-emerald-100">
              <Check className="w-6 sm:w-7 h-6 sm:h-7 text-emerald-600" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-ink mb-2">Password Updated</h2>
            <p className="text-ink-muted text-xs sm:text-sm">Your password has been reset. Redirecting you now...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-6">
          <Link href="/login" className="inline-flex flex-col items-center gap-2">
            <img src="/images/vyta-mark.png" alt="" aria-hidden="true" className="w-12 h-12 object-contain" />
            <span className="text-lg font-bold text-ink tracking-tight">VYTA</span>
          </Link>
        </div>

        <div className="bg-white rounded-xl p-6 sm:p-8 border border-line shadow-sm">
          <div className="text-center mb-5 sm:mb-6">
            <h2 className="text-xl sm:text-2xl font-bold text-ink mb-1">Set New Password</h2>
            <p className="text-ink-muted text-xs sm:text-sm">Choose a strong password for your account</p>
          </div>

          {error && (
            <div className="mb-4 p-2.5 sm:p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <span className="text-red-700 text-xs sm:text-sm">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">New Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted"
                  placeholder="Min. 8 characters"
                  autoComplete="new-password"
                />
              </div>
              <p className={`mt-1 text-[10px] sm:text-xs ${password && password.length < 8 ? 'text-red-600' : 'text-ink-muted'}`}>
                Must be at least 8 characters.
              </p>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`w-full pl-10 pr-10 py-2.5 sm:py-3 bg-surface rounded-lg border focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted ${
                    confirmPassword
                      ? passwordsMatch
                        ? 'border-emerald-300'
                        : 'border-red-300'
                      : 'border-line'
                  }`}
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                />
                {passwordsMatch && (
                  <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-ink hover:bg-ink/90 text-white font-semibold py-2.5 sm:py-3 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 text-sm"
            >
              {loading ? (
                <span>Updating...</span>
              ) : (
                <>
                  <span>Update Password</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </motion.div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-white"><span className="text-ink">Loading...</span></div>}>
      <ResetPasswordContent />
    </Suspense>
  );
}
