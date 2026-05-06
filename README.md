# 싹싹 서버 (ssakssak-server)

싹싹 모바일웹앱의 백엔드 API 서버. Express + Supabase + CoolSMS + Web Push.

**배포**: Railway → https://ssakssak-server-production.up.railway.app
**프론트**: https://github.com/momomint10/ssak-app

---

## 🏗 기술 스택

- **런타임**: Node.js 22.22.2 (Railway us-west2)
- **프레임워크**: Express ^4.18.2
- **DB**: Supabase (`@supabase/supabase-js ^2.39.0`)
- **SMS**: CoolSMS API (HMAC-SHA256)
- **Web Push**: `web-push ^3.6.7`
- **보안**: Helmet ^7.1.0, express-rate-limit ^7.4.0, cors

## 📋 환경변수

| 변수 | 용도 |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | DB 접근 |
| `ADMIN_KEY` | 사장님 데이터 보호용 (`/api/bookings`, `/api/contract/create` 등) |
| `COOLSMS_API_KEY` / `COOLSMS_API_SECRET` / `COOLSMS_FROM` | SMS 발송 (서버에서만 사용 — 클라이언트 노출 X) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push |
| `ALLOW_ALL_ORIGINS` | (선택) `1`로 설정 시 CORS 화이트리스트 우회 |

## 🗂 라우트 인벤토리 (49 routes)

| 영역 | 개수 | 주요 라우트 |
|---|---|---|
| `/api/workers` | 6 | 목록/상세/내것/등록/상태변경/삭제 |
| `/api/worker-chats` | 6 | 목록/생성/메시지조회/메시지전송/읽음/unread-count |
| `/api/jobs` | 9 | 목록/상세/내공고/내지원/등록/상태/지원/지원자/매칭 |
| `/api/community` | 7 | 목록/작성/상세/삭제/좋아요/댓글작성/댓글삭제 |
| `/api/market/listings` | 6 | 중고시장 상품 |
| `/api/market/chats` | 4 | 중고시장 안심채팅 |
| `/api/schedules` | 4 | 일정 CRUD |
| `/api/bookings` + `/api/booking` | 4 | 고객 예약 신청 + 사장님 조회/관리 |
| `/api/booking/token` | 2 | 단축 URL 토큰 생성/조회 |
| `/api/contract` | 4 | 계약서 (PDF 업로드, 비대면 서명) |
| `/api/push` | 3 | Web Push 구독 |
| `/api/sms` + `/send-sms` | 2 | SMS 발송 |
| 기타 (`/api/stats`, `/api/settings` 등) | 다양 | |

## 🔒 보안 정책

### Helmet 보안 헤더
- X-Content-Type-Options: nosniff
- X-Frame-Options: SAMEORIGIN
- Strict-Transport-Security: max-age=15552000
- Referrer-Policy: no-referrer
- Cross-Origin-Resource-Policy: cross-origin (GitHub Pages ↔ Railway 호환)

### Rate Limit (4단계)
- 일반: 100/분 (`generalLimiter`)
- 쓰기: 30/분 (`writeLimiter` — booking/jobs/market/community/push)
- 메신저: 60/분 (`messageLimiter` — worker-chats)
- SMS: 10/분 (`expensiveLimiter` — `/send-sms`)

### CORS 화이트리스트
- `https://ssakapp.co.kr`
- `https://www.ssakapp.co.kr`
- `https://momomint10.github.io`

### 본인 검증 헬퍼
- `validateAnonId(v)`: 영숫자_- 4-100자
- `clampStr(v, max)`: 길이 제한
- `assertChatParticipant(chat_id, anon_id)`: worker-chats 본인 검증
- `assertMarketChatParticipant(chat_id, anon_id)`: market-chats 본인 검증

### 응답 일관성
모든 응답: `{ success: true/false, data?: ..., error?: ... }`

## 🚀 배포

### 의존성 추가 시 필수
```bash
# package-lock.json 갱신 후 push (Railway npm ci 호환)
npm install --package-lock-only
git add package.json package-lock.json server.js
git commit -m "..."
git push origin main
```

### Railway 빌드 확인
- https://railway.app → ssakssak-server → Deployments
- 빌드 로그에서 npm ci SUCCESS + 새 commit ACTIVE 확인

## 🛠 개발

```bash
# 로컬 실행
node --check server.js   # 문법 검증
npm install
npm start                # PORT=3000
```

## 📊 코드 품질

- 라인 수: ~2030
- node --check: PASS
- Supabase MCP로 DB 시뮬레이션 검증 가능
- 라우트 인벤토리 회귀 검증: 변경마다 49 보존 확인
