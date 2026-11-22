// Website → structured facts for an RCS Biz Center (RBC) brand profile.
// Dependency-free (regex based) so it runs on Deno (Supabase Edge) and Node.

export type Candidate = { value: string; source: string };
export type ImgKind = "logo" | "og" | "icon" | "kakao";

export type Extracted = {
  url: string;
  title: string;
  metaDescription: string;
  og: Record<string, string>;
  siteName: Candidate[];
  descriptions: Candidate[];
  phones: Candidate[];
  emails: Candidate[];
  addresses: Candidate[];
  images: { url: string; kind: ImgKind; source: string }[];
  socials: Candidate[];
  kakaoChannels: Candidate[]; // normalized https://pf.kakao.com/_xxxx
  kakaoIds: Candidate[]; // 카카오톡 채널 검색용 아이디 / 채널명 (e.g. @서울밝은치과)
  kakao?: { url: string; name: string; description: string; image: string }; // filled by reading the channel page
  hours: Candidate[];
  bizInfo: Candidate[]; // 상호, 대표, 사업자등록번호 lines from footer
  companyNames: Candidate[]; // 상호/법인명 (사업자등록증 상 업체명 후보)
  ceos: Candidate[];
  bizNos: Candidate[]; // 사업자등록번호 000-00-00000
  themeColors: Candidate[];
  jsonLd: Record<string, unknown>[];
  text: string; // visible body text (trimmed)
  footer: string;
};

/* ---------------- decoding ---------------- */

export function decodeHtml(buf: Uint8Array, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || "utf-8").toLowerCase();
  if (charset === "ks_c_5601-1987" || charset === "euc_kr" || charset === "cp949") charset = "euc-kr";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/* ---------------- helpers ---------------- */

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", copy: "©" };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function safeChar(c: number) {
  try { return String.fromCodePoint(c); } catch { return ""; }
}
const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}

function abs(u: string, base: string): string {
  try { return new URL(u, base).href; } catch { return ""; }
}

function pushUniq(arr: Candidate[], value: string, source: string, max = 6) {
  const v = value.trim();
  if (!v || arr.length >= max) return;
  const key = v.replace(/\D/g, "") || v;
  if (arr.some((c) => (c.value.replace(/\D/g, "") || c.value) === key)) return;
  arr.push({ value: v, source });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|dd|dt|address)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/* ---------------- patterns ---------------- */

// 1588-1234 style 대표번호, landline/mobile with separators. Separators required to cut false positives.
const PHONE_RE = /(?<![\d-])(?:\+82[-\s]?)?(1[5-9]\d{2}[-.\s]\d{4}|0\d{1,2}[-.)\s]\s?\d{3,4}[-.\s]\d{4})(?![\d-])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SIDO = "서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|충청북도|충청남도|전라북도|전라남도|경상북도|경상남도|전북특별자치도|강원특별자치도|제주특별자치도";
const ADDR_RE = new RegExp(`(?:${SIDO})[가-힣]*\\s+[가-힣]+(?:시|군|구)(?:\\s+[가-힣]+(?:구|시))?\\s+[가-힣0-9\\s.-]{1,30}?(?:로|길|동|읍|면|리)\\s*[0-9-]+(?:[^\\n|]{0,40})?`, "g");
const HOURS_RE = /(?:영업|운영|진료|상담|고객센터)\s*시간\s*[:：]?\s*[^\n]{4,60}/g;

export function normalizePhone(p: string): string {
  let d = p.replace(/^\+82[-\s]?/, "0").replace(/\D/g, "");
  if (/^1[5-9]\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4)}`;
  if (d.startsWith("02")) return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : `02-${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return p.trim();
}

function findPhones(text: string, source: string, out: Candidate[]) {
  let m;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/(팩스|fax|F\s*[.:)]|FAX)/i.test(before)) continue; // skip fax numbers
    pushUniq(out, normalizePhone(m[1]), source);
  }
}

/* ---------------- main extraction ---------------- */

export function extract(html: string, url: string): Extracted {
  const ex: Extracted = {
    url, title: "", metaDescription: "", og: {}, siteName: [], descriptions: [], phones: [], emails: [],
    addresses: [], images: [], socials: [], kakaoChannels: [], kakaoIds: [], hours: [], bizInfo: [], companyNames: [], ceos: [], bizNos: [], themeColors: [], jsonLd: [], text: "", footer: "",
  };
  mergeInto(ex, html, url, "홈페이지");
  return ex;
}

