FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    NVR_HOST=0.0.0.0 NVR_DATA_DIR=/data NVR_RECORDINGS_DIR=/recordings
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 nvr && useradd --uid 10001 --gid nvr --no-create-home nvr \
    && mkdir /data /recordings && chown nvr:nvr /data /recordings
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY nvr ./nvr
RUN pip install --no-cache-dir .
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)"
CMD ["nvr-sr81"]
