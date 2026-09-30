'use client';

import React, { useEffect, useState, createContext, useContext } from 'react';
import { LayoutDashboard, Users, DollarSign, UserCircle, ArrowLeft, Mail, Lock, LogIn, AlertCircle, Info, ShoppingBag, FileText, ClipboardList, ScrollText, Briefcase, TrendingUp, Tag, Tags, Megaphone, Bell, Settings, PackageX, Warehouse, FlaskConical, Menu, X, ChevronsLeft, ChevronsRight, BookOpen, Handshake, Eye, Target, Sparkles, Radio, FileEdit, Newspaper, Layers, MessageSquareQuote, Ticket, Globe, History } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { canAccessAdmin, canAccessAdminPage, isAffiliate, adminLandingPage, getRoleName, type UserRole } from '@/lib/permissions';
import {
  ADMIN_VIEW_META,
  ADMIN_VIEW_MODES,
  canSwitchAdminView,
  effectiveAdminRole,
  readStoredAdminView,
  storeAdminView,
  type AdminViewMode,
} from '@/lib/admin/admin-view';
import { apiFetch } from '@/lib/api-fetch';
import AffiliateDashboard from './_components/AffiliateDashboard';

/**
 * The role every page below behaves as.
 *
 * This is the EFFECTIVE role, not the account's: an admin previewing the
 * analytics staff view reads `analytics` here, which is the whole point —
 * every existing permission check keeps working unchanged and the preview is
 * narrowed by the same code that narrows the real partner.
 */
const UserRoleContext = createContext<UserRole>('customer');
export const useUserRole = () => useContext(UserRoleContext);

interface AdminViewState {
  /** The account's own role — what the reader is really entitled to. */
  realRole: UserRole;
  view: AdminViewMode;
  setView: (view: AdminViewMode) => void;
  canSwitch: boolean;
}

const AdminViewContext = createContext<AdminViewState>({
  realRole: 'customer',
  view: 'admin',
  setView: () => {},
  canSwitch: false,
});

/** For the rare page that needs the real role (or the switch) as well as the effective one. */
export const useAdminView = () => useContext(AdminViewContext);

