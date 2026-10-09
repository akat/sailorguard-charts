FROM nginx:1.27-alpine

# The tiles and manifest are not part of the image: they live in the
# `charts-data` volume (see portainer-stack.yml) and are uploaded with
# scripts/upload.sh, so new data does not need a new image.
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Run as the unprivileged nginx user on a high port.
RUN sed -i 's/^user .*;$//' /etc/nginx/nginx.conf \
    && touch /var/run/nginx.pid \
    && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
