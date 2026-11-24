#!/bin/sh
set -eu

# 一个容器就是一个远程真实浏览器工作站：Xvfb 提供完整 GUI Chrome 所需的 X server，
# Node 服务统一提供 API、响应式 /browser 操控页与 CDP 帧流 /ws/browser。
config_source="${BROWSER_CONFIG_SOURCE:-/app/browser-config.json}"
display_number="${BROWSER_DISPLAY_NUMBER:-0}"
screen_size="${BROWSER_SCREEN_SIZE:-1440x900x24}"
window_size="${BROWSER_WINDOW_SIZE:-${screen_size%x*}}"
children=""
node_pid=""

fail() {
  echo "$1" >&2
  exit 2
}

case "$display_number" in
  ''|*[!0-9]*) fail "BROWSER_DISPLAY_NUMBER must be a non-negative integer" ;;
esac
echo "$screen_size" | grep -Eq '^[0-9]+x[0-9]+x[0-9]+$' \
  || fail "BROWSER_SCREEN_SIZE must look like 1440x900x24"
echo "$window_size" | grep -Eq '^[0-9]+x[0-9]+$' \
  || fail "BROWSER_WINDOW_SIZE must look like 1440x900"

# Docker 以 root 进入只做两件事：把只读挂载的配置放进可写 volume、修正数据属主，
# 然后立即降权到 pimuse。浏览器、X server 和 Node 服务都不以 root 运行。
if [ "$(id -u)" -eq 0 ]; then
  [ -f "$config_source" ] || fail "Missing browser config file: $config_source"
  run_uid="$(id -u pimuse)"
  run_gid="$(id -g pimuse)"
  # setpriv 只换 uid/gid，不切登录环境；Chrome 的 crashpad/profile 需要 pimuse 的 HOME。
  HOME=/home/pimuse
  USER=pimuse
  export HOME USER
  mkdir -p /app/.pi-muse
  install -d -m 1777 /tmp/.X11-unix
  install -o pimuse -g pimuse -m 0600 "$config_source" /app/.pi-muse/config.json
  chown -R pimuse:pimuse /app/.pi-muse
  exec setpriv \
    --reuid="$run_uid" \
    --regid="$run_gid" \
    --init-groups \
    "$0" --child
fi
if [ "${1:-}" != "--child" ] || [ "$(id -u)" -ne "$(id -u pimuse)" ]; then
  fail "This entrypoint must run as root and drop privileges to pimuse"
fi

cleanup() {
  status=$?
  trap - EXIT INT TERM
  # Node 必须先在仍然存活的 X server 上关闭 Chrome 并完成 profile 写入。
  # 等待本身不设超时；超过 Docker stop grace 时由 Docker 最终硬终止容器。
  if [ -n "$node_pid" ]; then
    kill -TERM "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
    node_pid=""
  fi
  if [ -n "$children" ]; then
    # shellcheck disable=SC2086
    kill $children 2>/dev/null || true
    # shellcheck disable=SC2086
    wait $children 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

display=":${display_number}"
x_socket="/tmp/.X11-unix/X${display_number}"
x_lock="/tmp/.X${display_number}-lock"
rm -f "$x_socket" "$x_lock"

Xvfb "$display" -screen 0 "$screen_size" -ac -nolisten tcp &
xvfb_pid=$!
children="$children $xvfb_pid"

ready=0
i=0
while [ "$i" -lt 100 ]; do
  if [ -S "$x_socket" ] && kill -0 "$xvfb_pid" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    fail "Xvfb exited before the X socket became ready"
  fi
  sleep 0.1
  i=$((i + 1))
done
[ "$ready" -eq 1 ] || fail "Xvfb did not become ready"

export DISPLAY="$display"
export BROWSER_WINDOW_SIZE="$window_size"
# 容器重建会硬终止旧 Chrome；这些 singleton 文件只表示旧进程锁，不代表浏览数据。
rm -f /app/.pi-muse/runtime/browser/profile/SingletonCookie \
  /app/.pi-muse/runtime/browser/profile/SingletonLock \
  /app/.pi-muse/runtime/browser/profile/SingletonSocket
echo "pi-muse browser container ready: API port 12330, viewer /browser, display ${display}"
node dist/index.js &
node_pid=$!
api_ready=0
i=0
while [ "$i" -lt 300 ]; do
  if curl -fsS http://127.0.0.1:12330/api/health >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  if ! kill -0 "$node_pid" 2>/dev/null; then
    fail "Node service exited before API health became ready"
  fi
  sleep 0.1
  i=$((i + 1))
done
[ "$api_ready" -eq 1 ] || fail "API health did not become ready"

# 触发一次标签列表唤醒真实 Chrome，确保打开 /browser 时立即可见；
# token 只留在这个短生命周期 Node 进程内，不写入参数、日志或镜像。
if ! node <<'NODE'
const { readFile } = require("node:fs/promises");
const main = async () => {
  const config = JSON.parse(await readFile("/app/.pi-muse/config.json", "utf8"));
  const login = await fetch("http://127.0.0.1:12330/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: config.server?.accessKey ?? "" }),
  });
  if (!login.ok) throw new Error(`browser session login failed: ${login.status}`);
  const { token } = await login.json();
  const tabs = await fetch("http://127.0.0.1:12330/api/browser/tabs", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!tabs.ok) throw new Error(`browser startup failed: ${tabs.status}`);
};
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
then
  fail "Unable to start the real Chrome window"
fi
wait "$node_pid"
node_pid=""
