# Multi-Agent Knowledge

## Breakout Room UX

- Instructor dashboard BO buttons move only the selected participant.
- Instructors stay in the main room after sending a participant to a BO room.
- The right instructor dashboard also has "講師の移動" self-move controls; these move only the current instructor between BO rooms and the main room.
- Participants can return to the main room voluntarily with the control bar "メインに戻る" button.
- Room changes update the local LiveKit metadata `currentRoom` before reconnecting; `/api/rooms-status` filters out stale room connections whose metadata points to another room.
- Instructor room status refreshes immediately on LiveKit participant connect/disconnect/metadata-change events, with polling as a fallback.
- Instructors can move BO participants back to main or remove them from the right dashboard.
- The right dashboard has "全員をメインへ招集" to send all BO occupants a main-room move command.
- There is no instructor-side "終了してメインへ" action that ends a BO room; all-main summon only moves occupants.
- `components/RoomView.tsx` keys `LiveKitRoom` by `currentRoom` so room changes remount the LiveKit connection.

## Deployment

- Deployment is GitHub auto-deploy from `main`.
- Push commits to `origin/main`; Vercel is linked to project `jishushitsu-discord`.
- Run `npx tsc --noEmit` and `npm run build` before pushing when possible.
- Local `npm run build` may need network access because `next/font/google` fetches Inter and Noto Sans JP during the build.

## Production domain

- Canonical production URL is `https://session.botarhythm.com` (custom domain on the `jishushitsu-discord` Vercel project). The old `jishushitsu-discord.vercel.app` still works but should be phased out.
- Reason for the custom domain: `jishushitsu-discord.vercel.app` triggered a Google Safe Browsing false-positive ("危険なサイト" phishing warning). Trigger = the substring `discord` in the hostname + a Discord-style login page. A domain without `discord` (`session.botarhythm.com`) clears the flag.
- DNS is managed at Xserver (nameservers `ns*.xserver.jp`). To point a subdomain at Vercel/Railway, add a **CNAME in「DNSレコード設定」only** — do NOT use「サブドメイン設定」. A サブドメイン設定 entry makes Xserver auto-publish a conflicting A record (server IP) and DKIM TXT records, which prevents the CNAME from resolving (A and CNAME can't coexist). `elevan`/`haccp` (Railway) and `session` (Vercel) all use the CNAME-only pattern.
- The Discord OAuth redirect URI is derived from `url.origin` (`app/api/auth/discord/callback/route.ts`), so no code change is needed per domain — but every serving domain's `https://<domain>/api/auth/discord/callback` must be registered in the Discord Developer Portal → OAuth2 → Redirects.
