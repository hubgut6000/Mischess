FROM node:20-bookworm

# Download Stockfish from Chess.com's mirror (always available)
RUN apt-get update && apt-get install -y wget && \
    wget https://s3.amazonaws.com/stockfish-builds/stockfish-ubuntu-x86_64-avx2 -O /usr/local/bin/stockfish && \
    chmod +x /usr/local/bin/stockfish && \
    /usr/local/bin/stockfish --version

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server/index.js"]
