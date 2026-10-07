# Order-Paid Email Notifications — Build Spec

> Definitive spec for rebuilding this feature in a Next.js + Supabase codebase.
> Generated from: `lib/order-confirmation.ts`, `lib/order-confirmation-data.ts`,
> `lib/order-confirmation-email.ts`, `lib/admin/stealth-health-paid-alert.ts`,
> `lib/email.ts` (`sendOrderConfirmation`, `sendAdminOrderPaidAlert`), `lib/smtp.ts`,
> `lib/admin/alert-recipients.ts`, `lib/customer/order-link.ts`,
> `app/api/admin/confirmation-email/route.ts`, `app/api/admin/paid-alert-email/route.ts`,
> `components/admin/OrderConfirmationEmailCard.tsx`, `components/admin/AdminPaidAlertEmailCard.tsx`,
> the paid-signal call sites (`lib/payments/puramass-fulfillment.ts`,
> `app/api/admin/invoices/**`, `app/api/admin/orders/[id]/route.ts`), and the migrations
> `order-confirmation-email-migration.sql` and `stealth-health-admin-paid-alert-migration.sql`.
> Stack: Next.js 15 **App Router** (route handlers + `after()` from `next/server`) +
> Supabase (service-role client on the server) + nodemailer SMTP.

---

## 1. Overview

When an order becomes **paid**, two emails go out:

| Email | Recipient | Subject | Sent automatically for |
|---|---|---|---|
| **Customer order confirmation** ("Thank you for your order.") | The buyer: first deliverable address among the linked customer account, the order/invoice copy, and the checkout capture | `Order Confirmed - {orderNumber}` | Stealth Health hand-offs (`puramass_orders`); storefront `orders` whose `source` starts with `e-transfer` (none exist on VYTA today) |
| **Admin "order paid" alert** | The admin notification list (`site_settings.admin_emails` → env `ADMIN_ALERT_EMAILS` → `site_settings.invoice_cc_emails`) | `New order: {orderNumber} · {who} · ${total} {CUR}` (or `Invoice paid: …` for a manual invoice) | Stealth Health hand-offs only |

The **HTML and plain-text body of both emails are identical** — the admin alert renders the customer
confirmation unchanged, "so the team sees what the buyer saw". Only subject and recipients differ.

Both emails are:
- **Exactly-once** on the automatic path, via a *claim column* (`confirmation_email_sent_at` /
  `admin_paid_alert_sent_at`) stamped NULL → `now()` with a conditional UPDATE before sending; a failed send
  clears it so the next paid signal retries.
- **Logged** on every attempt to `fulfillment_email_log` (`kind = 'order_confirmation'` /
  `'admin_paid_alert'`).
- **Never throwing** to the caller — a payment webhook or admin status change must never fail because an email failed.
- **Manually (re)sendable** by an admin from sidebar cards on the admin order / invoice pages, which also show
  sent / not sent / failed status and the send history. Manual invoices (no order, no hand-off) are *only* ever
  sent manually.

Three kinds of "order" are handled:
1. **Stealth Health hand-off** — a `puramass_orders` row (the hosted-checkout ledger) + its `invoices` row and
   `invoice_line_items`. The invoice is created at checkout as `pending_payment`, so *the invoice existing does not
   mean paid*.
2. **Storefront order** — an `orders` row (lines in `orders.items` JSONB, or `order_items` for admin-created orders).
3. **Manual invoice** — an `invoices` row with `order_id IS NULL` and no `puramass_orders` row pointing at it.

---

## 2. Database schema

Only the columns this cluster reads or writes are listed. Source: `_live-schema-snapshot.sql` plus the named
migrations. Columns marked † are added by later migrations and may be absent on an un-migrated database; the code
reads with `select('*')` precisely so a missing optional column never fails the read.

### 2.1 Columns added by this feature

```sql
-- order-confirmation-email-migration.sql
ALTER TABLE orders          ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;
ALTER TABLE puramass_orders ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;
-- NULL = not sent yet; set BEFORE sending so it goes out once.

-- stealth-health-admin-paid-alert-migration.sql
ALTER TABLE puramass_orders ADD COLUMN IF NOT EXISTS admin_paid_alert_sent_at TIMESTAMPTZ;
-- NULL = not sent yet; set BEFORE sending so it goes out once.
```

Both migrations also:
- **Backfill** every already-paid row (stamp `now()`), so enabling the feature doesn't email past buyers/admins:
  - `orders` where `status NOT IN ('pending','received')`, or whose invoice (`invoices.order_id = orders.id`) is `paid`.
  - `puramass_orders` where `status = 'paid'`, or whose invoice (`invoices.id = puramass_orders.invoice_id`) is `paid`.
    *Not* "has an invoice" — hand-offs get their invoice at checkout.
