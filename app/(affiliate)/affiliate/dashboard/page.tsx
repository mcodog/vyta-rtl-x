"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useAffiliate } from "@/contexts/AffiliateContext";
import { useCustomer } from "@/contexts/CustomerContext";
import {
  getAffiliateStats,
  getAffiliateCommissions,
  getReferralCodes,
} from "@/lib/affiliate/api";
import type { Commission, ReferralCode } from "@/lib/supabase";
import { formatCurrency } from "@/lib/affiliate/utils";
import {
  DollarSign,
  TrendingUp,
  Users,
  Clock,
  LogOut,
  Code,
  Receipt,
  Beaker,
  Copy,
  Check,
  Share2,
  Settings,
} from "lucide-react";
import Link from "next/link";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";

const statusColors: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 border-emerald-100",
  pending: "bg-amber-50 text-amber-700 border-amber-100",
  cancelled: "bg-red-50 text-red-700 border-red-100",
};

export default function AffiliateDashboard() {
  const router = useRouter();
  const { affiliate, isLoading: affiliateLoading } = useAffiliate();
  const { customer, isLoading: customerLoading, logout } = useCustomer();
  const [stats, setStats] = useState({
    totalEarnings: 0,
    pendingEarnings: 0,
    totalReferrals: 0,
    totalCommissions: 0,
  });
  const [recentCommissions, setRecentCommissions] = useState<Commission[]>([]);
  const [referralCodes, setReferralCodes] = useState<ReferralCode[]>([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (customerLoading || affiliateLoading) return;
    if (!customer) {
      router.push("/login");
      return;
    }
    if (!affiliate) {
      router.push("/affiliate/signup");
      return;
    }
    loadDashboardData();
  }, [customerLoading, affiliateLoading, customer, affiliate, router]);

  const loadDashboardData = async () => {
    if (!affiliate) return;

    setIsLoading(true);
    try {
      const [statsData, commissions, codes] = await Promise.all([
        getAffiliateStats(affiliate.id),
        getAffiliateCommissions(affiliate.id),
        getReferralCodes(affiliate.id),
      ]);
      setStats(statsData);
      setRecentCommissions(commissions.slice(0, 10));
      setReferralCodes(codes);
    } catch {
      // leave state as defaults
    } finally {
      setIsLoading(false);
    }
  };

  const primaryCode = referralCodes.find((c) => c.active);

  const copyToClipboard = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const copyReferralUrl = async (code: string) => {
    const url = `${window.location.origin}?ref=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCode(`url-${code}`);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (error) {
      console.error("Failed to copy URL:", error);
    }
  };

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  if (!affiliate) return null;

  return (
    <main className="min-h-screen bg-white">
      <Navigation />

      <div className="pt-28 sm:pt-32 md:pt-44 pb-16 sm:pb-20 md:pb-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 lg:px-12">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col md:flex-row md:items-center md:justify-between mb-6 sm:mb-8 md:mb-10"
          >
            <div>
              <span className="text-[10px] sm:text-xs font-semibold text-teal-dark uppercase tracking-[0.2em] mb-2 sm:mb-3 block">
                Affiliate Dashboard
              </span>
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-ink mb-1 sm:mb-2">
                Welcome, {affiliate.first_name}!
              </h1>
              <p className="text-ink-muted text-xs sm:text-sm">
                Track your earnings and referrals
              </p>
            </div>

            <div className="flex items-center gap-2 sm:gap-3 mt-4 md:mt-0">
              <Link
                href="/affiliate/settings"
                className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 bg-white border border-line text-ink font-medium rounded-lg hover:bg-surface transition-colors text-xs sm:text-sm"
              >
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">Settings</span>
              </Link>
              <button
                onClick={handleLogout}
                className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 bg-white border border-line text-ink-muted font-medium rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors text-xs sm:text-sm"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </motion.div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-5 mb-6 sm:mb-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="bg-white rounded-xl p-3 sm:p-4 md:p-5 border border-line"
            >
              <div className="flex items-center justify-between mb-2 sm:mb-3">
                <div className="w-8 sm:w-10 h-8 sm:h-10 bg-emerald-500/10 rounded-lg flex items-center justify-center">
                  <DollarSign className="w-4 sm:w-5 h-4 sm:h-5 text-emerald-500" />
                </div>
                <span className="text-[8px] sm:text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                  Paid
                </span>
              </div>
              <div className="text-lg sm:text-2xl md:text-3xl font-bold text-ink mb-0.5 sm:mb-1 tabular-nums">
                {formatCurrency(stats.totalEarnings)}
              </div>
              <p className="text-[10px] sm:text-xs text-ink-muted">
                Total Earnings
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-white rounded-xl p-3 sm:p-4 md:p-5 border border-line"
            >
              <div className="flex items-center justify-between mb-2 sm:mb-3">
                <div className="w-8 sm:w-10 h-8 sm:h-10 bg-amber-500/10 rounded-lg flex items-center justify-center">
                  <Clock className="w-4 sm:w-5 h-4 sm:h-5 text-amber-500" />
                </div>
                <span className="text-[8px] sm:text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                  Pending
                </span>
              </div>
              <div className="text-lg sm:text-2xl md:text-3xl font-bold text-ink mb-0.5 sm:mb-1 tabular-nums">
                {formatCurrency(stats.pendingEarnings)}
              </div>
              <p className="text-[10px] sm:text-xs text-ink-muted">
                Pending Earnings
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="bg-white rounded-xl p-3 sm:p-4 md:p-5 border border-line"
            >
              <div className="flex items-center justify-between mb-2 sm:mb-3">
                <div className="w-8 sm:w-10 h-8 sm:h-10 bg-blue-500/10 rounded-lg flex items-center justify-center">
                  <Users className="w-4 sm:w-5 h-4 sm:h-5 text-blue-500" />
                </div>
                <span className="text-[8px] sm:text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                  Referrals
                </span>
              </div>
              <div className="text-lg sm:text-2xl md:text-3xl font-bold text-ink mb-0.5 sm:mb-1 tabular-nums">
                {stats.totalReferrals}
              </div>
              <p className="text-[10px] sm:text-xs text-ink-muted">
                Total Referrals
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-white rounded-xl p-3 sm:p-4 md:p-5 border border-line"
            >
              <div className="flex items-center justify-between mb-2 sm:mb-3">
                <div className="w-8 sm:w-10 h-8 sm:h-10 bg-purple-500/10 rounded-lg flex items-center justify-center">
                  <TrendingUp className="w-4 sm:w-5 h-4 sm:h-5 text-purple-500" />
                </div>
                <span className="text-[8px] sm:text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                  Orders
                </span>
              </div>
              <div className="text-lg sm:text-2xl md:text-3xl font-bold text-ink mb-0.5 sm:mb-1 tabular-nums">
                {stats.totalCommissions}
              </div>
              <p className="text-[10px] sm:text-xs text-ink-muted">
                Commission Records
              </p>
            </motion.div>
          </div>

          {/* Referral Code Card */}
          {!isLoading && primaryCode && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
              className="bg-white rounded-xl p-4 sm:p-5 md:p-6 border border-line mb-6 sm:mb-8"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="text-base sm:text-lg font-bold text-ink flex items-center gap-2 mb-2">
                    <Code className="w-4 sm:w-5 h-4 sm:h-5 text-teal-dark" />
                    Your Referral Code
                  </h2>
                  <div className="inline-block bg-surface rounded-lg px-4 py-2 border border-line">
                    <span className="text-xl sm:text-2xl md:text-3xl font-bold text-ink tracking-wider font-mono">
                      {primaryCode.code}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-[10px] sm:text-xs text-ink-muted">
                    {/* <span>{primaryCode.uses_count} uses</span>
                    <span>10% commission</span> */}
                    <span className="text-emerald-600">Active</span>
                  </div>
                </div>
                <div className="flex flex-row sm:flex-col gap-2">
                  <button
                    onClick={() => copyToClipboard(primaryCode.code)}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2 bg-ink hover:bg-ink/90 text-white font-semibold rounded-lg transition-all text-xs sm:text-sm"
                  >
                    {copiedCode === primaryCode.code ? (
                      <>
                        <Check className="w-4 h-4" /> Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4" /> Copy Code
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => copyReferralUrl(primaryCode.code)}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2 bg-white hover:bg-surface border border-line text-ink font-medium rounded-lg transition-colors text-xs sm:text-sm"
                  >
                    {copiedCode === `url-${primaryCode.code}` ? (
                      <>
                        <Check className="w-4 h-4" /> URL Copied!
                      </>
                    ) : (
                      <>
                        <Share2 className="w-4 h-4" /> Copy URL
                      </>
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* Recent Commissions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-white rounded-xl border border-line overflow-hidden"
          >
            <div className="p-4 sm:p-5 md:p-6 border-b border-line">
              <h2 className="text-base sm:text-lg font-bold text-ink flex items-center gap-2">
                <Receipt className="w-4 sm:w-5 h-4 sm:h-5 text-teal-dark" />
                Recent Commissions
              </h2>
            </div>

            {isLoading ? (
              <div className="p-8 sm:p-12 text-center">
                <div className="animate-pulse text-ink-muted text-xs sm:text-sm">
                  Loading commissions...
                </div>
              </div>
            ) : recentCommissions.length === 0 ? (
              <div className="p-8 sm:p-12 text-center">
                <div className="w-12 sm:w-14 h-12 sm:h-14 bg-surface rounded-xl flex items-center justify-center mx-auto mb-3 sm:mb-4">
                  <Beaker className="w-6 sm:w-7 h-6 sm:h-7 text-line" />
                </div>
                <p className="text-ink-muted text-xs sm:text-sm mb-1 sm:mb-2">
                  No commissions yet
                </p>
                <p className="text-ink-muted text-[10px] sm:text-xs">
                  Share your referral code to start earning commissions!
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="text-left py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider">
                        Reference
                      </th>
                      <th className="text-left py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider">
                        Order Total
                      </th>
                      <th className="text-left py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider">
                        Commission
                      </th>
                      <th className="text-left py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider hidden sm:table-cell">
                        Status
                      </th>
                      <th className="text-left py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-xs font-semibold text-ink-muted uppercase tracking-wider hidden sm:table-cell">
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {recentCommissions.map((commission) => {
                      // Storefront sales carry order_id; hosted (Stealth Health)
                      // sales carry invoice_id instead, with order_id null.
                      const reference = commission.order_id ?? commission.invoice_id ?? "";
                      return (
                      <tr
                        key={commission.id}
                        className="hover:bg-surface transition-colors"
                      >
                        <td className="py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-sm text-ink font-mono">
                          <span className="hidden sm:inline">
                            {reference.substring(0, 12)}...
                          </span>
                          <span className="sm:hidden">
                            {reference.substring(0, 8)}...
                          </span>
                        </td>
                        <td className="py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-sm text-ink tabular-nums">
                          {formatCurrency(Number(commission.order_total))}
                        </td>
                        <td className="py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-sm font-semibold text-emerald-600 tabular-nums">
                          {formatCurrency(Number(commission.amount))}
                        </td>
                        <td className="py-2 sm:py-3 px-3 sm:px-5 hidden sm:table-cell">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] sm:text-xs font-medium border ${statusColors[commission.status] || "bg-surface text-ink-muted border-line"}`}
                          >
                            {(commission.status ?? "").toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2 sm:py-3 px-3 sm:px-5 text-[10px] sm:text-sm text-ink-muted hidden sm:table-cell">
                          {new Date(commission.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
