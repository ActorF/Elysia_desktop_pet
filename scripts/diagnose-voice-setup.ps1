param(
    [string]$ProfilePath = (Join-Path $env:APPDATA 'Elysia Desktop Pet'),
    [string]$OutputPath,
    [ValidateLength(1, 64)]
    [ValidatePattern('\A(?:unknown|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\z')]
    [string]$AppVersion = 'unknown'
)

# Windows PowerShell 5.1. Read metadata and the small completion marker only.
# Never run Python, download, hash model contents, repair, move or remove resources.
# Snapshot from electron/voice-bootstrap-manifest.json for reference app 1.4.4.
# AppVersion is user supplied; the reference is not a detected installed version.
$ErrorActionPreference = 'Stop'
$profileRoot = [IO.Path]::GetFullPath($ProfilePath)
$project = [IO.Path]::GetFullPath((Join-Path $profileRoot 'voice-runtime'))
$basicFiles = @('config/settings.py', 'python/python.exe', 'python/python314.zip',
    'voice/managed_gpt_sovits.py', 'scripts/gpt_sovits_worker.py',
    'workspace/settings/voice-profiles.json', 'models/cache/GPT-SoVITS-v2-240821/runtime/python.exe')
$expected = [ordered]@{
    version = 1
    assetsHash = '412dba6ffcc399fd48b80f540f9c2d7a3e90e76cea3af026e09c9da931a11f2e'
    runtimeHash = '9d9ba79de6aca0cf28a3635ccb1dbbb08b6aef362c4352e32fad99bb49e3000a'
}
$report = [ordered]@{
    diagnosticVersion = 2
    utcTime = [DateTime]::UtcNow.ToString('o')
    appVersion = $AppVersion
    appVersionSource = 'user-supplied-or-unknown'
    referenceAppVersion = '1.4.4'
    expectedManifest = $expected
    location = 'Elysia Desktop Pet/voice-runtime'
    profileStatus = 'unknown'
    directoryStatus = 'unknown'
    markerStatus = 'not-checked'
    markerIssues = @()
    markerVersion = $null
    markerVersionMatchesExpected = $null
    assetsHash = $null
    assetsHashMatchesExpected = $null
    runtimeHash = $null
    runtimeHashMatchesExpected = $null
    markerMatchesExpected = $null
    requiredListStatus = 'not-checked'
    requiredCount = 0
    invalidEntries = 0
    missingBasicEntries = @()
    filesChecked = 0
    fileProblems = @()
    downloadCacheStatus = 'not-checked'
    downloadedArchiveCount = 0
    partialDownloadCount = 0
    notes = @('Only metadata and the completion marker are read. Model contents are not read or hashed.',
              'Chat history, usernames, absolute paths and credentials are not collected.',
              'No environment files are changed. Only this diagnostic report is written.',
              'Reference comparisons are observations; they do not prove an upgrade caused the failure.')
}

