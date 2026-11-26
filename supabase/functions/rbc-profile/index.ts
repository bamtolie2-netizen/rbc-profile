// Supabase Edge Function
//   POST { url }                         → { requestId, extracted, application, steps }
//   POST { url, manual:{name,description,phone?,email?} } → same, from typed-in info (site unreadable)
//   POST { action:"lead", requestId, company, phone, agreed:true, ... } → saves a 상담 신청
// Reads a website (home + up to 2 about/contact pages, linked Kakao channel) and drafts
// the RCS Biz Center brand application and the KakaoTalk channel application.
import { addImage, decodeHtml, extract, isKakaoChannelUrl, isPrivateIp, isSafeUrl, mergeInto, normalizeKakao, normalizePhone, parseKakaoChannel, pickSubpages, softRedirect } from "./extract.ts";
import type { Extracted } from "./extract.ts";
import { buildPrompt, parseClaude, ruleApplication } from "./profile.ts";
import { countRows, dbEnabled, insert, recentCount, sha256, sinceParam, update } from "./db.ts";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim());
const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
const MAX_BYTES = 2_000_000;

function cors(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" } });

/* --- in-memory rate limit (per instance): fallback when the DB count is unavailable --- */
const hits = new Map<string, number[]>();
function limited(key: string, max = 20, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, ts] of hits) if (!ts.length || now - ts[ts.length - 1] >= windowMs) hits.delete(k);
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

const IP_FROM = Deno.env.get("IP_FROM") === "last" ? "last" : "first";
const DEBUG_IP = Deno.env.get("DEBUG_IP") === "1";
/** Client IP for per-IP limits. x-forwarded-for may be client-supplied, so the global cap is the real cost guard. */
function clientIp(req: Request): string {
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (DEBUG_IP) console.log("ip headers", { xff, realIp: req.headers.get("x-real-ip"), cf: req.headers.get("cf-connecting-ip") });
  return (IP_FROM === "last" ? xff[xff.length - 1] : xff[0]) || req.headers.get("x-real-ip") || "unknown";
}

let dnsWarned = false;
/** Every resolved address must be public. Unresolvable hosts are refused (fail closed). */
async function resolvesPublic(rawHost: string): Promise<boolean> {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return !isPrivateIp(host);
  if (typeof Deno.resolveDns !== "function") {
    if (!dnsWarned) { console.warn("Deno.resolveDns unavailable: DNS-based SSRF check skipped"); dnsWarned = true; }
    return true;
  }
  const errs: unknown[] = [];
  const look = (t: "A" | "AAAA") => Deno.resolveDns(host, t).catch((e) => { errs.push(e); return [] as string[]; });
  const ips = [...(await look("A")), ...(await look("AAAA"))];
  if (!ips.length) { console.error("dns: no address", host, errs.map(String)); return false; }
  return ips.every((ip) => !isPrivateIp(ip.toLowerCase()));
}

/** fetch with the SSRF guard re-applied on every hop: http(s) + public hosts only, manual redirects (max 4). */
async function safeFetch(raw: string, init: { accept: string; timeoutMs: number; ua: string }): Promise<{ url: string; res: Response }> {
  let url = raw;
  for (let i = 0; i < 5; i++) {
    if (!isSafeUrl(url) || !(await resolvesPublic(new URL(url).hostname))) throw new Error("허용되지 않는 주소예요.");
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs),
      headers: { "User-Agent": init.ua, "Accept": init.accept, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5" },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      await res.body?.cancel();
      continue;
    }
    return { url, res };
  }
  throw new Error("리다이렉트가 너무 많아요.");
}

/** Read at most `max` bytes. `truncated` is true when the body was longer. */
async function readLimited(res: Response, max: number): Promise<{ buf: Uint8Array<ArrayBuffer>; truncated: boolean }> {
  if (!res.body) return { buf: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > max) { truncated = true; await reader.cancel(); break; }
  }
  const buf = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) { const n = Math.min(c.length, buf.length - off); buf.set(c.subarray(0, n), off); off += n; if (off >= buf.length) break; }
  return { buf, truncated };
}

const PAGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 SureM-RBC-Profiler";

