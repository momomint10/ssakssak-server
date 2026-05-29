const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const webpush = require('web-push');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── 진단용 인-메모리 카운터 (서버 재시작 시 초기화) ──
const _diagStats = {
  bookingPostCount: 0,
  bookingSuccessCount: 0,
  bookingFailCount: 0,
  lastBookingPostAt: null,
  lastBookingSuccessAt: null,
  lastBookingError: null,
  serverStartedAt: new Date().toISOString()
};

// ── 보안 헤더 (Helmet) ──────────────────────────────────────
// X-Content-Type-Options, X-Frame-Options, HSTS 등 자동 적용.
// CSP는 차후 점진 도입 (외부 CDN 검토 필요).
// COEP/CORP는 GitHub Pages frontend ↔ Railway backend cross-origin 호환 위해 완화.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false
}));

// ── CORS 화이트리스트 (패치 C) ──────────────────────────────
// 운영 도메인만 허용. 개발 시 origin 추가 또는 ALLOW_ALL_ORIGINS=1 환경변수로 우회
const ALLOWED_ORIGINS = [
  'https://ssakapp.co.kr',
  'https://www.ssakapp.co.kr',
  'https://momomint10.github.io'
];
app.use(cors({
  origin: function(origin, cb) {
    // origin 없는 요청 (서버사이드, curl, 모바일 webview 일부) 허용
    if (!origin) return cb(null, true);
    if (process.env.ALLOW_ALL_ORIGINS === '1') return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: false
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// ── Rate Limit (패치 B) ─────────────────────────────────────
// 일반 라우트: IP당 분당 100회
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});
// 쓰기 라우트: IP당 분당 30회 (POST/PUT/DELETE에 더 강하게)
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '쓰기 요청 한도 초과. 잠시 후 다시 시도해주세요.' }
});
// SMS 발송 / 계약서 생성 등 비용 발생: IP당 분당 10회
const expensiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'SMS·계약서 등 비용 발생 요청 한도 초과.' }
});
// 메신저: 채팅 특성상 빈번 → 분당 60회
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '메시지 전송 한도 초과. 잠시 후 다시 시도해주세요.' }
});

// 모든 /api/* 에 일반 limiter 적용
app.use('/api/', generalLimiter);
// 비용 발생 경로에 추가 limiter
app.use('/send-sms', expensiveLimiter);
app.use('/api/booking', writeLimiter);          // 고객 신청 spam 방어
app.use('/api/schedules', writeLimiter);
app.use('/api/jobs', writeLimiter);
app.use('/api/market/listings', writeLimiter);
app.use('/api/market/chats', writeLimiter);
app.use('/api/worker-chats', messageLimiter);   // 메신저는 빈번하므로 messageLimiter
app.use('/api/community', writeLimiter);        // 커뮤니티 글·댓글·좋아요 spam 방어
app.use('/api/push', writeLimiter);             // 푸시 구독 등록·해제 spam 방어

// Supabase 연결
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Web Push 초기화 (Phase 3-A) ──────────────────────────
// VAPID 키는 Railway 환경변수에 설정. 미설정 시 푸시 비활성화 (서버 자체는 정상 가동)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@ssakapp.co.kr';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('✅ Web Push 활성화');
} else {
  console.log('⚠️  Web Push 비활성화 (VAPID 키 미설정)');
}

// 푸시 발송 헬퍼: 모든 push_subscriptions 에 발송 (소유자 알림용)
// 테스트 단계라 사장님 1명 구독만 있다는 가정. 향후 owner_anon_id 필터 필요.
async function sendPushToAll(payload) {
  if (!PUSH_ENABLED) return { sent: 0, failed: 0 };
  try {
    const { data: subs, error } = await supabase.from('push_subscriptions').select('endpoint, p256dh, auth');
    if (error || !subs || !subs.length) return { sent: 0, failed: 0 };
    const json = JSON.stringify(payload);
    let sent = 0, failed = 0;
    const stale = [];
    await Promise.allSettled(subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }}, json);
        sent++;
      } catch (err) {
        failed++;
        if (err.statusCode === 404 || err.statusCode === 410) stale.push(s.endpoint);
      }
    }));
    if (stale.length) await supabase.from('push_subscriptions').delete().in('endpoint', stale);
    return { sent, failed };
  } catch (e) {
    console.error('sendPushToAll error:', e.message);
    return { sent: 0, failed: 0 };
  }
}

// 푸시 발송 헬퍼: 특정 anon_id의 모든 구독으로 푸시 발송
// 만료된 구독은 자동 제거 (410 Gone 에러)
async function sendPushTo(anon_id, payload) {
  if (!PUSH_ENABLED || !anon_id) return { sent: 0, failed: 0 };
  try {
    const { data: subs, error } = await supabase.from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('anon_id', anon_id);
    if (error || !subs || !subs.length) return { sent: 0, failed: 0 };

    const json = JSON.stringify(payload);
    let sent = 0, failed = 0;
    const stale = [];
    await Promise.allSettled(subs.map(async s => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          json
        );
        sent++;
      } catch (err) {
        failed++;
        // 410 Gone / 404 Not Found = 만료된 구독 → 정리
        if (err.statusCode === 404 || err.statusCode === 410) {
          stale.push(s.endpoint);
        }
      }
    }));
    if (stale.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', stale);
    }
    return { sent, failed };
  } catch (e) {
    console.error('sendPushTo error:', e.message);
    return { sent: 0, failed: 0 };
  }
}

// ════════════════════════════════════════════════════════════════
// ── Phase 2: 인증 시스템 (admin_users + SMS OTP + JWT) ─────────
// ════════════════════════════════════════════════════════════════
// JWT_SECRET 부트스트랩 (2026-05-17 영구화)
// 우선순위: Railway 환경변수 > Supabase app_secrets DB > 메모리 신규 생성+저장
// 코드 push 시 Railway 재배포에도 시크릿 유지 → 30일 세션 보존 → SMS 비용 절감
let JWT_SECRET = '';
let JWT_SECRET_SOURCE = 'pending';
const JWT_TTL_SEC = 90 * 24 * 60 * 60;          // 90일 (D2 A 결정)
const OTP_TTL_MS  = 3 * 60 * 1000;              // 3분
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;       // 재발송 1분
const OTP_HOURLY_MAX = 5;                       // 시간당 발송 5회 (per phone)
const OTP_MAX_ATTEMPTS = 5;                     // 검증 5회 실패 시 무효

async function bootstrapJwtSecret() {
  // 1순위: Railway 환경변수
  if (process.env.JWT_SECRET) {
    JWT_SECRET = process.env.JWT_SECRET;
    JWT_SECRET_SOURCE = 'env';
    console.log('✅ JWT_SECRET: Railway 환경변수 사용 (영구)');
    return;
  }
  // 2순위: Supabase app_secrets DB
  try {
    const { data: row, error } = await supabase
      .from('app_secrets').select('value').eq('key', 'JWT_SECRET').maybeSingle();
    if (!error && row && row.value && row.value.length >= 32) {
      JWT_SECRET = row.value;
      JWT_SECRET_SOURCE = 'db';
      console.log('✅ JWT_SECRET: Supabase DB 사용 (영구 — 코드 push에도 유지)');
      return;
    }
  } catch (e) {
    console.error('JWT_SECRET DB read error:', e.message);
  }
  // 3순위: 신규 생성 + DB 영구 저장
  const newSecret = require('crypto').randomBytes(64).toString('hex');
  try {
    const { error: insErr } = await supabase
      .from('app_secrets').insert({
        key: 'JWT_SECRET',
        value: newSecret,
        description: '서버 자동 생성 (2026-05-17) — JWT HS256 서명 키'
      });
    if (insErr) {
      // 동시 다중 인스턴스에서 race로 이미 다른 row가 들어갔을 가능성 — 다시 read
      const { data: retry } = await supabase
        .from('app_secrets').select('value').eq('key', 'JWT_SECRET').maybeSingle();
      if (retry && retry.value) {
        JWT_SECRET = retry.value;
        JWT_SECRET_SOURCE = 'db-race-recovered';
        console.log('✅ JWT_SECRET: DB 동시 생성 감지 → 기존 값 사용');
        return;
      }
      throw insErr;
    }
    JWT_SECRET = newSecret;
    JWT_SECRET_SOURCE = 'generated';
    console.log('✅ JWT_SECRET: 신규 생성 후 DB 영구 저장 (이후 재배포에서도 유지)');
  } catch (e) {
    // DB 저장 실패 — 메모리만 사용 (재시작 시 풀림)
    JWT_SECRET = newSecret;
    JWT_SECRET_SOURCE = 'memory-fallback';
    console.warn('⚠️  JWT_SECRET DB 저장 실패 — 메모리 사용:', e.message);
  }
}

// 비동기 부트스트랩 — 서버 listen 전까지 완료
const JWT_BOOTSTRAP = bootstrapJwtSecret();

// E.164 정규화: 010-1234-5678 → +821012345678
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let p = raw.replace(/[\s\-().]/g, '');
  if (!p) return '';
  if (p.startsWith('+82')) return p;
  if (p.startsWith('82')) return '+' + p;
  if (p.startsWith('0')) return '+82' + p.substring(1);
  return p;
}

// SHA256 hex
function hashCode(code) {
  return require('crypto').createHash('sha256').update(String(code)).digest('hex');
}

// 6자리 OTP 발생 (cryptographically secure)
function genOtp() {
  const buf = require('crypto').randomBytes(4);
  const n = buf.readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}

// base64url 인코딩 (Node 16+ 'base64url' 지원)
function b64url(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64url') : Buffer.from(buf).toString('base64url');
}

// JWT HS256 서명 (자체 구현 — 의존성 추가 없이)
function signJwt(payload) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not set');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + JWT_TTL_SEC }));
  const sig = b64url(require('crypto').createHmac('sha256', JWT_SECRET).update(header + '.' + body).digest());
  return header + '.' + body + '.' + sig;
}

function verifyJwt(token) {
  if (!JWT_SECRET || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = b64url(require('crypto').createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest());
  // timing-safe compare
  if (expected.length !== parts[2].length) return null;
  if (!require('crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// 미들웨어: Authorization: Bearer <jwt> 검증
async function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) {
    return res.status(401).json({ success: false, error: '로그인이 필요합니다', code: 'AUTH_REQUIRED' });
  }
  // 사용자 상태 확인 (disabled 즉시 반영)
  const { data: u, error } = await supabase.from('admin_users')
    .select('id, phone_e164, role, name, status')
    .eq('id', payload.sub).maybeSingle();
  if (error || !u) return res.status(401).json({ success: false, error: '계정 없음', code: 'AUTH_USER_GONE' });
  if (u.status !== 'active') return res.status(403).json({ success: false, error: '비활성화된 계정입니다', code: 'AUTH_DISABLED' });
  req.user = u;
  next();
}

function ownerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ success: false, error: '관리자 권한 필요', code: 'AUTH_OWNER_ONLY' });
  }
  next();
}

// 로그인 이력 기록 (비동기, 응답 차단 안 함)
function logAuth(phone, outcome, userId, req) {
  supabase.from('auth_login_log').insert({
    phone_e164: phone,
    user_id: userId,
    outcome,
    ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
    user_agent: (req.headers['user-agent'] || '').slice(0, 200)
  }).then(({ error }) => {
    if (error) console.error('auth_login_log insert error:', error.message);
  });
}

