# Checking the app you were served

The words in the hub are encrypted in your browser with a key the server
never holds ([ADR 0001](adr/0001-client-side-encryption.md)). That promise
rests on one thing no web application can remove: the browser gets its code
from the same server every time, so whoever serves the code could serve a
version that copies the key at the next sign-in. Nothing in the design stops
that, and a page that claimed otherwise would be lying.

What can be done is to make the code checkable. The source is public, every
release is built from a tag by a workflow anyone can read, and each release
carries `hashes.txt` — the SHA-256 of every file in the frontend bundle. The
release run builds the frontend twice, once on the runner and once inside
the Docker image, and refuses to publish a list the two builds disagree on,
so the list is one a rebuild from source can reproduce. That proves a narrow
thing: the bundle you were served is byte-for-byte the one that belongs to
that tag. It does not prove the server will serve you the same bundle
tomorrow, or that it served the same bundle to you as to everyone else — a
server can single out one visitor. So check what your browser actually
loaded, not only what a fresh `curl` gets back today: the files listed in
DevTools → Sources (or Network, after a reload with the cache disabled) are
the ones that ran.

## Which version you are on

The foot of the sidebar names the version and the commit the bundle was
built from (hover it for both in full). It sits behind the sign-in screen on
purpose — `/api/health` withholds the version from the public internet, and
printing it under the login box would have handed it back.

## Listing what the page asks for

```bash
curl -s https://your-family.neiliro.com/ | grep -o 'assets/[^"]*'
```

Every hostname on the service is served the same bundle, including the ghost
that answers an unknown family name — so this can be run against any
subdomain, and a family does not have to name itself to check the code it
runs.

## Comparing with the published list

Download `hashes.txt` from the release page for your version
(`https://github.com/neiliro/neiliro/releases/tag/vX.Y.Z`) and hash what the
server hands you:

```bash
curl -s https://your-family.neiliro.com/assets/index-Brx0lNSS.js | sha256sum
grep index-Brx0lNSS.js hashes.txt
```

The repository has a script that does the whole list — the page itself, the
assets it references, the manifest, the service worker and the workbox chunk
the worker imports:

```bash
scripts/verify-bundle.sh https://your-family.neiliro.com hashes.txt
```

It prints a line per file and exits non-zero on the first mismatch. A
mismatch is not proof of an attack — an old tab, a stale service worker or a
list from the wrong version explain most of them — but it is the point at
which the next question is worth asking.

## Rebuilding the list yourself

Trusting the published list means trusting the workflow that produced it.
The alternative is to build the tag on your own machine and compare:

```bash
git clone https://github.com/neiliro/neiliro && cd neiliro
git checkout vX.Y.Z
npm ci
BUILD_SHA=$(git rev-parse HEAD) npm run build --workspace=web
scripts/bundle-hashes.sh web/dist
```

Node 22 (`.nvmrc`); the Docker image builds on the same major. `BUILD_SHA`
matters: the commit is compiled into the bundle, and a build without it —
or with a different value — differs by that string and matches nothing.

Source maps are excluded from the list. They are never executed, and
`sw.js.map` is not reproducible anyway: workbox builds the worker in a
temporary directory and the map keeps that path, which is different on every
machine. Everything the browser runs is covered.

## On your own hub

The same check works against a self-hosted instance — it is the same image
and the same bundle, so `hashes.txt` for the version you pulled applies
unchanged. To see what the image ships rather than what your reverse proxy
serves:

```bash
docker run --rm ghcr.io/neiliro/neiliro:2.2.0 \
  sh -c 'cat /app/web/dist/assets/index-*.js' | sha256sum
```

A difference between that and what the browser gets means the difference was
introduced after the image — by a proxy, a cache, or the machine.
