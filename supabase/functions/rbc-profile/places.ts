// Place pages (네이버 플레이스 · 카카오맵) for small businesses without a homepage.
// Best effort: both services change their markup/APIs often, so every step falls back quietly
// to whatever the page's og: tags give, and the caller falls back to manual input.
import { addImage, extract, normalizePhone } from "./extract.ts";
import type { Extracted } from "./extract.ts";

export type PlaceInfo = {
  provider: "naver" | "kakao";
  placeUrl: string;
  name: string; category: string; address: string; phone: string; virtualPhone: string;
  description: string; homepage: string; image: string; hours: string;
};
export type PlaceDeps = {
  fetchPage: (u: string) => Promise<{ url: string; html: string }>;
  fetchJson: (u: string, headers?: Record<string, string>) => Promise<unknown>;
};

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

/** Which place service a URL belongs to (short links included), or "" for an ordinary site. */
export function placeKind(u: string): "naver" | "kakao" | "" {
  const h = host(u);
  if (/(^|\.)naver\.me$/.test(h) || /(^|\.)map\.naver\.com$/.test(h) || /(^|\.)place\.naver\.com$/.test(h)) return "naver";
  if (/(^|\.)place\.map\.kakao\.com$/.test(h) || h === "kko.to" || (/(^|\.)map\.kakao\.com$/.test(h) && /itemId=\d+/.test(u))) return "kakao";
  return "";
}

