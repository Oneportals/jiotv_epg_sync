# Standalone JioTV EPG Synchronization Service

This is a lightweight, independent microservice for automatic JioTV EPG synchronization to Supabase via SOCKS5 proxy (over Tailscale).

## Directory Structure
- `index.js`: Standalone EPG sync script.
- `package.json`: Lightweight dependencies (`@supabase/supabase-js`, `socks-proxy-agent`, `ws`, `dotenv`).
- `Dockerfile`: Minimal Alpine-based image that runs sync every 6 hours (256MB RAM cap).
- `docker-compose.yml`: Compose file for Docker / Coolify.
- `.env.example`: Environment variable template.

## Deployment Instructions

### Option 1: Separate Git Repository / Coolify Project
1. Copy or push this `jiotv-epg-standalone` directory into a new GitHub repository (e.g. `jiotv-epg-sync`).
2. In Coolify, click **+ Add Resource** -> **Public/Private Repository** -> select this repository.
3. Set the Environment Variables in Coolify:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SOCKS_PROXY=socks5://100.X.Y.Z:1080` (Your Host computer's Tailscale IP)
4. Click **Deploy**.

### Option 2: Directly on VPS via Docker Compose
1. Upload this folder to your VPS.
2. Create `.env` from `.env.example` and fill in your values.
3. Start the container:
   ```bash
   docker compose up -d --build
   ```
