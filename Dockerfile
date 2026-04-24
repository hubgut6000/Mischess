FROM node:20-bookworm

# Download prebuilt Stockfish binary
RUN apt-get update && apt-get install -y wget && \
    wget https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-ubuntu-x86_64 -O /usr/local/bin/stockfish && \
    chmod +x /usr/local/bin/stockfish && \
    /usr/local/bin/stockfish --version

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server/index.js"]
