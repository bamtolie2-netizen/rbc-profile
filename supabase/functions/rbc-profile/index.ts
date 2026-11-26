// Supabase Edge Function
//   POST { url }                         → { requestId, extracted, application, steps }
//   POST { url, manual:{name,description,phone?,email?} } → same, from typed-in info (site unreadable)
//   POST { action:"lead", requestId, company, phone, agreed:true, ... } → saves a 상담 신청
//   POST { action:"card", image:"data:image/jpeg;base64,…" } → fields read off a 명함/간판 photo (Claude vision)
//   POST { action:"messages", requestId, brand:{…}, purpose?, tone?, kind? } → 3 fresh message drafts
// Any URL works: homepage, 네이버 플레이스(naver.me), 카카오맵, 카카오톡 채널, 블로그, 인스타그램.
// Reads a website (home + up to 2 about/contact pages, linked Kakao channel) and drafts
// the RCS Biz Center brand application and the KakaoTalk channel application.
import { addImage, decodeHtml, extract, isKakaoChannelUrl, isPrivateIp, isSafeUrl, mergeInto, normalizeKakao, normalizePhone, parseKakaoChannel, pickSubpages, softRedirect } from "./extract.ts";
import type { Extracted } from "./extract.ts";
import { buildMessagePrompt, buildPrompt, CARD_PROMPT, cleanMessages, parseClaude, ruleApplication } from "./profile.ts";
import type { BrandBrief } from "./profile.ts";
import { applyCard, applyPlace, placeExtract, placeKind, readPlace, rewriteUrl } from "./places.ts";
import type { CardInfo } from "./places.ts";
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
async function safeFetch(raw: string, init: { accept: string; timeoutMs: number; ua: string; headers?: Record<string, string> }): Promise<{ url: string; res: Response }> {
  let url = raw;
  for (let i = 0; i < 5; i++) {
    if (!isSafeUrl(url) || !(await resolvesPublic(new URL(url).hostname))) throw new Error("허용되지 않는 주소예요.");
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs),
      headers: { "User-Agent": init.ua, "Accept": init.accept, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5", ...(init.headers || {}) },
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

/** Fetch a small JSON document through the same SSRF guard (place APIs). */
async function fetchJson(raw: string, headers?: Record<string, string>): Promise<unknown> {
  const { res } = await safeFetch(raw, { accept: "application/json", timeoutMs: 8000, ua: PAGE_UA, headers });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
  const { buf, truncated } = await readLimited(res, 1_000_000);
  if (truncated) throw new Error("too large");
  return JSON.parse(new TextDecoder().decode(buf));
}

type Content = string | ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } })[];
const aiOn = () => !!Deno.env.get("ANTHROPIC_API_KEY");

