param(
  [Parameter(Mandatory = $true)]
  [string]$SoundDirectory
)

$ErrorActionPreference = 'SilentlyContinue'
$players = @{}
$loopPlayers = @{}
$shutdownDelayUntil = [DateTime]::MinValue
$activeCueName = $null
$activeCueUntil = [DateTime]::MinValue
$fullVolume = 1.0
$fadeInMilliseconds = 12
$crossfadeMilliseconds = 30
$fadeOutMilliseconds = 36

try {
  Add-Type -AssemblyName PresentationCore
} catch {
  exit 1
}

Get-ChildItem -LiteralPath $SoundDirectory -Filter '*.wav' -File | ForEach-Object {
  try {
    $name = $_.BaseName.ToLowerInvariant()
    $mediaPlayer = [System.Windows.Media.MediaPlayer]::new()
    $mediaPlayer.Volume = $fullVolume
    $mediaPlayer.Open([Uri]$_.FullName)
    $players[$name] = $mediaPlayer
  } catch {}
}

function Remove-LoopHandler([string]$Name) {
  if (-not $loopPlayers.ContainsKey($Name)) { return }
  try { Unregister-Event -SourceIdentifier "Loop_$Name" -ErrorAction SilentlyContinue } catch {}
  $loopPlayers.Remove($Name)
}

function Stop-PlayerSmoothly($MediaPlayer, [int]$DurationMilliseconds = $fadeOutMilliseconds) {
  if ($null -eq $MediaPlayer) { return }
  $steps = 6
  $startingVolume = [Math]::Max(0.0, [Math]::Min($fullVolume, $MediaPlayer.Volume))
  for ($step = 1; $step -le $steps; $step++) {
    $progress = $step / $steps
    $MediaPlayer.Volume = $startingVolume * [Math]::Cos($progress * [Math]::PI / 2)
    Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Round($DurationMilliseconds / $steps)))
  }
  $MediaPlayer.Stop()
  $MediaPlayer.Position = [TimeSpan]::Zero
  $MediaPlayer.Volume = $fullVolume
}

function Start-PlayerSmoothly($MediaPlayer, [int]$DurationMilliseconds = $fadeInMilliseconds) {
  $steps = 4
  $MediaPlayer.Stop()
  $MediaPlayer.Position = [TimeSpan]::Zero
  $MediaPlayer.Volume = 0.0
  $MediaPlayer.Play()
  for ($step = 1; $step -le $steps; $step++) {
    $progress = $step / $steps
    $MediaPlayer.Volume = $fullVolume * [Math]::Sin($progress * [Math]::PI / 2)
    Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Round($DurationMilliseconds / $steps)))
  }
  $MediaPlayer.Volume = $fullVolume
}

function Crossfade-Players($PreviousPlayer, $NextPlayer, [int]$DurationMilliseconds = $crossfadeMilliseconds) {
  $steps = 6
  $startingVolume = [Math]::Max(0.0, [Math]::Min($fullVolume, $PreviousPlayer.Volume))
  $NextPlayer.Stop()
  $NextPlayer.Position = [TimeSpan]::Zero
  $NextPlayer.Volume = 0.0
  $NextPlayer.Play()
  for ($step = 1; $step -le $steps; $step++) {
    $progress = $step / $steps
    $PreviousPlayer.Volume = $startingVolume * [Math]::Cos($progress * [Math]::PI / 2)
    $NextPlayer.Volume = $fullVolume * [Math]::Sin($progress * [Math]::PI / 2)
    Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Round($DurationMilliseconds / $steps)))
  }
  $PreviousPlayer.Stop()
  $PreviousPlayer.Position = [TimeSpan]::Zero
  $PreviousPlayer.Volume = $fullVolume
  $NextPlayer.Volume = $fullVolume
}

function Test-ActiveCue {
  return $null -ne $activeCueName -and [DateTime]::UtcNow -lt $activeCueUntil
}

function Set-ActiveCue([string]$Name, $MediaPlayer, [bool]$IsLoop = $false) {
  $script:activeCueName = $Name
  if ($IsLoop) {
    $script:activeCueUntil = [DateTime]::MaxValue
  } else {
    $script:activeCueUntil = [DateTime]::UtcNow.Add($MediaPlayer.NaturalDuration.TimeSpan)
  }
}

function Clear-ActiveCue([string]$Name) {
  if ($activeCueName -ne $Name) { return }
  $script:activeCueName = $null
  $script:activeCueUntil = [DateTime]::MinValue
}

