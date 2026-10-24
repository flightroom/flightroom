# Flightroom Azure DevOps extension

The extension packages two pipeline tasks, based on the MIT-licensed MFE Orchestrator upload extension:

- `mfe-orchestrator-upload@1` zips and uploads a BUNDLE frontend.
- `flightroom-register-docker-image@1` registers a Docker image that a preceding pipeline step has pushed.

The Docker task posts to Flightroom's backend or Docker frontend version-registration endpoint. It accepts the API key as a secret task input and sends it in the `api-key` header.

## Build and check

From the monorepo root:

```bash
pnpm --filter @flightroom/azure-devops-extension typecheck
pnpm --filter @flightroom/azure-devops-extension test
pnpm --filter @flightroom/azure-devops-extension build
```

To package a VSIX, set `AZURE_PUBLISHER_ID` to the Azure DevOps Marketplace publisher and run:

```bash
pnpm --filter @flightroom/azure-devops-extension package
```

See [overview.md](./overview.md) for task examples.
