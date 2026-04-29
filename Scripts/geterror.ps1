Write-Host "Running Scripts/geterror.ps1..."
Write-Host "====================================================================================" -ForegroundColor Yellow
Write-Host "gocd-server container errors:" -ForegroundColor Yellow
Write-Host "====================================================================================" -ForegroundColor Yellow
docker logs gocd-server 2>&1 | Select-String -Pattern "(ERROR|Exception|failed|STDERR)" -CaseSensitive:$false -Context 3,5

Write-Host "====================================================================================" -ForegroundColor Yellow
Write-Host "gocd-agent-1 container errors:" -ForegroundColor Yellow
Write-Host "====================================================================================" -ForegroundColor Yellow
docker logs gocd-agent-1 2>&1 | Select-String -Pattern "(ERROR|Exception|failed|STDERR)" -CaseSensitive:$false -Context 3,5

Write-Host "====================================================================================" -ForegroundColor Yellow
Write-Host "gocd-agent-2 container errors:" -ForegroundColor Yellow
Write-Host "====================================================================================" -ForegroundColor Yellow
docker logs gocd-agent-2 2>&1 | Select-String -Pattern "(ERROR|Exception|failed|STDERR)" -CaseSensitive:$false -Context 3,5
