FROM node:20-bookworm

# Install Stockfish
RUN apt-get update && apt-get install -y stockfish

WORKDIR /app

# Copy project
COPY package*.json ./
RUN npm install

COPY . .

# Expose port
EXPOSE 8080

# Run server
CMD ["node", "server/index.js"]