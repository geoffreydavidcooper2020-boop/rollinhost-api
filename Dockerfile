FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
