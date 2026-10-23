FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupmod --new-name candidate ubuntu \
    && usermod --login candidate --home /home/candidate --move-home ubuntu
COPY sandbox-images/shared/termforge-init /usr/local/bin/termforge-init
COPY sandbox-images/shared/termforge-inspect /usr/local/bin/termforge-inspect
COPY sandbox-images/docker/docker-simulator /usr/local/bin/docker
COPY sandbox-images/docker/docker_state.py /opt/termforge/docker_state.py
RUN chmod 0555 /usr/local/bin/termforge-init /usr/local/bin/termforge-inspect /usr/local/bin/docker \
    && chmod 0444 /opt/termforge/docker_state.py
USER candidate
WORKDIR /workspace
