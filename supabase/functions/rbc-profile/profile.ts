// Extracted website facts → two ready-to-submit applications:
//   1) RCS Biz Center(RBC) 브랜드 개설   2) 카카오톡 채널 개설
// Claude drafts; rules verify every fact against the crawl and apply each platform's review rules.
import type { Extracted } from "./extract.ts";

/** Soft limits. Re-check against the live forms; change here and in web/index.html. */
export const LIMITS = {
  rbcBrandName: 40, rbcDescription: 300, rbcQuickMenu: 4,
  kakaoName: 20, kakaoSearchId: 15, kakaoDescription: 60, kakaoMismatch: 300,
};
// RBC review: 브랜드 소개에 이벤트·할인·적립 등 홍보성 문구 불가
const PROMO_RE = /(이벤트|할인|적립|쿠폰|특가|세일|증정|사은품|무료\s*체험|최저가|\d+\s*%|프로모션|혜택)/;

export type Field = { value: string; source: string; verified: boolean };
export type Button = { label: string; type: "url" | "call" | "map" | "copy" | "chat"; value: string };

export type Application = {
  business: { companyName: Field; ceo: Field; bizNo: Field; hasStore: boolean };
  rbc: {
    brandName: Field; description: Field; category: Field; phone: Field; website: Field; email: Field; address: Field;
    brandColor: Field; profileImage: Field; backgroundImage: Field; quickMenu: Button[];
  };
  kakao: {
    existingChannel: Field; // 이미 운영 중인 채널이 사이트에 링크돼 있으면 표시
    channelName: Field; searchIds: string[]; category: Field; description: Field; csPhone: Field;
    profileImage: Field; storeAddress: Field; website: Field; mismatchNote: Field;
  };
  warnings: { rbc: string[]; kakao: string[]; common: string[] };
  engine: "claude" | "rule";
  messages?: Sample[]; // AI-written message samples (rule-based templates live in the page)
};
export type Sample = {
  purpose: string; kind: "info" | "ad";
  rcs: { title: string; body: string; buttons: Button[] };
  at: { body: string; button: { label: string; value: string } };
};

const F = (value = "", source = "", verified = false): Field => ({ value: String(value ?? "").trim(), source, verified });
const fromCand = (c?: { value: string; source: string }) => (c ? F(c.value, c.source, true) : F());
const digits = (s: string) => s.replace(/\D/g, "");
const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const stripCorp = (s: string) => s.replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|의원$|\s/g, "");

/* ---------------- rule-based draft ---------------- */

export function ruleApplication(ex: Extracted): Application {
  const host = new URL(ex.url).hostname.replace(/^www\./, "");
  const name = ex.siteName[0]?.value || ex.kakao?.name || host.split(".")[0];
  const desc = ex.descriptions[0];
  const logo = ex.images.find((i) => i.kind === "logo") || ex.images.find((i) => i.kind === "kakao") || ex.images.find((i) => i.kind === "icon");
  const og = ex.images.find((i) => i.kind === "og");
  const phone = fromCand(ex.phones[0]);
  const a: Application = {
    business: { companyName: fromCand(ex.companyNames[0]), ceo: fromCand(ex.ceos[0]), bizNo: fromCand(ex.bizNos[0]), hasStore: ex.addresses.length > 0 },
    rbc: {
      brandName: F(name.slice(0, LIMITS.rbcBrandName), ex.siteName[0]?.source || "도메인", !!ex.siteName[0]),
      description: desc ? F(desc.value.slice(0, LIMITS.rbcDescription), desc.source) : F(),
      category: fromCand(ex.categories?.[0]), phone, website: F(ex.url, "입력한 URL", true), email: fromCand(ex.emails[0]), address: fromCand(ex.addresses[0]),
      brandColor: fromCand(ex.themeColors[0]),
      profileImage: logo ? F(logo.url, logo.source, true) : F(), backgroundImage: og ? F(og.url, og.source, true) : F(),
      quickMenu: [],
    },
    kakao: {
      existingChannel: fromCand(ex.kakaoChannels[0]),
      channelName: F(name.slice(0, LIMITS.kakaoName), ex.siteName[0]?.source || "도메인", !!ex.siteName[0]),
      searchIds: [], category: fromCand(ex.categories?.[0]), description: desc ? F(desc.value.slice(0, LIMITS.kakaoDescription), desc.source) : F(),
      csPhone: phone, profileImage: logo ? F(logo.url, logo.source, true) : F(), storeAddress: fromCand(ex.addresses[0]),
      website: F(ex.url, "입력한 URL", true), mismatchNote: F(),
    },
    warnings: { rbc: [], kakao: [], common: [] },
    engine: "rule",
  };
  return finalize(a, ex);
}

