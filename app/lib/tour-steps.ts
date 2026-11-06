export type TourStep = {
  id: string;
  /** Default route for this step. */
  route: string;
  /** Dynamic route prefixes where this step can continue without redirecting. */
  allowedRoutePrefixes?: string[];
  /** `data-tour` value on the element to point at. */
  target?: string;
  /** Visible alternatives when the primary control is not rendered. */
  fallbackTargets?: string[];
  title: string;
  body: string;
  /** Short instruction shown beside the highlighted control. */
  action?: string;
  /** Clicking one of these targets advances the guide. */
  advanceOn?: string[];
  /** A visible target proving the preceding action already completed. */
  completeWhenVisible?: string[];
  /** Explanation shown while a target is not available. */
  waitFor?: string;
};

/**
 * The product journey, not an inventory of every screen.
 *
 * Opening Guide is contextual: Markets starts at market selection, a market
 * detail starts at its actions, and Portfolio explains positions. Test-token
 * setup and market administration stay outside the end-user walkthrough.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "side",
    route: "/app",
    target: "role-choice",
    title: "Choose your side",
    body: "Stock holders sell their upside for a premium. Upside buyers take the gains above the strike without margin or liquidation.",
    action: "Choose the side you want to explore.",
    advanceOn: ["role-seller", "role-buyer"],
  },
  {
    id: "market",
    route: "/app",
    allowedRoutePrefixes: ["/app/"],
    target: "series-card",
    fallbackTargets: ["series-list", "market-summary"],
    title: "Open a market",
    body: "Each row is one stock, strike and expiry. Compare the reference price, premium and time remaining before choosing.",
    action: "Open a market row to continue.",
    advanceOn: ["series-card"],
    waitFor: "Markets are loading. If none appear, check the network connection or active-market filter.",
  },
  {
    id: "act",
    route: "/app",
    allowedRoutePrefixes: ["/app/"],
    target: "market-actions",
    fallbackTargets: ["market-summary"],
    title: "Lock, then sell the upside",
    body: "Locking stock creates equal P and N claims. You keep the capped P claim and ask market makers for a premium for N.",
    waitFor: "Open a market first. Its lock and quote controls will appear here.",
  },
  {
    id: "portfolio",
    route: "/portfolio",
    target: "nav-portfolio",
    fallbackTargets: ["portfolio-positions"],
    title: "Track, settle and redeem",
    body: "Portfolio shows your P and N balances. After expiry, anyone can settle and each holder redeems their own claim.",
  },
];
