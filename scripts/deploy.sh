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
DATABASE_URL="mysql://vkhan1:Canada05@localhost:3306/radioplay"

# Icecast Output Stream Credentials
ICECAST_HOST=localhost
ICECAST_PORT=8000
ICECAST_MOUNT=/stream
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
sudo cat << 'EOF' > /tmp/nginx-radioplay
server {
    listen 80;
    server_name play.vawam.ca;
    client_max_body_size 50M;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name play.vawam.ca;
    client_max_body_size 50M;

    ssl_certificate /etc/nginx/ssl/fullchain.cer;
    ssl_certificate_key /etc/nginx/ssl/play.vawam.ca.key;

    # Dynamic styling assets and dashboard frontend
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Proxy the Icecast stream through Nginx over port 443 to avoid mixed content block in browser
    location /stream {
        proxy_pass http://localhost:8000/stream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }

    # Proxy the Live DJ stream source endpoint for external connections
    location /live {
        proxy_pass http://localhost:8000/live;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
EOF

sudo mv /tmp/nginx-radioplay /etc/nginx/sites-available/radioplay
sudo ln -sf /etc/nginx/sites-available/radioplay /etc/nginx/sites-enabled/radioplay
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
