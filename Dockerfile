FROM node:20-bookworm

# Download Stockfish for Ubuntu x86_64
RUN apt-get update && apt-get install -y wget && \
    wget https://github.com/official-stockfish/Stockfish/releases/download/sf_16.1/stockfish-ubuntu-x86_64-avx2.tar -O /tmp/stockfish.tar && \
    cd /tmp && tar -xf stockfish.tar && \
    mv stockfish/src/stockfish /usr/local/bin/stockfish && \
    chmod +x /usr/local/bin/stockfish && \
    /usr/local/bin/stockfish --version

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server/index.js"]
