FROM node:20-bookworm

# Install build tools
RUN apt-get update && apt-get install -y build-essential git

# Build Stockfish from source
RUN git clone https://github.com/official-stockfish/Stockfish.git /tmp/stockfish && \
    cd /tmp/stockfish/src && \
    make -j4 && \
    mv stockfish /usr/local/bin/stockfish && \
    chmod +x /usr/local/bin/stockfish

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server/index.js"]
