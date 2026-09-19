param(
    [Parameter(Mandatory)][string]$Directory,
    [switch]$PreserveExistingSignatures
)
$ErrorActionPreference = 'Stop'
foreach ($name in @('WINDOWS_SIGNING_ENDPOINT', 'WINDOWS_SIGNING_ACCOUNT', 'WINDOWS_SIGNING_PROFILE', 'WINDOWS_SIGNING_PUBLISHER')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "Windows signing requires $name."
    }
}
$files = @(Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' })
if ($files.Count -eq 0) { throw "No native files found to sign in $Directory." }
$unsigned = @($files | Where-Object {
    $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName
    if ($PreserveExistingSignatures -and $signature.Status -eq 'Valid' -and $null -ne $signature.TimeStamperCertificate) {
        return $false
    }
    if ($signature.Status -ne 'NotSigned') { throw "Unexpected existing signature on $($_.Name): $($signature.Status)" }
    return $true
})
if ($unsigned.Count -eq 0) { return }
Import-Module ArtifactSigning -RequiredVersion 0.1.8
$parameters = @{
    Endpoint = $env:WINDOWS_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:WINDOWS_SIGNING_ACCOUNT
    CertificateProfileName = $env:WINDOWS_SIGNING_PROFILE
    Files = ($unsigned.FullName -join ',')
    FileDigest = 'SHA256'
    TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
    TimestampDigest = 'SHA256'
    ExcludeEnvironmentCredential = $true
    ExcludeWorkloadIdentityCredential = $true
    ExcludeManagedIdentityCredential = $true
    ExcludeSharedTokenCacheCredential = $true
    ExcludeVisualStudioCredential = $true
    ExcludeVisualStudioCodeCredential = $true
    ExcludeAzureCliCredential = $false
    ExcludeAzurePowerShellCredential = $true
    ExcludeAzureDeveloperCliCredential = $true
    ExcludeInteractiveBrowserCredential = $true
}
Invoke-ArtifactSigning @parameters
foreach ($file in $unsigned) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
        throw "Invalid or untimestamped signature on $($file.Name): $($signature.Status)"
    }
    $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($signature.SignerCertificate.Subject -ne $env:WINDOWS_SIGNING_PUBLISHER -and $publisher -ne $env:WINDOWS_SIGNING_PUBLISHER) {
        throw "Unexpected publisher on $($file.Name)."
    }
    Write-Output "Verified timestamped signature: $($file.Name)"
}
