/**************************************************************
 * agent-file.js — card-agent เวอร์ชัน "อ่านไฟล์จาก SIAM-ID"
 * ไม่ต้อง npm install / ไม่ต้อง compile — ใช้ Node ล้วน (http + fs)
 *
 * หลักการ: SIAM-ID เซฟไฟล์ข้อมูลบัตรลงโฟลเดอร์ (เช่น Documents)
 * โปรแกรมนี้จะหยิบไฟล์ล่าสุด แยกข้อมูล แล้วเปิด API ให้เว็บดึงตรง
 *
 *   วิธีรัน:   node agent-file.js
 *   (ระบุโฟลเดอร์เอง)  node agent-file.js "C:\\Users\\JY-PC\\Documents"
 *
 *   เว็บเรียก:  GET http://localhost:8765/read
 **************************************************************/

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8765;
const WATCH_DIR = process.argv[2] || path.join(os.homedir(), 'Documents');
const EXTS = ['.txt', '.csv', '.log', '.json', '.dat'];
const MAX_AGE_MS = 5 * 60 * 1000;   // รับเฉพาะไฟล์ที่เพิ่งเซฟภายใน 5 นาที

/* ---------- ตัวถอดรหัส TIS-620 -> Unicode (ไม่ต้องพึ่งไลบรารี) ---------- */
function decodeMaybeTIS620(buf){
  const utf8 = buf.toString('utf8');
  if(!utf8.includes('\uFFFD')) return utf8;           // เป็น UTF-8 อยู่แล้ว
  let s = '';
  for(let i=0;i<buf.length;i++){
    const b = buf[i];
    if(b >= 0xA1 && b <= 0xFB) s += String.fromCharCode(0x0E00 + (b - 0xA0));
    else s += String.fromCharCode(b);
  }
  return s;
}

/* ---------- หาไฟล์ล่าสุดในโฟลเดอร์ ---------- */
function newestFile(dir){
  let best = null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch(e){ return null; }
  for(const name of entries){
    if(!EXTS.includes(path.extname(name).toLowerCase())) continue;
    const fp = path.join(dir, name);
    let st; try { st = fs.statSync(fp); } catch(e){ continue; }
    if(!st.isFile()) continue;
    if(!best || st.mtimeMs > best.mtime) best = { path: fp, mtime: st.mtimeMs, name };
  }
  return best;
}

/* ---------- แปลงวันที่ไทย -> ISO ---------- */
function thaiDateToISO(s){
  s = String(s||'').trim(); if(!s) return '';
  const TH={'มกราคม':1,'ม.ค.':1,'กุมภาพันธ์':2,'ก.พ.':2,'มีนาคม':3,'มี.ค.':3,'เมษายน':4,'เม.ย.':4,'พฤษภาคม':5,'พ.ค.':5,'มิถุนายน':6,'มิ.ย.':6,'กรกฎาคม':7,'ก.ค.':7,'สิงหาคม':8,'ส.ค.':8,'กันยายน':9,'ก.ย.':9,'ตุลาคม':10,'ต.ค.':10,'พฤศจิกายน':11,'พ.ย.':11,'ธันวาคม':12,'ธ.ค.':12};
  let m = s.match(/(\d{1,2})\s+([ก-๙.]+)\s+(\d{4})/), dd,mm,yy;
  if(m){ dd=+m[1]; mm=TH[m[2]]||0; yy=+m[3]; }
  else { m = s.match(/(\d{4})[-\/.]?(\d{2})[-\/.]?(\d{2})/); if(m){ yy=+m[1]; mm=+m[2]; dd=+m[3]; } else { m=s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/); if(!m) return ''; dd=+m[1]; mm=+m[2]; yy=+m[3]; } }
  if(!mm) return '';
  if(yy > 2400) yy -= 543;
  return yy + '-' + String(mm).padStart(2,'0') + '-' + String(dd).padStart(2,'0');
}

