/*  ============================================================
    ธีรยุทธคลินิก — Google Apps Script Backend (Code.gs)
    รองรับ: load, login, savePatient, saveVisit,
            saveAppointment, deleteAppointment
    วิธีติดตั้ง: ดู SETUP.md
    ============================================================ */

/* ---------- ตั้งค่า ----------
   ปล่อยว่างไว้ถ้าผูกสคริปต์กับชีตโดยตรง (Extensions > Apps Script)
   หรือใส่ Spreadsheet ID ถ้าต้องการระบุชีตเอง */
const SHEET_ID = '';

/* คอลัมน์ของแต่ละชีต (แถวแรกจะถูกสร้างอัตโนมัติถ้ายังไม่มี) */
const HEADERS = {
  Patients: ['hn','cid','prefix','firstName','lastName','birthDate','gender','phone',
    'addr_no','addr_building','addr_road','addr_province','addr_amphure','addr_tambon','addr_zip',
    'address','disease','allergy','emContact','emPhone','fileUrl','createdAt'],
  Visits: ['vn','hn','date','status','cc','pi','ph','pe',
    'bp_sys','bp_dia','bt','pr','weight','height','bmi',
    'dx','treatment','lab','meds','followUpDate','followUpNote',
    'serviceFee','otherFee','medTotal','total','paid','payMethod',
    'referTo','referReason',
    'createdAt','triageAt','examAt','dispenseAt','doneAt','referAt'],
  Appointments: ['id','hn','name','date','time','type','status','createdAt'],
  Users: ['username','password','name','role','active']
};

/* meds เก็บเป็น JSON string ในชีต แต่ส่งกลับเป็น array */
const JSON_FIELDS = { Visits: ['meds'] };

/* ---------- Entry points ---------- */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'load';
  if (action === 'load') return json(loadAll());
  return json({ status: 'error', message: 'unknown GET action: ' + action });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const data = body.data;
    switch (action) {
      case 'login':             return json(login(data));
      case 'savePatient':       return json(savePatient(data));
      case 'saveVisit':         return json(saveVisit(data));
      case 'saveAppointment':   return json(saveAppointment(data));
      case 'deleteAppointment': return json(deleteAppointment(data));
      default: return json({ status: 'error', message: 'unknown action: ' + action });
    }
  } catch (err) {
    return json({ status: 'error', message: String(err && err.message || err) });
  }
}

/* ---------- Helpers ---------- */
function ss() { return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* คืน sheet และสร้าง header ให้อัตโนมัติถ้ายังไม่มี */
function sheet(name) {
  const book = ss();
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* อ่านทุกแถวเป็น array ของ object ตาม header */
function readAll(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0];
  const jsonCols = JSON_FIELDS[name] || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === '' || c === null)) continue;
    const obj = {};
    for (let c = 0; c < head.length; c++) {
      let v = row[c];
      const key = head[c];
      if (jsonCols.indexOf(key) >= 0) {
        try { v = v ? JSON.parse(v) : []; } catch (e) { v = []; }
      }
      obj[key] = v;
    }
    rows.push(obj);
  }
  return rows;
}

/* เขียนแบบ upsert ตามคอลัมน์ key */
function upsert(name, keyField, record) {
  const sh = sheet(name);
  const head = HEADERS[name];
  const jsonCols = JSON_FIELDS[name] || [];
  const rowArr = head.map(k => {
    let v = record[k];
    if (v === undefined || v === null) v = '';
    if (jsonCols.indexOf(k) >= 0 && typeof v !== 'string') v = JSON.stringify(v || []);
    return v;
  });
  const keyIdx = head.indexOf(keyField);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyIdx]) === String(record[keyField])) {
      sh.getRange(i + 1, 1, 1, head.length).setValues([rowArr]);
      return { row: i + 1, updated: true };
    }
  }
  sh.appendRow(rowArr);
  return { row: sh.getLastRow(), updated: false };
}

/* ---------- Actions ---------- */
function loadAll() {
  return {
    status: 'success',
    patients: readAll('Patients'),
    visits: readAll('Visits'),
    appointments: readAll('Appointments')
  };
}

function login(data) {
  const sh = sheet('Users');
  // ถ้ายังไม่มีผู้ใช้เลย ให้สร้างบัญชีเริ่มต้น admin/clinic123
  if (sh.getLastRow() < 2) {
    sh.appendRow(['admin', 'clinic123', 'ผู้ดูแลระบบ', 'admin', 'yes']);
  }
  const users = readAll('Users');
  const u = users.find(x =>
    String(x.username).trim() === String(data.username).trim() &&
    String(x.password) === String(data.password) &&
    String(x.active).toLowerCase() !== 'no'
  );
  if (!u) return { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  return { status: 'success', user: { username: u.username, name: u.name || u.username, role: u.role || 'staff' } };
}

function savePatient(p) {
  // แนบไฟล์ลง Google Drive ถ้ามี fileBase64
  if (p.fileBase64 && p.fileName) {
    try {
      const folder = getUploadFolder();
      const blob = Utilities.newBlob(Utilities.base64Decode(p.fileBase64), p.fileMimeType || 'application/octet-stream', p.fileName);
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      p.fileUrl = file.getUrl();
    } catch (e) { /* ไม่ให้ล้มทั้งการบันทึกถ้าอัปโหลดไม่ได้ */ }
  }
  delete p.fileBase64; delete p.fileName; delete p.fileMimeType;
  upsert('Patients', 'hn', p);
  return { status: 'success', hn: p.hn, fileUrl: p.fileUrl || '' };
}

function saveVisit(v) {
  upsert('Visits', 'vn', v);
  return { status: 'success', vn: v.vn };
}

function saveAppointment(a) {
  upsert('Appointments', 'id', a);
  return { status: 'success', id: a.id };
}

function deleteAppointment(d) {
  const sh = sheet('Appointments');
  const data = sh.getDataRange().getValues();
  const idIdx = HEADERS.Appointments.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(d.id)) { sh.deleteRow(i + 1); return { status: 'success' }; }
  }
  return { status: 'success' };
}

function getUploadFolder() {
  const name = 'ธีรยุทธคลินิก - เอกสารผู้ป่วย';
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