// Nav is grouped into a few labelled sections so the side panel reads as an
// organised menu instead of a flat wall of buttons. Groups with no items the
// current role can reach are dropped at render time.
const navGroups = [
  {
    label: 'Overview',
    items: [
      { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/admin/analytics', label: 'Analytics', icon: TrendingUp },
    ],
  },
  {
    label: 'Sales',
    items: [
      // Orders were merged into Invoices — the invoice detail page now exposes
      // all order view/create/edit actions, so Orders is intentionally hidden
      // from the nav (the /admin/orders routes still work by direct URL).
      { href: '/admin/invoices', label: 'Invoices', icon: FileText },
      { href: '/admin/backorders', label: 'Backorders', icon: PackageX },
      { href: '/admin/stealth-health', label: 'Stealth Health', icon: Handshake },
      { href: '/admin/customers', label: 'Customers', icon: Users },
      { href: '/admin/pricing', label: 'Pricing', icon: Tag },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/admin/products', label: 'Products', icon: ShoppingBag },
      { href: '/admin/categories', label: 'Categories', icon: Tags },
      { href: '/admin/purchase-orders', label: 'Purchase Orders', icon: ClipboardList },
      { href: '/admin/stock-ledger', label: 'Stock Ledger', icon: History },
      { href: '/admin/warehouse', label: 'Warehouse', icon: Warehouse },
      { href: '/admin/lab-results', label: 'Lab Results', icon: FlaskConical },
      { href: '/admin/stock-requests', label: 'Stock Requests', icon: Bell },
    ],
  },
  {
    label: 'Partners',
    items: [
      { href: '/admin/affiliates', label: 'Affiliates', icon: Users },
      { href: '/admin/discount-codes', label: 'Discount Codes', icon: Ticket },
      { href: '/admin/sales-persons', label: 'Sales People', icon: Briefcase },
      { href: '/admin/commissions', label: 'Commissions', icon: DollarSign },
    ],
  },
  {
    label: 'Marketing',
    items: [
      { href: '/admin/marketing', label: 'Branding & Tracking', icon: Megaphone },
      { href: '/admin/promos', label: 'Promotions', icon: Sparkles },
      { href: '/admin/landing-pages', label: 'Landing Pages', icon: Globe },
      { href: '/admin/cart-upsells', label: 'Cart Upsells', icon: Layers },
    ],
  },
  {
    label: 'Content',
    items: [
      { href: '/admin/announcements', label: 'Announcements', icon: Radio },
      { href: '/admin/testimonials', label: 'Testimonials', icon: MessageSquareQuote },
      { href: '/admin/pages', label: 'Pages', icon: FileEdit },
      { href: '/admin/articles', label: 'Articles', icon: Newspaper },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/admin/users', label: 'Users', icon: UserCircle },
      { href: '/admin/audit-log', label: 'Audit Log', icon: ScrollText },
      { href: '/admin/settings', label: 'Settings', icon: Settings },
    ],
  },
  {
    label: 'Help',
    items: [
      { href: '/admin/guides', label: 'Guides & How-Tos', icon: BookOpen },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [authState, setAuthState] = useState<'checking' | 'not_logged_in' | 'not_admin' | 'error' | 'admin'>('checking');
  const [userRole, setUserRole] = useState<UserRole>('customer');
  const [backorderCount, setBackorderCount] = useState(0);

  // Which role's panel is being read. Only ever a narrowing of `userRole` —
  // see lib/admin/admin-view.ts.
  const [view, setView] = useState<AdminViewMode>('admin');
  const canSwitch = canSwitchAdminView(userRole);
  const effectiveRole = effectiveAdminRole(userRole, view);
  const previewing = effectiveRole !== userRole;

  // Side panel state: `collapsed` is the desktop rail (persisted), `mobileOpen`
  // is the off-canvas drawer on small screens.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Login form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    checkAdmin();
  }, []);

  // Scoped roles (affiliate, analytics) are confined to their allow-lists —
  // bounce them to their landing page if they navigate outside it. Using
  // adminLandingPage (not a hardcoded '/admin') is what stops an analytics
  // user from looping, since it cannot reach '/admin' (the Dashboard).
  // The switched-into view is bounced the same way, so previewing the analytics
  // staff view from a page they cannot reach lands on their landing page rather
  // than leaving an admin looking at a page the preview claims is hidden.
  useEffect(() => {
    if (authState === 'admin' && !canAccessAdminPage(effectiveRole, pathname)) {
      router.replace(adminLandingPage(effectiveRole));
    }
  }, [authState, effectiveRole, pathname, router]);

  // Open-backorder count for the nav badge. Re-runs on navigation so the
  // badge refreshes after fulfilling a backorder or editing an invoice.
  useEffect(() => {
    if (authState !== 'admin' || (effectiveRole !== 'admin' && effectiveRole !== 'assistant')) return;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch('/api/admin/backorders/count', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json().catch(() => ({ count: 0 }));
        setBackorderCount(res.ok ? data.count ?? 0 : 0);
      } catch {
        setBackorderCount(0);
      }
    })();
  }, [authState, effectiveRole, pathname]);

  // Restore the persisted desktop collapse preference on mount.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('admin-sidebar-collapsed') === '1');
    } catch {
      /* localStorage may be unavailable — fall back to expanded */
    }
  }, []);

  // Restore the chosen view. Read from the same helper the client fetchers use,
  // so the browser and the server agree on which view is in effect.
  useEffect(() => {
    setView(readStoredAdminView());
  }, []);

  const changeView = (next: AdminViewMode) => {
    setView(next);
    storeAdminView(next);
  };

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // While the mobile drawer is open, lock body scroll and let Escape dismiss it.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('admin-sidebar-collapsed', next ? '1' : '0');
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  const checkAdmin = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        setAuthState('not_logged_in');
        setIsChecking(false);
        return;
      }

      const { customer } = await apiFetch<{ customer: { role: string } }>('/api/auth/customer', {
        method: 'POST',
        body: JSON.stringify({ accessToken: session.access_token }),
      });
      const role = (customer?.role || 'customer') as UserRole;

      // Allow both admin and assistant roles
      if (canAccessAdmin(role)) {
        setIsAdmin(true);
        setUserRole(role);
        setAuthState('admin');
      } else {
        setAuthState('not_admin');
      }
    } catch (e) {
      console.error('Admin check failed:', e);
      setAuthState('error');
    }
    setIsChecking(false);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    if (!email || !password) {
      setLoginError('Enter your email and password');
      return;
    }

    setLoginLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        setLoginError(error.message);
        setLoginLoading(false);
        return;
      }

      // Re-check admin status after login
      setAuthState('checking');
      setIsChecking(true);
      await checkAdmin();
    } catch {
      setLoginError('Something went wrong');
      setLoginLoading(false);
    }
  };

  // Loading state
  if (isChecking) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="animate-pulse text-ink-muted text-sm">Loading admin panel...</div>
      </div>
    );
  }

  // Not logged in - show inline login form
  if (authState === 'not_logged_in') {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="bg-white rounded-xl p-6 sm:p-8 border border-line shadow-sm">
            <div className="text-center mb-6">
              <h1 className="font-display text-xl font-semibold tracking-[0.18em] text-ink">VYTA</h1>
              <p className="text-xs text-teal-dark font-semibold uppercase tracking-[0.15em] mt-1">Admin Panel</p>
            </div>

            {loginError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span className="text-red-700 text-sm">{loginError}</span>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 text-sm text-ink"
                    placeholder="admin@example.com"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 text-sm text-ink"
                    placeholder="Enter your password"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loginLoading}
                className="w-full bg-ink hover:bg-ink/90 text-white font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 text-sm"
              >
                {loginLoading ? 'Signing in...' : <><LogIn className="w-4 h-4" /> Sign In</>}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Not admin or error
  if (authState !== 'admin') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center max-w-md px-6">
          <h1 className="text-2xl font-bold text-ink mb-2">Access Denied</h1>
          <p className="text-ink-muted text-sm mb-6">
            {authState === 'not_admin'
              ? 'Your account does not have admin privileges.'
              : 'Something went wrong. Try refreshing.'}
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 bg-ink text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-ink/90 transition-colors"
          >
            Go Home
          </Link>
        </div>
      </div>
    );
  }

  // Admin authenticated - show dashboard
  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin';
    return pathname.startsWith(href);
  };

  const roleLabel = effectiveRole === 'admin' ? 'Admin' : getRoleName(effectiveRole);

  // Drop items — and any group left empty — the current view can't reach.
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessAdminPage(effectiveRole, item.href)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="min-h-screen bg-surface">
      {/* Mobile top bar — hamburger opens the drawer below the lg breakpoint. */}
      <div className="lg:hidden sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-white px-4">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="inline-flex items-center justify-center w-9 h-9 -ml-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-ink transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-semibold tracking-[0.18em] text-ink">VYTA</span>
          <span className="text-[10px] font-semibold text-teal-dark uppercase tracking-[0.15em]">
            {roleLabel}
          </span>
        </div>
        <Link
          href="/"
          className="inline-flex items-center justify-center w-9 h-9 -mr-1.5 rounded-lg text-ink-muted hover:bg-surface hover:text-ink transition-colors"
          aria-label="Back to store"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
      </div>

      {/* Backdrop behind the mobile drawer. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/50 backdrop-blur-xs lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Retractable side panel. Off-canvas drawer on mobile, fixed rail that
          collapses to icons on desktop. */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-ink text-white transition-transform duration-300 ease-out lg:transition-[width] ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0 ${collapsed ? 'lg:w-[76px]' : 'lg:w-64'}`}
      >
        <div className="flex h-16 flex-shrink-0 items-center gap-2 border-b border-white/10 px-3">
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors"
            aria-label="Close navigation menu"
          >
            <X className="w-5 h-5" />
          </button>
          <Link
            href={adminLandingPage(effectiveRole)}
            className={`flex items-center gap-2.5 min-w-0 ${collapsed ? 'lg:w-full lg:justify-center' : ''}`}
          >
            {/* Dark sidebar: the mark sits on a light tile rather than being
                recoloured — the ground the brand guidelines prefer. */}
            <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-white/95 p-1">
              <img
                src="/images/vyta-mark.png"
                alt=""
                aria-hidden="true"
                className="h-full w-full object-contain"
              />
            </span>
            <span className={`min-w-0 ${collapsed ? 'lg:hidden' : ''}`}>
              <span className="block truncate text-sm font-bold leading-tight text-white">VYTA</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.15em] text-teal-light">
                {roleLabel}
                {userRole === 'assistant' && <span className="ml-1 normal-case text-amber-400">· Read Only</span>}
              </span>
            </span>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-hide px-3 pb-4">
          {visibleGroups.map((group, groupIndex) => (
            <div key={group.label}>
              {collapsed && groupIndex > 0 && (
                <div className="hidden lg:block h-px bg-white/10 mx-2 my-2" />
              )}
              <p
                className={`px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/35 ${
                  collapsed ? 'lg:hidden' : ''
                }`}
              >
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  const showBadge = item.href === '/admin/backorders' && backorderCount > 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      aria-current={active ? 'page' : undefined}
                      className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        collapsed ? 'lg:justify-center' : ''
                      } ${
                        active
                          ? 'bg-white font-semibold text-ink'
                          : 'text-white/65 hover:bg-white/[0.07] hover:text-white'
                      }`}
                    >
                      <span className="relative flex-shrink-0">
                        <Icon className="w-5 h-5" />
                        {showBadge && (
                          <span className="absolute -right-2 -top-2 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-ink">
                            {backorderCount}
                          </span>
                        )}
                      </span>
                      <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-shrink-0 space-y-0.5 border-t border-white/10 p-3">
          {canSwitch && (
            <ViewSwitch view={view} collapsed={collapsed} onChange={changeView} />
          )}
          <Link
            href="/"
            title="Back to Store"
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white ${
              collapsed ? 'lg:justify-center' : ''
            }`}
          >
            <ArrowLeft className="w-5 h-5 flex-shrink-0" />
            <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>Back to Store</span>
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white lg:flex ${
              collapsed ? 'lg:justify-center' : ''
            }`}
          >
            {collapsed ? (
              <ChevronsRight className="w-5 h-5 flex-shrink-0" />
            ) : (
              <ChevronsLeft className="w-5 h-5 flex-shrink-0" />
            )}
            <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>Collapse</span>
          </button>
        </div>
      </aside>

      {/* Content shifts to make room for the desktop rail. */}
      <div className={`transition-[padding] duration-300 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-64'}`}>
        <main className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12 py-8">
          {previewing && (
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3">
              <Eye className="w-4 h-4 flex-shrink-0 text-violet-600" />
              <p className="text-xs text-violet-800">
                <span className="font-semibold">Viewing as {ADMIN_VIEW_META[view].label}.</span>{' '}
                {ADMIN_VIEW_META[view].description} Your own access has not changed.
              </p>
              <button
                type="button"
                onClick={() => changeView('admin')}
                className="ml-auto rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-100"
              >
                Back to my view
              </button>
            </div>
          )}

          {userRole === 'assistant' && (
            <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-2">
              <Info className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <p className="text-xs text-amber-700">
                You have read-only access. Contact an administrator to make changes.
              </p>
            </div>
          )}

          <AdminViewContext.Provider
            value={{ realRole: userRole, view, setView: changeView, canSwitch }}
          >
            <UserRoleContext.Provider value={effectiveRole}>
              {isAffiliate(userRole) && pathname === '/admin' ? <AffiliateDashboard /> : children}
            </UserRoleContext.Provider>
          </AdminViewContext.Provider>
        </main>
      </div>
    </div>
  );
}