# MediaPlayer opens asynchronously. Signal readiness only after every WAV has
# a resolved duration, so the first event cannot be lost during initialization.
# Deadline raised to 5000ms so the full 54-file sound bank has time to finish
# opening on slower machines.
$readyDeadline = [DateTime]::UtcNow.AddMilliseconds(5000)
do {
  $allReady = $true
  foreach ($mediaPlayer in $players.Values) {
    if (-not $mediaPlayer.NaturalDuration.HasTimeSpan) {
      $allReady = $false
      break
    }
  }
  if (-not $allReady) { Start-Sleep -Milliseconds 10 }
} while (-not $allReady -and [DateTime]::UtcNow -lt $readyDeadline)

# Never queue a cue against media that is still opening. MediaPlayer would
# otherwise start it later, detached from the event that requested it.
foreach ($name in @($players.Keys)) {
  if (-not $players[$name].NaturalDuration.HasTimeSpan) {
    try { $players[$name].Close() } catch {}
    $players.Remove($name)
  }
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line.Trim().Split(' ', 2, [System.StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Count -ne 2) { continue }
    $command = $parts[0].ToLowerInvariant()
    $name = $parts[1].ToLowerInvariant()
    $mediaPlayer = $players[$name]
    if ($null -eq $mediaPlayer) { continue }
    try {
      switch ($command) {
        'play' {
          Remove-LoopHandler $name
          if ($name.StartsWith('type_')) {
            # Typing samples are only about 10 ms long. Play them immediately;
            # a fade would remove the transient that makes them audible.
            $mediaPlayer.Stop()
            $mediaPlayer.Position = [TimeSpan]::Zero
            $mediaPlayer.Volume = $fullVolume
            $mediaPlayer.Play()
            continue
          }

          $previousName = if (Test-ActiveCue) { $activeCueName } else { $null }
          $previousPlayer = if ($null -ne $previousName) { $players[$previousName] } else { $null }
          if ($null -ne $previousName) { Remove-LoopHandler $previousName }

          if ($null -ne $previousPlayer -and $previousName -ne $name) {
            Crossfade-Players $previousPlayer $mediaPlayer
          } elseif ($previousName -eq $name) {
            Stop-PlayerSmoothly $mediaPlayer 18
            Start-PlayerSmoothly $mediaPlayer
          } else {
            Start-PlayerSmoothly $mediaPlayer
          }
          Set-ActiveCue $name $mediaPlayer
          if ($name -eq 'closing or quitting') {
            # Let the actual file finish if the parent exits immediately after
            # requesting the closing cue. This adapts if the asset is replaced.
            $shutdownDelayUntil = [DateTime]::UtcNow.Add($mediaPlayer.NaturalDuration.TimeSpan).AddMilliseconds(75)
          }
        }
        'loop' {
          $previousName = if (Test-ActiveCue) { $activeCueName } else { $null }
          $previousPlayer = if ($null -ne $previousName) { $players[$previousName] } else { $null }
          if ($null -ne $previousName) { Remove-LoopHandler $previousName }
          Remove-LoopHandler $name
          # Register a MediaEnded handler that restarts playback so the sound
          # actually loops instead of playing just once.
          $capturedPlayer = $mediaPlayer
          $null = Register-ObjectEvent -InputObject $capturedPlayer -EventName MediaEnded `
            -SourceIdentifier "Loop_$name" -Action {
              $capturedPlayer.Position = [TimeSpan]::Zero
              $capturedPlayer.Play()
          }
          $loopPlayers[$name] = $true
          if ($null -ne $previousPlayer -and $previousName -ne $name) {
            Crossfade-Players $previousPlayer $mediaPlayer
          } elseif ($previousName -eq $name) {
            Stop-PlayerSmoothly $mediaPlayer 18
            Start-PlayerSmoothly $mediaPlayer
          } else {
            Start-PlayerSmoothly $mediaPlayer
          }
          Set-ActiveCue $name $mediaPlayer $true
        }
        'stop' {
          Remove-LoopHandler $name
          if ($activeCueName -eq $name -and (Test-ActiveCue)) {
            Stop-PlayerSmoothly $mediaPlayer
          } else {
            $mediaPlayer.Stop()
            $mediaPlayer.Position = [TimeSpan]::Zero
            $mediaPlayer.Volume = $fullVolume
          }
          Clear-ActiveCue $name
        }
      }
    } catch {}
  }
} finally {
  # Clean up all loop handlers on exit.
  foreach ($loopName in @($loopPlayers.Keys)) {
    Remove-LoopHandler $loopName
  }
  $remaining = ($shutdownDelayUntil - [DateTime]::UtcNow).TotalMilliseconds
  if ($remaining -gt 0) { Start-Sleep -Milliseconds ([Math]::Ceiling($remaining)) }
  elseif (Test-ActiveCue) { Stop-PlayerSmoothly $players[$activeCueName] }
  foreach ($mediaPlayer in $players.Values) {
    try {
      $mediaPlayer.Stop()
      $mediaPlayer.Close()
    } catch {}
  }
}
