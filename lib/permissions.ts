/**
 * Permission utilities for role-based access control
 */

export type UserRole =
  | 'customer'
  | 'assistant'
  | 'admin'
  | 'affiliate'
  | 'warehouse'
  | 'analytics';

/**
 * Pages an analytics / marketing partner is allowed to reach inside /admin.
 * They read the analytics dashboard, edit product copy (descriptors only),
 * manage the storefront category taxonomy, and edit branding + tracking.
 * Notably they CANNOT reach /admin (the Dashboard) — see adminLandingPage.
 *
 * What they read on those pages is narrowed too: sales figures are limited to
 * orders won by a paid ad (lib/analytics/paid-scope.ts), and customer
 * identities are withheld.
 */
export const ANALYTICS_PAGES = [
  '/admin/analytics',
  '/admin/products',
  '/admin/categories',
  '/admin/marketing',
  // Storefront content: the announcement bar, editable pages and articles are
  // marketing surfaces, so the marketing partner owns them the same way it
  // owns branding — without ever reaching prices, stock or API keys.
  '/admin/announcements',
  '/admin/testimonials',
  '/admin/pages',
  '/admin/articles',
] as const;

/**
 * The single source of truth for "descriptor" (content) product fields — the
 * copy/image fields an analytics/marketing editor may change. Everything NOT
 * in this list (price, stock, visibility, checkout flags) is admin-only and is
 * stripped server-side from a non-admin product update.
 */
export const PRODUCT_DESCRIPTOR_FIELDS = [
  'name',
  'slug',
  'category',
  'description',
  'description_short',
  'benefits',
  'mechanism',
  'strength',
  'purity',
  'form',
  'image_url',
  'box_image_url',
  'box_image_first',
  'coa_url',
] as const;

/**
 * Check if user can access the admin dashboard.
 * admin + assistant have full entry; analytics partners enter a scoped portal.
 * Affiliates are deliberately excluded — they use their own /affiliate portal
 * and never see /admin.
 */
export function canAccessAdmin(role: UserRole): boolean {
  return role === 'admin' || role === 'assistant' || role === 'analytics';
}

/**
 * Can the role reach a specific /admin route?
 * admin/assistant: everything. analytics: only ANALYTICS_PAGES (exact match
 * or a sub-route of one of those entries). Everyone else, affiliates included:
 * nothing.
 */
export function canAccessAdminPage(role: UserRole, href: string): boolean {
  if (role === 'admin' || role === 'assistant') return true;
  if (role === 'analytics') {
    return ANALYTICS_PAGES.some(
      (page) => href === page || href.startsWith(`${page}/`),
    );
  }
  return false;
}

/**
 * Where a role should land when it enters /admin. Analytics cannot reach the
 * Dashboard (/admin), so it lands on the analytics page — using this instead
 * of a hardcoded '/admin' is what stops the redirect guard from looping.
 */
export function adminLandingPage(role: UserRole): string {
  return role === 'analytics' ? '/admin/analytics' : '/admin';
}

/**
 * Is this user an affiliate?
 */
export function isAffiliate(role: UserRole): boolean {
  return role === 'affiliate';
}

/**
 * Is this user an analytics / marketing partner?
 */
export function isAnalytics(role: UserRole): boolean {
  return role === 'analytics';
}

/**
 * Can the role reach the /warehouse portal?
 * warehouse staff have native access; admin can view for oversight.
 */
export function canAccessWarehouse(role: UserRole): boolean {
  return role === 'warehouse' || role === 'admin';
}

/**
 * Can the role view invoices (list / detail / PDF / aging)?
 * admin + assistant + affiliate (affiliates see their own customers' invoices).
 */
export function canViewInvoices(role: UserRole): boolean {
  return role === 'admin' || role === 'assistant' || role === 'affiliate';
}

/**
 * Can the role create / edit invoices?
 * admin always; affiliates have a narrow, explicitly-authorized flow for their
 * own customers' invoices.
 */
export function canEditInvoice(role: UserRole): boolean {
  return role === 'admin' || role === 'affiliate';
}

/**
 * Can the role read the sales/traffic analytics dashboard?
 * admin + assistant (oversight) + analytics (their primary surface).
 *
 * The analytics role reads a NARROWED version of it: every sales figure served
 * to it counts only orders won by a paid ad, filtered in the route before any
 * aggregation. It is an external marketing partner, so it sees the performance
 * of the campaigns it runs and not the rest of the business's revenue.
 * See lib/analytics/paid-scope.ts.
 */
export function canViewAnalytics(role: UserRole): boolean {
  return role === 'admin' || role === 'assistant' || role === 'analytics';
}

/**
 * Can the role edit product descriptors (copy + images only)?
 * admin (full edit) + analytics (descriptor-only). The server additionally
 * strips any non-descriptor keys from an analytics update.
 */
export function canEditProductDescriptors(role: UserRole): boolean {
  return role === 'admin' || role === 'analytics';
}

/**
 * Can the role manage the storefront category taxonomy?
 * admin + analytics.
 */
export function canManageCategories(role: UserRole): boolean {
  return role === 'admin' || role === 'analytics';
}

/**
 * Can the role edit branding + tracking (the Marketing page)?
 * admin + analytics. This is a SEPARATE surface from the main /admin/settings
 * (API keys / emails), which stays admin-only — so the marketing role never
 * gains sensitive config access.
 */
export function canManageMarketing(role: UserRole): boolean {
  return role === 'admin' || role === 'analytics';
}

/**
 * Can the role manage storefront CONTENT — the announcement bar, editable
 * pages (About Us) and articles?
 * admin + analytics, the same pair that owns branding. Content is public copy,
 * never commercial configuration, so this deliberately does NOT imply `canEdit`
 * (prices, stock, users) and is checked separately from it.
 */
export function canManageContent(role: UserRole): boolean {
  return role === 'admin' || role === 'analytics';
}

/**
 * Check if user can edit/update/delete records
 * Only admins can perform general mutations
 */
export function canEdit(role: UserRole): boolean {
  return role === 'admin';
}

/**
 * Check if user can create new records
 * Only admins can create
 */
export function canCreate(role: UserRole): boolean {
  return role === 'admin';
}

/**
 * Check if user can delete records
 * Only admins can delete
 */
export function canDelete(role: UserRole): boolean {
  return role === 'admin';
}

/**
 * Get user-friendly role display name
 */
export function getRoleName(role: UserRole): string {
  const roleNames: Record<UserRole, string> = {
    customer: 'Customer',
    affiliate: 'Affiliate',
    assistant: 'Assistant',
    admin: 'Administrator',
    warehouse: 'Warehouse',
    analytics: 'Analytics',
  };
  return roleNames[role];
}

/**
 * Get role badge color classes
 */
export function getRoleBadgeClasses(role: UserRole): string {
  const classes: Record<UserRole, string> = {
    customer: 'bg-gray-500/10 text-ink-muted',
    affiliate: 'bg-emerald-500/10 text-emerald-600',
    assistant: 'bg-blue-500/10 text-blue-400',
    admin: 'bg-teal/10 text-teal-dark',
    warehouse: 'bg-amber-500/10 text-amber-600',
    analytics: 'bg-violet-500/10 text-violet-500',
  };
  return classes[role];
}
