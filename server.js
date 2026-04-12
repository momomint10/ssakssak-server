const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Supabase 연결
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
          // LMS: 전달받은 subject 사용 (없으면 공백 대신 기본값)
          // subject가 명시적으로 설정되면 CoolSMS가 첫 줄 자동추출 안 함
          ...(msgType === 'LMS' ? { subject: (subject && subject.trim()) ? subject.trim().slice(0,20) : '[서프로클린] 문자' } : {})
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
  const { contractData, ownerSignature, ownerPhone, customerPhone, customerName, companyName, companyPhone } = req.body;
  if (!contractData || !customerPhone) {
    return res.status(400).json({ error: '필수 데이터가 없습니다' });
  }
  try {
    const crypto = require('crypto');
    const token = crypto.randomBytes(20).toString('hex');

    const { error } = await supabase.from('pending_contracts').insert([{
      token,
      contract_data: contractData,
      owner_signature: ownerSignature || null,
      status: 'pending'
    }]);
    if (error) throw error;

    const signUrl = `https://momomint10.github.io/ssak-app/sign.html?token=${token}`;
    const msg = `[${companyName||'서프로클린'}] 계약서 서명 요청\n\n${customerName||'고객'}님, 아래 링크에서 계약서 내용을 확인하고 서명해 주세요.\n\n${signUrl}\n\n링크는 7일간 유효합니다.\n\n문의: ${companyPhone||''}`;

    await sendSMSUtil(customerPhone.replace(/-/g,''), msg, `[${companyName||'서프로클린'}] 계약서`);

    console.log(`계약서 생성: ${token}`);
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

// ── 예약 신청 접수 ─────────────────────────────────────────────────────────
app.post('/api/booking', async (req, res) => {
  const { name, phone, address, size, type, date, time, notes, price, companyName } = req.body;

  if (!name || !phone || !address) {
    return res.status(400).json({ error: '이름, 연락처, 주소는 필수입니다' });
  }

  const typeLabels = { 'move-in':'입주 전', 'move-out':'이사 후', 'new':'신축 준공', 'life':'생활 청소' };

  try {
    // Supabase bookings 테이블에 저장
    const { data: booking, error } = await supabase
      .from('bookings')
      .insert([{
        name,
        phone: phone.replace(/-/g, ''),
        address,
        size: size ? parseInt(size) : null,
        type: type || 'move-in',
        preferred_date: date || null,
        preferred_time: time || null,
        notes: notes || null,
        price: price ? parseInt(price) : null,
        company_name: companyName || '서프로클린',
        status: 'pending',
      }])
      .select()
      .single();

    if (error) throw error;

    // 사장님에게 SMS 알림 발송
    const ownerPhone = process.env.COOLSMS_FROM; // 알림 수신 번호 (발신번호 재사용)
    const typeLabel  = typeLabels[type] || type || '입주 전';
    const ownerMsg   =
      `안녕하세요! 새 예약이 접수됐어요.\n\n` +
      `고객: ${name} (${phone})\n` +
      `주소: ${address}\n` +
      `유형: ${size ? size + '평 ' : ''}${typeLabel}\n` +
      (date ? `희망일: ${date}${time ? ' ' + time : ''}\n` : '') +
      (price ? `견적: ${parseInt(price).toLocaleString()}원\n` : '') +
      (notes ? `요청: ${notes}\n` : '') +
      `\n싹싹 앱에서 확인하세요 🧹`;

    if (ownerPhone) {
      await sendSMSUtil(ownerPhone.replace(/-/g, ''), ownerMsg, '새 예약 접수');
    }

    // 고객에게 접수 확인 SMS 발송
    const customerMsg =
      `안녕하세요, ${name}님!\n${companyName || '서프로클린'} 입주청소입니다.\n\n` +
      `예약 신청이 접수됐어요.\n` +
      `담당자가 확인 후 빠르게 연락드리겠습니다 😊\n\n` +
      (date ? `희망일: ${date}${time ? ' ' + time : ''}\n` : '') +
      `문의: ${process.env.COOLSMS_FROM || ''}`;

    await sendSMSUtil(phone.replace(/-/g, ''), customerMsg, `[${companyName || '서프로클린'}] 예약접수`);

    console.log(`예약 접수: ${name} (${phone})`);
    res.json({ success: true, bookingId: booking.id });

  } catch (err) {
    console.error('예약 접수 오류:', err);
    res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

// ── 예약 목록 조회 (사장님용) ───────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }

  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json({ success: true, count: data.length, data });

  } catch (err) {
    console.error('예약 조회 오류:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 예약 상태 변경 (사장님용) ───────────────────────────────────────────────
app.put('/api/bookings/:id/status', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: '인증 실패' });
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


// ── 예약링크 토큰 생성 (URL 단축용) ───────────────────────────────────────
// 견적 데이터를 서버에 저장 → 짧은 토큰 반환 → booking.html?t={token}
app.post('/api/booking/token', async (req, res) => {
  const { name, phone, size, type, price, companyName } = req.body;
  try {
    const crypto = require('crypto');
    const token = crypto.randomBytes(6).toString('hex'); // 12자리 짧은 토큰

    const { error } = await supabase.from('booking_tokens').insert([{
      token,
      quote_data: { name, phone, size, type, price, companyName },
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7일 유효
    }]);
    if (error) throw error;

    const finalUrl = `https://momomint10.github.io/ssak-app/booking.html?t=${token}`;
    res.json({ success: true, url: finalUrl, token });
  } catch (err) {
    console.error('토큰 생성 오류:', err);
    res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

// ── 예약링크 토큰 조회 ──────────────────────────────────────────────────────
app.get('/api/booking/token/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { data, error } = await supabase
      .from('booking_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !data) return res.status(404).json({ error: '유효하지 않은 링크입니다' });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: '만료된 링크입니다 (7일 초과)' });

    res.json({ success: true, data: data.quote_data });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 싹싹 서버 실행 중 - 포트 ${PORT}`);
  console.log(`🧹 싹싹 입주청소 전문인 플랫폼`);
});
