"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Wallet, ArrowRight, ArrowLeft, AlertCircle, ShieldCheck, Clock, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCustomer } from "@/contexts/CustomerContext";
import { isValidWalletAddress, suggestReferralCode } from "@/lib/affiliate/utils";
import ReferralCodeField, { type AvailabilityState } from "@/components/affiliate/ReferralCodeField";
import { checkReferralCode } from "@/lib/affiliate/referral-codes";

type RequestState = {
  status: "pending" | "approved" | "denied";
} | null;

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  return headers;
}

export default function AffiliateApply() {
  const router = useRouter();
  const { customer, isLoading: customerLoading } = useCustomer();

  const [walletAddress, setWalletAddress] = useState("");
  const [codeChoice, setCodeChoice] = useState("");
  const [codeAvailability, setCodeAvailability] = useState<AvailabilityState>({ kind: "idle" });
  const [message, setMessage] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [existing, setExisting] = useState<RequestState>(null);
  const [role, setRole] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitted, setSubmitted] = useState(false);

  const suggestion = customer
    ? suggestReferralCode(customer.first_name, customer.last_name)
    : null;

  // Seeded once, when the customer resolves — guarded by a ref, not by "is the
  // field empty": clearing the box is a deliberate act.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !suggestion) return;
    seeded.current = true;
    setCodeChoice(suggestion);
  }, [suggestion]);

  const checkCode = useCallback((code: string) => checkReferralCode(code), []);

  const loadRequest = useCallback(async () => {
    try {
      const res = await fetch("/api/affiliate-requests", { headers: await authHeaders() });
      if (res.ok) {
        const { request, role } = await res.json();
        setExisting(request);
        setRole(role);
      }
    } catch {
      /* ignore */
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (customerLoading) return;
    if (!customer) {
      router.replace("/login?redirect=/affiliate/apply");
      return;
    }
    loadRequest();
  }, [customerLoading, customer, router, loadRequest]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};
    if (walletAddress && !isValidWalletAddress(walletAddress)) {
      newErrors.walletAddress = "Invalid Ethereum wallet address";
    }
    if (!agreedToTerms) {
      newErrors.agreedToTerms = "You must agree to the affiliate program terms";
    }
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/affiliate-requests", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          wallet_address: walletAddress || null,
          message: message || null,
          requested_code: codeChoice || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors({ submit: data.error || "Failed to submit application" });
        return;
      }
      setSubmitted(true);
      setExisting({ status: "pending" });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (customerLoading || checking) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  // Already an affiliate.
  if (role === "affiliate") {
    return (
      <StatusShell
        icon={<CheckCircle2 className="w-6 h-6 text-emerald-500" />}
        title="You're already an affiliate"
        body="Head to your dashboard to grab your referral link and track commissions."
        cta={{ href: "/affiliate/dashboard", label: "Go to Dashboard" }}
      />
    );
  }

  // Pending request (existing or just submitted).
  if (submitted || existing?.status === "pending") {
    return (
      <StatusShell
        icon={<Clock className="w-6 h-6 text-teal-dark" />}
        title="Application received"
        body="Your affiliate application is pending review. We'll email you once an admin has made a decision."
        cta={{ href: "/", label: "Back to main site" }}
      />
    );
  }

  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4 sm:px-8 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <Link href="/" className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-ink-muted hover:text-ink transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to main site
          </Link>
        </div>

        <div className="text-center mb-6">
          <Link href="/" className="inline-flex flex-col items-center gap-2">
            <img src="/images/vyta-mark.png" alt="" aria-hidden="true" className="w-12 h-12 object-contain" />
            <span className="text-lg font-bold text-ink tracking-tight">VYTA</span>
          </Link>
        </div>

        <div className="text-center mb-5 sm:mb-6">
          <span className="text-[10px] sm:text-xs font-semibold text-teal-dark uppercase tracking-[0.2em] mb-2 block">
            Commission Program
          </span>
          <h2 className="text-xl sm:text-2xl font-bold text-ink mb-1">Apply to Become an Affiliate</h2>
          <p className="text-ink-muted text-xs sm:text-sm">Earn 10% commission on every sale you refer</p>
        </div>

        <div className="bg-white rounded-xl p-5 sm:p-6 md:p-8 border border-line shadow-sm">
          {customer && (
            <div className="mb-5 p-3 bg-teal/5 border border-teal/20 rounded-lg flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-teal-dark flex-shrink-0 mt-0.5" />
              <div className="text-xs text-ink-muted">
                Applying as <span className="font-semibold text-ink">{customer.first_name} {customer.last_name}</span>
                {" "}·{" "}
                <span className="font-mono">{customer.email}</span>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <ReferralCodeField
                value={codeChoice}
                onChange={setCodeChoice}
                onAvailabilityChange={setCodeAvailability}
                suggestion={suggestion}
                check={checkCode}
                label="Referral code you'd like"
                disabled={isSubmitting}
              />
              <p className="mt-1 text-[10px] sm:text-xs text-ink-muted">
                Held for you and issued when your application is approved.
              </p>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">
                Wallet Address <span className="text-ink-muted font-normal">(Optional)</span>
              </label>
              <div className="relative">
                <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="text"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted font-mono"
                  placeholder="0x..."
                />
              </div>
              {errors.walletAddress && (
                <p className="mt-1 text-[10px] sm:text-xs text-red-600">{errors.walletAddress}</p>
              )}
              <p className="mt-1 text-[10px] sm:text-xs text-ink-muted">For crypto commission payouts. Can be added later.</p>
            </div>

            <div>
              <label className="block text-xs sm:text-sm font-medium text-ink mb-1 sm:mb-1.5">
                Message <span className="text-ink-muted font-normal">(Optional)</span>
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="w-full px-4 py-2.5 sm:py-3 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent text-sm text-ink placeholder-ink-muted resize-none"
                placeholder="Tell us a little about how you'll promote VYTA…"
              />
            </div>

            <div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-line accent-teal cursor-pointer flex-shrink-0"
                />
                <span className="text-xs sm:text-sm text-ink-muted leading-snug">
                  I agree to abide by the{" "}
                  <Link href="/terms" className="text-teal-dark hover:text-teal-dark underline" target="_blank">
                    affiliate program terms
                  </Link>.
                </span>
              </label>
              {errors.agreedToTerms && (
                <p className="mt-1 text-[10px] sm:text-xs text-red-600">{errors.agreedToTerms}</p>
              )}
            </div>

            {errors.submit && (
              <div className="p-2.5 sm:p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span className="text-red-700 text-xs sm:text-sm">{errors.submit}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={
                isSubmitting || (codeChoice !== "" && codeAvailability.kind !== "free")
              }
              className="w-full bg-ink hover:bg-ink/90 text-white font-semibold py-2.5 sm:py-3 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 text-sm"
            >
              {isSubmitting ? <span>Submitting...</span> : (<><span>Submit Application</span><ArrowRight className="w-4 h-4" /></>)}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

function StatusShell({
  icon, title, body, cta,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: { href: string; label: string };
}) {
  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <div className="w-14 h-14 rounded-full bg-surface flex items-center justify-center mx-auto mb-4">{icon}</div>
        <h2 className="text-xl font-bold text-ink mb-2">{title}</h2>
        <p className="text-ink-muted text-sm mb-6">{body}</p>
        <Link
          href={cta.href}
          className="inline-flex items-center gap-2 bg-ink text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-ink/90 transition-colors"
        >
          {cta.label}
        </Link>
      </div>
    </main>
  );
}