/** Fetch an HTML page safely (see safeFetch), keeping the first MAX_BYTES. */
async function fetchPage(raw: string): Promise<{ url: string; html: string }> {
  const { url, res } = await safeFetch(raw, { accept: "text/html,application/xhtml+xml", timeoutMs: 9000, ua: PAGE_UA });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`사이트가 응답하지 않아요 (HTTP ${res.status}).`); }
  const ct = res.headers.get("content-type");
  if (ct && /^(image|video|audio|font)\/|application\/(pdf|zip|json)/i.test(ct)) { await res.body?.cancel(); throw new Error("HTML 페이지가 아니에요."); }
  const { buf } = await readLimited(res, MAX_BYTES);
  return { url, html: decodeHtml(buf, ct) };
}

async function askClaude(prompt: string): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(45000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    const t = await res.text();
    let msg = t.slice(0, 300);
    try { msg = JSON.parse(t)?.error?.message || msg; } catch { /* keep raw */ }
    throw new Error(`Claude API ${res.status} (model ${MODEL}): ${msg}`);
  }
  const data = await res.json();
  return (data.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
}

function applyKakao(ex: Extracted, k: ReturnType<typeof parseKakaoChannel>, source: string) {
  ex.kakao = k;
  if (k.url && !ex.kakaoChannels.some((c) => c.value === k.url)) ex.kakaoChannels.unshift({ value: k.url, source });
  if (k.name && !ex.siteName.some((c) => c.value === k.name)) ex.siteName.push({ value: k.name, source: `${source} 채널명` });
  if (k.description && !ex.descriptions.some((c) => c.value === k.description)) ex.descriptions.push({ value: k.description, source: `${source} 소개` });
  if (k.image) addImage(ex, k.image, "kakao", `${source} 프로필 이미지`);
}

