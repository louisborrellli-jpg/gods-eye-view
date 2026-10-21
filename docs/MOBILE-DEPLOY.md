# Reaching God's Eye View from your phone

The app runs as a server on a computer you control; your phone opens it in a
browser. Two things make that work well on a phone:

1. **A secure context (HTTPS).** Off `localhost`, browsers only grant the
   device APIs this app uses — geolocation for the **Me** layer, camera for any
   future AR — over HTTPS. Plain `http://192.168.x.x` will load the globe but
   silently deny "Me".
2. **The server staying private.** The server brokers your API keys, so anyone
   who can reach it can spend your quota. Keep it on a network you trust, or
   behind an authenticated tunnel. (The `GEV_RATELIMIT_*` throttles in
   `.env.example` are a backstop, not a substitute.)

Nothing here exposes a key to the browser beyond the three that are
client-exposed by design (see `SECURITY.md`). The TLS private key is read
server-side at startup and never sent to the page.

---

## Option A — Tailscale (recommended: private, HTTPS, reachable anywhere)

[Tailscale](https://tailscale.com) puts your phone and your computer on the same
private network wherever they are, and issues real HTTPS certificates for you.
Nothing is exposed to the public internet.

1. Install Tailscale on the computer and the phone, signed into the same
   account. Enable **MagicDNS** and **HTTPS** in the Tailscale admin console.
2. Run the app bound to localhost (the default is fine):
   ```sh
   npm run dev        # or: npm run build && npm run preview
   ```
3. From the computer, share it over Tailscale's HTTPS proxy:
   ```sh
   tailscale serve https / http://localhost:4173
   ```
4. On the phone, open `https://<your-computer>.<tailnet>.ts.net` — a real cert,
   so geolocation works, and only your devices can reach it.

No `GEV_TLS_*` needed here: Tailscale terminates TLS. Leave `HOST=localhost`.

---

## Option B — Same Wi-Fi, self-signed cert (`GEV_TLS_*`)

Good when the phone and computer are on the same network and you don't want a
tunnel. Uses [`mkcert`](https://github.com/FiloSottile/mkcert) to make a cert
your devices trust.

1. Make a locally-trusted cert for the computer's LAN name/IP:
   ```sh
   mkcert -install
   mkcert gev.local 192.168.1.50      # your hostname and/or LAN IP
   ```
   This writes `gev.local+1.pem` (cert) and `gev.local+1-key.pem` (key).
2. Point the app at them and open it to the LAN, in `.env`:
   ```sh
   HOST=0.0.0.0
   GEV_TLS_CERT=/absolute/path/gev.local+1.pem
   GEV_TLS_KEY=/absolute/path/gev.local+1-key.pem
   GEV_ALLOWED_HOSTS=gev.local       # the hostname you certified (IPs are always allowed)
   ```
   Both `GEV_TLS_*` must be set; setting only one leaves TLS off.
3. Trust the `mkcert` root on the phone: run `mkcert -CAROOT`, move the
   `rootCA.pem` from that folder to the phone, and install it (iOS: Settings →
   Profile, then General → About → Certificate Trust Settings; Android:
   Settings → Security → Install a certificate → CA certificate).
4. Run `npm run dev`, then open `https://gev.local:4173` (or your LAN IP) on the
   phone.

`HOST=0.0.0.0` exposes the key-brokering proxies to everyone on the network —
use it only on a network you trust.

---

## Installing it like an app

The app already ships a web manifest and icons, so once it loads over HTTPS you
can **Add to Home Screen** on the phone and it opens full-screen, with the
notch/home-indicator handled (see the mobile safe-area work). No store, no
build step.

## Keys

Add your API keys the usual way (the in-app **POWER UP** panel, or `.env`); they
stay server-side. The only keys ever in the browser bundle are
`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, and `MAPILLARY_CLIENT_TOKEN`, which
are client-side by design — scope/restrict them (`SECURITY.md`).
