"use client";

/**
 * The paid-ads welcome offer, inline in the nav's research-disclaimer row.
 *
 * Shown only to visitors who arrived on an ad — everyone else sees the site
 * unchanged, because the offer is what that click paid for. A guest is invited
 * to create an account; once they have one the same line turns into
 * confirmation that the discount is on their order, so the promise made at the
 * top of the funnel is still visible at the bottom of it.
 *
 * It is a welcome offer, so a signed-in customer only sees it while it is
 * actually theirs: once they have ordered it disappears, rather than inviting
 * them to claim a discount the checkout would refuse. A signed-in customer is
 * never shown the guest "sign up and save" call to action.
 *
 * ## Why this is a fragment and not a strip
 *
 * It used to be its own full-width row under the disclaimer, and that made the
 * fixed nav taller, which the storefront screens — each carrying its own
 * literal top padding — had to be compensated for with a body-padding rule,
 * and that gap showed above the hero as a second bar.
 *
 * Sitting inside the disclaimer row instead, it inherits that row's background
 * and colours and adds no height at all. So it renders no wrapper, no
 * background and no spacing of its own: just a separator and the offer, as
 * siblings of "Research Only".
 *
 * ## Landing-page visitors
 *
 * Someone who came through one of our landing pages was promised THAT page's
 * percentage, so it replaces the ad offer here — they usually count as ad
 * traffic too (the page forwards the ad's click id), and telling them "25%"
 * after the page said "35%" would read as a bait and switch. No sign-up is
 * asked for: the landing offer is a discount code, which works for guests, and
 * checkout puts it in the discount field for them.
 *
 * Nothing here decides money. `/api/checkout/puramass` re-reads the attribution
 * cookies, the customer row and their order history, and applies the discount
 * itself (lib/promos/ad-discount.ts); this only says what is about to happen.
 */
import React from "react";
import Link from "next/link";
import { ArrowRight, BadgePercent, Check } from "lucide-react";
import { usePromos } from "@/contexts/PromosContext";
import { useCustomer } from "@/contexts/CustomerContext";

export interface AdOfferNotice {
  /** Draw the offer at all. */
  show: boolean;
  /** It is already theirs — as opposed to an invitation to sign up for it. */
  eligible: boolean;
  /** The offer as advertised, e.g. "25%". */
  off: string;
  /** Limited to the first order — changes the wording. */
  firstOrder: boolean;
}

/**
 * Whether this visitor is being made the offer, and in which of its two forms.
 *
 * Exported because `Navigation` needs the same answer to lay the row out: on a
 * phone the disclaimer is already at the width of the screen, so it drops
 * "Canada Only" while the offer is running rather than letting the row wrap and
 * make the fixed nav taller than the pages below it allow for.
 */
export function useAdOfferNotice(): AdOfferNotice {
  const { adDiscount, isAdVisitor, adDiscountEligible, landingOffer } = usePromos();
  const { customer } = useCustomer();
  // A landing page's offer wins: it is the promise this visitor actually saw.
  if (landingOffer.active) {
    return {
      show: true,
      eligible: true,
      off: `${+landingOffer.percent.toFixed(2)}%`,
      firstOrder: landingOffer.firstOrderOnly,
    };
  }
  // A guest from an ad gets the invitation. A signed-in customer gets the line
  // only while the offer is still theirs to spend — which also keeps it hidden
  // during the moment before the first-order check has answered.
  const show =
    adDiscount.active && isAdVisitor && (customer ? adDiscountEligible : true);
  return { show, eligible: adDiscountEligible, off: `${adDiscount.percent}%`, firstOrder: true };
}

/**
 * Renders as siblings of the disclaimer text, so the caller must place it
 * inside that row's flex container. Renders nothing when there is no offer to
 * make, which is what lets `Navigation` drop it in unconditionally.
 */
export default function AdDiscountNotice() {
  const { show, eligible, off, firstOrder } = useAdOfferNotice();
  if (!show) return null;

  const amount = <span className="font-semibold text-ink">{off} off</span>;

  return (
    <>
      <span className="text-line">•</span>

      {eligible ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-emerald-700">
          <Check className="h-3 w-3 flex-shrink-0" />
          <span>
            <span className="font-semibold">{off} off</span>
            <span className="hidden sm:inline">
              {firstOrder ? ' your first order' : ''} — applied at checkout
            </span>
            <span className="sm:hidden"> applied</span>
          </span>
        </span>
      ) : (
        <Link
          href="/signup"
          className="group inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:text-ink"
        >
          <BadgePercent className="h-3 w-3 flex-shrink-0 text-teal-dark" />
          <span>
            {amount}
            <span className="hidden sm:inline"> your first order — sign up</span>
            <span className="sm:hidden"> first order</span>
          </span>
          <ArrowRight className="hidden h-3 w-3 flex-shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 sm:inline" />
        </Link>
      )}
    </>
  );
}
