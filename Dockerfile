FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY backend ./backend
COPY web ./web
COPY docs ./docs
COPY README.md ./README.md
COPY .env.example ./.env.example

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "backend/server.mjs"]
