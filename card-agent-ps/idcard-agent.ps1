# ============================================================
#  idcard-agent.ps1 — อ่านบัตรประชาชนไทยจากเครื่องอ่านสมาร์ทการ์ด
#  ใช้ PowerShell + .NET (winscard.dll) ที่มากับ Windows — ไม่ต้องลง Node/compiler
#
#  รัน:  คลิกขวาไฟล์ START-อ่านบัตร.bat > Run
#        หรือ  powershell -ExecutionPolicy Bypass -File idcard-agent.ps1
#
#  เว็บแอปเรียก:  http://localhost:8765/read
# ============================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- C# helper: เรียก WinSCard อ่านบัตร ----------
$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ThaiID {
    [DllImport("winscard.dll")] static extern int SCardEstablishContext(uint s, IntPtr a, IntPtr b, out IntPtr ctx);
    [DllImport("winscard.dll")] static extern int SCardReleaseContext(IntPtr ctx);
    [DllImport("winscard.dll", CharSet=CharSet.Ansi)] static extern int SCardListReadersA(IntPtr ctx, byte[] groups, byte[] readers, ref uint len);
    [DllImport("winscard.dll", CharSet=CharSet.Ansi)] static extern int SCardConnectA(IntPtr ctx, string reader, uint share, uint proto, out IntPtr card, out uint active);
    [DllImport("winscard.dll")] static extern int SCardDisconnect(IntPtr card, uint disp);
    [DllImport("winscard.dll")] static extern int SCardTransmit(IntPtr card, ref IO_REQ send, byte[] sbuf, uint slen, IntPtr rpci, byte[] rbuf, ref uint rlen);

    [StructLayout(LayoutKind.Sequential)] public struct IO_REQ { public uint proto; public uint len; }

    const uint SCOPE_USER=0, SHARE_SHARED=2, T0=1, T1=2, LEAVE=0;

    static byte[] SELECT = { 0x00,0xA4,0x04,0x00,0x08,0xA0,0x00,0x00,0x00,0x54,0x48,0x00,0x01 };

    static byte[] Tx(IntPtr card, uint proto, byte[] apdu){
        IO_REQ io = new IO_REQ(); io.proto = proto; io.len = (uint)Marshal.SizeOf(typeof(IO_REQ));
        byte[] r = new byte[512]; uint rl = (uint)r.Length;
        int rv = SCardTransmit(card, ref io, apdu, (uint)apdu.Length, IntPtr.Zero, r, ref rl);
        if(rv != 0) throw new Exception("SCardTransmit error 0x" + rv.ToString("X"));
        byte[] o = new byte[rl]; Array.Copy(r, o, (int)rl); return o;
    }
    // ส่งคำสั่งอ่าน + GET RESPONSE, คืนข้อมูล (ตัด SW1 SW2)
    static byte[] Field(IntPtr card, uint proto, byte[] cmd){
        Tx(card, proto, cmd);
        byte le = cmd[cmd.Length-1];
        byte[] getr = { 0x00,0xC0,0x00,0x00, le };
        byte[] res = Tx(card, proto, getr);
        int n = res.Length >= 2 ? res.Length-2 : res.Length;
        byte[] d = new byte[n]; Array.Copy(res, d, n); return d;
    }
    static string TIS(byte[] b){ return Encoding.GetEncoding(874).GetString(b).Trim(new char[]{' ','\0'}); }

    public static Dictionary<string,string> Read(){
        var outp = new Dictionary<string,string>();
        IntPtr ctx;
        if(SCardEstablishContext(SCOPE_USER, IntPtr.Zero, IntPtr.Zero, out ctx)!=0) throw new Exception("เปิดบริการสมาร์ทการ์ดไม่ได้");
        try{
            uint len = 4096; byte[] rb = new byte[len];
            if(SCardListReadersA(ctx, null, rb, ref len)!=0) throw new Exception("ไม่พบเครื่องอ่านบัตร");
            string reader = Encoding.ASCII.GetString(rb, 0, (int)len).Split('\0')[0];
            if(string.IsNullOrEmpty(reader)) throw new Exception("ไม่พบเครื่องอ่านบัตร");
            IntPtr card; uint proto;
            if(SCardConnectA(ctx, reader, SHARE_SHARED, T0|T1, out card, out proto)!=0) throw new Exception("ยังไม่ได้เสียบบัตร");
            try{
                Tx(card, proto, SELECT);
                outp["cid"]     = TIS(Field(card, proto, new byte[]{0x80,0xb0,0x00,0x04,0x02,0x00,0x0d}));
                outp["nameT"]   = TIS(Field(card, proto, new byte[]{0x80,0xb0,0x00,0x11,0x02,0x00,0x64}));
                outp["birth"]   = TIS(Field(card, proto, new byte[]{0x80,0xb0,0x00,0xD9,0x02,0x00,0x08}));
                outp["gender"]  = TIS(Field(card, proto, new byte[]{0x80,0xb0,0x00,0xE1,0x02,0x00,0x01}));
                outp["address"] = TIS(Field(card, proto, new byte[]{0x80,0xb0,0x15,0x79,0x02,0x00,0x64}));
                // รูปถ่าย 20 บล็อก
                var photo = new List<byte>();
                for(int i=0;i<20;i++){
                    int p = 0x017B + i*0xFF;
                    byte[] cmd = { 0x80,0xb0,(byte)((p>>8)&0xFF),(byte)(p&0xFF),0x02,0x00,0xFF };
                    photo.AddRange(Field(card, proto, cmd));
                }
                outp["photo"] = Convert.ToBase64String(photo.ToArray());
                reader.ToString();
            } finally { SCardDisconnect(card, LEAVE); }
        } finally { SCardReleaseContext(ctx); }
        return outp;
    }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

# ---------- แปลงข้อมูลดิบเป็นรูปแบบที่เว็บใช้ ----------
function Convert-Card($raw){
    $name = ($raw['nameT'] -replace '#',' ') -replace '\s+',' '
    $parts = $raw['nameT'].Split('#')  | Where-Object { $_ -ne '' }
    $prefix = ''; $first=''; $last=''
    if($parts.Count -ge 1){ $prefix = $parts[0] }
    if($parts.Count -ge 2){ $first  = $parts[1] }
    if($parts.Count -ge 3){ $last   = $parts[$parts.Count-1] }
    $bd = $raw['birth']    # YYYYMMDD (พ.ศ.)
    $iso = ''
    if($bd.Length -ge 8){ $y=[int]$bd.Substring(0,4)-543; $iso = ('{0:D4}-{1}-{2}' -f $y, $bd.Substring(4,2), $bd.Substring(6,2)) }
    $addr = ($raw['address'] -replace '#',' ') -replace '\s+',' '
    return [ordered]@{
        status='success'; cid=$raw['cid']; prefix=$prefix; firstName=$first; lastName=$last;
        gender=$raw['gender']; birthDate=$iso; address=$addr.Trim(); photoBase64=$raw['photo']
    }
}

# ---------- HTTP server ----------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:8765/')
$listener.Start()
Write-Host '==================================================='
Write-Host ' idcard-agent (PowerShell) ready at http://localhost:8765'
Write-Host ' * Keep this window open while using *'
Write-Host '==================================================='

while($listener.IsListening){
    # กัน agent ดับทั้งตัวเมื่อเจอ error รายคำขอ — จับทุก error แล้วรับคำขอต่อไป
    try {
        $ctx = $listener.GetContext()
    } catch { continue }
    try {
        $res = $ctx.Response
        $res.Headers.Add('Access-Control-Allow-Origin','*')
        $res.ContentType = 'application/json; charset=utf-8'
        $json = ''
        if($ctx.Request.Url.AbsolutePath -like '/read*'){
            try {
                $raw = [ThaiID]::Read()
                $json = (Convert-Card $raw) | ConvertTo-Json -Compress
                Write-Host ("Read OK: " + $raw['cid'])
            } catch {
                $json = @{ status='error'; message=$_.Exception.Message } | ConvertTo-Json -Compress
                Write-Host ("Read FAILED: " + $_.Exception.Message)
            }
        } else {
            $json = @{ status='ok'; message='idcard-agent running - call /read' } | ConvertTo-Json -Compress
        }
        $buf = [System.Text.Encoding]::UTF8.GetBytes($json)
        $res.OutputStream.Write($buf, 0, $buf.Length)
        $res.Close()
    } catch {
        Write-Host ("Request error (ignored): " + $_.Exception.Message)
    }
}
