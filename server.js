/** Node 20+ self-hosted server for Akevittguttas julebord. No npm modules required. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const ROOT=__dirname, DATA=path.join(ROOT,'.data'),MEDIA=path.join(DATA,'media'),PHOTOS=path.join(MEDIA,'gallery'),VIDEOS=path.join(MEDIA,'videos');
for(const p of [DATA,MEDIA,PHOTOS,VIDEOS])fs.mkdirSync(p,{recursive:true});
const DEFAULT_PEOPLE=JSON.parse(fs.readFileSync(path.join(ROOT,'participants.json'),'utf8'));
const SCORE_PEOPLE=DEFAULT_PEOPLE.filter(p=>!['p3','p9'].includes(p.id)); // Odin og Trym deltar ikke i konkurranser.
const SCORE_IDS=new Set(SCORE_PEOPLE.map(p=>p.id));
// En offentlig tjeneste må ALDRI bruke demokoden eller kortvarige sesjonsnøkler.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.ADMIN_PIN || process.env.ADMIN_PIN.length < 10 || process.env.ADMIN_PIN === '2026') {
    throw new Error('Sett en hemmelig ADMIN_PIN på minst 10 tegn før publisering.');
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('Sett SESSION_SECRET til en tilfeldig verdi på minst 32 tegn før publisering.');
  }
}
const PIN=process.env.ADMIN_PIN||'2026';
const SECRET=process.env.SESSION_SECRET||crypto.randomBytes(40).toString('hex');
const PORT=Number(process.env.PORT||8787),HOST=process.env.HOST||'127.0.0.1';
const STATE_FILE=path.join(DATA,'state.json');
const base=()=>({scores:Object.fromEntries(SCORE_PEOPLE.map(p=>[p.id,{stavmikser:0,ill:0,nest:0,other:0}])),feed:[{text:'Velkommen til Akevittguttas julebord. Alle starter på 0 poeng.',time:'Ved oppstart'}],active:'Ikke startet',ill:{startedAt:null},videos:[],gallery:[],guesses:[],surpriseRevealed:false});
let state=base();try{state={...base(),...JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))};}catch(_){/* fresh server */}
state.scores=Object.fromEntries(SCORE_PEOPLE.map(p=>[p.id,{...base().scores[p.id],...(state.scores?.[p.id]||{})}]));
const participants=()=>DEFAULT_PEOPLE;
const safeName=name=>String(name||'').trim().replace(/[<>\x00-\x1f]/g,'').slice(0,90);
const limitNumber=(value)=>{const n=Number(value);return Number.isFinite(n)?Math.max(-999,Math.min(999,Math.trunc(n))):0};
const serverState=(admin=false)=>({...state,participants:participants(),gallery:admin?state.gallery:state.gallery.filter(p=>p.approved),guesses:admin?state.guesses:undefined});
const subscribers=new Set();
const save=()=>{const file=STATE_FILE+'.tmp';fs.writeFileSync(file,JSON.stringify(state,null,2));fs.renameSync(file,STATE_FILE);broadcast()};
function broadcast(){const wire='data: '+JSON.stringify(serverState())+'\n\n';for(const res of subscribers){try{res.write(wire)}catch(_){subscribers.delete(res)}}}
function send(res,code,data,headers={}){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data))}
const bad=(res,message,code=400)=>send(res,code,{error:message});
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(part=>part.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
function token(){const expires=Date.now()+1000*60*60*14;const payload='admin.'+expires;const sig=crypto.createHmac('sha256',SECRET).update(payload).digest('hex');return payload+'.'+sig}
function authorized(req){const value=cookies(req).akv_admin;if(!value)return false;const match=/^admin\.(\d+)\.([0-9a-f]{64})$/.exec(value);if(!match||Number(match[1])<Date.now())return false;const payload='admin.'+match[1],expected=crypto.createHmac('sha256',SECRET).update(payload).digest('hex');return crypto.timingSafeEqual(Buffer.from(match[2]),Buffer.from(expected))}
async function body(req,max=1024*1024){let bytes=0;const parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw Object.assign(new Error('Filen eller forespørselen er for stor'),{status:413});parts.push(chunk)}return Buffer.concat(parts)}
async function json(req,max){const raw=await body(req,max);try{return JSON.parse(raw.toString('utf8'))}catch(_){throw Object.assign(new Error('Ugyldige JSON-data'),{status:400})}}
const uid=()=>crypto.randomBytes(12).toString('hex');
const rate=new Map();function limit(ip,key,max,windowMs){const k=ip+':'+key,now=Date.now();let a=rate.get(k)||[];a=a.filter(t=>now-t<windowMs);if(a.length>=max)return false;a.push(now);rate.set(k,a);return true}
function originSafe(req){const origin=req.headers.origin;if(!origin)return true;try{const ref=new URL(origin);return ref.host===req.headers.host}catch(_){return false}}
function typeOf(file){const ext=path.extname(file).toLowerCase();return {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.txt':'text/plain; charset=utf-8'}[ext]}
function staticFile(req,res,file,cache='private,max-age=300'){
 if(!fs.existsSync(file)||!fs.statSync(file).isFile())return bad(res,'Fil finnes ikke',404);
 const mime=typeOf(file);if(!mime)return bad(res,'Filtypen er ikke tilgjengelig',403);
 const size=fs.statSync(file).size;
 const headers={'Content-Type':mime,'Cache-Control':cache,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
 const range=req.headers.range;
 if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return bad(res,'Ugyldig videointervall',416);let start=m[1]?Number(m[1]):0;let end=m[2]?Number(m[2]):size-1;if(!m[1]&&m[2]){start=Math.max(0,size-Number(m[2]));end=size-1}if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||start>=size)return bad(res,'Videointervall utenfor filen',416);end=Math.min(end,size-1);res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});return fs.createReadStream(file,{start,end}).pipe(res)}
 res.writeHead(200,{...headers,'Content-Length':size});fs.createReadStream(file).pipe(res);
}
function checkMedia(req,res,pathname){const seg=pathname.split('/');if(seg.length!==4)return bad(res,'Ugyldig filadresse',404);const [,base,kind,file]=seg;if(base!=='media'||!['gallery','videos'].includes(kind)||!/^([a-f0-9]{24})\.(jpe?g|png|webp|mp4|mov|webm)$/.test(file))return bad(res,'Ikke tillatt',403);
 const ok=(kind==='videos'?state.videos:state.gallery).some(m=>m.url===pathname&&(kind==='videos'||m.approved||authorized(req)));if(!ok)return bad(res,'Filen er ikke tilgjengelig',404);
 const directory=kind==='gallery'?PHOTOS:VIDEOS;return staticFile(req,res,path.join(directory,file),'private,max-age=120');}
