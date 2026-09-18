// Gryph-ZCode 实时审计仪表盘:零依赖,数据来自 gryph CLI,每 3 秒自动刷新。
// 启动:node lib/server.js(或 npm start)→ 浏览器打开 http://127.0.0.1:<port>
// 注意:PAGE 是模板字符串,内嵌正则禁止用反斜杠转义(模板会吞掉 \s \( \/),用 [.]、String.fromCharCode(92) 替代。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { gryph, port: PORT, dataDir } = require('./paths');

// 崩溃/异常落盘:后台运行时 stderr 不可见,统一记到数据目录便于排障
function crashLog(msg) {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, '.server-error.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}
process.on('uncaughtException', e => { crashLog('uncaught: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', e => { crashLog('rejection: ' + (e && (e.stack || e.message) || e)); });

// 查询失败或空输出一律按空数组返回:仪表盘宁可显示"无记录",也不崩页面
function fetchEvents(window) {
  return new Promise((resolve) => {
    execFile(gryph, ['query', '--format', 'json', '--since', window], { timeout: 15000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
      });
  });
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Gryph · ZCode 审计仪表盘</title>
<style>
:root{--bg:#0f1117;--card:#171a23;--line:#262a36;--fg:#d7dce6;--dim:#7c8598;--acc:#5b9dff;--ok:#3fb98a;--warn:#e0a84e}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI",system-ui,sans-serif;padding:20px}
h1{font-size:18px;font-weight:600}h1 small{color:var(--dim);font-weight:400;margin-left:10px}
#totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:24px;color:var(--acc)}
.stat span{color:var(--dim);font-size:12px}
.session{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.session header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.session header .id{font-weight:600;color:var(--acc)}
.session header .time{color:var(--dim);font-size:12px}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.badge.read{color:var(--ok);border-color:var(--ok)}
.badge.sens{color:var(--warn);border-color:var(--warn)}
.files{margin-top:8px;display:flex;flex-direction:column;gap:3px}
.file{font:12px/1.45 Consolas,monospace;color:var(--fg);word-break:break-all;padding:3px 8px;background:rgba(91,157,255,.06);border-radius:6px}
.file.sens{background:rgba(224,168,78,.12);color:var(--warn)}
.file .t{color:var(--dim);margin-right:8px}
.file.shell{background:rgba(178,132,255,.09)}
.file .src{color:#b284ff;font-size:11px;border:1px solid #b284ff;border-radius:4px;padding:0 4px;margin-right:6px}
.badge.sh{color:#b284ff;border-color:#b284ff}
#err{color:var(--warn);font-size:12px;margin-top:8px;display:none}
#live{color:var(--ok);font-size:12px}
</style></head><body>
<h1>📖 ZCode 文件读取审计 <span id="live">● 实时</span><small>数据源:gryph · 每 3 秒刷新 · 近 12 小时 · 蓝=Read 工具 · 紫=shell 推定(cat/grep 等)</small></h1>
<div id="totals"></div><div id="sessions"></div><div id="err"></div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const hh=t=>new Date(t).toLocaleTimeString('zh-CN',{hour12:false});
// shell 读取推定:从 command_exec 原文提取读取类命令(cat/head/tail/grep/rg/sed 等)的文件路径参数
// 注意:本段位于模板字符串内,禁止使用含反斜杠的正则字面量,统一用 [.] / new RegExp / 字符串方法
const READ_CMDS=/^(cat|head|tail|less|more|nl|bat|zcat|grep|egrep|fgrep|rg|ack|awk|sed|type)([.]exe)?$/;
const PATH_RE=new RegExp('^(?:[A-Za-z]:['+String.fromCharCode(92)+'/.][^|<>;*?]*|/[^|<>;*?]+|[.]{1,2}/[^|<>;*?]+|~/[^|<>;*?]+)$');
function splitArgs(s){const out=[];let cur='',q=null;for(const ch of s){if(q){if(ch===q)q=null;else cur+=ch}else if(ch==='"'||ch==="'"){q=ch}else if(ch<=' '){if(cur)out.push(cur);cur=''}else cur+=ch}if(cur)out.push(cur);return out}
function shellReads(evs){
 const seen=new Set(),res=[];
 for(const e of evs){
  if(e.ActionType!=='command_exec'||!e.Command)continue;
  for(const seg of e.Command.split(/&&|;|[(|]/)){
   const parts=splitArgs(seg.trim());if(!parts.length)continue;
   if(!READ_CMDS.test(parts[0].toLowerCase()))continue;
   if(parts[0].toLowerCase().indexOf('sed')===0&&(seg.indexOf(' -i')>=0||seg.indexOf('--in-place')>=0))continue;
   for(const t of parts.slice(1)){
    if(t.charAt(0)==='-'||t==='|'||t==='>')continue;
    if(!PATH_RE.test(t)||seen.has(t))continue;seen.add(t);
    res.push({time:e.Timestamp,path:t,cmd:seg.trim().slice(0,60)});
   }
  }
 }
 return res;
}
async function tick(){
 try{
  const evs=await(await fetch('/api/events')).json();
  document.getElementById('err').style.display='none';
  const bySess={};
  for(const e of evs)(bySess[e.ShortSessionID]??=[]).push(e);
  const reads=evs.filter(e=>e.ActionType==='file_read');
  const shell=shellReads(evs);
  const uniq=f=>[...new Set(f)];
  document.getElementById('totals').innerHTML=
   [['会话数',Object.keys(bySess).length],['读取事件',reads.length],
    ['读取文件(去重)',uniq(reads.map(e=>e.Path)).length],
    ['Shell 读取(推定)',shell.length],
    ['命令执行',evs.filter(e=>e.ActionType==='command_exec').length],
    ['文件写入',evs.filter(e=>e.ActionType==='file_write').length],
    ['敏感命中',evs.filter(e=>e.IsSensitive).length]]
   .map(([k,v])=>'<div class="stat"><b>'+v+'</b><span>'+k+'</span></div>').join('');
  // 会话按最近活动时间倒序,最新的排最前
  document.getElementById('sessions').innerHTML=Object.entries(bySess)
   .sort((a,b)=>Math.max(...b[1].map(e=>+new Date(e.Timestamp)))-Math.max(...a[1].map(e=>+new Date(e.Timestamp))))
   .map(([id,evs])=>{
    const rs=evs.filter(e=>e.ActionType==='file_read').sort((a,b)=>b.Timestamp.localeCompare(a.Timestamp));
    const sh=shellReads(evs);
    const seen=new Set(),lines=[];
    for(const e of rs){if(seen.has(e.Path))continue;seen.add(e.Path);
     lines.push('<div class="file'+(e.IsSensitive?' sens':'')+'"><span class="t">'+hh(e.Timestamp)+'</span>'+esc(e.Path)+'</div>');}
    for(const s of sh.sort((a,b)=>b.time.localeCompare(a.time))){if(seen.has(s.path))continue;seen.add(s.path);
     lines.push('<div class="file shell" title="'+esc(s.cmd)+'"><span class="t">'+hh(s.time)+'</span><span class="src">shell</span>'+esc(s.path)+'</div>');}
    const acts={};evs.forEach(e=>acts[e.ActionDisplay]=(acts[e.ActionDisplay]||0)+1);
    return '<section class="session"><header><span class="id">会话 '+esc(id)+'</span>'
     +'<span class="time">'+hh(evs[0].Timestamp)+' → '+hh(evs[evs.length-1].Timestamp)+'</span>'
     +'<span class="badge read">读 '+uniq(rs.map(e=>e.Path)).length+' 文件</span>'
     +'<span class="badge sh">shell读 '+sh.length+'</span>'
     +Object.entries(acts).map(([k,v])=>'<span class="badge">'+esc(k)+' ×'+v+'</span>').join('')
     +'</header><div class="files">'+(lines.join('')||'<div class="file">（无文件读取）</div>')+'</div></section>';
   }).join('')||'<div class="stat">近 12 小时无记录</div>';
 }catch(e){document.getElementById('err').textContent='刷新失败: '+e;document.getElementById('err').style.display='block';}
}
tick();setInterval(tick,3000);
</script></body></html>`;

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/events')) {
      const events = await fetchEvents('12h');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(events));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    }
  } catch (e) { crashLog('req ' + req.url + ': ' + e); try { res.writeHead(500); res.end('err'); } catch {} }
}).listen(PORT, '127.0.0.1', () => console.log(`Gryph 仪表盘: http://127.0.0.1:${PORT}`))
  .on('error', e => { crashLog('listen 失败: ' + e.message); console.error('listen 失败: ' + e.message + '(端口被占? netstat -ano | grep ' + PORT + ')'); process.exit(1); });
