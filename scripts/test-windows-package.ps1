$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = Join-Path $repoRoot '.local/windows-build'
$payload = (Get-Content -LiteralPath (Join-Path $buildRoot 'payload-path.txt') -Raw).Trim()
if (-not ([IO.Path]::GetFullPath($payload).StartsWith($buildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { throw 'Unexpected package path.' }
$setup = Join-Path $buildRoot 'output/MCP-Queue-Setup.exe'
$installed = Join-Path $buildRoot ('install-test-' + [Guid]::NewGuid().ToString('N'))
$state = Join-Path $buildRoot ('state-test-' + [Guid]::NewGuid().ToString('N'))

# Run on the disposable Windows CI runner. Suppress post-install app/browser launch.
$installer = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',"/DIR=`"$installed`"") -PassThru -Wait -WindowStyle Hidden
if ($installer.ExitCode -ne 0) { throw "Installer failed: $($installer.ExitCode)" }
try {
    foreach ($file in @('MCPQueue.exe','runtime/node.exe','dist/src/client.js','client-public/index.html','node_modules/express/package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installed $file))) { throw "Installed file missing: $file" }
    }
    # The installation directory itself sits under .local in this test; only paths inside it count.
    $privateFiles = @(Get-ChildItem -LiteralPath $installed -Recurse -Force -File | Where-Object { $_.FullName.Substring($installed.Length) -match '(^|[\\/])(\.env|\.local)([\\/]|$)|\.queue\.json$|\.sqlite$' })
    if ($privateFiles.Count) { throw 'Private state was included in the installer.' }
    $env:QUEUE_NO_OPEN_BROWSER='1';$env:QUEUE_DESKTOP_HOST='1';$env:QUEUE_CLIENT_HOME=$state;$env:QUEUE_CLIENT_PORT='0'
    # Exercise the installed runtime offline; no npm, global Node, agent or model is used.
    @'
import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['dist/src/client.js'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});
let output='';const timeout=setTimeout(()=>{child.kill();process.exitCode=1;},15000);
child.stderr.on('data',()=>{});
child.stdout.on('data',async chunk=>{
 output+=chunk;const found=output.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(!found||child.tested)return;child.tested=true;
 try { const response=await fetch(found[0]+'/client-info');const info=await response.json();if(info.name!=='mcp-queue-client'||info.pid!==child.pid)throw Error('Wrong client');child.stdin.end('quit\n'); }
 catch(error){console.error(error.message);child.kill();process.exitCode=1;}
});
child.once('exit',code=>{clearTimeout(timeout);if(code!==0)process.exitCode=1;});
'@ | Set-Content -LiteralPath (Join-Path $installed 'smoke.mjs') -Encoding utf8
    Push-Location $installed
    try { & (Join-Path $installed 'runtime/node.exe') 'smoke.mjs'; if ($LASTEXITCODE -ne 0) { throw 'Installed runtime smoke test failed.' } }
    finally { Pop-Location }
    # Exercise the native launcher, singleton mutex and owned-process job as installed.
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start()
    $desktopPort=$listener.LocalEndpoint.Port;$listener.Stop();$env:QUEUE_CLIENT_PORT=[string]$desktopPort
    $env:QUEUE_DESKTOP_TEST='1'
    $desktop=Start-Process -FilePath (Join-Path $installed 'MCPQueue.exe') -PassThru -WindowStyle Hidden
    $ownedNode=$null
    try {
        $deadline=[DateTime]::UtcNow.AddSeconds(25)
        while ([DateTime]::UtcNow -lt $deadline) {
            try {$info=Invoke-RestMethod "http://127.0.0.1:$desktopPort/client-info" -TimeoutSec 1;if($info.name -eq 'mcp-queue-client'){$ownedNode=Get-Process -Id $info.pid;break}} catch { }
            if($desktop.HasExited){throw 'Native desktop launcher exited during startup.'}
            Start-Sleep -Milliseconds 200
        }
        if(-not $ownedNode){throw 'Native launcher did not start the bundled runtime.'}
        $second=Start-Process -FilePath (Join-Path $installed 'MCPQueue.exe') -PassThru -WindowStyle Hidden
        if(-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0){throw 'Second launch did not reuse the existing app.'}
    } finally {
        if(-not $desktop.HasExited){$desktop.Kill();$desktop.WaitForExit(10000)|Out-Null}
    }
    if($ownedNode -and -not $ownedNode.WaitForExit(10000)){throw 'Desktop exit left its Node process running.'}
} finally {
    $uninstaller = Join-Path $installed 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $removed = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -PassThru -Wait -WindowStyle Hidden
        if ($removed.ExitCode -ne 0) { throw 'Test uninstallation failed.' }
    }
}
Write-Output 'Installer, offline runtime startup, graceful stop, and uninstall passed.'
