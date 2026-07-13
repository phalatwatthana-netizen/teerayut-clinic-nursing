/**************************************************************
 * ธีรยุทธคลินิก — Google Apps Script Backend (Code.gs)
 * ฐานข้อมูล: Google Sheets | ไฟล์แนบ: Google Drive
 *
 * วิธีใช้:
 *  1) สร้าง Google Sheet ใหม่ 1 ไฟล์
 *  2) Extensions > Apps Script > วางโค้ดนี้แทนของเดิม
 *  3) Deploy > New deployment > Web app
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  4) คัดลอก URL (.../exec) ไปวางในหน้า "ตั้งค่า" ของเว็บแอป
 **************************************************************/

var SHEET_PATIENTS = 'Patients';
var SHEET_VISITS = 'Visits';
var SHEET_APPTS = 'Appointments';
var SHEET_USERS = 'Users';
var SHEET_INV = 'Inventory';
var DRIVE_FOLDER = 'ThirayutClinic_Files';

var HEADERS = {
  Patients: ['hn','cid','prefix','firstName','lastName','birthDate','gender','phone','race','nationality','maritalStatus','address','disease','allergy','emContact','emPhone','fileUrl','photoUrl','createdAt'],
  Visits: ['vn','hn','date','status','cc','pi','ph','pe','bp_sys','bp_dia','bt','pr','weight','height','bmi','dx','treatment','lab','meds_json','medTotal','serviceFee','otherFee','total','paid','payMethod','referTo','referReason','followUpDate','followUpNote','createdAt','triageAt','examAt','dispenseAt','doneAt','referAt'],
  Appointments: ['id','hn','name','date','time','type','status','createdAt'],
  Users: ['username','password','name','role','active'],
  Inventory: ['code','name','unit','price','stock','minStock','category','updatedAt']
};
var KEY = { Patients:'hn', Visits:'vn', Appointments:'id', Inventory:'code' };
/* คอลัมน์ที่ต้องเก็บเป็นข้อความ (กัน Google Sheets ตัดเลข 0 นำหน้า) */
var TEXT_COLS = { Patients:['cid','phone','emPhone'], Users:['username','password'], Inventory:['code'] };

/* ---------- HTTP entry points ---------- */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'load';
    if (action === 'load') return json(loadAll());
    return json({ status: 'error', message: 'unknown action' });
  } catch (err) {
    return json({ status: 'error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var data = body.data || {};
    if (action === 'login')             return json(login(data));
    if (action === 'savePatient')       return json(savePatient(data));
    if (action === 'saveVisit')         return json(upsert(SHEET_VISITS, data));
    if (action === 'saveAppointment')   return json(upsert(SHEET_APPTS, data));
    if (action === 'deleteAppointment') return json(deleteRecord(SHEET_APPTS, data.id));
    if (action === 'saveInventory')     return json(upsert(SHEET_INV, data));
    if (action === 'deleteInventory')   return json(deleteRecord(SHEET_INV, data.code));
    if (action === 'saveVisitPdf')      return json(saveVisitPdf(data));
    return json({ status: 'error', message: 'unknown action: ' + action });
  } catch (err) {
    return json({ status: 'error', message: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Sheet helpers ---------- */
function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS[name]);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS[name]);
  }
  return sh;
}

function readAll(name) {
  var sh = getSheet(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  // ยึดลำดับคอลัมน์จากโค้ด (HEADERS) เป็นหลัก กันหัวตารางในชีตไม่ตรงลำดับ -> ข้อมูลเลื่อนช่อง
  var head = HEADERS[name] || values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0]) continue; // skip empty key
    var obj = {};
    for (var c = 0; c < head.length; c++) obj[head[c]] = row[c];
    if (name === SHEET_VISITS) {
      try { obj.meds = obj.meds_json ? JSON.parse(obj.meds_json) : []; } catch (x) { obj.meds = []; }
      delete obj.meds_json;
    }
    out.push(obj);
  }
  return out;
}

