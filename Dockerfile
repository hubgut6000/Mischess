FROM node:20-bookworm

RUN apt-get update && apt-get install -y stockfish

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server/index.js"]
