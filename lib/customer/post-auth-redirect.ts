/**
 * Where to send a customer after they sign in or create an account — used by
 * the "View Order Details" button in the order confirmation email, which
 * lands on /login or /signup with `?redirect=/account/orders/…&email=…`.
 *
 * Signing up usually means confirming the email address first; the
 * confirmation link signs the customer in on the home page, not back on the
 * signup form. So signup also remembers the destination here, and
 * CustomerContext resumes it on that first sign-in.
 *
 * Client-safe. Every storage access is guarded (private mode, blocked
 * storage) — losing the hint only costs a click, never the sign-in.
 */

const KEY = 'vyta_post_auth_redirect';
const TTL_MS = 24 * 60 * 60 * 1000;

/** A same-site path, or null — never an absolute or protocol-relative URL. */
export function safeRedirect(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const path = raw.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;
  return path;
}

/** The destination is a customer order page (from the confirmation email). */
export function isOrderRedirect(path: string | null | undefined): boolean {
  return !!path && /^\/account\/orders\/[^/?#]+/.test(path);
}

/** /login or /signup, carrying the destination and prefilled email along. */
export function authHref(
  base: '/login' | '/signup',
  redirect: string | null | undefined,
  email?: string | null,
): string {
  const params = new URLSearchParams();
  const target = safeRedirect(redirect);
  if (target && target !== '/') params.set('redirect', target);
  if (email && email.trim()) params.set('email', email.trim());
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function rememberPostAuthRedirect(path: string | null | undefined): void {
  const target = safeRedirect(path);
  if (!target || target === '/') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ path: target, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function clearPostAuthRedirect(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Read and clear the remembered destination, if it is still fresh. */
export function takePostAuthRedirect(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    window.localStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as { path?: string; at?: number };
    if (!parsed?.at || Date.now() - parsed.at > TTL_MS) return null;
    return safeRedirect(parsed.path);
  } catch {
    return null;
  }
}