function Get-SafeItem([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
}

function Test-RelativeResourcePath($Relative) {
    if ($Relative -isnot [string] -or [string]::IsNullOrWhiteSpace($Relative) -or $Relative.Length -gt 240 -or
        $Relative -match '[\x00-\x1f\x7f:?*<>|"#]' -or $Relative -match '^[\\/]') { return $false }
    # Validate EVERY segment before any filesystem access for this entry.
    foreach ($segment in ($Relative -split '[\\/]')) {
        if (-not $segment -or $segment -in @('.', '..') -or $segment -match '[. ]$' -or
            $segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { return $false }
    }
    return $true
}

function Test-ResourcePath([string]$Relative) {
    if (-not (Test-RelativeResourcePath $Relative)) { return 'invalid-entry' }
    $segments = $Relative -split '[\\/]'
    $cursor = $project
    for ($index = 0; $index -lt $segments.Length; $index++) {
        $cursor = Join-Path $cursor $segments[$index]
        try { $item = Get-SafeItem $cursor } catch { return 'unreadable' }
        if ($null -eq $item) { return 'missing' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'linked-path' }
        if ($index -lt $segments.Length - 1 -and -not $item.PSIsContainer) { return 'wrong-type' }
        if ($index -eq $segments.Length - 1 -and $item.PSIsContainer) { return 'wrong-type' }
    }
    return 'present'
}

function Test-MarkerVersion($Value) {
    return (($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and
        $Value -ge 1 -and $Value -le 9007199254740991 -and [Math]::Floor([double]$Value) -eq [double]$Value)
}

try {
    $profile = Get-SafeItem $profileRoot
    if ($null -eq $profile) { $report.profileStatus = 'missing'; $report.directoryStatus = 'missing' }
    elseif (($profile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $report.profileStatus = 'linked-directory'; $report.directoryStatus = 'not-checked'
    }
    elseif (-not $profile.PSIsContainer) { $report.profileStatus = 'not-a-directory'; $report.directoryStatus = 'not-checked' }
    else {
        $report.profileStatus = 'present'
        $directory = Get-SafeItem $project
        if ($null -eq $directory) { $report.directoryStatus = 'missing' }
        elseif (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $report.directoryStatus = 'linked-directory' }
        elseif (-not $directory.PSIsContainer) { $report.directoryStatus = 'not-a-directory' }
        else {
            $report.directoryStatus = 'present'
            $required = @($basicFiles)
            $markerPath = Join-Path $project 'voice-setup-complete.json'
            $report.markerStatus = Test-ResourcePath 'voice-setup-complete.json'
            if ($report.markerStatus -eq 'present') {
                $markerLength = (Get-Item -LiteralPath $markerPath -Force).Length
                if ($markerLength -gt 65536) { $report.markerStatus = 'too-large' }
                elseif ($markerLength -le 0) { $report.markerStatus = 'empty' }
                else {
                    try {
                        $markerSource = [IO.File]::ReadAllText($markerPath)
                        # PowerShell 5.1 enumerates a top-level single-item JSON array.
                        # Check the root token so an array cannot become a trusted object.
                        if (-not $markerSource.TrimStart().StartsWith('{')) { $report.markerStatus = 'invalid-object' }
                        else { $marker = $markerSource | ConvertFrom-Json }
                    }
                    catch { $report.markerStatus = 'invalid-or-unreadable-json' }
                    if ($report.markerStatus -eq 'present') {
                        if ($marker -isnot [pscustomobject]) { $report.markerStatus = 'invalid-object' }
                        else {
                            $report.markerStatus = 'parsed'
                            $report.markerVersionMatchesExpected = $false
                            $report.assetsHashMatchesExpected = $false
                            $report.runtimeHashMatchesExpected = $false
                            if (Test-MarkerVersion $marker.version) {
                                $report.markerVersion = [long]$marker.version
                                $report.markerVersionMatchesExpected = $marker.version -eq $expected.version
                                if (-not $report.markerVersionMatchesExpected) { $report.markerIssues += 'marker-version-mismatch' }
                            } else { $report.markerIssues += 'invalid-marker-version' }
                            foreach ($pair in @(@('assets', 'assetsHash', 'assetsHashMatchesExpected'), @('runtime', 'runtimeHash', 'runtimeHashMatchesExpected'))) {
                                $value = $marker.($pair[0])
                                if ($value -is [string] -and $value -match '\A[a-fA-F0-9]{64}\z') {
                                    $report[$pair[1]] = $value.ToLowerInvariant()
                                    $report[$pair[2]] = $report[$pair[1]] -eq $expected[$pair[1]]
                                    if (-not $report[$pair[2]]) { $report.markerIssues += ($pair[0] + '-hash-mismatch') }
                                } else { $report.markerIssues += ('invalid-' + $pair[0] + '-hash') }
                            }
                            if ($marker.required -isnot [Array]) { $report.requiredListStatus = 'not-an-array' }
                            else {
                                $report.requiredCount = $marker.required.Count
                                if ($marker.required.Count -gt 200) { $report.requiredListStatus = 'too-many-entries' }
                                else {
                                    # Validate the entire list before doing IO on any marker-supplied path.
                                    $validEntries = @()
                                    foreach ($relative in $marker.required) {
                                        if (Test-RelativeResourcePath $relative) { $validEntries += $relative.Replace('\', '/') }
                                        else { $report.invalidEntries++ }
                                    }
                                    $report.missingBasicEntries = @($basicFiles | Where-Object { $_ -notin $validEntries })
                                    if ($report.invalidEntries -gt 0) { $report.requiredListStatus = 'invalid-entries' }
                                    elseif ($marker.required.Count -lt $basicFiles.Count) { $report.requiredListStatus = 'too-few-entries' }
                                    elseif ($report.missingBasicEntries.Count -gt 0) { $report.requiredListStatus = 'missing-basic-entries' }
                                    else { $report.requiredListStatus = 'valid'; $required += $validEntries }
                                }
                            }
                            if ($report.requiredListStatus -ne 'valid') { $report.markerIssues += 'invalid-required-list' }
                            if ($report.missingBasicEntries.Count -gt 0) { $report.markerIssues += 'missing-basic-entries' }
                            $report.markerMatchesExpected = $report.markerVersionMatchesExpected -and $report.assetsHashMatchesExpected -and
                                $report.runtimeHashMatchesExpected -and $report.requiredListStatus -eq 'valid'
                        }
                    }
                }
            }
            $seen = @{}
            foreach ($relative in $required) {
                if ($seen.ContainsKey($relative)) { continue }; $seen[$relative] = $true
                $report.filesChecked++
                $status = Test-ResourcePath $relative
                if ($status -ne 'present') { $report.fileProblems += [ordered]@{ relativePath = $relative; status = $status } }
            }
        }
    }
} catch {
    $report.directoryStatus = 'unreadable'
    $report.notes += 'Directory metadata could not be read.'
}

try {
    if ($report.profileStatus -eq 'present') {
        $cache = Get-SafeItem (Join-Path $profileRoot 'voice-downloads')
        if ($null -eq $cache) { $report.downloadCacheStatus = 'missing' }
        elseif (($cache.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $report.downloadCacheStatus = 'linked-directory' }
        elseif (-not $cache.PSIsContainer) { $report.downloadCacheStatus = 'not-a-directory' }
        else {
            $report.downloadCacheStatus = 'present'
            foreach ($entry in (Get-ChildItem -LiteralPath $cache.FullName -Force -File)) {
                if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                if ($entry.Name -match '\.(zip|7z)$') { $report.downloadedArchiveCount++ }
                if ($entry.Name -match '\.part$') { $report.partialDownloadCount++ }
            }
        }
    }
} catch { $report.downloadCacheStatus = 'unreadable'; $report.notes += 'Download cache metadata could not be read.' }

if (-not $OutputPath) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { $desktop = [IO.Path]::GetTempPath() }
    $OutputPath = Join-Path $desktop ('Elysia-voice-diagnostic-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$json = $report | ConvertTo-Json -Depth 5
$bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
Write-Output ('Report saved: ' + [IO.Path]::GetFileName($OutputPath))
Write-Output 'Send this JSON report to the developer. No repair or download was performed.'
