const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

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

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 싹싹 서버 실행 중 - 포트 ${PORT}`);
  console.log(`🧹 싹싹 입주청소 전문인 플랫폼`);
});
