FROM node:20-slim AS builder
WORKDIR /app
COPY frontend/package.json .
RUN npm install
COPY frontend/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
# SEC-002: Copy the built dist into the shared volume at runtime so the backend
# can read index.html for CSP nonce injection.  Docker only auto-populates named
# volumes on first creation — subsequent image rebuilds would leave stale content.
# Copying at startup ensures the volume always reflects the current build.
CMD sh -c 'cp -r /usr/share/nginx/html/* /usr/share/frontend_dist/ 2>/dev/null; nginx -g "daemon off;"'
