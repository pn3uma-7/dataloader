# Build context must be the project root:
# docker build -t dataloader-backend -f backend/Dockerfile .

# ── Frontend build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Backend build ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src/ ./src/
RUN npm run build

# ── Final image ───────────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /frontend/dist ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
