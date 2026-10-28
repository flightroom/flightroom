# syntax=docker/dockerfile:1
# Production Image with Nginx

# ---------------------------------------------------------------------------
# Stage 1 - production dependencies of the backend
# ---------------------------------------------------------------------------
# The dependencies are resolved from the workspace lockfile, like in
# Dockerfile.all-in-one, so the image ships the versions the monorepo was built
# and tested with. The stage starts from the same image as the runtime, so the
# node that runs them is the one they were installed with. npm, pnpm and the
# pnpm store stay here: the runtime ships none of them.
FROM nginx:alpine AS backend-deps

# pnpm must be pinned to the same version as the "packageManager" field of the
# workspace: an unpinned install now resolves to pnpm 11, which tries to
# self-switch to the pinned 10.x release and fails on Alpine, because
# @pnpm/exe@10.x publishes no musl platform binary ("Cannot verify the identity
# of the @pnpm/exe.linux-x64 native binary: it is missing from pnpm-lock.yaml").
ARG PNPM_VERSION=10.19.0
RUN apk add --no-cache nodejs npm && \
    npm install -g pnpm@${PNPM_VERSION}

# The pinned version is a deliberate choice, so the "Update available!" banner
# is just noise in the build log: pnpm only hides it on its own when it detects
# a CI environment, which a `docker build` is not.
# Both spellings are set on purpose: pnpm 10 reads settings from the npm-style
# `NPM_CONFIG_*` variables, while pnpm 11 only reads its own `PNPM_CONFIG_*`
# prefix. This way bumping PNPM_VERSION does not bring the banner back.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    PNPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /var/www

# Only the manifests are copied, so this layer is rebuilt just when a
# dependency changes and not at every source change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY e2e/package.json e2e/

# The OpenShell SDK (@nvidia) is published on GitHub Packages, which asks for a
# token even to read a public package: pass one with read:packages as the
# build secret npm_token (docker build --secret id=npm_token,env=GITHUB_TOKEN).
# It is read from the secret mount and written to a user config removed in the
# same step, so it never ends up in a layer.
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN \
    echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > /root/.npmrc && \
    pnpm install --filter @flightroom/backend --prod --frozen-lockfile --ignore-scripts; \
    status=$?; rm -f /root/.npmrc; exit $status

# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM nginx:alpine

# Node.js only, without npm: the backend never runs a package manager. The
# upgrade picks up the Alpine fixes released after the base image was built.
RUN apk upgrade --no-cache && apk add --no-cache nodejs

# Every request reaches the backend through the nginx of this image, from the
# loopback: trusting that one hop gives the backend the real client IP for its
# per-IP rate limits, and an X-Forwarded-For sent by the client cannot spoof it.
ENV TRUST_PROXY=127.0.0.1

# Create application directories
RUN mkdir -p /var/www/frontend /var/www/backend /repositories

# Copy Nginx configuration
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf

# Production node_modules of stage 1. The two directories keep the layout they
# had in the builder, because pnpm links them with relative symlinks.
COPY --from=backend-deps /var/www/node_modules /var/www/node_modules
COPY --from=backend-deps /var/www/backend/node_modules /var/www/backend/node_modules

# Copy built frontend
COPY frontend/dist/ /var/www/frontend/

# Copy built backend
COPY backend/dist/ /var/www/backend/

# Expose port 80
EXPOSE 80
EXPOSE 27017
EXPOSE 8443

WORKDIR /var/www/

# Start script that will run both backend and nginx
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Start the application
CMD ["/start.sh"]
