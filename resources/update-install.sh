#!/bin/sh
set -eu

if [ "${1:-}" = 'perform-mac' ]; then
  source_app=$2; target=$3; version=$4; token=$5
  case "$target" in /*/Hrrrwork.app) ;; *) exit 2 ;; esac
  stage="$target.update-$token"; backup="$target.previous-$token"
  [ ! -e "$stage" ] && [ ! -e "$backup" ]
  /usr/bin/ditto "$source_app" "$stage"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$stage/Contents/Info.plist")" = "$version" ]
  had_old=0
  if [ -d "$target" ]; then /bin/mv "$target" "$backup"; had_old=1; fi
  if ! /bin/mv "$stage" "$target"; then
    if [ "$had_old" = 1 ]; then /bin/mv "$backup" "$target"; fi
    exit 1
  fi
  if [ "$had_old" = 1 ]; then /bin/rm -r "$backup"; fi
  exit 0
fi

parent_pid=$1; installer=$2; target=$3; version=$4; token=$5; marker=$6; kind=$7
mount=''
finish() {
  result=$?
  if [ -n "$mount" ]; then /usr/bin/hdiutil detach "$mount" -quiet || true; /bin/rmdir "$mount" || true; fi
  if [ "$result" != 0 ]; then printf 'failed:%s' "$token" > "$marker"; fi
}
trap finish EXIT
wait_count=0
while kill -0 "$parent_pid" 2>/dev/null; do
  wait_count=$((wait_count + 1)); [ "$wait_count" -lt 120 ] || exit 1
  sleep 0.5
done
case "$kind" in
  mac)
    mount=$(mktemp -d "$(dirname "$installer")/mount.XXXXXX")
    /usr/bin/hdiutil attach "$installer" -nobrowse -readonly -mountpoint "$mount" -quiet
    source_app="$mount/Hrrrwork.app"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$source_app/Contents/Info.plist")" = "$version" ]
    /bin/mkdir -p "$(dirname "$target")"
    if [ -w "$(dirname "$target")" ]; then
      /bin/sh "$0" perform-mac "$source_app" "$target" "$version" "$token"
    else
      /usr/bin/osascript -e 'on run argv' -e 'do shell script "/bin/sh " & quoted form of (item 1 of argv) & " perform-mac " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv) & " " & quoted form of (item 4 of argv) & " " & quoted form of (item 5 of argv) with administrator privileges' -e 'end run' "$0" "$source_app" "$target" "$version" "$token"
    fi
    printf '%s' "$token" > "$marker"
    /usr/bin/open -n "$target"
    ;;
  deb)
    /usr/bin/pkexec /usr/bin/dpkg --install "$installer"
    printf '%s' "$token" > "$marker"
    "$target" --updated >/dev/null 2>&1 &
    ;;
  appimage)
    stage="$target.update-$token"
    [ ! -e "$stage" ]
    cp "$installer" "$stage"
    chmod 755 "$stage"
    mv -f "$stage" "$target"
    printf '%s' "$token" > "$marker"
    "$target" --updated >/dev/null 2>&1 &
    ;;
  *) exit 2 ;;
esac
