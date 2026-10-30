# GitHub Actions Workflows

This directory contains the CI/CD workflows for the Flightroom project.

## Available Workflows

### E2E Tests (`e2e-tests.yml`)

Runs end-to-end tests using Playwright.

**Triggers:**
- Manual trigger via GitHub Actions UI (`workflow_dispatch`)
- Push to the `e2e` branch
- Scheduled: Every Monday at 6:00 AM UTC

**What it does:**
1. Sets up the environment (Node.js 24, pnpm)
2. Installs project dependencies
3. Installs Playwright Chromium browser
4. Runs all E2E tests against `https://console-dev.flightroom.dev` (`BASE_URL`): no local dev server is started
5. Uploads test reports and results as artifacts (retained for 30 days)

**Secrets:** `TESTMAIL_API_KEY` and `TESTMAIL_NAMESPACE`. The test mailboxes live on testmail.app; without these two the tests that follow links received by email skip themselves.

**How to run manually:**
1. Go to the "Actions" tab in GitHub
2. Select "E2E Tests" workflow
3. Click "Run workflow"
4. Select the branch and click "Run workflow"

**Viewing test reports:**
After a workflow run completes, you can download the following artifacts:
- `playwright-report`: HTML report with detailed test results
- `test-results`: Raw test results and failure screenshots/videos

### Monorepo Build & Test (`monorepo-build.yml`)

Builds every package and runs the backend unit tests.

**Triggers:** push to `main` or `development`, manual, and `workflow_call` (docker-build runs it first).

**What it does:** installs with pnpm, runs `pnpm build` and `pnpm --filter @flightroom/backend test:coverage`, writes the coverage summary, and uploads the backend coverage and the backend and frontend builds as artifacts. The root `pnpm test` is not used because it would also run the e2e suite.

### Docker Build (`docker-build.yml`)

Builds and publishes the Docker images (standard and all-in-one) and, on a tag, the Helm chart and the GitHub release.

**Triggers:** push to `main` or `development`, push of any tag, manual, and `workflow_call`.

**What it does:** runs monorepo-build, lints the Helm chart and builds the images from its artifacts. On a tag it first refuses the release when the tag is not on `main`, when `CHANGELOG.md` has no `## [x.y.z]` section for it, or when the chart `appVersion` or `version` is not the tag or is already published; then it publishes the chart and creates the GitHub release with the notes taken from the changelog.

### Deploy to Server (`deploy.yml`)

Deploys the development installation.

**Triggers:** push to `development`, manual, and `workflow_call`.

**What it does:** runs docker-build, then connects over SSH to the server and runs `tofu init` and `tofu apply` in the infrastructure directory, passing the database URLs, the Azure Foundry key and the OpenShell client secret as variables.

## Adding New Workflows

When adding new workflows, follow these conventions:
- Use kebab-case for file names
- Add meaningful job names
- Use timeout-minutes to prevent hanging jobs
- Upload relevant artifacts for debugging
- Document the workflow in this README
