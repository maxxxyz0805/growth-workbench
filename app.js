/* =====================================================================
 *  app.js  ——  多设备同步数据层 / 登录门 / 离线队列 / PWA 注册
 *  本文件不再使用任何 localStorage，全部持久化走 Supabase（云端）+ IndexedDB（离线缓存）。
 *  对外暴露给主业务脚本（index.html 内联 <script>）的全局：
 *     window.K   存储键名映射
 *     window.g   读取  window.sv  写入（写入即触发云端同步 / 离线入队）
 *     window.wipeCloud   清空全部数据
 *  主业务脚本只需照常调用 g()/sv()/render()/seed() 等，存储细节对本文件透明。
 * =================================================================== */
(function(){
'use strict';

/* ---------- 0. 配置校验 ---------- */
var SB_URL  = window.SB_URL  || '';
var SB_ANON = window.SB_ANON || '';
var TABLE   = window.SB_TABLE || 'wb_store';
var CONFIGURED = SB_URL.indexOf('YOUR-PROJECT') === -1 && SB_ANON.indexOf('YOUR-SUPABASE-ANON-KEY') === -1;

/* ---------- 1. 存储键名（与旧版 localStorage key 保持一致，便于迁移语义） ---------- */
window.K = {
  tx:'wb_growth_tx', health:'wb_growth_health', habits:'wb_growth_habits',
  checks:'wb_growth_checkins', study:'wb_growth_study', mats:'wb_growth_mats',
  kb:'wb_growth_kb', water:'wb_growth_water', ink:'wb_growth_ink', set:'wb_growth_settings',
  backup:'wb_growth_backup_dismissed', kbImport:'wb_growth_kb_lastimport',
  siRead:'wb_growth_si_read', siPod:'wb_growth_si_podcast', siRev:'wb_growth_si_review', siSeeded:'wb_growth_si_seeded'
};

/* ---------- 2. 内存数据缓存（页面运行时唯一数据源） ---------- */
var DB = {};
var session = null;            // {access_token, refresh_token, uid, email}
var _flushTimers = {};

/* ---------- 3. IndexedDB（会话 / 数据快照 / 离线写队列，均非 localStorage） ---------- */
var _dbp = null;
function idbOpen(){
  if(_dbp) return _dbp;
  _dbp = new Promise(function(resolve, reject){
    var req = indexedDB.open('wb_pwa', 1);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', {keyPath:'k'});
      if(!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', {keyPath:'id', autoIncrement:true});
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
  return _dbp;
}
function idbGet(store, key){
  return idbOpen().then(function(db){
    return new Promise(function(res, rej){
      var tx = db.transaction(store, 'readonly').objectStore(store).get(key);
      tx.onsuccess = function(){ res(tx.result ? tx.result.v : undefined); };
      tx.onerror = function(){ rej(tx.error); };
    });
  }).catch(function(){ return undefined; });
}
function idbSet(store, key, val){
  return idbOpen().then(function(db){
    return new Promise(function(res, rej){
      var tx = db.transaction(store, 'readwrite').objectStore(store).put({k:key, v:val});
      tx.onsuccess = function(){ res(); };
      tx.onerror = function(){ rej(tx.error); };
    });
  }).catch(function(){ /* 离线缓存不可用时静默 */ });
}
function idbDel(store, key){
  return idbOpen().then(function(db){
    return new Promise(function(res, rej){
      var tx = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      tx.onsuccess = function(){ res(); };
      tx.onerror = function(){ rej(tx.error); };
    });
  }).catch(function(){});
}
function idbAll(store){
  return idbOpen().then(function(db){
    return new Promise(function(res, rej){
      var tx = db.transaction(store, 'readonly').objectStore(store).getAll();
      tx.onsuccess = function(){ res(tx.result || []); };
      tx.onerror = function(){ rej(tx.error); };
    });
  }).catch(function(){ return []; });
}

/* ---------- 4. 同步状态小工具 ---------- */
function online(){ return navigator.onLine !== false; }
function persistSnapshot(){ idbSet('kv', 'dbsnapshot', DB); }
function loadSnapshot(){ return idbGet('kv', 'dbsnapshot').then(function(s){ if(s && typeof s === 'object') DB = s; }); }
function saveSession(s){ return idbSet('kv', 'session', s); }
function loadSession(){ return idbGet('kv', 'session'); }
function clearSession(){ return idbDel('kv', 'session'); }

/* ---------- 5. 数据读写接口（业务层只认这两个） ---------- */
window.g = function(k, d){ return DB[k] !== undefined ? DB[k] : d; };
window.sv = function(k, v){
  DB[k] = v;
  persistSnapshot();
  if(online() && session){ debouncedFlush(k); }
  else { enqueue(k, v); }
};

/* ---------- 6. 离线写队列 + 防抖上云 ---------- */
function enqueue(store, value){
  idbOpen().then(function(db){
    var tx = db.transaction('queue', 'readwrite').objectStore('queue').add({store:store, value:value, ts:Date.now()});
    tx.onerror = function(){};
  }).catch(function(){});
}
function removeQueued(store){
  idbAll('queue').then(function(rows){
    rows.filter(function(r){ return r.store === store; }).forEach(function(r){
      idbDel('queue', r.id);
    });
  });
}
function debouncedFlush(k){
  _flushPending = true;
  clearTimeout(_flushTimers[k]);
  _flushTimers[k] = setTimeout(function(){ flushStore(k); }, 350);
}
function flushStore(k){
  if(!session || !online()){ enqueue(k, DB[k]); _flushPending = false; return; }
  rest('POST', '/rest/v1/' + TABLE + '?on_conflict=user_id,store',
    [{user_id: session.uid, store:k, value: DB[k]}],
    {'Prefer':'resolution=merge-duplicates'})
    .then(function(){ _flushPending = false; removeQueued(k); })
    .catch(function(){ _flushPending = false; enqueue(k, DB[k]); });
}
function drainQueue(){
  return idbAll('queue').then(function(rows){
    if(!rows.length) return;
    var latest = {};
    rows.forEach(function(r){ latest[r.store] = r.value; });
    var ks = Object.keys(latest);
    return Promise.all(ks.map(function(k){
      return rest('POST', '/rest/v1/' + TABLE + '?on_conflict=user_id,store',
        [{user_id: session.uid, store:k, value: latest[k]}],
        {'Prefer':'resolution=merge-duplicates'})
        .then(function(){ return k; })
        .catch(function(){ return null; });
    })).then(function(done){
      done.filter(Boolean).forEach(function(k){ removeQueued(k); });
    });
  });
}

/* ---------- 7. 云端读取（登录后拉全量） ---------- */
function isEmptyVal(v){ return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && v !== null && Object.keys(v).length === 0); }
function mergeStore(cloud, local){
  // 两端都是数组：按 id（无 id 则按内容）做并集，绝不丢弃任一侧独有数据
  if(Array.isArray(cloud) && Array.isArray(local)){
    var seen = {}, out = [];
    var keyOf = function(it){ return (it && typeof it === 'object' && it.id != null) ? ('id:'+it.id) : ('j:'+JSON.stringify(it)); };
    cloud.concat(local).forEach(function(it){ var k = keyOf(it); if(!seen[k]){ seen[k] = 1; out.push(it); } });
    return out;
  }
  if(isEmptyVal(cloud)) return local;   // 云端空 → 保留本地（防丢）
  if(isEmptyVal(local)) return cloud;   // 本地空 → 用云端
  // 对象：合并双方键；冲突键以云端为准（保证多设备同步，最后写入方胜出），本地独有键保留
  if(cloud && typeof cloud === 'object' && !Array.isArray(cloud) && local && typeof local === 'object' && !Array.isArray(local)){
    var m = {};
    for(var k in local){ if(Object.prototype.hasOwnProperty.call(local, k)) m[k] = local[k]; }
    for(var k2 in cloud){ if(Object.prototype.hasOwnProperty.call(cloud, k2)) m[k2] = cloud[k2]; }
    return m;
  }
  return cloud;                          // 标量：云端优先
}
function loadAll(){
  // 安全网：先备份当前本地快照，极端情况下可在 localStorage['wb_snapshot_prev'] 找回
  try { localStorage.setItem('wb_snapshot_prev', JSON.stringify(DB)); } catch(e){}
  return rest('GET', '/rest/v1/' + TABLE + '?select=store,value').then(function(rows){
    var needPush = [];
    (rows || []).forEach(function(r){
      var cloud = r.value, local = DB[r.store];
      if(cloud === undefined || cloud === null){
        // 云端缺该键但本地有数据：保留本地并补推上云
        if(local !== undefined && local !== null){ DB[r.store] = local; needPush.push(r.store); }
        return;
      }
      var merged = mergeStore(cloud, local);
      DB[r.store] = merged;
      // 合并后比云端多（说明本地有云端没有的数据）→ 补推上云，恢复多设备一致（自愈）
      if(!isEmptyVal(local) && (isEmptyVal(cloud) || (Array.isArray(merged) && Array.isArray(cloud) && merged.length > cloud.length))){
        needPush.push(r.store);
      }
    });
    persistSnapshot();
    needPush.forEach(function(k){ try { flushStore(k); } catch(e){} });
  });
}

/* ---------- 7.5 自动拉取（多设备实时同步） ---------- */
var _flushPending = false;
function isEditing(){
  var a = document.activeElement;
  if(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
  if(document.querySelector('.mask.show')) return true;  // 弹窗打开中，不打断
  return false;
}
var _lastPull = 0;
function pullAndRender(){
  if(!session || !online() || isEditing() || _flushPending) return;  // 本地刚改动未上云时不拉，避免覆盖
  var now = Date.now();
  if(now - _lastPull < 4000) return;  // 4s 节流，防抖动
  _lastPull = now;
  setSync('syncing');
  loadAll()
    .then(function(){ if(typeof render === 'function'){ try{ render(); }catch(e){} } setSync('synced'); })
    .catch(function(){ setSync('offline'); });
}

/* ---------- 8. Supabase REST 封装（零依赖，纯 fetch） ---------- */
function rest(method, path, body, extra){
  var headers = { 'apikey': SB_ANON, 'Content-Type':'application/json' };
  if(session && session.access_token) headers['Authorization'] = 'Bearer ' + session.access_token;
  if(extra) Object.keys(extra).forEach(function(k){ headers[k] = extra[k]; });
  return fetch(SB_URL + path, { method:method, headers:headers, body: body ? JSON.stringify(body) : undefined })
    .then(function(res){
      if(!res.ok){
        var p = res.json().catch(function(){ return {}; });
        return p.then(function(j){ throw new Error(j.error_description || j.message || j.error || ('HTTP ' + res.status)); });
      }
      if(res.status === 204) return null;
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('application/json') >= 0 ? res.json() : null;
    });
}
function authSignIn(email, pw){ return rest('POST', '/auth/v1/token?grant_type=password', {email:email, password:pw}); }
function authSignUp(email, pw){ return rest('POST', '/auth/v1/signup', {email:email, password:pw}); }
function authGetUser(){ return rest('GET', '/auth/v1/user'); }
function authRefresh(rt){ return rest('POST', '/auth/v1/token?grant_type=refresh_token', {refresh_token: rt}); }
function authSignOut(){ return rest('POST', '/auth/v1/logout', {}).catch(function(){}); }
function normalizeSession(j){
  return { access_token:j.access_token, refresh_token:j.refresh_token,
           uid:(j.user && j.user.id) || j.uid, email:(j.user && j.user.email) || j.email };
}

/* ---------- 9. 会话保活 ---------- */
function ensureFreshToken(){
  return authGetUser().catch(function(){
    if(session && session.refresh_token){
      return authRefresh(session.refresh_token).then(function(j){
        session.access_token = j.access_token;
        session.refresh_token = j.refresh_token || session.refresh_token;
        return saveSession(session);
      });
    }
    throw new Error('session expired');
  });
}

/* ---------- 10. UI：登录门 + 同步徽标 ---------- */
function escS(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

function injectStyles(){
  var css = ''
  + '.login-overlay{position:fixed;inset:0;z-index:100000;background:linear-gradient(160deg,#FFF5ED,#FBE9D8);display:flex;align-items:center;justify-content:center;padding:20px}'
  + '.login-card{background:#fff;border-radius:18px;box-shadow:0 10px 40px rgba(201,72,48,.18);width:100%;max-width:360px;padding:26px 22px}'
  + '.login-card h2{font-size:1.2rem;margin-bottom:6px;color:#5C3320}'
  + '.login-card input{margin-top:12px}'
  + '.login-card .btn{width:100%;margin-top:12px}'
  + '.li-err{color:#D96C5F;font-size:.8rem;margin-top:10px;min-height:1em;white-space:pre-wrap}'
  + '.li-hint{font-size:.7rem;color:#B07A4E;margin-top:12px;line-height:1.6}'
  + '.sync-badge{position:fixed;top:10px;right:10px;z-index:99990;background:rgba(255,255,255,.92);border:1px solid #F5DCC8;border-radius:99px;padding:6px 12px;font-size:.72rem;color:#5C3320;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(0,0,0,.06);cursor:default}'
  + '.sync-badge .dot{width:8px;height:8px;border-radius:50%;background:#C4906F;display:inline-block}'
  + '.sync-badge .dot.ok{background:#7BAE7F}'
  + '.sync-badge .dot.off{background:#D96C5F}'
  + '.sync-badge .dot.pulse{animation:pulse 1s infinite}'
  + '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}'
  + '.sync-badge a{color:#C94830;cursor:pointer;margin-left:6px;text-decoration:underline}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}
function buildLoginUI(){
  injectStyles();
  var ov = document.createElement('div'); ov.id = 'loginOverlay'; ov.className = 'login-overlay';
  ov.innerHTML = ''
    + '<div class="login-card">'
    +   '<h2>🔐 登录工作台</h2>'
    +   '<p class="muted" style="font-size:.8rem;color:#C4906F">数据保存在云端，登录后多设备自动同步</p>'
    +   '<input id="liEmail" type="email" placeholder="邮箱（用作登录账号）" autocomplete="username">'
    +   '<input id="liPw" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password">'
    +   '<div id="liErr" class="li-err"></div>'
    +   '<button id="liLogin" class="btn btn-p">登录</button>'
    +   '<button id="liReg" class="btn btn-g">注册新账号</button>'
    +   '<div id="liHint" class="li-hint"></div>'
    + '</div>';
  document.body.appendChild(ov);
  var hint = document.getElementById('liHint');
  if(!CONFIGURED){
    hint.innerHTML = '⚠️ 尚未配置 Supabase：请打开 <b>config.js</b> 填入 SB_URL 与 SB_ANON（见部署文档）。';
  } else {
    hint.innerHTML = '首次使用点「注册新账号」即可（建议关闭 Supabase 的邮件确认）。';
  }
  document.getElementById('liLogin').addEventListener('click', function(){
    doLogin(document.getElementById('liEmail').value.trim(), document.getElementById('liPw').value);
  });
  document.getElementById('liReg').addEventListener('click', function(){
    doRegister(document.getElementById('liEmail').value.trim(), document.getElementById('liPw').value);
  });
  document.getElementById('liPw').addEventListener('keydown', function(e){ if(e.key === 'Enter') doLogin(document.getElementById('liEmail').value.trim(), e.target.value); });
}
function showLoginErr(msg){ var e = document.getElementById('liErr'); if(e) e.textContent = msg || ''; }
function showLogin(msg){ var ov = document.getElementById('loginOverlay'); if(ov) ov.style.display = 'flex'; if(msg) showLoginErr(msg); }
function hideLogin(){ var ov = document.getElementById('loginOverlay'); if(ov) ov.style.display = 'none'; }

function buildSyncBadge(){
  var b = document.createElement('div'); b.id = 'syncBadge'; b.className = 'sync-badge';
  document.body.appendChild(b);
  setSync('idle');
}
function setSync(state){
  var el = document.getElementById('syncBadge'); if(!el) return;
  if(state === 'syncing'){ el.innerHTML = '<span class="dot pulse"></span> 同步中…'; }
  else if(state === 'offline'){ el.innerHTML = '<span class="dot off"></span> 离线（本地缓存）'; }
  else if(state === 'synced'){
    var email = session && session.email ? escS(session.email) : '';
    el.innerHTML = '<span class="dot ok"></span> 已同步' + (email ? ' · ' + email : '')
      + '<a id="liOut">退出</a>';
    var out = document.getElementById('liOut');
    if(out) out.addEventListener('click', function(){ if(confirm('退出登录？本地缓存会保留，重新登录即可恢复。')) doLogout(); });
  }
  else { el.innerHTML = '<span class="dot"></span> 未登录'; }
}

/* ---------- 11. 登录 / 注册 / 退出 ---------- */
function doLogin(email, pw){
  showLoginErr('');
  if(!CONFIGURED){ showLoginErr('请先配置 config.js 中的 Supabase 信息'); return; }
  if(!email || !pw){ showLoginErr('请输入邮箱和密码'); return; }
  authSignIn(email, pw).then(function(j){
    session = normalizeSession(j); return saveSession(session);
  }).then(function(){ return afterAuth(); })
    .catch(function(e){ showLoginErr('登录失败：' + (e.message || e)); });
}
function doRegister(email, pw){
  showLoginErr('');
  if(!CONFIGURED){ showLoginErr('请先配置 config.js 中的 Supabase 信息'); return; }
  if(!email || !pw){ showLoginErr('请输入邮箱和密码'); return; }
  if(pw.length < 6){ showLoginErr('密码至少 6 位'); return; }
  authSignUp(email, pw).then(function(j){
    if(j && j.session){ session = normalizeSession(j); return saveSession(session).then(function(){ return afterAuth(); }); }
    // 未返回 session：可能需邮件确认，尝试直接登录（关闭确认时可行）
    return authSignIn(email, pw).then(function(j2){
      session = normalizeSession(j2); return saveSession(session).then(function(){ return afterAuth(); });
    }).catch(function(){ showLoginErr('注册成功，但暂无法自动登录：请在 Supabase 关闭「邮件确认」后重试登录。'); });
  }).catch(function(e){ showLoginErr('注册失败：' + (e.message || e)); });
}
function doLogout(){
  authSignOut();
  session = null; clearSession();
  setSync('idle');
  showLogin('已退出登录');
}

/* ---------- 12. 登录成功后的启动流程 ---------- */
function afterAuth(){
  setSync('syncing');
  return loadAll()
    .catch(function(){ toast && toast('⚠️ 云端拉取失败，显示本地缓存'); })
    .then(function(){ return drainQueue(); })
    .then(function(){
      if(typeof seed === 'function') seed();
      if(typeof setTxType === 'function') setTxType('expense');
      if(typeof render === 'function') render();
      if(typeof ingestImport === 'function') ingestImport();
      hideLogin();
      setSync('synced');
    });
}

/* ---------- 13. 清空全部数据（供 clearAll 调用） ---------- */
window.wipeCloud = function(){
  Object.keys(window.K).forEach(function(k){ DB[k] = undefined; });
  persistSnapshot();
  if(session && online()){
    rest('DELETE', '/rest/v1/' + TABLE + '?user_id=eq.' + session.uid).catch(function(){});
  }
};

/* ---------- 14. 网络事件 ---------- */
function onOnline(){
  if(!session) return;
  setSync('syncing');
  drainQueue().then(function(){ setSync('synced'); toast && toast('🌐 网络恢复，已同步'); })
    .catch(function(){ setSync('synced'); });
}
function onOffline(){ setSync('offline'); }

/* ---------- 15. Service Worker 注册（基础离线：缓存应用壳） ---------- */
function registerSW(){
  if(!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('./sw.js').catch(function(e){ console.warn('[SW] 注册失败', e); });
  });
}

/* ---------- 16. 启动 ---------- */
function boot(){
  buildLoginUI();
  buildSyncBadge();
  registerSW();
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('focus', pullAndRender);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) pullAndRender(); });

  loadSnapshot().then(function(){
    if(!CONFIGURED){ setSync('idle'); showLogin(); return Promise.resolve(); }
    return loadSession().then(function(s){
      if(s && s.access_token){
        session = s;
        if(online()){
          return ensureFreshToken()
            .then(function(){ return afterAuth(); })
            .catch(function(){ showLogin('登录已过期，请重新登录'); });
        }
        /* 离线：直接用本地会话 + 快照渲染，写操作后续联网自动同步 */
        return afterAuth();
      }
      showLogin();
    });
  });
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