// CoolSMS 발송 헬퍼 (OTP 전용 짧은 메시지)
async function sendOtpSms(toPhone, code) {
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_FROM;
  if (!apiKey || !apiSecret || !from) throw new Error('SMS_NOT_CONFIGURED');
  const crypto = require('crypto');
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  const text = `[싹싹] 인증번호: ${code}\n3분 안에 입력해 주세요.`;
  const r = await fetch('https://api.coolsms.co.kr/messages/v4/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`
    },
    body: JSON.stringify({
      message: { to: toPhone.replace(/[\s\-+]/g,'').replace(/^82/,'0'), from: from.replace(/-/g,''), text, type: 'SMS' }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.errorMessage || 'SMS_SEND_FAIL');
  return data;
}

// ── POST /api/auth/send-otp { phone } ──────────────────────────
// 화이트리스트 검증 → rate limit → OTP 생성 → SMS 발송
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone || !/^\+82\d{9,11}$/.test(phone)) {
      return res.status(400).json({ success: false, error: '휴대폰 번호를 정확히 입력해 주세요' });
    }
    // 1) 화이트리스트 검증
    const { data: u } = await supabase.from('admin_users')
      .select('id, phone_e164, role, status').eq('phone_e164', phone).maybeSingle();
    if (!u || u.status !== 'active') {
      logAuth(phone, 'otp_blocked_whitelist', null, req);
      // 보안: 등록 여부를 노출하지 않기 위해 동일한 일반 메시지
      return res.status(403).json({ success: false, error: '등록되지 않은 번호입니다. 관리자에게 문의해 주세요.' });
    }
    // 2) Rate limit: 직전 발송 1분 이내?
    const oneMinAgo = new Date(Date.now() - OTP_RESEND_COOLDOWN_MS).toISOString();
    const { data: recent } = await supabase.from('auth_otp_codes')
      .select('id, created_at').eq('phone_e164', phone)
      .gte('created_at', oneMinAgo).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (recent) {
      logAuth(phone, 'otp_blocked_rate', u.id, req);
      return res.status(429).json({ success: false, error: '잠시 후 다시 시도해 주세요 (1분 내 1회 발송)', code: 'RATE_LIMIT' });
    }
    // 3) Rate limit: 1시간 5회?
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: hourCount } = await supabase.from('auth_otp_codes')
      .select('id', { count: 'exact', head: true }).eq('phone_e164', phone)
      .gte('created_at', oneHourAgo);
    if ((hourCount || 0) >= OTP_HOURLY_MAX) {
      logAuth(phone, 'otp_blocked_rate', u.id, req);
      return res.status(429).json({ success: false, error: '시간당 발송 한도 초과 (5회). 1시간 후 다시 시도해 주세요.', code: 'RATE_LIMIT_HOUR' });
    }
    // 4) OTP 생성 + 저장 + SMS 발송
    const code = genOtp();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    const { error: insErr } = await supabase.from('auth_otp_codes').insert({
      phone_e164: phone, code_hash: codeHash, expires_at: expiresAt,
      client_ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      user_agent: (req.headers['user-agent'] || '').slice(0, 200)
    });
    if (insErr) {
      console.error('otp insert error:', insErr.message);
      return res.status(500).json({ success: false, error: 'OTP 생성 실패' });
    }
    try {
      await sendOtpSms(phone, code);
      logAuth(phone, 'otp_sent', u.id, req);
      res.json({ success: true, message: '인증번호를 발송했습니다', expires_in_sec: OTP_TTL_MS / 1000 });
    } catch (smsErr) {
      console.error('OTP SMS 발송 실패:', smsErr.message);
      res.status(500).json({ success: false, error: 'SMS 발송 실패 — 잠시 후 다시 시도해 주세요' });
    }
  } catch (e) {
    console.error('send-otp error:', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── POST /api/auth/verify-otp { phone, code } ─────────────────
// OTP 검증 → JWT 발급 → last_login_at 갱신
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    if (!phone || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: '휴대폰 번호와 6자리 인증번호를 확인해 주세요' });
    }
    // 최신 OTP row 조회 (사용 안 한 것, 만료 안 된 것 우선)
    const { data: otp } = await supabase.from('auth_otp_codes')
      .select('id, code_hash, expires_at, used, attempts')
      .eq('phone_e164', phone).eq('used', false)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!otp) {
      logAuth(phone, 'verify_fail', null, req);
      return res.status(401).json({ success: false, error: '인증번호를 먼저 발송해 주세요', code: 'OTP_NOT_FOUND' });
    }
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      logAuth(phone, 'verify_expired', null, req);
      return res.status(401).json({ success: false, error: '인증번호가 만료됐습니다. 다시 발송해 주세요.', code: 'OTP_EXPIRED' });
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      // 시도 한계 초과 → 무효화
      await supabase.from('auth_otp_codes').update({ used: true }).eq('id', otp.id);
      logAuth(phone, 'verify_fail', null, req);
      return res.status(401).json({ success: false, error: '시도 한도 초과. 인증번호를 다시 발송해 주세요.', code: 'OTP_LOCKED' });
    }
    // 검증
    const expected = hashCode(code);
    const ok = otp.code_hash.length === expected.length &&
      require('crypto').timingSafeEqual(Buffer.from(otp.code_hash), Buffer.from(expected));
    if (!ok) {
      await supabase.from('auth_otp_codes').update({ attempts: otp.attempts + 1 }).eq('id', otp.id);
      logAuth(phone, 'verify_fail', null, req);
      return res.status(401).json({ success: false, error: '인증번호가 올바르지 않습니다', code: 'OTP_WRONG' });
    }
    // 성공 — used 마킹
    await supabase.from('auth_otp_codes').update({ used: true }).eq('id', otp.id);
    // 사용자 조회 + last_login_at 갱신
    const { data: u } = await supabase.from('admin_users')
      .select('id, phone_e164, role, name, status').eq('phone_e164', phone).maybeSingle();
    if (!u || u.status !== 'active') {
      logAuth(phone, 'verify_fail', null, req);
      return res.status(403).json({ success: false, error: '계정이 활성화되어 있지 않습니다' });
    }
    await supabase.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', u.id);
    const token = signJwt({ sub: u.id, phone: u.phone_e164, role: u.role, name: u.name });
    logAuth(phone, 'verify_ok', u.id, req);
    res.json({ success: true, token, user: { id: u.id, phone: u.phone_e164, role: u.role, name: u.name }, expires_in_sec: JWT_TTL_SEC });
  } catch (e) {
    console.error('verify-otp error:', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
app.get('/api/auth/me', authRequired, async (req, res) => {
  // hero_image_url을 함께 반환 (홈 hero 배경에 활용)
  let heroImageUrl = null;
  try {
    const { data: u } = await supabase.from('admin_users')
      .select('hero_image_url').eq('id', req.user.id).maybeSingle();
    heroImageUrl = (u && u.hero_image_url) || null;
  } catch (e) { /* optional column, ignore */ }
  res.json({
    success: true,
    user: {
      id: req.user.id,
      phone: req.user.phone_e164,
      role: req.user.role,
      name: req.user.name,
      hero_image_url: heroImageUrl
    }
  });
});

// ── 홈 화면 사진 hero 업로드/제거 ────────────────────────────
// POST /api/user/hero-image — body: { imageBase64, imageMime }
app.post('/api/user/hero-image', authRequired, ownerOnly, async (req, res) => {
  try {
    const { imageBase64, imageMime } = req.body || {};
    if (!imageBase64 || !imageMime) {
      return res.status(400).json({ success: false, error: '이미지 데이터 필수' });
    }
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(imageMime)) {
      return res.status(400).json({ success: false, error: '지원되지 않는 형식 (jpeg/png/webp/heic/heif)' });
    }
    const buf = Buffer.from(imageBase64, 'base64');
    if (buf.length > 5 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: '이미지 5MB 이하' });
    }
    const ext = imageMime.split('/')[1].replace('jpeg', 'jpg');
    // 사장님당 1장만 유지 — 고정 파일명 + upsert
    const filePath = `${req.user.id}/hero.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('ssak-hero-images')
      .upload(filePath, buf, { contentType: imageMime, upsert: true });
    if (upErr) {
      console.error('hero upload error:', upErr.message);
      return res.status(500).json({ success: false, error: '업로드 실패' });
    }
    const { data: pub } = supabase.storage.from('ssak-hero-images').getPublicUrl(filePath);
    // 캐시 무효화 → ?v=timestamp 추가
    const url = (pub && pub.publicUrl) + '?v=' + Date.now();
    await supabase.from('admin_users').update({ hero_image_url: url }).eq('id', req.user.id);
    res.json({ success: true, url });
  } catch (e) {
    console.error('POST /api/user/hero-image error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/user/hero-image — 본인 hero 제거
app.delete('/api/user/hero-image', authRequired, ownerOnly, async (req, res) => {
  try {
    // 모든 확장자 시도 — 어떤 게 저장됐는지 모름
    const exts = ['jpg', 'png', 'webp', 'heic', 'heif'];
    const paths = exts.map(e => `${req.user.id}/hero.${e}`);
    await supabase.storage.from('ssak-hero-images').remove(paths);
    await supabase.from('admin_users').update({ hero_image_url: null }).eq('id', req.user.id);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/user/hero-image error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 신뢰 기기 (Trusted Device) — 자동 로그인 (선택적, 30일)
// 사장님/권한자가 "이 기기에서 자동 로그인" 체크 시 device_token 발급.
// 다음 방문 때 OTP/PIN 입력 없이 JWT 자동 발급.
// ════════════════════════════════════════════════════════════════
const TRUSTED_DEVICE_TTL_SEC = 30 * 24 * 60 * 60;  // 30일

function genDeviceToken() {
  return require('crypto').randomBytes(32).toString('base64url');
}

function hashDeviceToken(token) {
  return require('crypto').createHash('sha256').update(String(token)).digest('hex');
}

function deviceNameFromUA(ua) {
  ua = String(ua || '');
  let device = '기기', browser = '';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua)) device = 'Android';
  else if (/Macintosh/i.test(ua)) device = 'Mac';
  else if (/Windows/i.test(ua)) device = 'Windows';
  if (/CriOS|Chrome/i.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua)) browser = 'Safari';
  else if (/Edg/i.test(ua)) browser = 'Edge';
  return browser ? `${device} · ${browser}` : device;
}

// POST /api/auth/trust-device — 현재 JWT 사용자의 기기를 30일 신뢰 등록
app.post('/api/auth/trust-device', authRequired, async (req, res) => {
  try {
    const token = genDeviceToken();
    const tokenHash = hashDeviceToken(token);
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_SEC * 1000).toISOString();
    const deviceName = deviceNameFromUA(req.headers['user-agent']);
    const { error } = await supabase.from('trusted_devices').insert([{
      user_id: req.user.id,
      device_token_hash: tokenHash,
      device_name: deviceName,
      expires_at: expiresAt
    }]);
    if (error) return res.status(500).json({ success: false, error: error.message });
    // token 평문은 클라이언트가 localStorage 저장. 서버는 해시만 보관.
    res.json({ success: true, device_token: token, expires_at: expiresAt, device_name: deviceName });
  } catch (e) {
    console.error('trust-device error:', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// POST /api/auth/auto-login — device_token으로 인증번호/PIN 없이 JWT 발급
// body: { device_token }
app.post('/api/auth/auto-login', async (req, res) => {
  try {
    const token = String(req.body.device_token || '').trim();
    if (!token || token.length < 20) {
      return res.status(400).json({ success: false, error: 'device_token 필요', code: 'DEVICE_TOKEN_REQUIRED' });
    }
    const tokenHash = hashDeviceToken(token);
    const { data: dev } = await supabase.from('trusted_devices')
      .select('id, user_id, expires_at')
      .eq('device_token_hash', tokenHash).maybeSingle();
    if (!dev) {
      return res.status(401).json({ success: false, error: '신뢰되지 않은 기기', code: 'DEVICE_UNKNOWN' });
    }
    if (new Date(dev.expires_at).getTime() < Date.now()) {
      await supabase.from('trusted_devices').delete().eq('id', dev.id);
      return res.status(401).json({ success: false, error: '기기 인증 만료. 인증번호로 다시 로그인해 주세요.', code: 'DEVICE_EXPIRED' });
    }
    const { data: u } = await supabase.from('admin_users')
      .select('id, phone_e164, role, name, status').eq('id', dev.user_id).maybeSingle();
    if (!u || u.status !== 'active') {
      return res.status(403).json({ success: false, error: '계정이 비활성화됐습니다', code: 'USER_DISABLED' });
    }
    // 사용 시각 갱신
    await supabase.from('trusted_devices').update({ last_used_at: new Date().toISOString() }).eq('id', dev.id);
    await supabase.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', u.id);
    try { logAuth(u.phone_e164, 'auto_login_ok', u.id, req); } catch (_) {}
    const jwt = signJwt({ sub: u.id, phone: u.phone_e164, role: u.role, name: u.name });
    res.json({ success: true, token: jwt, user: { id: u.id, phone: u.phone_e164, role: u.role, name: u.name }, expires_in_sec: JWT_TTL_SEC });
  } catch (e) {
    console.error('auto-login error:', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// GET /api/auth/trust-devices — 본인 신뢰 기기 목록
app.get('/api/auth/trust-devices', authRequired, async (req, res) => {
  try {
    const { data, error } = await supabase.from('trusted_devices')
      .select('id, device_name, last_used_at, expires_at, created_at')
      .eq('user_id', req.user.id)
      .gt('expires_at', new Date().toISOString())
      .order('last_used_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// DELETE /api/auth/trust-devices/:id — 본인 신뢰 기기 제거
app.delete('/api/auth/trust-devices/:id', authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: '잘못된 id' });
    const { error } = await supabase.from('trusted_devices')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ════════════════════════════════════════════════════════════════
// PIN 빠른 로그인 (SMS 비용 절감 / 매번 OTP 받는 불편 해소)
// ════════════════════════════════════════════════════════════════
function hashPinPbkdf2(pin, saltHex) {
  return require('crypto').pbkdf2Sync(pin, Buffer.from(saltHex, 'hex'), 100000, 32, 'sha256').toString('hex');
}
function genSaltHex() {
  return require('crypto').randomBytes(16).toString('hex');
}

// GET /api/auth/pin-status?phone=01012345678
// 사용자가 PIN 설정되어 있는지 확인 (login.html이 UI 분기)
// 정보 노출 최소화: PIN 미설정/사용자 미등록은 동일 응답
app.get('/api/auth/pin-status', async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || '');
    if (!phone || !/^\+82\d{9,11}$/.test(phone)) {
      return res.json({ success: true, has_pin: false });
    }
    const { data: u } = await supabase.from('admin_users')
      .select('pin_hash, pin_locked_until, status').eq('phone_e164', phone).maybeSingle();
    if (!u || u.status !== 'active') {
      return res.json({ success: true, has_pin: false });
    }
    const locked = u.pin_locked_until && new Date(u.pin_locked_until).getTime() > Date.now();
    res.json({
      success: true,
      has_pin: !!u.pin_hash,
      locked: locked,
      locked_until: locked ? u.pin_locked_until : null
    });
  } catch (e) {
    console.error('pin-status error:', e.message);
    res.json({ success: true, has_pin: false });
  }
});

// POST /api/auth/pin/verify { phone, pin } → JWT 발급 (SMS 없이)
app.post('/api/auth/pin/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const pin = String(req.body.pin || '').trim();
    if (!phone || !/^\+82\d{9,11}$/.test(phone)) {
      return res.status(400).json({ success: false, error: '휴대폰 번호 확인' });
    }
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ success: false, error: '4자리 숫자 PIN' });
    }
    const { data: u } = await supabase.from('admin_users')
      .select('id, phone_e164, role, name, status, pin_hash, pin_salt, pin_attempts, pin_locked_until')
      .eq('phone_e164', phone).maybeSingle();
    if (!u || u.status !== 'active' || !u.pin_hash || !u.pin_salt) {
      logAuth(phone, 'verify_fail', null, req);
      return res.status(401).json({ success: false, error: 'PIN 로그인이 설정되지 않았습니다. SMS로 로그인 후 PIN을 설정하세요.', code: 'PIN_NOT_SET' });
    }
    // 잠금 확인
    if (u.pin_locked_until && new Date(u.pin_locked_until).getTime() > Date.now()) {
      const remainMin = Math.ceil((new Date(u.pin_locked_until).getTime() - Date.now()) / 60000);
      return res.status(429).json({ success: false, error: `PIN 잠금. ${remainMin}분 후 또는 SMS 인증으로 재로그인`, code: 'PIN_LOCKED' });
    }
    // 검증
    const expected = hashPinPbkdf2(pin, u.pin_salt);
    const ok = expected.length === u.pin_hash.length &&
      require('crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(u.pin_hash));
    if (!ok) {
      const newCount = (u.pin_attempts || 0) + 1;
      const patch = { pin_attempts: newCount };
      // 5회 연속 실패 시 30분 잠금
      if (newCount >= 5) {
        patch.pin_locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      }
      await supabase.from('admin_users').update(patch).eq('id', u.id);
      logAuth(phone, 'verify_fail', u.id, req);
      const remaining = 5 - newCount;
      return res.status(401).json({
        success: false,
        error: newCount >= 5
          ? 'PIN 5회 실패. 30분간 잠금. SMS로 재로그인하세요.'
          : `PIN 불일치. 남은 시도 ${remaining}회.`,
        code: newCount >= 5 ? 'PIN_LOCKED_NOW' : 'PIN_WRONG'
      });
    }
    // 성공 — 시도 횟수 리셋 + JWT 발급
    await supabase.from('admin_users').update({
      pin_attempts: 0, pin_locked_until: null,
      last_login_at: new Date().toISOString()
    }).eq('id', u.id);
    const token = signJwt({ sub: u.id, phone: u.phone_e164, role: u.role, name: u.name });
    logAuth(phone, 'verify_ok', u.id, req);
    res.json({ success: true, token, user: { id: u.id, phone: u.phone_e164, role: u.role, name: u.name }, method: 'pin' });
  } catch (e) {
    console.error('pin verify error:', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// POST /api/auth/pin/setup { pin } — JWT 인증된 사용자만 PIN 설정/변경
app.post('/api/auth/pin/setup', authRequired, async (req, res) => {
  try {
    const pin = String(req.body.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, error: '4자리 숫자' });
    // 너무 단순한 PIN 방지
    if (/^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '0000' || pin === '1111') {
      return res.status(400).json({ success: false, error: '너무 단순한 PIN (1234, 0000, 1111 등 금지)' });
    }
    const salt = genSaltHex();
    const hash = hashPinPbkdf2(pin, salt);
    const { error } = await supabase.from('admin_users').update({
      pin_hash: hash, pin_salt: salt, pin_set_at: new Date().toISOString(),
      pin_attempts: 0, pin_locked_until: null
    }).eq('id', req.user.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, message: 'PIN 설정 완료' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/auth/pin — PIN 비활성화 (사장님이 해제 시)
app.delete('/api/auth/pin', authRequired, async (req, res) => {
  const { error } = await supabase.from('admin_users').update({
    pin_hash: null, pin_salt: null, pin_set_at: null,
    pin_attempts: 0, pin_locked_until: null
  }).eq('id', req.user.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, message: 'PIN 해제' });
});

// ── 관리자 — 화이트리스트 관리 ────────────────────────────────
// GET /api/admin/users
app.get('/api/admin/users', authRequired, ownerOnly, async (req, res) => {
  const { data, error } = await supabase.from('admin_users')
    .select('id, phone_e164, role, name, status, approved_at, last_login_at, created_at')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

// POST /api/admin/users { phone, name }
app.post('/api/admin/users', authRequired, ownerOnly, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 40);
  const notify = req.body.notify === true;  // 안내 SMS 자동 발송 여부
  if (!phone || !/^\+82\d{9,11}$/.test(phone)) {
    return res.status(400).json({ success: false, error: '휴대폰 번호를 정확히 입력해 주세요' });
  }
  const { data, error } = await supabase.from('admin_users').insert({
    phone_e164: phone, role: 'approved', name: name || null,
    status: 'active', approved_by: req.user.id, approved_at: new Date().toISOString()
  }).select('id, phone_e164, role, name, status').maybeSingle();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: '이미 등록된 번호입니다' });
    return res.status(500).json({ success: false, error: error.message });
  }
  // 안내 SMS 발송 (옵션) — fire-and-forget
  let sms_sent = false;
  if (notify) {
    const greet = name ? `${name}님 안녕하세요.` : '안녕하세요.';
    const msg = `[싹싹]\n${greet}\n${req.user.name || '관리자'}님이 싹싹 앱 접근 권한을 부여하셨습니다.\n\n▶ 접속: https://ssakapp.co.kr/login.html\n\n첫 로그인 시 인증번호 1회 입력 후,\n다음번부터는 PIN 또는 자동 로그인으로 빠르게 들어오실 수 있어요.`;
    try {
      const r = await sendSMSUtil(phone.replace(/^\+82/, '0'), msg, null, { type: 'general', customerName: name || '권한자' });
      sms_sent = !!r.ok;
    } catch (e) { console.warn('admin user invite SMS error:', e.message); }
  }
  res.json({ success: true, data, sms_sent });
});