const HOURLY_LIMIT = Number(Deno.env.get("HOURLY_LIMIT") || 20);
// Cap across all visitors: bounds Claude cost even if per-IP limits are bypassed with spoofed headers.
const GLOBAL_HOURLY_LIMIT = Number(Deno.env.get("GLOBAL_HOURLY_LIMIT") || 300);
const IMAGE_HOURLY_LIMIT = Number(Deno.env.get("IMAGE_HOURLY_LIMIT") || 120);
const LEADS_PER_REQUEST = 3;
const SALT = Deno.env.get("IP_SALT") || "surem-rbc";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tooMany = (req: Request) => json(req, { error: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요." }, 429);

function manualExtract(url: string, m: { name?: string; description?: string; phone?: string; email?: string; address?: string }): Extracted {
  const ex = extract("<html><body></body></html>", url);
  const src = "직접 입력";
  if (m.name) ex.siteName.push({ value: m.name.slice(0, 60), source: src });
  if (m.description) {
    ex.descriptions.push({ value: m.description.slice(0, 400), source: src });
    ex.text = m.description.slice(0, 3000);
  }
  if (m.phone) ex.phones.push({ value: normalizePhone(m.phone), source: src });
  if (m.email) ex.emails.push({ value: m.email.trim(), source: src });
  if (m.address) ex.addresses.push({ value: m.address.trim(), source: src });
  ex.title = m.name || "";
  ex.metaDescription = m.description || "";
  ex.footer = [m.name, m.phone, m.email, m.address].filter(Boolean).join(" ");
  return ex;
}

async function crawl(input: string, steps: string[]): Promise<Extracted> {
  let home = await fetchPage(input).catch(async (e) => {
    if (input.startsWith("https://")) return await fetchPage(input.replace(/^https:/, "http:"));
    throw e;
  });
  // follow JS / meta-refresh / frameset landing pages (up to 2 hops, same site only)
  for (let hop = 0; hop < 2; hop++) {
    const next = softRedirect(home.html, home.url);
    if (!next) break;
    try { home = await fetchPage(next); steps.push(`첫 화면이 다른 페이지로 넘겨서 따라감: ${home.url}`); } catch { break; }
  }
  const inputIsKakao = isKakaoChannelUrl(input) || isKakaoChannelUrl(home.url);
  steps.push(`${inputIsKakao ? "카카오톡 채널" : "홈페이지"} 읽음: ${home.url}`);
  const ex = extract(home.html, home.url);

  for (const sub of inputIsKakao ? [] : pickSubpages(home.html, home.url, 2)) {
    try {
      const page = await fetchPage(sub);
      mergeInto(ex, page.html, page.url, `하위페이지(${new URL(page.url).pathname})`);
      steps.push(`하위 페이지 읽음: ${page.url}`);
    } catch { steps.push(`하위 페이지 실패: ${sub}`); }
  }

  if (inputIsKakao) {
    applyKakao(ex, parseKakaoChannel(home.html, normalizeKakao(input) || home.url), "카카오톡 채널(입력)");
  } else if (ex.kakaoChannels[0]) {
    const ch = ex.kakaoChannels[0].value;
    try {
      const page = await fetchPage(ch);
      applyKakao(ex, parseKakaoChannel(page.html, ch), "카카오톡 채널 페이지");
      steps.push(`카카오톡 채널 읽음: ${ch}`);
    } catch {
      ex.kakao = { url: ch, name: "", description: "", image: "" };
      steps.push(`카카오톡 채널 링크 발견(페이지는 읽지 못함): ${ch}`);
    }
  } else {
    steps.push("카카오톡 채널 링크는 찾지 못했어요");
  }

  // Almost no readable content → treat as unreadable so the user can type the basics instead.
  if (ex.text.length < 80 && !ex.metaDescription && !ex.siteName.length && !inputIsKakao) {
    throw Object.assign(new Error("사이트 내용이 거의 없어요(자바스크립트로 그리는 사이트일 수 있어요)."), { code: "unreadable" });
  }
  return ex;
}

async function analyze(req: Request, body: Record<string, unknown>) {
  let input = String(body.url || "").trim();
  const manual = body.manual as Record<string, string> | undefined;
  if (!input && !manual?.name) return json(req, { error: "url을 보내 주세요." }, 400);
  if (input && !/^https?:\/\//i.test(input)) input = "https://" + input;
  if (!input) input = "https://example.invalid/";

  // Reserve the row BEFORE counting, so concurrent requests all see each other (the count includes this row).
  const ip = clientIp(req);
  const ipHash = await sha256(ip + SALT);
  const mode = manual?.name ? "manual" : "crawl";
  const reqId = await insert("rbc_requests", { input_url: input, ip_hash: ipHash, mode });
  const [mine, all] = reqId ? await Promise.all([recentCount(ipHash), recentCount()]) : [-1, -1];
  const overDb = (mine >= 0 && mine > HOURLY_LIMIT) || (all >= 0 && all > GLOBAL_HOURLY_LIMIT);
  const overMem = (mine < 0 && limited(`an:${ip}`, HOURLY_LIMIT)) || (all < 0 && limited("an:*", GLOBAL_HOURLY_LIMIT));
  if (overDb || overMem) {
    if (reqId) await update("rbc_requests", reqId, { error: "rate_limited" });
    if (all > GLOBAL_HOURLY_LIMIT) console.warn("global hourly limit reached", all);
    return tooMany(req);
  }

  const steps: string[] = [];
  const log = async (row: Record<string, unknown>) => {
    if (reqId) return (await update("rbc_requests", reqId, row)) ? reqId : null;
    return insert("rbc_requests", { input_url: input, ip_hash: ipHash, mode, ...row });
  };
  let ex: Extracted;
  try {
    if (manual?.name) {
      ex = manualExtract(input, manual);
      steps.push("직접 입력한 정보로 작성");
    } else {
      ex = await crawl(input, steps);
    }
  } catch (e) {
    const raw = (e as Error).message || "";
    const msg = /[가-힣]/.test(raw) ? raw : "사이트에 접속하지 못했어요(자동 접속 차단 또는 주소 오류).";
    await log({ ok: false, error: raw.slice(0, 300) });
    // code "unreadable": the screen offers manual input (brand name + 소개) instead of a dead end
    return json(req, { error: msg, code: "unreadable", steps }, 422);
  }

  let application;
  try {
    application = parseClaude(await askClaude(buildPrompt(ex)), ex);
    steps.push("Claude로 RBC·카카오톡 채널 신청 정보 작성 완료");
  } catch (e) {
    application = ruleApplication(ex);
    console.error("claude", (e as Error).message);
    steps.push(`규칙 기반으로 제안 (AI 미사용: ${(e as Error).message.slice(0, 400)})`);
  }
  if (input.includes("example.invalid")) { // manual input without any URL
    application.rbc.website = { value: "", source: "", verified: false };
    application.kakao.website = { value: "", source: "", verified: false };
    application.kakao.searchIds = application.kakao.searchIds.filter((x) => x !== "example");
    application.rbc.quickMenu = application.rbc.quickMenu.filter((b) => !b.value.includes("example.invalid"));
  }
  const extracted = { ...ex, text: ex.text.slice(0, 3000) };
  const requestId = await log({ ok: true, engine: application.engine, application, extracted });
  return json(req, { requestId, extracted, application, steps });
}

/** Image proxy so the page can redraw a site's logo on a canvas (cross-origin images can't be exported). */
async function proxyImage(req: Request, body: Record<string, unknown>) {
  if (limited(`img:${clientIp(req)}`, IMAGE_HOURLY_LIMIT)) return tooMany(req);
  const url = String(body.url || "");
  if (!isSafeUrl(url)) return json(req, { error: "허용되지 않는 주소예요." }, 400);
  try {
    // safeFetch re-checks every redirect hop, so a public URL can't bounce us into the private network.
    const { res } = await safeFetch(url, { accept: "image/*", timeoutMs: 8000, ua: "Mozilla/5.0 SureM-RBC-Profiler" });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !/^image\//i.test(ct)) { await res.body?.cancel(); return json(req, { error: "이미지를 가져오지 못했어요." }, 422); }
    const { buf, truncated } = await readLimited(res, 5_000_000);
    if (truncated) return json(req, { error: "이미지가 너무 커요(5MB 초과)." }, 422);
    return new Response(buf, { headers: { ...cors(req), "Content-Type": ct, "Cache-Control": "public, max-age=86400" } });
  } catch (e) {
    const msg = (e as Error).message;
    return json(req, { error: msg === "허용되지 않는 주소예요." ? msg : "이미지를 가져오지 못했어요." }, msg === "허용되지 않는 주소예요." ? 400 : 422);
  }
}

async function saveLead(req: Request, body: Record<string, unknown>) {
  const company = String(body.company || "").trim().slice(0, 100);
  const phone = String(body.phone || "").replace(/[^\d-]/g, "").slice(0, 20);
  if (!company || phone.replace(/\D/g, "").length < 9) return json(req, { error: "회사명과 연락처를 확인해 주세요." }, 400);
  if (body.agreed !== true) return json(req, { error: "개인정보 수집·이용에 동의해 주세요." }, 400);

  // Leads ride on an analysis (already rate-limited): it must exist, be recent, and carry only a few leads.
  const requestId = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId.toLowerCase() : null;
  if (limited(`lead:${clientIp(req)}`, 10)) return tooMany(req);
  if (requestId && dbEnabled) {
    const [found, leads] = await Promise.all([
      countRows("rbc_requests", `id=eq.${requestId}&ok=is.true&created_at=gte.${sinceParam(24 * 60)}`),
      countRows("rbc_leads", `request_id=eq.${requestId}`),
    ]);
    if (found === 0) return json(req, { error: "분석 결과가 만료됐어요. 홈페이지를 다시 분석한 뒤 신청해 주세요." }, 400);
    if (leads >= LEADS_PER_REQUEST) return tooMany(req);
  } else if (limited(`lead-noreq:${clientIp(req)}`, 3)) {
    return tooMany(req);
  }

  const id = await insert("rbc_leads", {
    request_id: requestId,
    company,
    contact_name: String(body.name || "").trim().slice(0, 50) || null,
    phone,
    email: String(body.email || "").trim().slice(0, 100) || null,
    wants: Array.isArray(body.wants) ? (body.wants as unknown[]).map(String).slice(0, 5) : [],
    agreed: true,
    final_application: body.application ?? null,
  });
  if (!id) return json(req, { error: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  return json(req, { ok: true, id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === "lead") return await saveLead(req, body);
    if (body.action === "image") return await proxyImage(req, body);
    return await analyze(req, body);
  } catch (e) {
    console.error(e);
    return json(req, { error: "처리 중 오류가 났어요." }, 500);
  }
});
