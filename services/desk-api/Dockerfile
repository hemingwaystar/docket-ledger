FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
COPY webui/ ./webui/
# --proxy-headers: honor X-Forwarded-Proto/For from the nginx front so
# request.base_url (and OIDC's derived redirect URI) reflect https. The
# allow-list is * because docker NAT hides the caller IP anyway; the only
# reachable paths are host nginx and NetBird peers, and a spoofed header
# gains nothing security-relevant here (auth never trusts it).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
