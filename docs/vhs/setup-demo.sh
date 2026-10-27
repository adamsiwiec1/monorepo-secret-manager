#!/bin/sh
# Builds a throwaway npm workspace with fake values for the VHS tapes.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
D=/tmp/msm-vhs-demo
rm -rf "$D" && mkdir -p "$D/apps/api" "$D/apps/web" && cd "$D" && git init -q
echo '{"name":"demo","private":true,"workspaces":["apps/*"]}' > package.json
for p in api web; do echo "{\"name\":\"$p\",\"version\":\"1.0.0\"}" > "apps/$p/package.json"; done
printf 'API_URL=https://api.example.test\nAPI_TOKEN=demo-not-a-secret\n' > apps/api/.env.stg
printf 'PUBLIC_SITE=https://example.test\n' > apps/web/.env.stg
mkdir -p /tmp/msm-vhs-bin
printf '#!/bin/sh\nexec node %s/dist/cli.js "$@"\n' "$ROOT" > /tmp/msm-vhs-bin/msm
chmod +x /tmp/msm-vhs-bin/msm
