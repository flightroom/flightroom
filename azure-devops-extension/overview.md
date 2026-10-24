# Flightroom Azure DevOps Tasks

Use these Azure Pipelines tasks to upload a BUNDLE frontend or register a Docker image after it has been pushed.

The API key is sent in the `api-key` request header and must be a Flightroom MANAGER deploy key. It is never added to the request URL.

## Upload a frontend bundle

```yaml
- task: mfe-orchestrator-upload@1
  inputs:
    apiKey: $(FLIGHTROOM_API_KEY)
    microfrontendSlug: checkout
    domain: https://console.flightroom.dev
    filePath: $(Build.ArtifactStagingDirectory)/app
    version: $(Build.SourceBranchName)
```

## Register a pushed Docker image

Place this task after the Docker build-and-push step. `image` must be the full registry reference that was pushed. Select `frontend` only for a Flightroom DOCKER frontend; `backend` also covers maintenance agents.

```yaml
- task: flightroom-register-docker-image@1
  inputs:
    apiKey: $(FLIGHTROOM_API_KEY)
    domain: https://console.flightroom.dev
    resourceType: backend
    slug: orders-api
    version: $(Build.SourceBranchName)
    image: $(DOCKER_IMAGE)
    commitSha: $(Build.SourceVersion)
```

For a DOCKER frontend, set `resourceType: frontend`. `digest` and `commitSha` are optional.