function loadAll() {
  return {
    status: 'success',
    patients: readAll(SHEET_PATIENTS),
    visits: readAll(SHEET_VISITS),
    appointments: readAll(SHEET_APPTS),
    inventory: readAll(SHEET_INV)
  };
}

/* upsert a record into a sheet by its KEY column */
function upsert(name, data) {
  var sh = getSheet(name);
  var headers = HEADERS[name];
  var keyField = KEY[name];

  // prepare row payload (handle nested meds for Visits)
  var rec = {};
  for (var k in data) rec[k] = data[k];
  if (name === SHEET_VISITS) {
    rec.meds_json = JSON.stringify(data.meds || []);
  }

  var keyVal = rec[keyField];
  var rowArr = headers.map(function (h) {
    var v = rec[h];
    return (v === undefined || v === null) ? '' : v;
  });

  // find existing row by key
  var keyColIdx = headers.indexOf(keyField); // 0-based
  var lastRow = Math.max(sh.getLastRow(), 1);
  var keyValues = sh.getRange(1, keyColIdx + 1, lastRow, 1).getValues();
  var foundRow = -1;
  for (var i = 1; i < keyValues.length; i++) {
    if (String(keyValues[i][0]) === String(keyVal)) { foundRow = i + 1; break; }
  }
  if (foundRow > 0) {
    sh.getRange(foundRow, 1, 1, headers.length).setValues([rowArr]);
  } else {
    sh.appendRow(rowArr);
  }

  var res = { status: 'success' };
  res[keyField] = keyVal;
  return res;
}

function deleteRecord(name, keyVal) {
  var sh = getSheet(name);
  var headers = HEADERS[name];
  var keyColIdx = headers.indexOf(KEY[name]);
  var lastRow = Math.max(sh.getLastRow(), 1);
  var values = sh.getRange(1, keyColIdx + 1, lastRow, 1).getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(keyVal)) { sh.deleteRow(i + 1); break; }
  }
  return { status: 'success' };
}

/* ---------- ติดตั้งครั้งแรก (รันเองจากเมนู Apps Script) ----------
   เลือกฟังก์ชัน setupSheets แล้วกด Run เพื่อสร้างทุกชีตพร้อมหัวตาราง
   และบัญชีผู้ใช้เริ่มต้น admin / clinic123 */
function setupSheets() {
  getSheet(SHEET_PATIENTS);
  getSheet(SHEET_VISITS);
  getSheet(SHEET_APPTS);
  getSheet(SHEET_INV);
  var users = getSheet(SHEET_USERS);
  if (users.getLastRow() < 2) {
    // username, password, name, role, active
    users.appendRow(['admin', 'clinic123', 'ผู้ดูแลระบบ', 'admin', 'yes']);
    users.appendRow(['nurse', 'nurse123', 'พยาบาลวิชาชีพ', 'staff', 'yes']);
  }
  applyTextFormats();
  return 'สร้างชีตเรียบร้อย: Patients, Visits, Appointments, Users, Inventory';
}

/* ---------- ซ่อมหัวตารางทุกชีตให้ตรงลำดับ HEADERS (รันเองถ้าต้องการ) ---------- */
function syncHeaders() {
  ['Patients','Visits','Appointments','Users','Inventory'].forEach(function(name){
    var sh = getSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
  });
  applyTextFormats();
  return 'ปรับหัวตาราง + ตั้งคอลัมน์ข้อความ (กันเลข 0 หาย) แล้ว';
}

/* ตั้งรูปแบบคอลัมน์ที่ต้องเป็นข้อความ (เบอร์โทร/บัตร ปชช./รหัส) */
function applyTextFormats() {
  Object.keys(TEXT_COLS).forEach(function(name){
    var sh = getSheet(name);
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    TEXT_COLS[name].forEach(function(col){
      var idx = HEADERS[name].indexOf(col);
      if (idx >= 0) sh.getRange(2, idx + 1, rows, 1).setNumberFormat('@');
    });
  });
}

