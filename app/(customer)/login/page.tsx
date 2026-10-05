'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LogIn, Mail, Lock, Eye, EyeOff, ArrowRight, ArrowLeft, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useCustomer } from '@/contexts/CustomerContext';
import PeptideLoader from '@/components/PeptideLoader';
import {
  authHref,
  clearPostAuthRedirect,
  isOrderRedirect,
  safeRedirect,
} from '@/lib/customer/post-auth-redirect';

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

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { customer } = useCustomer();

  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showAnimation, setShowAnimation] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Same-site paths only — never bounce a sign-in to another origin.
  const redirect = safeRedirect(searchParams.get('redirect')) || '/';

  useEffect(() => {
    if (customer) {
      clearPostAuthRedirect();
      router.push(redirect);
    }
  }, [customer, router, redirect]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter email and password');
      return;
    }

    setLoading(true);
    console.log('[Auth] login: starting signInWithPassword');

    try {
      const authPromise = supabase.auth.signInWithPassword({ email, password });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 10000)
      );
      const { data, error: authError } = await Promise.race([authPromise, timeout]);
      console.log('[Auth] login: auth finished', authError ? `error: ${authError.message}` : 'success');

      if (authError) {
        setError(friendlyAuthError(authError.message));
      } else if (data.session) {
        await supabase.from('customers').update({ website_accessed: 'aminocan' }).eq('id', data.session.user.id);
        setShowAnimation(true);
        console.log('[Auth] login: redirecting to', redirect);
        clearPostAuthRedirect();
        setTimeout(() => {
          router.replace(redirect);
        }, 2500);
        return;
      }
    } catch (err) {
      console.error('[Auth] login: error', err);
      setError(err instanceof Error && err.message === 'Timeout' ? 'Sign in timed out — please try again' : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
      <AnimatePresence>
        {showAnimation && <PeptideLoader message="Signing you in..." type="login" />}
      </AnimatePresence>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        {/* Back to main */}
        <div className="mb-6">
          <Link href="/" className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-ink-muted hover:text-ink transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to main site
          </Link>
        </div>

        {/* Logo */}
        <div className="text-center mb-6">
          <Link href="/login" className="inline-flex flex-col items-center gap-2">
            <img src="/images/vyta-mark.png" alt="" aria-hidden="true" className="w-12 h-12 object-contain" />
            <span className="text-lg font-bold text-ink tracking-tight">VYTA</span>
          </Link>
        </div>

        <div className="bg-white rounded-xl p-5 sm:p-6 md:p-8 border border-line shadow-sm">
          <div className="text-center mb-5 sm:mb-6">
            <h2 className="text-xl sm:text-2xl font-bold text-ink mb-1">Welcome Back</h2>
            <p className="text-ink-muted text-xs sm:text-sm">Sign in to your account</p>
          </div>

          {isOrderRedirect(redirect) && (
            <div className="mb-4 sm:mb-5 p-3 bg-surface border border-line rounded-lg text-xs sm:text-sm text-ink">
              <span className="font-semibold">Sign in to view your order.</span>{' '}
              <span className="text-ink-muted">Use the email address your order confirmation was sent to.</span>
            </div>
          )}

          {error && (
            <div className="mb-4 sm:mb-5 p-2.5 sm:p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 sm:gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <span className="text-red-700 text-xs sm:text-sm">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-10 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-ink hover:bg-ink/90 text-white font-semibold py-2.5 sm:py-3 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 text-sm"
            >
              {loading ? (
                <span>Signing in...</span>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>Sign In</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-4 text-center">
            <Link href="/forgot-password" className="text-[10px] sm:text-xs text-ink-muted hover:text-teal-dark transition-colors">
              Forgot your password?
            </Link>
          </div>

          <div className="mt-4 sm:mt-5 text-center">
            <p className="text-ink-muted text-xs sm:text-sm">
              Don&apos;t have an account?{' '}
              <Link href={authHref('/signup', redirect, email)} className="text-teal-dark hover:text-teal-dark font-medium">
                Create one
              </Link>
            </p>
          </div>

          <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-line text-center">
            <p className="text-[10px] sm:text-xs text-ink-muted">
              Looking for affiliate login?{' '}
              <Link href="/affiliate/login" className="text-teal-dark">
                Click here
              </Link>
            </p>
          </div>
        </div>
      </motion.div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-white"><span className="text-ink">Loading...</span></div>}>
      <LoginContent />
    </Suspense>
  );
}