async function doCommand(req,res){if(!authorized(req))return bad(res,'Du må logge inn som arrangør.',401);
 const j=await json(req),type=j.type;
 switch(type){
 case 'score':if(!SCORE_IDS.has(j.id)||!['stavmikser','ill','nest','other'].includes(j.key))return bad(res,'Ugyldig deltaker eller konkurranse');state.scores[j.id][j.key]=limitNumber(j.value);break;
 case 'scoreAdjust':{if(!SCORE_IDS.has(j.id)||!Number.isInteger(j.delta)||j.delta===0||Math.abs(j.delta)>999)return bad(res,'Velg deltaker og poeng mellom −999 og 999');const score=state.scores[j.id];score.other=limitNumber((score.other||0)+j.delta);const reason=String(j.reason||'').trim();if(reason){const p=SCORE_PEOPLE.find(x=>x.id===j.id);state.feed.unshift({text:`${p.name}: ${j.delta>0?'+':''}${j.delta} poeng – ${reason.slice(0,100)}`,time:new Date().toLocaleTimeString('nb-NO')})}break;}
 case 'illStart':state.ill={startedAt:Date.now()};state.active='ILL';state.feed.unshift({text:'ILL startet – latter gir −1 poeng',time:new Date().toLocaleTimeString('nb-NO')});break;
 case 'illStop':state.ill={startedAt:null};break;
 case 'feed':{const t=String(j.text||'').trim();if(!t||t.length>240)return bad(res,'Melding må være 1–240 tegn');state.feed.unshift({text:t,time:new Date().toLocaleTimeString('nb-NO')});break;}
 case 'active':if(!['Ikke startet','Stavmikser','ILL','Nest flest','Pause','Ferdig'].includes(j.active))return bad(res,'Ukjent konkurranse');state.active=j.active;break;
 case 'surpriseReveal':state.surpriseRevealed=!!j.value;break;
 case 'videoOrder':{const ids=j.order;if(!Array.isArray(ids)||ids.length!==state.videos.length||new Set(ids).size!==ids.length||ids.some(id=>!state.videos.some(v=>v.id===id)))return bad(res,'Ugyldig videorekkefølge');state.videos.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));break;}
 case 'videoDelete':{const found=state.videos.find(v=>v.id===j.id);if(!found)return bad(res,'Fant ikke video',404);state.videos=state.videos.filter(v=>v.id!==j.id);try{fs.unlinkSync(path.join(VIDEOS,path.basename(found.url)))}catch(_){}break;}
 case 'galleryModerate':{const found=state.gallery.find(v=>v.id===j.id);if(!found)return bad(res,'Fant ikke bildet',404);if(j.remove){state.gallery=state.gallery.filter(v=>v.id!==j.id);try{fs.unlinkSync(path.join(PHOTOS,path.basename(found.url)))}catch(_){}}else found.approved=!!j.approved;break;}
 default:return bad(res,'Ukjent kommando');
 }
 state.feed=state.feed.slice(0,80);save();send(res,200,{state:serverState()});}