/* ---------- Login (ตรวจสอบผู้ใช้จากชีต Users) ---------- */
function login(data) {
  var sh = getSheet(SHEET_USERS);
  // ถ้ายังไม่มีผู้ใช้เลย สร้างบัญชีเริ่มต้น admin/clinic123 ให้อัตโนมัติ
  if (sh.getLastRow() < 2) {
    sh.appendRow(['admin', 'clinic123', 'ผู้ดูแลระบบ', 'admin', 'yes']);
  }
  var users = readAll(SHEET_USERS);
  var u = null;
  for (var i = 0; i < users.length; i++) {
    var x = users[i];
    if (String(x.username).trim() === String(data.username).trim() &&
        String(x.password) === String(data.password) &&
        String(x.active).toLowerCase() !== 'no') { u = x; break; }
  }
  if (!u) return { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  return { status: 'success', user: { username: u.username, name: u.name || u.username, role: u.role || 'staff' } };
}

/* ---------- Patient save with optional Drive upload ----------
   ไฟล์ทั้งหมดเก็บใน Drive แยกโฟลเดอร์ตาม HN */
function savePatient(data) {
  var hn = data.hn || 'unknown';

  // เอกสารแนบ (บัตร ปชช./ใบส่งตัว)
  if (data.fileBase64 && data.fileName) {
    try {
      var folder = getPatientFolder(hn);
      var blob = Utilities.newBlob(Utilities.base64Decode(data.fileBase64),
        data.fileMimeType || 'application/octet-stream', hn + '_doc_' + data.fileName);
      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      data.fileUrl = file.getUrl();
    } catch (err) { /* ไม่ให้ล้มทั้งการบันทึก */ }
  }

  // รูปผู้รับบริการ
  if (data.photoBase64) {
    try {
      var pfolder = getPatientFolder(hn);
      var pname = data.photoName || 'photo.jpg';
      var pblob = Utilities.newBlob(Utilities.base64Decode(data.photoBase64),
        data.photoMimeType || 'image/jpeg', hn + '_photo_' + pname);
      var pfile = pfolder.createFile(pblob);
      pfile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      data.photoUrl = pfile.getUrl();
    } catch (err) { /* ไม่ให้ล้มทั้งการบันทึก */ }
  }

  // strip file payload before writing to sheet
  delete data.fileBase64; delete data.fileName; delete data.fileMimeType;
  delete data.photoBase64; delete data.photoName; delete data.photoMimeType;

  var res = upsert(SHEET_PATIENTS, data);
  res.fileUrl = data.fileUrl || '';
  res.photoUrl = data.photoUrl || '';
  return res;
}

/* โฟลเดอร์รากของคลินิก */
/* ---------- บันทึกเวชระเบียนเป็น PDF ลง Drive (แยกโฟลเดอร์ HN) ---------- */
function saveVisitPdf(data) {
  var hn = data.hn || 'unknown';
  var vn = data.vn || 'visit';
  var html = data.html || '<p>-</p>';
  var folder = getPatientFolder(hn);
  var pdf = Utilities.newBlob(html, 'text/html', vn + '.html').getAs('application/pdf')
              .setName(hn + '_' + vn + '_record.pdf');
  var file = folder.createFile(pdf);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { status: 'success', url: file.getUrl() };
}

function getDriveFolder() {
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(DRIVE_FOLDER);
}

/* โฟลเดอร์ย่อยแยกตาม HN (อยู่ภายใต้โฟลเดอร์รากคลินิก) */
function getPatientFolder(hn) {
  var root = getDriveFolder();
  var it = root.getFoldersByName(String(hn));
  return it.hasNext() ? it.next() : root.createFolder(String(hn));
}
