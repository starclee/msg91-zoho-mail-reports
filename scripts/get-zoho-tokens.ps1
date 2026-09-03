<#
.SYNOPSIS
  Exchanges a Zoho Self Client authorization code for a refresh token, then
  looks up your Zoho Mail account id and mailbox address - covers README.md
  steps 3 and 4 ("ZOHO_REFRESH_TOKEN", "ZOHO_ACCOUNT_ID", "ZOHO_FROM_ADDRESS")
  in one run instead of copy-pasting curl/Invoke-RestMethod one-liners.

.DESCRIPTION
  Run this from PowerShell right after generating the authorization code on
  the Self Client "Generate Code" tab at api-console.zoho.com - the code
  expires fast, so have it ready before running this script.

  Prompts for ClientId/ClientSecret/Code interactively if not passed as
  parameters, so nothing needs to be typed into a chat or committed to a file.

.EXAMPLE
  .\get-zoho-tokens.ps1
  # prompts for everything

.EXAMPLE
  .\get-zoho-tokens.ps1 -AccountsHost accounts.zoho.in -MailHost mail.zoho.in
  # for a non-US datacenter account
#>
param(
  [string]$ClientId,
  [securestring]$ClientSecret,
  [string]$Code,
  [string]$AccountsHost = "accounts.zoho.com",
  [string]$MailHost = "mail.zoho.com"
)

$ErrorActionPreference = "Stop"

if (-not $ClientId) { $ClientId = Read-Host "Client ID" }
if (-not $ClientSecret) { $ClientSecret = Read-Host "Client Secret" -AsSecureString }
if (-not $Code) { $Code = Read-Host "Authorization code (from Generate Code tab)" }

$plainSecret = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ClientSecret)
)

Write-Host "`nExchanging code for tokens..." -ForegroundColor Cyan
$tokenBody = @{
  client_id     = $ClientId
  client_secret = $plainSecret
  grant_type    = "authorization_code"
  code          = $Code
}

try {
  $tokenResponse = Invoke-RestMethod -Method Post -Uri "https://$AccountsHost/oauth/v2/token" -Body $tokenBody
} catch {
  Write-Host "Token exchange failed:" -ForegroundColor Red
  Write-Host $_.ErrorDetails.Message
  exit 1
}

if (-not $tokenResponse.refresh_token) {
  Write-Host "No refresh_token in the response - the code may have expired. Generate a fresh one and re-run." -ForegroundColor Red
  $tokenResponse | ConvertTo-Json
  exit 1
}

Write-Host "`n=== ZOHO_REFRESH_TOKEN (save this - it does not expire) ===" -ForegroundColor Green
Write-Host $tokenResponse.refresh_token

Write-Host "`nLooking up your Zoho Mail account id / mailbox address..." -ForegroundColor Cyan
try {
  $accounts = Invoke-RestMethod -Uri "https://$MailHost/api/accounts" `
    -Headers @{ Authorization = "Zoho-oauthtoken $($tokenResponse.access_token)" }
} catch {
  Write-Host "Account lookup failed - you can still find ZOHO_ACCOUNT_ID/ZOHO_FROM_ADDRESS manually (see README.md step 4)." -ForegroundColor Yellow
  Write-Host $_.ErrorDetails.Message
  exit 0
}

Write-Host "`n=== Account(s) found ===" -ForegroundColor Green
$accounts.data | ForEach-Object {
  Write-Host "ZOHO_ACCOUNT_ID   = $($_.accountId)"
  Write-Host "ZOHO_FROM_ADDRESS = $($_.mailboxAddress)"
  Write-Host "---"
}

Write-Host "`nDone. Add these as GitHub repo secrets, e.g.:" -ForegroundColor Cyan
Write-Host "  gh secret set ZOHO_REFRESH_TOKEN"
Write-Host "  gh secret set ZOHO_ACCOUNT_ID"
Write-Host "  gh secret set ZOHO_FROM_ADDRESS"
