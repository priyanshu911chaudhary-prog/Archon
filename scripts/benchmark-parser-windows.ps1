[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('zustand', 'nextjs-subscription-payments', 'taxonomy')]
  [string]$RepoId,

  [Parameter(Mandatory = $true)]
  [string]$RepoDir,

  [Parameter(Mandatory = $true)]
  [string]$BundlePath,

  [Parameter(Mandatory = $true)]
  [string]$RunDir,

  [Parameter(Mandatory = $true)]
  [string]$RunId,

  [switch]$SkipLibFiles,

  [ValidateSet('instrumented', 'public')]
  [string]$RunnerMode = 'instrumented',

  [int]$MaxOldSpaceMb = 256,
  [int]$ParserTimeoutMs = 60000,
  [int]$MaxResponseBytes = 33554432,
  [int]$Repetitions = 1,
  [int]$SampleIntervalMs = 25
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$archonRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scoreScript = Join-Path $archonRoot 'scripts\dist\benchmark-parser-score.js'
$parentScript = Join-Path $archonRoot 'scripts\dist\benchmark-parser-parent.js'
$compiledChild = Join-Path $archonRoot 'apps\worker\dist\parser-child.js'
$compiledRunner = Join-Path $archonRoot 'apps\worker\dist\parser-runner.js'

foreach ($required in @($scoreScript, $parentScript, $compiledChild, $compiledRunner, $RepoDir, $BundlePath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing required prerequisite path: $required (run 'npm run build' first)."
  }
}

# Exclusive run directory creation — never overwrite existing benchmark outputs
if (Test-Path -LiteralPath $RunDir) {
  throw "Run directory already exists (exclusive creation required): $RunDir"
}
New-Item -ItemType Directory -Path $RunDir | Out-Null

function Write-ExclusiveUtf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $fs = [System.IO.File]::Open(
    $FilePath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $bytes = $utf8NoBom.GetBytes($Content)
    $fs.Write($bytes, 0, $bytes.Length)
  } finally {
    $fs.Dispose()
  }
}

function Get-NumericSummary {
  param([double[]]$Values)
  if ($null -eq $Values -or $Values.Count -eq 0) {
    return [ordered]@{ min = $null; median = $null; max = $null }
  }
  $sorted = [double[]]($Values | Sort-Object)
  $mid = [int][Math]::Floor($sorted.Count / 2)
  if (($sorted.Count % 2) -eq 1) {
    $med = $sorted[$mid]
  } else {
    $med = ($sorted[$mid - 1] + $sorted[$mid]) / 2.0
  }
  return [ordered]@{
    min    = [Math]::Round($sorted[0], 2)
    median = [Math]::Round($med, 2)
    max    = [Math]::Round($sorted[$sorted.Count - 1], 2)
  }
}

function Get-NonNegWallClockDeltaMs {
  param(
    [string]$StartIso,
    [string]$EndIso
  )
  if ([string]::IsNullOrWhiteSpace($StartIso) -or [string]::IsNullOrWhiteSpace($EndIso)) {
    return $null
  }
  try {
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $style = [System.Globalization.DateTimeStyles]::RoundtripKind
    $t1 = [DateTimeOffset]::Parse($StartIso, $inv, $style)
    $t2 = [DateTimeOffset]::Parse($EndIso, $inv, $style)
    $delta = ($t2 - $t1).TotalMilliseconds
    if ($delta -lt 0.0) {
      return $null
    }
    return [Math]::Round($delta, 2)
  } catch {
    return $null
  }
}

function Get-OptionalJsonProp {
  param($Obj, [string]$PropName)
  if ($null -eq $Obj) { return $null }
  if ($Obj.PSObject.Properties.Match($PropName).Count -gt 0) {
    return $Obj.$PropName
  }
  return $null
}

