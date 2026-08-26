FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
COPY webui/ ./webui/
# --proxy-headers: honor X-Forwarded-Proto/For from the nginx front so
# request.base_url (and OIDC's derived redirect URI) reflect https.
# non-root (audit): an RCE in the Python stack must not be container-root.
RUN groupadd -r -g 10001 appuser && useradd -r -u 10001 -g appuser appuser
USER appuser
# trust X-Forwarded-* only from the proxy's network (audit: '*' let any
# direct-port caller forge the audited sign-in IP); compose sets the range.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000      --proxy-headers --forwarded-allow-ips \"${FORWARDED_ALLOW_IPS:-172.16.0.0/12}\""]
