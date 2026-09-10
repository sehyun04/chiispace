param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [ValidateSet('x64', 'x86', 'arm64')][string]$Architecture = 'x64'
)
$ErrorActionPreference = 'Stop'
$version = '1.24.260710001'
$packageHash = '175640566A3B59C4B132070EE96C2C77E5AB7EDD2E92732A5EB3610BBF63D90E'
$cache = Join-Path $PSScriptRoot "../src-tauri/target/conpty/$version"
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$archive = Join-Path $cache 'package.zip'
if (-not (Test-Path -LiteralPath $archive)) {
  $download = Join-Path $cache ("download-" + [guid]::NewGuid().ToString('N') + '.zip')
  Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$version/microsoft.windows.console.conpty.$version.nupkg" -OutFile $download
  if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $packageHash) {
    throw 'ConPTY package checksum mismatch'
  }
  Move-Item -LiteralPath $download -Destination $archive -Force
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $packageHash) {
  throw 'ConPTY cache checksum mismatch'
}
# OUT_DIR는 타깃·프로필마다 달라서 다른 빌드가 쓰는 런타임 파일을 덮지 않는다.
$output = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $output -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $files = @{
    'conpty.dll' = "runtimes/win-$Architecture/native/conpty.dll"
    'OpenConsole.exe' = "build/native/runtimes/$Architecture/OpenConsole.exe"
  }
  foreach ($name in $files.Keys) {
    $entry = $zip.GetEntry($files[$name])
    if ($null -eq $entry) { throw "ConPTY package missing $name" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $output $name), $true)
  }
} finally {
  $zip.Dispose()
}