/* ---------------- Claude ---------------- */

/** Shared copywriting brief for message drafts (analysis + "다시 쓰기"). */
const COPY_GUIDE = `MESSAGE COPY — write like a top Korean CRM copywriter, not a template:
- Title (RCS, ≤40 chars, aim 14-24): lead with what the customer gets or must do, concrete and specific
  ("내일 오후 3시, 예약 잊지 않으셨죠?" beats "예약 안내"). No brand name in the title (the sender already shows it).
- Body (RCS ≤200 chars): first line = the key fact; then 1-3 short lines; blank line before the call to action.
  Address the customer as #{고객명}님. Natural spoken Korean (해요체 unless tone says otherwise). No filler like "안녕하세요 고객님".
- Buttons (≤2, label ≤17): verb phrases ("예약 변경하기", "배송 조회하기"), values only from the facts given.
- Variables: #{변수} for anything per-customer or unknown (#{예약일시}, #{상품명}, #{혜택}, #{기간}). Never invent prices, %, dates, counts.
- 알림톡 ("at", info only): starts "[브랜드명] 제목", then a one-line context, then "■ 항목: #{변수}" lines, ≤1000 chars,
  purely informational (no 혜택/쿠폰/이벤트 words — Kakao rejects ad content in 알림톡). One button {label ≤14, value url}.
- "ad": one clear reason to act + a deadline variable, no exaggeration (최고/1위/유일 금지). Do NOT write (광고) or 수신거부 in rcs.body
  (the page adds them). In "at" write it as a 카카오 브랜드 메시지 starting "(광고)".
- Each sample must differ in purpose and shape (not the same sentence pattern three times).`;

const TONES: Record<string, string> = {
  friendly: "친근하고 따뜻하게 (해요체, 이모지 0~2개 자연스럽게)",
  formal: "정중하고 신뢰감 있게 (하십시오체/합니다체, 이모지 없음)",
  short: "짧고 굵게 (핵심만, 각 줄 짧게, 이모지 없음)",
  emotional: "감성적으로 (공감 한 줄로 시작, 이모지 1개 이내)",
};

export type BrandBrief = {
  name: string; description: string; category: string; phone: string; website: string; address: string; kakao: string;
};

/** Prompt for regenerating message drafts ("AI로 다시 쓰기"). */
export function buildMessagePrompt(b: BrandBrief, o: { purpose: string; tone: string; kind: string }): string {
  const tone = TONES[o.tone] || TONES.friendly;
  const kind = o.kind === "ad" ? "ad" : o.kind === "info" ? "info" : "mixed";
  const want = o.purpose
    ? `3 alternative drafts for the purpose "${o.purpose.slice(0, 80)}" (kind: ${kind === "mixed" ? "decide info or ad from the purpose" : kind}).
Make the 3 clearly different angles: (1) clear & practical, (2) benefit-led, (3) warm/personal. Use the same "purpose" label for all 3, with a short suffix like "· 실용형".`
    : `3 drafts for the 3 most valuable scenarios for this business (two "info", one "ad").`;
  return `You write Korean business messages (RCS 브랜드 메시지 + 카카오 알림톡/브랜드 메시지) for this brand.
Tone: ${tone}.
${want}

${COPY_GUIDE}

BRAND (JSON)
${JSON.stringify(b)}

Return ONLY JSON:
{"messages":[{"purpose":"≤20 chars Korean label","kind":"info|ad","rcs":{"title":"","body":"","buttons":[{"label":"","type":"url|call|map","value":""}]},"at":{"body":"","button":{"label":"","value":""}}}]}`;
}

export type CardPromptOut = string;
/** Vision prompt: read a business card / shop sign photo. */
export const CARD_PROMPT = `This image is a Korean business card, shop sign, flyer or business registration certificate.
Read it and return ONLY JSON with these keys (Korean values as printed, "" when not visible — never guess):
{"name":"brand or shop name customers know","company":"legal company name if printed (e.g. ㈜OO, OO의원)","ceo":"대표자 name if labeled 대표",
"bizNo":"사업자등록번호 000-00-00000","phone":"main/office landline or 대표번호","mobile":"mobile 010 number","email":"",
"address":"full address","website":"URL if printed","category":"industry in 1-3 Korean words","slogan":"slogan or one-line intro if printed"}`;

