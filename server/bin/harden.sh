#!/usr/bin/env bash
# One-time server hardening for Ubuntu 24.04. Run as root, ONCE, after your ssh key works for the non-root user (README step 4):
#   sudo ./harden.sh aretia
# It installs ufw, fail2ban, unattended-upgrades, age and rclone; allows only ssh, 80 and 443; turns off ssh passwords and root login.
# Docker publishes ports around ufw by design: the compose file therefore publishes only 80/443, and Postgres on 127.0.0.1.
set -euo pipefail
user="${1:?usage: harden.sh <non-root user that already has your ssh key>}"
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
id "$user" > /dev/null
[ -s "/home/$user/.ssh/authorized_keys" ] || { echo "/home/$user/.ssh/authorized_keys is empty: you would lock yourself out. Stopping." >&2; exit 2; }
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ufw fail2ban unattended-upgrades age rclone curl ca-certificates
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
cat > /etc/ssh/sshd_config.d/99-aretia.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
CONF
sshd -t
systemctl reload ssh
cat > /etc/fail2ban/jail.d/aretia.local <<'CONF'
[sshd]
enabled = true
maxretry = 4
findtime = 10m
bantime = 1h
CONF
systemctl enable --now fail2ban
systemctl restart fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades
echo "Listening on non-local addresses (expect only 22, 80, 443):"
ss -lntH | awk '{print $4}' | grep -v '^127\.' | grep -v '^\[::1\]' | sort -u || true
echo "hardening done"
