# Affiliate referral codes

Vanity codes, affiliate-raised change requests, an admin review queue, and
admins setting codes outright. This replaces the old model — fixed 8-character,
system-generated, permanent codes with the format re-declared in four files.

Run **`referral-code-requests-migration.sql`** before deploying. Until it does,
any code longer than 8 characters is rejected by the column and the review
queue reads as permanently empty.

---

## What changed

| | Before | Now |
| --- | --- | --- |
| Format | `VARCHAR(8)`, `/^[A-Z0-9]{8}$/` re-declared in middleware, checkout, attribution and utils | `VARCHAR(32)` column, **4–20 characters**, constants exported from **one** module (`lib/affiliate/utils.ts`) and imported everywhere |
| Allocation | `generateReferralCode()` (random 8) at every issuance point, each with its own retry loop | `proposeReferralCode(db, person)` — **`AMC` + surname + `10`** (`AMCSMITH10`), a collision ladder, random only as the last fallback. One retry loop, server-side |
| Changing a code | Impossible | Affiliates **request**; admins **approve / decline**; admins can also **set a code directly**, no queue |
| History | None | **`referral_code_requests`** — the queue *and* the audit history of every code a partner has ever held |
| Notification | None | Approving a request or setting a code **emails the affiliate**. Opt-out checkbox, on by default. Never fatal to the save |

Two rules that are decisions, not accidents:

- **A decline reason is admin-only.** The affiliate sees the word "Declined"
  and nothing more. Enforced by column selection in the route, *not* by RLS.
- **Approving a request renames the existing `referral_codes` row.** It never
  inserts a second one.

---

## Data model

`referral_codes.code` widens to `VARCHAR(32)`. `uses_count` is maintained by a
trigger on `commissions` insert and `commissions.referral_code_id` is a FK onto
that row — which is *why* a code change is an `UPDATE`. A second row would
strand the commission history behind a code nobody uses and reset the count to
zero.

`referral_code_requests` carries the request, its decision, and the code that
was live when it was raised. Two **partial unique indexes** are load-bearing:

- one pending request per affiliate (the portal offers "withdraw", not a queue);
- one pending claim per code (two affiliates cannot both be waiting on it).

They are the backstop behind every availability check — `23505` maps to a 409
the user can act on.

### RLS is on with *no policies*, deliberately

The table denies `anon` and `authenticated` outright. Every read and write goes
through an API route holding a service-role client; the route authenticates the
caller **and chooses the columns**. That column choice is the only thing keeping
`decision_notes` and `decided_by_name` off an affiliate's screen. A row-level
policy of the obvious shape (`affiliate_id = auth.uid()`) would hand the
affiliate the whole row, rejection note included. Do not "simplify" it.

---

## Modules

| File | What it owns |
| --- | --- |
| `lib/affiliate/utils.ts` | **The format contract.** `REFERRAL_CODE_{MIN,MAX}_LENGTH`, `REFERRAL_CODE_REGEX`, `normalizeReferralCode`, `suggestReferralCode`, `suggestReferralCodeVariants`, `referralCodeFormatError`, `generateReferralCode` |
| `lib/affiliate/referral-code-service.ts` | Allocation, server side, service-role client only: `checkReferralCodeAvailability`, `proposeReferralCode`, `assignReferralCode`, `getCurrentReferralCode`, `notifyAffiliateOfCodeChange` |
| `lib/affiliate/route-auth.ts` | Caller resolution — an affiliate resolver that accepts a row in **any** state, and a staff resolver that separates "reads the queue" from "decides" |
| `lib/affiliate/referral-codes.ts` | Affiliate portal client |
| `lib/admin/referral-codes.ts` | Admin desk client |

`assignReferralCode` is the **one** write path that puts a code on an affiliate.
It is idempotent against "that is already your code", and the unique index is
the final arbiter.

---

## Routes

| Route | Method | Who | Purpose |
| --- | --- | --- | --- |
| `/api/affiliate/referral-code` | GET | the affiliate (any state) | Their code, open request, history, suggestion |
| `/api/affiliate/referral-code` | POST | the affiliate (not deactivated) | Ask for a code |
| `/api/affiliate/referral-code` | DELETE | the affiliate | Withdraw the open request |
| `/api/affiliate/referral-code/check` | GET | **any signed-in user** | Availability, as you type |
| `/api/admin/referral-code-requests` | GET | admin, assistant | The review queue |
| `/api/admin/referral-code-requests/[id]` | POST | **admin only** | Approve / decline one request |
| `/api/admin/affiliates/[id]/referral-code` | GET | admin, assistant | Current code + suggestion |
| `/api/admin/affiliates/[id]/referral-code` | PUT | **admin only** | Set a code outright |

The affiliate-facing GET reads an explicit column list —
`id, requested_code, previous_code, status, source, created_at, decided_at`.
`decision_notes` and `decided_by_name` are deliberately absent. **This is the
privacy boundary.**

On approve, the code is assigned **before** the request is marked decided: if
the code got taken in the meantime the request stays open rather than being
silently closed against a code nobody can have. The decision `UPDATE` is
guarded on `status = 'pending'`, which makes a double click idempotent.

A rejection never mails. Nothing changed, they keep the code they have, and the
reason is for the admin side of the desk.

---

## Issuance points

Every place a code is born now goes through the service layer:

