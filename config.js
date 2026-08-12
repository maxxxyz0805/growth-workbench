/* =====================================================================
 *  Supabase 配置  ——  已填入 Max 的实测项目（2026-08-12 直连验证通过）
 *  获取位置：Supabase 后台 → 左侧 Settings → API
 *    - SB_URL    = Project URL        （形如 https://xxxx.supabase.co）
 *    - SB_ANON   = Publishable key     （Project API Keys 里的 sb_publishable_...）
 *  说明：新版 Publishable key 不是 JWT，必须放 apikey 请求头（app.js 已正确实现）；
 *        仅登录用户可读写自己的数据，受行级安全 RLS 保护。
 * =================================================================== */
window.SB_URL  = 'https://rqtyeyrctwqwlipktlcz.supabase.co';
window.SB_ANON = 'sb_publishable_oByIO3pqvmmtkxnB8P_9mw_1Hw99R0z';

/* 应用标识（用于表内区分，一般无需改动） */
window.SB_TABLE = 'wb_store';
