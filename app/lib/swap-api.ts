// Local API shim is started alongside Next by `pnpm dev`. Production uses the
// existing Cloudflare Worker, not a second deployed backend.
export const SWAP_API = process.env.NODE_ENV === "development" ? process.env.NEXT_PUBLIC_SWAP_API ?? "http://localhost:8787" : "";
