/**************************************************************
 * card-agent — โปรแกรมอ่านบัตรประชาชนไทย (USB PC/SC)
 * เปิด local HTTP server ให้เว็บแอปเรียกดึงข้อมูลจากบัตร
 *
 * ใช้กับเครื่องอ่านบัตรมาตรฐาน PC/SC (สมาร์ทการ์ดรีดเดอร์ทั่วไป)
 * วิธีติดตั้ง/รัน: ดู README.md ในโฟลเดอร์นี้
 *
 *   เว็บแอปเรียก:  GET http://localhost:8765/read
 *   ได้ผลลัพธ์:    { status, cid, prefix, firstName, lastName,
 *                    gender, birthDate, address, photoBase64 }
 **************************************************************/

const http = require('http');
const pcsclite = require('pcsclite');
const iconv = require('iconv-lite');

const PORT = 8765;

/* ---------- APDU commands ของบัตรประชาชนไทย ---------- */
const SELECT = [0x00, 0xA4, 0x04, 0x00, 0x08, 0xA0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01];
const CMD = {
  cid:       [0x80, 0xb0, 0x00, 0x04, 0x02, 0x00, 0x0d],
  fullNameT: [0x80, 0xb0, 0x00, 0x11, 0x02, 0x00, 0x64], // ชื่อ-สกุล ภาษาไทย
  fullNameE: [0x80, 0xb0, 0x01, 0x75, 0x02, 0x00, 0x64], // ชื่อ-สกุล อังกฤษ
  birth:     [0x80, 0xb0, 0x00, 0xD9, 0x02, 0x00, 0x08],
  gender:    [0x80, 0xb0, 0x00, 0xE1, 0x02, 0x00, 0x01],
  address:   [0x80, 0xb0, 0x15, 0x79, 0x02, 0x00, 0x64]
};
// รูปถ่ายในบัตร: อ่านทีละบล็อก (20 บล็อก × 255 ไบต์)
function photoCmd(i) {
  const p = 0x017B + i * 0xFF;
  return [0x80, 0xb0, (p >> 8) & 0xFF, p & 0xFF, 0x02, 0x00, 0xFF];
}

/* GET RESPONSE — บัตรไทยตอบผ่านคำสั่งนี้หลังส่งคำสั่งอ่าน */
const getResponse = le => [0x00, 0xc0, 0x00, 0x00, le];

function transmit(reader, protocol, apdu) {
  return new Promise((resolve, reject) => {
    reader.transmit(Buffer.from(apdu), 258, protocol, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

/* ส่งคำสั่งอ่าน แล้วตามด้วย GET RESPONSE คืน Buffer เฉพาะข้อมูล (ตัด SW1 SW2) */
async function readField(reader, protocol, apdu) {
  await transmit(reader, protocol, apdu);
  const le = apdu[apdu.length - 1];
  const res = await transmit(reader, protocol, getResponse(le));
  return res.slice(0, res.length - 2); // ตัด status word 2 ไบต์ท้าย
}

const decodeTIS620 = buf => iconv.decode(buf, 'tis-620').trim();

/* แปลงชื่อ-สกุลไทย: "คำนำหน้า#ชื่อ##นามสกุล" */
function parseName(raw) {
  const parts = decodeTIS620(raw).split('#').filter(s => s !== '');
  return {
    prefix: parts[0] || '',
    firstName: parts[1] || '',
    lastName: parts[parts.length - 1] || ''
  };
}

/* วันเกิด YYYYMMDD (พ.ศ.) -> ISO ค.ศ. */
function parseBirth(raw) {
  const s = decodeTIS620(raw);
  if (s.length < 8) return '';
  const be = parseInt(s.slice(0, 4), 10);
  return `${be - 543}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/* ที่อยู่: ช่องคั่นด้วย # -> รวมเป็นข้อความเดียว */
const parseAddress = raw => decodeTIS620(raw).split('#').filter(Boolean).join(' ');

async function readCard(reader, protocol) {
  await transmit(reader, protocol, SELECT);
  const cid = decodeTIS620(await readField(reader, protocol, CMD.cid));
  const name = parseName(await readField(reader, protocol, CMD.fullNameT));
  const birthDate = parseBirth(await readField(reader, protocol, CMD.birth));
  const gender = decodeTIS620(await readField(reader, protocol, CMD.gender));
  const address = parseAddress(await readField(reader, protocol, CMD.address));

  // รูปถ่าย (ต่อบล็อก)
  let photo = Buffer.alloc(0);
  for (let i = 0; i < 20; i++) {
    const chunk = await readField(reader, protocol, photoCmd(i));
    photo = Buffer.concat([photo, chunk]);
  }

  return {
    status: 'success',
    cid, prefix: name.prefix, firstName: name.firstName, lastName: name.lastName,
    gender, birthDate, address,
    photoBase64: photo.toString('base64')
  };
}

/* ---------- state ปัจจุบันของบัตรที่เสียบอยู่ ---------- */
let currentReader = null;
let currentProtocol = null;

const pcsc = pcsclite();
pcsc.on('reader', reader => {
  console.log('พบเครื่องอ่านบัตร:', reader.name);
  reader.on('error', err => console.error('reader error:', err.message));
  reader.on('status', status => {
    const changes = reader.state ^ status.state;
    if (changes & reader.SCARD_STATE_PRESENT && (status.state & reader.SCARD_STATE_PRESENT)) {
      reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (err, protocol) => {
        if (err) return console.error('connect error:', err.message);
        currentReader = reader; currentProtocol = protocol;
        console.log('เสียบบัตรแล้ว — พร้อมอ่าน');
      });
    } else if (changes & reader.SCARD_STATE_EMPTY) {
      currentReader = null; currentProtocol = null;
      console.log('ถอดบัตรออก');
    }
  });
});
pcsc.on('error', err => console.error('PC/SC error:', err.message));

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  // อนุญาต CORS ให้เว็บแอป (Netlify/localhost) เรียกได้
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (req.url.startsWith('/read')) {
    if (!currentReader || !currentProtocol) return send(200, { status: 'error', message: 'ยังไม่ได้เสียบบัตร หรือยังไม่พบเครื่องอ่าน' });
    try {
      const data = await readCard(currentReader, currentProtocol);
      send(200, data);
    } catch (e) {
      send(200, { status: 'error', message: 'อ่านบัตรไม่สำเร็จ: ' + e.message });
    }
  } else {
    send(200, { status: 'ok', message: 'card-agent ทำงานอยู่ — เรียก /read เพื่ออ่านบัตร' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`card-agent พร้อมใช้งานที่ http://localhost:${PORT}`));