/** Add facts from another page (e.g. /about, /contact) of the same site. */
export function mergeInto(ex: Extracted, html: string, url: string, label: string) {
  const isMain = label === "홈페이지";
  const head = html.slice(0, 200_000);

  if (isMain) {
    ex.title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] || "");
  }

  // meta / og
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    const val = clean(a.content || "");
    if (!key || !val) continue;
    if (isMain && key === "description") ex.metaDescription = val;
    if (isMain && key.startsWith("og:")) ex.og[key.slice(3)] = val;
    if (key === "description" || key === "og:description") pushUniq(ex.descriptions, val, `${label} ${key}`);
    if (key === "og:site_name" || key === "application-name") pushUniq(ex.siteName, val, `${label} ${key}`);
    if (key === "og:image") addImage(ex, abs(val, url), "og", `${label} og:image`);
    if ((key === "theme-color" || key === "msapplication-tilecolor") && /^#[0-9a-f]{6}$/i.test(val)) pushUniq(ex.themeColors, val.toLowerCase(), `${label} ${key}`);
  }
  if (isMain && ex.title) pushUniq(ex.siteName, ex.title.split(/\s*[|\-–:·]\s*/)[0], "홈페이지 <title>");

  // icons / logos
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const rel = (a.rel || "").toLowerCase();
    if (/icon/.test(rel) && a.href) addImage(ex, abs(a.href, url), "icon", `${label} <link rel=${rel}>`);
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const hint = `${a.alt || ""} ${a.class || ""} ${a.id || ""} ${a.src || ""}`.toLowerCase();
    if (/logo|로고|\bci\b/.test(hint) && a.src && !a.src.startsWith("data:")) {
      addImage(ex, abs(a.src, url), "logo", `${label} <img ${a.alt ? `alt="${a.alt.slice(0, 20)}"` : "logo"}>`);
    }
  }

  // JSON-LD
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      walkLd(data, (o) => {
        const t = String(o["@type"] || "");
        if (!/Organization|LocalBusiness|Corporation|Store|Restaurant|Dentist|MedicalBusiness|Clinic|Hospital|WebSite|Brand/i.test(t)) return;
        ex.jsonLd.push(o);
        if (typeof o.name === "string") pushUniq(ex.siteName, clean(o.name), `${label} JSON-LD ${t}.name`);
        if (typeof o.legalName === "string") pushUniq(ex.companyNames, clean(o.legalName), `${label} JSON-LD legalName`);
        if (typeof o.taxID === "string" || typeof o.vatID === "string") addBizNo(ex, String(o.taxID || o.vatID), `${label} JSON-LD taxID`);
        if (typeof o.description === "string") pushUniq(ex.descriptions, clean(o.description), `${label} JSON-LD ${t}.description`);
        if (typeof o.telephone === "string") pushUniq(ex.phones, normalizePhone(o.telephone), `${label} JSON-LD telephone`);
        if (typeof o.email === "string") pushUniq(ex.emails, o.email.replace(/^mailto:/, ""), `${label} JSON-LD email`);
        const logo = typeof o.logo === "string" ? o.logo : (o.logo as Record<string, string> | undefined)?.url;
        if (logo) addImage(ex, abs(logo, url), "logo", `${label} JSON-LD logo`);
        const ad = o.address as Record<string, string> | string | undefined;
        if (typeof ad === "string") pushUniq(ex.addresses, clean(ad), `${label} JSON-LD address`);
        else if (ad) {
          const s = [ad.addressRegion, ad.addressLocality, ad.streetAddress].filter(Boolean).join(" ");
          if (s) pushUniq(ex.addresses, clean(s), `${label} JSON-LD address`);
        }
        if (o.openingHours) pushUniq(ex.hours, clean(String(o.openingHours)), `${label} JSON-LD openingHours`);
        const same = Array.isArray(o.sameAs) ? o.sameAs : [];
        for (const s of same) if (typeof s === "string") {
          const k = normalizeKakao(s);
          if (k) pushUniq(ex.kakaoChannels, k, `${label} JSON-LD sameAs`);
          else pushUniq(ex.socials, s, `${label} JSON-LD sameAs`, 8);
        }
      });
    } catch { /* ignore broken JSON-LD */ }
  }

  // links: tel:, mailto:, socials
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = decodeEntities(m[1]).trim();
    if (/^tel:/i.test(href)) pushUniq(ex.phones, normalizePhone(href.slice(4)), `${label} tel: 링크`);
    else if (/^mailto:/i.test(href)) pushUniq(ex.emails, href.slice(7).split("?")[0], `${label} mailto: 링크`);
    else if (normalizeKakao(href)) pushUniq(ex.kakaoChannels, normalizeKakao(href), `${label} 카카오톡 채널 링크`);
    else if (/(instagram\.com|blog\.naver\.com|youtube\.com|facebook\.com|place\.naver\.com|naver\.me|map\.kakao\.com|open\.kakao\.com)/i.test(href)) {
      pushUniq(ex.socials, abs(href, url), `${label} 링크`, 8);
    }
  }

  // Kakao channel URLs anywhere in the HTML (scripts, onclick, floating buttons)
  for (const m of html.matchAll(/pf\.kakao\.com\/(_[A-Za-z0-9]{3,20})/g)) {
    pushUniq(ex.kakaoChannels, `https://pf.kakao.com/${m[1]}`, `${label} 카카오톡 채널 링크`);
  }

  // visible text, footer
  const footerHtml = [...html.matchAll(/<footer\b[\s\S]*?<\/footer>/gi)].map((x) => x[0]).join("\n") ||
    (/<(div|section)[^>]+(?:id|class)=["'][^"']*(footer|ft_|bottom)[^"']*["'][\s\S]{0,8000}/i.exec(html)?.[0] || "");
  const footer = htmlToText(footerHtml).slice(0, 2000);
  const text = htmlToText(/<body[\s\S]*<\/body>/i.exec(html)?.[0] || html);
  if (isMain) { ex.text = text.slice(0, 6000); ex.footer = footer; }
  else ex.text = (ex.text + `\n\n[${label}]\n` + text.slice(0, 2500)).slice(0, 9000);
  if (!ex.footer && footer) ex.footer = footer;

  // footer first: it usually holds the official 대표번호/주소
  for (const [src, body] of [[`${label} 하단(footer)`, footer], [`${label} 본문`, text]] as const) {
    findPhones(body, src, ex.phones);
    for (const e of body.match(EMAIL_RE) || []) {
      if (/\.(png|jpe?g|gif|webp|svg)$/i.test(e) || /example\.|sentry|wixpress/i.test(e)) continue;
      pushUniq(ex.emails, e, src);
    }
    for (const a of body.match(ADDR_RE) || []) {
      const cut = a.split(/\s*(?:\||\/|·|고객\s*센터|대표\s*번호|대표|tel|전화|팩스|fax|사업자|이메일|e-?mail|copyright|ⓒ|©|건강기능식품|판매업|통신판매|신고\s*번호|허가|개인정보|호스팅|영업\s*신고)/i)[0];
      pushUniq(ex.addresses, cut.replace(/\s+/g, " ").replace(/[,.\s]+$/, "").trim(), src, 4);
    }
    for (const h of body.match(HOURS_RE) || []) pushUniq(ex.hours, h.trim(), src, 3);
  }
  for (const body of [footer, text]) findKakaoIds(body, `${label} ${body === footer ? "하단(footer)" : "본문"}`, ex.kakaoIds);
  for (const [src, body] of [[`${label} 하단(footer)`, footer], [`${label} 본문`, text.slice(-3000)]] as const) findBusiness(body, src, ex);
  for (const line of footer.split("\n")) {
    if (/(상호|회사명|대표(?!번호)|사업자\s*등록|통신판매)/.test(line) && line.length < 200) pushUniq(ex.bizInfo, line.trim(), `${label} 하단(footer)`, 6);
  }
}

export function addImage(ex: Extracted, u: string, kind: ImgKind, source: string) {
  if (!u || ex.images.some((i) => i.url === u) || ex.images.length >= 10) return;
  ex.images.push({ url: u, kind, source });
}

function walkLd(node: unknown, fn: (o: Record<string, unknown>) => void, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) return node.forEach((n) => walkLd(n, fn, depth + 1));
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["@type"]) fn(o);
    for (const k of ["@graph", "publisher", "author", "brand", "provider", "mainEntity"]) walkLd(o[k], fn, depth + 1);
  }
}