export function buildPrompt(ex: Extracted): string {
  const facts = {
    url: ex.url, title: ex.title, metaDescription: ex.metaDescription, og: ex.og,
    nameCandidates: ex.siteName, descriptionCandidates: ex.descriptions,
    companyNameCandidates: ex.companyNames, ceoCandidates: ex.ceos, bizNoCandidates: ex.bizNos,
    phoneCandidates: ex.phones, emailCandidates: ex.emails, addressCandidates: ex.addresses, hoursCandidates: ex.hours,
    imageCandidates: ex.images, themeColorCandidates: ex.themeColors,
    existingKakaoChannels: ex.kakaoChannels, kakaoIdCandidates: ex.kakaoIds, kakaoChannelPage: ex.kakao || null,
    categoryCandidates: ex.categories || [], socialLinks: ex.socials, footer: ex.footer.slice(0, 1500), pageText: ex.text.slice(0, 6500),
  };
  return `You prepare two Korean business-messaging registrations for the company whose website was crawled below:
(A) RCS Biz Center(RBC) 브랜드 개설, (B) 카카오톡 채널 개설 (카카오비즈니스 파트너센터).

GLOBAL RULES
- Korean values. Contacts, addresses, business numbers, image URLs: copy EXACTLY from candidate lists, never invent. Unknown → "".
- For every field return {"value","source"}; source = short Korean note of where it came from.

(A) RBC rules (from the RBC review guide)
- brandName: 기업명 or 기업의 서비스명 customers know, ≤${LIMITS.rbcBrandName} chars.
- description: slogan/특징 소개, ≤${LIMITS.rbcDescription} chars. NO promotional words (이벤트, 할인, 적립, 쿠폰, 특가, %, 혜택 등).
- category: "대분류 > 중분류 > 소분류" style Korean industry guess.
- phone: the number actually used for the brand (대표번호 1588-xxxx or main landline preferred; not fax).
- brandColor: #hex from themeColorCandidates, else a hex matching the logo/brand.
- profileImage: square symbol/logo candidate. backgroundImage: wide brand image (og image) if any.
- quickMenu: 2-${LIMITS.rbcQuickMenu} 브랜드 홈 퀵 버튼, type url|call|map|copy, values from facts.

(B) 카카오톡 채널 rules
- channelName: brand name customers search, 한글/영문/숫자, ≤${LIMITS.kakaoName} chars.
- searchIds: 3 candidates for 검색용 아이디 (cannot be changed later), ≤${LIMITS.kakaoSearchId} chars, no spaces/special chars;
  one Korean (brand), one English/romanized (from domain), one with region or industry word.
- category: Korean industry label.
- description: 채널 소개 — what the channel offers + why add as friend, ≤${LIMITS.kakaoDescription} chars.
- csPhone: 고객센터 연락처 (needed to create 발신 프로필 키 for 알림톡) — same rules as phone.
- storeAddress: only if the business has an offline store, from addressCandidates.
- mismatchNote: if channelName differs from the legal company name (companyNameCandidates), write a ≤${LIMITS.kakaoMismatch}-char 사업자정보 불일치 소명
  explaining that the channel name is the brand/service operated by that company, pointing to the website footer as evidence. Else "".

(C) messages: 3 message samples this business would really send after opening the brand/channel —
pick the 3 scenarios that matter most for THIS industry (two "info" transactional, one "ad").
${COPY_GUIDE}

FACTS (JSON)
${JSON.stringify(facts)}

Return ONLY JSON:
{"business":{"companyName":{"value":"","source":""},"ceo":{"value":"","source":""},"bizNo":{"value":"","source":""},"hasStore":false},
"rbc":{"brandName":{},"description":{},"category":{},"phone":{},"email":{},"address":{},"brandColor":{},"profileImage":{},"backgroundImage":{},
"quickMenu":[{"label":"","type":"url","value":""}]},
"kakao":{"channelName":{},"searchIds":["","",""],"category":{},"description":{},"csPhone":{},"profileImage":{},"storeAddress":{},"mismatchNote":{}},
"messages":[{"purpose":"","kind":"info","rcs":{"title":"","body":"","buttons":[{"label":"","type":"url","value":""}]},"at":{"body":"","button":{"label":"","value":""}}}],
"notes":[]}`;
}

