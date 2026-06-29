#!/bin/bash
set -e

# RadioPlay - Production Deployment Script
PROJECT_DIR="/home/ubuntu/radioplayone"
REPO_URL="https://github.com/victorykhan/radioplayone.git"

echo "=== Starting RadioPlay Production Deployment ==="

# 1. Clone or Pull code
if [ ! -d "$PROJECT_DIR" ]; then
    echo "Cloning repository from GitHub..."
    git clone "$REPO_URL" "$PROJECT_DIR"
else
    echo "Updating repository via git pull..."
    cd "$PROJECT_DIR"
    git fetch --all
    git reset --hard origin/main
fi

cd "$PROJECT_DIR"

# 2. Write Production Environment configuration
echo "Writing production .env file..."
cat << EOF > .env
PORT=3000
JWT_SECRET=super-secret-radio-key
LOG_LEVEL=debug

# Database Connection (MySQL remote)
DATABASE_URL="mysql://vkhan1:Canada05@localhost:3306/playone"

# Icecast Output Stream Credentials
ICECAST_HOST=localhost
ICECAST_PORT=8000
ICECAST_MOUNT=/playout
ICECAST_SOURCE_PASSWORD=hackme

# Audio Playout Engine Defaults
DEFAULT_FADE_DURATION=3
STREAM_BITRATE=128k
START_PLAYOUT_ON_BOOT=false # Set to true once Icecast is running
EOF

# 3. Create required directories
mkdir -p storage/tracks
mkdir -p storage/uploads
mkdir -p storage/logs
mkdir -p public/covers
mkdir -p public/images

# Copy SVG placeholders if not present
cp public/covers/default-vinyl.svg public/covers/default-vinyl.svg 2>/dev/null || true
cp public/images/default-logo.svg public/images/default-logo.svg 2>/dev/null || true

# 4. Install NPM dependencies
echo "Installing project dependencies..."
npm install --omit=dev

# 5. Run Prisma Migrations and Seed
echo "Running database schema migrations..."
# We generate the client first
npx prisma generate
# We deploy migrations
npx prisma db push --accept-data-loss # push schema to clean/sync DB

echo "Seeding the database..."
node prisma/seed.js

# 6. Configure Nginx Server Block with SSL
echo "Creating Nginx configuration..."
sudo cat << 'EOF' > /tmp/nginx-playone
server {
    server_name play.vawam.ca;
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /stream {
        proxy_pass http://127.0.0.1:3000/stream.html;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass 1;
    }

    location /stream.mp3 {
        proxy_pass http://127.0.0.1:8000/playout;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        add_header Cache-Control 'no-cache, no-store';
        add_header Access-Control-Allow-Origin '*';
    }

    location /live {
        proxy_pass http://127.0.0.1:8000/live;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/play.vawam.ca/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/play.vawam.ca/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = play.vawam.ca) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name play.vawam.ca;
    return 404; # managed by Certbot
}
EOF

sudo mv /tmp/nginx-playone /etc/nginx/sites-available/playone
sudo ln -sf /etc/nginx/sites-available/playone /etc/nginx/sites-enabled/playone
sudo rm -f /etc/nginx/sites-enabled/radioplay || true
sudo rm -f /etc/nginx/sites-enabled/default || true

echo "Testing Nginx syntax configuration..."
sudo nginx -t

echo "Reloading Nginx service..."
sudo systemctl reload nginx

# 7. Start/Restart the application via PM2
echo "Deploying Node process in PM2..."
pm2 delete radioplay 2>/dev/null || true
pm2 start src/app.js --name "radioplay"
pm2 save

echo "=== Deployment Completed Successfully! ==="
