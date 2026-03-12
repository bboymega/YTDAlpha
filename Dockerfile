FROM python:3.12-slim

WORKDIR /app
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    apache2 \
    redis-server \
    curl \
    ca-certificates \
    git \
    unzip \
    cron \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/deno && \
    chmod +x /usr/local/bin/deno

RUN pip install --no-cache-dir yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider

RUN git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider /opt/bgutil-ytdlp-pot-provider && \
    cd /opt/bgutil-ytdlp-pot-provider/server && \
    deno install --allow-scripts=npm:canvas --frozen

RUN a2enmod proxy proxy_http && \
    sed -i 's/Listen 80/Listen 8080/g' /etc/apache2/ports.conf

COPY /api/requirements.txt /app/
COPY apache2-vhost.conf /app/

RUN pip install --no-cache-dir --root-user-action=ignore --upgrade pip && \
    pip install --no-cache-dir --root-user-action=ignore -r requirements.txt

RUN echo "0 0 * * * root /usr/local/bin/pip install --no-cache-dir -U yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider" \
    > /etc/cron.d/ytdlp-update && \
    chmod 0644 /etc/cron.d/ytdlp-update


COPY /react/out /app/html/
COPY /api /app/api/

EXPOSE 8080

ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0

CMD ["sh", "-c", "\
service redis-server start && \
service cron start && \
until redis-cli ping | grep -q PONG; do sleep 1; done && \
chown www-data:www-data -R /app/html/ && \
cp /app/apache2-vhost.conf /etc/apache2/sites-available/000-default.conf && \
service apache2 start && \
pip install --no-cache-dir -U yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider && \
cd /opt/bgutil-ytdlp-pot-provider/server && \
deno run --allow-env --allow-ffi --allow-read --allow-net src/main.ts & \
WORKERS=$(( $(nproc) * 2 + 1 )) && \
exec gunicorn --chdir /app/api --bind 127.0.0.1:8000 --workers $WORKERS --threads 25 --worker-class gthread app:app --timeout 600 \
"]
