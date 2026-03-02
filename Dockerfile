FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

ENV NODE_OPTIONS="--max-old-space-size=512"

EXPOSE 3001

CMD ["node", "server.js"]
