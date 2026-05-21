# Kubernetes deployment

1. `helm install sentri ./helm/sentri --set ingress.host=sentri.example.com`
2. `kubectl wait --for=condition=Ready pod -l app=backend --timeout=90s`
3. `kubectl wait --for=condition=Ready pod -l app=worker --timeout=90s`
4. Validate `GET /api/v1/health` and worker `/healthz`.
