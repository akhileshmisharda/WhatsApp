# Use official lightweight Node.js image
FROM node:20-slim

# Install system dependencies if required for sharp/network
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package descriptors first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source
COPY . .

# Set environment
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Start command
CMD ["node", "index.js"]

