FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY agent.js ./
CMD ["node", "agent.js"]
