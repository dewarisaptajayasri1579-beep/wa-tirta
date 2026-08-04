# wa-tirta

Pengganti `wa-tirtabening` (whatsapp-web.js/Puppeteer) menggunakan [Baileys](https://github.com/WhiskeySockets/Baileys) — tidak butuh Chromium, lebih ringan.

API-nya sengaja dibuat kompatibel 1:1 dengan `wa-tirtabening` (endpoint, format request/response, header auth, nilai `state`) supaya `TirtaBening` (app utama) tidak perlu diubah — cukup ganti `WA_API_URL`/`WA_API_KEY` di `.env`.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Scan QR yang muncul di terminal (atau ambil via `GET /qr`) dengan WhatsApp di HP.

## Endpoint

| Method | Path | Body | Keterangan |
|---|---|---|---|
| GET | `/health` | - | `{ ok, state, ready, me }` |
| GET | `/status` | - | `{ ok, state, ready, me }` |
| GET | `/qr` | - | `{ ok, dataUrl }`, atau 204 kalau sudah ready |
| POST | `/send` | `{ to, text }` | `{ ok, id, to }` |
| POST | `/send-image` | `{ to, url\|base64, caption?, mimeType?, filename? }` | `{ ok, id }` |
| POST | `/send-document` | `{ to, url\|base64, filename?, caption?, mimeType? }` | `{ ok }` |
| POST | `/bulk` | `{ items: [{to, text}], delayMs? }` | `{ ok, results }` |
| POST | `/logout` | - | `{ ok }`, sesi dihapus, minta scan QR baru |
| POST | `/reinit` | - | `{ ok }`, paksa reconnect + QR baru |
| GET | `/logs?limit=` | - | `{ ok, items }` |

Auth: header `x-api-key` (kalau `API_KEY` di-set di `.env`).

## Beda dari `wa-tirtabening`

- Sesi disimpan di folder `auth_info_<WWS_SESSION_LABEL>/` (Baileys multi-file auth state), **tidak kompatibel** dengan sesi lama `.wwebjs_auth` — saat pindah dari `wa-tirtabening`, harus scan QR ulang.
- Field `me.platform` selalu `"baileys"` (Baileys tidak expose info platform device seperti whatsapp-web.js).
- Endpoint `/send-document` tetap tidak menunggu status `ready` dulu, mengikuti perilaku service lama — kalau socket belum konek, request-nya akan gagal dengan 500.
