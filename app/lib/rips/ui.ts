/** Rips UI surface switches. Hidden parts stay in the code; flip to restore them. */
// Demo pool entry points. Off: Rips always uses the live pool.
export const RIPS_SHOW_DEMO = false;
// Decoration and secondary features: marquee, sharing, sorting, explainers, pool debug state.
export const RIPS_SHOW_EXTRAS = false;
// The app shows only what a Rips user needs: buy, My Rips, sell. Other routes
// stay in the code and reachable by URL, but are not linked from the header.
export const RIPS_ONLY_APP = true;
