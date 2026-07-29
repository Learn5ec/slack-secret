#!/bin/bash
# Stop all secret-bot services

echo "=== Stopping Secret Bot Services ==="

# Stop Secret Bot
echo -n "Secret Bot... "
if pgrep -f "tsx.*src/index.ts" >/dev/null 2>&1; then
    PID=$(pgrep -f 'tsx.*src/index.ts')
    kill $PID
    echo "Stopped (PID: $PID)"
else
    echo "Not running"
fi

# Optional: Stop PostgreSQL and Redis (commented out by default)
# echo -n "PostgreSQL... "
# sudo systemctl stop postgresql
# echo "Stopped"

# echo -n "Redis... "
# sudo systemctl stop redis
# echo "Stopped"

echo ""
echo "=== Services stopped ==="