/**
 * The view switch in the side panel.
 *
 * Deliberately a pair of buttons rather than a dropdown: there are two views,
 * and which one is active has to be readable at a glance — an admin who forgets
 * they are in the analytics view would read a paid-ads revenue figure as the
 * whole business. Collapsed to the icon rail it becomes a single toggle that
 * still shows which view is on, via its tint.
 */
function ViewSwitch({ view, collapsed, onChange }: {
  view: AdminViewMode;
  collapsed: boolean;
  onChange: (next: AdminViewMode) => void;
}) {
  const previewing = view === 'analytics';

  return (
    <div className="pb-1">
      {/* Collapsed rail: one button that toggles between the two views. */}
      <button
        type="button"
        onClick={() => onChange(previewing ? 'admin' : 'analytics')}
        title={previewing ? 'Back to the admin view' : 'View as analytics staff'}
        aria-label={previewing ? 'Back to the admin view' : 'View as analytics staff'}
        className={`hidden w-full items-center justify-center rounded-lg px-3 py-2.5 text-sm transition-colors ${
          collapsed ? 'lg:flex' : ''
        } ${
          previewing
            ? 'bg-violet-500/20 text-violet-200 hover:bg-violet-500/30'
            : 'text-white/65 hover:bg-white/[0.07] hover:text-white'
        }`}
      >
        {previewing ? <Target className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
      </button>

      {/* Expanded: both views named, so nobody has to remember what the icon meant. */}
      <div className={collapsed ? 'lg:hidden' : ''}>
        <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
          Viewing as
        </p>
        <div className="flex gap-1 rounded-lg bg-white/[0.06] p-1" role="group" aria-label="Panel view">
          {ADMIN_VIEW_MODES.map((mode) => {
            const active = mode === view;
            const Icon = mode === 'analytics' ? Target : Eye;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onChange(mode)}
                aria-pressed={active}
                title={ADMIN_VIEW_META[mode].description}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-[6px] px-2 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-white text-ink'
                    : 'text-white/60 hover:bg-white/[0.07] hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
                <span className="truncate">{mode === 'analytics' ? 'Analytics' : 'Admin'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
