---
name: catman-ops
description: 管理员排查或维护宿主机程序、部署目录和 Docker 服务时使用。申请用户硬指令授权，通过临时运维容器执行命令和脚本。
---

# 宿主机运维

普通 Bash 在会话 worker 中，只能看到原有挂载。需要查看宿主部署目录、修改宿主文件、
操作宿主 Docker 或为自进化制备取得宿主权限时，使用此流程。只处理 workspace 或个人文件无需申请。

## 申请与等待

先运行 `catman-ops status`。已有授权就复用；部署未启用时告诉用户需要配置，不要尝试其他提权通道。
没有授权时运行 `catman-ops request '本次任务与需要查看或修改的资源'`。
挂载目录和 Docker socket 由部署配置决定，申请不能增加路径或权限。

系统向用户发送申请 ID、完整资源清单和授权硬指令。原样转述系统给出的指令，
请用户亲自发送，然后结束本轮等待。自然语言同意、你自己发出指令、
调用接口或让其他 agent 代发都不能代替用户授权；不要轮询或 sleep 等待。
普通用户和 cron 无法申请。用户授权后系统会将资源清单交回原会话，继续原任务。

## 连接与资源

授权后运行 `catman-ops connect`，读取控制面生成的清单：镜像、宿主源路径到容器路径、
读写模式、Docker socket、共享 workspace 和生命周期。以实际清单为准，不假设某目录一定存在。
凭证和固定主机公钥由工具写到当前 worker 的 /tmp，不要输出、复用到其他会话，
也不要放入 workspace、skill、credential 或 git。需要交互登录时使用输出的 SSH 命令；
自动执行优先用下面的封装，不要手写多层 SSH 转义或关闭主机校验。

```bash
# 程序与参数逐项传递；引号、空格等由工具处理
catman-ops exec -- docker ps --format '{{.Names}} {{.Status}}'
catman-ops exec -- ls -la /opt/services

# 多行脚本在 worker 的 workspace 编写，再传给运维容器的 bash 执行
cat > inspect.sh <<'SCRIPT'
set -euo pipefail
cd "$1"
pwd
ls -la
SCRIPT
catman-ops run inspect.sh /opt/services

# 也可从 stdin 传脚本。用带引号的 heredoc 防止 worker 提前展开变量
catman-ops run - /opt/services <<'SCRIPT'
set -euo pipefail
find "$1" -maxdepth 2 -name '*compose*' -print
SCRIPT
```

`exec` 执行单个程序，不解释管道、重定向或 `&&`；需要这些操作就写脚本用 `run`。
两种封装每次都检查当前授权，保留 stdout、stderr 和远端退出码，失败不会自动重试变更命令。
相对路径从共享 workspace 开始，worker 与运维容器里路径相同；脚本、备份与日志放在这里即可互见。
默认镜像带 Bash、git、curl、SSH/SCP、网络排查工具、Docker CLI/Compose；自定义镜像以实际工具为准。

## 使用挂载与 Docker

可先探索清单中的目录找服务配置。修改前检查实际文件、软链接、Compose 项目和卷，
保留要修改的配置副本，验证变更并报告结果。只读挂载不能修改；不在清单里的宿主路径不可直接访问。
运维容器不是宿主的进程命名空间或 init 系统，容器内的 /etc、/root、进程列表也不是宿主的。
`host.docker.internal` 只是宿主网关地址，不提供宿主 SSH 凭据。

只有清单含 Docker socket 才能管理宿主 Docker，它相当于宿主 root 权限，操作仍以用户交办的任务为范围。
Docker bind mount 的 source 由宿主 daemon 解析；Compose 中的路径先在运维容器解析，
再交给 daemon，因此以清单中的宿主源路径核对卷，尤其是映射到不同 target 的目录。
不要为补工具或绕过缺失挂载而新建特权容器。需要长期运行的服务，应明确部署与验证，
不要把它当成临时 shell 后台进程留在运维容器。

## 结束与中断

运维容器不设独立时限，与原会话容器同生共死；会话原有的闲置预警与回收仍生效。
原容器回收或重建，SSH、远端进程和授权一起失效，新容器必须重新申请。
用户可用系统清单中的回收硬指令提前回收；当前会话的清单也可用 `catman-ops status` 查看。
连接断开或命令失败后，先检查实际状态再决定后续操作；不要直接重跑可能已部分生效的变更。
回收保留 workspace，不撤销宿主修改，也不删除另行部署的服务。
