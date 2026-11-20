// Supabase Edge Function
//   POST { url }                         → { requestId, extracted, application, steps }
//   POST { url, manual:{name,description,phone?,email?} } → same, from typed-in info (site unreadable)
//   POST { action:"lead", requestId, company, phone, agreed:true, ... } → saves a 상담 신청
// Reads a website (home + up to 2 about/contact pages, linked Kakao channel) and drafts
// the RCS Biz Center brand application and the KakaoTalk channel application.
import { addImage, decodeHtml, extract, isKakaoChannelUrl, isPrivateIp, isSafeUrl, mergeInto, normalizeKakao, normalizePhone, parseKakaoChannel, pickSubpages } from "./extract.ts";
import type { Extracted } from "./extract.ts";
import { buildPrompt, parseClaude, ruleApplication } from "./profile.ts";
import { insert, recentCount, sha256 } from "./db.ts";

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

/* --- tiny in-memory rate limit (per instance) --- */
const hits = new Map<string, number[]>();
function limited(ip: string, max = 20, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

async function resolvesPublic(host: string): Promise<boolean> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return !isPrivateIp(host);
  try {
    const ips = [...(await Deno.resolveDns(host, "A").catch(() => [])), ...(await Deno.resolveDns(host, "AAAA").catch(() => []))];
    return ips.length === 0 || ips.every((ip) => !isPrivateIp(ip.toLowerCase()));
  } catch {
    return true; // DNS API unavailable: hostname checks already applied
  }
}

/** Fetch a page safely: http(s) only, public hosts only, manual redirects (max 4), size + time limits. */
async function fetchPage(raw: string): Promise<{ url: string; html: string }> {
  let url = raw;
  for (let i = 0; i < 5; i++) {
    if (!isSafeUrl(url) || !(await resolvesPublic(new URL(url).hostname))) throw new Error("허용되지 않는 주소예요.");
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(9000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 SureM-RBC-Profiler",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).href;
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) throw new Error(`사이트가 응답하지 않아요 (HTTP ${res.status}).`);
    const ct = res.headers.get("content-type");
    if (ct && /^(image|video|audio|font)\/|application\/(pdf|zip|json)/i.test(ct)) throw new Error("HTML 페이지가 아니에요.");
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX_BYTES) { await reader.cancel(); break; }
    }
    const buf = new Uint8Array(size > MAX_BYTES ? MAX_BYTES : size);
    let off = 0;
    for (const c of chunks) { const n = Math.min(c.length, buf.length - off); buf.set(c.subarray(0, n), off); off += n; if (off >= buf.length) break; }
    return { url, html: decodeHtml(buf, ct) };
  }
  throw new Error("리다이렉트가 너무 많아요.");
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
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
const SALT = Deno.env.get("IP_SALT") || "surem-rbc";

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
  const home = await fetchPage(input).catch(async (e) => {
    if (input.startsWith("https://")) return await fetchPage(input.replace(/^https:/, "http:"));
    throw e;
  });
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
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const ipHash = await sha256(ip + SALT);
  const n = await recentCount(ipHash);
  if ((n >= 0 && n >= HOURLY_LIMIT) || (n < 0 && limited(ip, HOURLY_LIMIT))) {
    return json(req, { error: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요." }, 429);
  }

  let input = String(body.url || "").trim();
  const manual = body.manual as Record<string, string> | undefined;
  if (!input && !manual?.name) return json(req, { error: "url을 보내 주세요." }, 400);
  if (input && !/^https?:\/\//i.test(input)) input = "https://" + input;
  if (!input) input = "https://example.invalid/";

  const steps: string[] = [];
  const log = (row: Record<string, unknown>) => insert("rbc_requests", { input_url: input, ip_hash: ipHash, ...row });
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
    await log({ mode: "crawl", ok: false, error: raw.slice(0, 300) });
    // code "unreadable": the screen offers manual input (brand name + 소개) instead of a dead end
    return json(req, { error: msg, code: "unreadable", steps }, 422);
  }

  let application;
  try {
    application = parseClaude(await askClaude(buildPrompt(ex)), ex);
    steps.push("Claude로 RBC·카카오톡 채널 신청 정보 작성 완료");
  } catch (e) {
    application = ruleApplication(ex);
    steps.push(`규칙 기반으로 제안 (AI 미사용: ${(e as Error).message.slice(0, 80)})`);
  }
  if (input.includes("example.invalid")) { // manual input without any URL
    application.rbc.website = { value: "", source: "", verified: false };
    application.kakao.website = { value: "", source: "", verified: false };
    application.kakao.searchIds = application.kakao.searchIds.filter((x) => x !== "example");
    application.rbc.quickMenu = application.rbc.quickMenu.filter((b) => !b.value.includes("example.invalid"));
  }
  const extracted = { ...ex, text: ex.text.slice(0, 3000) };
  const requestId = await log({ mode: manual?.name ? "manual" : "crawl", ok: true, engine: application.engine, application, extracted });
  return json(req, { requestId, extracted, application, steps });
}

async function saveLead(req: Request, body: Record<string, unknown>) {
  const company = String(body.company || "").trim().slice(0, 100);
  const phone = String(body.phone || "").replace(/[^\d-]/g, "").slice(0, 20);
  if (!company || phone.replace(/\D/g, "").length < 9) return json(req, { error: "회사명과 연락처를 확인해 주세요." }, 400);
  if (body.agreed !== true) return json(req, { error: "개인정보 수집·이용에 동의해 주세요." }, 400);
  const id = await insert("rbc_leads", {
    request_id: typeof body.requestId === "string" && /^[0-9a-f-]{36}$/.test(body.requestId) ? body.requestId : null,
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
    return await analyze(req, body);
  } catch (e) {
    console.error(e);
    return json(req, { error: "처리 중 오류가 났어요." }, 500);
  }
});
