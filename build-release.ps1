$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'slashslash'
$archive = Join-Path $dist 'slashslash-windows.zip'
$buildingArchive = Join-Path $dist 'slashslash-windows.building.zip'
$checksumFile = Join-Path $dist 'slashslash-windows.zip.sha256'

if (Test-Path -LiteralPath $dist) {
  Remove-Item -LiteralPath $dist -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$trackedRootScripts = & git -C $root ls-files -- '*.js' |
  Where-Object { $_ -notmatch '[\\/]' }
foreach ($name in $trackedRootScripts) {
  Copy-Item -LiteralPath (Join-Path $root $name) -Destination $stage
}
foreach ($name in @('package.json', 'README.md', 'relay-config.json', 'launch-wordfx.cmd', 'wordfx-icon.ico', 'wordfx-icon.png')) {
  $source = Join-Path $root $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $stage }
}
foreach ($name in @('sound-player.ps1', 'sound', 'tools')) {
  $source = Join-Path $root $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $stage -Recurse }
}

$packageManifest = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
$managedFiles = @(
  Get-ChildItem -LiteralPath $stage -Recurse -File |
    ForEach-Object { $_.FullName.Substring($stage.Length + 1).Replace('\', '/') } |
    Sort-Object
)
$releaseManifest = [ordered]@{
  version = $packageManifest.version
  files = $managedFiles
} | ConvertTo-Json -Depth 4
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage '.release-manifest.json'), $releaseManifest, $utf8WithoutBom)

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $buildingArchive -CompressionLevel Optimal

# Fully read the temporary archive before exposing the final filename. This
# catches truncated or unreadable entries and prevents sync/upload software
# from copying a ZIP while Compress-Archive is still writing it.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($buildingArchive)
try {
  $expectedFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File).Count
  $entries = @($zip.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
  if ($entries.Count -ne $expectedFiles) {
    throw "Release verification failed: expected $expectedFiles files, found $($entries.Count) ZIP entries."
  }
  $buffer = New-Object byte[] 65536
  foreach ($entry in $entries) {
    $stream = $entry.Open()
    try {
      while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) {}
    } finally {
      $stream.Dispose()
    }
  }
} finally {
  $zip.Dispose()
}

Move-Item -LiteralPath $buildingArchive -Destination $archive
$checksum = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumFile -Value "$checksum  slashslash-windows.zip" -Encoding Ascii
Write-Host "Clean release created: $archive"
Write-Host "SHA-256: $checksum"
Write-Host 'Personal saves and credentials were not included; each copy creates its own data folder.'
