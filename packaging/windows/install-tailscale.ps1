$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $existing = Join-Path $env:ProgramW6432 'Tailscale\tailscale.exe'
    if (Test-Path $existing) {
        $current = (Get-Item $existing).VersionInfo.ProductVersion
        if ($current -match '^([0-9]+\.[0-9]+\.[0-9]+)' -and [version]$Matches[1] -ge [version]'1.52.0') { Write-Output 'Tailscale is already installed.'; exit 0 }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $metadata = Invoke-RestMethod -Uri 'https://pkgs.tailscale.com/stable/?mode=json&os=windows' -TimeoutSec 60
    $filename = $metadata.MSIs.amd64
    if ($filename -notmatch '^tailscale-setup-\d+\.\d+\.\d+-amd64(?:-winui)?\.msi$') { throw 'Unexpected package metadata; installation stopped.' }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('Bathjun-Tailscale-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $msi = Join-Path $temporary $filename
        Invoke-WebRequest -UseBasicParsing -Uri ('https://pkgs.tailscale.com/stable/' + $filename) -OutFile $msi -TimeoutSec 180
        $signature = Get-AuthenticodeSignature -FilePath $msi
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw 'The Tailscale package signature is not valid; installation stopped.' }
        $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if ($publisher -ne 'Tailscale Inc.') { throw 'Unexpected package publisher; installation stopped.' }
        Write-Output 'Verified Tailscale Inc. signature. Windows will ask permission to install Tailscale.'
        $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList @('/i', ('"' + $msi + '"'), '/passive', '/norestart') -Verb RunAs -Wait -PassThru
        if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw ('Tailscale installation failed: ' + $process.ExitCode) }
        if ($process.ExitCode -eq 3010) { Write-Output 'Restart Windows before starting Bathjun.' }
    } finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
    exit 0
} catch {
    Write-Error $_
    exit 1
}
