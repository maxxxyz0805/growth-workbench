# -*- coding: utf-8 -*-
import io, sys

SRC = r'D:/WorkBuddyData/workbench/growth-hub.html'
OUT = r'D:/WorkBuddyData/workbench/pwa-sync/index.html'

with io.open(SRC, encoding='utf-8') as f:
    s = f.read()

repls = []

# R1 head comment
repls.append((
'''<!-- 本工作台为本地单文件方案：localStorage 存储（前缀 wb_growth_），全内联零外链 -->''',
'''<!-- 多设备同步工作台 v2：Supabase 云存储 + PWA 离线优先，全内联零外链，无任何 localStorage -->'''
))

# R2 manifest link
repls.append((
'''<link rel="manifest" href="manifest.webmanifest">''',
'''<link rel="manifest" href="manifest.json">'''
))

# R3 data safety copy
repls.append((
'''        <p class="muted mb">数据保存在本设备浏览器中，建议每周导出一次备份。换手机/电脑时用「导入恢复」即可迁移全部数据。</p>''',
'''        <p class="muted mb">数据实时保存在云端（Supabase），多设备自动同步；换手机/电脑登录同一账号即可延续。仍建议每周导出一次 JSON 备份防丢失。</p>'''
))

# R4 script opening: add external scripts, drop SW-unregister comment wording
repls.append((
'''<script>
/* ================= 启动期错误捕获 + 旧 SW 清理 ================= */''',
'''<script src="config.js"></script>
<script src="app.js"></script>
<script>
/* ================= 启动期错误捕获 ================= */'''
))

# R5 remove SW unregister block
repls.append((
'''if('serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations().then(function(rs){
    rs.forEach(function(r){r.unregister().then(function(ok){console.log('[SW] unregistered old SW:',ok)})});
  }).catch(function(){});
  if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})}).catch(function(){})}
}
''',
''''''
))

# R6 remove const K
repls.append((
'''const K={tx:'wb_growth_tx',health:'wb_growth_health',habits:'wb_growth_habits',checks:'wb_growth_checkins',study:'wb_growth_study',mats:'wb_growth_mats',kb:'wb_growth_kb',water:'wb_growth_water',ink:'wb_growth_ink',set:'wb_growth_settings'};''',
''''''
))

# R7 remove const g
repls.append((
'''const g=(k,d)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}};''',
''''''
))

# R8 remove const sv
repls.append((
'''const sv=(k,v)=>localStorage.setItem(k,JSON.stringify(v));''',
''''''
))

# R9 remove KB mig IIFE
repls.append((
'''/* KB 数据迁移：ensure 每条 entry 有 links 字段（双向链接预留） */
(function(){const kb=g(K.kb,[]);let dirty=false;
  kb.forEach(x=>{if(!Array.isArray(x.links)){x.links=[];dirty=true}});
  if(dirty)sv(K.kb,kb)})();

''',
''''''
))

# R10 remove migrate hb1 IIFE
repls.append((
'''/* 一次性迁移：清理重复的喝水习惯 hb1（和喝水小工具重复） */
(function migrate(){
  if(localStorage.getItem('wb_growth_mig_v1_7_1')==='1')return;
  let changed=false;
  const hbs=g(K.habits,[]).filter(h=>h.id!=='hb1');if(hbs.length!==g(K.habits,[]).length){sv(K.habits,hbs);changed=true}
  const ck=g(K.checks,{});let anyChk=false;Object.keys(ck).forEach(d=>{if('hb1' in ck[d]){delete ck[d].hb1;anyChk=true}});if(anyChk){sv(K.checks,ck);changed=true}
  if(changed)console.log('[mig] cleaned hb1 duplicate');
  localStorage.setItem('wb_growth_mig_v1_7_1','1');
})();
''',
''''''
))