1. **`/affiliate/signup`** — the field is seeded once from
   `suggestReferralCode(customer)` (guarded by a ref, not by "is the field
   empty"; the suggestion reappearing under the cursor is not help). The chosen
   code is issued with the account.
2. **`/affiliate/apply`** — the applicant picks a code. It is **held on the
   application**, not issued (see *Deviations*).
3. **Approving an application** (`POST /api/admin/affiliate-requests/[id]`) —
   a code the admin typed, else **the code they asked for** if it is still
   free, else `proposeReferralCode`. The ask is then closed against whatever
   was actually issued, so the queue never shows an answered request. Guarded
   on "they have no code yet".
4. **Admin creates an affiliate** (`POST /api/admin/affiliates`) — the code is
   validated *before* the auth user is created: a collision is the likeliest
   way the request fails, and failing early costs nothing, whereas failing
   after provisioning means rolling back an auth user just to say "try another
   code".
5. **The review queue** — approving a change request.

---

## UI

- `components/affiliate/ReferralCodeField.tsx` — the shared picker, used by all
  four forms that choose a code (portal panel, application, admin create modal,
  admin edit modal). The parent owns the value; this owns the checking:
  normalize → format → 400 ms debounced availability call. Every lookup is
  stamped with a ticket so a slow reply for an older code cannot overwrite the
  verdict for what is in the box now.
- `components/affiliate/ReferralCodePanel.tsx` — the portal's Settings panel.
  Has-a-code / no-code / open-request states, plus a past-requests list.
- `PendingReferralCodeRequests.tsx` — the queue above the affiliates list.
  Returns `null` when nothing is pending: a box that is empty on every page
  load teaches people to stop reading it. One "email on approve" checkbox above
  the list, ticked by default.
- `EditReferralCodeModal.tsx` — an admin setting a code, with the amber warning
  that saving retires the current code immediately. An affiliate with printed
  cards needs to hear that **before** the change.
- `DeclineReferralCodeDialog.tsx` — shared by the queue and the partner page so
  both ask the same way. The reason is optional and admin-only.

Partner 360 (`/admin/affiliates/[id]`) gains a Referral link card: the code and
use count, a click-to-copy referral link, an inline decision block when a
request is open, and the last five decided rows.

---

## Integration points

- **`middleware.ts`** captures `?ref=` exactly as the link carries it — no case
  change, nothing stripped — and a newer link's code replaces the stored one.
  The checkout shows that code in its affiliate field and checks it with an
  exact match (`resolveReferralCodeOwner`), never correcting it.
- **`lib/analytics/attribution.ts`** stores `ref_code` on a touch and had the
  same stale pattern. Same fix.
- **Checkout** bounds the field by `REFERRAL_CODE_MAX_LENGTH`, normalizes the
  input, debounces 350 ms, and validates once the input reaches
  `REFERRAL_CODE_MIN_LENGTH` — not on an exact width.
- **`resolveAffiliateAttribution`** now only honours a code while the affiliate
  who owns it is active. A switched-off partner's code must not discount an
  order or book a commission nobody intends to pay.
- **`sendReferralCodeChanged`** (`lib/email.ts`) — subject *"Your Aminocan
  referral code is now X"*, with an amber "your old code has been retired"
  block only when there was a previous code.
- **Audit log** — `referral_code.approve`, `referral_code.reject`,
  `referral_code.update`. Entity is `affiliate` and the entity id is the
  *affiliate's* id, not the request's, so code changes appear on the partner's
  own timeline.

---

## Deviations from the source spec

The spec was written against a sibling site. Three things differ here, on
purpose:

1. **House prefix is `AMC`**, not the sibling's. It is a single constant in
   `lib/affiliate/utils.ts`.
2. **There is no `affiliates.status` column.** An `affiliates` row only exists
   once an application has been accepted, and `active` is what an admin
   switches off afterwards, so the spec's three states collapse to two:
   accepted → `approved`, switched off → `rejected`.
3. **A pending applicant's code choice rides on `affiliate_requests`**, in a
   new `requested_code` column, rather than on `referral_code_requests` — an
   applicant has no `affiliates` row for the FK to reference. The invariant the
   spec cares about is preserved exactly: **no live `referral_codes` row is
   ever created for someone an admin has not approved**, and their choice is
   issued the moment they are.

One item from the spec is not carried over: the audit entries record the action
and the affiliate but no JSON detail payload, because `audit_logs` in this
codebase has no detail column.

---

## Invariants

1. **One format definition.** No inline `{8}` survives anywhere.
2. **Normalize before compare or store.**
3. **A code change is an `UPDATE` of the existing row.** Never an insert.
4. **A pending request is a claim.** Availability considers it; both partial
   unique indexes must exist.
5. **No live code for an unapproved applicant.**
6. **`decision_notes` and `decided_by_name` never reach the affiliate.**
7. **The decline reason is optional** for a code, required for an application.
   Different decisions, different bars.
8. **Email is reported, never fatal.** Approve/set returns `notified` +
   `notify_error` alongside a successful save. Approvals mail; declines never do.
9. **Decisions are guarded on `status = 'pending'`**, and the code is assigned
   *before* the request is marked decided.
10. **Assign is idempotent** against "that is already your code".

## Tests

`lib/affiliate/referral-code.test.ts` pins the format contract, the suggestion
and the collision ladder. `lib/affiliate/commission.test.ts` covers the
active-affiliate guard on attribution. Run with a TS-aware loader:

```
node --test --import tsx lib/affiliate/referral-code.test.ts
```
