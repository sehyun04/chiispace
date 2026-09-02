# 앱을 띄우고 창 하나만 캡처한 뒤 거둔다.
#
# 주의할 점 둘 — 둘 다 실제로 밟았다:
#   1. 디버그 빌드는 콘솔 서브시스템이라 창을 **둘** 만든다(앱 창 + exe 경로가
#      제목인 콘솔 창). Process.MainWindowHandle 은 콘솔 쪽을 집을 수 있으므로
#      제목으로 골라야 한다.
#   2. EnumWindows 콜백을 인라인 람다로 넘기면 열거 도중 GC 되어 결과가 0개로
#      나온다. 델리게이트를 static 에 붙들어 둔다.
#
# 포커스는 절대 건드리지 않는다(SWP_NOACTIVATE). 앱을 활성화하면 사용자가
# 그때 치던 글자가 이 창으로 들어간다.
param(
  [string]$Exe = "$PSScriptRoot\..\src-tauri\target\debug\kasaspace.exe",
  [string]$Title = "kasaspace",
  [string]$Out = "$env:TEMP\kasaspace-shot.png",
  [int]$WaitSec = 10
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public struct RECT { public int L,T,R,B; }
public class Shot {
  public delegate bool Proc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Proc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x,int y,int cx,int cy, uint f);
  // PW_RENDERFULLCONTENT(2). 창이 다른 창에 가려 있어도 그 창 자신의 내용을 받는다 —
  // 화면 복사(CopyFromScreen)는 위에 덮인 창을 찍어 온다.
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  // 이걸 안 부르면 GetWindowRect 가 **가상화된** 좌표를 준다. 125% 배율에서는
  // 창의 80% 만 잘라 찍고는 "레이아웃이 깨졌다"고 오진하게 된다 — 실제로 했다.
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  static Proc keep;
  public static IntPtr Find(int pid, string title) {
    IntPtr found = IntPtr.Zero;
    keep = (h,p) => {
      int wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    };
    EnumWindows(keep, IntPtr.Zero);
    return found;
  }
}
"@

[void][Shot]::SetProcessDPIAware()

$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $WaitSec
$h = [Shot]::Find($p.Id, $Title)
if ($h -eq [IntPtr]::Zero) {
  Write-Output "창을 못 찾았다: '$Title'"
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  exit 1
}

$r = New-Object RECT
[void][Shot]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Shot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$mid = $bmp.GetPixel([int]($w/2), [int]($ht/2))
$bmp.Dispose()

# 창 닫기를 먼저 청한다. 곧바로 죽이면 PTY 가 한꺼번에 무너지며 그 부고가 웹뷰에
# 닿아 배치가 지워지고, 그 빈 배치가 세션 파일에 저장된다 — 사용자가 쓰던 칸들이
# 검증 한 번에 날아간다. 실제로 그렇게 잃었다.
$p.CloseMainWindow() | Out-Null
for ($i = 0; $i -lt 30 -and -not $p.HasExited; $i++) { Start-Sleep -Milliseconds 100 }
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
Write-Output "저장: $Out (${w}x${ht}) PrintWindow=$ok 중앙픽셀=$mid"
