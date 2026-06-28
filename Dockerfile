# ponytail: run TS via the tsx loader, no build step. Add a tsc->dist stage if image
# size or cold-start ever matters; for a small API it doesn't yet.
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/app.ts"]