/* ---------------- business info (사업자 정보) ---------------- */

function addBizNo(ex: Extracted, raw: string, source: string) {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) pushUniq(ex.bizNos, `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`, source, 3);
}
const COMPANY_LABEL_RE = /(?:상호(?:명)?|회사명|법인명|업체명|사업자명)\s*[:：]?\s*([^\n|,/·]{2,30})/g;
const CORP_RE = /(?:\(주\)|㈜|주식회사|\(유\)|유한회사)\s*[가-힣A-Za-z0-9&]{2,20}|[가-힣][가-힣0-9&]{1,19}\s*(?:\(주\)|㈜|주식회사)/g;
const CEO_RE = /대표\s*(?:자|이사)?\s*(?:명|성명)?(?!\s*(?:번호|전화|메일|이메일|홈|문의|상품|이미지))\s*[:：]?\s*([가-힣]{2,4}|[A-Z][a-z]+ [A-Z][a-z]+)(?=[\s|,/·)]|$)/g;
const BIZNO_RE = /사업자\s*(?:등록)?\s*(?:번호)?\s*[:：]?\s*(\d{3}\s*-?\s*\d{2}\s*-?\s*\d{5})/g;

function findBusiness(text: string, source: string, ex: Extracted) {
  for (const m of text.matchAll(BIZNO_RE)) addBizNo(ex, m[1], source);
  for (const m of text.matchAll(COMPANY_LABEL_RE)) {
    const v = m[1].replace(/\s*(대표|사업자|주소|tel|전화).*$/i, "").trim();
    if (v.length >= 2) pushUniq(ex.companyNames, v, source, 4);
  }
  for (const m of text.matchAll(CORP_RE)) pushUniq(ex.companyNames, m[0].trim(), source, 4);
  for (const m of text.matchAll(CEO_RE)) {
    if (!/^(번호|전화|이사|메일)$/.test(m[1])) pushUniq(ex.ceos, m[1], source, 2);
  }
}