- **Drop any CHECK constraint on `fulfillment_email_log` whose definition mentions `kind`** (an older one limited
  `kind` to `packed`, `shipped`, …). Supabase *returns* (doesn't throw) a rejected insert, so without this the email
  goes out but the admin history stays empty.
- `stealth-health-admin-paid-alert-migration.sql` ends with `NOTIFY pgrst, 'reload schema';`.
- Are idempotent; run in the Supabase SQL editor.

### 2.2 `fulfillment_email_log` (send history)

```sql
CREATE TABLE IF NOT EXISTS fulfillment_email_log (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id    uuid,
  order_id      uuid,
  kind          text NOT NULL,        -- 'order_confirmation' | 'admin_paid_alert' (+ other fulfillment kinds)
  to_email      text NOT NULL,        -- admin alert: recipients joined with ', '
  subject       text,
  message_id    text,                 -- SMTP messageId (customer email only; NULL for admin alert)
  success       boolean NOT NULL DEFAULT false,
  error         text,
  sent_by       uuid,                 -- NULL = automatic on payment; else the admin's auth user id
  sent_by_email text,                 -- NULL = automatic; else the admin's email
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

### 2.3 Tables read

```sql
-- orders (storefront)
id uuid, customer_id uuid, order_number text NOT NULL, items jsonb NOT NULL,
total numeric NOT NULL, subtotal numeric, shipping_cost numeric,
discount_total numeric DEFAULT 0, discount_amount numeric NOT NULL DEFAULT 0,
email text, phone text†, shipping_address jsonb, currency text†,
status text NOT NULL DEFAULT 'pending', source text NOT NULL DEFAULT 'website',
payment_confirmed_at timestamptz, created_at timestamptz,
confirmation_email_sent_at timestamptz†

-- order_items (fallback lines when orders.items is empty — admin-created orders)
order_id, product_name | name_snapshot, strength | product_strength,
quantity | qty, price_at_time | unit_price          -- first non-null of each pair

-- puramass_orders (Stealth Health hand-off ledger)
id uuid PK, partner_reference text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'payment_pending',
customer_id uuid → customers(id), customer_email text, customer_name text†, customer_phone text†,
items jsonb NOT NULL DEFAULT '[]',   -- each may carry product_id, pack_size, list_unit_price_cents
invoice_id uuid†, paid_at timestamptz, currency text, shipping_address jsonb†,
shipping_courier text†, discount_code varchar(32)†, discount_code_percent numeric†,
ad_discount_percent numeric†, cart_offer_percent numeric(5,2)†,
confirmation_email_sent_at timestamptz†, admin_paid_alert_sent_at timestamptz†

-- invoices
id uuid, invoice_number text NOT NULL, order_id uuid, customer_id uuid,
status text NOT NULL DEFAULT 'draft',  -- 'paid' is what counts
subtotal numeric, tax_total numeric, shipping_cost numeric, total numeric,
currency text NOT NULL DEFAULT 'CAD', customer_name text, customer_email text, customer_phone text,
issue_date date, created_at timestamptz, carrier text†, ships_to_client boolean†, client_id uuid†

-- invoice_line_items
invoice_id uuid, description text NOT NULL, qty integer, unit_price numeric, line_total numeric,
discount_pct numeric, product_id uuid†, price_type text† ('vial' | 'box'), vials_per_unit integer†

-- customers
id, email, first_name, last_name, phone, role,
shipping_address, shipping_city, shipping_state, shipping_postal_code, shipping_country

-- customer_clients (drop-ship client of a manual invoice)
id, first_name, last_name, address, city, state, postal_code, country, phone

-- products
id, image_url

-- site_settings
admin_emails jsonb NOT NULL DEFAULT '[]', invoice_cc_emails
```

### 2.4 Schema usage

| Table.column | Read / written by |
|---|---|
| `orders.confirmation_email_sent_at` | claim/release/stamp — `lib/order-confirmation.ts` |
| `puramass_orders.confirmation_email_sent_at` | claim/release/stamp — `lib/order-confirmation.ts` |
| `puramass_orders.admin_paid_alert_sent_at` | claim/release/stamp — `lib/admin/stealth-health-paid-alert.ts` |
| `fulfillment_email_log` (insert) | `logAttempt` in both send modules |
| `fulfillment_email_log` (select) | `readLog`, `summariesBy` (customer); `getAdminPaidAlertStatus` (admin) |
| `orders`, `order_items`, `invoices`, `invoice_line_items`, `puramass_orders`, `customers`, `customer_clients` | payload builders in `lib/order-confirmation-data.ts` via loaders in both send modules |
| `products.id, image_url` | `withProductImages` |
| `customers.email` (ilike) | `buildViewOrderUrl` — decides `/login` vs `/signup` |
| `customers.role, email` | API route `verifyStaff` |
| `site_settings.admin_emails / invoice_cc_emails` | `getAdminAlertEmails` |

---

## 3. Components

### 3.1 Payload builders — `lib/order-confirmation-data.ts`
- **Type:** pure TS module, **no imports** (runs in browser, server and `node --test`).
- **Purpose:** turn DB rows into the `ConfirmationEmailData` the template renders; pick a deliverable address; fold
  the send log into a status summary.
- **Types:**
  ```ts
  interface ConfirmationLine { name: string; quantity: number; price: number /* ONE unit */;
    strength?: string; unit?: 'vial' | 'case'; vialsPerBox?: number; productId?: string; imageUrl?: string }
  interface ConfirmationShipTo { name: string | null; lines: string[]; phone: string | null }
  interface ConfirmationEmailData { to: string; customerName: string; orderNumber: string;
    items: ConfirmationLine[]; subtotal: number; discount: number; discountLabel?: string;
    shipping: number; total: number; currency: string; orderDate?: string; paymentStatus?: string;
    tax?: number; shipTo?: ConfirmationShipTo; accountOrderId?: string; viewOrderUrl?: string }
  interface ConfirmationLogRow { created_at: string; to_email: string | null; success: boolean;
    error?: string | null; sent_by_email?: string | null }
  interface ConfirmationSummary { sendCount: number; lastSentAt: string | null; lastSentTo: string | null;
    lastSentBy: string | null /* null = automatic */; lastAttemptFailed: boolean; lastError: string | null }
  ```
- **Functions (exact rules):**
  - `deliverableEmail(raw)` → trimmed string matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` and **not** ending in
    `.local|.invalid|.test|.example` (case-insensitive); else `null`.
  - `pickDeliverableEmail(...candidates)` → first deliverable, in order.
  - Candidate order (mirrors what the admin page shows):
    - storefront: `[customer.email, order.email, order.shipping_address.email]`
    - Stealth Health: `[customer.email, invoice.customer_email, ledger.customer_email]`
    - manual: `[customer.email, invoice.customer_email]`
  - `noEmailReason(candidates)` → if no non-empty string: `No email address on this order or its customer account —
    add one to send the confirmation.`; else `“{first}” can’t receive email — update the customer’s email address to send the confirmation.`
  - `isStorefrontCheckoutSource(source)` → `typeof source === 'string' && source.startsWith('e-transfer')`.
  - `shipToFrom(raw, fallback)` — accepts object or JSON string; camelCase or snake_case keys.
    Lines: `[street, cityLine, country]` with empties dropped, where
    `street = [address|address1|line1, address2|line2].join(', ')`,
    `region = [state|province, zip|postalCode|postal_code].join(' ')`,
    `cityLine = [city, region].join(', ')`, country `CA`→`Canada`, `US`→`United States`, else as-is.
    `name = "first last"` → `name` → `fallback.name` → null; `phone = addr.phone` → `fallback.phone` → null.
    No lines → `undefined` (Shipping Address column omitted).
  - `splitPackSuffix(desc)` — regex `/^(.*?)\s+[—-]\s+(?:Pack of (\d+)|Single vial)\s*$/i`;
    `"GLP-3 20mg — Pack of 5"` → `{name:"GLP-3 20mg", pack:5}`, `"… — Single vial"` → pack 1.
  - **`storefrontConfirmationData(order)`** → null if no deliverable `order.email`. Lines from `order.items`
    (`name` default `'Item'`, `quantity = max(1, round(q)) || 1`, `price` rounded to 2dp, optional `strength`,
    `unit`, `vials_per_box`→`vialsPerBox`, `product_id|id`→`productId` only if a UUID).
    `discount = max(0, discount_total ?? discount_amount)`; `subtotal = order.subtotal ?? Σ(price×qty)`;
    `total = order.total ?? subtotal − discount + shipping`; `customerName = "first last"` from shipping_address or
    `'there'`; `orderNumber = order_number || id`; `currency` upper-cased, default `'CAD'`;
    `orderDate = payment_confirmed_at || created_at`; `shipTo` from `shipping_address` (phone fallback `order.phone`);
    `accountOrderId = order.id`. **No `tax`, no `paymentStatus`** (template defaults status to "Paid").
  - **`stealthHealthOrderSummary(ledger, invoice, lines, customer)`** (`stealthHealthConfirmationData` = same, null
    when `to` is empty):
    - Lines from `invoice_line_items`: name via `splitPackSuffix(description)`; `unit = 'vial'` if
      `price_type==='vial'` or pack 1; `'case'` if `price_type==='box'` or pack > 1; `vialsPerBox = vials_per_unit || pack`
      when case and > 1; price = `unit_price`.
    - `chargedSubtotal = invoice.subtotal ?? Σ lines`; `total = invoice.total ?? chargedSubtotal + shipping + tax`.
    - **List-price discount row:** match every line to `ledger.items[]` by `"{product_id lowercased}|{pack_size||1}"`
      → `list_unit_price_cents/100`. Only if **every** line has a list price and none is below the charged
      `unit_price` (tolerance 0.005), and `listSum − chargedSubtotal ≥ 0.01`: show lines at list price,
      `subtotal = listSum`, `discount = listSum − chargedSubtotal`. Otherwise charged prices, no discount.
    - `discountLabel` (only when discount > 0): parts joined with `' + '`:
      `discount_code` (if `discount_code_percent > 0`), `"{ad_discount_percent}% first-order discount"`,
      `"{cart_offer_percent}% limited-time offer"`.
    - `customerName = ledger.customer_name || invoice.customer_name || 'there'`;
      `orderNumber = invoice.invoice_number || ledger.partner_reference || ledger.id`;
      `currency = invoice.currency || ledger.currency || 'CAD'` (upper-cased);
      `orderDate = invoice.paid_at || ledger.paid_at || invoice.created_at`;
      `paymentStatus = 'Paid'` if either status is `paid`; `tax = invoice.tax_total` (always set → Tax row always shown);
      `shipTo` from `ledger.shipping_address` (fallback name/phone from ledger then invoice);
      `accountOrderId = invoice.id`.
  - **`manualInvoiceOrderSummary(invoice, lines, customer, client)`** (`manualInvoiceConfirmationData` = same, null
    when no `to`): per line `list = unit_price × qty`, `charged = line_total ?? list`. If `listSum − chargedSum ≥ 0.01`
    **and** `|listSum − discount + shipping + tax − total| < 0.015` → list-price lines + Discount row; else if there
    was a line discount → each line's price becomes `charged / qty`, no Discount row.
    `customerName = customer "first last" || invoice.customer_name || 'there'`;
    `orderDate = invoice.paid_at || issue_date || created_at`; `paymentStatus='Paid'` if `invoice.status==='paid'`;
    `shipTo` from the drop-ship `client` when `ships_to_client`, else the customer's `shipping_*` columns.
    **No `accountOrderId`** → no "View Order Details" button (manual invoices aren't in the customer account).
  - `summarizeConfirmationLog(rows)` — sort newest first; `sendCount` = successes; `lastSent*` from newest success;
    `lastAttemptFailed = !newest.success`; `lastError = newest.error ?? 'Send failed'` when failing.

### 3.2 Template — `lib/order-confirmation-email.ts`
- **Type:** pure TS (type-only imports) — renders under `node --test` and preview scripts.
- **Exports:** `SUPPORT_EMAIL = 'support@vytabio.com'`, `formatOrderDate`, `orderConfirmationSubject`,
  `renderOrderConfirmationHtml(data, siteUrl)`, `renderOrderConfirmationText(data)`, `AdminOrderPaidEmailData`,
  `adminOrderPaidSubject`, `renderAdminOrderPaidHtml` (= customer HTML of `data.order`),
  `renderAdminOrderPaidText` (= customer text of `data.order`).
- **`AdminOrderPaidEmailData`:**
  `{ order: ConfirmationEmailData; source: 'stealth_health' | 'manual'; paidVia: 'checkout' | 'admin';
  customer: {name, email, phone}; courier: string | null; discountCode: string | null; stockWarnings: string[];
  invoiceUrl: string }`. Only `order`, `source` and `customer` affect output today (see §7).
- Full visual spec in §4.

### 3.3 Mailers — `lib/email.ts` + `lib/smtp.ts`
- `sendOrderConfirmation(data)` → `{ success, id?, error?, subject }`, sends `to: data.to`, `html`, `text`.
- `sendAdminOrderPaidAlert(to: string[], data)` → same shape; returns `{success:false, error:'no admin recipients'}`
  when `to` is empty. All recipients go in one `To:` header.
- Both **never throw** and always return `subject` so callers can log it. `siteUrl = SITE_URL = "https://www.vytabio.com"`
  (`lib/config.ts`).
- Transport: nodemailer, env `SMTP_HOST`, `SMTP_PORT` (default 587; `secure` iff 465, `requireTLS` otherwise),
  `SMTP_USER`, `SMTP_PASSWORD`; From = `SMTP_FROM` → `SMTP_USER` → `EMAIL_FROM` → `'VYTA <noreply@aminocan.com>'`.
  No Reply-To is set (the email says "reply to this email", so replies go to the From mailbox).

### 3.4 Customer send orchestration — `lib/order-confirmation.ts`
- **Type:** server-only; callers pass the **service-role** Supabase client. Constants: `SENT_COLUMN =
  'confirmation_email_sent_at'`, `LOG_KIND = 'order_confirmation'`, `HISTORY_LIMIT = 50`.
- **Outcome type:** `{sent:true} | {sent:false, reason: 'not_found'|'not_eligible'|'already_sent'|'no_email'|'not_migrated'|'send_failed'|'error'}`.
- **Loaders:** `loadStorefront` (fills empty `items` from `order_items`; sets `email` to the picked deliverable
  address; injects customer first/last name into `shipping_address` when it has none), `loadStealthHealth`
  (`paid = !!invoice && (ledger.status==='paid' || invoice.status==='paid')`), `loadManual` (`paid = invoice.status==='paid'`;
  loads `customer_clients` when `ships_to_client && client_id`).
- **`claim(table, id)`**: `UPDATE {table} SET confirmation_email_sent_at = now() WHERE id = :id AND confirmation_email_sent_at IS NULL RETURNING id`
  → `'won'` (row returned) | `'lost'` (none, or any non-missing-column error) | `'not_migrated'` (Postgres `42703` /
  PostgREST `PGRST204` / "column … does not exist" / "in the schema cache").
- **`release`**: sets the column back to NULL.
- **`enrichForEmail`**: `withProductImages` (batch `products.select('id, image_url').in('id', ids)`; relative paths →
  `SITE_URL + encodeURI('/'+path)`) then `viewOrderUrl = buildViewOrderUrl(...)` when `accountOrderId` is set.
  Both best-effort.
- **Automatic entry points:**
  - `sendStorefrontOrderConfirmationOnce(db, orderId)` — requires `isStorefrontCheckoutSource(order.source)`
    (else `not_eligible`), column present (else warn + `not_migrated`), column NULL, payload non-null (else `no_email`);
    logs with `order_id` and the order's invoice id.
  - `sendStealthHealthOrderConfirmationOnce(db, puramassOrderId)` — requires `paid` and invoice; logs with
    `order_id: null, invoice_id`.
  - `sendConfirmationForPaidInvoice(db, invoiceId)` — resolves target; **manual → `not_eligible`** (never automatic).
- **Admin entry points:** `resolveConfirmationTarget`, `getConfirmationStatus`, `sendConfirmationManually`
  (not once-only; storefront orders need **not** be paid or from a checkout — the admin decides; Stealth Health and
  manual invoices must be paid → 422; after success stamps `confirmation_email_sent_at = sentAt` on the
  `orders`/`puramass_orders` row unconditionally so the automatic send won't repeat), `confirmationSummariesByOrder`,
  `confirmationSummariesByInvoice` (bulk summaries for list tables; ids with no log rows are absent = "Not sent").

### 3.5 Admin alert orchestration — `lib/admin/stealth-health-paid-alert.ts`
- **Type:** server-only, service-role client. `SENT_COLUMN = 'admin_paid_alert_sent_at'`, `LOG_KIND = 'admin_paid_alert'`.
- **`sendStealthHealthPaidAlertOnce(db, puramassOrderId, { transition, paidVia })`:**
  1. Load ledger (`*`); no ledger or no `invoice_id` → `not_found`. Load invoice + lines; no invoice → `not_found`.
  2. Neither `invoice.status` nor `ledger.status` is `paid` → `not_paid`.
  3. `migrated = 'admin_paid_alert_sent_at' in ledger`. Not migrated → warn; continue **only if `transition`**
     (this call saw it turn paid), else `not_migrated`. Migrated and already stamped → `already_sent`.
  4. Recipients from `getAdminAlertEmails`; none → warn + `no_recipients` (checked **before** claiming, so the alert
     is still unsent and will go out once recipients are configured and another paid signal arrives).
  5. If migrated, claim (same conditional UPDATE); lost → `already_sent`.
  6. Build payload (`buildAdminEmail`), send, log (`to_email = recipients.join(', ')`, `message_id: null`,
     `order_id: null`), release on failure → `send_failed`.
- **`sendStealthHealthPaidAlertForInvoice(db, invoiceId)`** — finds the `puramass_orders` row by `invoice_id`
  (none → `not_found`, i.e. non-Stealth-Health invoices are ignored) and calls the above with
  `{ transition: true, paidVia: 'admin' }`.
- **`buildAdminEmail`** — loads `customers` (by `invoice.customer_id ?? ledger.customer_id`) and, for manual invoices
  with `ships_to_client`, `customer_clients`; builds the order via `stealthHealthOrderSummary` /
  `manualInvoiceOrderSummary` (no deliverable buyer address required), adds product images; `customer.name` =
  account "first last" → `invoice.customer_name` → `ledger.customer_name`; email/phone same precedence;
  `courier = ledger.shipping_courier` (or `invoice.carrier`); `discountCode = ledger.discount_code`;
  `stockWarnings = lines without product_id as "{description} × {qty}"`; `invoiceUrl = SITE_URL/admin/invoices/{id}`.
- **Manual/admin:** `getAdminPaidAlertStatus(db, invoiceId)` (null for an invoice with `order_id` — storefront
  invoices aren't covered), `sendAdminPaidAlertManually(db, invoiceId, actor)` — 404 not found / storefront,
  422 not paid (`Mark the invoice paid first — this email tells the team an order was paid.`), 422 no recipients
  (`No admin recipients — add them under Settings → Admin Email Notifications.`), 502 send failed; on success for a
  hand-off stamps `admin_paid_alert_sent_at` **only if still NULL**.

### 3.6 Recipients — `lib/admin/alert-recipients.ts`
`getAdminAlertEmails(db)`: `site_settings.admin_emails` (non-empty array) → `ADMIN_ALERT_EMAILS` env (comma-separated)
→ `site_settings.invoice_cc_emails`; on any exception, the env list. Edited in Admin → Settings → Admin Email
Notifications.

### 3.7 "View Order Details" link — `lib/customer/order-link.ts`
- Server-only (`node:crypto`). Secret = `ORDER_LINK_SECRET` → `SUPABASE_SERVICE_ROLE_KEY` (throws if neither).
- `signOrderClaim(orderId, email)` = base64url HMAC-SHA256 of `order-claim:v1:{orderId}:{lowercased trimmed email}`.
- Order page path: `/account/orders/{encodeURIComponent(orderId)}?claim={token}`.
- `buildViewOrderUrl(db, siteUrl, orderId, email)`: if any `customers.email ILIKE email` → `/login`, else `/signup`
  (lookup failure defaults to `/login`), with query `redirect={orderPagePath}&email={email}`.
- The order page posts the token to `POST /api/customer/orders/[id]/claim`, which links a guest order to the signed-in
  account only if the token verifies (constant-time) **and** the account's email equals the emailed address.

### 3.8 API routes
Both routes use a module-level service-role client and `verifyStaff`: Bearer token → `auth.getUser` →
`customers.role`; staff = `admin` or `assistant`.

| Route | Who | Input | Response |
|---|---|---|---|
| `GET /api/admin/confirmation-email?orderId=… \| invoiceId=… \| puramassOrderId=…` | admin, assistant | first UUID-valid param in that order | `{applicable:false}` or `{applicable:true, kind, summary, history, recipient, orderNumber, blockedReason}`; 400 `Pass orderId, invoiceId or puramassOrderId.`; 403; 500 |
| `POST /api/admin/confirmation-email` `{orderId \| invoiceId \| puramassOrderId}` | **admin only** | JSON body | `{success:true, to, sent_at}` or `{error}` with 404/422/502/500; audit log `order.confirmation_email_sent` (entity `order` / `invoice` / `puramass_order`) |
| `GET /api/admin/paid-alert-email?invoiceId=…` | admin, assistant | UUID | `{applicable:false}` (storefront invoice / not found) or `{applicable:true, kind, summary, history, recipients, blockedReason}` |
| `POST /api/admin/paid-alert-email` `{invoiceId}` | **admin only** | JSON body | `{success:true, to: string[], sent_at}`; audit log `invoice.admin_paid_alert_sent` |

### 3.9 `OrderConfirmationEmailCard` / `OrderConfirmationCell` — `components/admin/OrderConfirmationEmailCard.tsx`
- **Type:** Client component (`'use client'`). Uses `apiFetch` (adds the Supabase session Bearer token; default
  10 s timeout, POST uses 30 s) and `useToast()` from `@/contexts/ToastContext`. Icons: lucide-react
  `Mail`, `Check`, `AlertTriangle`, `Loader2`, `RotateCw`.
- **Card props:** `target: {orderId} | {invoiceId} | {puramassOrderId}`, `canSend?: boolean = true`, `onSent?: () => void`.
- **Card state:** `status`, `loading` (init true), `error`, `sending`, `showHistory`. Loads on mount / target change.
  Returns `null` when the API says `applicable:false`.
- **Send flow:** if already sent ≥ 1, `window.confirm("{recipient || 'This customer'} has already been sent this
  confirmation {once | N times}. Send it again?")`; POST; toast `Order confirmation {re}sent to {to}.`; reload; `onSent()`.
  On error: toast the message (default `The email could not be sent.`) and reload.
- **Cell props:** `summary` (prefetched by the list API), `target | null`, `canSend`. Optimistically updates the summary
  on success (`lastSentBy: 'you'`), no reload.
- **Rendered by:**
  - `app/(admin)/admin/orders/[id]/page.tsx` — `key={order.status}`, `target={{orderId}}`, `canSend={canEdit(userRole)}`.
  - `components/admin/OrderManagementPanel.tsx` — `key={order.status}`, `target={{orderId}}`, `canSend={editable}`.
  - `app/(admin)/admin/invoices/[id]/page.tsx` — **only when `!invoice.order_id`**, `key={"confirmation-"+status}`,
    `target={{invoiceId}}` (an invoice with an order shows the card in the order panel instead).
  - `app/(admin)/admin/customers/[id]/page.tsx` — `OrderConfirmationCell` in the orders table
    (`target={{orderId}}`) and the Stealth Health table (only when `p.status==='paid' && p.invoice_id`, else
    `—` in `text-[11px] text-ink-light`), fed by `confirmationSummariesByOrder/ByInvoice` in
    `app/api/admin/customers/[id]/insights/route.ts`. `app/api/admin/puramass/orders/route.ts` also returns
    `confirmationSummariesByInvoice`.
  - Keying on status re-mounts the card after a status change so it re-reads the automatic send.

### 3.10 `AdminPaidAlertEmailCard` — `components/admin/AdminPaidAlertEmailCard.tsx`
- **Type:** Client component. Same structure as §3.9, icon `BellRing` instead of `Mail`.
- **Props:** `invoiceId: string`, `canSend?: boolean = true`.
- **Rendered by:** `app/(admin)/admin/invoices/[id]/page.tsx`, directly after `OrderConfirmationEmailCard`, only when
  `!invoice.order_id`, `key={"admin-alert-"+invoice.status}`, `canSend={editable}`.
- **Send flow:** confirm `The admin notification has already gone out {once | N times}. Send it again?` when sent
  before; POST `{invoiceId}`; toast `Admin notification {re}sent to {a, b}.`; always reload in `finally`.

---

## 4. UI/UX design overview

### 4.1 Email design tokens (inline hex — the email can't use Tailwind)

| Token | Hex | Use |
|---|---|---|
| NAVY | `#07203A` | headings, values, body text on light |
| DEEP | `#05182B` | footer background |
| BLUE | `#0E68AE` | "your order." highlight, CTA button, support link |
| TEAL | `#2A8C95` | "Brighter" in tagline |
| MUTED | `#56707F` | labels, secondary text |
| LINE | `#DCE7EB` | all borders / rules |
| SOFT | `#F3F8FB` | section cards, image placeholder background |
| GREEN | `#047857` | discount amount |
| Page bg | `#EEF4F7` | `<body>` and outer table |
| Hero fallback bg | `#E6F0F6` | behind hero photo (Outlook desktop drops backgrounds) |
| Intro text | `#34495A` | hero paragraph |
| Icon circle bg | `#E3EFF6` default; `#DDF3EC` for the Payment Status check |
| Tagline divider | `#B8CDD9` |
| Footer text | `#FFFFFF` (VYTA), `#E6EEF3` (badges), `#9DB3BF` (Biosciences, disclaimer); rules `rgba(255,255,255,0.18)`; badge circle border `rgba(255,255,255,0.55)` |

- **Font stack:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` (no web fonts).
- **Money:** `money(n)` → `"-$12.50"` / `"$12.50"` (always 2 decimals, `$` regardless of currency); Total shows
  `"$123.45 CAD"`.
- **Dates:** `formatOrderDate` → `toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'})`
  ("October 4, 2026") in `America/New_York`; a bare `YYYY-MM-DD` is formatted as-is in UTC. Invalid → row omitted.
- **Escaping:** every data value passes through `esc()` (`& < > "`).

### 4.2 Email-client constraints (must keep)
- Table layout only (`role="presentation" cellpadding=0 cellspacing=0 border=0`), all styles inline, **no SVG,
  no web fonts, no emoji entities**. `<meta name="color-scheme" content="light only">`.
- All images are absolute URLs under `{SITE_URL}`. Bordered rounded cells use `border-collapse: separate` (a
  collapsed table ignores border-radius).
- Icons are pre-rendered **96×96 transparent PNGs** in `public/images/email/{icon}-{colour}.png`: Lucide
  (lucide-static 0.546.0, stroke 1.75) + Font Awesome canadian-maple-leaf. Set used: `file-text-blue`,
  `calendar-blue`, `check-teal`, `map-pin-blue`, `package-blue`, `truck-blue`, `package-open-blue`, `mail-blue`,
  `flask-conical-blue`, `flask-conical-white`, `shield-check-white`, `canadian-maple-leaf-white`,
  `arrow-right-white`, `arrow-right-muted`. `<img>` style: `display:inline-block; width/height:{px}; border:0; vertical-align:middle`.
- `iconCircle(content, {bg='#E3EFF6', size=44, border?})` = a single `td` of `size×size`, `border-radius: size/2`,
  centered, `line-height:0`.
- Other assets: `public/images/email/order-hero.jpg` (1280×660), `public/images/vyta-mark.png`,
  `public/images/vyta-wordmark.png`.

### 4.3 Email layout (top → bottom)

`<head>`: `<title>` = subject. Hidden preheader div (`display:none; max-height:0; overflow:hidden; opacity:0`):
`Your payment has been received — order {orderNumber}.`

Outer: full-width table bg `#EEF4F7`; cell `padding: 28px 10px`, centered; inner table `width:100%; max-width:640px`.

1. **Hero** (`td.hero`) — `background` attr + `background-image: url(order-hero.jpg)`, `background-color:#E6F0F6`,
   `background-position: right bottom; background-size: cover; no-repeat`, `border-radius: 20px 20px 0 0`.
   - Top row `padding: 26px 32px 0`: left = link to `{site}` with `vyta-mark.png` (44px wide) + `vyta-wordmark.png`
     (132px wide, `margin-left:6px`, alt "VYTA Biosciences"); right (`.hide-sm`) = tagline cell
     `padding-left:14px; border-left:1px solid #B8CDD9`, 10px/600, `letter-spacing:0.2em`, `line-height:16px`,
     uppercase, NAVY: `Research today.<br><span TEAL>Brighter</span> tomorrow.`
   - Content row: left cell `.stack` width 54%, `padding: 26px 8px 32px 32px`:
     - Eyebrow `ORDER CONFIRMED` — 12px/600, `letter-spacing:0.3em`, uppercase, NAVY, `margin:0 0 12px`.
     - `<h1 class="hero-title">` — 38px / line-height 42px / 800, `letter-spacing:-0.02em`, NAVY, `margin:0 0 14px`:
       `Thank you<br>for <span BLUE>your order.</span>`
     - Intro `<p>` 14px / 22px, `#34495A`: `Hi {customerName}, your payment has been received and your order is being
       processed. We’ll send you another email with tracking information once your order ships.`
     - Right cell `.hide-sm` width 46% `&nbsp;` (the vials in the photo sit there).
2. **Body** — `td` bg `#FFFFFF`, `padding: 0 20px 4px`, starting with a 20px spacer:
   1. **Info strip** — table `border:1px solid LINE; border-radius:16px; box-shadow: 0 6px 18px rgba(7,32,58,0.06)`,
      bg white. Cells (`.stack`, width `floor(100/n)%`, `padding:18px 12px`, cells after the first get
      `border-left:1px solid LINE` + `.stack-rule`): each = 44px icon circle (22px icon) + label (10px/600,
      `letter-spacing:0.14em`, uppercase, MUTED) + value (16px/600 NAVY, `nowrap`, `margin-top:4px`).
      Cells: **Order Number** (`file-text-blue`), **Order Date** (`calendar-blue`; omitted when no date),
      **Payment Status** (`check-teal` on `#DDF3EC`; value `paymentStatus || 'Paid'`).
   2. **Items** — wrapper `padding: 26px 12px 8px`; heading `Your Order` 22px/700 NAVY `margin:0 0 12px`.
      Header row (10px/600, `letter-spacing:0.12em`, uppercase, MUTED, `border-bottom:2px solid LINE`,
      `padding-bottom:8px`): `Product` (colspan 2) · `Qty` (center) · `Unit price` (right, `.hide-sm`) · `Total` (right).
      Each line (`border-bottom:1px solid LINE`, cells `padding:14px …`):
      - `td.thumb` 76px: product image 64×64, `object-fit:cover; border-radius:10px; border:1px solid LINE; bg SOFT`;
        no image → 64×64 SOFT rounded box with `flask-conical-blue` 26px.
      - Name 15px/700 NAVY; sub-line 13px MUTED `"{pack} · {strength}"` where pack = `Pack of {vialsPerBox||10}` for
        case, `Single vial` for vial.
      - Qty 44px centered 14px NAVY; Unit price 84px right 14px; Line total 84px right 14px/600 = `price × qty`.
   3. **Order Summary card** — `card()`: table bg SOFT, `border-radius:16px`, `margin-top:16px`.
      - With ship-to: left `.stack` 58% `padding:24px 20px 24px 24px`; right `.stack.stack-rule` 42%
        `padding:24px 24px 24px 20px; border-left:1px solid LINE`. Without ship-to: one cell `padding:24px`.
      - Totals: heading `Order Summary` 20px/700 NAVY `margin:0 0 10px`; rows (label 14px MUTED, value right 14px
        NAVY nowrap, `padding:5px 0`): **Subtotal**; **Discount** (only if > 0; label
        `Discount <span MUTED>({discountLabel})</span>`, value `-$x` in GREEN); **Shipping** (`Free` when 0);
        **Tax** (only when `tax != null`). Then **Total** row with `border-top:1px solid LINE; padding-top:14px`:
        label 18px/700, value 20px/800 `"$x CUR"`.
      - Shipping Address: 34px icon circle with `map-pin-blue` 18px; title `Shipping Address` 14px/700
        (`margin:6px 0 10px`); name 14px/700 NAVY; each address line 13px / 20px MUTED; phone 13px MUTED `margin-top:8px`.
   4. **What Happens Next? card** — cell `padding:22px 20px 24px 24px`; heading 20px/700 `margin:0 0 16px`; three
      `.stack.stack-gap` cells (31%, `padding:0 4px`), separated by `.hide-sm` 18px cells holding `arrow-right-muted` 16px.
      Each = 40px circle (20px icon) + title 13px/700 NAVY + body 12px / 17px MUTED:
      `package-blue` **1. Order Processing** — "We’re preparing your order." ·
      `truck-blue` **2. Order Ships** — "You’ll receive a tracking email once it ships." ·
      `package-open-blue` **3. Delivery** — "Your order will be on its way to you soon."
   5. **Need Help? card** (`margin-bottom:20px`) — cell `padding:22px 24px`; `.hide-sm` 52px circle with `mail-blue`
      24px; title `Need Help?` 18px/700; text 13px / 19px MUTED: "If you have any questions about your order, reply to
      this email or contact us at **support@vytabio.com** (BLUE, 600, mailto). We’re happy to help."
      If `viewOrderUrl`: right `.stack.stack-gap` 210px cell — pill button `View Order Details&nbsp;&nbsp;→`
      (`arrow-right-white` 16px): `padding:14px 26px; border-radius:999px; background BLUE; color #FFF; 15px/700;
      nowrap`; caption under it 11px MUTED centered: "Sign in or create an account to view it."
3. **Footer** — `td` bg DEEP, `border-radius: 0 0 20px 20px`, `padding: 28px 24px 22px`.
   - Row: brand cell (`border-right:1px solid rgba(255,255,255,0.18)`, `padding-right:12px`): `vyta-mark.png` 38px +
     `VYTA` (20px, `letter-spacing:0.3em`, white) over `BIOSCIENCES` (7px, `letter-spacing:0.32em`, uppercase,
     `#9DB3BF`). Then three badges (36px transparent circle, `1px solid rgba(255,255,255,0.55)`, 18px white icon;
     text 10px/600, `letter-spacing:0.08em`, 14px line-height, uppercase, `#E6EEF3`):
     `flask-conical-white` "Third-party<br>lab tested", `shield-check-white` "High purity<br>&amp; quality",
     `canadian-maple-leaf-white` "Canadian<br>owned &amp; operated".
   - Disclaimer: `margin-top:22px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.18)`, 10px,
     `letter-spacing:0.14em`, uppercase, centered, `#9DB3BF`: "For research purposes only. Not for human or veterinary use."

### 4.4 Email responsive behaviour (`@media only screen and (max-width: 600px)` in `<style>`)
- `.stack` → `display:block; width:100%; box-sizing:border-box; border-left:0; border-right:0` (columns stack).
- `.stack-rule` → `border-top:1px solid #DCE7EB`. `.stack-gap` → `padding-top:12px; text-align:left`.
- `.hide-sm` → hidden (tagline, photo spacer, Unit price column, step arrows, Need Help icon).
- `.hero-title` → 32px / 36px. `.hero` → `background-position: left center` (light side of the photo behind text).
- `.thumb` → width 52px, `padding-right:8px`; `.thumb img, .thumb td` → 44×44.
- Clients that strip `<style>` get the desktop layout.

### 4.5 Plain-text body (both emails)
```
ORDER CONFIRMED — Thank you for your order.

Hi {customerName}, your payment has been received and your order is being processed.
We’ll email you tracking information once it ships.

Order number: {orderNumber}
Order date: {date}                      ← omitted when no date
Payment status: {paymentStatus|Paid}

Your order:
  {name} ({pack}) × {qty} — ${price×qty}   ← "(pack)" omitted when none

Subtotal: $x
Discount ({label}): -$x                 ← only when > 0; "(label)" optional
Shipping: $x | Free
Tax: $x                                 ← only when tax != null
Total: $x CUR

Shipping address:                       ← block only when shipTo; empty parts dropped
{name}
{lines…}
{phone}

View your order (sign in or create an account first): {viewOrderUrl}   ← only when set
Questions? Reply to this email or write to support@vytabio.com.

For research purposes only. Not for human or veterinary use.
```

### 4.6 Subjects
- Customer: `Order Confirmed - {orderNumber}` (kept identical to the previous template).
- Admin: `{prefix}: {label} · {who} · {money(total)} {currency}` where
  `prefix = 'Invoice paid'` for `source==='manual'`, else `'New order'`;
  `label = orderNumber || ('Invoice' | 'Stealth Health order')`;
  `who = customer.name || customer.email || 'Guest'`.
  Example: `New order: VYTA-1042 · Jane Doe · $189.00 CAD`.

### 4.7 Admin cards (Tailwind; tokens from `tailwind.config.ts`)
Token resolution: `ink` `#07203A`, `ink-muted` `#56707F`, `ink-light` `#6E8898`, `line` `#DCE7EB`,
`surface` `#F7FAFB`, `teal` `#438B9E`, `teal-dark` `#1B5D83`; Tailwind defaults `emerald-50` `#ECFDF5`,
`emerald-200` `#A7F3D0`, `emerald-700` `#047857`, `emerald-800` `#065F46`, `amber-50` `#FFFBEB`,
`amber-200` `#FDE68A`, `amber-700` `#B45309`, `amber-800` `#92400E`, `red-600` `#DC2626`.
Body font: Inter (`var(--font-inter)`).

**Sidebar card** (both cards identical except icon/copy):
- Container `bg-white rounded-xl border border-line p-5` (white, 12px radius, 1px `#DCE7EB`, 20px padding).
- Header `flex items-center gap-2 mb-3`: icon `w-4 h-4 text-ink-muted` (`Mail` / `BellRing`) + `h3`
  `font-semibold text-ink text-sm` — "Order confirmation email" / "Admin notification email".
- Loading: `text-xs text-ink-muted flex items-center gap-1.5` with `Loader2 w-3.5 h-3.5 animate-spin` "Checking…".
- Load error: `text-xs text-red-600` message (default "Could not load the confirmation status." / "…notification status.").
- **Sent** box: `rounded-lg px-3 py-2 text-xs border bg-emerald-50 border-emerald-200 text-emerald-800`;
  line 1 `font-semibold flex items-center gap-1` `Check w-3.5 h-3.5` + `Sent` (+ ` N times` when > 1);
  line 2 `mt-0.5`: customer card `Last {when} to <span font-medium>{lastSentTo}</span> · {by X | automatically on payment}`;
  admin card `Last {when} · {by X | automatically on payment}`.
  `when` = `toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'})`.
- **Not sent** box: same shape, `bg-amber-50 border-amber-200 text-amber-800`; `Not sent` + customer:
  "This customer hasn't been sent an order confirmation."; admin: manual → "Manual invoices don’t notify the team
  automatically — send it from here.", else "The team hasn’t been notified about this order yet."
- **Last attempt failed:** `mt-2 text-xs text-red-600 flex items-start gap-1`, `AlertTriangle w-3.5 h-3.5 mt-px shrink-0`
  + "Last attempt failed: {lastError}".
- **Button** (only if `canSend`): `mt-3 w-full px-3 py-2 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg
  text-sm hover:bg-teal/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2`
  (bg `#438B9E` @10%, hover @20%, border @20%, text `#1B5D83`). Disabled while sending or when `blockedReason`.
  Icon `w-3.5 h-3.5`: `Loader2 animate-spin` while sending, `RotateCw` if sent before, else `Mail`/`BellRing`.
  Label: "Send/Resend order confirmation" | "Send/Resend admin notification".
- Under button `mt-1.5 text-[10px] text-ink-muted`: `blockedReason` or `Goes to {recipient}` / `Goes to {a, b}`.
- **History** (when any rows): `mt-3 pt-3 border-t border-line/60`; toggle `text-[11px] text-ink-muted hover:text-ink`
  "Show/Hide send history (N)"; list `mt-2 space-y-1.5`, each `li text-[11px] leading-snug`: `✓` `text-emerald-700`
  or `✗` `text-red-600`, `when` in `text-ink`, then `text-ink-muted` "· {to_email} · {sent_by_email || 'automatic'}";
  failed rows add `div text-red-600 ml-3` with the error.

**List cell** (`OrderConfirmationCell`) — `flex items-center gap-2`:
- Status label `inline-flex items-center gap-1 text-[11px] font-medium` with a `h-3 w-3` icon:
  Failed → `text-red-600` `Mail` "Failed" (title "Last attempt failed: …"); Sent → `text-emerald-700` `Check`
  "Sent {localeDate}" + " · N×" when > 1 (title with time, recipient, by/automatically); else `text-amber-700`
  `Mail` "Not sent".
- Button (if `canSend && target`): `inline-flex h-6 w-6 items-center justify-center rounded border border-line
  bg-surface text-ink-muted hover:border-ink/20 hover:text-ink disabled:opacity-40`, icon `h-3 w-3`
  (`Loader2` spinning / `RotateCw` / `Mail`); `title`/`aria-label` "Send|Resend the order confirmation email".

---

## 5. Data flow & behavior

### 5.1 Paid signals → sends

| Paid signal | Customer confirmation | Admin alert |
|---|---|---|
| Stealth Health webhook (`app/api/webhooks/stealth-health/route.ts`), poller (`lib/payments/puramass-poll.ts`, cron), admin refresh (`app/api/admin/puramass/orders/refresh/route.ts`) → `materializeStealthHealthFulfillment` | `sendStealthHealthOrderConfirmationOnce` on **every pass** (after stock, `onFirstPaid`, affiliate credit, shipment booking) | `sendStealthHealthPaidAlertOnce(…, {transition: firstPaid, paidVia:'checkout'})` on every pass, right after the confirmation |
| Admin sets invoice status → `paid` (`PATCH app/api/admin/invoices/[id]/route.ts`, first transition only) | `after(() => sendConfirmationForPaidInvoice)` | `after(() => sendStealthHealthPaidAlertForInvoice)` |
| Admin records a payment that settles the invoice (`app/api/admin/invoices/[id]/payments/route.ts`, `totalPaid ≥ total − 0.001`, first transition) | same | same |
| Admin creates an invoice already `paid` **with an `order_id`** (`app/api/admin/invoices/route.ts`) | `after(() => sendConfirmationForPaidInvoice)` | — |
| Admin sets a storefront order to `confirmed` (`app/api/admin/orders/[id]/route.ts`, status change only) | `after(() => sendStorefrontOrderConfirmationOnce)` — only `source` starting `e-transfer` | — |
| Manual invoice paid | **never automatic** (`not_eligible`) | **never automatic** (no ledger → `not_found`) |

`after()` runs the send after the HTTP response is returned, so admin saves aren't slowed down. The webhook path
awaits but swallows every error and logs `… failed; will retry` on `send_failed`.

### 5.2 Exactly-once state machine (per claim column)
```
NULL ──(paid signal: conditional UPDATE … WHERE col IS NULL wins)──▶ now()  ──send ok──▶ stays stamped (done)
                                                                       └──send failed──▶ NULL (next signal retries)
NULL ──(signal loses the race: 0 rows updated)──▶ 'already_sent', no send
stamped ──(any automatic signal)──▶ 'already_sent'
stamped/NULL ──(admin manual send ok)──▶ stamped (customer: always overwritten; admin alert: only if NULL)
```
Every attempt (auto or manual, success or failure) inserts one `fulfillment_email_log` row.

### 5.3 Rules / intricacies to preserve
1. **Unpaid hand-offs already have an invoice** (`pending_payment`). "Paid" = `invoice.status === 'paid'` **or**
   `puramass_orders.status === 'paid'`.
2. **Customer email requires the migration**: if `confirmation_email_sent_at` is missing, nothing is sent
   automatically (warn `[order-confirmation] … run order-confirmation-email-migration.sql …`); manual send still works.
3. **Admin alert degrades** without its migration: sent unclaimed only by the call where `transition` is true (the
   call that saw the invoice turn paid), with no retry.
4. **Recipient = what the admin page shows**: linked customer account email first, then the order/invoice copy,
   then the checkout capture. Placeholder domains (`.local/.invalid/.test/.example`) are skipped; if nothing is
   deliverable the auto send returns `no_email` (the claim is **not** taken, so a later fixed address + signal sends)
   and the admin card shows the `noEmailReason` text with the button disabled.
5. **Admin alert body = customer email body**, including the buyer-facing "Need Help? … reply to this email" copy
   and the buyer's View Order Details button only if `viewOrderUrl` were set (it isn't on the admin path — see §7).
6. **Line prices**: Stealth Health invoices store discounted prices; list prices from `ledger.items[].list_unit_price_cents`
   are shown with a Discount row only when every line matches and Subtotal − Discount + Shipping + Tax still equals
   the invoice total.
7. **Manual invoices have no "View Order Details" link** (not in the customer account).
8. **Storefront orders are not auto-confirmed on VYTA today** — VYTA sells through the Stealth Health hosted
   checkout; admin-created orders are invoiced by hand; legacy crypto orders use the separate `sendPaymentConfirmed`
   email. A future own checkout opts in by writing `orders.source` starting `e-transfer`.
9. **Product images**: catalog `products.image_url` (relative paths are URL-encoded and prefixed with `SITE_URL`).
   Only lines whose `product_id` is a UUID get an image.
10. **Admin cards appear only on non-order invoices** on the invoice page; storefront invoices show the customer card in
    the order panel and have no admin-alert card.
11. **Permissions**: GET status = admin or assistant; POST send = admin only. Cards receive `canSend` from the page's
    edit permission so assistants see status read-only.
12. **Nothing throws to the caller**; logging failures are console-only and never block the email.

---

## 6. Edge cases & states

| Case | Behaviour |
|---|---|
| No deliverable buyer address | Auto: `no_email`, no claim, no log row. Card: Not sent + disabled button + `noEmailReason`. Admin alert still sends (doesn't need the buyer address). |
| No admin recipients | Auto: `no_recipients`, no claim. Card: blocked "No admin recipients — add them under Settings → Admin Email Notifications." |
| SMTP failure | Log row `success=false` with error; claim released; next paid signal retries. Card shows red "Last attempt failed: …"; list cell shows "Failed". Manual send → HTTP 502 → error toast. |
| Duplicate / concurrent webhooks | Conditional UPDATE lets exactly one caller send; others `already_sent`. |
| Order not paid | Stealth Health card: blocked "Not paid yet — the confirmation goes out once the order is paid." Manual invoice: "Mark the invoice paid first — this email tells the customer their payment was received." Admin alert: "Mark the invoice paid first — this email tells the team an order was paid." Storefront orders are **never** blocked on paid status for manual sends. |
| `fulfillment_email_log` CHECK on `kind` (un-migrated) | Email sends, insert rejected, history empty; console error tells you to run the migration. |
| Invoice deleted after linking | `materializeStealthHealthFulfillment` recreates it; send proceeds normally. |
| Card loading / error / not applicable | "Checking…" spinner / red error text / renders nothing (`applicable:false`). |
| Resend | Browser `confirm()` dialog when already sent ≥ 1. |
| Unauthorized API call | 403 `{error:'Unauthorized'}`; bad id → 400. |
| Optional sections | Order Date cell omitted when no/invalid date; Discount row only when > 0; Tax row only when `tax != null` (always for invoice-based orders, never for storefront); Shipping shows `Free` at 0; Ship-to column and text block omitted when no address; product image falls back to flask placeholder. |

---

## 7. Open questions & unverified items

1. **`invoices.paid_at`** is read for the Order Date (`invoice.paid_at || …`) but no migration in the repo adds that
   column; in practice the date falls back to `ledger.paid_at` / `issue_date` / `created_at`. Confirm whether the
   column exists in production.
2. **Unused admin payload fields:** `AdminOrderPaidEmailData.paidVia`, `customer.phone`, `courier`, `discountCode`,
   `stockWarnings` and `invoiceUrl` are built but **not rendered** — since commit "Admin 'order paid' email: same
   design as the customer confirmation" the admin body is the customer email verbatim. The header comment of
   `stealth-health-paid-alert.ts` still says `paidVia` "changes one line of the email". Unused icons
   `phone-blue`, `tag-blue`, `triangle-alert-amber`, `user-blue` in `public/images/email/` suggest a richer admin
   layout existed. Decide whether a rebuild should surface these (e.g. a link to the admin invoice, unlinked-stock
   warnings).
3. **Admin email has no View Order Details button** — `buildAdminEmail` calls `withProductImages` only, not
   `enrichForEmail`, so `viewOrderUrl` is never set. Appears intentional but not documented.
4. **`orders.phone` and `orders.currency`** are read by the storefront builder but are not in the schema snapshot;
   they fall back to null / `'CAD'`.
5. **Money formatting ignores currency** — always `$` with the code appended only on the Total row.
6. **Reply-To** is not set; "reply to this email" relies on the From mailbox (`SMTP_FROM`/`SMTP_USER`) being monitored.
7. The `apiFetch` / `ToastContext` internals, Admin → Settings UI for `admin_emails`, and the customer order page /
   claim route UI were not examined beyond their contracts above.
