# chiispace 를 소스·빌드 도구가 없는 PC 에 깔고 새 판으로 맞춘다.
# 노트북의 deploy.mjs 가 배포할 때마다 올리는 GitHub 릴리스(releases/latest)를 받는다.
# 받은 파일은 같이 올라온 SHA256SUMS.txt 와 대조한 뒤에만 바꾼다.
#
#   처음 깔기  powershell -ExecutionPolicy Bypass -File chiispace-update.ps1 -Install
#              (C:\chiispace 에 받고, 바탕화면·시작 메뉴 바로가기를 이 스크립트 -Launch 로 건다)
#   바로가기   ... -Launch   새 판이 있으면 받고 켠다. 떠 있으면 받아만 두고(다음 실행부터) 그 창을 앞으로
#   손으로     ... (인자 없음) 받기만
param([switch]$Install, [switch]$Launch, [string]$Dir = 'C:\chiispace')
$ErrorActionPreference = 'Stop'
# PS 5.1 의 진행 막대는 내려받기를 몇 배 느리게 만든다
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'sehyun04/chiispace'
$files = 'chiispace.exe', 'chiispace-cli.exe', 'chiispace-update.ps1'
$app = Join-Path $Dir 'chiispace.exe'
$log = Join-Path $Dir 'update.log'

function Say($m) {
    Write-Host $m
    # 바로가기는 창 없이 돌아서 무슨 일이 있었는지는 여기에만 남는다
    try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -Encoding UTF8 } catch {}
}
function Running { [bool](Get-Process -Name chiispace, chiispace-cli -ErrorAction SilentlyContinue) }

function Update {
    # 검증은 CHIISPACE_UPDATE_FEED 로 가짜 릴리스 정보를 준다(진짜 GitHub 을 건드리지 않게)
    $feed = $env:CHIISPACE_UPDATE_FEED
    if (-not $feed) { $feed = "https://api.github.com/repos/$repo/releases/latest" }
    $rel = Invoke-RestMethod $feed -Headers @{ 'User-Agent' = 'chiispace-update' }
    $tag = $rel.tag_name
    $have = ''
    if (Test-Path "$Dir\VERSION") { $have = (Get-Content "$Dir\VERSION" -Raw).Trim() }
    if ($tag -eq $have -and (Test-Path $app)) { return $false }

    $url = @{}
    foreach ($a in $rel.assets) { $url[$a.name] = $a.browser_download_url }
    if (-not $url['SHA256SUMS.txt']) { throw "$tag 에 SHA256SUMS.txt 가 없다" }
    $tmp = Join-Path $Dir '.incoming'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force $tmp | Out-Null
    Invoke-WebRequest -UseBasicParsing $url['SHA256SUMS.txt'] -OutFile "$tmp\SHA256SUMS.txt"
    $sums = @{}
    foreach ($line in Get-Content "$tmp\SHA256SUMS.txt") {
        if ($line -match '^([0-9A-Fa-f]{64}) \*?(.+)$') { $sums[$Matches[2].Trim()] = $Matches[1].ToUpper() }
    }
    if (-not $sums['chiispace.exe']) { throw "$tag 의 SHA256SUMS.txt 에 chiispace.exe 가 없다" }
    foreach ($f in $files) {
        if (-not $sums[$f] -or -not $url[$f]) { continue }
        Invoke-WebRequest -UseBasicParsing $url[$f] -OutFile "$tmp\$f"
        if ((Get-FileHash "$tmp\$f").Hash -ne $sums[$f]) { throw "$f 해시가 SHA256SUMS.txt 와 다르다" }
    }

    $when = Get-Date -Format yyyyMMdd-HHmmss
    foreach ($f in $files) {
        if (-not (Test-Path "$tmp\$f")) { continue }
        $to = Join-Path $Dir $f
        # 떠 있는 exe 는 지울 수 없어도 이름은 바꿀 수 있다. 새 판은 다음 실행부터 쓰인다
        if (Test-Path $to) { Rename-Item $to "$f.old-$when" }
        Move-Item "$tmp\$f" $to
    }
    Set-Content -Path "$Dir\VERSION" -Value $tag -Encoding Ascii
    Remove-Item -Recurse -Force $tmp
    Say "받았다: $have -> $tag"
    return $true
}

New-Item -ItemType Directory -Force $Dir | Out-Null
# 지난번에 옮겨 둔 옛 판. 아직 떠 있는 것은 잠겨 있어 지워지지 않으니 그냥 둔다
Get-ChildItem $Dir -Filter '*.old-*' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item $_.FullName -Force } catch {} }

if ($Install) {
    $wv = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    if (-not ((Test-Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv") -or (Test-Path "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv"))) {
        Say '화면을 그리는 WebView2 가 없어 깐다'
        winget install --id Microsoft.EdgeWebView2Runtime -e --accept-package-agreements --accept-source-agreements
    }
}

try {
    Update | Out-Null
} catch {
    # 오프라인이어도 있던 판으로는 켜져야 한다. 처음 깔 때만 멈춘다
    Say "새 판 확인 실패: $($_.Exception.Message)"
    if ($Install -or -not (Test-Path $app)) { throw }
}

if ($Install) {
    $me = Join-Path $Dir 'chiispace-update.ps1'
    $sys32 = "$env:SystemRoot\System32"
    $shell = New-Object -ComObject WScript.Shell
    foreach ($place in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
        $lnk = $shell.CreateShortcut((Join-Path $place 'chiispace.lnk'))
        # conhost --headless 로 감싸야 확인하는 동안 검은 창이 번쩍이지 않는다
        $lnk.TargetPath = "$sys32\conhost.exe"
        $lnk.Arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$me`" -Launch"
        $lnk.WorkingDirectory = $Dir
        $lnk.IconLocation = "$app,0"
        $lnk.Save()
        Say "바로가기: $place\chiispace.lnk"
    }
}

if ($Launch -or $Install) {
    $up = Get-Process -Name chiispace -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($up) {
        # 둘째 인스턴스를 띄우면 초기화가 서로 부딪힌다. 떠 있는 창을 앞으로만 꺼낸다
        (New-Object -ComObject WScript.Shell).AppActivate($up.Id) | Out-Null
    } else {
        Start-Process $app -WorkingDirectory $Dir
    }
}
