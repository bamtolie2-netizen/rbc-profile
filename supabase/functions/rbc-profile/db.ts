// Minimal Supabase REST (PostgREST) client using the service role key that Supabase injects
// into every Edge Function (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). No npm dependency.

const URL_ = Deno.env.get("SUPABASE_URL") || "";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
export const dbEnabled = !!(URL_ && KEY);

const headers = (extra: Record<string, string> = {}) => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

export async function insert(table: string, row: Record<string, unknown>): Promise<string | null> {
  if (!dbEnabled) return null;
  try {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=id`, {
      method: "POST",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { console.error(`insert ${table}`, res.status, await res.text()); return null; }
    const data = await res.json();
    return data?.[0]?.id ?? null;
  } catch (e) {
    console.error(`insert ${table}`, e);
    return null;
  }
}

/** Number of analyze requests from this ip hash within the last `minutes`. Returns -1 if unknown. */
export async function recentCount(ipHash: string, minutes = 60): Promise<number> {
  if (!dbEnabled) return -1;
  try {
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const res = await fetch(
      `${URL_}/rest/v1/rbc_requests?select=id&ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${encodeURIComponent(since)}`,
      { headers: headers({ Prefer: "count=exact", Range: "0-0" }), signal: AbortSignal.timeout(4000) },
    );
    const range = res.headers.get("content-range") || ""; // e.g. "0-0/7" or "*/0"
    const n = parseInt(range.split("/")[1] || "", 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