async function uploadPhoto(req,res){if(!limit(req.socket.remoteAddress||'','gallery',15,60*60*1000))return bad(res,'Maks 15 bilder per time fra samme enhet',429);
 const ct=String(req.headers['content-type']||'');if(!['image/jpeg','image/png','image/webp'].includes(ct))return bad(res,'Bruk JPG, PNG eller WebP',415);
 const b=await body(req,5*1024*1024),id=uid(),ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[ct];
 // Check magic bytes; never trust just the content-type header.
 const okay=ct==='image/jpeg'?b[0]===0xff&&b[1]===0xd8:ct==='image/png'?b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
 if(!okay)return bad(res,'Filen ser ikke ut som et bilde',415);
 const file=id+'.'+ext;fs.writeFileSync(path.join(PHOTOS,file),b,{flag:'wx'});
 let by='Anonym';try{by=safeName(decodeURIComponent(String(req.headers['x-display-name']||'Anonym')))||'Anonym'}catch(_){}
 state.gallery.push({id,url:'/media/gallery/'+file,by,approved:true,addedAt:Date.now()});save();send(res,200,{state:serverState()});}
async function uploadVideo(req,res){if(!authorized(req))return bad(res,'Kun arrangøren kan laste opp filmklipp.',401);if(state.videos.length>=50)return bad(res,'Maks 50 klipp',400);
 const type=String(req.headers['content-type']||'');const ext={'video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm','application/octet-stream':'mp4'}[type];if(!ext)return bad(res,'Video må være MP4, MOV eller WebM',415);
 const id=uid(),file=id+'.'+ext,location=path.join(VIDEOS,file),tmp=location+'.upload';let bytes=0;
 const check=new Transform({transform(chunk,enc,done){bytes+=chunk.length;if(bytes>250*1024*1024)return done(new Error('Video over 250 MB'));done(null,chunk)}});
 try{await pipeline(req,check,fs.createWriteStream(tmp,{flags:'wx'}));if(bytes<1024)throw new Error('Videoen er tom eller ugyldig');fs.renameSync(tmp,location)}catch(err){try{fs.unlinkSync(tmp)}catch(_){}return bad(res,err.message,413)}
 let name='Video';try{name=safeName(decodeURIComponent(String(req.headers['x-file-name']||'Video')))||'Video'}catch(_){}
 state.videos.push({id,url:'/media/videos/'+file,name,bytes});save();send(res,200,{state:serverState()});}
