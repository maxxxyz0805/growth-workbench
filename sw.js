/* =====================================================================
 *  sw.js  ——  基础离线支持（应用壳预缓存 + 网络优先回退）
 *  说明：数据本身存在云端（Supabase），离线时由 IndexedDB 缓存兜底显示。
 *        本 SW 只负责让「应用页面」在断网时也能打开（应用壳缓存）。
 * =================================================================== */
var CACHE = 'growth-pwa-v4';
var SHELL = [
  './', './index.html', './config.js', './app.js', './manifest.json',
  './icon-180.png', './icon-192.png', './icon-512.png',
  './icon-maskable-512.png', './icon.svg'
];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;                 // 非 GET（如 Supabase 写）直接走网络
  var url = new URL(req.url);
  if(url.origin !== location.origin){ return; }    // 跨域（Supabase API 等）交给浏览器网络栈

  // 页面导航：网络优先，失败回退到缓存的首页
  if(req.mode === 'navigate'){
    e.respondWith(fetch(req).catch(function(){ return caches.match('./index.html'); }));
    return;
  }
  // 静态资源：缓存优先，缺失再网络并补缓存
  e.respondWith(
    caches.match(req).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(function(res){
        if(res && res.ok){ var cp = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, cp); }); }
        return res;
      });
    })
  );
});
