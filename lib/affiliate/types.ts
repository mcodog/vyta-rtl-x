/** One row of GET /api/affiliate/commissions, as the affiliate dashboard renders it. */
export type AffiliateCommissionRow = {
  id: string;
  source: 'referral' | 'invoice';
  /** Invoice number, else order number, else a short id. */
  reference: string;
  base: number;
  amount: number;
  /** Percentage, e.g. 10 for 10%. */
  rate: number;
  status: string;
  created_at: string;
  paid_at: string | null;
};