// PATCH /api/admin/users/:id  { status?, name? }
app.patch('/api/admin/users/:id', authRequired, ownerOnly, async (req, res) => {
  const id = req.params.id;
  const patch = {};
  if (req.body.status === 'active' || req.body.status === 'disabled') patch.status = req.body.status;
  if (typeof req.body.name === 'string') patch.name = req.body.name.trim().slice(0, 40);
  if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: '변경할 값이 없습니다' });
  // owner 자기 자신을 disabled 시키는 것 방지
  if (id === req.user.id && patch.status === 'disabled') {
    return res.status(400).json({ success: false, error: '본인 계정은 비활성화할 수 없습니다' });
  }
  const { data, error } = await supabase.from('admin_users').update(patch).eq('id', id)
    .select('id, phone_e164, role, name, status').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', authRequired, ownerOnly, async (req, res) => {
  const id = req.params.id;
  if (id === req.user.id) return res.status(400).json({ success: false, error: '본인 계정은 삭제할 수 없습니다' });
  // owner 보호: 마지막 owner 삭제 방지
  const { data: target } = await supabase.from('admin_users').select('role').eq('id', id).maybeSingle();
  if (target && target.role === 'owner') {
    const { count } = await supabase.from('admin_users').select('id', { count: 'exact', head: true }).eq('role', 'owner').eq('status', 'active');
    if ((count || 0) <= 1) return res.status(400).json({ success: false, error: '마지막 관리자는 삭제할 수 없습니다' });
  }
  const { error } = await supabase.from('admin_users').delete().eq('id', id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

// POST /api/admin/users/:id/pin-setup { pin } — 베타 모드: 관리자가 사용자에게 초기 PIN 설정
// SMS 인증 없이 신규 사용자가 PIN으로 바로 로그인 가능 (chicken-and-egg 해결)
app.post('/api/admin/users/:id/pin-setup', authRequired, ownerOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const pin = String(req.body.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, error: '4자리 숫자 PIN' });
    if (/^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '0000' || pin === '1111') {
      return res.status(400).json({ success: false, error: '너무 단순한 PIN (1234, 0000, 1111 등 금지)' });
    }
    // 대상 사용자 검증
    const { data: target } = await supabase.from('admin_users').select('id, phone_e164, status').eq('id', id).maybeSingle();
    if (!target) return res.status(404).json({ success: false, error: '사용자 없음' });
    if (target.status !== 'active') return res.status(400).json({ success: false, error: '비활성 사용자' });

    const salt = genSaltHex();
    const hash = hashPinPbkdf2(pin, salt);
    const { error } = await supabase.from('admin_users').update({
      pin_hash: hash, pin_salt: salt, pin_set_at: new Date().toISOString(),
      pin_attempts: 0, pin_locked_until: null
    }).eq('id', id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    try { logAuth(target.phone_e164, 'admin_set_pin', id, req); } catch (_) {}
    res.json({ success: true, message: 'PIN 설정 완료', phone: target.phone_e164 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/admin/users/:id/pin — 관리자가 사용자 PIN 강제 해제 (분실 시)
app.delete('/api/admin/users/:id/pin', authRequired, ownerOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const { error } = await supabase.from('admin_users').update({
      pin_hash: null, pin_salt: null, pin_set_at: null,
      pin_attempts: 0, pin_locked_until: null
    }).eq('id', id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, message: 'PIN 해제 완료' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/admin/login-log?limit=50
app.get('/api/admin/login-log', authRequired, ownerOnly, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50') || 50, 200);
  const { data, error } = await supabase.from('auth_login_log')
    .select('id, phone_e164, user_id, outcome, ip, user_agent, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

// ════════════════════════════════════════════════════════════════
// (위 인증 인프라는 추가 — 기존 라우트는 다음 단계에서 미들웨어 적용)

// ── 서버 상태 확인 ──────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '싹싹 서버 정상 작동 중 🧹',
    version: '1.0.0'
  });
});

// ── 구독자 사전 신청 ────────────────────────────
// 랜딩페이지에서 사전 신청 시 호출
app.post('/api/subscribe', async (req, res) => {
  const { company_name, phone, email, plan } = req.body;

  if (!company_name || !phone) {
    return res.status(400).json({ success: false, error: '업체명과 연락처는 필수입니다' });
  }

  try {
    // 중복 체크
    const { data: existing } = await supabase
      .from('subscribers')
      .select('id')
      .eq('phone', phone)
      .single();

    if (existing) {
      return res.json({ success: true, message: '이미 신청하셨습니다!', duplicate: true });
    }

    // 구독자 저장
    const { data: subscriber, error } = await supabase
      .from('subscribers')
      .insert([{
        company_name,
        phone,
        email: email || null,
        plan: plan || 'standard',
        status: 'pending',
      }])
      .select()
      .single();

    if (error) throw error;

    // 기본 업체 설정 자동 생성
    await supabase
      .from('business_settings')
      .insert([{
        subscriber_id: subscriber.id,
        company_name,
        phone,
        greeting: `안녕하세요! 😊 ${company_name} 입주청소 전문팀입니다.`,
      }]);

    res.json({
      success: true,
      message: '신청이 완료되었습니다! 출시 시 연락드릴게요 😊',
      id: subscriber.id
    });

  } catch (err) {
    console.error('구독 신청 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다' });
  }
});

// ── 구독자 목록 조회 (관리자용) ─────────────────
app.get('/api/subscribers', authRequired, ownerOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscribers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, count: data.length, data });

  } catch (err) {
    console.error('구독자 조회 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 구독자 상태 변경 (관리자용) ─────────────────
app.put('/api/subscribers/:id/status', authRequired, ownerOnly, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'active', 'paused', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, error: '유효하지 않은 상태값입니다' });
  }

  try {
    const { data, error } = await supabase
      .from('subscribers')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });

  } catch (err) {
    console.error('상태 변경 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 업체 설정 조회 ───────────────────────────────
app.get('/api/settings/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('business_settings')
      .select('*')
      .eq('subscriber_id', id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });

  } catch (err) {
    console.error('설정 조회 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 업체 설정 업데이트 ───────────────────────────
app.put('/api/settings/:id', async (req, res) => {
  const { id } = req.params;
  const settings = req.body;

  try {
    const { data, error } = await supabase
      .from('business_settings')
      .update(settings)
      .eq('subscriber_id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });

  } catch (err) {
    console.error('설정 업데이트 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 인력 풀 목록 조회 ───────────────────────────
app.get('/api/workforce', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscribers')
      .select('id, company_name, phone, plan, status, created_at')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, count: data.length, data });

  } catch (err) {
    console.error('인력 풀 조회 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 통계 (관리자용) ──────────────────────────────
app.get('/api/stats', authRequired, ownerOnly, async (req, res) => {
  try {
    const { data: all } = await supabase.from('subscribers').select('status, plan');

    const stats = {
      total: all.length,
      pending: all.filter(s => s.status === 'pending').length,
      active: all.filter(s => s.status === 'active').length,
      by_plan: {
        basic: all.filter(s => s.plan === 'basic').length,
        standard: all.filter(s => s.plan === 'standard').length,
        premium: all.filter(s => s.plan === 'premium').length,
      }
    };

    res.json({ success: true, stats });

  } catch (err) {
    console.error('통계 조회 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 사장님 홈용 월간 통계 (이달 완료/매출/확정 + 지난달 매출 비교) ──
app.get('/api/stats/monthly', authRequired, ownerOnly, async (req, res) => {
  try {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(); // 0-indexed
    const pad = n => String(n).padStart(2, '0');
    const thisMonthStart = `${y}-${pad(m + 1)}-01`;
    const nextY = m === 11 ? y + 1 : y;
    const nextM = (m + 1) % 12;
    const nextMonthStart = `${nextY}-${pad(nextM + 1)}-01`;
    const lastY = m === 0 ? y - 1 : y;
    const lastM = (m + 11) % 12;
    const lastMonthStart = `${lastY}-${pad(lastM + 1)}-01`;

    // 이달 + 지난달 booking을 한 번에 조회 (date 범위로 RLS 부담 ↓)
    const { data, error } = await supabase
      .from('bookings')
      .select('status, price, date')
      .gte('date', lastMonthStart)
      .lt('date', nextMonthStart);
    if (error) throw error;

    let done = 0, revenue = 0, confirmed = 0, lastRevenue = 0;
    (data || []).forEach(b => {
      const isThisMonth = b.date >= thisMonthStart && b.date < nextMonthStart;
      const isLastMonth = b.date >= lastMonthStart && b.date < thisMonthStart;
      const price = parseInt(b.price) || 0;
      if (isThisMonth) {
        if (b.status === 'completed' || b.status === 'done') { done++; revenue += price; }
        if (b.status === 'confirmed') confirmed++;
      } else if (isLastMonth) {
        if (b.status === 'completed' || b.status === 'done') lastRevenue += price;
      }
    });

    // 지난달 매출이 0이면 비교 의미 없음 → null
    const revenue_change_pct = lastRevenue > 0
      ? Math.round(((revenue - lastRevenue) / lastRevenue) * 100)
      : null;

    res.json({
      success: true,
      done, revenue, confirmed,
      revenue_change_pct,
      last_month_revenue: lastRevenue
    });
  } catch (err) {
    console.error('월간 통계 오류:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SMS 발송 (CoolSMS) ────────────────────────
app.post('/api/sms/send', authRequired, async (req, res) => {
  // ── 보안 강화: origin 검증 (curl/Postman 등 서버사이드 호출 차단) ──
  // CORS 화이트리스트가 origin 없는 요청을 허용하므로 라우트 단에서 추가 검증.
  // 브라우저는 origin 자동 설정 → 위조 불가. 서버사이드 호출자는 origin 없음 → 차단.
  const origin = req.headers.origin || req.headers.referer || '';
  const allowedHosts = ['ssakapp.co.kr', 'localhost', '127.0.0.1'];
  const isAllowed = origin && allowedHosts.some(h => origin.includes(h));
  if (!isAllowed) {
    console.warn(`sms/send: blocked origin: ${origin || '(no-origin)'}`);
    return res.status(403).json({ success: false, error: '허용되지 않은 출처에서 호출됐습니다.' });
  }

  const { to, msg, subject } = req.body;

  // 환경변수에서 API 키 로드 (사용자에게 노출 안 됨)
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_FROM;

  if (!apiKey || !apiSecret || !from) {
    return res.status(500).json({ success: false, error: 'SMS API가 설정되지 않았습니다.' });
  }
  if (!to || !msg) {
    return res.status(400).json({ success: false, error: '수신번호와 메시지는 필수입니다' });
  }

  try {
    const crypto = require('crypto');
    const date = new Date().toISOString();
    const salt = Math.random().toString(36).substring(2, 12);
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(date + salt)
      .digest('hex');

    const msgType = Buffer.byteLength(msg, 'utf8') > 90 ? 'LMS' : 'SMS';

    const response = await fetch('https://api.coolsms.co.kr/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`
      },
      body: JSON.stringify({
        message: {
          to: to.replace(/-/g, ''),
          from: from.replace(/-/g, ''),
          text: msg,
          type: msgType,
          // LMS: subject를 공백(' ')으로 명시 설정
          // → CoolSMS가 첫 줄을 subject로 자동추출하는 것을 막음
          // → [Web발신] 앞에 아무 내용도 표시되지 않음 (중복 완전 제거)
          ...(msgType === 'LMS' ? { subject: ' ' } : {})
        }
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log(`SMS 발송 완료: ${to} (${msgType})`);

      // 발송이력 저장 (실패해도 응답 차단 안 함)
      // 본문에서 type 추론: [Web발신] 다음 머리말로 분류
      const inferType = (() => {
        const m = msg.replace(/^\[Web발신\][\s\n]*/, '');
        if (/계약서|서명/.test(m)) return 'contract';
        if (/완료\s*보고서|시공\s*완료/.test(m)) return 'report';
        if (/견적|예상\s*금액|금액\s*안내/.test(m)) return 'quote';
        return 'general';
      })();
      const meta = req.body.meta || null;
      const customerName = req.body.customer_name || req.body.customerName || null;
      const sentBy = req.body.sent_by || req.headers['x-anon-id'] || null;
      supabase.from('sms_history').insert({
        type: inferType,
        to_phone: to.replace(/-/g, ''),
        customer_name: customerName,
        subject: subject || null,
        msg: msg,
        meta: meta,
        sent_by: sentBy
      }).then(({ error: histErr }) => {
        if (histErr) console.error('sms_history insert error:', histErr.message);
      });

      res.json({ success: true, message: '발송 완료', type: msgType });
    } else {
      console.error('SMS 발송 실패:', data);
      res.status(400).json({ success: false, error: data.errorMessage || '발송 실패' });
    }

  } catch (err) {
    console.error('SMS 발송 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다' });
  }
});

// ── 발송이력 조회 (origin 검증) ─────────────────────────────
app.get('/api/sms-history', async (req, res) => {
  const origin = req.headers.origin || req.headers.referer || '';
  const allowedHosts = ['ssakapp.co.kr', 'localhost', '127.0.0.1'];
  const isAllowed = origin && allowedHosts.some(h => origin.includes(h));
  if (!isAllowed) return res.status(403).json({ success: false, error: '허용되지 않은 출처' });

  try {
    const { phone, type, limit } = req.query;
    let q = supabase.from('sms_history').select('*').order('sent_at', { ascending: false });
    if (phone) q = q.eq('to_phone', String(phone).replace(/-/g, ''));
    if (type)  q = q.eq('type', type);
    q = q.limit(Math.min(parseInt(limit) || 50, 200));
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SMS 발송 공통 함수 ───────────────────────────
// subject 미설정 시 CoolSMS가 본문 첫 줄을 자동 추출 → [Web발신] 앞뒤 중복 원인
async function sendSMSUtil(to, msg, subject, opts = {}) {
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_FROM;
  if (!apiKey || !apiSecret || !from) return { ok: false, error: 'SMS API 미설정' };

  const crypto = require('crypto');
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  const msgType = Buffer.byteLength(msg, 'utf8') > 90 ? 'LMS' : 'SMS';

  // LMS일 때만 subject 포함 (subject 없으면 본문 첫줄이 제목으로 자동 추출됨)
  const msgObj = { to: to.replace(/-/g,''), from: from.replace(/-/g,''), text: msg, type: msgType };
  if (msgType === 'LMS' && subject) msgObj.subject = subject.slice(0, 20);

  const response = await fetch('https://api.coolsms.co.kr/messages/v4/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`
    },
    body: JSON.stringify({ message: msgObj })
  });

  // 발송 성공 시 sms_history 자동 저장 (opts.type/customerName/meta/sentBy 옵셔널)
  if (response.ok) {
    supabase.from('sms_history').insert({
      type: opts.type || 'general',
      to_phone: to.replace(/-/g, ''),
      customer_name: opts.customerName || null,
      subject: subject || null,
      msg: msg,
      meta: opts.meta || null,
      sent_by: opts.sentBy || null
    }).then(({ error: histErr }) => {
      if (histErr) console.error('sms_history insert error (sendSMSUtil):', histErr.message);
    });
  }
  return response.ok ? { ok: true } : { ok: false, error: (await response.json()).errorMessage };
}

// ── 계약서 / 완료보고서 PDF 업로드 & SMS 발송 ─────────
// body.type: 'contract' (기본) | 'report' — SMS 본문 분기
app.post('/api/contract/upload', async (req, res) => {
  const { pdfBase64, customerPhone, ownerPhone, customerName, companyName, companyPhone, type } = req.body;
  const docType = type === 'report' ? 'report' : 'contract';
  const docLabel = docType === 'report' ? '완료보고서' : '계약서';

  if (!pdfBase64 || !customerPhone) {
    return res.status(400).json({ success: false, error: '필수 데이터가 없습니다' });
  }

  try {
    // base64 → Buffer 변환
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const timestamp = Date.now();
    const fileName = `${timestamp}_${customerPhone.replace(/-/g,'')}.pdf`;
    const filePath = `contracts/${fileName}`;

    // Supabase Storage 업로드 (Private 버킷 — 계약서 PDF는 개인정보 포함)
    const { error: uploadError } = await supabase.storage
      .from('ssak-contracts-private')
      .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (uploadError) throw uploadError;

    // Signed URL 생성 (7일 만료 — 개인정보보호법 제29조 부합)
    const { data: urlData, error: signError } = await supabase.storage
      .from('ssak-contracts-private')
      .createSignedUrl(filePath, 7 * 24 * 60 * 60);
    if (signError) throw signError;

    const pdfUrl = urlData.signedUrl;

    // 견적 톤 기준 통일 SMS 본문 (사장님 D2 A 결정)
    const intro = docType === 'report'
      ? '시공이 완료되어 보고서를 보내드립니다.'
      : '계약서가 작성되어 보내드립니다.';

    const customerMsg = `안녕하세요, ${customerName||'고객'}님!
${companyName||'서프로클린'} 입주청소입니다.

━━━━ ${docLabel} 안내 ━━━━
${intro}
아래 링크에서 확인하시고 보관해 주세요.
━━━━━━━━━━━━━━

📎 ${docLabel} PDF: ${pdfUrl}
${companyPhone ? `\n📞 문의: ${companyPhone}` : ''}`;

    const ownerMsg = `📋 ${docLabel} 발송 완료
고객: ${customerName||'고객'}님 (${customerPhone})

PDF 링크:
${pdfUrl}`;

    // 고객 SMS 발송
    await sendSMSUtil(customerPhone, customerMsg, null, { type: docType, customerName });

    // 사장님 SMS 발송 (번호가 있고 고객과 다를 때)
    if (ownerPhone && ownerPhone.replace(/-/g,'') !== customerPhone.replace(/-/g,'')) {
      await sendSMSUtil(ownerPhone, ownerMsg, null, { type: docType, customerName });
    }

    console.log(`${docLabel} 업로드 완료: ${filePath}`);
    res.json({ success: true, pdfUrl });

  } catch (err) {
    console.error('계약서 업로드 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류: ' + err.message });
  }
});

// ── 비대면 계약서: 저장 & 서명링크 발송 ──────────────
app.post('/api/contract/create', async (req, res) => {
  // sign.html 개별 필드 방식 + 구버전 contractData 방식 모두 지원
  const body = req.body;

  // 개별 필드 방식 (새 sign.html)
  const customerPhone  = body.customer_phone || body.customerPhone || '';
  const customerName   = body.customer_name  || body.customerName  || '';
  const companyName    = body.company_name   || body.companyName   || '서프로클린';
  const companyPhone   = body.owner_phone    || body.companyPhone  || '';
  const ownerSignature = body.owner_signature|| body.ownerSignature|| null;
  const adminKey       = body.admin_key      || '';

  // 보안: admin_key 검증 (strict 모드)
  // 2026-05-16: 호환 모드 제거 — 인증 없는 contract/create 차단
  // Railway 환경변수 ADMIN_KEY 와 클라이언트가 보낸 admin_key 가 일치해야 통과
  if (!process.env.ADMIN_KEY) {
    console.error('contract/create: FATAL Railway ADMIN_KEY env var not set');
    return res.status(500).json({ success: false, error: '서버 설정 오류: ADMIN_KEY 환경변수 미설정 (Railway Variables에 추가 필요)' });
  }
  if (!adminKey) {
    console.warn('contract/create: blocked — admin_key missing');
    return res.status(401).json({ success: false, error: 'ADMIN_KEY가 필요합니다. 싹싹 앱 설정 → ADMIN_KEY 항목에 Railway와 동일한 값을 입력해 주세요.' });
  }
  if (adminKey !== process.env.ADMIN_KEY) {
    console.warn('contract/create: blocked — admin_key mismatch');
    return res.status(401).json({ success: false, error: '인증 실패 — 설정의 ADMIN_KEY가 Railway 환경변수와 다릅니다.' });
  }

  if (!customerPhone) {
    return res.status(400).json({ success: false, error: '고객 연락처가 없습니다' });
  }

  // contract_data 구성 (개별 필드 → 통합 객체)
  const contractData = body.contractData || {
    name:         customerName,
    phone:        customerPhone,
    addr:         body.address       || '',
    type:         body.service_type  || '',
    size:         body.size          || '',
    companyName:  companyName,
    companyPhone: companyPhone,
    owner:        body.owner         || '',
    workDateStr:  body.service_date  || '',
    base:         body.base          || 0,
    vat:          body.vat           || 0,
    total:        body.total         || body.price || 0,
    deposit:      body.deposit       || 0,
    balance:      body.balance       || 0,
    extra:        body.extra         || '',
    extraTotal:   body.extra_total   || 0,
    memo:         body.memo          || '',
    isCash:       body.is_cash       || false,
    contractNum:  body.contract_num  || '',
    dateStr:      new Date().toLocaleDateString('ko-KR'),
  };

  try {
    const crypto = require('crypto');
    const token = crypto.randomBytes(20).toString('hex');

    const { error } = await supabase.from('pending_contracts').insert([{
      token,
      contract_data: contractData,
      owner_signature: ownerSignature,
      status: 'pending'
    }]);
    if (error) throw error;

    // 서명 URL: ssakapp.co.kr 기준
    const signUrl = `https://ssakapp.co.kr/sign.html?token=${token}`;
    const msg = `안녕하세요, ${customerName||'고객'}님!
${companyName||'서프로클린'} 입주청소입니다.

━━━━ 계약서 서명 안내 ━━━━
계약 진행을 위해 아래 링크에서
서명을 부탁드립니다.
링크는 7일간 유효합니다.
━━━━━━━━━━━━━━

✍️ 서명 링크: ${signUrl}
${companyPhone ? `\n📞 문의: ${companyPhone}` : ''}`;

    await sendSMSUtil(customerPhone.replace(/-/g,''), msg, `[${companyName}] 계약서 서명요청`, {
      type: 'contract',
      customerName: customerName || null,
      meta: { token, signUrl, stage: 'create' }
    });

    console.log(`계약서 생성: ${token} / ${customerName} (${customerPhone})`);
    res.json({ success: true, token, signUrl });
  } catch (err) {
    console.error('계약서 생성 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류: ' + err.message });
  }
});

// ── 비대면 계약서: 고객 조회 ─────────────────────────
app.get('/api/contract/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { data, error } = await supabase.from('pending_contracts').select('*').eq('token', token).maybeSingle();
    if (error || !data) return res.status(404).json({ success: false, error: '계약서를 찾을 수 없습니다' });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ success: false, error: '만료된 계약서입니다' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ── 비대면 계약서: 고객 서명 완료 & PDF 생성 ────────────
app.post('/api/contract/:token/sign', async (req, res) => {
  const { token } = req.params;
  const { customerSignature, pdfBase64 } = req.body;
  if (!customerSignature) return res.status(400).json({ success: false, error: '서명이 없습니다' });

  try {
    const { data: contract, error } = await supabase.from('pending_contracts').select('*').eq('token', token).maybeSingle();
    if (error || !contract) return res.status(404).json({ success: false, error: '계약서를 찾을 수 없습니다' });
    if (contract.status === 'completed') return res.status(400).json({ success: false, error: '이미 서명된 계약서입니다' });

    const cd = contract.contract_data;
    let pdfUrl = null;

    // PDF 업로드
    if (pdfBase64) {
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const fileName = `${Date.now()}_${token.slice(0,8)}.pdf`;
      const filePath = `contracts/${fileName}`;
      const { error: uploadError } = await supabase.storage.from('ssak-contracts-private').upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
      if (!uploadError) {
        const { data: urlData, error: signError } = await supabase.storage
          .from('ssak-contracts-private')
          .createSignedUrl(filePath, 7 * 24 * 60 * 60);
        if (!signError) pdfUrl = urlData.signedUrl;
      }
    }

    // 상태 업데이트
    await supabase.from('pending_contracts').update({
      customer_signature: customerSignature,
      status: 'completed',
      pdf_url: pdfUrl
    }).eq('token', token);

    // 양측 SMS 발송
    const companyName = cd.companyName || '서프로클린';
    const companyPhone = cd.companyPhone || '';
    const customerName = cd.name || '고객';
    const customerPhone = cd.phone || '';
    const linkMsg = pdfUrl ? `\n\n계약서 PDF: ${pdfUrl}` : '';

    const customerMsg = `[${companyName}] 계약서 서명 완료!\n${customerName}님의 서명이 완료되었습니다.${linkMsg}\n\n문의: ${companyPhone}`;
    const ownerMsg = `[계약서 서명 완료]\n고객: ${customerName}님 (${customerPhone})\n서명이 완료되었습니다.${linkMsg}`;

    if (customerPhone) await sendSMSUtil(customerPhone.replace(/-/g,''), customerMsg, `[${companyName}] 서명 완료`, {
      type: 'contract', customerName, meta: { token, stage: 'sign-complete', pdfUrl }
    });
    if (companyPhone) await sendSMSUtil(companyPhone.replace(/-/g,''), ownerMsg, '계약서 서명 완료', {
      type: 'contract', customerName, meta: { token, stage: 'sign-complete', pdfUrl }
    });

    // Web Push 알림 (사장님이 앱 켜두면 즉시 알림 — SMS 보조)
    // PUSH_ENABLED false면 자동 no-op. 실패해도 라우트 응답 차단 안 함.
    sendPushToAll({
      title: '📄 계약서 서명 완료',
      body: `${customerName}님 (${customerPhone}) 서명이 완료됐어요`,
      url: pdfUrl || 'https://ssakapp.co.kr/schedule.html',
      icon: '/icon-192.png',
      tag: `contract-${token}`,
    }).catch(e => console.error('contract sign push error:', e.message));

    console.log(`계약서 서명 완료: ${token}`);
    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error('서명 완료 오류:', err);
    res.status(500).json({ success: false, error: '서버 오류: ' + err.message });
  }
});

// ── 스케줄 (사장님 직접 관리) ──────────────────────────────────────────────
// 본인 anon_id 기준 전체 조회 (옵션: status, from, to 날짜 필터)
app.get('/api/schedules', async (req, res) => {
  try {
    const { anon_id, status, from, to } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    let query = supabase.from('schedules')
      .select('*')
      .eq('anon_id', anon_id)
      .order('date', { ascending: true })
      .order('time', { ascending: true });

    if (status) query = query.eq('status', status);
    if (from)   query = query.gte('date', from);
    if (to)     query = query.lte('date', to);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('schedules GET error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 신규 추가
app.post('/api/schedules', authRequired, async (req, res) => {
  try {
    const { anon_id, name, phone, date, time, addr, type, size, price, memo, status, source, source_id } = req.body;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    if (!name || !phone) return res.status(400).json({ success: false, error: '이름과 연락처는 필수' });
    if (!date) return res.status(400).json({ success: false, error: '날짜는 필수' });

    const row = {
      anon_id, name, phone,
      date,
      time:   time   || '',
      addr:   addr   || '',
      type:   type   || '입주 전 청소',
      size:   size   || '',
      price:  Number(price) || 0,
      memo:   memo   || '',
      status: status || 'confirmed',
      source: source || 'manual',
      source_id: source_id || null
    };
    const { data, error } = await supabase.from('schedules').insert([row]).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('schedules POST error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 수정 (필드 부분 업데이트)
app.put('/api/schedules/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    const allowed = ['name','phone','date','time','addr','type','size','price','memo','status'];
    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = (k === 'price') ? (Number(req.body[k]) || 0) : req.body[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: '수정할 필드 없음' });
    }

    const { data, error } = await supabase.from('schedules')
      .update(patch)
      .eq('id', id)
      .eq('anon_id', anon_id)   // 본인 데이터만 수정
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('schedules PUT error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 삭제
app.delete('/api/schedules/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const anon_id = req.query.anon_id || req.body.anon_id;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    const { error } = await supabase.from('schedules')
      .delete()
      .eq('id', id)
      .eq('anon_id', anon_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('schedules DELETE error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 커뮤니티 (community)
// ══════════════════════════════════════════════════════════════════════

// 닉네임 헬퍼: anon_id로부터 결정적 닉네임 생성 (같은 anon_id는 항상 같은 닉네임)
function nicknameOf(anonId) {
  if (!anonId) return '익명';
  // anon_id의 마지막 4자를 base36 숫자로 사용 (0001~9999 범위로 매핑)
  const tail = String(anonId).slice(-4).toLowerCase();
  let n = 0;
  for (const ch of tail) n = (n * 36 + parseInt(ch, 36) || 0) | 0;
  const num = (Math.abs(n) % 9000 + 1000); // 1000~9999
  return '익명' + num;
}

// 입력 검증 헬퍼
function validateAnonId(v) { return typeof v === 'string' && v.length >= 4 && v.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(v); }
function clampStr(v, max) { return (typeof v === 'string' ? v : '').slice(0, max); }

// 1) 피드 조회 (페이지네이션 + 검색)
app.get('/api/community/posts', async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const search = clampStr(req.query.search || '', 100).trim();
    const categoryFilter = clampStr(req.query.category || '', 20).trim();

    let q = supabase.from('community_posts')
      .select('id, anon_id, author_name, category, title, content, image_url, like_count, comment_count, created_at')
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);

    if (search) {
      const pat = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      q = q.or(`title.ilike.${pat},content.ilike.${pat}`);
    }
    // 카테고리 필터 (사장님 결정 D1 B: Blind 스타일 카테고리 칩)
    if (categoryFilter && ['자유', '노하우', '구인구직', 'Q&A'].includes(categoryFilter)) {
      q = q.eq('category', categoryFilter);
    }

    const { data, error } = await q;
    if (error) throw error;

    // author_name 우선, 폴백으로 nicknameOf (구버전 backfill 데이터)
    const enriched = (data || []).map(p => ({
      ...p,
      nickname: p.author_name || nicknameOf(p.anon_id)
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('community posts GET error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2) 피드 글 작성 (이미지 base64 업로드 지원)
app.post('/api/community/posts', authRequired, async (req, res) => {
  try {
    const { anon_id, title, content, imageBase64, imageMime, author_name, category } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const t = clampStr(title || '', 100).trim();
    const c = clampStr(content || '', 2000).trim();
    if (!c) return res.status(400).json({ success: false, error: '내용은 필수' });
    // 사업장명(=display ID) 필수 + 길이 제한 (사장님 결정 D3 A: 강제 입력)
    const authorName = clampStr(author_name || '', 40).trim();
    if (!authorName) return res.status(400).json({ success: false, error: '사업장명이 필요합니다. 설정에서 입력해 주세요.' });
    // 카테고리 화이트리스트 (사장님 결정 D1 B: Blind 스타일 카테고리)
    const allowedCats = ['자유', '노하우', '구인구직', 'Q&A'];
    const cat = allowedCats.includes(category) ? category : '자유';

    let image_url = null;
    if (imageBase64 && typeof imageBase64 === 'string') {
      // 이미지 업로드 → Storage (ssak-contracts 버킷의 community/ 폴더)
      try {
        // base64 사이즈 제한 (10MB)
        if (imageBase64.length > 14 * 1024 * 1024) {
          return res.status(400).json({ success: false, error: '이미지가 너무 큽니다 (10MB 이하)' });
        }
        const mime = (typeof imageMime === 'string' && /^image\/(png|jpe?g|webp|gif)$/.test(imageMime)) ? imageMime : 'image/jpeg';
        const ext = mime.split('/')[1].replace('jpeg', 'jpg');
        const buf = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const filename = `community/${Date.now()}-${Math.random().toString(36).slice(2,9)}.${ext}`;
        const { error: upErr } = await supabase.storage.from('ssak-contracts').upload(filename, buf, { contentType: mime, upsert: false });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from('ssak-contracts').getPublicUrl(filename);
        image_url = pub.publicUrl;
      } catch (e) {
        console.error('이미지 업로드 실패:', e.message);
        // 이미지 실패해도 글은 등록 (image_url=null)
      }
    }

    const { data, error } = await supabase.from('community_posts').insert([{
      anon_id, title: t || null, content: c, image_url, category: cat, author_name: authorName
    }]).select().single();
    if (error) throw error;

    res.json({ success: true, data: { ...data, nickname: authorName } });
  } catch (err) {
    console.error('community posts POST error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3) 글 상세 + 댓글 + 내가 좋아요 했는지
app.get('/api/community/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const anon_id = String(req.query.anon_id || '');

    const { data: post, error: pErr } = await supabase.from('community_posts')
      .select('id, anon_id, author_name, category, title, content, image_url, like_count, comment_count, created_at, deleted')
      .eq('id', id).maybeSingle();
    if (pErr) throw pErr;
    if (!post || post.deleted) return res.status(404).json({ success: false, error: '글을 찾을 수 없습니다' });

    const { data: comments, error: cErr } = await supabase.from('community_comments')
      .select('id, anon_id, author_name, content, created_at')
      .eq('post_id', id).eq('deleted', false)
      .order('created_at', { ascending: true });
    if (cErr) throw cErr;

    let liked = false;
    if (anon_id) {
      const { data: lk } = await supabase.from('community_likes')
        .select('id').eq('post_id', id).eq('anon_id', anon_id).maybeSingle();
      liked = !!lk;
    }

    // 사장님 결정 D2 A: author_name 우선, 폴백 nicknameOf
    const enrichedComments = (comments || []).map(c => ({
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      nickname: c.author_name || nicknameOf(c.anon_id),
      is_mine: anon_id && c.anon_id === anon_id
    }));

    res.json({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        category: post.category,
        image_url: post.image_url,
        like_count: post.like_count,
        comment_count: post.comment_count,
        created_at: post.created_at,
        nickname: post.author_name || nicknameOf(post.anon_id),
        liked,
        is_mine: anon_id && post.anon_id === anon_id
      },
      comments: enrichedComments
    });
  } catch (err) {
    console.error('community post detail error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4) 글 삭제 (본인만)
app.delete('/api/community/posts/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 본인 검증 + soft delete
    const { data, error } = await supabase.from('community_posts')
      .update({ deleted: true })
      .eq('id', id).eq('anon_id', anon_id)
      .select().single();
    if (error) throw error;
    if (!data) return res.status(403).json({ success: false, error: '본인 글만 삭제할 수 있습니다' });
    res.json({ success: true });
  } catch (err) {
    console.error('community post DELETE error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5) 좋아요 토글
app.post('/api/community/posts/:id/like', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 글 존재 확인
    const { data: post, error: pErr } = await supabase.from('community_posts')
      .select('id, like_count, deleted').eq('id', id).maybeSingle();
    if (pErr) throw pErr;
    if (!post || post.deleted) return res.status(404).json({ success: false, error: '글을 찾을 수 없습니다' });

    // 기존 좋아요 확인
    const { data: existing } = await supabase.from('community_likes')
      .select('id').eq('post_id', id).eq('anon_id', anon_id).maybeSingle();

    let liked;
    if (existing) {
      // 취소
      await supabase.from('community_likes').delete().eq('id', existing.id);
      liked = false;
    } else {
      // 추가 (UNIQUE 제약으로 race-safe)
      const { error: insErr } = await supabase.from('community_likes').insert([{ post_id: id, anon_id }]);
      if (insErr && insErr.code !== '23505') throw insErr; // 23505 = duplicate (race) → liked로 처리
      liked = true;
    }

    // like_count 재계산 (가장 정확)
    const { count } = await supabase.from('community_likes')
      .select('*', { count: 'exact', head: true }).eq('post_id', id);
    await supabase.from('community_posts').update({ like_count: count || 0 }).eq('id', id);

    res.json({ success: true, liked, like_count: count || 0 });
  } catch (err) {
    console.error('community like error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6) 댓글 작성
app.post('/api/community/posts/:id/comments', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id, content, author_name } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const c = clampStr(content || '', 500).trim();
    if (!c) return res.status(400).json({ success: false, error: '댓글 내용은 필수' });
    // 사장님 결정 D2/D3: author_name 필수
    const authorName = clampStr(author_name || '', 40).trim();
    if (!authorName) return res.status(400).json({ success: false, error: '사업장명이 필요합니다. 설정에서 입력해 주세요.' });

    const { data: post } = await supabase.from('community_posts')
      .select('id, comment_count, deleted').eq('id', id).maybeSingle();
    if (!post || post.deleted) return res.status(404).json({ success: false, error: '글을 찾을 수 없습니다' });

    const { data: cmt, error: cErr } = await supabase.from('community_comments')
      .insert([{ post_id: id, anon_id, content: c, author_name: authorName }])
      .select().single();
    if (cErr) throw cErr;

    const { count } = await supabase.from('community_comments')
      .select('*', { count: 'exact', head: true }).eq('post_id', id).eq('deleted', false);
    await supabase.from('community_posts').update({ comment_count: count || 0 }).eq('id', id);

    res.json({
      success: true,
      data: {
        id: cmt.id,
        content: cmt.content,
        created_at: cmt.created_at,
        nickname: authorName
      }
    });
  } catch (err) {
    console.error('community comment POST error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7) 댓글 삭제 (본인만)
app.delete('/api/community/comments/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 댓글 본인 확인 + soft delete
    const { data: cmt, error: cErr } = await supabase.from('community_comments')
      .update({ deleted: true })
      .eq('id', id).eq('anon_id', anon_id)
      .select('id, post_id').maybeSingle();
    if (cErr) throw cErr;
    if (!cmt) return res.status(403).json({ success: false, error: '본인 댓글만 삭제할 수 있습니다' });

    // post의 comment_count 감소
    const { count } = await supabase.from('community_comments')
      .select('*', { count: 'exact', head: true }).eq('post_id', cmt.post_id).eq('deleted', false);
    await supabase.from('community_posts').update({ comment_count: count || 0 }).eq('id', cmt.post_id);

    res.json({ success: true });
  } catch (err) {
    console.error('community comment DELETE error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Web Push API (Phase 3-A)
// ══════════════════════════════════════════════════════════════════════

// VAPID 공개키 제공 — 클라이언트가 구독 시 사용
app.get('/api/push/vapid-key', (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ success: false, error: 'Push 비활성화' });
  res.json({ success: true, publicKey: VAPID_PUBLIC_KEY });
});

// 구독 등록
// body: { endpoint, p256dh, auth, anon_id, deviceId?, reminder_hour?, reminder_minute? }
app.post('/api/push/subscribe', authRequired, async (req, res) => {
  try {
    const { endpoint, p256dh, auth, anon_id, deviceId, reminder_hour, reminder_minute } = req.body || {};
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ success: false, error: 'endpoint, p256dh, auth 필수' });
    }
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    const row = {
      endpoint, p256dh, auth, anon_id,
      device_id: deviceId || null,
      updated_at: new Date().toISOString()
    };
    if (Number.isInteger(reminder_hour) && reminder_hour >= 0 && reminder_hour <= 23) row.reminder_hour = reminder_hour;
    if (Number.isInteger(reminder_minute) && reminder_minute >= 0 && reminder_minute <= 59) row.reminder_minute = reminder_minute;

    // endpoint UNIQUE 제약 활용 — upsert로 중복 시 갱신
    const { data, error } = await supabase.from('push_subscriptions')
      .upsert([row], { onConflict: 'endpoint' })
      .select().single();
    if (error) throw error;
    res.json({ success: true, data: { id: data.id } });
  } catch (e) {
    console.error('push subscribe error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 구독 해제
// body: { endpoint }
app.delete('/api/push/subscribe', authRequired, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint 필수' });
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('push unsubscribe error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  일정 리마인더 자동 푸시 (Phase 1)
//  컬럼: push_subscriptions.reminder_hour/minute/enabled/last_reminder_date
// ═══════════════════════════════════════════════════════════════

// GET /api/push/reminder?endpoint= : 현재 설정 조회
app.get('/api/push/reminder', authRequired, async (req, res) => {
  try {
    const { endpoint } = req.query;
    if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint 필수' });
    const { data } = await supabase.from('push_subscriptions')
      .select('reminder_hour, reminder_minute, reminder_enabled')
      .eq('endpoint', endpoint).maybeSingle();
    res.json({ success: true, data: data || { reminder_hour: 8, reminder_minute: 0, reminder_enabled: true } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/push/reminder : 시간/ON-OFF 변경
// body: { endpoint, reminder_hour?, reminder_minute?, reminder_enabled? }
app.patch('/api/push/reminder', authRequired, async (req, res) => {
  try {
    const { endpoint, reminder_hour, reminder_minute, reminder_enabled } = req.body || {};
    if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint 필수' });

    const patch = { updated_at: new Date().toISOString() };
    if (Number.isInteger(reminder_hour) && reminder_hour >= 0 && reminder_hour <= 23) patch.reminder_hour = reminder_hour;
    if (Number.isInteger(reminder_minute) && reminder_minute >= 0 && reminder_minute <= 59) patch.reminder_minute = reminder_minute;
    if (typeof reminder_enabled === 'boolean') patch.reminder_enabled = reminder_enabled;

    const { error } = await supabase.from('push_subscriptions').update(patch).eq('endpoint', endpoint);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── KST 헬퍼 ─────────────────────────────────────────────────
function _nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function _kstDateStr(d) {
  d = d || _nowKST();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ── 단일 구독자에게 푸시 (410은 자동 삭제) ────────────────────
async function _sendPushToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    }
    console.log('reminder push fail:', e.statusCode, e.message);
    return false;
  }
}

// ── 리마인더 실행기 (cron + 수동 트리거에서 호출) ─────────────
async function _runReminders({ force = false, anon_id_filter = null } = {}) {
  if (!PUSH_ENABLED) return { sent: 0, skipped: 'push_disabled' };
  const kst = _nowKST();
  const today = _kstDateStr(kst);
  const hh = kst.getUTCHours();
  const mm = kst.getUTCMinutes();

  let q = supabase.from('push_subscriptions').select('*').eq('reminder_enabled', true);
  if (!force) {
    q = q.eq('reminder_hour', hh).eq('reminder_minute', mm)
         .or(`last_reminder_date.is.null,last_reminder_date.lt.${today}`);
  }
  if (anon_id_filter) q = q.eq('anon_id', anon_id_filter);

  const { data: subs, error } = await q;
  if (error) { console.log('[reminder] subs query error:', error.message); return { sent: 0 }; }
  if (!subs || !subs.length) return { sent: 0 };

  let sent = 0;
  for (const sub of subs) {
    if (!sub.anon_id) continue;
    const { data: items } = await supabase.from('schedules')
      .select('name, time, addr')
      .eq('anon_id', sub.anon_id).eq('date', today)
      .order('time', { ascending: true });

    if (!items || items.length === 0) {
      if (!force) {
        await supabase.from('push_subscriptions')
          .update({ last_reminder_date: today }).eq('endpoint', sub.endpoint);
      }
      continue;
    }
    const lines = items.slice(0, 5).map((s, i) =>
      `${i+1}) ${s.time || '시간미정'} ${(s.name || '고객').slice(0,6)}${s.addr ? ' ('+s.addr.slice(0,8)+')' : ''}`
    ).join('\n');
    const more = items.length > 5 ? `\n외 ${items.length - 5}건` : '';

    const ok = await _sendPushToSubscription(sub, {
      title: `🧹 오늘 일정 ${items.length}건`,
      body: lines + more,
      icon: '/icon-192.png',
      url: '/schedule.html',
      tag: 'daily-reminder'
    });
    if (ok) sent++;
    if (!force) {
      await supabase.from('push_subscriptions')
        .update({ last_reminder_date: today }).eq('endpoint', sub.endpoint);
    }
  }
  if (sent > 0) console.log(`[reminder] ${today} ${hh}:${mm} → ${sent}건 발송`);
  return { sent };
}

// POST /api/push/test-reminder : 수동 트리거 (adminKey 필요)
app.post('/api/push/test-reminder', async (req, res) => {
  try {
    const { adminKey, anon_id } = req.body || {};
    if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ success: false, error: '인증 실패' });
    const result = await _runReminders({ force: true, anon_id_filter: anon_id || null });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 예약 신청 접수 ─────────────────────────────────────────────────────────
app.post('/api/booking', async (req, res) => {
  try {
    // ⚠️ 보안: 클라이언트 apiKey/apiSecret 무시 (환경변수 기반 sendSMSUtil 사용)
    const { name, phone, size, type, date, time, notes, ownerPhone } = req.body || {};
    // address ↔ addr 둘 다 호환 (booking.html은 address, 서버는 addr 사용해왔음)
    const addrInput = req.body?.addr || req.body?.address || '';

    _diagStats.bookingPostCount++;
    _diagStats.lastBookingPostAt = new Date().toISOString();
    console.log('booking POST:', { name, phone, hasAddr: !!addrInput, hasOwner: !!ownerPhone });

    if (!name || !phone) {
      _diagStats.bookingFailCount++;
      _diagStats.lastBookingError = '이름/연락처 누락';
      return res.status(400).json({ success: false, error: '이름과 연락처는 필수입니다.' });
    }

    // 입력 길이 검증
    const cleanName = String(name).trim().slice(0, 30);
    const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(0, 15);
    if (!cleanName || cleanPhone.length < 8) {
      _diagStats.bookingFailCount++;
      _diagStats.lastBookingError = '검증 실패: name=' + cleanName + ', phone=' + cleanPhone;
      console.log('booking 검증 실패: name=', cleanName, 'phone=', cleanPhone);
      return res.status(400).json({ success: false, error: '이름/연락처가 올바르지 않습니다.' });
    }

    const bookingData = {
      name: cleanName,
      phone: cleanPhone,
      addr: String(addrInput).slice(0, 200),
      size: String(size || '').slice(0, 10),
      type: String(type || '입주 전 청소').slice(0, 30),
      date: String(date || '').slice(0, 20),
      time: String(time || '').slice(0, 20),
      notes: String(notes || '').slice(0, 500),
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase.from('bookings').insert([bookingData]).select().single();
    if (error) {
      console.error('booking INSERT 실패:', error);
      throw error;
    }

    _diagStats.bookingSuccessCount++;
    _diagStats.lastBookingSuccessAt = new Date().toISOString();
    console.log('booking INSERT 성공:', data.id);

    // ⚡ 즉시 응답 (사용자 화면 빠르게 다음 단계로)
    res.json({ success: true, data });

    // 사장님 SMS 알림은 fire-and-forget (응답 차단 안 함)
    if (ownerPhone) {
      const cleanOwner = String(ownerPhone).replace(/[^0-9]/g, '');
      if (cleanOwner.length >= 8) {
        const msg = `[싹싹] 새 예약신청이 왔습니다!\n고객: ${cleanName} (${cleanPhone})\n날짜: ${bookingData.date} ${bookingData.time}\n유형: ${bookingData.type} ${bookingData.size}평\n주소: ${bookingData.addr}\n앱에서 확인하세요.`;
        sendSMSUtil(cleanOwner, msg, '[싹싹] 새 예약신청', {
          type: 'general', customerName: cleanName, meta: { stage: 'booking-alert', bookingId: data?.id }
        })
          .then(r => console.log('booking SMS 결과:', r))
          .catch(e => console.log('SMS 알림 실패(무시):', e.message));
      } else {
        console.log('ownerPhone 형식 오류:', ownerPhone);
      }
    } else {
      console.log('ownerPhone 미전달');
    }
  } catch (err) {
    _diagStats.bookingFailCount++;
    _diagStats.lastBookingError = err.message;
    console.error('booking error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/bookings', authRequired, ownerOnly, async (req, res) => {
  try {
    const status = req.query.status || null;
    const date = req.query.date || null;
    let query = supabase.from('bookings').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (date) query = query.eq('date', date);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/bookings/:id', authRequired, ownerOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const { data, error } = await supabase.from('bookings').update({ status }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/bookings/:id/status', authRequired, ownerOnly, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // pending | confirmed | completed | cancelled

  try {
    const { data, error } = await supabase
      .from('bookings')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// ──────────────────────────────────────────────────────────────
// 📅 예약 단축 URL 토큰 (booking_tokens 테이블 활용)
// 긴 URL → 짧은 ?t=xxx 토큰 URL로 변환
// ──────────────────────────────────────────────────────────────
app.post('/api/booking/token', authRequired, async (req, res) => {
  try {
    const { name, phone, size, type, price, companyName } = req.body || {};
    if (!phone || !size) return res.status(400).json({ success: false, error: 'phone, size 필수' });

    // 8자 base62 토큰 생성 + 충돌 회피 (최대 5회 재시도)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      token = '';
      for (let j = 0; j < 6; j++) token += chars[Math.floor(Math.random() * chars.length)];
      const { data: dup } = await supabase.from('booking_tokens').select('id').eq('token', token).maybeSingle();
      if (!dup) break;
      if (attempt === 4) return res.status(500).json({ success: false, error: '토큰 생성 실패' });
    }

    const quote_data = {
      name: String(name||'').slice(0, 50),
      phone: String(phone).slice(0, 20),
      size: String(size).slice(0, 10),
      type: String(type||'').slice(0, 30),
      price: String(price||'').slice(0, 12),
      companyName: String(companyName||'서프로클린').slice(0, 50)
    };

    const { error } = await supabase.from('booking_tokens').insert([{ token, quote_data }]);
    if (error) throw error;

    // 만료 토큰 자동 정리 (DB 비대 방지) — fire-and-forget, 응답 차단 안 함
    supabase.from('booking_tokens').delete()
      .lt('expires_at', new Date().toISOString())
      .not('expires_at', 'is', null)  // null=영구 토큰 보존
      .then(({ error: cErr }) => {
        if (cErr) console.warn('booking_tokens cleanup error:', cErr.message);
      });

    // 만료된 미서명 계약서 자동 정리 (서명 완료된 것은 보존)
    supabase.from('pending_contracts').delete()
      .lt('expires_at', new Date().toISOString())
      .eq('status', 'pending')
      .then(({ error: cErr }) => {
        if (cErr) console.warn('pending_contracts cleanup error:', cErr.message);
      });

    // 30일 이상된 sent/cancelled reminders 자동 정리 (성공/취소 기록만 정리)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    supabase.from('pending_reminders').delete()
      .in('status', ['sent', 'cancelled'])
      .lt('created_at', thirtyDaysAgo)
      .then(({ error: cErr }) => {
        if (cErr) console.warn('pending_reminders cleanup error:', cErr.message);
      });

    // 만료 리마인더 자동 발송 (피기백: cron 없어도 견적 발송할 때마다 처리)
    _processReminders().catch(() => null);

    res.json({ success: true, token, url: `https://ssakapp.co.kr/b/?t=${token}` });
  } catch (e) {
    console.error('booking token POST error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/booking/token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length > 20) return res.status(400).json({ success: false, error: 'token 형식 오류' });

    const { data, error } = await supabase.from('booking_tokens')
      .select('quote_data, expires_at').eq('token', token).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: '유효하지 않은 링크' });
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ success: false, error: '만료된 링크' });
    }
    res.json({ success: true, data: data.quote_data || {} });
  } catch (e) {
    console.error('booking token GET error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📋 견적 요청 (Quote Requests) — 사장님 → 고객 정보 수집 → 정밀 견적
// 2026-05-17 사장님 결정: 러프 금액 미공개 → 고객 셀프 입력 → 정밀 견적
// ════════════════════════════════════════════════════════════════

// 1) POST /api/quote-requests — 사장님이 수집 폼 발송 (JWT 인증)
app.post('/api/quote-requests', authRequired, async (req, res) => {
  try {
    const customerPhoneRaw = String(req.body.customer_phone || '').replace(/[^0-9]/g,'');
    if (!/^01[016789]\d{7,8}$/.test(customerPhoneRaw)) {
      return res.status(400).json({ success: false, error: '고객 휴대폰 번호를 확인해 주세요' });
    }
    const customerName = clampStr(req.body.customer_name || '', 30);
    const customMsg    = clampStr(req.body.message || '', 500);
    const companyName  = clampStr(req.body.company_name || '', 50);

    // 사장님 안내 자료 (블로그/SNS/인사말 등)
    // 각 필드 길이 제한 + URL 검증
    const ownerInfoIn = req.body.owner_info && typeof req.body.owner_info === 'object' ? req.body.owner_info : {};
    const safeUrl = (u) => {
      if (!u || typeof u !== 'string') return '';
      const s = u.trim().slice(0, 300);
      if (!s) return '';
      // http(s)://로 시작 안 하면 https:// 자동 보정
      if (!/^https?:\/\//i.test(s)) return 'https://' + s;
      return s;
    };
    const ownerInfo = {
      company:        clampStr(ownerInfoIn.company   || companyName || '', 50),
      phone:          clampStr(ownerInfoIn.phone     || '', 20),
      intro:          clampStr(ownerInfoIn.intro     || '', 500),
      blog_url:       safeUrl(ownerInfoIn.blog_url),
      naver_url:      safeUrl(ownerInfoIn.naver_url),
      kakao_url:      safeUrl(ownerInfoIn.kakao_url),
      instagram_url:  safeUrl(ownerInfoIn.instagram_url),
      review_url:     safeUrl(ownerInfoIn.review_url),
      process_guide:  clampStr(ownerInfoIn.process_guide || '', 500)
    };

    // 토큰 생성 (32자 hex — 계약서 토큰과 동일 강도)
    const token = require('crypto').randomBytes(16).toString('hex');
    const { data: inserted, error: insErr } = await supabase.from('quote_requests').insert({
      token,
      customer_phone: customerPhoneRaw,
      customer_name: customerName || null,
      owner_info: ownerInfo,
      status: 'pending',
      created_by: req.user.id
    }).select('id, token, customer_phone, customer_name, status, owner_info, created_at, expires_at').maybeSingle();
    if (insErr) {
      console.error('quote_requests insert error:', insErr.message);
      return res.status(500).json({ success: false, error: '요청 생성 실패' });
    }

    // SMS 본문 자동 생성 — 사장님 자료 자동 포함
    const formUrl = `https://ssakapp.co.kr/quote.html?token=${token}`;
    // 안내 링크 1순위 (네이버 블로그 우선, 없으면 카카오, 인스타, 리뷰 순)
    const promoUrl = ownerInfo.blog_url || ownerInfo.naver_url ||
                     ownerInfo.kakao_url || ownerInfo.instagram_url || ownerInfo.review_url || '';
    const promoLabel = ownerInfo.blog_url || ownerInfo.naver_url ? '🔗 업체 안내' :
                       ownerInfo.kakao_url ? '💬 카카오' :
                       ownerInfo.instagram_url ? '📷 인스타' :
                       ownerInfo.review_url ? '⭐ 후기' : '';

    const builtMsg = [
      `[싹싹] ${ownerInfo.company || companyName || '청소 견적'}`,
      ``,
      `${customerName || '고객님'}, 안녕하세요!`,
      `정확한 견적을 위해 평수·사진을 알려주세요.`,
      ``,
      `📝 정보 입력: ${formUrl}`,
      `(약 2분 소요 — 첨부 자료가 페이지에서 확인됩니다)`,
      promoUrl ? `\n${promoLabel}: ${promoUrl}` : '',
      ownerInfo.phone ? `\n📞 문의: ${ownerInfo.phone}` : ''
    ].filter(Boolean).join('\n').trim();

    const finalMsg = customMsg
      ? customMsg
          .replace(/\{링크\}|\{url\}|\{URL\}/g, formUrl)
          .replace(/\{이름\}/g, customerName || '고객님')
          .replace(/\{업체명\}/g, ownerInfo.company || companyName || '')
          .replace(/\{전화\}/g, ownerInfo.phone || '')
          .replace(/\{블로그\}/g, ownerInfo.blog_url || ownerInfo.naver_url || '')
          .replace(/\{카카오\}/g, ownerInfo.kakao_url || '')
          .replace(/\{인스타\}/g, ownerInfo.instagram_url || '')
      : builtMsg;

    let smsResult = { ok: false };
    try {
      smsResult = await sendSMSUtil(customerPhoneRaw, finalMsg, ' ', {
        type: 'quote_request',
        customerName,
        meta: { quote_request_id: inserted.id, token }
      });
    } catch (smsErr) {
      console.error('quote_requests SMS error:', smsErr.message);
    }
    res.json({
      success: true,
      data: inserted,
      url: formUrl,
      sms_body: finalMsg,
      sms_sent: smsResult.ok || false,
      sms_error: smsResult.ok ? null : (smsResult.error || null)
    });
  } catch (e) {
    console.error('POST /api/quote-requests error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 2) GET /api/quote-requests/by-token/:token — 게스트 (고객 폼 페이지)
app.get('/api/quote-requests/by-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ success: false, error: '잘못된 링크' });
    const { data, error } = await supabase.from('quote_requests')
      .select('id, token, status, customer_phone, customer_name, clean_type, housing_type, area_size, area_type, region, desired_date, notes, room_count, bathroom_count, veranda_count, site_conditions, appliance_options, aircon_info, referral_source, owner_info, photos, final_quote_amount, expires_at, submitted_at, quoted_at')
      .eq('token', token).maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data)  return res.status(404).json({ success: false, error: '만료되었거나 존재하지 않는 링크입니다' });
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ success: false, error: '만료된 링크입니다', code: 'EXPIRED' });
    }
    // 사장님 회사 정보 (선택 — 고객 화면 브랜딩)
    const { data: owner } = await supabase.from('admin_users').select('name').eq('id', (await supabase.from('quote_requests').select('created_by').eq('token', token).maybeSingle()).data.created_by).maybeSingle();
    res.json({ success: true, data, owner_name: owner ? owner.name : null });
  } catch (e) {
    console.error('GET /api/quote-requests/by-token error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3) PUT /api/quote-requests/by-token/:token — 게스트 (고객 폼 제출)
app.put('/api/quote-requests/by-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ success: false, error: '잘못된 링크' });
    const { data: row, error: getErr } = await supabase.from('quote_requests')
      .select('id, status, expires_at, customer_phone, created_by').eq('token', token).maybeSingle();
    if (getErr || !row) return res.status(404).json({ success: false, error: '존재하지 않는 링크입니다' });
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ success: false, error: '만료된 링크입니다' });
    }
    if (row.status !== 'pending' && row.status !== 'submitted') {
      return res.status(400).json({ success: false, error: '이미 견적이 발송된 요청입니다' });
    }
    // 입력 검증 (Phase D 확장: 프리덤클린 레퍼런스 통합)
    // 1) 청소 유형 — 5종
    const cleanTypes = ['신축입주청소','구축이사청소','거주청소','사이청소','인테리어 후 청소'];
    const cleanType = cleanTypes.includes(req.body.clean_type) ? req.body.clean_type : null;

    // 2) 주거 형태 — 7종
    const housingTypes = ['원룸','투룸','아파트','오피스텔','빌라','주택','사무실'];
    const housingType = housingTypes.includes(req.body.housing_type) ? req.body.housing_type : null;

    // 3) 평수 + 전용/공급
    const areaSize  = parseInt(req.body.area_size) || null;
    if (areaSize !== null && (areaSize < 1 || areaSize > 999)) {
      return res.status(400).json({ success: false, error: '평수는 1~999 사이' });
    }
    const areaType = (req.body.area_type === '전용' || req.body.area_type === '공급') ? req.body.area_type : null;

    // 4) 지역 + 시공일 + 특이사항
    const region    = clampStr(req.body.region || '', 50);
    const desiredDate = req.body.desired_date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.desired_date) ? req.body.desired_date : null;
    const notes     = clampStr(req.body.notes || '', 1000);

    // 5) 방·화장실·베란다 갯수
    const roomCount    = req.body.room_count     === null || req.body.room_count     === undefined ? null : parseInt(req.body.room_count);
    const bathroomCount= req.body.bathroom_count === null || req.body.bathroom_count === undefined ? null : parseInt(req.body.bathroom_count);
    const verandaCount = req.body.veranda_count  === null || req.body.veranda_count  === undefined ? null : parseInt(req.body.veranda_count);
    for (const [k, v] of [['room_count',roomCount],['bathroom_count',bathroomCount],['veranda_count',verandaCount]]) {
      if (v !== null && Number.isFinite(v) && (v < 0 || v > 99)) {
        return res.status(400).json({ success: false, error: `${k}는 0~99 사이` });
      }
    }

    // 6) 현장 조건 (다중 선택, 최대 9개)
    const allowedConditions = ['보조주방','광폭거실','거실 추가창문','엘리베이터 없음','베란다 곰팡이','시트지 자국','안전고리','니코틴 제거'];
    const siteConditions = Array.isArray(req.body.site_conditions)
      ? req.body.site_conditions.filter(s => allowedConditions.includes(s)).slice(0, 9)
      : [];

    // 7) 가전 분해청소 [{name, count}]
    const allowedAppliances = ['단문형 냉장고','양문형 냉장고','단문형 김치냉장고','양문형 김치냉장고','식기세척기','오븐','세탁기(드럼)'];
    let applianceOptions = [];
    if (Array.isArray(req.body.appliance_options)) {
      applianceOptions = req.body.appliance_options
        .filter(a => a && allowedAppliances.includes(a.name) && Number.isFinite(parseInt(a.count)) && parseInt(a.count) > 0)
        .map(a => ({ name: a.name, count: Math.min(parseInt(a.count), 20) }))
        .slice(0, 7);
    }

    // 8) 에어컨 정보 (자유 텍스트)
    const airconInfo = clampStr(req.body.aircon_info || '', 200);

    // 9) 유입 채널
    const referralSources = ['블로그','인스타그램','스레드','유튜브','부동산소개','지인추천','카페','기타'];
    const referralSource = referralSources.includes(req.body.referral_source) ? req.body.referral_source : null;

    // 사진은 별도 라우트에서 업로드 — 여기서는 photos 배열만 갱신
    const photos = Array.isArray(req.body.photos) ? req.body.photos.slice(0, 5) : undefined;

    const patch = {
      clean_type:        cleanType,
      housing_type:      housingType,
      area_size:         areaSize,
      area_type:         areaType,
      region:            region || null,
      desired_date:      desiredDate,
      notes:             notes || null,
      room_count:        Number.isFinite(roomCount)    ? roomCount    : null,
      bathroom_count:    Number.isFinite(bathroomCount)? bathroomCount: null,
      veranda_count:     Number.isFinite(verandaCount) ? verandaCount : null,
      site_conditions:   siteConditions,
      appliance_options: applianceOptions,
      aircon_info:       airconInfo || null,
      referral_source:   referralSource,
      status:            'submitted',
      submitted_at:      new Date().toISOString()
    };
    if (photos !== undefined) patch.photos = photos;

    const { data, error } = await supabase.from('quote_requests')
      .update(patch).eq('token', token)
      .select('id, status, submitted_at').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });

    // 사장님 Web Push 알림
    sendPushToAll({
      title: '🆕 새 견적 요청',
      body: `${cleanType || '청소'} · ${areaSize ? areaSize + '평' : ''} 정보가 도착했어요`,
      url: '/ssak-quote.html?tab=quote-requests',
      tag: 'quote-request-' + row.id
    }).catch(()=>null);

    res.json({ success: true, data });
  } catch (e) {
    console.error('PUT /api/quote-requests error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 4) POST /api/quote-requests/by-token/:token/photos — 게스트 (사진 업로드)
// body: { imageBase64: "...", imageMime: "image/jpeg" }
app.post('/api/quote-requests/by-token/:token/photos', async (req, res) => {
  try {
    const { token } = req.params;
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ success: false, error: '잘못된 링크' });
    const { imageBase64, imageMime } = req.body || {};
    if (!imageBase64 || !imageMime) return res.status(400).json({ success: false, error: '이미지 데이터 필수' });
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(imageMime)) {
      return res.status(400).json({ success: false, error: '지원되지 않는 형식' });
    }
    const { data: row, error: getErr } = await supabase.from('quote_requests')
      .select('id, status, photos, expires_at').eq('token', token).maybeSingle();
    if (getErr || !row) return res.status(404).json({ success: false, error: '존재하지 않는 링크' });
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ success: false, error: '만료된 링크' });
    }
    const existing = Array.isArray(row.photos) ? row.photos : [];
    if (existing.length >= 5) return res.status(400).json({ success: false, error: '사진은 최대 5장' });

    // base64 → Buffer
    const buf = Buffer.from(imageBase64, 'base64');
    if (buf.length > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: '이미지 10MB 이하' });
    }
    // 파일명: {token}/{nanoid}.ext
    const ext = imageMime.split('/')[1].replace('jpeg','jpg');
    const name = require('crypto').randomBytes(8).toString('hex') + '.' + ext;
    const filePath = `${token}/${name}`;
    const { data: up, error: upErr } = await supabase.storage
      .from('quote-photos')
      .upload(filePath, buf, { contentType: imageMime, upsert: false });
    if (upErr) {
      console.error('storage upload error:', upErr.message);
      return res.status(500).json({ success: false, error: '업로드 실패' });
    }
    const { data: pub } = supabase.storage.from('quote-photos').getPublicUrl(filePath);
    const url = pub && pub.publicUrl;
    const newPhotos = [...existing, { url, path: filePath, sort_order: existing.length, uploaded_at: new Date().toISOString() }];
    const { error: updErr } = await supabase.from('quote_requests')
      .update({ photos: newPhotos }).eq('id', row.id);
    if (updErr) return res.status(500).json({ success: false, error: updErr.message });
    res.json({ success: true, url, count: newPhotos.length });
  } catch (e) {
    console.error('POST /api/quote-requests/photos error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5) GET /api/quote-requests — 사장님 목록 (JWT 인증)
app.get('/api/quote-requests', authRequired, async (req, res) => {
  try {
    const status = req.query.status && ['pending','submitted','quoted','contracted','cancelled'].includes(req.query.status) ? req.query.status : null;
    let q = supabase.from('quote_requests')
      .select('id, token, status, customer_phone, customer_name, clean_type, housing_type, area_size, area_type, region, desired_date, notes, room_count, bathroom_count, veranda_count, site_conditions, appliance_options, aircon_info, referral_source, owner_info, photos, final_quote_amount, created_at, submitted_at, quoted_at')
      .eq('deleted', false)
      .order('created_at', { ascending: false }).limit(100);
    if (status) q = q.eq('status', status);
    // owner만 본인 것 + 다른 owner의 것도 (1인 운영 단순화)
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('GET /api/quote-requests error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5-1) GET /api/quote-requests/trash — 휴지통 목록 (deleted=true, 최근 7일) (JWT)
// :id 라우트보다 먼저 등록 필요 (Express 매칭 순서)
app.get('/api/quote-requests/trash', authRequired, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('quote_requests')
      .select('id, token, status, customer_phone, customer_name, clean_type, area_size, region, final_quote_amount, created_at, deleted_at')
      .eq('deleted', true)
      .gte('deleted_at', sevenDaysAgo)
      .order('deleted_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('GET /api/quote-requests/trash error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 6) GET /api/quote-requests/:id — 사장님 상세 (JWT)
app.get('/api/quote-requests/:id', authRequired, async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: '잘못된 id' });
  const { data, error } = await supabase.from('quote_requests')
    .select('*').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data)  return res.status(404).json({ success: false, error: '없음' });
  res.json({ success: true, data });
});

// 7) PATCH /api/quote-requests/:id — 사장님 정밀 견적 발송 (JWT)
// body: { final_quote_amount, quote_message, action: 'quote'|'cancel'|'delete'|'restore' }
app.patch('/api/quote-requests/:id', authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: '잘못된 id' });
    const action = req.body.action || 'quote';
    const { data: row, error: getErr } = await supabase.from('quote_requests')
      .select('id, status, customer_phone, customer_name').eq('id', id).maybeSingle();
    if (getErr || !row) return res.status(404).json({ success: false, error: '없음' });
    if (action === 'cancel') {
      const { error } = await supabase.from('quote_requests')
        .update({ status: 'cancelled' }).eq('id', id);
      if (error) return res.status(500).json({ success: false, error: error.message });
      return res.json({ success: true });
    }
    if (action === 'delete') {
      // Soft-delete: deleted=true + deleted_at=now
      const { error } = await supabase.from('quote_requests')
        .update({ deleted: true, deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) return res.status(500).json({ success: false, error: error.message });
      return res.json({ success: true });
    }
    if (action === 'restore') {
      // 휴지통에서 복구: deleted=false + deleted_at=null
      const { error } = await supabase.from('quote_requests')
        .update({ deleted: false, deleted_at: null }).eq('id', id);
      if (error) return res.status(500).json({ success: false, error: error.message });
      return res.json({ success: true });
    }
    if (action !== 'quote') return res.status(400).json({ success: false, error: 'action invalid' });
    const amount = parseInt(req.body.final_quote_amount);
    const msg    = clampStr(req.body.quote_message || '', 1000);
    if (!Number.isFinite(amount) || amount < 1 || amount > 99999999) {
      return res.status(400).json({ success: false, error: '금액은 1~99,999,999원' });
    }
    if (!msg) return res.status(400).json({ success: false, error: '메시지 필수' });
    if (row.status === 'cancelled') return res.status(400).json({ success: false, error: '취소된 요청' });
    // 정밀 견적 SMS 발송
    const sms = await sendSMSUtil(row.customer_phone, msg, ' ', {
      type: 'quote',
      customerName: row.customer_name || '',
      meta: { quote_request_id: id, final_quote_amount: amount }
    });
    if (!sms.ok) return res.status(500).json({ success: false, error: 'SMS 발송 실패: ' + (sms.error || '') });
    const { data, error } = await supabase.from('quote_requests').update({
      final_quote_amount: amount,
      quote_message: msg,
      status: 'quoted',
      quoted_at: new Date().toISOString()
    }).eq('id', id).select('id, status, final_quote_amount, quoted_at').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) {
    console.error('PATCH /api/quote-requests error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────
// 📅 자동 Follow-up (Reminders)
// 견적 발송 후 24시간 미응답 시 자동 리마인드 SMS 시스템
// ──────────────────────────────────────────────────────────────

// 리마인더 자동 발송 처리 (만료된 scheduled 항목들 → SMS 발송)
async function _processReminders() {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('pending_reminders')
      .select('*')
      .eq('status', 'scheduled')
      .lte('send_at', now)
      .limit(20);
    if (error || !data || !data.length) return { sent: 0 };

    let sent = 0;
    for (const r of data) {
      try {
        // 이미 고객이 예약 신청했는지 체크 (해당 phone으로 booking이 있으면 skip)
        const { data: existing } = await supabase.from('bookings')
          .select('id').eq('phone', r.customer_phone)
          .gte('created_at', new Date(r.created_at).toISOString())
          .limit(1).maybeSingle();
        if (existing) {
          // 이미 예약 들어옴 → 리마인드 스킵
          await supabase.from('pending_reminders').update({ status: 'cancelled', sent_at: now }).eq('id', r.id);
          continue;
        }
        // 발송
        const result = await sendSMSUtil(r.customer_phone, r.message, '[싹싹] 견적 안내', {
          type: 'quote', customerName: r.customer_name || null, meta: { stage: 'followup-reminder', reminderId: r.id }
        });
        await supabase.from('pending_reminders').update({
          status: result.ok ? 'sent' : 'cancelled',
          sent_at: now
        }).eq('id', r.id);
        if (result.ok) sent++;
      } catch (e) {
        console.warn('reminder process item error:', e.message);
      }
    }
    return { sent };
  } catch (e) {
    console.error('_processReminders error:', e);
    return { sent: 0, error: e.message };
  }
}

// POST /api/reminders — 새 리마인더 예약 (사장님 인증)
app.post('/api/reminders', authRequired, ownerOnly, async (req, res) => {
  try {
    const { anon_id, customer_phone, customer_name, message, hours_later, source_type, source_ref } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    if (!customer_phone || customer_phone.length < 8) return res.status(400).json({ success: false, error: '고객 연락처 필수' });
    if (!message || message.length > 500) return res.status(400).json({ success: false, error: '메시지 형식 오류' });
    const hours = parseInt(hours_later, 10);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return res.status(400).json({ success: false, error: 'hours_later 1-168' });

    const sendAt = new Date(Date.now() + hours * 3600000).toISOString();
    const { data, error } = await supabase.from('pending_reminders').insert([{
      anon_id,
      customer_phone: String(customer_phone).replace(/[^0-9]/g, ''),
      customer_name: clampStr(customer_name || '', 30),
      message: clampStr(message, 500),
      send_at: sendAt,
      source_type: clampStr(source_type || 'quote', 30),
      source_ref: clampStr(source_ref || '', 100)
    }]).select().single();
    if (error) throw error;

    // piggyback: 만료된 리마인더 처리
    _processReminders().catch(() => null);

    res.json({ success: true, data });
  } catch (e) {
    console.error('reminders POST error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/reminders — 본인 리마인더 목록 (사장님 인증)
app.get('/api/reminders', authRequired, ownerOnly, async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const status = req.query.status || 'scheduled';
    const { data, error } = await supabase.from('pending_reminders')
      .select('*').eq('anon_id', anon_id).eq('status', status)
      .order('send_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('reminders GET error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/reminders/:id — 리마인더 취소 (본인만)
app.delete('/api/reminders/:id', authRequired, ownerOnly, async (req, res) => {
  try {
    const { anon_id } = req.body || req.query || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const { data, error } = await supabase.from('pending_reminders')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id).eq('anon_id', anon_id).eq('status', 'scheduled')
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(403).json({ success: false, error: '본인 리마인더만 취소 가능' });
    res.json({ success: true });
  } catch (e) {
    console.error('reminders DELETE error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/reminders/process — 만료된 리마인더 일괄 처리 (cron 호출용)
// 외부 cron-job.org 같은 서비스에서 매시간 호출 권장
app.post('/api/reminders/process', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey || req.query.adminKey || '';
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ success: false, error: '인증 실패' });
    }
    const result = await _processReminders();
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('reminders process error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});


// ──────────────────────────────────────────────────────────────
// 🩺 서버 상태 진단 (모바일에서 한 번 열기 편하게 HTML 응답)
// 환경변수 값은 노출 안 함 (set/missing만)
// ──────────────────────────────────────────────────────────────
app.get('/api/_status', async (req, res) => {
  const ENV_KEYS = [
    'ADMIN_KEY', 'JWT_SECRET', 'COOLSMS_API_KEY', 'COOLSMS_API_SECRET', 'COOLSMS_FROM',
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
    'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'
  ];
  const envCheck = {};
  ENV_KEYS.forEach(k => { envCheck[k] = !!process.env[k] ? '✅ set' : '❌ missing'; });
  // JWT_SECRET는 env 미설정이어도 DB에 저장되어 있으면 정상 — source 표시
  const jwtSourceLabel = {
    env: '✅ Railway env',
    db: '✅ DB 영구',
    generated: '✅ 신규 생성 후 DB 저장',
    'db-race-recovered': '✅ DB (race recovered)',
    'memory-fallback': '⚠️ 메모리 (DB 저장 실패)',
    pending: '⏳ 부트스트랩 중'
  }[JWT_SECRET_SOURCE] || JWT_SECRET_SOURCE;
  if (!process.env.JWT_SECRET) {
    envCheck['JWT_SECRET'] = jwtSourceLabel;
  }

  // Railway 빌드 정보
  const buildInfo = {
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_BRANCH || '(unknown)',
    deployId: process.env.RAILWAY_DEPLOYMENT_ID || '(unknown)',
    serverStart: _diagStats.serverStartedAt
  };

  // uptime
  const sec = Math.floor(process.uptime());
  const uptimeStr = sec < 60 ? sec + 's' :
    sec < 3600 ? Math.floor(sec/60) + 'm ' + (sec%60) + 's' :
    Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';

  // DB 상태 + 카운트
  let dbStatus = '✅ connected';
  const counts = {};
  const lastSeen = {};
  const tables = [
    { name: 'bookings', label: '📅 예약 신청' },
    { name: 'booking_tokens', label: '🪙 단축 URL 토큰' },
    { name: 'pending_contracts', label: '📋 계약서' },
    { name: 'pending_reminders', label: '⏰ 예약 발송' },
    { name: 'worker_profiles', label: '👥 워커' },
    { name: 'community_posts', label: '📰 커뮤니티 글' },
    { name: 'market_listings', label: '🛒 중고거래' },
    { name: 'push_subscriptions', label: '🔔 푸시 구독' }
  ];
  try {
    for (const t of tables) {
      try {
        const { count } = await supabase.from(t.name).select('*', { count: 'exact', head: true });
        counts[t.label] = count || 0;
        // 최근 created_at
        const { data: latest } = await supabase.from(t.name)
          .select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
        lastSeen[t.label] = latest?.created_at || null;
      } catch (e) {
        counts[t.label] = 'ERR';
        lastSeen[t.label] = null;
      }
    }
  } catch (e) {
    dbStatus = '❌ error: ' + e.message;
  }

  // CoolSMS 환경변수 모두 set인지
  const smsReady = envCheck.COOLSMS_API_KEY === '✅ set' &&
                   envCheck.COOLSMS_API_SECRET === '✅ set' &&
                   envCheck.COOLSMS_FROM === '✅ set';

  // HTML 응답
  const fmtTime = (t) => t ? new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음';
  const envRows = ENV_KEYS.map(k => `<tr><td>${k}</td><td>${envCheck[k]}</td></tr>`).join('');
  const tableRows = tables.map(t => `<tr><td>${t.label}</td><td>${counts[t.label]}</td><td>${fmtTime(lastSeen[t.label])}</td></tr>`).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>서버 진단</title>
<style>
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;}
body{margin:0;padding:16px;background:#f5f7fa;color:#1a1f36;font-size:14px;line-height:1.6;}
h1{font-size:20px;margin:0 0 16px;color:#00C896;}
h2{font-size:15px;margin:20px 0 8px;color:#1a1f36;border-bottom:2px solid #e0e6ed;padding-bottom:6px;}
.card{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.big{font-size:16px;font-weight:600;}
.green{color:#00C896;}
.red{color:#FF3B30;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:6px 4px;text-align:left;border-bottom:1px solid #f0f0f0;}
th{font-weight:600;color:#6b7684;}
.summary{display:flex;justify-content:space-between;margin:6px 0;}
.summary-key{color:#6b7684;}
.summary-val{font-weight:600;}
.warn{background:#FFF7E6;border:1px solid #FFD591;color:#B45309;padding:10px 12px;border-radius:10px;margin-bottom:12px;font-size:13px;}
.ok{background:#E6FAF5;border:1px solid #00C896;color:#00A87A;padding:10px 12px;border-radius:10px;margin-bottom:12px;font-size:13px;}
</style>
</head><body>
<h1>🩺 싹싹 서버 진단</h1>

${smsReady ? '<div class="ok">✅ CoolSMS 환경변수 모두 등록됨 — SMS 발송 준비 완료</div>' : '<div class="warn">⚠️ CoolSMS 환경변수 누락 — Railway Variables에서 등록 필요</div>'}

<div class="card">
  <h2>⚙️ 서버 상태</h2>
  <div class="summary"><span class="summary-key">서버 가동 시간</span><span class="summary-val big">${uptimeStr}</span></div>
  <div class="summary"><span class="summary-key">DB 연결</span><span class="summary-val ${dbStatus.startsWith('✅')?'green':'red'}">${dbStatus}</span></div>
  <div class="summary"><span class="summary-key">현재 시각 (KST)</span><span class="summary-val">${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span></div>
  <div class="summary"><span class="summary-key">서버 시작</span><span class="summary-val" style="font-size:11px;">${new Date(buildInfo.serverStart).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span></div>
</div>

<div class="card">
  <h2>🚂 Railway 빌드 정보</h2>
  <div class="summary"><span class="summary-key">배포된 commit</span><span class="summary-val" style="font-family:monospace;font-size:11px;">${String(buildInfo.commit).slice(0,12)}</span></div>
  <div class="summary"><span class="summary-key">배포 ID</span><span class="summary-val" style="font-family:monospace;font-size:11px;">${String(buildInfo.deployId).slice(0,16)}</span></div>
  <div style="font-size:11.5px;color:#6b7684;margin-top:8px;">💡 GitHub 최신 commit과 다르면 Railway 자동 배포가 막혀있거나 빌드 실패. (unknown)이면 Railway 환경변수 미주입.</div>
</div>

<div class="card">
  <h2>📥 예약 신청 시도 통계 (서버 시작 후)</h2>
  <div class="summary"><span class="summary-key">총 시도 횟수</span><span class="summary-val big ${_diagStats.bookingPostCount === 0 ? 'red' : 'green'}">${_diagStats.bookingPostCount}</span></div>
  <div class="summary"><span class="summary-key">성공</span><span class="summary-val green">${_diagStats.bookingSuccessCount}</span></div>
  <div class="summary"><span class="summary-key">실패</span><span class="summary-val ${_diagStats.bookingFailCount === 0 ? '' : 'red'}">${_diagStats.bookingFailCount}</span></div>
  <div class="summary"><span class="summary-key">마지막 시도</span><span class="summary-val" style="font-size:11px;">${_diagStats.lastBookingPostAt ? new Date(_diagStats.lastBookingPostAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음'}</span></div>
  <div class="summary"><span class="summary-key">마지막 성공</span><span class="summary-val" style="font-size:11px;">${_diagStats.lastBookingSuccessAt ? new Date(_diagStats.lastBookingSuccessAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음'}</span></div>
  ${_diagStats.lastBookingError ? '<div class="summary"><span class="summary-key">마지막 에러</span><span class="summary-val red" style="font-size:11px;">' + _diagStats.lastBookingError + '</span></div>' : ''}
  <div style="font-size:11.5px;color:#6b7684;margin-top:8px;">💡 사장님이 booking 신청 후 이 페이지 새로고침해서 "총 시도 횟수"가 늘면 서버 도달 ✅. 안 늘면 서버 도달 X (캐시/CORS 등 클라이언트 문제).</div>
</div>

<div class="card">
  <h2>🔑 환경변수 등록 여부</h2>
  <table>
    <tr><th>변수명</th><th>상태</th></tr>
    ${envRows}
  </table>
  <div style="font-size:11.5px;color:#6b7684;margin-top:8px;">💡 missing 항목이 있으면 Railway → Variables에서 추가하세요. 값은 보안상 노출되지 않습니다.</div>
</div>

<div class="card">
  <h2>📊 DB 데이터 현황</h2>
  <table>
    <tr><th>테이블</th><th>건수</th><th>최근 활동 (KST)</th></tr>
    ${tableRows}
  </table>
</div>

<div class="card">
  <h2>📝 진단 가이드</h2>
  <ul style="padding-left:18px;margin:8px 0;">
    <li><b>예약 신청 후 SMS 안 옴</b>: COOLSMS_* 3개 모두 ✅ set 인지 확인</li>
    <li><b>'유효하지 않은 링크'</b>: SUPABASE_* 2개 ✅ set인지 + DB connected 확인</li>
    <li><b>'인증 실패'</b>: ADMIN_KEY ✅ set인지 + 사장님 cfg.adminKey와 일치 확인</li>
    <li><b>예약 신청 0건</b>: bookings 최근 활동 시각 확인 (오늘이면 정상)</li>
  </ul>
</div>

<div style="text-align:center;font-size:11px;color:#a0a8b8;margin:20px 0;">
  싹싹 서버 진단 페이지 · 새로고침하면 최신 상태 확인
</div>
</body></html>`);
});

// 서버 시작 (JWT_SECRET 부트스트랩 완료 후)
const PORT = process.env.PORT || 3000;
JWT_BOOTSTRAP.then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 싹싹 서버 실행 중 - 포트 ${PORT}`);
    console.log(`🧹 싹싹 입주청소 전문인 플랫폼`);
    console.log(`🔑 JWT_SECRET source: ${JWT_SECRET_SOURCE}`);

    // ── 일정 리마인더 cron (매분 KST 체크) ──
    try {
      const cron = require('node-cron');
      cron.schedule('* * * * *', () => {
        _runReminders().catch(e => console.log('[cron] error:', e.message));
      });
      console.log('🔔 리마인더 cron 활성화 (매분 KST 체크)');

      // ── 휴지통 자동 정리 cron (매일 03:00 KST: 7일 이상 된 deleted=true 영구 삭제) ──
      cron.schedule('0 3 * * *', async () => {
        try {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { error, count } = await supabase.from('quote_requests')
            .delete({ count: 'exact' })
            .eq('deleted', true)
            .lte('deleted_at', sevenDaysAgo);
          if (error) console.error('[trash-cleanup] error:', error.message);
          else if (count && count > 0) console.log(`🗑 quote_requests 영구 삭제: ${count}건 (7일+ 휴지통)`);
        } catch (e) { console.error('[trash-cleanup] cron error:', e.message); }
      }, { timezone: 'Asia/Seoul' });
      console.log('🗑 휴지통 자동 정리 cron 활성화 (매일 03:00 KST)');

      // ── 신뢰 기기 만료 정리 cron (매일 03:05 KST) ──
      cron.schedule('5 3 * * *', async () => {
        try {
          const now = new Date().toISOString();
          const { error, count } = await supabase.from('trusted_devices')
            .delete({ count: 'exact' })
            .lte('expires_at', now);
          if (error) console.error('[trusted-devices-cleanup] error:', error.message);
          else if (count && count > 0) console.log(`🔒 trusted_devices 만료 정리: ${count}건`);
        } catch (e) { console.error('[trusted-devices-cleanup] cron error:', e.message); }
      }, { timezone: 'Asia/Seoul' });
      console.log('🔒 신뢰 기기 만료 정리 cron 활성화 (매일 03:05 KST)');
    } catch (e) {
      console.error('cron 활성화 실패:', e.message);
    }
  });
}).catch((e) => {
  console.error('FATAL: JWT_SECRET bootstrap failed —', e.message);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════
// 👥 인력 매칭 API
// ═══════════════════════════════════════════════════════════════

// 인력 목록 조회
app.get('/api/workers', async (req, res) => {
  try {
    const { region, skill, anon_id } = req.query;
    let q = supabase.from('worker_profiles').select('*').eq('status','active').order('created_at',{ascending:false});
    if (region) q = q.contains('regions',[region]);
    if (skill)  q = q.contains('skills',[skill]);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 내 프로필 조회
app.get('/api/workers/my/:anon_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('worker_profiles').select('*').eq('anon_id', req.params.anon_id).maybeSingle();
    if (error) throw error;
    res.json({ success:true, data: data||null });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 프로필 등록/수정 (upsert) — 입력 검증 강화
app.post('/api/workers', authRequired, async (req, res) => {
  try {
    const body = req.body || {};

    // ── 입력 검증 ──
    if (!validateAnonId(body.anon_id)) {
      return res.status(400).json({ success: false, error: 'anon_id 형식 오류' });
    }

    // 길이 제한 + trim
    const nickname     = clampStr(body.nickname, 30).trim();
    const bio          = clampStr(body.bio, 500).trim();
    const contact      = clampStr(body.contact, 50).trim();
    const experience   = clampStr(body.experience, 30).trim();
    const avatar_emoji = clampStr(body.avatar_emoji, 5);

    // daily_rate 검증 (음수/거대값 차단)
    let daily_rate = null;
    if (body.daily_rate !== undefined && body.daily_rate !== null && body.daily_rate !== '') {
      daily_rate = parseInt(body.daily_rate, 10);
      if (!Number.isFinite(daily_rate) || daily_rate < 0 || daily_rate > 9999999) {
        return res.status(400).json({ success: false, error: '일당이 올바르지 않습니다' });
      }
    }

    // 배열 검증 (길이 제한)
    const regions         = Array.isArray(body.regions)         ? body.regions.slice(0, 20).map(r => clampStr(r, 30)) : [];
    const skills          = Array.isArray(body.skills)          ? body.skills.slice(0, 20).map(s => clampStr(s, 30)) : [];
    const available_days  = Array.isArray(body.available_days)  ? body.available_days.slice(0, 7).map(d => clampStr(d, 5)) : [];
    const available_times = Array.isArray(body.available_times) ? body.available_times.slice(0, 5).map(t => clampStr(t, 10)) : [];

    // status 화이트리스트
    const status = ['active', 'inactive'].includes(body.status) ? body.status : undefined;

    const profileData = {
      anon_id: body.anon_id,
      ...(nickname     && { nickname }),
      ...(bio          && { bio }),
      ...(contact      && { contact }),
      ...(experience   && { experience }),
      ...(avatar_emoji && { avatar_emoji }),
      regions, skills, available_days, available_times,
      ...(daily_rate !== null && { daily_rate }),
      ...(status && { status }),
    };

    // 사진 처리: base64 → Supabase Storage 업로드
    if (body.photoBase64) {
      try {
        // 사이즈 제한 (10MB)
        if (typeof body.photoBase64 === 'string' && body.photoBase64.length > 14 * 1024 * 1024) {
          return res.status(400).json({ success: false, error: '사진이 너무 큽니다 (10MB 이하)' });
        }
        const cleaned = String(body.photoBase64).replace(/^data:image\/\w+;base64,/, '');
        const imgBuffer = Buffer.from(cleaned, 'base64');
        const mime = (typeof body.photoMime === 'string' && /^image\/(png|jpe?g|webp|gif)$/.test(body.photoMime)) ? body.photoMime : 'image/jpeg';
        const ext  = mime.split('/')[1].replace('jpeg', 'jpg');
        const fileName = `workers/${body.anon_id}_${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('ssak-contracts')
          .upload(fileName, imgBuffer, { contentType: mime, upsert: true });
        if (!upErr) {
          const { data: urlData } = supabase.storage
            .from('ssak-contracts')
            .getPublicUrl(fileName);
          profileData.photo_url = urlData.publicUrl;
        } else {
          console.error('사진 업로드 오류:', upErr.message);
        }
      } catch(photoErr) {
        console.error('사진 처리 오류:', photoErr.message);
      }
    } else if (body.photo_url && typeof body.photo_url === 'string') {
      // 직접 photo_url 전달 시 — 우리 Storage URL만 허용 (SSRF 방어)
      try {
        const url = new URL(body.photo_url);
        if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('supabase.co') || url.hostname === 'ssakapp.co.kr') {
          profileData.photo_url = body.photo_url;
        }
        // 외부 URL은 무시
      } catch(e) { /* 잘못된 URL 무시 */ }
    }

    profileData.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('worker_profiles')
      .upsert(profileData, { onConflict: 'anon_id' })
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch(e) {
    console.error('workers POST error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 워커 상세 조회
// 프론트가 워커 카드 클릭 시 호출. 라우트 부재로 채팅 진입 자체가 깨졌던 문제 해소.
app.get('/api/workers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('worker_profiles')
      .select('*')
      .eq('id', id)
      .neq('status', 'deleted')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: '구직자 프로필을 찾을 수 없습니다' });
    res.json({ success: true, data });
  } catch (e) {
    console.error('workers GET :id error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 워커 상태 변경 (active / inactive)
// 본인만 변경 가능 — anon_id로 본인 검증
app.patch('/api/workers/:id/status', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id, status } = req.body || {};
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status는 active 또는 inactive' });
    }

    // 본인 검증 + 상태 변경
    const { data, error } = await supabase.from('worker_profiles')
      .update({ status })
      .eq('id', id)
      .eq('anon_id', anon_id)
      .select().single();
    if (error) throw error;
    if (!data) return res.status(403).json({ success: false, error: '본인 프로필만 변경할 수 있습니다' });
    res.json({ success: true, data });
  } catch (e) {
    console.error('workers PATCH status error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 프로필 삭제 (본인만 — anon_id 검증)
app.delete('/api/workers/:id', authRequired, async (req, res) => {
  try {
    const { anon_id } = req.body || {};
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const { data, error } = await supabase.from('worker_profiles')
      .update({ status:'deleted' })
      .eq('id', req.params.id)
      .eq('anon_id', anon_id)
      .select().single();
    if (error) throw error;
    if (!data) return res.status(403).json({ success: false, error: '본인 프로필만 삭제할 수 있습니다' });
    res.json({ success: true });
  } catch(e) {
    console.error('workers DELETE error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 채용공고 (jobs) — 라우트 미스매치 일괄 수정
// 이전 문제:
//   - 서버: 'job_postings' / 'poster_anon_id' / 'regions' 배열 contains
//   - DB:   'job_posts'    / 'anon_id'        / 'region' 단일값
//   - 프론트: anon_id 키로 보냄 (DB와 일치)
// ══════════════════════════════════════════════════════════════════════

// 채용공고 목록 (지역 필터)
app.get('/api/jobs', async (req, res) => {
  try {
    const { region, status } = req.query;
    let q = supabase.from('job_posts').select('*').order('created_at', { ascending: false });
    q = q.eq('status', status || 'open');
    if (region && region !== '전체') q = q.eq('region', region);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('jobs GET error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 내가 올린 채용공고
app.get('/api/jobs/my/posted', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필요' });
    const { data, error } = await supabase.from('job_posts').select('*')
      .eq('anon_id', anon_id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('jobs my/posted error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 내가 지원한 채용공고
app.get('/api/jobs/my/applied', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필요' });
    const { data, error } = await supabase.from('job_applications')
      .select('*, job:job_posts(*)')
      .eq('applicant_anon_id', anon_id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('jobs my/applied error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 채용공고 상세 조회
// 누구나 조회 가능 (공고는 공개 정보) — anon_id 검증 없음
// 단, deleted 상태는 제외
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('job_posts')
      .select('*')
      .eq('id', id)
      .neq('status', 'deleted')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: '공고를 찾을 수 없습니다' });
    res.json({ success: true, data });
  } catch (e) {
    console.error('jobs GET :id error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 채용공고 등록
// body: { anon_id, title, region, work_date, headcount, daily_rate, skills, description, contact }
app.post('/api/jobs', authRequired, async (req, res) => {
  try {
    const { anon_id, title, region, work_date, headcount, daily_rate, skills, description, contact } = req.body || {};
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    if (!title || !title.trim()) return res.status(400).json({ success: false, error: '공고 제목 필수' });
    if (!region) return res.status(400).json({ success: false, error: '지역 필수' });
    if (!work_date) return res.status(400).json({ success: false, error: '작업 날짜 필수' });

    const row = {
      anon_id,
      title: String(title).trim().slice(0, 100),
      region,
      work_date,
      headcount: Math.max(1, Math.min(99, parseInt(headcount) || 1)),
      daily_rate: Math.max(0, parseInt(daily_rate) || 0),
      skills: Array.isArray(skills) ? skills.slice(0, 10) : [],
      description: String(description || '').slice(0, 1000),
      contact: String(contact || '').slice(0, 50),
      status: 'open'
    };
    const { data, error } = await supabase.from('job_posts').insert([row]).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    console.error('jobs POST error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 채용공고 상태 변경 (본인만 — 보안 정책 일관 적용)
app.patch('/api/jobs/:id/status', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id, status } = req.body || {};
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    if (!status || !['open', 'closed', 'matched'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status는 open/closed/matched' });
    }
    const { data, error } = await supabase.from('job_posts')
      .update({ status })
      .eq('id', id).eq('anon_id', anon_id)
      .select().single();
    if (error) throw error;
    if (!data) return res.status(403).json({ success: false, error: '본인 공고만 변경 가능' });
    res.json({ success: true, data });
  } catch (e) {
    console.error('jobs PATCH status error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 지원하기
app.post('/api/jobs/:id/apply', authRequired, async (req, res) => {
  try {
    const { applicant_anon_id, applicant_contact, worker_nickname, message } = req.body || {};
    if (!applicant_anon_id) return res.status(400).json({ success: false, error: 'anon_id 필요' });

    // 자기 자신의 공고에 지원 차단
    const { data: post } = await supabase.from('job_posts').select('anon_id, status').eq('id', req.params.id).maybeSingle();
    if (!post) return res.status(404).json({ success: false, error: '공고를 찾을 수 없습니다' });
    if (post.status !== 'open') return res.status(400).json({ success: false, error: '마감된 공고입니다' });
    if (post.anon_id === applicant_anon_id) return res.status(400).json({ success: false, error: '본인 공고에는 지원할 수 없습니다' });

    const { data, error } = await supabase.from('job_applications')
      .upsert([{
        job_id: req.params.id,
        applicant_anon_id,
        applicant_contact: String(applicant_contact || '').slice(0, 50),
        worker_nickname: String(worker_nickname || '구직자').slice(0, 30),
        message: String(message || '').slice(0, 200),
        status: 'pending'
      }], { onConflict: 'job_id,applicant_anon_id' })
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    console.error('jobs apply error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 지원자 목록 (공고 작성자만 — 보안 정책)
app.get('/api/jobs/:id/applications', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 본인 공고인지 확인
    const { data: post } = await supabase.from('job_posts').select('anon_id').eq('id', req.params.id).maybeSingle();
    if (!post) return res.status(404).json({ success: false, error: '공고를 찾을 수 없습니다' });
    if (post.anon_id !== anon_id) return res.status(403).json({ success: false, error: '본인 공고의 지원자만 조회 가능' });

    const { data, error } = await supabase.from('job_applications').select('*')
      .eq('job_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('jobs applications GET error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 매칭 확정 (공고 작성자만)
app.patch('/api/jobs/applications/:id/match', authRequired, async (req, res) => {
  try {
    const { anon_id, employer_contact } = req.body || {};
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 지원서 + 해당 공고 작성자 검증
    const { data: app } = await supabase.from('job_applications').select('job_id').eq('id', req.params.id).maybeSingle();
    if (!app) return res.status(404).json({ success: false, error: '지원서를 찾을 수 없습니다' });
    const { data: post } = await supabase.from('job_posts').select('anon_id').eq('id', app.job_id).maybeSingle();
    if (!post || post.anon_id !== anon_id) return res.status(403).json({ success: false, error: '본인 공고의 지원자만 매칭 가능' });

    const { error } = await supabase.from('job_applications')
      .update({ status: 'matched', employer_contact: String(employer_contact || '').slice(0, 50), matched_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('jobs match error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 인력 채팅 (worker chats)
// ══════════════════════════════════════════════════════════════════════

// 본인 검증 헬퍼: 해당 chat_id에 anon_id가 참여자인지 확인
async function assertChatParticipant(chat_id, anon_id) {
  if (!chat_id || !anon_id) return { ok: false, status: 400, error: 'chat_id와 anon_id 필수' };
  const { data: chat, error } = await supabase.from('worker_chats')
    .select('id, worker_anon_id, requester_anon_id').eq('id', chat_id).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!chat) return { ok: false, status: 404, error: '채팅방을 찾을 수 없습니다' };
  if (chat.worker_anon_id !== anon_id && chat.requester_anon_id !== anon_id) {
    return { ok: false, status: 403, error: '권한 없음' };
  }
  return { ok: true, chat };
}

// 입력 검증 헬퍼 (community와 동일 규칙)
function validateMsgContent(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim().slice(0, 1000);
  return trimmed || null;
}

// ── 1) 채팅방 목록 ──────────────────────────────────────────
// 본인이 참여한 채팅방만 (worker 또는 requester)
app.get('/api/worker-chats', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필요' });
    const { data, error } = await supabase.from('worker_chats')
      .select('*, worker:worker_profiles(nickname,avatar_emoji,photo_url)')
      .or(`worker_anon_id.eq.${anon_id},requester_anon_id.eq.${anon_id}`)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('worker-chats GET list error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 2) 채팅방 생성/조회 (메시지 전송과 분리) ──────────────────
// requester가 worker에게 채팅 시작
app.post('/api/worker-chats', authRequired, async (req, res) => {
  try {
    const { worker_id, requester_anon_id } = req.body || {};
    if (!worker_id || !requester_anon_id) {
      return res.status(400).json({ success: false, error: 'worker_id, requester_anon_id 필수' });
    }

    // worker_id로 worker_anon_id 조회 (요청 body의 worker_anon_id를 신뢰하지 않음 — spoofing 방어)
    const { data: profile, error: pErr } = await supabase.from('worker_profiles')
      .select('anon_id').eq('id', worker_id).maybeSingle();
    if (pErr) throw pErr;
    if (!profile) return res.status(404).json({ success: false, error: '구직자 프로필을 찾을 수 없습니다' });
    const worker_anon_id = profile.anon_id;

    // 자기 자신과 채팅 차단
    if (worker_anon_id === requester_anon_id) {
      return res.status(400).json({ success: false, error: '자신과 채팅할 수 없습니다' });
    }

    // 기존 채팅방 있으면 재사용 (UNIQUE 제약 활용)
    const { data: existing } = await supabase.from('worker_chats')
      .select('id').eq('worker_id', worker_id).eq('requester_anon_id', requester_anon_id).maybeSingle();
    if (existing) {
      return res.json({ success: true, data: { id: existing.id } });
    }

    const { data: newChat, error } = await supabase.from('worker_chats')
      .insert([{ worker_id, worker_anon_id, requester_anon_id }])
      .select('id').single();
    if (error) throw error;
    res.json({ success: true, data: newChat });
  } catch (e) {
    console.error('worker-chats POST create error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 3) 메시지 조회 (?after=<ISO>로 증분 로딩) ─────────────────
// 본인 참여 검증 필수
app.get('/api/worker-chats/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id, after } = req.query;
    const auth = await assertChatParticipant(id, anon_id);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    let q = supabase.from('worker_messages')
      .select('id, sender_anon_id, content, created_at, read_at')
      .eq('chat_id', id)
      .order('created_at', { ascending: true })
      .limit(200);
    if (after) q = q.gt('created_at', after);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('worker-chats GET messages error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 4) 메시지 전송 ──────────────────────────────────────────
app.post('/api/worker-chats/:id/messages', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id, content } = req.body || {};
    const auth = await assertChatParticipant(id, anon_id);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    const cleanContent = validateMsgContent(content);
    if (!cleanContent) return res.status(400).json({ success: false, error: '메시지 내용은 필수' });

    // 메시지 INSERT
    const { data: msg, error } = await supabase.from('worker_messages')
      .insert([{ chat_id: id, sender_anon_id: anon_id, content: cleanContent }])
      .select('id, sender_anon_id, content, created_at, read_at').single();
    if (error) throw error;

    // 채팅방 last_message + 상대방 unread +1
    const isWorkerSender = anon_id === auth.chat.worker_anon_id;
    const updates = {
      last_message: cleanContent.slice(0, 200),
      updated_at: new Date().toISOString()
    };
    // unread 증가는 raw SQL로 (race-safe)
    if (isWorkerSender) {
      // worker가 보냄 → requester unread +1
      await supabase.rpc('increment_chat_unread', { p_chat_id: id, p_field: 'requester_unread' })
        .then(() => null).catch(() => null);
    } else {
      await supabase.rpc('increment_chat_unread', { p_chat_id: id, p_field: 'worker_unread' })
        .then(() => null).catch(() => null);
    }
    // RPC가 없으면 fallback (count 안 맞을 수 있지만 작동은 함)
    await supabase.from('worker_chats').update(updates).eq('id', id);

    // ── Push 알림 발송 (Phase 3-A) ──────────────────────────
    // 수신자(상대방)에게 푸시 발송 — 비동기, 응답 차단하지 않음
    const recipientAnonId = isWorkerSender ? auth.chat.requester_anon_id : auth.chat.worker_anon_id;
    sendPushTo(recipientAnonId, {
      title: '🧹 새 메시지',
      body: cleanContent.slice(0, 100),
      tag: 'chat-' + id,                  // 같은 채팅방 알림은 1개로 묶임 (Smart Grouping)
      url: '/workforce.html?chat=' + id   // 클릭 시 채팅방 자동 진입
    }).catch(() => {});

    res.json({ success: true, data: msg });
  } catch (e) {
    console.error('worker-chats POST message error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 5) 읽음 처리 ────────────────────────────────────────────
// 본인이 채팅방을 열었을 때, 상대방이 보낸 미확인 메시지 모두 read_at 업데이트
app.post('/api/worker-chats/:id/read', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body || {};
    const auth = await assertChatParticipant(id, anon_id);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    // 상대방이 보낸 + 아직 안 읽은 메시지만 read_at 갱신
    const now = new Date().toISOString();
    const { count, error } = await supabase.from('worker_messages')
      .update({ read_at: now }, { count: 'exact' })
      .eq('chat_id', id)
      .neq('sender_anon_id', anon_id)
      .is('read_at', null);
    if (error) throw error;

    // 본인의 unread 카운터 0으로
    const isWorker = anon_id === auth.chat.worker_anon_id;
    const updates = isWorker ? { worker_unread: 0 } : { requester_unread: 0 };
    await supabase.from('worker_chats').update(updates).eq('id', id);

    res.json({ success: true, marked: count || 0 });
  } catch (e) {
    console.error('worker-chats POST read error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 6) 미확인 메시지 카운트 (배지용 — Phase 3-B) ─────────────
// 본인이 참여한 모든 채팅방의 unread 합산. 가벼운 쿼리로 폴링용.
app.get('/api/worker-chats/unread-count', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필요' });
    const { data, error } = await supabase.from('worker_chats')
      .select('worker_anon_id, requester_anon_id, worker_unread, requester_unread')
      .or(`worker_anon_id.eq.${anon_id},requester_anon_id.eq.${anon_id}`);
    if (error) throw error;
    let count = 0;
    (data || []).forEach(c => {
      if (c.worker_anon_id === anon_id) count += (c.worker_unread || 0);
      else if (c.requester_anon_id === anon_id) count += (c.requester_unread || 0);
    });
    res.json({ success: true, count });
  } catch (e) {
    console.error('worker-chats unread-count error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// 🛒 중고거래 API
// ═══════════════════════════════════════════════════════════════


// market_chats 본인 참여 검증 헬퍼
async function assertMarketChatParticipant(chat_id, anon_id) {
  if (!chat_id || !anon_id) return { ok: false, status: 400, error: 'chat_id와 anon_id 필수' };
  const { data: chat, error } = await supabase.from('market_chats')
    .select('id, buyer_anon_id, seller_anon_id, listing_id').eq('id', chat_id).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!chat) return { ok: false, status: 404, error: '채팅방을 찾을 수 없습니다' };
  if (chat.buyer_anon_id !== anon_id && chat.seller_anon_id !== anon_id) {
    return { ok: false, status: 403, error: '권한 없음' };
  }
  return { ok: true, chat };
}

// 목록 조회 (무한스크롤 + 검색 + 카테고리)
app.get('/api/market/listings', async (req, res) => {
  try {
    const page = parseInt(req.query.page)||0;
    const limit = parseInt(req.query.limit)||20;
    const { search, category } = req.query;
    let q = supabase.from('market_listings').select('*', { count:'exact' })
      .neq('status','deleted').order('created_at',{ascending:false})
      .range(page*limit, (page+1)*limit-1);
    if (category && category !== '전체') q = q.eq('category', category);
    if (search) q = q.ilike('title', `%${search}%`);
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ success:true, data: data||[], total: count||0, hasMore: (page+1)*limit < (count||0) });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 내 목록
app.get('/api/market/listings/mine', async (req, res) => {
  try {
    const { anon_id } = req.query;
    const { data, error } = await supabase.from('market_listings').select('*').eq('anon_id', anon_id).neq('status','deleted').order('created_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 상세 조회 + 조회수 증가 (jobs 사고 패턴 fix: maybeSingle + deleted 제외 + 404)
app.get('/api/market/listings/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('market_listings').select('*').eq('id', req.params.id).neq('status','deleted').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: '상품을 찾을 수 없습니다' });
    supabase.from('market_listings').update({ views: (data.views||0)+1 }).eq('id', req.params.id).then(() => {});
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

// 등록 (화이트리스트 + 입력 검증 — body spread 차단)
app.post('/api/market/listings', authRequired, async (req, res) => {
  try {
    const { anon_id, title, description, price, category, image_url, contact } = req.body || {};
    if (!anon_id || !title || price === undefined) return res.status(400).json({ success:false, error: '필수값 누락' });

    const cleanTitle = String(title).trim().slice(0, 100);
    const cleanDesc  = String(description || '').trim().slice(0, 2000);
    const cleanCat   = String(category || '기타').slice(0, 30);
    const cleanCont  = String(contact || '').trim().slice(0, 50);
    const numPrice   = parseInt(price, 10);

    if (!cleanTitle) return res.status(400).json({ success:false, error: '제목 필수' });
    if (!Number.isFinite(numPrice) || numPrice < 0 || numPrice > 99999999) {
      return res.status(400).json({ success:false, error: '가격이 올바르지 않습니다' });
    }

    const insertData = {
      anon_id, title: cleanTitle, description: cleanDesc, price: numPrice,
      category: cleanCat, image_url: image_url || null, contact: cleanCont,
      status: 'available', views: 0
    };

    const { data, error } = await supabase.from('market_listings').insert([insertData]).select().single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

// 상태 변경 (available/reserved/sold)
app.patch('/api/market/listings/:id/status', authRequired, async (req, res) => {
  try {
    const { status, anon_id } = req.body;
    const { error } = await supabase.from('market_listings').update({ status }).eq('id', req.params.id).eq('anon_id', anon_id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 삭제
app.delete('/api/market/listings/:id', authRequired, async (req, res) => {
  try {
    const { anon_id } = req.body;
    const { error } = await supabase.from('market_listings').update({ status:'deleted' }).eq('id', req.params.id).eq('anon_id', anon_id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 채팅방 목록
app.get('/api/market/chats', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필요' });
    const { data, error } = await supabase.from('market_chats').select('*, listing:market_listings(title,image_url,price)').or(`buyer_anon_id.eq.${anon_id},seller_anon_id.eq.${anon_id}`).order('updated_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// 채팅 메시지 조회 (본인 참여 검증)
app.get('/api/market/chats/:id', async (req, res) => {
  try {
    const { anon_id } = req.query;
    const auth = await assertMarketChatParticipant(req.params.id, anon_id);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    const { data, error } = await supabase.from('market_messages').select('*').eq('chat_id', req.params.id).order('created_at',{ascending:true}).limit(100);
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

// 채팅 시작/메시지 전송 (seller 서버 조회 — 스푸핑 방어)
app.post('/api/market/chats', async (req, res) => {
  try {
    const { listing_id, buyer_anon_id, content } = req.body || {};
    if (!listing_id || !buyer_anon_id) return res.status(400).json({ success: false, error: 'listing_id, buyer_anon_id 필수' });

    // listing_id로 seller 서버 조회 (요청 body의 seller_anon_id를 신뢰하지 않음)
    const { data: listing, error: lErr } = await supabase.from('market_listings')
      .select('anon_id, status').eq('id', listing_id).maybeSingle();
    if (lErr) throw lErr;
    if (!listing) return res.status(404).json({ success: false, error: '상품을 찾을 수 없습니다' });
    if (listing.status === 'deleted') return res.status(400).json({ success: false, error: '삭제된 상품입니다' });
    const seller_anon_id = listing.anon_id;
    if (seller_anon_id === buyer_anon_id) return res.status(400).json({ success: false, error: '자신과 채팅할 수 없습니다' });

    let chat;
    const { data: existing } = await supabase.from('market_chats').select('id').eq('listing_id', listing_id).eq('buyer_anon_id', buyer_anon_id).maybeSingle();
    if (existing) {
      chat = existing;
    } else {
      const { data: newChat, error } = await supabase.from('market_chats').insert([{ listing_id, buyer_anon_id, seller_anon_id }]).select().single();
      if (error) throw error;
      chat = newChat;
    }
    if (content) {
      const trimmed = String(content).trim().slice(0, 1000);
      if (trimmed) {
        await supabase.from('market_messages').insert([{ chat_id: chat.id, sender_anon_id: buyer_anon_id, content: trimmed }]);
        await supabase.from('market_chats').update({ last_message: trimmed.slice(0,200), updated_at: new Date().toISOString() }).eq('id', chat.id);
      }
    }
    res.json({ success:true, data: chat });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});

// 메시지 전송 (본인 참여 검증 + 입력 검증)
app.post('/api/market/chats/:id', async (req, res) => {
  try {
    const { sender_anon_id, content } = req.body || {};
    const auth = await assertMarketChatParticipant(req.params.id, sender_anon_id);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    const trimmed = String(content || '').trim().slice(0, 1000);
    if (!trimmed) return res.status(400).json({ success: false, error: '메시지 내용은 필수' });
    const { data, error } = await supabase.from('market_messages').insert([{ chat_id: req.params.id, sender_anon_id, content: trimmed }]).select().single();
    if (error) throw error;
    await supabase.from('market_chats').update({ last_message: trimmed.slice(0,200), updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ success:false, error: e.message }); }
});
