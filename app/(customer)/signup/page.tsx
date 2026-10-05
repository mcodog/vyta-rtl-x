'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { motion } from 'framer-motion';
import { UserPlus, Mail, Lock, User, ArrowRight, ArrowLeft, AlertCircle, Check, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signUpCustomer } from '@/lib/customer/api';
import { useCustomer } from '@/contexts/CustomerContext';
import { supabase } from '@/lib/supabase';
import {
  authHref,
  clearPostAuthRedirect,
  isOrderRedirect,
  rememberPostAuthRedirect,
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

function SignupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { customer } = useCustomer();

  const [formData, setFormData] = useState({
    email: searchParams.get('email') ?? '',
    firstName: '',
    lastName: '',
    password: '',
    confirmPassword: '',
  });
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [agreedToResearcher, setAgreedToResearcher] = useState(false);
  const [consentToContact, setConsentToContact] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  // Email existence check state
  const [emailExists, setEmailExists] = useState<boolean | null>(null);
  const [emailChecking, setEmailChecking] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same-site paths only — never bounce a sign-up to another origin.
  const redirect = safeRedirect(searchParams.get('redirect')) || '/';

  useEffect(() => {
    if (customer) {
      clearPostAuthRedirect();
      router.push(redirect);
    }
  }, [customer, router, redirect]);

  // Debounced email check against the customers table
  useEffect(() => {
    const email = formData.email;

    if (!email.includes('@') || email.length < 5) {
      setEmailExists(null);
      setEmailChecking(false);
      return;
    }

    setEmailChecking(true);
    setEmailExists(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const { data } = await supabase
        .from('customers')
        .select('id')
        .eq('email', email.toLowerCase())
        .maybeSingle();

      setEmailChecking(false);
      setEmailExists(data !== null);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [formData.email]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!formData.firstName.trim() || !formData.lastName.trim()) {
      setError('Please enter your full name');
      return;
    }

    if (!formData.email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!agreedToTerms || !agreedToResearcher) {
      setError('You must agree to both checkboxes to create an account');
      return;
    }

    if (emailExists) {
      setError('An account with this email already exists');
      return;
    }

    setLoading(true);

    const result = await signUpCustomer({
      email: formData.email,
      password: formData.password,
      firstName: formData.firstName,
      lastName: formData.lastName,
      contactConsent: consentToContact,
    });

    if (result.success) {
      // The email-confirmation link signs them in on the home page; resume
      // the destination (e.g. their order) from there.
      rememberPostAuthRedirect(redirect);
      setSuccess(true);
    } else {
      setError(friendlyAuthError(result.error));
    }

    setLoading(false);
  };

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
          <div className="bg-white rounded-xl p-5 sm:p-6 md:p-8 border border-line text-center shadow-sm">
            <div className="w-12 sm:w-14 h-12 sm:h-14 bg-emerald-50 rounded-xl flex items-center justify-center mx-auto mb-4 sm:mb-5 border border-emerald-100">
              <Check className="w-6 sm:w-7 h-6 sm:h-7 text-emerald-600" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-ink mb-2 sm:mb-3">Check Your Email</h2>
            <p className="text-ink-muted mb-5 sm:mb-6 text-xs sm:text-sm leading-relaxed">
              We sent a confirmation link to <span className="font-medium text-ink">{formData.email}</span>.
              Click the link to verify your account.
            </p>
            <Link
              href={authHref('/login', redirect, formData.email)}
              className="inline-flex items-center gap-2 text-teal-dark hover:text-teal-dark font-semibold text-sm"
            >
              Go to Login
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
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
            <h2 className="text-xl sm:text-2xl font-bold text-ink mb-1">Create Account</h2>
            <p className="text-ink-muted text-xs sm:text-sm">Join us for exclusive access and order tracking</p>
          </div>

          {isOrderRedirect(redirect) && (
            <div className="mb-4 sm:mb-5 p-3 bg-surface border border-line rounded-lg text-xs sm:text-sm text-ink">
              <span className="font-semibold">Create an account to view your order.</span>{' '}
              <span className="text-ink-muted">Use the email address your order confirmation was sent to — you&apos;ll go straight to your order once you&apos;re signed in.</span>
            </div>
          )}

          {error && (
            <div className="mb-4 sm:mb-5 p-2.5 sm:p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 sm:gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <span className="text-red-700 text-xs sm:text-sm">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <div>
                <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">First Name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    type="text"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleChange}
                    className="w-full pl-10 pr-2 sm:pr-3 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted"
                    placeholder="John"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Last Name</label>
                <input
                  type="text"
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleChange}
                  className="w-full px-3 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted"
                  placeholder="Doe"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  className={`w-full pl-10 pr-10 py-2.5 sm:py-3 bg-surface rounded-lg border focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted ${
                    emailExists === true
                      ? 'border-red-400'
                      : emailExists === false
                      ? 'border-emerald-400'
                      : 'border-line'
                  }`}
                  placeholder="you@example.com"
                />
                {emailChecking && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted animate-spin" />
                )}
                {!emailChecking && emailExists === false && (
                  <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />
                )}
                {!emailChecking && emailExists === true && (
                  <XCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />
                )}
              </div>
              {emailExists === true && (
                <p className="mt-1 text-[10px] sm:text-xs text-red-600">
                  An account with this email already exists.{' '}
                  <Link href={authHref('/login', redirect, formData.email)} className="underline font-medium">Sign in</Link>
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="password"
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  className="w-full pl-10 pr-4 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted"
                  placeholder="Min. 8 characters"
                />
              </div>
              <p className={`mt-1 text-[10px] sm:text-xs ${formData.password && formData.password.length < 8 ? 'text-red-600' : 'text-ink-muted'}`}>
                Must be at least 8 characters.
              </p>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="password"
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  className={`w-full pl-10 pr-10 py-2.5 sm:py-3 bg-surface rounded-lg border focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted ${
                    formData.confirmPassword
                      ? formData.password === formData.confirmPassword
                        ? 'border-emerald-300'
                        : 'border-red-300'
                      : 'border-line'
                  }`}
                  placeholder="Confirm your password"
                />
                {formData.confirmPassword && formData.password === formData.confirmPassword && (
                  <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />
                )}
              </div>
            </div>

            {/* Checkboxes */}
            <div className="space-y-3 pt-1">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[#07203a] flex-shrink-0 cursor-pointer"
                />
                <span className="text-xs text-ink-muted leading-relaxed">
                  I agree to the{' '}
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal-dark underline hover:text-teal-dark"
                  >
                    Terms and Conditions
                  </a>{' '}
                  of this website
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToResearcher}
                  onChange={(e) => setAgreedToResearcher(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[#07203a] flex-shrink-0 cursor-pointer"
                />
                <span className="text-xs text-ink-muted leading-relaxed">
                  I am a professional researcher and understand how to properly handle and use these products
                  for research purposes only. I acknowledge these products are not intended for human
                  consumption.
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentToContact}
                  onChange={(e) => setConsentToContact(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[#07203a] flex-shrink-0 cursor-pointer"
                />
                <span className="text-xs text-ink-muted leading-relaxed">
                  I consent to being contacted by an VYTA representative if I run into any issues on the
                  site, or for information and guidance about peptides. <span className="text-ink-muted/70">(Optional)</span>
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading || !agreedToTerms || !agreedToResearcher || emailExists === true || emailChecking}
              className="w-full bg-ink hover:bg-ink/90 text-white font-semibold py-2.5 sm:py-3 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 text-sm"
            >
              {loading ? (
                <span>Creating account...</span>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  <span>Create Account</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-5 sm:mt-6 text-center">
            <p className="text-ink-muted text-xs sm:text-sm">
              Already have an account?{' '}
              <Link href={authHref('/login', redirect, formData.email)} className="text-teal-dark hover:text-teal-dark font-medium">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </motion.div>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-white"><span className="text-ink">Loading...</span></div>}>
      <SignupContent />
    </Suspense>
  );
}
