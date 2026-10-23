const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-before-publishing';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname,'data.json');
const defaults = () => ({title:'منصة التقييم والتصويت التفاعلي', groups:['المجموعة الأولى','المجموعة الثانية','المجموعة الثالثة','المجموعة الرابعة','المجموعة الخامسة','المجموعة السادسة','المجموعة السابعة'], mode:'anonymous', active:-1, votes:[[],[],[],[],[],[],[]], completed:[false,false,false,false,false,false,false], codes:[], codeMode:'legacy', adminToken:crypto.randomBytes(24).toString('hex')});
let state;
try { state = {...defaults(),...JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}; } catch { state = defaults(); }
const persist=()=>fs.writeFileSync(DATA_FILE,JSON.stringify(state,null,2));
const clients=new Set();
// Public clients and SSE receive only the information required to vote.
// All vote totals, averages and individual votes are available ONLY through
// password-protected admin routes and never through public endpoints.
function snapshot(admin=false){
 const view={
  title:state.title,
  groups:state.groups,
  mode:state.mode,
  active:state.active,
  completed:state.completed,
  participantMode:state.codeMode==='phone4'?'phone4':'legacy',
  participantsReady:state.codeMode==='phone4'&&state.codes.length>0
 };
 if(!admin)return view;
 return {...view,
  approvedCount:state.codeMode==='phone4'?state.codes.length:0,
  counts:state.votes.map(v=>v.length),
  sums:state.votes.map(v=>v.reduce((s,x)=>s+x.score,0)),
  averages:state.votes.map(v=>v.length?Number((v.reduce((s,x)=>s+x.score,0)/v.length).toFixed(2)):null),
  codes:state.codes,
  votes:state.votes
 };
}
function broadcast(){ const line=`data: ${JSON.stringify(snapshot())}\n\n`; for(const c of clients){try {c.write(line)}catch{clients.delete(c)}} }
function reply(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
const readBody = req=>new Promise((resolve,reject)=>{let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>100000){reject(Error('طلب كبير'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'))}catch{reject(Error('JSON غير صالح'))}})});
const admin = req=>req.headers['x-admin-token']===state.adminToken;
// Normalize Arabic / Persian digits without ever requesting a full phone number.
const normalizeDigits = value => typeof value==='string'
  ? value.trim().replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0)-0x6f0))
  : '';
const shortCode=()=>crypto.randomBytes(5).toString('hex').toUpperCase();
const failedVotes=new Map();
const voterAddress=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
function voteRateLimit(req,failed=false){
 const key=voterAddress(req),now=Date.now(),windowMs=5*60*1000;
 let record=failedVotes.get(key);
 if(!record||record.until<=now)record={count:0,until:now+windowMs};
 if(failed)record.count++;
 failedVotes.set(key,record);
 if(failedVotes.size>5000){for(const [k,v] of failedVotes){if(v.until<=now)failedVotes.delete(k)}}
 return record.count>=25;
}
const publicDir=path.join(__dirname,'public');
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 try {
 if(req.method==='GET' && url.pathname==='/api/state')return reply(res,200,snapshot());
 if(req.method==='GET' && url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify(snapshot())}\n\n`); clients.add(res);req.on('close',()=>clients.delete(res));return;}
 if(req.method==='POST'&&url.pathname==='/api/login'){let b=await readBody(req);if(b.password!==ADMIN_PASSWORD)return reply(res,401,{error:'كلمة مرور المدرب غير صحيحة'});return reply(res,200,{token:state.adminToken,state:snapshot(true)});}
 if(req.method==='GET'&&url.pathname==='/api/admin'){if(!admin(req))return reply(res,401,{error:'غير مصرح'});return reply(res,200,snapshot(true));}
 if(req.method==='POST'&&url.pathname==='/api/config'){if(!admin(req))return reply(res,401,{error:'غير مصرح'});let b=await readBody(req);if(state.votes.some(v=>v.length)&& (b.groups||b.mode))return reply(res,409,{error:'لا يمكن تغيير المجموعات أو نمط التصويت بعد بداية التصويت؛ استخدم إعادة الضبط أولاً'});if(b.groups){if(!Array.isArray(b.groups)||b.groups.length<2||b.groups.length>12||b.groups.some(x=>typeof x!=='string'||!x.trim()||x.length>60))return reply(res,400,{error:'أدخل من مجموعتين إلى 12 مجموعة بأسماء صحيحة'});state.groups=b.groups.map(x=>x.trim());state.votes=state.groups.map(()=>[]);state.completed=state.groups.map(()=>false);state.active=-1;}if(b.mode){if(!['named','anonymous'].includes(b.mode))return reply(res,400,{error:'نمط غير صالح'});state.mode=b.mode;}if(b.title)state.title=String(b.title).slice(0,100);persist();broadcast();return reply(res,200,snapshot(true));}
 if(req.method==='POST'&&url.pathname==='/api/participants'){
  if(!admin(req))return reply(res,401,{error:'غير مصرح'});
  const b=await readBody(req);
  if(!Array.isArray(b.lastFour)||b.lastFour.length<1||b.lastFour.length>300)
    return reply(res,400,{error:'أدخل من رقم واحد إلى 300 رقم، كل رقم من أربعة أرقام فقط'});
  const codes=b.lastFour.map(normalizeDigits);
  const invalid=codes.findIndex(x=>!/^[0-9]{4}$/.test(x));
  if(invalid!==-1)return reply(res,400,{error:'السطر '+(invalid+1)+': يجب كتابة آخر أربعة أرقام فقط، مع الاحتفاظ بالأصفار الأولى'});
  const unique=new Set(codes);
  if(unique.size!==codes.length){
    const seen=new Set(),duplicates=[];
    for(const code of codes){if(seen.has(code)&&!duplicates.includes(code))duplicates.push(code);seen.add(code)}
    return reply(res,409,{error:'توجد أرقام متطابقة في القائمة: '+duplicates.join('، ')+'. لا يمكن التمييز بين المشاركين باستخدام آخر أربعة أرقام فقط. عالج التكرار أولًا.'});
  }
  if(state.votes.some(v=>v.length))return reply(res,409,{error:'هناك تقييمات مسجلة بالفعل. لا يمكن تغيير قائمة المشاركين حفاظًا على النتائج. ابدأ فعالية جديدة بعد حفظ النتائج المطلوبة.'});
  state.codes=codes;
  state.codeMode='phone4';
  state.active=-1;
  state.completed=state.groups.map(()=>false);
  persist();broadcast();
  return reply(res,200,{count:codes.length,codes:state.codes,participantMode:'phone4'});
 }
 if(req.method==='POST'&&url.pathname==='/api/codes'){if(!admin(req))return reply(res,401,{error:'غير مصرح'});let b=await readBody(req),n=Number(b.count);if(!Number.isInteger(n)||n<1||n>300)return reply(res,400,{error:'عدد المشاركين يجب أن يكون بين 1 و300'});if(state.codeMode==='phone4')return reply(res,409,{error:'النظام يعتمد آخر أربعة أرقام من الجوال؛ استخدم اعتماد قائمة المشاركين'});if(state.votes.some(v=>v.length))return reply(res,409,{error:'لا يمكن تغيير الرموز بعد بدء التصويت'});state.codes=Array.from({length:n},()=>shortCode());persist();return reply(res,200,{codes:state.codes});}
 if(req.method==='POST'&&url.pathname==='/api/active'){if(!admin(req))return reply(res,401,{error:'غير مصرح'});let b=await readBody(req),idx=Number(b.index);if(!Number.isInteger(idx)||idx < -1 || idx>=state.groups.length)return reply(res,400,{error:'مجموعة غير صالحة'});if(idx>=0&&(state.codeMode!=='phone4'||state.codes.length===0))return reply(res,409,{error:'اعتمد قائمة آخر أربعة أرقام للمشاركين قبل بدء التصويت'});if(idx>=0&&state.completed[idx])return reply(res,409,{error:'تصويت هذه المجموعة مغلق نهائياً؛ أعد الضبط إذا أردت التكرار'});if(state.active>=0 && state.active!==idx)state.completed[state.active]=true;state.active=idx;persist();broadcast();return reply(res,200,snapshot(true));}
 if(req.method==='POST'&&url.pathname==='/api/close'){if(!admin(req))return reply(res,401,{error:'غير مصرح'});if(state.active>=0)state.completed[state.active]=true;state.active=-1;persist();broadcast();return reply(res,200,snapshot(true));}
 if(req.method==='POST'&&url.pathname==='/api/reset'){if(!admin(req))return reply(res,401,{error:'غير مصرح'});let b=await readBody(req);if(b.confirm!=='RESET')return reply(res,400,{error:'التأكيد غير صحيح'});state.votes=state.groups.map(()=>[]);state.completed=state.groups.map(()=>false);state.active=-1;state.codes=[];state.codeMode='phone4';persist();broadcast();return reply(res,200,snapshot(true));}
 if(req.method==='POST'&&url.pathname==='/api/vote'){
  if(voteRateLimit(req))return reply(res,429,{error:'محاولات عديدة غير صحيحة. انتظر خمس دقائق ثم حاول مجددًا'});
  const b=await readBody(req),idx=state.active,code=normalizeDigits(b.code),name=String(b.name||'').trim(),score=Number(b.score);
  if(state.codeMode!=='phone4'||!state.codes.length)return reply(res,409,{error:'لم يعتمد المدرب قائمة المشاركين بعد'});
  if(idx<0)return reply(res,409,{error:'التصويت مغلق حاليًا'});
  if(!/^[0-9]{4}$/.test(code))return reply(res,400,{error:'أدخل آخر أربعة أرقام من جوالك فقط'});
  if(!state.codes.includes(code)){
    voteRateLimit(req,true);
    return reply(res,403,{error:'الرقم غير مسجل في قائمة المشاركين المعتمدين. تواصل مع المدرب'});
  }
  if(!Number.isInteger(score)||score<1||score>10)return reply(res,400,{error:'الدرجة يجب أن تكون من 1 إلى 10'});
  if(state.mode==='named'&&(!name||name.length>80))return reply(res,400,{error:'أدخل اسمك'});
  if(state.votes[idx].some(v=>v.code===code))return reply(res,409,{error:'سبق التصويت بهذا الرقم للمجموعة الحالية'});
  state.votes[idx].push({code,score,name:state.mode==='named'?name:null,at:new Date().toISOString()});
  persist();broadcast();return reply(res,200,{success:true,group:state.groups[idx]});
 }
 if(req.method!=='GET')return reply(res,404,{error:'غير موجود'});
 let pathname=url.pathname==='/'?'/index.html':url.pathname;
 const allowed={'/index.html':'text/html; charset=utf-8','/style.css':'text/css; charset=utf-8','/app.js':'text/javascript; charset=utf-8'};
 if(!allowed[pathname])return reply(res,404,{error:'غير موجود'});
 const filepath=path.join(publicDir,pathname);fs.readFile(filepath,(err,data)=>{if(err){res.writeHead(404);res.end('Not found');return}res.writeHead(200,{'Content-Type':allowed[pathname],'Cache-Control':'no-store'});res.end(data)});
 }catch(e){reply(res,400,{error:e.message||'خطأ غير متوقع'})}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Voting platform at http://localhost:${PORT}`));
