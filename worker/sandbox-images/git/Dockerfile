FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends git docker.io python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupmod --new-name candidate ubuntu \
    && usermod --login candidate --home /home/candidate --move-home ubuntu
COPY sandbox-images/git/termforge-shell /usr/local/bin/termforge-shell
COPY sandbox-images/shared/termforge-init /usr/local/bin/termforge-init
COPY sandbox-images/shared/termforge-inspect /usr/local/bin/termforge-inspect
RUN chmod 0555 /usr/local/bin/termforge-shell /usr/local/bin/termforge-init /usr/local/bin/termforge-inspect
