FROM nginx:alpine

# Static marketing + legal site for cordel.tech. No runtime configuration: the
# container listens on 80 and the quadlet on corfront publishes it as
# PublishPort=8084:80 (infra/web/cordel-web.container).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY *.html robots.txt /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
EXPOSE 80
