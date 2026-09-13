# Foolscap Notary — the one long-lived process in this repository.
#
# WHY A CONTAINER AND NOT A SERVERLESS FUNCTION. Two reasons, either one
# sufficient: the mirror holds a Technocore long-poll open for minutes at a
# time, and every cold start would open a Postgres connection it then abandons.
# Supabase counts those. The rest of Foolscap is static and stays on Vercel;
# this part runs on Railway or Fly, where a process is allowed to stay up.
#
# Node 24 because that is the version this was built and exercised against.
# `--experimental-strip-types` runs the TypeScript directly rather than building
# to JavaScript first — the same thing the local scripts do, so what runs in
# production is the file you edited. Type stripping has moved between 22 and 24;
# pinning to the tested runtime is cheaper than discovering the difference in a
# deploy log.

FROM node:24-alpine

WORKDIR /app

# The workspace root manifests first, so `npm ci` is cached until a dependency
# actually changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY services/notary/package.json services/notary/package.json

# --omit=dev: the service needs `pg` and nothing else at runtime. TypeScript is
# a devDependency and the types are stripped, not checked, at startup — the
# checking happens in CI and in `npm run typecheck`.
#
# No --include-workspace-root: the root's dependencies are React, three and the
# rest of the site, and the service imports none of them. Its only reach outside
# its own directory is src/lib, which is plain TypeScript importing nothing but
# itself — verified, not assumed.
RUN npm ci --omit=dev --workspace @foolscap/notary

COPY services/notary ./services/notary
# The service imports the Technocore client, the DID helpers and the contest
# room list from the site's own source. That is deliberate — one client, not
# two — so the image needs them.
COPY src/lib ./src/lib

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Capture is the point. A container that serves the API without sweeping is an
# archive that stops growing, so this defaults on and the platform can turn it
# off rather than having to know to turn it on.
ENV NOTARY_RUN_MIRROR=1

# The server starts the mirror itself when NOTARY_RUN_MIRROR=1.
CMD ["npm", "run", "serve", "--workspace", "services/notary"]
