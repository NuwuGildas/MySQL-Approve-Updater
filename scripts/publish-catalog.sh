#!/usr/bin/env bash
# Rebuild the marketplace catalog from every module release and publish it.
#
# Run by the catalog job of each module's workflow, right after that module's
# release, and by .github/workflows/catalog.yml by hand. Needs `gh` authenticated
# (GH_TOKEN) and a checkout of the default branch, for scripts/build-catalog.js.
#
# Several modules released at once each run this. They are deliberately NOT
# serialised with a concurrency group: GitHub cancels the superseded runs in a
# group, which paints them red and hides real failures. Instead every pass
# checks what it actually published and goes round again if a sibling's release
# landed in the meantime, so any interleaving converges on a complete catalog.
set -euo pipefail

server="${GITHUB_SERVER_URL:-https://github.com}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
catalog_url="$server/$repo/releases/download/catalog/catalog.json"

# The module ids a catalog document names, sorted, space separated.
ids_of() { node -e "
  let s = '';
  process.stdin.on('data', (d) => { s += d; })
    .on('end', () => {
      try { console.log(JSON.parse(s).modules.map((m) => m.id).sort().join(' ')); }
      catch { console.log(''); }
    });
"; }

for pass in 1 2 3; do
  rm -rf artifacts && mkdir -p artifacts
  released=""
  for tag in $(gh release list --limit 200 --json tagName --jq '.[].tagName'); do
    case "$tag" in *-v*) ;; *) continue ;; esac      # the catalog's own release is not a module
    if gh release download "$tag" --pattern '*.json' --dir artifacts --clobber 2>/dev/null; then
      released="$released ${tag%-v*}"
    else
      echo "::warning::$tag has no module description asset; skipped"
    fi
  done
  if [ -z "$released" ]; then
    echo "::error::no module releases found. Push a tag like servers-v1.0.0 to cut one."
    exit 1
  fi
  expected=$(printf '%s\n' $released | sort -u | tr '\n' ' ' | sed 's/ *$//')

  node scripts/build-catalog.js \
    --dir artifacts \
    --out catalog.json \
    --name "Server Tools modules" \
    --url-template "$server/$repo/releases/download/{id}-v{version}/{file}"

  # An unsigned entry would offer users a version the application then refuses
  # to install. Better to fail here, and say why.
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

  if gh release view catalog >/dev/null 2>&1; then
    gh release upload catalog catalog.json --clobber
  else
    gh release create catalog catalog.json --title "Module catalog" \
      --notes "The marketplace catalog, rebuilt whenever a module is released. An installation finds it at $catalog_url"
  fi

  sleep 5   # the asset is served from a CDN; give the replacement a moment
  published=$(curl -fsSL "$catalog_url" | ids_of || echo '')
  echo "pass $pass: published [$published] / released [$expected]"
  if [ "$published" = "$expected" ]; then
    echo "the catalog offers every released module: $catalog_url"
    exit 0
  fi
  echo "a release landed while this was building; going round again"
done

echo "::error::the published catalog does not list every released module after 3 passes"
exit 1
