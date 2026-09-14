FROM node:20-alpine

# pg_dump / pg_restore для бэкапов
RUN apk add --no-cache postgresql-client

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data/backups

EXPOSE 3000

CMD ["node", "server.js"]
