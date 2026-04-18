FROM node:20-slim AS builder
WORKDIR /app
COPY frontend/package.json .
RUN npm install
COPY frontend/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# SEC-002: Copy index.html to a secondary path that is shared with the backend
# container via a Docker volume.  The backend's serveIndexWithNonce() reads this
# file to inject per-request CSP nonces into __CSP_NONCE__ placeholders.
COPY --from=builder /app/dist /usr/share/frontend_dist
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
