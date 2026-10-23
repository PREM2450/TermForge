FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends git docker.io ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupmod --new-name candidate ubuntu \
    && usermod --login candidate --home /home/candidate --move-home ubuntu
COPY termforge-shell /usr/local/bin/termforge-shell
RUN chmod 0555 /usr/local/bin/termforge-shell
