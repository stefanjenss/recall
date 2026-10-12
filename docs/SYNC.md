# Sync between devices

Recall can keep a phone and a laptop in step through a small sync server that you run yourself, for example on a home
server such as a Lenovo ThinkCentre. This guide covers how it works, how to set it up, and what to expect.

## How it works

- **Every device keeps a full copy** in its own browser storage and works offline. Sync is an addition to the local
  app, not a replacement for it.
- **The server keeps one more copy** in a SQLite file, and also serves the app itself. Opening the server's address in a
  browser gives you Recall, and that copy can sync with the server it came from.
- **Changes move in both directions automatically.** A device syncs when it opens, about 1.5 seconds after you change
  something, when you switch back to the tab, when the browser comes back online, and every 5 minutes. When you leave
  the tab, Recall tries to send anything not yet uploaded before the browser suspends it. Settings → Sync between
  devices also has a **Sync now** button.
- **One sync key** protects the server. Anyone who has the key and can reach the server can read and change your data,
  so keep the server on a private network (Tailscale is the setup described here) and treat the key like a password.

### What syncs

| Synced                                             | Not synced                                                  |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Cards (including deleted ones, which keep history) | A session in progress, until you finish or end it           |
| Schedules                                          | Import retry keys (`importBatches`), the "last backup" date |
| Every review, with its answer and snapshot         | The sync key and server address (each device has its own)   |
| Finished and ended sessions, reflections           | Storage-persistence status (it's per browser)               |
| Preferences: timezone, session size, reading size  |                                                             |

### When the same thing changes on two devices

Devices usually sync within seconds, so conflicts need two devices changing the same card while at least one of them
is offline. When that happens:

- **The most recent change wins**, record by record. Each change carries a hybrid logical clock stamp: wall-clock time,
  corrected so that a change made after seeing another device's change always counts as later, even if this device's
  clock is a little slow.
- **Reviews are never lost.** If you review the same card on both devices before they sync, both reviews stay in your
  history. The card's schedule comes from the later review, so its review count can be one lower than the number of
  reviews in its history.
- **Deleting a card wins** over an edit made on another device before the two synced. The card stays deleted; if the
  edit was the later change, the deleted card keeps the edited text, so its review history shows it.
- **Preferences** sync as one record: the most recently saved set wins.

If a device has a newer change of its own to a record the server sends, it keeps its own change and uploads it next;
the server then settles the two with the rules above.

## Set up the ThinkCentre

You need the ThinkCentre running Linux with either Docker or Node.js 22.13 or newer, and
[Tailscale](https://tailscale.com) on the ThinkCentre, your laptop, and your phone, all signed in to the same tailnet.
Tailscale lets your devices reach the server from anywhere without opening a port to the internet, and Tailscale Serve
gives it an HTTPS address. Browsers need HTTPS for some features Recall uses, such as coordinating sync across tabs.

In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**.

### Option A: Docker

```bash
git clone <your Recall repository> recall && cd recall
docker compose up -d --build
docker compose exec recall node dist-server/recall-server.mjs key    # prints the sync key
```

The container listens only on the ThinkCentre's own loopback address (`127.0.0.1:8787`). Its data lives in the
`recall-data` Docker volume.

### Option B: Node.js and systemd

```bash
sudo useradd --system --home /var/lib/recall --shell /usr/sbin/nologin recall
sudo git clone <your Recall repository> /opt/recall && cd /opt/recall
sudo npm ci && sudo npm run build && sudo npm run build:server
sudo cp deploy/recall-sync.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now recall-sync
sudo cat /var/lib/recall/sync-key                                      # the sync key
```

If `node` isn't at `/usr/bin/node` (for example, it was installed with nvm), change `ExecStart` in the unit file.

### Publish it on your tailnet

```bash
sudo tailscale serve --bg 8787
tailscale serve status        # shows the address, e.g. https://thinkcentre.tail1234.ts.net
```

Tailscale Serve keeps the address private to your tailnet and handles HTTPS. Don't use `tailscale funnel`, which
would put the server on the public internet.

## Connect your devices

Data in a browser belongs to the address it was saved under. If you've been using Recall at another address, such as a
local development server or GitHub Pages, bring that data along first. Open the old address, go to Settings → Download
full backup, then open the server's address and restore the backup under Settings → Restore from a full backup.

1. **Laptop:** open `https://thinkcentre.<your-tailnet>.ts.net`. In Settings → Sync between devices, the server address
   is already filled in. Paste the sync key, choose **Check connection**, then **Connect and upload this device's
   data**.
2. **Phone:** install the Tailscale app and sign in. Open the same address in Safari and add it to your Home Screen
   (Share → Add to Home Screen), which also keeps iOS from clearing its storage. Get the sync key onto the phone, for
   example by AirDrop or through your password manager. Then, in Settings → Sync between devices, choose **Check
   connection** and **Connect and download**.

If both devices already have data, Recall asks what to do:

| Choice                                       | Use it when                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Use the server's copy on this device         | Adding a device. Replaces this device's data, after you confirm. Offers a backup download first.         |
| Combine both                                 | Both devices have their own cards. Keeps everything; the most recently changed copy of each record wins. |
| Replace the server's copy with this device's | Starting over from this device, for example after restoring a backup. Other devices must reconnect.      |

Cards added separately on two devices are different cards, even with the same question, so **Combine both** can leave
duplicates to tidy up in Collection.

## Run it

### Settings

The server reads these environment variables.

| Variable                 | Default                    | Meaning                                                                          |
| ------------------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `RECALL_HOST`            | `127.0.0.1`                | Address to listen on. Keep it on loopback behind Tailscale Serve.                |
| `RECALL_PORT`            | `8787`                     | Port to listen on.                                                               |
| `RECALL_DATA_DIR`        | `./data`                   | Folder for `recall-sync.sqlite`, `sync-key`, and `backups/`.                     |
| `RECALL_SYNC_KEY`        | (from `sync-key`)          | Use this key instead of the file. At least 16 characters.                        |
| `RECALL_STATIC_DIR`      | `dist/` next to the server | The built app to serve. Set it to an empty string to serve only the sync API.    |
| `RECALL_ALLOWED_ORIGINS` | (none)                     | Comma-separated origins allowed to call the API from another address. See below. |

### Commands

```bash
node dist-server/recall-server.mjs            # start the server (same as `serve`)
node dist-server/recall-server.mjs key        # print the sync key, creating one if needed
node dist-server/recall-server.mjs backup [file]
                                              # write the server's data as a recall-backup file
```

In a development checkout, `npm run build && npm run build:server && npm run server` builds and starts it.

### Backups

The server's copy is one more copy of your data, not a backup. Take regular backups with the `backup` command. Its
output is an ordinary Recall full backup that any device can restore. For example, nightly at 03:00 with Docker:

```bash
0 3 * * * cd /path/to/recall && docker compose exec -T recall node dist-server/recall-server.mjs backup > /srv/backups/recall-$(date +\%F).json
```

or with systemd:

```bash
0 3 * * * sudo -u recall env RECALL_DATA_DIR=/var/lib/recall node /opt/recall/dist-server/recall-server.mjs backup /var/lib/recall/backups/recall-$(date +\%F).json
```

When a device replaces the server's copy, the server first saves the old data to
`backups/before-reset-<time>.json` in its data folder.

### Change the sync key

Delete `sync-key` from the data folder (or set `RECALL_SYNC_KEY`) and restart the server. Each device then reports
that the key was rejected. Disconnect it in Settings, then connect again with the new key and choose **Combine both**,
so that changes the device hadn't uploaded yet are kept.

### Update

Pull the new code, then run `docker compose up -d --build`, or `npm ci && npm run build && npm run build:server` and
`sudo systemctl restart recall-sync`. Devices pick up the new app the next time they load the page.

### Delete the server's data

Deleting data in a device's Settings removes only that device's copy and disconnects it. To delete the server's copy,
stop the server and delete its data folder (Docker: `docker compose down -v`).

## Serving the app from somewhere else

The simplest setup serves the app from the sync server, as above. If you'd rather keep the app on another host, such as
GitHub Pages, set `RECALL_ALLOWED_ORIGINS` to that page's origin (for example `https://you.github.io`), and enter the
Tailscale address in Settings. Two caveats apply. The page must be HTTPS to reach an HTTPS server. And some browsers ask
for permission before a public page can reach an address on your private network.

## Security notes

- The sync key is 32 random bytes. The server compares it in constant time, and devices send it only in an
  `Authorization` header, never in a URL.
- Each browser stores the key in its own storage. It isn't included in backups or exports.
- The server stores data unencrypted. It creates its files readable by its own user only, but anyone with
  administrator access to the ThinkCentre can read your cards and answers.
- The server checks every incoming record with the same rules a backup restore uses, and refuses a change stamped more
  than a day ahead of its own clock, so one device with a wrong clock can't override everything else.
- HTML pages from the server carry a Content Security Policy that allows only same-origin scripts, styles, fonts, and
  connections.

## Limits

- **One person per server.** There's a single key and a single collection, with no separate accounts.
- **Opening the app needs the server.** A page that's already open, or an installed Home Screen app that iOS kept in
  memory, keeps working offline. A fresh load needs the server to be reachable, because Recall has no service worker
  yet.
- **During a long first sync**, a card can briefly arrive before its schedule. The app treats such a card as not yet
  practicable until the rest arrives a moment later.

For the storage details and the wire format, see [DATA.md](DATA.md#sync). The design reasoning is in
[DECISIONS.md](DECISIONS.md#sync).
