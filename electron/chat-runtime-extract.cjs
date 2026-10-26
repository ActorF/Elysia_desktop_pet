'use strict';

// Fixed program: archive/staging paths are passed only as environment data.
// Validate every entry before creating files, including Windows path aliases.
const EXTRACT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($env:ELYSIA_CHAT_STAGE).TrimEnd('\') + '\'
if (-not [IO.Directory]::Exists($root)) { throw 'stage' }
$archive = [IO.Compression.ZipFile]::OpenRead($env:ELYSIA_CHAT_ARCHIVE)
try {
  if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt 20000) { throw 'entries' }
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    if ([string]::IsNullOrEmpty($name) -or [IO.Path]::IsPathRooted($name) -or $name.Contains(':')) { throw 'path' }
    foreach ($part in $name.TrimEnd('\').Split('\')) {
      if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') { throw 'path' }
    }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not $names.Add($target.TrimEnd('\'))) { throw 'path' }
    $type = ($entry.ExternalAttributes -shr 16) -band 61440
    if (($type -ne 0 -and $type -ne 32768 -and $type -ne 16384) -or (($entry.ExternalAttributes -band 1024) -ne 0)) { throw 'link' }
    $total += $entry.Length
    if ($entry.Length -lt 0 -or $total -gt 2147483648) { throw 'size' }
  }
  foreach ($entry in $archive.Entries) {
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName.Replace('/', '\')))
    if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) {
      [void][IO.Directory]::CreateDirectory($target)
    } else {
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  }
} finally { $archive.Dispose() }
`;
module.exports = { EXTRACT_SCRIPT };
