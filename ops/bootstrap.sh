#!/usr/bin/env bash
# Run as root once. Does not configure credentials, modify existing services, or migrate data.
set -euo pipefail
root=/data/science-evaluation
id science-eval >/dev/null 2>&1 || useradd --create-home --shell /bin/bash science-eval
install -d -o science-eval -g science-eval -m 750 "$root" "$root/releases" "$root/releases/backend" "$root/releases/frontend" "$root/shared"
install -d -o science-eval -g science-eval -m 700 /home/science-eval/.ssh
install -o root -g root -m 755 "$(dirname "$0")/deploy.sh" /usr/local/bin/science-evaluation-deploy
cat > /etc/sudoers.d/science-evaluation <<'SUDO'
science-eval ALL=(root) NOPASSWD: /usr/bin/systemctl restart science-evaluation-backend.service, /usr/bin/systemctl restart science-evaluation-frontend.service, /usr/bin/systemctl stop science-evaluation-backend.service, /usr/bin/systemctl stop science-evaluation-frontend.service
SUDO
chmod 440 /etc/sudoers.d/science-evaluation
visudo -cf /etc/sudoers.d/science-evaluation
for component in backend frontend; do
  if [[ "$component" == backend ]]; then entry=src/server.js; else entry=server.js; fi
  cat > "/etc/systemd/system/science-evaluation-$component.service" <<UNIT
[Unit]
Description=Science Evaluation $component
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=science-eval
Group=science-eval
WorkingDirectory=$root/current-$component
EnvironmentFile=$root/shared/$component.env
ExecStart=/usr/bin/node $root/current-$component/$entry
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$root
ProtectHome=true
[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable science-evaluation-backend.service science-evaluation-frontend.service