/** blog.naver.com is a frameset; the mobile page carries the real text. */
export function rewriteUrl(u: string): string {
  const m = u.match(/^https?:\/\/(?:www\.)?blog\.naver\.com\/([^/?#]+)(?:\/(\d+))?/i);
  if (m) return `https://m.blog.naver.com/${m[1]}${m[2] ? "/" + m[2] : ""}`;
  return u;
}

const naverId = (u: string) =>
  u.match(/(?:place|restaurant|hairshop|hospital|accommodation|cafe|attraction|nailshop|beauty|shopping)\/(\d{5,})/)?.[1] ||
  u.match(/[?&](?:id|placeId|place)=(\d{5,})/)?.[1] || "";
const kakaoId = (u: string) => u.match(/place\.map\.kakao\.com\/(?:m\/)?(\d{4,})/)?.[1] || u.match(/itemId=(\d{4,})/)?.[1] || "";

const metaOf = (html: string, prop: string) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ||
  html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"))?.[1] || "";

/** Pull the JSON object assigned to `marker` in an inline script, by bracket matching. */
function inlineJson(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length && i < start + 3_000_000; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

/** First non-empty string under any of `keys`, searching breadth-first. */
function deep(obj: unknown, keys: string[], test: (s: string) => boolean = (s) => !!s.trim()): string {
  const q: unknown[] = [obj];
  for (let n = 0; q.length && n < 20000; n++) {
    const o = q.shift();
    if (!o || typeof o !== "object") continue;
    for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if (typeof v === "string" && test(v)) return v.trim(); }
    for (const v of Object.values(o as Record<string, unknown>)) if (v && typeof v === "object") q.push(v);
  }
  return "";
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
// a place's own homepage (blogs and smart stores count); not map/place pages or social profiles
const isExternalSite = (u: string) => /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}/i.test(u) && !/(map|place|m\.place|pcmap\.place|booking)\.naver\.com|naver\.me|map\.kakao\.com|kko\.to|pstatic\.net|kakaocdn\.net|instagram\.com|facebook\.com|youtube\.com/i.test(u);

async function readNaver(input: string, deps: PlaceDeps): Promise<PlaceInfo> {
  let id = naverId(input);
  if (!id) { // naver.me short link or a map URL without the id: follow it
    const page = await deps.fetchPage(input);
    id = naverId(page.url) || naverId(page.html);
  }
  if (!id) throw new Error("네이버 플레이스 주소에서 업체 번호를 찾지 못했어요. 플레이스 화면의 '공유 → 링크 복사' 주소를 넣어 주세요.");
  const placeUrl = `https://m.place.naver.com/place/${id}/home`;
  const { html } = await deps.fetchPage(placeUrl);
  const st = inlineJson(html, "__APOLLO_STATE__");
  // the detail object is keyed "PlaceDetailBase:<id>" in the Apollo cache
  let base: unknown = null;
  if (st && typeof st === "object") {
    for (const [k, v] of Object.entries(st as Record<string, unknown>)) if (/^PlaceDetailBase:/.test(k)) { base = v; break; }
  }
  const src = base || st;
  const ogTitle = decode(metaOf(html, "og:title")).replace(/\s*[:：|-]\s*네이버.*$/, "").trim();
  const phoneOk = (s: string) => /\d{2,4}-?\d{3,4}-?\d{4}/.test(s);
  return {
    provider: "naver", placeUrl,
    name: deep(src, ["name"]) || ogTitle,
    category: deep(src, ["category"]),
    address: deep(src, ["roadAddress"]) || deep(src, ["address"]),
    phone: deep(src, ["phone"], phoneOk),
    virtualPhone: deep(src, ["virtualPhone"], phoneOk),
    description: deep(st, ["description", "microReview"], (s) => s.trim().length >= 10).slice(0, 400) || decode(metaOf(html, "og:description")),
    homepage: deep(st, ["url"], isExternalSite),
    image: decode(metaOf(html, "og:image")),
    hours: deep(st, ["businessHours", "description"], (s) => /\d{1,2}:\d{2}/.test(s)).slice(0, 120),
  };
}

async function readKakao(input: string, deps: PlaceDeps): Promise<PlaceInfo> {
  let id = kakaoId(input), html = "";
  if (!id) { const page = await deps.fetchPage(input); id = kakaoId(page.url) || kakaoId(page.html); html = page.html; }
  if (!id) throw new Error("카카오맵 주소에서 장소 번호를 찾지 못했어요. 카카오맵 '공유 → 링크 복사' 주소를 넣어 주세요.");
  const placeUrl = `https://place.map.kakao.com/${id}`;
  // older public JSON first, then the newer panel API; either may be gone — og: tags are the floor
  let j: unknown = null;
  for (const [u, h] of [
    [`https://place.map.kakao.com/main/v/${id}`, {}],
    [`https://place-api.map.kakao.com/places/panel3/${id}`, { pf: "web", Referer: "https://place.map.kakao.com/" }],
  ] as [string, Record<string, string>][]) {
    try { j = await deps.fetchJson(u, h); if (j && typeof j === "object") break; } catch { /* next */ }
  }
  if (!html) { try { html = (await deps.fetchPage(placeUrl)).html; } catch { /* json only */ } }
  const b = (j as Record<string, unknown>)?.basicInfo as Record<string, unknown> | undefined;
  const addrObj = b?.address as Record<string, Record<string, string>> | undefined;
  const oldAddr = addrObj ? [addrObj.region?.newaddrfullname, addrObj.newaddr?.newaddrfull, addrObj.addrdetail].filter(Boolean).join(" ") : "";
  return {
    provider: "kakao", placeUrl,
    name: deep(j, ["placenamefull", "place_name", "name"]) || decode(metaOf(html, "og:title")).replace(/\s*[|-]\s*카카오맵.*$/, ""),
    category: deep(j, ["catename", "category_name", "cate1name"]),
    address: oldAddr || deep(j, ["road_address", "roadAddress", "address_name", "address"]) || "",
    phone: deep(j, ["phonenum", "tel", "phone"], (s) => /\d{2,4}-?\d{3,4}-?\d{4}/.test(s)),
    virtualPhone: "",
    description: deep(j, ["introduction", "desc", "description"], (s) => s.trim().length >= 10).slice(0, 400) || decode(metaOf(html, "og:description")),
    homepage: deep(j, ["homepage", "homepage_url", "url"], isExternalSite),
    image: deep(j, ["mainphotourl", "main_photo_url"]) || decode(metaOf(html, "og:image")),
    hours: "",
  };
}

export async function readPlace(input: string, deps: PlaceDeps): Promise<PlaceInfo> {
  const info = placeKind(input) === "kakao" ? await readKakao(input, deps) : await readNaver(input, deps);
  if (!info.name) throw new Error(`${info.provider === "naver" ? "네이버 플레이스" : "카카오맵"}에서 업체 정보를 읽지 못했어요.`);
  if (info.homepage && !/^https?:\/\//i.test(info.homepage)) info.homepage = "https://" + info.homepage;
  return info;
}

/** Put place facts into an Extracted (place candidates go first: small businesses are known by their place name). */
export function applyPlace(ex: Extracted, p: PlaceInfo) {
  const src = p.provider === "naver" ? "네이버 플레이스" : "카카오맵";
  const first = (arr: { value: string; source: string }[], v: string, s = src) => {
    if (!v) return;
    const i = arr.findIndex((c) => c.value.replace(/\s/g, "") === v.replace(/\s/g, ""));
    if (i >= 0) arr.splice(i, 1);
    arr.unshift({ value: v, source: s });
  };
  first(ex.siteName, p.name);
  if (p.description) ex.descriptions.push({ value: p.description, source: `${src} 소개` });
  // 0507 안심번호(virtualPhone) is a forwarding number — the real phone goes first
  if (p.phone) first(ex.phones, normalizePhone(p.phone));
  if (p.virtualPhone && !ex.phones.some((c) => c.value.replace(/\D/g, "") === p.virtualPhone.replace(/\D/g, ""))) {
    ex.phones.push({ value: normalizePhone(p.virtualPhone), source: `${src} 안심번호` });
  }
  first(ex.addresses, p.address);
  if (p.hours) ex.hours.push({ value: p.hours, source: src });
  ex.categories = ex.categories || [];
  if (p.category) first(ex.categories, p.category);
  if (p.image) addImage(ex, p.image, "og", `${src} 대표 사진`);
  ex.socials.push({ value: p.placeUrl, source: src });
  const facts = [p.name, p.category, p.address, p.phone, p.virtualPhone, p.description, p.hours].filter(Boolean).join(" · ");
  ex.text = (facts + "\n" + ex.text).slice(0, 12000);
  ex.footer = (ex.footer + " " + facts).trim();
  if (!ex.title) ex.title = p.name;
  if (!ex.metaDescription) ex.metaDescription = p.description || [p.category, p.address].filter(Boolean).join(" · ");
}

/** An Extracted for a place without a homepage. */
export function placeExtract(p: PlaceInfo): Extracted {
  const ex = extract("<html><body></body></html>", p.placeUrl);
  ex.images = [];
  applyPlace(ex, p);
  return ex;
}

/** Fields read off a business card (or a shop-sign photo) → candidates with source "명함". */
export type CardInfo = Partial<Record<"name" | "company" | "ceo" | "bizNo" | "phone" | "mobile" | "email" | "address" | "website" | "category" | "slogan", string>>;
export function applyCard(ex: Extracted, c: CardInfo) {
  const src = "명함";
  const add = (arr: { value: string; source: string }[], v?: string, front = false) => {
    const s = String(v || "").trim().slice(0, 120);
    if (!s || arr.some((x) => x.value.replace(/\s/g, "") === s.replace(/\s/g, ""))) return;
    front ? arr.unshift({ value: s, source: src }) : arr.push({ value: s, source: src });
  };
  add(ex.siteName, c.name, !ex.siteName.length);
  add(ex.companyNames, c.company, true);
  add(ex.ceos, c.ceo, true);
  if (c.bizNo && /\d{3}-?\d{2}-?\d{5}/.test(c.bizNo)) add(ex.bizNos, c.bizNo.replace(/\D/g, "").replace(/(\d{3})(\d{2})(\d{5})/, "$1-$2-$3"), true);
  if (c.phone) add(ex.phones, normalizePhone(c.phone), !ex.phones.length);
  if (c.mobile) add(ex.phones, normalizePhone(c.mobile));
  add(ex.emails, c.email, !ex.emails.length);
  add(ex.addresses, c.address, !ex.addresses.length);
  ex.categories = ex.categories || [];
  add(ex.categories, c.category);
  if (c.slogan) add(ex.descriptions, c.slogan);
  const facts = Object.values(c).filter(Boolean).join(" · ");
  ex.text = (ex.text + "\n" + facts).slice(0, 12000);
  ex.footer = (ex.footer + " " + facts).trim();
}
