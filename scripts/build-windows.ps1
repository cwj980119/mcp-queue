param([string]$NodeVersion = '22.23.4', [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repoRoot
if ($env:OS -ne 'Windows_NT') { throw 'Build the Windows installer on Windows.' }
if ($NodeVersion -notmatch '^22\.\d+\.\d+$') { throw 'Use a supported, pinned Node 22 runtime version.' }

# A unique staging directory avoids deleting or reusing any previous package or private user state.
$buildRoot = Join-Path $repoRoot '.local/windows-build'
$stage = Join-Path $buildRoot ([Guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage 'app'
$output = Join-Path $buildRoot 'output'
New-Item -ItemType Directory -Path $payload,$output -Force | Out-Null
if (-not (Test-Path 'dist/src/client.js')) { throw 'Run npm ci and npm run build first.' }
New-Item -ItemType Directory -Path (Join-Path $payload 'dist') -Force | Out-Null
Copy-Item -LiteralPath 'dist/src' -Destination (Join-Path $payload 'dist/src') -Recurse
Copy-Item -LiteralPath 'client-public' -Destination (Join-Path $payload 'client-public') -Recurse
foreach ($file in @('package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath $file -Destination $payload
}
Push-Location $payload
try { & npm.cmd ci --omit=dev --ignore-scripts; if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' } }
finally { Pop-Location }

$archiveName = "node-v$NodeVersion-win-x64.zip"
$baseUrl = "https://nodejs.org/dist/v$NodeVersion"
$archive = Join-Path $stage $archiveName
$manifest = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
$manifestLine = @($manifest -split "`n" | Where-Object { $_.Trim() -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($archiveName) + '$') })
if ($manifestLine.Count -ne 1) { throw 'Official Node.js checksum entry not found.' }
$expected = ($manifestLine[0].Trim() -split '\s+')[0].ToLowerInvariant()
Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archive -UseBasicParsing
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node.js runtime checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $stage 'node')
$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$nodeRoot = Join-Path $stage "node/node-v$NodeVersion-win-x64"
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $runtime 'LICENSE.txt')

$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$(Join-Path $payload 'MCPQueue.exe')" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32manifest:$(Join-Path $repoRoot 'installer\windows\launcher.manifest')" (Join-Path $repoRoot 'installer\windows\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher compilation failed.' }
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
@{version=$version;nodeVersion=$NodeVersion;nodeArchiveSha256=$expected;sourceCommit=(& git rev-parse HEAD)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'build-info.json') -Encoding utf8
Set-Content -LiteralPath (Join-Path $buildRoot 'payload-path.txt') -Value $payload -Encoding utf8
if ($PrepareOnly) { Write-Output "Prepared: $payload"; exit 0 }

$iscc = $env:ISCC_PATH
if (-not $iscc) { $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe' }
if (-not (Test-Path -LiteralPath $iscc)) { throw 'Inno Setup 6 is required for packaging. The Windows CI runner includes it.' }
& $iscc "/DAppVersion=$version" "/DPayloadDirectory=$payload" "/DOutputDirectory=$output" 'installer/windows/setup.iss'
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$setup = Join-Path $output 'MCP-Queue-Setup.exe'
$sha = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), "$sha  MCP-Queue-Setup.exe`n", [Text.UTF8Encoding]::new($false))
Write-Output "Installer ready: $setup"