export function parseClaude(text: string, ex: Extracted): Application {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model output");
  const j = JSON.parse(m[0]);
  const g = (o: Record<string, { value?: string; source?: string }> | undefined, k: string) =>
    F(String(o?.[k]?.value ?? ""), String(o?.[k]?.source ?? ""));
  const b = j.business || {}, r = j.rbc || {}, k = j.kakao || {};
  const a: Application = {
    business: { companyName: g(b, "companyName"), ceo: g(b, "ceo"), bizNo: g(b, "bizNo"), hasStore: !!b.hasStore || ex.addresses.length > 0 },
    rbc: {
      brandName: g(r, "brandName"), description: g(r, "description"), category: g(r, "category"), phone: g(r, "phone"),
      website: F(ex.url, "입력한 URL", true), email: g(r, "email"), address: g(r, "address"), brandColor: g(r, "brandColor"),
      profileImage: g(r, "profileImage"), backgroundImage: g(r, "backgroundImage"), quickMenu: buttons(r.quickMenu, LIMITS.rbcQuickMenu),
    },
    kakao: {
      existingChannel: fromCand(ex.kakaoChannels[0]),
      channelName: g(k, "channelName"), searchIds: (Array.isArray(k.searchIds) ? k.searchIds : []).map(String),
      category: g(k, "category"), description: g(k, "description"), csPhone: g(k, "csPhone"), profileImage: g(k, "profileImage"),
      storeAddress: g(k, "storeAddress"), website: F(ex.url, "입력한 URL", true), mismatchNote: g(k, "mismatchNote"),
    },
    warnings: { rbc: [], kakao: [], common: (Array.isArray(j.notes) ? j.notes : []).map(String).slice(0, 4) },
    engine: "claude",
  };
  const done = finalize(a, ex);
  done.messages = cleanMessages(j.messages, allowFromEx(ex, done));
  return done;
}

function buttons(raw: unknown, max: number, labelMax = 15): Button[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && x.label)
    .map((x) => ({
      label: String(x.label).slice(0, labelMax),
      type: (["url", "call", "map", "copy", "chat"].includes(x.type) ? x.type : "url") as Button["type"],
      value: String(x.value ?? ""),
    }))
    .slice(0, max);
}

/* ---------------- verification & platform rules ---------------- */

