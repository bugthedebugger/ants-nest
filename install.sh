#!/bin/sh
set -eu

repository="bugthedebugger/ants-nest"
mode="${1:---cli-only}"
marker="# Managed by Ants Nest CLI installer"

case "$mode" in
  --cli-only|--all) ;;
  *) echo "Usage: install.sh [--cli-only|--all]" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  echo "Ants Nest automatic installation currently supports Linux." >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) echo "The published Ants Nest artifacts currently support Linux x86_64 only." >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }

home_directory="${HOME:?HOME is required}"
bin_directory="$home_directory/.local/bin"
data_home="${XDG_DATA_HOME:-$home_directory/.local/share}"
app_directory="$data_home/ants-nest"
applications_directory="$data_home/applications"
app_image="$app_directory/Ants Nest.AppImage"
cli_script="$app_directory/cli.cjs"
icon_file="$app_directory/icon.png"
desktop_entry="$applications_directory/ants-nest.desktop"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/ants-nest-install.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

for launcher in "$bin_directory/ants" "$bin_directory/ants-nest"; do
  if [ -e "$launcher" ] && ! grep -Fq "$marker" "$launcher"; then
    echo "$launcher already exists and is not managed by Ants Nest. Move or remove it first." >&2
    exit 1
  fi
done
if [ "$mode" = "--all" ] && [ -e "$desktop_entry" ] && ! grep -Fq "$marker" "$desktop_entry"; then
  echo "$desktop_entry already exists and is not managed by Ants Nest. Move or remove it first." >&2
  exit 1
fi

release_json="$temporary_directory/release.json"
curl -fsSL "https://api.github.com/repos/$repository/releases/latest" -o "$release_json"
release_tag="$(sed -n 's/^[[:space:]]*"tag_name": "\([^"]*\)".*/\1/p' "$release_json" | head -n 1)"
[ -n "$release_tag" ] || { echo "Could not determine the latest Ants Nest release." >&2; exit 1; }
version="${release_tag#v}"

asset_value() {
  asset_name="$1"
  field="$2"
  awk -v wanted="$asset_name" -v field="$field" '
    index($0, "\"name\": \"" wanted "\"") { found=1 }
    found && index($0, "\"" field "\":") {
      value=$0
      sub(/^.*: "/, "", value)
      sub(/".*$/, "", value)
      print value
      exit
    }
  ' "$release_json"
}

download_verified() {
  asset_name="$1"
  destination="$2"
  asset_url="$(asset_value "$asset_name" browser_download_url)"
  asset_digest="$(asset_value "$asset_name" digest)"
  [ -n "$asset_url" ] || { echo "Release $release_tag does not contain $asset_name." >&2; exit 1; }
  curl -fL --retry 3 "$asset_url" -o "$destination"
  case "$asset_digest" in
    sha256:*) expected_digest="${asset_digest#sha256:}" ;;
    *) echo "GitHub did not provide a SHA-256 digest for $asset_name; refusing installation." >&2; exit 1 ;;
  esac
  actual_digest="$(sha256sum "$destination" | awk '{print $1}')"
  [ "$actual_digest" = "$expected_digest" ] || { echo "SHA-256 verification failed for $asset_name." >&2; exit 1; }
}

mkdir -p "$bin_directory" "$app_directory"
chmod 700 "$app_directory"

if [ "$mode" = "--cli-only" ]; then
  command -v node >/dev/null 2>&1 || { echo "CLI-only installation requires Node.js 22 or newer. Use --all for a Node-free installation." >&2; exit 1; }
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [ "$node_major" -ge 22 ] || { echo "CLI-only installation requires Node.js 22 or newer. Use --all instead." >&2; exit 1; }
  node_path="$(command -v node)"
  download_verified "ants-nest-cli.cjs" "$temporary_directory/cli.cjs"
  install -m 600 "$temporary_directory/cli.cjs" "$cli_script"
  for launcher in "$bin_directory/ants" "$bin_directory/ants-nest"; do
    cat > "$temporary_directory/launcher" <<EOF
#!/bin/sh
$marker
# ants-nest-cli mode=repository version=$version
exec "$node_path" "$cli_script" "\$@"
EOF
    install -m 755 "$temporary_directory/launcher" "$launcher"
  done
else
  app_asset="$(awk '/"name": "Ants.Nest-.*.AppImage"/ { value=$0; sub(/^.*"name": "/, "", value); sub(/".*$/, "", value); print value; exit }' "$release_json")"
  [ -n "$app_asset" ] || { echo "The latest release does not contain a Linux AppImage." >&2; exit 1; }
  download_verified "$app_asset" "$temporary_directory/Ants-Nest.AppImage"
  download_verified "ants-nest-icon.png" "$temporary_directory/icon.png"
  install -m 755 "$temporary_directory/Ants-Nest.AppImage" "$app_image"
  install -m 644 "$temporary_directory/icon.png" "$icon_file"
  for launcher in "$bin_directory/ants" "$bin_directory/ants-nest"; do
    cat > "$temporary_directory/launcher" <<EOF
#!/bin/sh
$marker
# ants-nest-cli mode=appimage version=$version
unset ELECTRON_RUN_AS_NODE
exec "$app_image" --cli "\$@"
EOF
    install -m 755 "$temporary_directory/launcher" "$launcher"
  done
  mkdir -p "$applications_directory"
  cat > "$temporary_directory/ants-nest.desktop" <<EOF
[Desktop Entry]
$marker
Type=Application
Name=Ants Nest
Comment=Local-first Cloudflare Tunnel manager
Exec="$app_image"
Icon=$icon_file
Terminal=false
Categories=Development;Network;
StartupWMClass=ants-nest
EOF
  install -m 644 "$temporary_directory/ants-nest.desktop" "$desktop_entry"
fi

echo "Installed Ants Nest $version ($mode)."
echo "Commands: $bin_directory/ants and $bin_directory/ants-nest"
case ":${PATH:-}:" in
  *":$bin_directory:"*) ;;
  *) echo "Add $bin_directory to PATH, then open a new terminal." ;;
esac
