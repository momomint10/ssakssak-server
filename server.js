const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const app = express();

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
    return res.status(400).json({ error: '업체명과 연락처는 필수입니다' });
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
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ── 구독자 목록 조회 (관리자용) ─────────────────
app.get('/api/subscribers', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }

  try {
    const { data, error } = await supabase
      .from('subscribers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, count: data.length, data });

  } catch (err) {
    console.error('구독자 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 구독자 상태 변경 (관리자용) ─────────────────
app.put('/api/subscribers/:id/status', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }

  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'active', 'paused', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '유효하지 않은 상태값입니다' });
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
    res.status(500).json({ error: '서버 오류' });
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
    res.status(500).json({ error: '서버 오류' });
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
    res.status(500).json({ error: '서버 오류' });
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
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 통계 (관리자용) ──────────────────────────────
app.get('/api/stats', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }

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
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── SMS 발송 (CoolSMS) ────────────────────────
app.post('/api/sms/send', async (req, res) => {
  const { to, msg, subject } = req.body;

  // 환경변수에서 API 키 로드 (사용자에게 노출 안 됨)
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_FROM;

  if (!apiKey || !apiSecret || !from) {
    return res.status(500).json({ error: 'SMS API가 설정되지 않았습니다.' });
  }
  if (!to || !msg) {
    return res.status(400).json({ error: '수신번호와 메시지는 필수입니다' });
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
      res.json({ success: true, message: '발송 완료', type: msgType });
    } else {
      console.error('SMS 발송 실패:', data);
      res.status(400).json({ error: data.errorMessage || '발송 실패' });
    }

  } catch (err) {
    console.error('SMS 발송 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ── SMS 발송 공통 함수 ───────────────────────────
// subject 미설정 시 CoolSMS가 본문 첫 줄을 자동 추출 → [Web발신] 앞뒤 중복 원인
async function sendSMSUtil(to, msg, subject) {
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
  return response.ok ? { ok: true } : { ok: false, error: (await response.json()).errorMessage };
}

// ── 계약서 PDF 업로드 & SMS 발송 ─────────────────
app.post('/api/contract/upload', async (req, res) => {
  const { pdfBase64, customerPhone, ownerPhone, customerName, companyName, companyPhone } = req.body;

  if (!pdfBase64 || !customerPhone) {
    return res.status(400).json({ error: '필수 데이터가 없습니다' });
  }

  try {
    // base64 → Buffer 변환
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const timestamp = Date.now();
    const fileName = `${timestamp}_${customerPhone.replace(/-/g,'')}.pdf`;
    const filePath = `contracts/${fileName}`;

    // Supabase Storage 업로드
    const { error: uploadError } = await supabase.storage
      .from('ssak-contracts')
      .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (uploadError) throw uploadError;

    // Public URL 생성
    const { data: urlData } = supabase.storage
      .from('ssak-contracts')
      .getPublicUrl(filePath);

    const pdfUrl = urlData.publicUrl;

    // 계약서 SMS 문구
    const customerMsg = `📋 [${companyName||'서프로클린'}] 계약서 안내\n${customerName}님, 계약서가 작성되었습니다.\n\n아래 링크에서 확인 및 보관하세요:\n${pdfUrl}\n\n문의: ${companyPhone||''}`;
    const ownerMsg = `📋 계약서 체결 완료\n고객: ${customerName}님 (${customerPhone})\n\n계약서 링크:\n${pdfUrl}`;

    // 고객 SMS 발송
    await sendSMSUtil(customerPhone, customerMsg);

    // 사장님 SMS 발송 (번호가 있고 고객과 다를 때)
    if (ownerPhone && ownerPhone.replace(/-/g,'') !== customerPhone.replace(/-/g,'')) {
      await sendSMSUtil(ownerPhone, ownerMsg);
    }

    console.log(`계약서 업로드 완료: ${filePath}`);
    res.json({ success: true, pdfUrl });

  } catch (err) {
    console.error('계약서 업로드 오류:', err);
    res.status(500).json({ error: '서버 오류: ' + err.message });
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

  // 보안: admin_key 검증 (호환 모드)
  // - adminKey 있으면 strict 검증 (스푸핑 차단)
  // - adminKey 없으면 통과 (구버전 sign.html / cfg 미설정 호환)
  if (adminKey && adminKey !== process.env.ADMIN_KEY) {
    console.warn('contract/create: admin_key mismatch, blocking');
    return res.status(401).json({ success: false, error: '인증 실패 — 설정의 ADMIN_KEY를 Railway 환경변수와 동일하게 입력해 주세요' });
  }
  if (!adminKey) {
    console.log('contract/create: admin_key missing (compatibility mode)');
  }

  if (!customerPhone) {
    return res.status(400).json({ error: '고객 연락처가 없습니다' });
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
    const msg = `[${companyName}] 계약서 서명 요청\n\n${customerName||'고객'}님, 아래 링크에서 계약서 내용을 확인하고 서명해 주세요.\n\n${signUrl}\n\n링크는 7일간 유효합니다.\n\n문의: ${companyPhone}`;

    await sendSMSUtil(customerPhone.replace(/-/g,''), msg, `[${companyName}] 계약서 서명요청`);

    console.log(`계약서 생성: ${token} / ${customerName} (${customerPhone})`);
    res.json({ success: true, token, signUrl });
  } catch (err) {
    console.error('계약서 생성 오류:', err);
    res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

// ── 비대면 계약서: 고객 조회 ─────────────────────────
app.get('/api/contract/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { data, error } = await supabase.from('pending_contracts').select('*').eq('token', token).single();
    if (error || !data) return res.status(404).json({ error: '계약서를 찾을 수 없습니다' });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: '만료된 계약서입니다' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 비대면 계약서: 고객 서명 완료 & PDF 생성 ────────────
app.post('/api/contract/:token/sign', async (req, res) => {
  const { token } = req.params;
  const { customerSignature, pdfBase64 } = req.body;
  if (!customerSignature) return res.status(400).json({ error: '서명이 없습니다' });

  try {
    const { data: contract, error } = await supabase.from('pending_contracts').select('*').eq('token', token).single();
    if (error || !contract) return res.status(404).json({ error: '계약서를 찾을 수 없습니다' });
    if (contract.status === 'completed') return res.status(400).json({ error: '이미 서명된 계약서입니다' });

    const cd = contract.contract_data;
    let pdfUrl = null;

    // PDF 업로드
    if (pdfBase64) {
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const fileName = `${Date.now()}_${token.slice(0,8)}.pdf`;
      const filePath = `contracts/${fileName}`;
      const { error: uploadError } = await supabase.storage.from('ssak-contracts').upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
      if (!uploadError) {
        const { data: urlData } = supabase.storage.from('ssak-contracts').getPublicUrl(filePath);
        pdfUrl = urlData.publicUrl;
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

    if (customerPhone) await sendSMSUtil(customerPhone.replace(/-/g,''), customerMsg, `[${companyName}] 서명 완료`);
    if (companyPhone) await sendSMSUtil(companyPhone.replace(/-/g,''), ownerMsg, '계약서 서명 완료');

    console.log(`계약서 서명 완료: ${token}`);
    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error('서명 완료 오류:', err);
    res.status(500).json({ error: '서버 오류: ' + err.message });
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
app.post('/api/schedules', async (req, res) => {
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
app.put('/api/schedules/:id', async (req, res) => {
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
app.delete('/api/schedules/:id', async (req, res) => {
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

    let q = supabase.from('community_posts')
      .select('id, anon_id, title, content, image_url, like_count, comment_count, created_at')
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);

    if (search) {
      // ILIKE on title or content. Supabase의 .or() 사용
      const pat = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      q = q.or(`title.ilike.${pat},content.ilike.${pat}`);
    }

    const { data, error } = await q;
    if (error) throw error;

    const enriched = (data || []).map(p => ({
      ...p,
      nickname: nicknameOf(p.anon_id)
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('community posts GET error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2) 피드 글 작성 (이미지 base64 업로드 지원)
app.post('/api/community/posts', async (req, res) => {
  try {
    const { anon_id, title, content, imageBase64, imageMime } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const t = clampStr(title || '', 100).trim();
    const c = clampStr(content || '', 2000).trim();
    if (!c) return res.status(400).json({ success: false, error: '내용은 필수' });

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
      anon_id, title: t || null, content: c, image_url, category: '일반'
    }]).select().single();
    if (error) throw error;

    res.json({ success: true, data: { ...data, nickname: nicknameOf(anon_id) } });
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
      .select('id, anon_id, title, content, image_url, like_count, comment_count, created_at, deleted')
      .eq('id', id).single();
    if (pErr) throw pErr;
    if (!post || post.deleted) return res.status(404).json({ success: false, error: '글을 찾을 수 없습니다' });

    const { data: comments, error: cErr } = await supabase.from('community_comments')
      .select('id, anon_id, content, created_at')
      .eq('post_id', id).eq('deleted', false)
      .order('created_at', { ascending: true });
    if (cErr) throw cErr;

    // 내가 좋아요했는지
    let liked = false;
    if (anon_id) {
      const { data: lk } = await supabase.from('community_likes')
        .select('id').eq('post_id', id).eq('anon_id', anon_id).maybeSingle();
      liked = !!lk;
    }

    const enrichedComments = (comments || []).map(c => ({
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      nickname: nicknameOf(c.anon_id),
      is_mine: anon_id && c.anon_id === anon_id
    }));

    res.json({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        image_url: post.image_url,
        like_count: post.like_count,
        comment_count: post.comment_count,
        created_at: post.created_at,
        nickname: nicknameOf(post.anon_id),
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
app.delete('/api/community/posts/:id', async (req, res) => {
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
app.post('/api/community/posts/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 글 존재 확인
    const { data: post, error: pErr } = await supabase.from('community_posts')
      .select('id, like_count, deleted').eq('id', id).single();
    if (pErr || !post || post.deleted) return res.status(404).json({ success: false, error: '글을 찾을 수 없습니다' });

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
app.post('/api/community/posts/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id, content } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });
    const c = clampStr(content || '', 500).trim();
    if (!c) return res.status(400).json({ success: false, error: '댓글 내용은 필수' });

    // 글 존재 확인
    const { data: post } = await supabase.from('community_posts')
      .select('id, comment_count, deleted').eq('id', id).single();
    if (!post || post.deleted) return res.status(404).json({ success: false, error: '글을 찾을 수 없습니다' });

    // 댓글 INSERT
    const { data: cmt, error: cErr } = await supabase.from('community_comments')
      .insert([{ post_id: id, anon_id, content: c }])
      .select().single();
    if (cErr) throw cErr;

    // comment_count 재계산
    const { count } = await supabase.from('community_comments')
      .select('*', { count: 'exact', head: true }).eq('post_id', id).eq('deleted', false);
    await supabase.from('community_posts').update({ comment_count: count || 0 }).eq('id', id);

    res.json({
      success: true,
      data: {
        id: cmt.id,
        content: cmt.content,
        created_at: cmt.created_at,
        nickname: nicknameOf(anon_id)
      }
    });
  } catch (err) {
    console.error('community comment POST error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7) 댓글 삭제 (본인만)
app.delete('/api/community/comments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { anon_id } = req.body || {};
    if (!validateAnonId(anon_id)) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // 댓글 본인 확인 + soft delete
    const { data: cmt, error: cErr } = await supabase.from('community_comments')
      .update({ deleted: true })
      .eq('id', id).eq('anon_id', anon_id)
      .select('id, post_id').single();
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
// body: { endpoint, p256dh, auth, anon_id, deviceId? }
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { endpoint, p256dh, auth, anon_id, deviceId } = req.body || {};
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ success: false, error: 'endpoint, p256dh, auth 필수' });
    }
    if (!anon_id) return res.status(400).json({ success: false, error: 'anon_id 필수' });

    // endpoint UNIQUE 제약 활용 — upsert로 중복 시 갱신
    const { data, error } = await supabase.from('push_subscriptions')
      .upsert([{
        endpoint,
        p256dh,
        auth,
        anon_id,
        device_id: deviceId || null,
        updated_at: new Date().toISOString()
      }], { onConflict: 'endpoint' })
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
app.delete('/api/push/subscribe', async (req, res) => {
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

// ── 예약 신청 접수 ─────────────────────────────────────────────────────────
app.post('/api/booking', async (req, res) => {
  try {
    const { name, phone, addr, size, type, date, time, notes, ownerPhone, apiKey, apiSecret, fromPhone, company } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, error: '이름과 연락처는 필수입니다.' });

    const bookingData = {
      name, phone,
      addr: addr || '',
      size: size || '',
      type: type || '입주 전 청소',
      date: date || '',
      time: time || '',
      notes: notes || '',
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase.from('bookings').insert([bookingData]).select().single();
    if (error) throw error;

    // 업주에게 SMS 알림 (설정된 경우)
    if (ownerPhone && apiKey && apiSecret && fromPhone) {
      try {
        const msg = `[싹싹] 새 예약신청이 왔습니다!\n고객: ${name} (${phone})\n날짜: ${date} ${time}\n유형: ${type} ${size}평\n주소: ${addr}\n앱에서 확인하세요.`;
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const salt = Math.random().toString(36).substr(2, 16);
        const hmacStr = timestamp + salt;
        const crypto = require('crypto');
        const signature = crypto.createHmac('sha256', apiSecret).update(hmacStr).digest('hex');
        await fetch('https://api.coolsms.co.kr/messages/v4/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${timestamp}, salt=${salt}, signature=${signature}` },
          body: JSON.stringify({ message: { to: ownerPhone, from: fromPhone, text: msg } })
        });
      } catch(smsErr) { console.log('SMS 알림 실패(무시):', smsErr.message); }
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('booking error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/bookings', async (req, res) => {
  // 보안: 사장님 데이터 → adminKey 필수 (header OR query 둘 다 수용)
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey || '';
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, error: '인증 실패' });
  }
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

app.patch('/api/bookings/:id', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey || '';
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, error: '인증 실패' });
  }
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

app.put('/api/bookings/:id/status', async (req, res) => {
  // header OR query 둘 다 수용 (schedule.html 호환)
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey || '';
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, error: '인증 실패' });
  }

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
    res.status(500).json({ error: '서버 오류' });
  }
});

// ──────────────────────────────────────────────────────────────
// 📅 예약 단축 URL 토큰 (booking_tokens 테이블 활용)
// 긴 URL → 짧은 ?t=xxx 토큰 URL로 변환
// ──────────────────────────────────────────────────────────────
app.post('/api/booking/token', async (req, res) => {
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

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 싹싹 서버 실행 중 - 포트 ${PORT}`);
  console.log(`🧹 싹싹 입주청소 전문인 플랫폼`);
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 내 프로필 조회
app.get('/api/workers/my/:anon_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('worker_profiles').select('*').eq('anon_id', req.params.anon_id).maybeSingle();
    if (error) throw error;
    res.json({ success:true, data: data||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 프로필 등록/수정 (upsert)
app.post('/api/workers', async (req, res) => {
  try {
    const body = req.body;
    if (!body.anon_id) return res.status(400).json({ error: 'anon_id 필요' });

    // DB에 저장할 허용 필드만 추출 (unknown 컬럼 에러 방지)
    const allowed = ['anon_id','nickname','regions','skills','available_days',
                     'available_times','experience','daily_rate','bio',
                     'contact','avatar_emoji','status','photo_url'];
    const profileData = {};
    for (const k of allowed) {
      if (body[k] !== undefined) profileData[k] = body[k];
    }

    // 사진 처리: base64 → Supabase Storage 업로드
    if (body.photoBase64) {
      try {
        const imgBuffer = Buffer.from(body.photoBase64, 'base64');
        const mime = body.photoMime || 'image/jpeg';
        const ext  = mime.split('/')[1] || 'jpg';
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
    }

    profileData.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('worker_profiles')
      .upsert(profileData, { onConflict: 'anon_id' })
      .select().single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.patch('/api/workers/:id/status', async (req, res) => {
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

// 프로필 삭제
app.delete('/api/workers/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('worker_profiles').update({ status:'deleted' }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.post('/api/jobs', async (req, res) => {
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
app.patch('/api/jobs/:id/status', async (req, res) => {
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
app.post('/api/jobs/:id/apply', async (req, res) => {
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
app.patch('/api/jobs/applications/:id/match', async (req, res) => {
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
app.post('/api/worker-chats', async (req, res) => {
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
app.post('/api/worker-chats/:id/messages', async (req, res) => {
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
app.post('/api/worker-chats/:id/read', async (req, res) => {
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 내 목록
app.get('/api/market/listings/mine', async (req, res) => {
  try {
    const { anon_id } = req.query;
    const { data, error } = await supabase.from('market_listings').select('*').eq('anon_id', anon_id).neq('status','deleted').order('created_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.post('/api/market/listings', async (req, res) => {
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
app.patch('/api/market/listings/:id/status', async (req, res) => {
  try {
    const { status, anon_id } = req.body;
    const { error } = await supabase.from('market_listings').update({ status }).eq('id', req.params.id).eq('anon_id', anon_id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 삭제
app.delete('/api/market/listings/:id', async (req, res) => {
  try {
    const { anon_id } = req.body;
    const { error } = await supabase.from('market_listings').update({ status:'deleted' }).eq('id', req.params.id).eq('anon_id', anon_id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채팅방 목록
app.get('/api/market/chats', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ error: 'anon_id 필요' });
    const { data, error } = await supabase.from('market_chats').select('*, listing:market_listings(title,image_url,price)').or(`buyer_anon_id.eq.${anon_id},seller_anon_id.eq.${anon_id}`).order('updated_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
