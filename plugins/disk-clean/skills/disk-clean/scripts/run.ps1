$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  'X64' { $asset = 'disk-clean-windows-x86_64.zip' }
  'Arm64' { $asset = 'disk-clean-windows-arm64.zip' }
  default { $asset = '' }
}

$data = ''
$rest = @()
if ($args.Count -gt 0) {
  $data = [string]$args[0]
  $rest = @($args | Select-Object -Skip 1)
}
if ($data -eq '' -or $data.Contains('${')) {
  $data = Join-Path $HOME '.cache\disk-clean'
}
$data = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($data)

function Write-Stderr([string]$Message) {
  [Console]::Error.WriteLine($Message)
}

function Invoke-Binary([string]$Path) {
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  } catch {
    $null = $_
  }
  & $Path @rest
  exit $LASTEXITCODE
}

$manifest = Join-Path $pluginRoot '.claude-plugin\plugin.json'
$version = ''
$line = Select-String -LiteralPath $manifest -Pattern '^\s*"version"\s*:\s*"([^"]*)"' -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($line) {
  $version = $line.Matches[0].Groups[1].Value
}
if ($version -notmatch '^[0-9A-Za-z.+-]+$') {
  Write-Stderr "disk-clean: could not read a valid version from $manifest"
  exit 1
}

$bin = Join-Path $data "bin\disk-clean-$version.exe"
if (Test-Path -LiteralPath $bin -PathType Leaf) {
  Invoke-Binary $bin
}

$null = New-Item -ItemType Directory -Force -Path (Join-Path $data 'bin')
$tmp = Join-Path $data ("bin\.install." + [System.IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $tmp
$ready = Join-Path $tmp 'ready'

function Save-Url([string]$Url, [string]$OutFile) {
  for ($try = 0; $try -lt 3; $try++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
      return $true
    } catch {
      $null = $_
    }
  }
  return $false
}

$releases = 'https://github.com/omridevk/mopper/releases'

function Stop-Install([string]$Message) {
  Write-Stderr "disk-clean: $Message"
  Write-Stderr '  Release binaries exist for macOS (arm64 and x86_64), Linux (x86_64 and arm64) and Windows (x86_64 and arm64):'
  Write-Stderr "  $releases"
  exit 1
}

try {
  if ($asset -eq '') {
    Stop-Install "no release binary for Windows/$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)."
  }
  $url = "$releases/download/disk-clean--v$version/$asset"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
    [Net.SecurityProtocolType]::Tls12
  Write-Stderr "disk-clean: downloading release v$version..."
  $zip = Join-Path $tmp $asset
  if (-not (Save-Url $url $zip) -or -not (Save-Url "$url.sha256" "$zip.sha256")) {
    Stop-Install "could not download $asset for v$version (no published release for this version, or no network)."
  }
  $fields = @(([System.IO.File]::ReadAllText("$zip.sha256").Trim()) -split '\s+')
  if ($fields.Count -ne 2 -or $fields[1] -cne $asset -or
    $fields[0] -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash) {
    Write-Stderr "disk-clean: checksum mismatch on the downloaded v$version release, refusing to run it"
    exit 1
  }
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'unzip')
    Move-Item -LiteralPath (Join-Path $tmp 'unzip\disk-clean.exe') -Destination $ready
  } catch {
    Stop-Install "could not unpack $asset for v$version."
  }
  try {
    [System.IO.File]::Move($ready, $bin)
  } catch {
    if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) { throw }
  }
} finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
Invoke-Binary $bin
