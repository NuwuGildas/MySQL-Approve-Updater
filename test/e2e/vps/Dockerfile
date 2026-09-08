# Throwaway "VPS" for deploy end-to-end tests: sshd + nginx + PHP-FPM + composer + node + git.
# build:  docker build -t st-vps test/e2e/vps
# run:    docker run -d --rm --name st-vps -p 2222:22 -p 8088:80 st-vps
# ssh:    deploy / deploy  (password auth), passwordless sudo for nginx + php-fpm reloads only
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo git curl ca-certificates tar unzip \
      nginx php8.3-cli php8.3-fpm php8.3-mbstring php8.3-xml php8.3-curl php8.3-zip composer nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash deploy && echo 'deploy:deploy' | chpasswd \
    && mkdir -p /run/sshd /run/php /var/www && chown deploy:deploy /var/www \
    && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && echo 'deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -s reload, /usr/sbin/service php8.3-fpm reload, /usr/sbin/service php8.3-fpm restart' > /etc/sudoers.d/deploy \
    && chmod 440 /etc/sudoers.d/deploy
COPY nginx-demo.conf /etc/nginx/sites-available/default
EXPOSE 22 80
CMD service php8.3-fpm start && nginx && exec /usr/sbin/sshd -D -e