# R11 remove migrateMoney IIFE
repls.append((
'''/* 一次性迁移：为已有用户补上「记账」分组下的默认习惯 hb9 */
(function migrateMoney(){
  if(localStorage.getItem('wb_growth_mig_money')==='1')return;
  const hbs=g(K.habits,[]);
  if(!hbs.some(h=>h.id==='hb9')){
    hbs.push({id:'hb9',name:'每日记一笔账',grp:'money',restAllow:true,sample:true});
    sv(K.habits,hbs);
    console.log('[mig] added 记账 habit hb9');
  }
  localStorage.setItem('wb_growth_mig_money','1');
})();
''',
''''''
))

# R12 startup block
repls.append((
'''/* ================= 启动 ================= */
seed();
setTxType('expense');
render();
ingestImport();''',
'''/* ================= 启动（登录门由 app.js 接管） ================= */
/* 数据加载与首次渲染在 app.js afterAuth() 中完成：loadAll → seed → setTxType → render → ingestImport */'''
))

# R13 backup dismissed get
repls.append((
'''const dismissed=localStorage.getItem('wb_growth_backup_dismissed')===today();''',
'''const dismissed=g(K.backup,null)===today();'''
))

# R14 dismissBackup set
repls.append((
'''function dismissBackup(){localStorage.setItem('wb_growth_backup_dismissed',today());document.getElementById('backupHint').innerHTML=''}''',
'''function dismissBackup(){sv(K.backup,today());document.getElementById('backupHint').innerHTML=''}'''
))

# R15 kb lastimport set
repls.append((
'''  localStorage.setItem('wb_growth_kb_lastimport',ACE_KB_VER);''',
'''  sv(K.kbImport,ACE_KB_VER);'''
))

# R16 kb lastimport get
repls.append((
'''  if(aceBtn)aceBtn.style.display=localStorage.getItem('wb_growth_kb_lastimport')===ACE_KB_VER?'none':'';''',
'''  if(aceBtn)aceBtn.style.display=g(K.kbImport,null)===ACE_KB_VER?'none':'';'''
))

# R17 clearAll removeItem
repls.append((
'''  Object.values(K).forEach(k=>localStorage.removeItem(k));''',
'''  if(window.wipeCloud)window.wipeCloud();'''
))

# R18a seed kb entry 1 add links
repls.append((
'''{id:uid(),title:'示例：小宇宙播客《知行小酒馆》E150',link:'',cat:'播客',note:'讲存钱心态的一期，「先支付给自己」这个概念值得记住',date:t,sample:true}''',
'''{id:uid(),title:'示例：小宇宙播客《知行小酒馆》E150',link:'',cat:'播客',note:'讲存钱心态的一期，「先支付给自己」这个概念值得记住',date:t,sample:true,links:[]}'''
))

# R18b seed kb entry 2 add links
repls.append((
'''{id:uid(),title:'示例：看到好内容先丢进来，再找 Ace 提炼',link:'',cat:'灵感笔记',note:'这是示例条目，点右上角「收一条」开始建你自己的知识库',date:t,sample:true}''',
'''{id:uid(),title:'示例：看到好内容先丢进来，再找 Ace 提炼',link:'',cat:'灵感笔记',note:'这是示例条目，点右上角「收一条」开始建你自己的知识库',date:t,sample:true,links:[]}'''
))

# R19 remove INK init IIFE (would pre-enqueue empty [] and overwrite cloud on drain)
repls.append((
'''(function(){const a=g(K.ink,null);if(!Array.isArray(a))sv(K.ink,[])})();''',
''''''
))

# apply
bad = 0
for i,(old,new) in enumerate(repls):
    cnt = s.count(old)
    if cnt != 1:
        print('WARN R%d count=%d' % (i+1, cnt))
        bad += 1
    s = s.replace(old, new)

if 'localStorage' in s:
    print('ERROR: still contains localStorage')
    bad += 1

with io.open(OUT, 'w', encoding='utf-8') as f:
    f.write(s)

print('transform done, bad=%d, out bytes=%d' % (bad, len(s.encode('utf-8'))))