export function finalize(a: Application, ex: Extracted): Application {
  const hay = squash([ex.title, ex.metaDescription, ex.footer, ex.text, JSON.stringify(ex.jsonLd), JSON.stringify(ex.og), JSON.stringify(ex.kakao || {})].join(" "));
  const { rbc, kakao, business: biz, warnings: W } = a;

  // --- contacts: must exist on the site, else fall back to the best crawled candidate ---
  const checkPhone = (f: Field, label: string, list: string[]): Field => {
    if (f.value) {
      const ok = ex.phones.some((c) => digits(c.value) === digits(f.value));
      if (ok) return { ...f, verified: true };
      list.push(`AI가 제안한 ${label} ${f.value}는 사이트에서 확인되지 않아 뺐어요.`);
    }
    return fromCand(ex.phones[0]);
  };
  rbc.phone = checkPhone(rbc.phone, "전화번호", W.rbc);
  kakao.csPhone = checkPhone(kakao.csPhone, "고객센터 연락처", W.kakao);
  if (rbc.email.value && !hay.includes(rbc.email.value.toLowerCase())) { W.rbc.push(`이메일 ${rbc.email.value}는 사이트에서 확인되지 않아 뺐어요.`); rbc.email = F(); }
  if (!rbc.email.value) rbc.email = fromCand(ex.emails[0]); else rbc.email.verified = true;

  const checkAddr = (f: Field): Field => {
    if (!f.value) return f;
    const key = squash(f.value).slice(0, 12);
    return { ...f, verified: ex.addresses.some((c) => squash(c.value).includes(key)) || hay.includes(key) };
  };
  rbc.address = checkAddr(rbc.address.value ? rbc.address : fromCand(ex.addresses[0]));
  kakao.storeAddress = checkAddr(kakao.storeAddress);
  if (a.business.hasStore && !kakao.storeAddress.value) kakao.storeAddress = fromCand(ex.addresses[0]);

  // --- business info ---
  const checkBiz = (f: Field, list: { value: string }[], cmp: (x: string) => string): Field => {
    if (f.value && list.some((c) => cmp(c.value) === cmp(f.value))) return { ...f, verified: true };
    if (f.value && hay.includes(squash(f.value))) return { ...f, verified: true };
    return list[0] ? fromCand(list[0] as { value: string; source: string }) : F();
  };
  biz.bizNo = checkBiz(biz.bizNo, ex.bizNos, digits);
  biz.companyName = checkBiz(biz.companyName, ex.companyNames, stripCorp);
  biz.ceo = checkBiz(biz.ceo, ex.ceos, (x) => x);

  // --- images must be crawled candidates ---
  const img = (f: Field, fallbackKinds: string[]): Field => {
    if (f.value && ex.images.some((i) => i.url === f.value)) return { ...f, verified: true };
    const c = fallbackKinds.map((k) => ex.images.find((i) => i.kind === k)).find(Boolean);
    return c ? F(c.url, c.source, true) : F();
  };
  rbc.profileImage = img(rbc.profileImage, ["logo", "kakao", "icon"]);
  rbc.backgroundImage = img(rbc.backgroundImage, ["og"]);
  kakao.profileImage = img(kakao.profileImage.value ? kakao.profileImage : rbc.profileImage, ["logo", "kakao", "icon"]);

  // --- names ---
  const host = new URL(ex.url).hostname.replace(/^www\./, "").split(".")[0];
  const fallbackName = ex.siteName[0]?.value || host;
  if (!rbc.brandName.value) rbc.brandName = F(fallbackName, ex.siteName[0]?.source || "도메인");
  if (!kakao.channelName.value) kakao.channelName = F(rbc.brandName.value, rbc.brandName.source);
  for (const f of [rbc.brandName, kakao.channelName]) f.verified = hay.includes(squash(f.value));
  if (!kakao.category.value && rbc.category.value) kakao.category = F(rbc.category.value.split(">").slice(-1)[0].trim(), "RBC 카테고리 참고");

  // --- brand color ---
  if (!/^#[0-9a-f]{6}$/i.test(rbc.brandColor.value)) rbc.brandColor = ex.themeColors[0] ? fromCand(ex.themeColors[0]) : F("#2f5bff", "기본값");
  else rbc.brandColor.verified = ex.themeColors.some((c) => c.value === rbc.brandColor.value.toLowerCase());

  // --- RBC rules ---
  if (rbc.brandName.value.length > LIMITS.rbcBrandName) W.rbc.push(`브랜드명이 ${LIMITS.rbcBrandName}자를 넘어요.`);
  if (!rbc.description.value) W.rbc.push("브랜드 소개는 필수예요.");
  if (PROMO_RE.test(rbc.description.value)) W.rbc.push(`브랜드 소개에 홍보성 문구("${PROMO_RE.exec(rbc.description.value)![0]}")가 있어요. RBC 심사에서 반려돼요.`);
  if (rbc.description.value.length > LIMITS.rbcDescription) W.rbc.push(`브랜드 소개가 ${LIMITS.rbcDescription}자를 넘어요.`);
  if (!rbc.phone.value) W.rbc.push("브랜드 용도로 실제 사용하는 전화번호를 넣어 주세요.");
  if (!biz.bizNo.value && !biz.companyName.value) W.rbc.push("웹사이트에서 사업자등록번호·기업명을 찾지 못했어요. RBC는 이 정보가 보이는 홈페이지를 요구해서 반려될 수 있어요.");
  if (!rbc.profileImage.value) W.rbc.push("프로필 이미지(정사각형 심벌, 배경색 있는 PNG, 388~1080px)를 준비해 주세요.");
  rbc.quickMenu = rbc.quickMenu.filter((b) => b.type !== "call" || ex.phones.some((c) => digits(c.value) === digits(b.value)));
  if (!rbc.quickMenu.length) {
    if (rbc.website.value) rbc.quickMenu.push({ label: "홈페이지", type: "url", value: rbc.website.value });
    if (rbc.phone.value) rbc.quickMenu.push({ label: "전화 문의", type: "call", value: rbc.phone.value });
    if (rbc.address.value) rbc.quickMenu.push({ label: "오시는 길", type: "map", value: rbc.address.value });
  }

  // --- Kakao rules ---
  if (kakao.existingChannel.value) W.kakao.push(`사이트에 이미 카카오톡 채널(${kakao.existingChannel.value})이 연결돼 있어요. 새로 만들지 말고 기존 채널을 쓰는지 먼저 확인하세요.`);
  if (kakao.channelName.value.length > LIMITS.kakaoName) W.kakao.push(`채널 이름이 ${LIMITS.kakaoName}자를 넘어요.`);
  kakao.searchIds = cleanIds(kakao.searchIds, kakao.channelName.value, host, ex);
  if (kakao.description.value.length > LIMITS.kakaoDescription) W.kakao.push(`채널 소개가 ${LIMITS.kakaoDescription}자를 넘어요. 짧게 다듬어 주세요.`);
  if (!kakao.description.value) kakao.description = F(rbc.description.value.slice(0, LIMITS.kakaoDescription), "RBC 브랜드 소개 참고");
  if (!kakao.csPhone.value) W.kakao.push("고객센터 연락처가 없으면 알림톡용 발신 프로필 키를 만들 수 없어요.");
  const legal = biz.companyName.value;
  if (legal && stripCorp(legal) !== stripCorp(kakao.channelName.value)) {
    if (!kakao.mismatchNote.value) {
      kakao.mismatchNote = F(
        `'${kakao.channelName.value}'은(는) ${legal}${biz.bizNo.value ? `(사업자등록번호 ${biz.bizNo.value})` : ""}가 운영하는 브랜드(서비스)명입니다. 공식 홈페이지(${ex.url}) 하단 사업자 정보에서 운영 주체를 확인하실 수 있습니다.`,
        "자동 작성",
      );
    }
    kakao.mismatchNote.value = kakao.mismatchNote.value.slice(0, LIMITS.kakaoMismatch);
    W.kakao.push("채널 이름과 사업자등록증 상 업체명이 달라요. 개설 시 '사업자정보 불일치 소명'을 함께 내야 해요.");
  } else kakao.mismatchNote = F();
  if (!biz.bizNo.value) W.common.push("사업자등록번호를 찾지 못했어요. 두 곳 모두 사업자등록증으로 확인하니 직접 입력해 주세요.");

  for (const k of ["rbc", "kakao", "common"] as const) W[k] = [...new Set(W[k])];
  return a;
}

/** 검색용 아이디: ≤15자, 공백·특수문자 제거, 3개 후보 보장. */
function cleanIds(ids: string[], name: string, host: string, ex: Extracted): string[] {
  const norm = (s: string) => s.replace(/^@/, "").replace(/[^가-힣a-zA-Z0-9]/g, "").toLowerCase().slice(0, LIMITS.kakaoSearchId);
  const out: string[] = [];
  const add = (s: string) => { const v = norm(s); if (v.length >= 2 && !out.includes(v)) out.push(v); };
  ids.forEach(add);
  ex.kakaoIds.forEach((c) => add(c.value));
  add(name);
  if (/[a-z]/i.test(host)) add(host);
  const region = /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|제주|강남|분당|판교|홍대|해운대)/.exec(ex.addresses[0]?.value || "")?.[1];
  if (region && !name.includes(region)) add(region + name);
  return out.slice(0, 3);
}