$inventoryPath = Join-Path $RunDir 'prepared-inventory.json'
$parentRecordPath = Join-Path $RunDir 'parent-run-record.json'
$monitorPath = Join-Path $RunDir 'windows-monitor.json'
$lifecycleEventsFileName = 'windows-lifecycle-events.json'
$samplesFileName = 'windows-samples.ndjson'
$lifecycleEventsPath = Join-Path $RunDir $lifecycleEventsFileName
$samplesPath = Join-Path $RunDir $samplesFileName
$scoredPath = Join-Path $RunDir 'scored-run.json'

# === STAGE A: Authoritative snapshot verification (outside measured parent) ===
Write-Host "[Stage A] Preparing verified inventory for $RepoId..." -ForegroundColor Cyan
& node $scoreScript prepare `
  --repo $RepoId `
  --repo-dir $RepoDir `
  --bundle $BundlePath `
  --out $inventoryPath
if ($LASTEXITCODE -ne 0) {
  throw "Stage A prepare failed with exit code $LASTEXITCODE."
}

# === STAGE B: Measured lightweight parent + external Windows .NET OS monitor ===
$parentArgs = New-Object System.Collections.Generic.List[string]
$parentArgs.Add($parentScript)
$parentArgs.Add('--inventory');          $parentArgs.Add($inventoryPath)
$parentArgs.Add('--out-record');         $parentArgs.Add($parentRecordPath)
$parentArgs.Add('--out-dir');            $parentArgs.Add($RunDir)
$parentArgs.Add('--mode');               $parentArgs.Add($RunnerMode)
$parentArgs.Add('--repetitions');        $parentArgs.Add([string]$Repetitions)
$parentArgs.Add('--max-old-space-mb');   $parentArgs.Add([string]$MaxOldSpaceMb)
$parentArgs.Add('--timeout-ms');         $parentArgs.Add([string]$ParserTimeoutMs)
$parentArgs.Add('--max-response-bytes'); $parentArgs.Add([string]$MaxResponseBytes)
if ($SkipLibFiles.IsPresent) {
  $parentArgs.Add('--skip-lib-files')
}

$quotedArgs = ($parentArgs | ForEach-Object {
  if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
}) -join ' '

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Get-Command node).Source
$psi.Arguments = $quotedArgs
$psi.WorkingDirectory = $archonRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$windowStartUtc = [DateTime]::UtcNow.ToString('o')
$loopSw = [System.Diagnostics.Stopwatch]::StartNew()
$supervisorDeadlineMs = ($ParserTimeoutMs * $Repetitions) + 30000

$parentProc = New-Object System.Diagnostics.Process
$parentProc.StartInfo = $psi

$monitorStatus = 'completed'
$failureDetails = $null
$currentPhase = 'startup'
$parentPid = 0
$parentStartTimeUtc = $null
$parentExitCode = $null

$childIdentities = New-Object System.Collections.Generic.List[object]
$quarantinedOwned = New-Object System.Collections.Generic.List[object]
$lifecycleAuditEvents = New-Object System.Collections.Generic.List[object]
$rawSampleLines = New-Object System.Collections.Generic.List[string]

$activeChildEntry = $null
$activeChildProc = $null

$totalSamples = 0
$startupSamples = 0
$parserSamples = 0
$persistSamples = 0
$finalWriteSamples = 0
$validChildSamples = 0
$pairedParserWindowSamples = 0
$observedGapCount = 0
$missingCounterCount = 0
$counterReadFailureCount = 0

$actualIntervals = New-Object System.Collections.Generic.List[double]
$tickDurations = New-Object System.Collections.Generic.List[double]
$maxParentChildSkewMs = $null
$lastTickStartMs = $null

# Window B (parser execution) peaks
$bParentPeakWs = $null
$bParentPeakPriv = $null
$bChildPeakWs = $null
$bChildOsPeakWs = $null
$bChildPeakPriv = $null
$bMaxCombinedWs = $null
$bMaxCombinedPriv = $null

