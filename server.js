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
  try {
    const status = req.query.status || null;
    let query = supabase.from('bookings').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/bookings/:id', async (req, res) => {
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
    if (region) q = q.eq('region', region);
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
    const { data, error } = await supabase.from('worker_profiles')
      .upsert({ ...body, updated_at: new Date().toISOString() }, { onConflict: 'anon_id' })
      .select().single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 프로필 삭제
app.delete('/api/workers/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('worker_profiles').update({ status:'deleted' }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 인력 프로필 상태 변경 (active/inactive)
app.patch('/api/workers/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const { error } = await supabase.from('worker_profiles').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채용공고 단일 조회
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('job_posts').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채용공고 목록
app.get('/api/jobs', async (req, res) => {
  try {
    const { region, status, anon_id } = req.query;
    let q = supabase.from('job_posts').select('*').order('created_at',{ascending:false});
    if (status) q = q.eq('status', status);
    else q = q.eq('status','open');
    if (region) q = q.eq('region', region);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 내가 올린 채용공고
app.get('/api/jobs/my/posted', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ error: 'anon_id 필요' });
    const { data, error } = await supabase.from('job_posts').select('*').eq('anon_id', anon_id).order('created_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 내가 지원한 채용공고
app.get('/api/jobs/my/applied', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ error: 'anon_id 필요' });
    const { data, error } = await supabase.from('job_applications').select('*, job:job_posts(*)').eq('applicant_anon_id', anon_id).order('created_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채용공고 등록
app.post('/api/jobs', async (req, res) => {
  try {
    const body = req.body;
    if (!body.anon_id || !body.title) return res.status(400).json({ error: '필수값 누락' });
    const { data, error } = await supabase.from('job_posts').insert([{ ...body, status:'open' }]).select().single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채용공고 상태 변경
app.patch('/api/jobs/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const { error } = await supabase.from('job_posts').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 지원하기
app.post('/api/jobs/:id/apply', async (req, res) => {
  try {
    const { applicant_anon_id, message } = req.body;
    if (!applicant_anon_id) return res.status(400).json({ error: 'anon_id 필요' });
    const { data, error } = await supabase.from('job_applications')
      .upsert([{ job_id: req.params.id, applicant_anon_id, message: message||'', status:'pending' }], { onConflict: 'job_id,applicant_anon_id' })
      .select().single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 지원자 목록
app.get('/api/jobs/:id/applications', async (req, res) => {
  try {
    const { data, error } = await supabase.from('job_applications').select('*').eq('job_id', req.params.id).order('created_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 매칭 확정
app.patch('/api/jobs/applications/:id/match', async (req, res) => {
  try {
    const { error } = await supabase.from('job_applications').update({ status:'matched' }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 인력 채팅방 목록
app.get('/api/worker-chats', async (req, res) => {
  try {
    const { anon_id } = req.query;
    if (!anon_id) return res.status(400).json({ error: 'anon_id 필요' });
    const { data, error } = await supabase.from('worker_chats').select('*, worker:worker_profiles(nickname,avatar_emoji)').or(`worker_anon_id.eq.${anon_id},requester_anon_id.eq.${anon_id}`).order('updated_at',{ascending:false});
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채팅방 메시지 (기본 경로)
app.get('/api/worker-chats/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('worker_messages').select('*').eq('chat_id', req.params.id).order('created_at',{ascending:true}).limit(100);
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채팅방 메시지 (messages 서브경로)
app.get('/api/worker-chats/:id/messages', async (req, res) => {
  try {
    const { data, error } = await supabase.from('worker_messages').select('*').eq('chat_id', req.params.id).order('created_at',{ascending:true}).limit(100);
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채팅 시작/메시지 전송
app.post('/api/worker-chats', async (req, res) => {
  try {
    const { worker_id, worker_anon_id, requester_anon_id, content } = req.body;
    let chat;
    const { data: existing } = await supabase.from('worker_chats').select('id').eq('worker_id', worker_id).eq('requester_anon_id', requester_anon_id).maybeSingle();
    if (existing) {
      chat = existing;
    } else {
      const { data: newChat, error } = await supabase.from('worker_chats').insert([{ worker_id, worker_anon_id, requester_anon_id }]).select().single();
      if (error) throw error;
      chat = newChat;
    }
    if (content) {
      await supabase.from('worker_messages').insert([{ chat_id: chat.id, sender_anon_id: requester_anon_id, content }]);
      await supabase.from('worker_chats').update({ last_message: content, updated_at: new Date().toISOString(), worker_unread: supabase.rpc ? 1 : 1 }).eq('id', chat.id);
    }
    res.json({ success:true, data: chat });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 메시지 전송 (기본 경로)
app.post('/api/worker-chats/:id', async (req, res) => {
  try {
    const { sender_anon_id, content } = req.body;
    const { data, error } = await supabase.from('worker_messages').insert([{ chat_id: req.params.id, sender_anon_id, content }]).select().single();
    if (error) throw error;
    await supabase.from('worker_chats').update({ last_message: content, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 메시지 전송 (messages 서브경로)
app.post('/api/worker-chats/:id/messages', async (req, res) => {
  try {
    const { sender_anon_id, content } = req.body;
    const { data, error } = await supabase.from('worker_messages').insert([{ chat_id: req.params.id, sender_anon_id, content }]).select().single();
    if (error) throw error;
    await supabase.from('worker_chats').update({ last_message: content, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 🛒 중고거래 API
// ═══════════════════════════════════════════════════════════════

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

// 상세 조회 + 조회수 증가
app.get('/api/market/listings/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('market_listings').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    supabase.from('market_listings').update({ views: (data.views||0)+1 }).eq('id', req.params.id).then(() => {});
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 등록
app.post('/api/market/listings', async (req, res) => {
  try {
    const body = req.body;
    if (!body.anon_id || !body.title || body.price === undefined) return res.status(400).json({ error: '필수값 누락' });
    const { data, error } = await supabase.from('market_listings').insert([{ ...body, status:'available', views:0 }]).select().single();
    if (error) throw error;
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// 채팅 메시지 조회 (기본 경로)
app.get('/api/market/chats/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('market_messages').select('*').eq('chat_id', req.params.id).order('created_at',{ascending:true}).limit(100);
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채팅 메시지 조회 (messages 서브경로)
app.get('/api/market/chats/:id/messages', async (req, res) => {
  try {
    const { data, error } = await supabase.from('market_messages').select('*').eq('chat_id', req.params.id).order('created_at',{ascending:true}).limit(100);
    if (error) throw error;
    res.json({ success:true, data: data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 채팅 시작/메시지 전송
app.post('/api/market/chats', async (req, res) => {
  try {
    const { listing_id, buyer_anon_id, seller_anon_id, content } = req.body;
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
      await supabase.from('market_messages').insert([{ chat_id: chat.id, sender_anon_id: buyer_anon_id, content }]);
      await supabase.from('market_chats').update({ last_message: content, updated_at: new Date().toISOString() }).eq('id', chat.id);
    }
    res.json({ success:true, data: chat });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 메시지 전송 (기본 경로)
app.post('/api/market/chats/:id', async (req, res) => {
  try {
    const { sender_anon_id, content } = req.body;
    const { data, error } = await supabase.from('market_messages').insert([{ chat_id: req.params.id, sender_anon_id, content }]).select().single();
    if (error) throw error;
    await supabase.from('market_chats').update({ last_message: content, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 메시지 전송 (messages 서브경로)
app.post('/api/market/chats/:id/messages', async (req, res) => {
  try {
    const { sender_anon_id, content } = req.body;
    const { data, error } = await supabase.from('market_messages').insert([{ chat_id: req.params.id, sender_anon_id, content }]).select().single();
    if (error) throw error;
    await supabase.from('market_chats').update({ last_message: content, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// 💬 커뮤니티 API
// ═══════════════════════════════════════════════════════════════


// 익명 닉네임 생성 헬퍼
function makeNick(anon_id) {
  const emojis = ['🧹','🪣','✨','🫧','🧽','🪥','🧴','🫙'];
  const idx = Math.abs(anon_id.split('').reduce((a,c)=>a+c.charCodeAt(0),0)) % emojis.length;
  return emojis[idx] + ' 익명' + anon_id.slice(-4).toUpperCase();
}

// 게시글 목록 (무한스크롤 + 검색 + 카테고리)
app.get('/api/community/posts', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 0;
    const limit = parseInt(req.query.limit) || 20;
    const { search, category } = req.query;

    let q = supabase.from('community_posts')
      .select('*', { count: 'exact' })
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);

    if (category && category !== '전체') q = q.eq('category', category);
    if (search) q = q.ilike('content', `%${search}%`);

    const { data, error, count } = await q;
    if (error) throw error;
    const enriched = (data || []).map(p => ({ ...p, nickname: makeNick(p.anon_id) }));
    res.json({ success: true, data: enriched, total: count || 0, hasMore: (page + 1) * limit < (count || 0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 게시글 단일 조회 (댓글 + 좋아요 여부 포함)
app.get('/api/community/posts/:id', async (req, res) => {
  try {
    const { anon_id } = req.query;
    const { data: post, error } = await supabase.from('community_posts')
      .select('*').eq('id', req.params.id).single();
    if (error) throw error;

    // 댓글 함께 조회
    const { data: comments } = await supabase.from('community_comments')
      .select('*').eq('post_id', req.params.id).eq('deleted', false)
      .order('created_at', { ascending: true });

    // 좋아요 여부
    let liked = false;
    if (anon_id) {
      const { data: like } = await supabase.from('community_likes')
        .select('id').eq('post_id', req.params.id).eq('anon_id', anon_id).maybeSingle();
      liked = !!like;
    }

    // 내 게시글 여부
    const is_mine = anon_id && post.anon_id === anon_id;

    const postWithNick = { ...post, liked, is_mine, nickname: makeNick(post.anon_id) };
    const cmtsWithNick = (comments || []).map(c => ({ ...c, nickname: makeNick(c.anon_id), is_mine: anon_id && c.anon_id === anon_id }));
    res.json({ success: true, data: postWithNick, comments: cmtsWithNick });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 게시글 작성
app.post('/api/community/posts', async (req, res) => {
  try {
    const { anon_id, title, content, category, imageBase64 } = req.body;
    if (!anon_id || !content) return res.status(400).json({ error: '필수값 누락' });

    let image_url = null;

    // 이미지 업로드 (base64 → Supabase Storage)
    if (imageBase64) {
      try {
        const buf = Buffer.from(imageBase64, 'base64');
        const fname = `community/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
        const { data: upData, error: upErr } = await supabase.storage
          .from('ssak-contracts').upload(fname, buf, { contentType: 'image/jpeg', upsert: false });
        if (!upErr) {
          const { data: urlData } = supabase.storage.from('ssak-contracts').getPublicUrl(fname);
          image_url = urlData.publicUrl;
        }
      } catch(imgErr) { console.warn('이미지 업로드 실패:', imgErr.message); }
    }

    const { data, error } = await supabase.from('community_posts')
      .insert([{ anon_id, title: title || '', content, category: category || '일반', image_url }])
      .select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 게시글 삭제 (soft delete)
app.delete('/api/community/posts/:id', async (req, res) => {
  try {
    const { anon_id } = req.body;
    const { error } = await supabase.from('community_posts')
      .update({ deleted: true }).eq('id', req.params.id).eq('anon_id', anon_id);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 좋아요 토글
app.post('/api/community/posts/:id/like', async (req, res) => {
  try {
    const { anon_id } = req.body;
    const postId = req.params.id;
    if (!anon_id) return res.status(400).json({ error: 'anon_id 필요' });

    // 이미 좋아요 눌렀는지 확인
    const { data: existing } = await supabase.from('community_likes')
      .select('id').eq('post_id', postId).eq('anon_id', anon_id).maybeSingle();

    let liked;
    if (existing) {
      await supabase.from('community_likes').delete().eq('id', existing.id);
      await supabase.from('community_posts').update({ like_count: supabase.rpc ? undefined : undefined }).eq('id', postId);
      // like_count 감소
      const { data: post } = await supabase.from('community_posts').select('like_count').eq('id', postId).single();
      await supabase.from('community_posts').update({ like_count: Math.max(0, (post?.like_count || 1) - 1) }).eq('id', postId);
      liked = false;
    } else {
      await supabase.from('community_likes').insert([{ post_id: postId, anon_id }]);
      const { data: post } = await supabase.from('community_posts').select('like_count').eq('id', postId).single();
      await supabase.from('community_posts').update({ like_count: (post?.like_count || 0) + 1 }).eq('id', postId);
      liked = true;
    }
    res.json({ success: true, liked });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 댓글 목록
app.get('/api/community/comments/:postId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('community_comments')
      .select('*').eq('post_id', req.params.postId).eq('deleted', false)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 댓글 작성
app.post('/api/community/comments/:postId', async (req, res) => {
  try {
    const { anon_id, content } = req.body;
    if (!anon_id || !content) return res.status(400).json({ error: '필수값 누락' });

    const { data, error } = await supabase.from('community_comments')
      .insert([{ post_id: req.params.postId, anon_id, content }]).select().single();
    if (error) throw error;

    // comment_count 증가
    const { data: post } = await supabase.from('community_posts').select('comment_count').eq('id', req.params.postId).single();
    await supabase.from('community_posts').update({ comment_count: (post?.comment_count || 0) + 1 }).eq('id', req.params.postId);

    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 댓글 삭제
app.delete('/api/community/comments/:id', async (req, res) => {
  try {
    const { anon_id, post_id } = req.body;
    const { error } = await supabase.from('community_comments')
      .update({ deleted: true }).eq('id', req.params.id).eq('anon_id', anon_id);
    if (error) throw error;

    // comment_count 감소
    if (post_id) {
      const { data: post } = await supabase.from('community_posts').select('comment_count').eq('id', post_id).single();
      await supabase.from('community_posts').update({ comment_count: Math.max(0, (post?.comment_count || 1) - 1) }).eq('id', post_id);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
