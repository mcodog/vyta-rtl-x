# Supabase Auth email templates

These are the bodies pasted into **Supabase → Authentication → Email Templates**.
They live here so the copy is reviewable and versioned; nothing in the app reads
them at runtime — editing a file does not change what Supabase sends until it is
pasted into the dashboard.

| File | Supabase template | Sent when |
| --- | --- | --- |
| `reset-password.html` | **Reset Password** | `resetPasswordForEmail` — the self-serve `/forgot-password` page, and the admin desks' "Send password reset link" action (`lib/admin/password-reset.ts`) |
| `magic-link.html` | **Magic Link** | A passwordless sign-in request |

`reset-password.html` is a fragment, not a full document — the dashboard editor
expects body markup. `magic-link.html` predates that and carries a full
`<!DOCTYPE>`; both render, so it has been left as-is.

## The reset link

`reset-password.html` does **not** use `{{ .ConfirmationURL }}`. It links straight
to the app with the token hash:

```html
<a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery">
```

`/reset-password` verifies it itself (`supabase.auth.verifyOtp`). The link never
goes through GoTrue's `/auth/v1/verify` redirect, so it does not depend on the
Redirect URLs allow-list below and cannot fall back to the homepage. It also
survives email link scanners: the token is only spent when the page's script
runs, not when a scanner fetches the URL. `{{ .SiteURL }}` is **Authentication →
URL Configuration → Site URL** — keep it set to the live storefront origin.

If a template ever does use `{{ .ConfirmationURL }}`, use it **on its own** —
never `{{ .ConfirmationURL }}/reset-password`. It is GoTrue's
`…/auth/v1/verify?token=…&redirect_to=…`, so anything appended lands on the tail
of the encoded `redirect_to` value.

## Redirect allow-list

Every `redirectTo` must be listed under **Authentication → URL Configuration →
Redirect URLs**. When it is not, GoTrue silently falls back to the project's Site
URL — the recipient lands on the homepage, signed in by the recovery session,
and never sees the new-password form. (`lib/supabase.ts` now forwards such a
landing on to `/reset-password`, and the token-hash link above avoids it
entirely, but the magic-link and admin flows still rely on the allow-list.) That failure looks
identical to a broken link, so check the allow-list first. Note `www.aminocan.com`
and `aminocan.com` are distinct entries.

## Expiry wording

`reset-password.html` says the link expires in **60 minutes**, matching GoTrue's
default email OTP expiry. If that is changed under **Authentication → Settings**,
update the copy here to match.
