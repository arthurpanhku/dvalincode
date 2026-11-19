# Smoke-test the Windows desktop app the way a user meets it: install it with
# its setup executable, start it the way the Start menu entry does, and check
# that the window opens, the page loads and signs in to the embedded server,
# closing the window ends the server too, and uninstalling removes the app.
#
#   pwsh scripts/smoke-gui-windows.ps1 -Installer <setup.exe> [-Screenshot <file.png>]
#
# Run by .github/workflows/release-gui.yml on the Windows runner, before
# anything is published. The install path, executable name and window title
# below must agree with installer/windows/dvalincode.iss and src/gui/index.ts;
# tests/windowsInstaller.test.ts checks that they do.

param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Screenshot
)

$ErrorActionPreference = 'Stop'

$appDir = Join-Path $env:LOCALAPPDATA 'Programs\DvalinCode'
$appExe = Join-Path $appDir 'DvalinCode.exe'

function Fail([string]$message) { throw "smoke: $message" }

function Wait-Until([scriptblock]$condition, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $condition)) {
    if ((Get-Date) -gt $deadline) { return $false }
    Start-Sleep -Seconds 1
  }
  return $true
}

Write-Host "==> Installing $(Split-Path $Installer -Leaf)"
$setup = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if ($setup.ExitCode -ne 0) { Fail "the installer exited with $($setup.ExitCode)" }
foreach ($file in $appExe, (Join-Path $appDir 'web\dist\index.html'), (Join-Path $appDir 'unins000.exe')) {
  if (-not (Test-Path $file)) { Fail "not installed: $file" }
}
Write-Host "    ok: installed in $appDir"

Write-Host '==> Starting DvalinCode.exe'
# No console and no redirected output: what the Start menu entry does.
$app = Start-Process -FilePath $appExe -WorkingDirectory $appDir -PassThru
$opened = Wait-Until { $app.Refresh(); $app.HasExited -or $app.MainWindowTitle -eq 'DvalinCode' } 60
if ($app.HasExited) { Fail "the app exited with $($app.ExitCode) before opening its window" }
if (-not $opened) { Fail "no window titled DvalinCode after 60 s (main window: '$($app.MainWindowTitle)')" }
Write-Host '    ok: window "DvalinCode" is open'

# The window opens only once its server child is listening, on a port of its own.
$server = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)" |
  Where-Object Name -eq 'DvalinCode.exe' | Select-Object -First 1
if (-not $server) { Fail 'the window process has no server child' }
$port = (Get-NetTCPConnection -State Listen -OwningProcess $server.ProcessId -ErrorAction SilentlyContinue |
  Select-Object -First 1).LocalPort
if (-not $port) { Fail 'the embedded server is not listening' }
$base = "http://127.0.0.1:$port"
$page = Invoke-WebRequest "$base/"
if ($page.Content -notmatch 'id="root"') { Fail "the server on $base did not serve the UI" }
$api = Invoke-WebRequest "$base/api/sessions" -SkipHttpErrorCheck
if ($api.StatusCode -ne 401) { Fail "the API answered $($api.StatusCode) without the access token" }
Write-Host "    ok: the server on port $port serves the UI and refuses the API without its token"

# Past its unlock screen the UI holds a WebSocket to the server. Loading the
# page uses short-lived connections (the server's keep-alive is 5 s), so a
# WebView2 connection still open 10 s later is that socket: the page loaded,
# traded the window's token for its cookie, and connected.
function Get-WebViewConnections {
  @(Get-NetTCPConnection -State Established -RemotePort $port -ErrorAction SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'msedgewebview2' })
}
if (-not (Wait-Until { (Get-WebViewConnections).Count -gt 0 } 30)) { Fail 'the window never loaded the page from its server' }
Start-Sleep -Seconds 10
if ((Get-WebViewConnections).Count -eq 0) { Fail 'the page loaded but holds no WebSocket: it did not get past the unlock screen' }
Write-Host '    ok: the page loaded, signed in, and holds its WebSocket'

# For the person reviewing the run: only a picture shows what was painted.
if ($Screenshot) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($Screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    Write-Host "    ok: screenshot saved to $Screenshot"
  } catch {
    Write-Warning "Could not capture a screenshot: $_"
  }
}

Write-Host '==> Closing the window'
[void]$app.CloseMainWindow()
if (-not $app.WaitForExit(15000)) {
  Stop-Process -Id $app.Id -Force
  Fail 'the app was still running 15 s after its window was closed'
}
if (-not (Wait-Until { -not (Get-Process -Id $server.ProcessId -ErrorAction SilentlyContinue) } 15)) {
  Stop-Process -Id $server.ProcessId -Force
  Fail 'the embedded server outlived its window'
}
Write-Host '    ok: the window and its server both exited'

Write-Host '==> Uninstalling'
$uninstall = Start-Process -FilePath (Join-Path $appDir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { Fail "the uninstaller exited with $($uninstall.ExitCode)" }
# The uninstaller re-runs itself from %TEMP% so that it can delete its own file.
if (-not (Wait-Until { -not (Test-Path $appDir) } 60)) {
  Fail "left behind after uninstalling: $((Get-ChildItem $appDir -Recurse -Name) -join ', ')"
}
Write-Host '    ok: uninstalled'
Write-Host 'Smoke test passed.'