# Full parent lifetime peaks (Windows A + B + C + D)
$fullParentPeakWs = $null
$fullParentOsPeakWs = $null
$fullParentPeakPriv = $null

$eventPrefix = 'ARCHON_BENCH_EVENT:'

try {
  $started = $parentProc.Start()
  if (-not $started) {
    throw 'Failed to start measured benchmark parent process.'
  }
  $parentPid = $parentProc.Id
  try {
    $parentStartTimeUtc = $parentProc.StartTime.ToUniversalTime().ToString('o')
  } catch {
    $parentStartTimeUtc = $null
  }

  $stdoutTask = $parentProc.StandardOutput.ReadLineAsync()
  $stderrTask = $parentProc.StandardError.ReadLineAsync()
  $stderrLines = New-Object System.Collections.Generic.List[string]

  while ($true) {
    $tickStartMs = $loopSw.Elapsed.TotalMilliseconds
    if ($null -ne $lastTickStartMs) {
      $intervalMs = $tickStartMs - $lastTickStartMs
      $actualIntervals.Add($intervalMs)
      if ($intervalMs -gt ($SampleIntervalMs * 2.0)) {
        $observedGapCount += 1
      }
    }
    $lastTickStartMs = $tickStartMs

    # 1. Drain completed stdout lifecycle markers non-blockingly
    while ($null -ne $stdoutTask -and $stdoutTask.IsCompleted) {
      $line = $stdoutTask.GetAwaiter().GetResult()
      if ($null -eq $line) {
        $stdoutTask = $null
        break
      }
      if ($line.StartsWith($eventPrefix)) {
        $jsonText = $line.Substring($eventPrefix.Length)
        $receivedAtUtc = [DateTime]::UtcNow.ToString('o')
        $receivedOffsetMs = [Math]::Round($loopSw.Elapsed.TotalMilliseconds, 2)
        try {
          $evt = $jsonText | ConvertFrom-Json
          $lifecycleAuditEvents.Add([ordered]@{
            monitorOffsetMs      = $receivedOffsetMs
            monitorReceivedAtUtc = $receivedAtUtc
            payload              = $evt
          })
          $evtName = [string](Get-OptionalJsonProp -Obj $evt -PropName 'event')
          switch ($evtName) {
            'parent_imports_loaded' {
              $currentPhase = 'parser_execution'
            }
            'parser_run_start' {
              $currentPhase = 'parser_execution'
            }
            'child_spawned' {
              if ($null -ne $activeChildProc) {
                try { $activeChildProc.Dispose() } catch {}
                $activeChildProc = $null
              }
              $cPid = [int]$evt.childPid
              $emittedUtc = Get-OptionalJsonProp -Obj $evt -PropName 'timestampUtc'
              $bindStartMs = $loopSw.Elapsed.TotalMilliseconds
              $cStartUtc = $null
              $obsStatus = 'still_running'
              $pidBindMs = $null
              try {
                $activeChildProc = [System.Diagnostics.Process]::GetProcessById($cPid)
                $pidBindMs = [Math]::Round(($loopSw.Elapsed.TotalMilliseconds - $bindStartMs), 2)
                try {
                  $cStartUtc = $activeChildProc.StartTime.ToUniversalTime().ToString('o')
                } catch {
                  $cStartUtc = $null
                }
              } catch {
                # Do NOT treat PID lookup failure as confirmed process exit
                $missingCounterCount += 1
                $obsStatus = 'handle_unavailable'
                $activeChildProc = $null
              }
              $deliveryLatencyMs = Get-NonNegWallClockDeltaMs -StartIso $emittedUtc -EndIso $receivedAtUtc
              $activeChildEntry = [ordered]@{
                iterationIndex             = [int]$evt.iterationIndex
                pid                        = $cPid
                startTimeUtc               = $cStartUtc
                spawnEventEmittedAtUtc     = $emittedUtc
                spawnEventReceivedAtUtc    = $receivedAtUtc
                spawnEventReceivedOffsetMs = $receivedOffsetMs
                pidBindingDurationMs       = $pidBindMs
                eventDeliveryLatencyMs     = $deliveryLatencyMs
                firstValidSampleAtUtc      = $null
                firstSampleOffsetMs        = $null
                lastSampleOffsetMs         = $null
                creationToFirstSampleMs    = $null
                pairedSampleCount          = 0
                observationStatus          = $obsStatus
              }
              $childIdentities.Add($activeChildEntry)
            }
            'child_closed' {
              if ($null -ne $activeChildEntry) {
                $activeChildEntry.observationStatus = 'confirmed_closed'
              }
              if ($null -ne $activeChildProc) {
                try {
                  $activeChildProc.Refresh()
                  $cOsPeak = [long]$activeChildProc.PeakWorkingSet64
                  if ($null -eq $bChildOsPeakWs -or $cOsPeak -gt $bChildOsPeakWs) {
                    $bChildOsPeakWs = $cOsPeak
                  }
                } catch {}
                try { $activeChildProc.Dispose() } catch {}
                $activeChildProc = $null
              }
            }
            'parser_run_settled' {
              $currentPhase = 'artifact_persistence'
            }
            'artifacts_persisted' {
              $currentPhase = 'final_record_writing'
            }
            'final_record_writing' {
              $currentPhase = 'final_record_writing'
            }
            'fatal_state' {
              $monitorStatus = 'monitor_error'
              $fatalCode = Get-OptionalJsonProp -Obj $evt -PropName 'code'
              $failureDetails = "Runner reported fatal state: $fatalCode"
            }
          }
        } catch {
          # Ignore unparseable non-event output
        }
      }
      $stdoutTask = $parentProc.StandardOutput.ReadLineAsync()
    }

    # Drain stderr non-blockingly
    while ($null -ne $stderrTask -and $stderrTask.IsCompleted) {
      $errLine = $stderrTask.GetAwaiter().GetResult()
      if ($null -eq $errLine) {
        $stderrTask = $null
        break
      }
      if ($stderrLines.Count -lt 50) {
        $stderrLines.Add($errLine)
      }
      $stderrTask = $parentProc.StandardError.ReadLineAsync()
    }

    # 2. Sample parent + active child in the same iteration
    $sampledAtUtc = [DateTime]::UtcNow.ToString('o')
    $parentOk = $false
    $pWs = $null
    $pPriv = $null
    $pOsPeak = $null
    $tParentMs = 0.0
    try {
      if (-not $parentProc.HasExited) {
        $parentProc.Refresh()
        $pWs = [long]$parentProc.WorkingSet64
        $pPriv = [long]$parentProc.PrivateMemorySize64
        $pOsPeak = [long]$parentProc.PeakWorkingSet64
        $tParentMs = $loopSw.Elapsed.TotalMilliseconds
        $parentOk = $true
      }
    } catch {
      $counterReadFailureCount += 1
    }

    $childOk = $false
    $cWs = $null
    $cPriv = $null
    $cOsPeak = $null
    $tChildMs = 0.0
    $sampledChildPid = if ($null -ne $activeChildEntry) { [int]$activeChildEntry.pid } else { $null }
    if ($null -ne $activeChildProc) {
      try {
        if (-not $activeChildProc.HasExited) {
          $activeChildProc.Refresh()
          $cWs = [long]$activeChildProc.WorkingSet64
          $cPriv = [long]$activeChildProc.PrivateMemorySize64
          $cOsPeak = [long]$activeChildProc.PeakWorkingSet64
          $tChildMs = $loopSw.Elapsed.TotalMilliseconds
          $childOk = $true
        } elseif ($null -ne $activeChildEntry -and $activeChildEntry.observationStatus -eq 'still_running') {
          $activeChildEntry.observationStatus = 'observed_exited'
        }
      } catch {
        $counterReadFailureCount += 1
      }
    }

    if ($parentOk) {
      $totalSamples += 1
      if ($currentPhase -eq 'startup') { $startupSamples += 1 }
      elseif ($currentPhase -eq 'parser_execution') { $parserSamples += 1 }
      elseif ($currentPhase -eq 'artifact_persistence') { $persistSamples += 1 }
      else { $finalWriteSamples += 1 }

      if ($null -eq $fullParentPeakWs -or $pWs -gt $fullParentPeakWs) { $fullParentPeakWs = $pWs }
      if ($null -eq $fullParentOsPeakWs -or $pOsPeak -gt $fullParentOsPeakWs) { $fullParentOsPeakWs = $pOsPeak }
      if ($null -eq $fullParentPeakPriv -or $pPriv -gt $fullParentPeakPriv) { $fullParentPeakPriv = $pPriv }

      if ($currentPhase -eq 'parser_execution') {
        if ($null -eq $bParentPeakWs -or $pWs -gt $bParentPeakWs) { $bParentPeakWs = $pWs }
        if ($null -eq $bParentPeakPriv -or $pPriv -gt $bParentPeakPriv) { $bParentPeakPriv = $pPriv }
      }
    }

    if ($childOk) {
      $validChildSamples += 1
      $offsetMs = [Math]::Round($tChildMs, 2)
      if ($null -ne $activeChildEntry) {
        if ($null -eq $activeChildEntry.firstSampleOffsetMs) {
          $activeChildEntry.firstSampleOffsetMs = $offsetMs
          $activeChildEntry.firstValidSampleAtUtc = $sampledAtUtc
          $activeChildEntry.creationToFirstSampleMs = Get-NonNegWallClockDeltaMs `
            -StartIso $activeChildEntry.startTimeUtc `
            -EndIso $sampledAtUtc
        }
        $activeChildEntry.lastSampleOffsetMs = $offsetMs
      }
      if ($null -eq $bChildPeakWs -or $cWs -gt $bChildPeakWs) { $bChildPeakWs = $cWs }
      if ($null -eq $bChildOsPeakWs -or $cOsPeak -gt $bChildOsPeakWs) { $bChildOsPeakWs = $cOsPeak }
      if ($null -eq $bChildPeakPriv -or $cPriv -gt $bChildPeakPriv) { $bChildPeakPriv = $cPriv }
    }

    $sampleSkewMs = $null
    if ($parentOk -and $childOk -and $currentPhase -eq 'parser_execution') {
      $pairedParserWindowSamples += 1
      if ($null -ne $activeChildEntry) {
        $activeChildEntry.pairedSampleCount = [int]$activeChildEntry.pairedSampleCount + 1
      }
      $sampleSkewMs = [Math]::Round([Math]::Abs($tChildMs - $tParentMs), 2)
      if ($null -eq $maxParentChildSkewMs -or $sampleSkewMs -gt $maxParentChildSkewMs) {
        $maxParentChildSkewMs = $sampleSkewMs
      }
      $combWs = $pWs + $cWs
      $combPriv = $pPriv + $cPriv
      if ($null -eq $bMaxCombinedWs -or $combWs -gt $bMaxCombinedWs) { $bMaxCombinedWs = $combWs }
      if ($null -eq $bMaxCombinedPriv -or $combPriv -gt $bMaxCombinedPriv) { $bMaxCombinedPriv = $combPriv }
    }

    $tickElapsed = $loopSw.Elapsed.TotalMilliseconds - $tickStartMs
    $tickDurations.Add($tickElapsed)

    if ($parentOk -or $childOk) {
      $rowObj = [ordered]@{
        sampleIndex         = $totalSamples
        tMs                 = [Math]::Round($tickStartMs, 2)
        sampledAtUtc        = $sampledAtUtc
        phase               = $currentPhase
        parentOk            = $parentOk
        parentWsBytes       = $pWs
        parentPrivBytes     = $pPriv
        parentOsPeakWsBytes = $pOsPeak
        childPid            = $sampledChildPid
        childOk             = $childOk
        childWsBytes        = $cWs
        childPrivBytes      = $cPriv
        childOsPeakWsBytes  = $cOsPeak
        parentChildSkewMs   = $sampleSkewMs
        tickDurationMs      = [Math]::Round($tickElapsed, 2)
      }
      $rawSampleLines.Add(($rowObj | ConvertTo-Json -Compress))
    }

    if ($parentProc.HasExited -and $null -eq $stdoutTask -and $null -eq $stderrTask) {
      $parentExitCode = $parentProc.ExitCode
      if ($parentExitCode -ne 0 -and $monitorStatus -eq 'completed') {
        $monitorStatus = 'parent_nonzero_exit'
        $errSummary = ($stderrLines -join ' | ')
        $failureDetails = "Measured parent exited with code $parentExitCode. $errSummary".Trim()
      }
      break
    }

    if ($loopSw.ElapsedMilliseconds -ge $supervisorDeadlineMs) {
      $monitorStatus = 'supervisor_timeout'
      $failureDetails = "Supervisor observation deadline ($supervisorDeadlineMs ms) expired while parent PID $parentPid remained active; snapshot and artifacts preserved without killing unrelated processes."
      $quarantinedOwned.Add([ordered]@{ role = 'parent'; pid = $parentPid; startTimeUtc = $parentStartTimeUtc })
      if ($null -ne $activeChildEntry -and $activeChildEntry.observationStatus -ne 'confirmed_closed' -and $activeChildEntry.observationStatus -ne 'observed_exited') {
        $quarantinedOwned.Add([ordered]@{ role = 'child'; pid = $activeChildEntry.pid; startTimeUtc = $activeChildEntry.startTimeUtc })
      }
      break
    }

    $remainingSleepMs = [int][Math]::Floor($SampleIntervalMs - $tickElapsed)
    if ($remainingSleepMs -gt 0) {
      Start-Sleep -Milliseconds $remainingSleepMs
    }
  }
} catch {
  $monitorStatus = 'monitor_error'
  $failureDetails = $_.Exception.Message
} finally {
  if ($null -ne $activeChildProc) {
    try { $activeChildProc.Dispose() } catch {}
  }
  try { $parentProc.Dispose() } catch {}
}

