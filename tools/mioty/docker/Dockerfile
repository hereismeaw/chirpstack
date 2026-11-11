FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libsqlite3-0 python3 python3-venv redis-server mosquitto \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 demo \
    && mkdir /data && chown demo:demo /data
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
COPY --chmod=755 chirpstack /usr/local/bin/chirpstack
COPY api /opt/chirpstack/api
COPY tools /opt/chirpstack/tools
WORKDIR /opt/chirpstack
USER demo
EXPOSE 8080 1883
ENTRYPOINT ["/opt/venv/bin/python", "tools/mioty/docker_demo.py"]
