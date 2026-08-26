FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
RUN useradd -r -u 10001 appuser   # non-root (audit)
USER appuser
CMD ["python", "-m", "app.worker"]