async function askClaude(prompt: Content, maxTokens = 4000): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(55000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
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
  if (placeKind(input)) return await crawlPlace(input, steps);
  input = rewriteUrl(input);
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

/** 네이버 플레이스 / 카카오맵: read the place; if it lists a homepage, read that too and put place facts first. */
async function crawlPlace(input: string, steps: string[]): Promise<Extracted> {
  const label = placeKind(input) === "kakao" ? "카카오맵" : "네이버 플레이스";
  let p;
  try {
    p = await readPlace(input, { fetchPage, fetchJson });
  } catch (e) {
    const raw = (e as Error).message || "";
    throw Object.assign(new Error(/[가-힣]/.test(raw) ? raw : `${label} 정보를 읽지 못했어요.`), { code: "unreadable" });
  }
  steps.push(`${label} 읽음: ${p.name}${p.category ? ` (${p.category})` : ""}`);
  if (p.homepage) {
    try {
      const ex = await crawl(p.homepage, steps);
      applyPlace(ex, p);
      steps.push(`${label}에 등록된 홈페이지도 읽음: ${p.homepage}`);
      return ex;
    } catch { steps.push(`${label}에 등록된 홈페이지는 읽지 못했어요: ${p.homepage}`); }
  }
  if (!p.phone && p.virtualPhone) steps.push("대표 전화가 0507 안심번호뿐이에요. 실제 매장 번호로 바꿔 주세요");
  return placeExtract(p);
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

  if (body.card && typeof body.card === "object") { applyCard(ex, cleanCard(body.card)); steps.push("명함에서 읽은 정보도 반영"); }

  let application;
  try {
    application = parseClaude(await askClaude(buildPrompt(ex)), ex);
    steps.push("AI로 RBC·카카오톡 채널 신청 정보와 메시지 초안 작성 완료");
  } catch (e) {
    application = ruleApplication(ex);
    console.error("claude", (e as Error).message); // details stay in the server log, not on the customer's screen
    steps.push("기본 규칙으로 작성했어요 (AI 문구 다듬기는 꺼져 있어요)");
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

const CARD_HOURLY_LIMIT = Number(Deno.env.get("CARD_HOURLY_LIMIT") || 15);
const MSG_HOURLY_LIMIT = Number(Deno.env.get("MSG_HOURLY_LIMIT") || 30);
const CARD_KEYS = ["name", "company", "ceo", "bizNo", "phone", "mobile", "email", "address", "website", "category", "slogan"] as const;
function cleanCard(raw: unknown): CardInfo {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: CardInfo = {};
  for (const k of CARD_KEYS) { const v = String(o[k] ?? "").replace(/\s+/g, " ").trim().slice(0, 120); if (v) out[k] = v; }
  return out;
}

/** 명함·간판 사진 → fields. The page resizes the photo first (≤1600px JPEG), so the payload stays small. */
async function readCard(req: Request, body: Record<string, unknown>) {
  if (!aiOn()) return json(req, { error: "명함 자동 읽기는 AI 연결 후 켜져요. 내용을 직접 입력해 주세요.", code: "ai_off" }, 503);
  const ip = clientIp(req);
  if (limited(`card:${ip}`, CARD_HOURLY_LIMIT) || limited("card:*", GLOBAL_HOURLY_LIMIT)) return tooMany(req);
  const m = String(body.image || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return json(req, { error: "사진 파일(JPG·PNG)만 올려 주세요." }, 400);
  if (m[2].length > 2_800_000) return json(req, { error: "사진이 너무 커요. 2MB 이하로 올려 주세요." }, 413);
  try {
    const text = await askClaude([
      { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
      { type: "text", text: CARD_PROMPT },
    ], 800);
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const card = cleanCard(j);
    if (!Object.keys(card).length) return json(req, { error: "사진에서 글자를 읽지 못했어요. 더 밝고 반듯하게 찍어 주세요.", code: "unreadable" }, 422);
    if (card.website && !/^https?:\/\//i.test(card.website)) card.website = "https://" + card.website.replace(/^\/+/, "");
    return json(req, { card });
  } catch (e) {
    console.error("card", (e as Error).message);
    return json(req, { error: "명함을 읽지 못했어요. 내용을 직접 입력해 주세요.", code: "ai_off" }, 503);
  }
}

/** "AI로 다시 쓰기": fresh drafts for a purpose and tone. Rides on a recent analysis like leads do. */
async function rewriteMessages(req: Request, body: Record<string, unknown>) {
  if (!aiOn()) return json(req, { error: "AI 다시 쓰기는 AI 연결 후 켜져요.", code: "ai_off" }, 503);
  const ip = clientIp(req);
  const requestId = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId.toLowerCase() : null;
  if (limited(`msg:${ip}`, MSG_HOURLY_LIMIT) || limited("msg:*", GLOBAL_HOURLY_LIMIT) || (requestId && limited(`msg:${requestId}`, 12))) return tooMany(req);
  if (dbEnabled) {
    if (!requestId) return json(req, { error: "먼저 업체 정보를 불러와 주세요." }, 400);
    const found = await countRows("rbc_requests", `id=eq.${requestId}&ok=is.true&created_at=gte.${sinceParam(24 * 60)}`);
    if (found === 0) return json(req, { error: "분석 결과가 만료됐어요. 다시 불러와 주세요." }, 400);
  }
  const b = (body.brand && typeof body.brand === "object" ? body.brand : {}) as Record<string, unknown>;
  const s = (k: string, n = 120) => String(b[k] ?? "").trim().slice(0, n);
  const brand: BrandBrief = { name: s("name", 40), description: s("description", 300), category: s("category", 60), phone: s("phone", 20), website: s("website", 200), address: s("address", 120), kakao: s("kakao", 120) };
  if (!brand.name) return json(req, { error: "브랜드명이 필요해요." }, 400);
  const opts = { purpose: String(body.purpose || "").trim().slice(0, 80), tone: String(body.tone || "friendly"), kind: String(body.kind || "") };
  try {
    const text = await askClaude(buildMessagePrompt(brand, opts), 2500);
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const messages = cleanMessages(j.messages, { site: brand.website, phones: brand.phone ? [brand.phone] : [], kakao: brand.kakao ? [brand.kakao] : [], fallbackUrl: brand.website });
    if (!messages) throw new Error("no messages");
    return json(req, { messages });
  } catch (e) {
    console.error("messages", (e as Error).message);
    return json(req, { error: "지금은 AI 초안을 만들지 못했어요. 잠시 후 다시 눌러 주세요." }, 502);
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
    // 마케팅 수신 동의(선택)는 스키마 변경 없이 wants에 "marketing_ok"로, 동의 시각은 final_application.consent에 남겨요.
    wants: [...(Array.isArray(body.wants) ? (body.wants as unknown[]).map(String).filter((w) => w !== "marketing_ok").slice(0, 5) : []), ...(body.marketing === true ? ["marketing_ok"] : [])],
    agreed: true,
    final_application: { ...(body.application && typeof body.application === "object" ? body.application as Record<string, unknown> : {}), consent: { privacy: true, marketing: body.marketing === true, at: new Date().toISOString() } },
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
    if (body.action === "card") return await readCard(req, body);
    if (body.action === "messages") return await rewriteMessages(req, body);
    return await analyze(req, body);
  } catch (e) {
    console.error(e);
    return json(req, { error: "처리 중 오류가 났어요." }, 500);
  }
});
