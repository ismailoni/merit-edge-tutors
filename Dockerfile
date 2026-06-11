FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MERIT_DB_PATH=/data/merit-edge.sqlite

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . .
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 3000

CMD ["npm", "start"]