/* ---------------- Kakao channel ---------------- */

/** pf.kakao.com/_abc, pf.kakao.com/_abc/chat, /friend, /posts → https://pf.kakao.com/_abc ; else "" */
export function normalizeKakao(u: string): string {
  const m = /^(?:https?:\/\/)?pf\.kakao\.com\/(_[A-Za-z0-9]{3,20})/i.exec(u.trim());
  return m ? `https://pf.kakao.com/${m[1]}` : "";
}
export function isKakaoChannelUrl(u: string): boolean {
  return !!normalizeKakao(u);
}

const KAKAO_ID_RE = /카카오\s*톡?\s*(?:채널|플러스\s*친구|플친|상담|ID|아이디)\s*[:：]?\s*(@[가-힣A-Za-z0-9_.\-]{2,30})/gi;
const KAKAO_SEARCH_RE = /카카오\s*톡?(?:\s*채널)?(?:에서)?\s*['"“‘「]([^'"”’」\n]{2,30})['"”’」]\s*(?:을|를)?\s*검색/g;
function findKakaoIds(text: string, source: string, out: Candidate[]) {
  for (const m of text.matchAll(KAKAO_ID_RE)) pushUniq(out, m[1], source, 3);
  for (const m of text.matchAll(KAKAO_SEARCH_RE)) pushUniq(out, m[1].trim(), source, 3);
}

/** Read a Kakao channel page's meta tags (og:title/description/image). Best effort. */
export function parseKakaoChannel(html: string, url: string) {
  const meta: Record<string, string> = {};
  for (const tag of html.slice(0, 100_000).match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const key = (a.property || a.name || "").toLowerCase();
    if (key && a.content) meta[key] = clean(a.content);
  }
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
  const name = (meta["og:title"] || title).replace(/\s*[|\-–]\s*카카오.*$/, "").trim();
  return {
    url: normalizeKakao(url) || url,
    name: name === "카카오톡 채널" ? "" : name,
    description: meta["og:description"] || meta["description"] || "",
    image: meta["og:image"] ? abs(meta["og:image"], url) : "",
  };
}

/* ---------------- crawling helpers ---------------- */

/** Pick up to `max` same-site pages likely to hold company/contact info. */
export function pickSubpages(html: string, baseUrl: string, max = 2): string[] {
  const base = new URL(baseUrl);
  const scored: { u: string; s: number }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = abs(decodeEntities(m[1]), baseUrl);
    if (!u) continue;
    let p: URL;
    try { p = new URL(u); } catch { continue; }
    if (p.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    if (p.href.split("#")[0] === base.href.split("#")[0]) continue;
    if (/\.(pdf|jpg|png|zip|hwp|docx?)$/i.test(p.pathname)) continue;
    const label = htmlToText(m[2]).slice(0, 40) + " " + p.pathname;
    let s = 0;
    if (/(회사\s*소개|기업\s*소개|about|company|intro|브랜드\s*소개|병원\s*소개|인사말|greeting)/i.test(label)) s += 3;
    if (/(오시는\s*길|찾아오시는|contact|location|map|위치|연락처|고객\s*센터)/i.test(label)) s += 2;
    if (s && !scored.some((x) => x.u === p.href)) scored.push({ u: p.href, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.u);
}

/** Block non-http(s), localhost and private/link-local IP literals (SSRF guard). */
export function isSafeUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return false;
  return !isPrivateIp(h);
}

export function isPrivateIp(h: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c] = [+v4[1], +v4[2], +v4[3]];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 ||
      (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0); // benchmark, IETF special-use
  }
  if (h.includes(":")) {
    // ::/x (loopback, unspecified, v4-mapped/compatible), ULA, link-local, NAT64 and 6to4 can all reach private v4.
    return h.startsWith("::") || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^64:ff9b:/.test(h) || /^2002:/.test(h);
  }
  return false;
}
