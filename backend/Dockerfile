FROM node:24-alpine AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM build AS test
COPY database ./database
COPY backend/test ./test
CMD ["npm", "test"]

FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY database ./database
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
