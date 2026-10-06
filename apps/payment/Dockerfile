FROM nginx:alpine

# The config is a template: the official image's entrypoint runs `envsubst` over
# /etc/nginx/templates/*.template at container start and writes the result into
# /etc/nginx/conf.d/. Both origins below are config rather than literals because
# dev and pro differ and this image is one tag for both (#1083); the values here
# are the dev defaults, so a container started with no environment behaves
# exactly as this app did before the webhook relay existed.
#
# CORDEL_FITNESS_API_INTERNAL_URL is the address *this container* reaches the API
# at, used by the webhook relay only. Give it no trailing slash.
ENV CORDEL_FITNESS_API_PUBLIC_URL=https://api.vdicube.com \
    CORDEL_FITNESS_API_INTERNAL_URL=https://api.vdicube.com

COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY checkout.html error.html /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
EXPOSE 80