export type Allow = { site: string; phones: string[]; kakao: string[]; fallbackUrl: string };
export const allowFromEx = (ex: Extracted, a: Application): Allow => ({
  site: ex.url, phones: ex.phones.map((c) => c.value), kakao: ex.kakaoChannels.map((c) => c.value), fallbackUrl: a.rbc.website.value,
});

/** Keep AI samples within limits; drop buttons whose link/number does not come from the business. */
export function cleanMessages(raw: unknown, allow: Allow): Sample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const site = host(allow.site);
  const okValue = (type: string, v: string) =>
    type === "call" ? allow.phones.some((p) => digits(p) === digits(v) && digits(v).length >= 8) :
    type === "map" ? !!v :
    !v || (!!site && host(v) === site) || allow.kakao.some((c) => v.startsWith(c));
  const out = raw.slice(0, 4).filter((m) => m && m.rcs && m.purpose).map((m): Sample => ({
    purpose: String(m.purpose).slice(0, 24),
    kind: m.kind === "ad" ? "ad" : "info",
    rcs: {
      title: String(m.rcs.title || "").slice(0, 40),
      body: String(m.rcs.body || "").replace(/^\(광고\)\s*/, "").replace(/\n*무료\s*수신\s*거부.*$/s, "").slice(0, 200),
      buttons: buttons(m.rcs.buttons, 2, 17).filter((b) => b.label && okValue(b.type, b.value)),
    },
    at: {
      body: String(m.at?.body || "").slice(0, 1000),
      button: { label: String(m.at?.button?.label || "").slice(0, 14), value: okValue("url", String(m.at?.button?.value || "")) ? String(m.at?.button?.value || "") : allow.fallbackUrl },
    },
  }));
  return out.length ? out : undefined;
}
