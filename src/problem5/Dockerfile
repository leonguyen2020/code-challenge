# ---------------------------------------------------------------------------
# Multi-stage build.
#
# The build stage needs TypeScript, the type definitions and the whole dev
# toolchain; the runtime image needs none of it. Shipping them anyway means a
# larger image, a slower pull, and a much wider set of packages that a CVE
# scanner can flag - for code that never executes in production.
# ---------------------------------------------------------------------------

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first. This layer only changes when a dependency changes, so
# the (slow) install is cached across the (frequent) source edits below.
COPY package.json package-lock.json ./
# `npm ci` installs exactly the lockfile, so the image cannot drift from what
# was tested. `npm install` would happily resolve a newer transitive version.
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Discard dev dependencies now that the build is done.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Run as an unprivileged user. The node image ships a `node` user for exactly
# this; running as root means a code-execution bug becomes root-in-container,
# which is a far shorter path to root-on-host.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node

EXPOSE 3000

# Uses the liveness endpoint, which deliberately checks nothing external - see
# routes/health.ts for why a liveness probe must not test the database.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node dist/main.js` directly, not `npm start`: npm sits between the init
# system and the process, and does not forward SIGTERM - so graceful shutdown
# never runs and every deploy drops in-flight requests.
CMD ["node", "dist/main.js"]
