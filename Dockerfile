# Build the React frontend.
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY BlueCodeOS-PayU-MERN/client/package*.json ./
RUN npm ci
COPY BlueCodeOS-PayU-MERN/client/ ./
ENV VITE_API_URL=
RUN npm run build

# Install only production backend dependencies and serve the built frontend.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/server
COPY BlueCodeOS-PayU-MERN/server/package*.json ./
RUN npm ci --omit=dev
COPY BlueCodeOS-PayU-MERN/server/src ./src
COPY --from=client-build /app/client/dist ../client/dist
EXPOSE 5000
CMD ["npm", "start"]
