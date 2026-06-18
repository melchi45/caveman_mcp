#!/bin/sh
# caveman-mcp watchdog — crontab에서 1분마다 실행
# health endpoint 확인 후 응답 없으면 서버 재시작

PATH=/home/youngho/.local/bin:/usr/local/bin:/usr/bin:/bin
export PATH

WORKDIR="/data6/youngho/workspace/caveman_mcp"
SERVER_SCRIPT="src/mcp-servers/caveman-mode/index.js"
LOGFILE="/var/log/caveman-mcp.log"
HEALTH_URL="http://localhost:3100/health"
NODE="/home/youngho/.local/bin/node"

if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] caveman-mcp not responding — restarting" >> "$LOGFILE"

# 잔여 프로세스 정리
pkill -f "caveman-mode/index.js" 2>/dev/null
sleep 1

# 재시작
cd "$WORKDIR" && nohup "$NODE" "$SERVER_SCRIPT" >> "$LOGFILE" 2>&1 &

echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] restarted (PID $!)" >> "$LOGFILE"
