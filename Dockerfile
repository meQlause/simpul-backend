# One image for the four roles (be-stack B-8): PROCESS_ROLE picks api, webhook, worker or
# scheduler at run time; `node dist/server.js migrate-databases` and `create-workspace` run as jobs.
FROM node:24.21.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.21.0-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations are read from beside dist/ (src/platform/db/migrate-tenant.ts).
COPY drizzle ./drizzle
USER node
CMD ["node", "dist/server.js"]
