FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY agent.js ./

# Create writable dirs (container runs with --read-only, these are mounted volumes)
RUN mkdir -p /root/.openclaw /root/memory /root/workspace /root/data /root/skills

CMD ["node", "agent.js"]
