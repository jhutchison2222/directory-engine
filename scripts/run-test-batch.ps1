# Publish-queue test batch -- restaurants site, 3 real listings
#
# Fill in your Worker URL and both keys below (same ones you've used for
# every other test this session), then run this whole file in PowerShell.
#
# What it does: calls POST /v1/write/publish-queue/:id/process for queue
# entries 1, 2, and 3 -- three real restaurant listings already queued for
# the "restaurants" site. Each call:
#   1. Looks up (or auto-creates) the listing's GeoDirectory category on
#      restaurants.directory-engine.net, using the Consumer Key/Secret.
#   2. Creates the actual WordPress post via geodir/v2/places, using the
#      Application Password credential.
#   3. Records the result on listing_site_links and removes the queue entry
#      (success or failure -- there's no retry queue yet).
#
# New posts are created as WordPress status "draft" by default (not
# published live) -- that's intentional for this first real test batch, so
# nothing goes public until you've reviewed the results in wp-admin.

$workerUrl = "https://YOUR-WORKER-URL-HERE"
$readKey   = "YOUR-DIRECTORY-ENGINE-API-KEY"
$writeKey  = "YOUR-DIRECTORY-ENGINE-WRITE-API-KEY"

$headers = @{
  "X-Directory-Engine-Key"       = $readKey
  "X-Directory-Engine-Write-Key" = $writeKey
  "Content-Type"                 = "application/json"
}

foreach ($id in 1, 2, 3) {
  Write-Host "`n--- Processing publish_queue id $id ---"
  try {
    $response = Invoke-WebRequest -Uri "$workerUrl/v1/write/publish-queue/$id/process" `
      -Method POST -Headers $headers -Body "{}"
    Write-Host $response.Content
  } catch {
    Write-Host "FAILED:" $_.Exception.Response.StatusCode $_.ErrorDetails.Message
  }
}
