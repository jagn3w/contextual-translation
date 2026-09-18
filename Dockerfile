# syntax=docker/dockerfile:1
# One image for the whole app (design D5.3): a Node stage builds the Vite SPA, a Ruby stage
# installs gems, and the final stage runs Rails, which also serves the built frontend (D1.6).
#
# Built on the owner's machine for the x86 EC2 host — see bin/release:
#   docker buildx build --platform linux/amd64 -t <image> .

ARG RUBY_VERSION=3.4.10
ARG NODE_VERSION=22

# --- Frontend: build the SPA ------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS frontend
WORKDIR /frontend
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
COPY frontend/app/package.json app/
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# --- Ruby base shared by the build and runtime stages -----------------------------------------
FROM ruby:${RUBY_VERSION}-slim AS base
WORKDIR /rails
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y curl libjemalloc2 libpq5 libyaml-0-2 \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives
ENV RAILS_ENV=production \
    BUNDLE_DEPLOYMENT=1 \
    BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_WITHOUT=development:test

# --- Gems and app code --------------------------------------------------------------------------
FROM base AS build
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y build-essential git libpq-dev libyaml-dev pkg-config \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives
COPY backend/Gemfile backend/Gemfile.lock ./
RUN bundle install \
  && rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git \
  && bundle exec bootsnap precompile --gemfile
COPY backend/ ./
RUN bundle exec bootsnap precompile app/ lib/

# --- Runtime ------------------------------------------------------------------------------------
FROM base
RUN groupadd --system --gid 1000 rails \
  && useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash
COPY --from=build "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=build --chown=rails:rails /rails /rails
# index.html is served by SpaController (no-cache); hashed assets by the static file server.
COPY --from=frontend --chown=rails:rails /frontend/app/dist/index.html /rails/spa/index.html
COPY --from=frontend --chown=rails:rails /frontend/app/dist/assets /rails/public/assets
USER 1000:1000

# The entrypoint runs db:prepare before the server starts.
ENTRYPOINT ["/rails/bin/docker-entrypoint"]
EXPOSE 3000
CMD ["./bin/rails", "server", "-b", "0.0.0.0", "-p", "3000"]
