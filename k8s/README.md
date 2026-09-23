# Deploy SupOps on k3s

Single-node k3s (e.g. an ESXi VM `k3master`), namespace `supops`. SupOps is one
container (API + UI + SQLite) — so **1 replica** with a persistent volume.

Run everything on the k3s node (or a machine with `kubectl` pointed at the cluster).

## 1. Get the image onto the cluster

k3s uses **containerd**, not Docker, so the image must be built into (or imported
into) the node — there's no registry in the default setup.

**If Docker is installed on the node:**
```bash
git clone https://github.com/Ayyush-Maheshwari/SupOps.git
cd SupOps
docker build -t supops:local .
docker save supops:local | sudo k3s ctr images import -
```

**If you use nerdctl/containerd (no Docker):** build straight into k3s's namespace:
```bash
sudo nerdctl -n k8s.io build -t supops:local .
```

Verify the image is visible to k3s:
```bash
sudo k3s ctr images ls | grep supops:local
```

## 2. Create the config/secret (recommended)

This pins a stable master key + JWT secret (so sessions and encrypted credentials
survive pod restarts) and sets org options. Skip it and the entrypoint auto-generates
the keys into the volume on first boot — but a managed secret is safer.

```bash
kubectl create namespace supops   # (also created by the manifest; harmless if it exists)

kubectl -n supops create secret generic supops-env \
  --from-literal=SUPOPS_MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SEED_ADMIN_EMAIL="you@definitive.com" \
  --from-literal=SEED_ADMIN_PASSWORD="change-me-strong" \
  --from-literal=AUTH_ALLOWED_EMAIL_DOMAIN="definitive.com"
```
(Drop `AUTH_ALLOWED_EMAIL_DOMAIN` if you don't want the org-only restriction.)

## 3. Deploy

```bash
kubectl apply -f k8s/supops.yaml
```

## 4. Verify

```bash
kubectl -n supops rollout status deploy/supops
kubectl -n supops get pods,svc,pvc
kubectl -n supops logs deploy/supops    # look for "starting SupOps on port 3001"
```

## 5. Open it

- **NodePort (default):** `http://<k3master-ip>:30300`
- **Quick test from your laptop:** `kubectl -n supops port-forward svc/supops 3001:80` → `http://localhost:3001`
- **Ingress (optional):** uncomment the Ingress in `supops.yaml`, point a hostname at the node.

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (default `admin@supops.local` / `supops`
if you skipped the secret), then paste an LLM key in **Settings**, and register your servers under
**Targets**.

## Updating to a new version
```bash
git pull
docker build -t supops:local . && docker save supops:local | sudo k3s ctr images import -
kubectl -n supops rollout restart deploy/supops
```

## Pinning to the node that has the image
Because the image is imported into one node (no registry), the pod must run there or you
get `ImagePullBackOff` on other nodes. The manifest pins it with:
```yaml
nodeSelector:
  kubernetes.io/hostname: k3s-master
```
Match that to your control-plane node name (`kubectl get nodes`). To apply it to an
already-running deployment without re-applying everything:
```bash
kubectl -n supops patch deploy supops --type=merge \
  -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"k3s-master"}}}}}'
```
(If your master carries a NoSchedule taint, also add a matching `tolerations` entry.)

## Troubleshooting: "didn't match PersistentVolume's node affinity"
`local-path` binds a volume to the node where the pod first scheduled. If an early pod
landed on a worker (e.g. before the `nodeSelector` was added), the PV is stuck to that
node and won't match once the pod is pinned to the master. With no data yet, delete and
re-provision on the master:
```bash
kubectl -n supops scale deploy supops --replicas=0
kubectl -n supops delete pvc supops-data
kubectl apply -f k8s/supops.yaml            # recreates the PVC; provisions on the pinned node
kubectl -n supops rollout status deploy/supops
```

## Notes
- **Do not scale replicas > 1** — SQLite is single-writer; the manifest uses `Recreate` so
  two pods never mount the volume at once.
- Backups = the PVC (`local-path` stores it under `/var/lib/rancher/k3s/storage/…` on the node).
  Back up that directory, or `kubectl -n supops exec` + copy out `/app/data/supops.db`.
- `kubectl -n supops delete -f k8s/supops.yaml` removes everything; add nothing else to keep the
  PVC if you want to preserve data (delete the Deployment/Service but keep the PVC).
