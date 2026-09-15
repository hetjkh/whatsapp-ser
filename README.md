# The Unboxing — WhatsApp service (VPS)

Always-on [Baileys](https://github.com/WhiskeySockets/Baileys) HTTP API. Deploy this folder on a VPS (not Vercel). The main website calls it with a shared secret.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | no | Liveness + status |
| `GET` | `/session` | Bearer | QR / connection snapshot |
| `POST` | `/session/start` | Bearer | Start / reconnect |
| `POST` | `/session/logout` | Bearer | Logout + wipe auth |
| `POST` | `/send` | Bearer | Send brief text + optional media |

`Authorization: Bearer <WHATSAPP_SERVICE_SECRET>`

### Send body

```json
{
  "phone": "971506023071",
  "text": "Project brief…",
  "media": {
    "filename": "logo.png",
    "contentBase64": "<base64>",
    "contentType": "image/png"
  }
}
```

## Deploy on VPS

```bash
git clone <this-repo> whatsapp-service
cd whatsapp-service
cp .env.example .env
# edit WHATSAPP_SERVICE_SECRET + PORT
npm install
npm start
```

Keep it running with pm2:

```bash
npm i -g pm2
pm2 start "npm start" --name whatsapp
pm2 save
pm2 startup
```

Put nginx (or Caddy) in front with HTTPS on a subdomain, e.g. `wa.yourdomain.com` → `127.0.0.1:8787`.

## Website env

On the Next.js site (Vercel / host):

```
WHATSAPP_SERVICE_URL=https://wa.yourdomain.com
WHATSAPP_SERVICE_SECRET=same-as-vps
```

Then open **Admin → Settings**, click Connect, scan the QR with the business phone.
