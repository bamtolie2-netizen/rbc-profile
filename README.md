# RBC 브랜드 · 카카오톡 채널 개설 정보 자동 완성

홈페이지 URL → 사이트(메인 + 회사소개/오시는길 + 연결된 카카오 채널)를 읽고
① RCS 비즈센터 브랜드 개설 ② 카카오톡 채널 개설 정보를 채움 → 상담 신청을 Supabase DB에 저장.

```
web/index.html                              화면 (GitHub Pages)
supabase/functions/rbc-profile/
  index.ts    분석·직접입력·상담신청 API, 안전한 크롤링, Claude 호출, DB 기록
  extract.ts  HTML → 사업자정보·연락처·주소·이미지·카카오 채널 (EUC-KR/JSON-LD 지원)
  profile.ts  RBC·카카오 신청서 작성, 심사 규칙 검사, 사이트 대조 검증
  db.ts       Supabase REST 기록(서비스 키, 라이브러리 없음)
supabase/migrations/…_rbc_tables.sql        테이블 2개 (rbc_requests, rbc_leads)
supabase/config.toml                        함수 JWT 검사 끔(공개 화면용)
.github/workflows/deploy.yml                main에 push → 함수 + Pages 자동 배포
```

## 처음 한 번 설정 (15분)

### 1. Supabase
1. **SQL Editor** → `supabase/migrations/20261120000000_rbc_tables.sql` 내용 붙여넣기 → Run
2. **Edge Functions → Secrets**(또는 Project Settings → Edge Functions)에 추가
   - `ANTHROPIC_API_KEY` = Claude API 키 (없으면 규칙 기반으로만 작성)
   - `ALLOWED_ORIGINS` = `https://<깃허브아이디>.github.io` (선택, 다른 사이트에서 호출 차단)
   - `HOURLY_LIMIT` = `20` (선택, IP당 시간당 분석 횟수)
3. **Account → Access Tokens**에서 토큰 하나 발급 (GitHub 자동 배포용)

### 2. GitHub
1. 새 저장소 만들고 이 폴더 전체를 올리기 (`.github` 폴더 포함)
2. **Settings → Secrets and variables → Actions**
   - Variables 탭: `SUPABASE_PROJECT_ID` = Supabase 프로젝트 ID(ref)
   - Secrets 탭: `SUPABASE_ACCESS_TOKEN` = 위에서 발급한 토큰
3. **Settings → Pages → Source = GitHub Actions**
4. **Actions** 탭에서 `deploy` 실행(또는 main에 push) → 끝나면 Pages 주소가 표시돼요

이후에는 코드를 고쳐 main에 push만 하면 함수와 화면이 같이 배포돼요.
`API_URL`은 배포할 때 자동으로 채워져요(저장소의 index.html은 비워 둬도 됨 → 로컬에서 열면 데모 모드).

## 리드 확인
대시보드 **Table Editor → rbc_leads**. `status`(신규/연락중/진행중/완료/보류)와 `memo`로 관리하고,
`final_application`에 고객이 수정한 RBC·카카오 신청 정보가 그대로 들어 있어요(`request_id`로 분석 원본과 연결).

## 동작 요약
- 사이트를 못 읽으면(봇 차단, 빈 페이지) 브랜드명·소개를 직접 입력하는 창으로 넘어가요.
- 전화·이메일·주소·사업자번호·이미지는 사이트(또는 직접 입력)에 있는 값만 사용, AI가 지어내면 빼고 경고.
- RBC: 브랜드명 40자·소개 300자, 홍보성 문구, 웹사이트 사업자정보 노출, 이미지 규격 검사.
- 카카오: 기존 채널 중복, 검색용 아이디(변경 불가) 후보 3개, 불일치 소명 300자, 고객센터 연락처.
- 보안: 테이블 RLS 켬(정책 없음) → 브라우저에서 DB 직접 접근 불가, 함수만 기록. IP는 해시로만 저장.

## 확인할 것
- 카카오 채널 이름 20자·검색용 아이디 15자·소개 60자는 개설 화면에서 한 번 확인 후 `LIMITS`(profile.ts, index.html) 조정.
- 상담 신청 보관기간(6개월)을 자동으로 지우려면 SQL 파일 맨 아래 pg_cron 부분 사용.
- 개인정보 동의 문구는 회사 개인정보처리방침과 맞춰 주세요.
