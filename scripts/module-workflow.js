'use strict';
/* The per-module CI workflow, written into each module package by
   scripts/scaffold-module.js. Exported separately so the template stays
   readable: it is YAML with one substitution. */

module.exports = (id) => `# Build, test and publish the ${id} module.
#
# This branch holds one standalone package. The package is checked out INTO a
# checkout of the application's default branch, at modules/${id}, which is
# exactly where the documented local workflow puts it: the host supplies the
# build tooling, the host SDK to validate against, and the shared libraries a
# module resolves at runtime. Nothing here is installed from a moving branch -
# CI produces a versioned, signed archive and a release points at it.
name: ${id}

on:
  push:
    branches: [modules/${id}]
    tags: ['${id}-v*']
  pull_request:
    branches: [modules/${id}]
  workflow_dispatch:

# Tagging publishes: the job attaches this package to a GitHub release, which
# needs write access to the repository's contents. The repository's default
# token is read-only, so the permission is requested here rather than relying on
# a setting - without it the release step fails with "Resource not accessible by
# integration" after a build that otherwise succeeded.
permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # The host first: it owns the tooling and the SDK this package targets.
      - uses: actions/checkout@v4
        with:
          ref: master
          path: host

      # Then this package, in the place the host expects to find it.
      - uses: actions/checkout@v4
        with:
          path: host/modules/${id}

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: host/package-lock.json

      - name: Install host tooling
        working-directory: host
        run: npm ci

      - name: Check the manifest against this host SDK
        working-directory: host
        run: |
          node -e "
            const { validateManifest } = require('./lib/host/manifest');
            const { HOST_SDK_VERSION } = require('./lib/host/sdk');
            const m = validateManifest(require('./modules/${id}/module.json'));
            if (!m.compatible) throw new Error(m.name + ' declares hostSdk ' + m.hostSdk + ', which host SDK ' + HOST_SDK_VERSION + ' does not satisfy');
            console.log(m.id, m.version, 'is compatible with host SDK', HOST_SDK_VERSION);
          "

      - name: Test
        working-directory: host
        run: node scripts/test-modules.js ${id}

      - name: Build the package
        working-directory: host
        env:
          SIGNING_KEY: \${{ secrets.MODULE_SIGNING_KEY }}
          SIGNING_KEY_ID: \${{ vars.MODULE_SIGNING_KEY_ID }}
        run: |
          mkdir -p keys
          if [ -n "$SIGNING_KEY" ]; then
            printf '%s' "$SIGNING_KEY" > keys/ci.private.pem
            SIGN="--sign keys/ci.private.pem --key-id \${SIGNING_KEY_ID:-ci}"
          else
            echo "::warning::MODULE_SIGNING_KEY is not set; building an UNSIGNED package that the host will refuse to install"
            SIGN=""
          fi
          node scripts/build-module.js ${id} \\
            --out ../artifacts \\
            --commit "\${{ github.sha }}" \\
            --branch "modules/${id}" \\
            --repository "\${{ github.server_url }}/\${{ github.repository }}" \\
            $SIGN
          rm -f keys/ci.private.pem

      - uses: actions/upload-artifact@v4
        with:
          name: ${id}-package
          path: artifacts/*

      # A tag is what publishes: the archive becomes a release asset, and the
      # catalog entry that points at it is updated from the same artifact file.
      - name: Release
        if: startsWith(github.ref, 'refs/tags/${id}-v')
        uses: softprops/action-gh-release@v2
        with:
          files: artifacts/*

  # The marketplace catalog, rebuilt from every module release once this one is
  # published. It lives here rather than in a workflow of its own on master,
  # because a tag push only runs workflows that exist in the TAGGED commit - and
  # these tags point into this module branch, which carries only this file. (An
  # \`on: release\` workflow would not help either: a release created with
  # GITHUB_TOKEN raises no event that starts another workflow.)
  #
  # The concurrency group is shared by every module's copy of this job, so two
  # modules released at once publish the catalog one after the other instead of
  # overwriting one another.
  catalog:
    needs: build
    if: startsWith(github.ref, 'refs/tags/${id}-v')
    runs-on: ubuntu-latest
    concurrency:
      group: module-catalog
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          ref: master
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci

      # Every released module's description file. "<id>-v<version>" is the tag
      # shape a module release uses; the catalog's own release is not one.
      - name: Collect every released module
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          mkdir -p artifacts
          found=0
          for tag in $(gh release list --limit 200 --json tagName --jq '.[].tagName'); do
            case "$tag" in *-v*) ;; *) continue ;; esac
            if gh release download "$tag" --pattern '*.json' --dir artifacts --clobber 2>/dev/null; then
              echo "collected $tag"
              found=$((found + 1))
            else
              echo "::warning::$tag has no module description asset; skipped"
            fi
          done
          [ "$found" -gt 0 ] || { echo "::error::no module releases found"; exit 1; }

      - name: Build the catalog
        run: |
          node scripts/build-catalog.js \\
            --dir artifacts \\
            --out catalog.json \\
            --name "Server Tools modules" \\
            --url-template '\${{ github.server_url }}/\${{ github.repository }}/releases/download/{id}-v{version}/{file}'

      # An unsigned entry would offer users a version the application then
      # refuses to install. Better to fail here, and say why.
      - name: Refuse to publish an unsigned catalog
        run: |
          node -e "
            const catalog = require('./catalog.json');
            const bad = catalog.modules.flatMap((m) => m.versions.filter((v) => !v.package.signature).map((v) => m.id + ' ' + v.version));
            if (bad.length) {
              console.error('unsigned: ' + bad.join(', '));
              console.error('Set the MODULE_SIGNING_KEY secret and MODULE_SIGNING_KEY_ID variable, then release again.');
              process.exit(1);
            }
            console.log(catalog.modules.length + ' module(s), every version signed');
          "

      - name: Publish it at one unchanging URL
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          if gh release view catalog >/dev/null 2>&1; then
            gh release upload catalog catalog.json --clobber
          else
            gh release create catalog catalog.json --title "Module catalog" \\
              --notes "The marketplace catalog, rebuilt whenever a module is released."
          fi
          echo "published \${{ github.server_url }}/\${{ github.repository }}/releases/download/catalog/catalog.json"
`;
