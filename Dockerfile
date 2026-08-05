FROM node:20-alpine

WORKDIR /app

# Copy dependency definitions
COPY package.json ./

# Install dependencies inside image
RUN npm install --omit=dev

# Copy application script
COPY index.js ./

# Run sync immediately on startup, then repeat every 6 hours (21600 seconds)
CMD ["sh", "-c", "while true; do node index.js; echo 'Next EPG sync scheduled in 6 hours...'; sleep 21600; done"]