/* ---------- แยกข้อมูลบัตรแบบไม่อิงลำดับ (พอร์ตจากฝั่งเว็บ) ---------- */
function parseCardData(raw){
  const parts = String(raw||'').split(/[,\t\r\n#]+/).map(s=>s.trim()).filter(Boolean);
  const d = {}; const used = new Array(parts.length).fill(false);
  parts.forEach((p,i)=>{
    const digits = p.replace(/\D/g,'');
    if(!d.cid && digits.length===13){ d.cid=digits; used[i]=true; }
    else if(!d.gender && (p==='ชาย'||p==='หญิง'||p==='1'||p==='2')){ d.gender = (p==='1'?'ชาย':p==='2'?'หญิง':p); used[i]=true; }
    else if(!d.birthDate && (/[ก-๙]+\s+\d{4}/.test(p) || /\d{4}[-\/.]?\d{2}[-\/.]?\d{2}/.test(p) || /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}/.test(p))){ const iso=thaiDateToISO(p); if(iso){ d.birthDate=iso; used[i]=true; } }
  });
  let addrIdx = -1;
  parts.forEach((p,i)=>{ if(!used[i] && /[ก-๙]/.test(p) && /(หมู่|ม\.|ต\.|ตำบล|อ\.|อำเภอ|จ\.|จังหวัด|แขวง|เขต|ซอย|ถนน|\d{5})/.test(p)){ if(addrIdx<0 || p.length>parts[addrIdx].length) addrIdx=i; } });
  if(addrIdx<0){ let mx=0; parts.forEach((p,i)=>{ if(!used[i] && /[ก-๙]/.test(p) && p.length>mx){ mx=p.length; addrIdx=i; } }); }
  if(addrIdx>=0){ d.address=parts[addrIdx]; used[addrIdx]=true; }
  let nameStr='';
  for(let i=0;i<parts.length;i++){ if(!used[i] && /[ก-๙]/.test(parts[i]) && !/[a-zA-Z0-9]/.test(parts[i])){ nameStr=parts[i]; used[i]=true; break; } }
  if(nameStr){
    const sp = nameStr.split(/\s+/);
    const PMAP={'นาย':'นาย','นาง':'นาง','นางสาว':'นางสาว','ด.ช.':'ด.ช.','ด.ญ.':'ด.ญ.','เด็กชาย':'ด.ช.','เด็กหญิง':'ด.ญ.'};
    if(PMAP[sp[0]]){ d.prefix=PMAP[sp[0]]; sp.shift(); }
    d.firstName = sp.shift() || '';
    d.lastName = sp.join(' ');
  }
  if(d.gender && !d.prefix) d.prefix = d.gender==='ชาย' ? 'นาย' : '';
  return d;
}

/* ---------- HTTP server ---------- */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const send = (code,obj) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); };

  if(req.url.startsWith('/read')){
    const f = newestFile(WATCH_DIR);
    if(!f) return send(200, { status:'error', message:'ไม่พบไฟล์ข้อมูลในโฟลเดอร์ '+WATCH_DIR });
    if(Date.now() - f.mtime > MAX_AGE_MS) return send(200, { status:'error', message:'ยังไม่มีการอ่านบัตรใหม่ (ไฟล์ล่าสุดเก่าเกิน 5 นาที) — แตะบัตรใน SIAM-ID ก่อน' });
    let raw; try { raw = decodeMaybeTIS620(fs.readFileSync(f.path)); } catch(e){ return send(200,{status:'error',message:'อ่านไฟล์ไม่ได้: '+e.message}); }
    const d = parseCardData(raw);
    d.status = (d.cid || d.firstName) ? 'success' : 'error';
    if(d.status==='error') d.message = 'แยกข้อมูลไม่ได้ ตรวจรูปแบบไฟล์ SIAM-ID';
    d._file = f.name; d._raw = raw.slice(0, 500);   // แนบดิบ 500 ตัวแรกไว้ debug
    send(200, d);
  } else {
    send(200, { status:'ok', message:'agent-file ทำงานอยู่ — เฝ้าโฟลเดอร์: '+WATCH_DIR });
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('===================================================');
  console.log(' card-agent (อ่านไฟล์) พร้อมใช้งานที่ http://localhost:'+PORT);
  console.log(' เฝ้าโฟลเดอร์: ' + WATCH_DIR);
  console.log(' * เปิดหน้าต่างนี้ค้างไว้ระหว่างใช้งาน *');
  console.log('===================================================');
});
