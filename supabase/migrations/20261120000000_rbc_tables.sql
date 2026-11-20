-- RBC 브랜드 · 카카오톡 채널 개설 도우미 테이블
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run (또는 supabase db push)

create extension if not exists pgcrypto;

-- 1) 분석 이력: 사이트를 분석할 때마다 1건
create table if not exists public.rbc_requests (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  input_url   text,
  mode        text check (mode in ('crawl','manual')),
  ok          boolean not null default false,
  error       text,
  engine      text,                -- 'claude' | 'rule'
  application jsonb,               -- RBC·카카오 신청 정보 초안
  extracted   jsonb,               -- 사이트에서 뽑은 원본 후보
  ip_hash     text                 -- 레이트리밋용(원본 IP 저장 안 함)
);
create index if not exists rbc_requests_ip_time on public.rbc_requests (ip_hash, created_at desc);
create index if not exists rbc_requests_time on public.rbc_requests (created_at desc);

-- 2) 상담 신청(리드): 결과 화면에서 연락처를 남긴 경우
create table if not exists public.rbc_leads (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  request_id        uuid references public.rbc_requests(id) on delete set null,
  company           text not null,
  contact_name      text,
  phone             text not null,
  email             text,
  wants             text[] default '{}',      -- 'rbc','kakao' 등 원하는 대행
  agreed            boolean not null,         -- 개인정보 수집·이용 동의
  final_application jsonb,                    -- 고객이 수정한 최종 신청 정보
  status            text not null default '신규' check (status in ('신규','연락중','진행중','완료','보류')),
  memo              text
);
create index if not exists rbc_leads_time on public.rbc_leads (created_at desc);

-- 보안: RLS 켜고 정책은 만들지 않음 → 브라우저(anon)는 읽기·쓰기 불가,
-- Edge Function(service role)만 기록. 리드 조회는 대시보드 Table Editor에서.
alter table public.rbc_requests enable row level security;
alter table public.rbc_leads    enable row level security;

-- 보관기간: 상담 신청 6개월, 분석 이력 90일 (pg_cron 확장을 켠 경우에만 실행)
-- select cron.schedule('rbc-retention', '0 3 * * *', $$
--   delete from public.rbc_leads    where created_at < now() - interval '6 months';
--   delete from public.rbc_requests where created_at < now() - interval '90 days';
-- $$);