const loginLimits=new Map();
async function handle(req,res){const u=new URL(req.url,'http://localhost');const pathname=decodeURIComponent(u.pathname);
 if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!originSafe(req))return bad(res,'Ugyldig forespørselsopprinnelse',403);
 if(req.method==='GET'&&pathname==='/health')return send(res,200,{ok:true});
 if(req.method==='GET'&&pathname==='/api/state')return send(res,200,serverState());
 if(req.method==='GET'&&pathname==='/api/admin/status')return send(res,200,{authenticated:authorized(req)});
 if(req.method==='GET'&&pathname==='/api/admin')return authorized(req)?send(res,200,{guesses:state.guesses,gallery:state.gallery}):bad(res,'Ikke innlogget',401);
 if(req.method==='GET'&&pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 4000\ndata: '+JSON.stringify(serverState())+'\n\n');subscribers.add(res);req.on('close',()=>subscribers.delete(res));return}
 if(req.method==='POST'&&pathname==='/api/login'){if(!limit(req.socket.remoteAddress||'','login',10,15*60*1000))return bad(res,'For mange forsøk; prøv senere',429);const j=await json(req,3000);const a=Buffer.from(String(j.pin||'')),b=Buffer.from(PIN);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return bad(res,'Feil arrangørkode',401);return send(res,200,{ok:true},{'Set-Cookie':`akv_admin=${encodeURIComponent(token())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=50400${req.socket.encrypted||req.headers['x-forwarded-proto']==='https'?'; Secure':''}`})}
 if(req.method==='POST'&&pathname==='/api/logout')return send(res,200,{ok:true},{'Set-Cookie':'akv_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'});
 if(req.method==='POST'&&pathname==='/api/command')return doCommand(req,res);
 if(req.method==='POST'&&pathname==='/api/guess'){
  if(!limit(req.socket.remoteAddress||'','guess',20,60*60*1000))return bad(res,'For mange innsendte svar',429);
  const j=await json(req,10000),name=safeName(j.name),answers=j.answers;
  if(!name||name.length>60||!Array.isArray(answers)||answers.length!==3||answers.some(x=>typeof x!=='string'||!x.trim()||x.length>90))return bad(res,'Oppgi navn og akkurat tre forslag');
  if(state.guesses.some(g=>g.name.toLocaleLowerCase('nb-NO')===name.toLocaleLowerCase('nb-NO')))return bad(res,'Dette navnet har allerede sendt inn et svar');
  state.guesses.push({id:uid(),name,answers:answers.map(a=>a.trim()),time:new Date().toLocaleTimeString('nb-NO')});save();return send(res,200,{ok:true});}
 if(req.method==='POST'&&pathname==='/api/gallery')return uploadPhoto(req,res);
 if(req.method==='POST'&&pathname==='/api/video')return uploadVideo(req,res);
 if(req.method==='GET'&&pathname.startsWith('/media/'))return checkMedia(req,res,pathname);
 if(req.method==='GET'&&(pathname==='/'||pathname==='/index.html'))return staticFile(req,res,path.join(ROOT,'index.html'),'no-cache');
 if(req.method==='GET'){
  if(/^(\/participants\/[a-z0-9_-]+\.(png|webp)|\/ill\/ill_\d{2}\.webp|\/style\.css|\/app\.js)$/.test(pathname))return staticFile(req,res,path.join(ROOT,pathname),'private,max-age=3600');
  return bad(res,'Fant ikke siden',404);
 }
 return bad(res,'Metoden støttes ikke',405);
}
const server=http.createServer((req,res)=>{handle(req,res).catch(err=>{if(!res.headersSent)bad(res,err.message||'Uventet serverfeil',err.status||500);else res.destroy()})});
const keepalive=setInterval(()=>{for(const res of subscribers){try{res.write(': ping\n\n')}catch(_){subscribers.delete(res)}}},25000);keepalive.unref();
server.listen(PORT,HOST,()=>{console.log(`Akevittguttas julebord kjører på http://${HOST}:${PORT}`);if(PIN==='2026')console.warn('ADVARSEL: Du bruker standardkode 2026. Sett ADMIN_PIN før du gjør siden tilgjengelig for andre.');});