$windowEndUtc = [DateTime]::UtcNow.ToString('o')

# Write exclusive raw audit artifacts (lifecycle events + raw timestamped samples)
$lifecyclePayload = [ordered]@{
  schemaVersion = 1
  parentPid     = $parentPid
  events        = @($lifecycleAuditEvents.ToArray())
}
Write-ExclusiveUtf8NoBom -FilePath $lifecycleEventsPath -Content (($lifecyclePayload | ConvertTo-Json -Depth 10) + "`n")
$ndjsonContent = if ($rawSampleLines.Count -gt 0) { ($rawSampleLines -join "`n") + "`n" } else { '' }
Write-ExclusiveUtf8NoBom -FilePath $samplesPath -Content $ndjsonContent

$monitorSummary = [ordered]@{
  schemaVersion          = 1
  monitorStatus          = $monitorStatus
  platform               = 'win32'
  phaseAttributionMethod = 'approximate-monitor-stdout-event-receipt'
  counterSemantics       = 'Windows System.Diagnostics.Process counters: WorkingSet64/PeakWorkingSet64 measure mapped physical pages (combined same-iteration working set may double-count shared pages); PrivateMemorySize64 measures committed private virtual bytes (not physical resident memory); PagedMemorySize64 measures committed paged virtual memory. Same-iteration parent+child readings are approximately simultaneous (not atomic), sampling can miss transient sub-interval spikes, and Windows counters are not equivalent to Linux cgroup memory accounting.'
  clockDomainNotes       = 'Monotonic Stopwatch offsets (tMs, tickDurationMs, actualIntervalMs, pidBindingDurationMs, parentChildSkewMs) share one monitor clock domain. Cross-process wall-clock deltas (creationToFirstSampleMs, eventDeliveryLatencyMs) compare OS/parent UTC wall clocks and may be null when sub-tick skew produces a negative delta. Phase attribution switches upon monitor stdout receipt of lifecycle markers (approximate-monitor-stdout-event-receipt); zero samples in a short window (e.g. artifact persistence or final record writing) indicates the window finished faster than the sampling interval, not zero memory consumption.'
  auditArtifacts         = [ordered]@{
    lifecycleEventsFile = $lifecycleEventsFileName
    samplesFile         = $samplesFileName
  }
  parentIdentity         = [ordered]@{
    pid          = $parentPid
    startTimeUtc = $parentStartTimeUtc
    exitCode     = $parentExitCode
  }
  childIdentities        = @($childIdentities.ToArray())
  sampling               = [ordered]@{
    requestedIntervalMs              = $SampleIntervalMs
    windowStartUtc                   = $windowStartUtc
    windowEndUtc                     = $windowEndUtc
    totalSamples                     = $totalSamples
    startupWindowSamples             = $startupSamples
    parserWindowSamples              = $parserSamples
    artifactPersistenceWindowSamples = $persistSamples
    finalRecordWriteWindowSamples    = $finalWriteSamples
    validChildSamples                = $validChildSamples
    pairedParserWindowSamples        = $pairedParserWindowSamples
    observedGapCount                 = $observedGapCount
    missingCounterCount              = $missingCounterCount
    counterReadFailureCount          = $counterReadFailureCount
    actualIntervalMs                 = Get-NumericSummary -Values $actualIntervals.ToArray()
    tickDurationMs                   = Get-NumericSummary -Values $tickDurations.ToArray()
    maxParentChildSkewMs             = $maxParentChildSkewMs
  }
  parserExecutionWindowMemory = [ordered]@{
    parentSampledWorkingSetPeakBytes           = $bParentPeakWs
    parentSampledPrivateMemoryPeakBytes        = $bParentPeakPriv
    childSampledWorkingSetPeakBytes            = $bChildPeakWs
    childOsReportedPeakWorkingSetBytes         = $bChildOsPeakWs
    childSampledPrivateMemoryPeakBytes         = $bChildPeakPriv
    maxSameIterationCombinedWorkingSetBytes    = $bMaxCombinedWs
    maxSameIterationCombinedPrivateMemoryBytes = $bMaxCombinedPriv
  }
  fullParentLifetimeMemory = [ordered]@{
    parentSampledWorkingSetPeakBytes    = $fullParentPeakWs
    parentOsReportedPeakWorkingSetBytes = $fullParentOsPeakWs
    parentSampledPrivateMemoryPeakBytes = $fullParentPeakPriv
  }
  failureDetails            = $failureDetails
  quarantinedOwnedProcesses = @($quarantinedOwned.ToArray())
}

Write-ExclusiveUtf8NoBom -FilePath $monitorPath -Content (($monitorSummary | ConvertTo-Json -Depth 10) + "`n")

if ($monitorStatus -eq 'supervisor_timeout') {
  Write-Error $failureDetails
  exit 1
}

# === STAGE C: Independent scoring (outside measured parent) ===
if (Test-Path -LiteralPath $parentRecordPath) {
  Write-Host "[Stage C] Scoring isolated parser output for $RunId..." -ForegroundColor Cyan
  & node $scoreScript score `
    --run-dir $RunDir `
    --run-id $RunId `
    --parent-record $parentRecordPath `
    --monitor $monitorPath `
    --out $scoredPath
  if ($LASTEXITCODE -ne 0) {
    throw "Stage C score failed with exit code $LASTEXITCODE."
  }
} else {
  throw "Measured parent did not produce $parentRecordPath (monitorStatus=$monitorStatus; details=$failureDetails)."
}