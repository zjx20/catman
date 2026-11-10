#!/bin/sh
set -eu
mkdir -p /run/sshd
pwd > /run/catman-ops-workspace
# 私钥和 authorized_keys 每次授权独立生成，由控制面只读挂载。
# 不采用镜像默认 sshd_config，避免密码、转发或持久密钥意外生效。
exec /usr/sbin/sshd -D -e -f /dev/null -p 2222 -o "ListenAddress=$(hostname -i)" \
  -h /run/catman-ops/host_key \
  -o AuthorizedKeysFile=/run/catman-ops/client_key.pub \
  -o PidFile=/run/sshd.pid \
  -o PubkeyAuthentication=yes \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o PermitEmptyPasswords=no \
  -o PermitRootLogin=prohibit-password \
  -o UsePAM=no \
  -o StrictModes=no \
  -o DisableForwarding=yes \
  -o PermitUserRC=no \
  -o ForceCommand=/usr/local/bin/catman-ops-shell \
  -o "Subsystem=sftp /usr/lib/openssh/sftp-server"
